// What a step can reference, built the way the editor builds its field-mapping chips: the trigger's sample as
// context.req.body and, for each step that runs before a position (flow order), that step's sample as
// context.res.<slug> (context.vals.<slug> for variables). Every sample carries its origin, so the app's documented
// example output (e.g. {"id":"12345"}) is never taken for a real one:
//   tested      a test in this session, or a saved sample that differs from the documented example
//   run         the flow's latest run, only when that run came from the same trigger / step as the draft
//   documented  only the app's own example output
//
// Test results are held for this service-worker lifetime. Trigger samples are also saved with the trigger, raw, as
// the editor's Save does (json_script.trigger.sampleData). App-step samples are saved compressed on the block
// (blocks[slug].sampleData); the backend stores sampleData for app steps only, so function, API and variable test
// outputs last for this session. `viasocket_help` is guidance an app adds to its sample ("save and publish to
// receive ..."), never data to map.

import { shapeOf } from '../redact'
import type { ToolContext } from '../types'
import { getActionVersionRow } from './catalog'
import { isAbortError } from './errors'
import { flowKey } from './fields'
import { descendants, listFunctionRows, pluginDataOf, triggerKind } from './flow-api'
import { getRecentRun, type ParsedRun, type RunContext } from './runs'
import type { Block, FlowRow, FlowTarget, FunctionRow, JsonScript, PluginData, Trigger } from './types'
import { asRecord, isRecord, parseMaybeJson, ROW_ID_RE, str, truncate } from './util'

export type SampleOrigin = 'tested' | 'run' | 'documented'
/** A path segment: an object key, or an array index */
export type Seg = string | number

export interface SampleSource {
  /** 'trigger' or the step slug */
  id: string
  ref: 'req' | 'res' | 'vals'
  /** context.req.body, context.res.<slug> or context.vals.<slug> */
  base: string
  stepId?: string
  /** Trigger kind or block type */
  type: string
  app?: string
  action?: string
  origin?: SampleOrigin
  data?: unknown
  note?: string
  /** The data is the copy saved with the step, compressed (long strings cut): fine for paths, not as test values */
  compacted?: boolean
  /** The user declined testing this step; only then may its documented example be used (allowDocumentedSample) */
  declined?: boolean
  /** A payload given for one test, not a real sample */
  viaPayload?: boolean
  /** Webhook request query and headers that came with the sample */
  query?: unknown
  headers?: unknown
}

export type Position = { at: 'end' } | { at: 'before'; slug: string } | { at: 'insert'; parent: string; afterSlug?: string; atStart?: boolean }

export interface Catalogue {
  /** The trigger first, then the earlier data steps in run order */
  sources: SampleSource[]
  byId: Map<string, SampleSource>
  triggerKind?: string
  /** Block keys that run before the position (all types) */
  earlier: string[]
  /** The step at the position and everything after it */
  later: string[]
  js: JsonScript
  position: string
  run: ParsedRun | null
}

export const HELP_KEY = 'viasocket_help'
export const TOO_LARGE = 'data too large'
const IDENT = /^[A-Za-z_$][\w$]*$/
const CACHE_MAX = 200
const DATA_TYPES = new Set(['plugin', 'function', 'api'])
/** compactSample cuts strings to 100 characters and appends '...' */
const CUT_LENGTH = 103

// ---- Held samples and declined tests (this service-worker lifetime) -----------------------------------------

interface Held {
  data: unknown
  identity?: string
  query?: unknown
  headers?: unknown
}

const held = new Map<string, Held>()
const declined = new Map<string, true>()
const documentedCache = new Map<string, unknown>()

/** JSON with object keys sorted, so the same configuration always gives the same identity. */
function stableJson(v: unknown, depth = 0): string {
  if (depth > 12 || v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x, depth + 1)).join(',')}]`
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k], depth + 1)}`)
    .join(',')}}`
}

/**
 * Which Get Data configuration a sample belongs to: what it runs and with which values. Keys viaSocket adds on save
 * (the plugin's source code) and the stored sample itself are left out.
 */
export function getDataIdentity(pre: unknown): string {
  const p = asRecord(pre)
  const type = str(p.type) ?? ''
  const code = asRecord(p.code)
  if (type === 'plugin') {
    const sv = asRecord(code.selectedValues)
    return stableJson(['plugin', code.actionVersionId, asRecord(sv.authData).id, sv.inputData])
  }
  if (type === 'api') return stableJson(['api', code.url, code.method, code.headers, code.queryString, code.postData, p.dynamicVariables])
  return stableJson([type, p.code, p.dynamicVariables])
}

/** A successful Get Data test: its output becomes context.req.body for the whole flow. */
export function holdGetDataSample(ctx: ToolContext, t: FlowTarget, pre: unknown, data: unknown): void {
  keep(held, `${flowKey(ctx, t)}|getdata`, { data, identity: getDataIdentity(pre) })
}

export function forgetGetDataSample(ctx: ToolContext, t: FlowTarget): void {
  held.delete(`${flowKey(ctx, t)}|getdata`)
}

function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > CACHE_MAX) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

/** Which trigger a sample belongs to: switching the trigger app or event makes it stale. */
export function triggerIdentity(trigger: Trigger | undefined): string {
  return `${triggerKind(trigger) ?? ''}|${str(trigger?.selectedCreate) ?? ''}|${str(trigger?.actionVersionId) ?? ''}`
}

export function holdTriggerSample(
  ctx: ToolContext,
  t: FlowTarget,
  trigger: Trigger | undefined,
  data: unknown,
  extra: { query?: unknown; headers?: unknown } = {},
): void {
  keep(held, `${flowKey(ctx, t)}|trigger`, { data, identity: triggerIdentity(trigger), query: extra.query, headers: extra.headers })
}

export function holdStepSample(ctx: ToolContext, t: FlowTarget, stepId: string, data: unknown): void {
  keep(held, `${flowKey(ctx, t)}|step|${stepId}`, { data })
  declined.delete(`${flowKey(ctx, t)}|${stepId}`)
}

/** vs_test_step returned declined for this step: its documented example may now be used, if the model says so. */
export function markDeclined(ctx: ToolContext, t: FlowTarget, stepId: string): void {
  keep(declined, `${flowKey(ctx, t)}|${stepId}`, true)
}

function isDeclined(ctx: ToolContext, t: FlowTarget, stepId: string | undefined): boolean {
  return !!stepId && declined.has(`${flowKey(ctx, t)}|${stepId}`)
}

// ---- Sample helpers ------------------------------------------------------------------------------------------

/** The sample without viasocket_help keys (any depth). */
export function cleanSample(v: unknown, depth = 0): unknown {
  if (depth > 20) return v
  if (Array.isArray(v)) return v.map((x) => cleanSample(x, depth + 1))
  if (!isRecord(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (k !== HELP_KEY) out[k] = cleanSample(x, depth + 1)
  return out
}

/** An array's items as one shape (keys of the first items merged), or its first item. */
export function elementOf(arr: unknown[]): unknown {
  const head = arr.slice(0, 10)
  if (head.length && head.every(isRecord)) {
    const out: Record<string, unknown> = {}
    for (const item of head as Record<string, unknown>[]) for (const [k, v] of Object.entries(item)) if (!(k in out)) out[k] = v
    return out
  }
  return arr[0]
}

/**
 * A trigger sample as later steps see it at run time: a list of events runs the flow once per item, each item
 * becoming context.req.body.
 */
export function triggerBody(v: unknown): unknown {
  const c = cleanSample(parseMaybeJson(v))
  return Array.isArray(c) ? (c.length ? elementOf(c) : undefined) : c
}

/** True when a sample holds data (not empty, not only viasocket_help, not the 'data too large' marker). */
export function meaningful(v: unknown): boolean {
  const c = cleanSample(parseMaybeJson(v))
  if (c === TOO_LARGE || c === undefined || c === null) return false
  if (Array.isArray(c)) return c.some((x) => meaningful(x))
  if (isRecord(c)) return Object.keys(c).length > 0
  return typeof c === 'string' ? c.trim().length > 0 : true
}

/** The viasocket_help text of a sample (top level, or of its first item). */
export function helpText(v: unknown): string | undefined {
  const p = parseMaybeJson(v)
  const r = Array.isArray(p) ? p[0] : p
  return isRecord(r) && typeof r[HELP_KEY] === 'string' ? truncate(r[HELP_KEY] as string, 300) : undefined
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * The copy saved with an app step, compressed like the editor's save does (cleanApiResponse): strings cut to 100
 * characters, repeated array items of the same shape dropped, anything over 50 KB replaced by a marker. Paths and
 * value types survive, which is what mapping needs; values that were cut are never sent as test data.
 */
export function compactSample(v: unknown): unknown {
  const out = compact(v, 0)
  return (JSON.stringify(out) ?? '').length > 50 * 1024 ? TOO_LARGE : out
}

function compact(v: unknown, depth: number): unknown {
  if (depth > 50) return '...'
  if (typeof v === 'string') return v.length > 100 ? `${v.slice(0, 100)}...` : v
  if (Array.isArray(v)) {
    const shapes = new Set<string>()
    const out: unknown[] = []
    for (const item of v) {
      if (isRecord(item)) {
        const shape = Object.keys(item).sort().join('\u0000')
        if (shapes.has(shape)) continue
        shapes.add(shape)
      }
      out.push(compact(item, depth + 1))
    }
    return out
  }
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = compact(x, depth + 1)
    return out
  }
  return v
}

/** A value (or anything inside it) that compression changed: a cut string or the too-large marker. */
export function hasCutValue(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v === TOO_LARGE || v === '...' || (v.length === CUT_LENGTH && v.endsWith('...'))
  if (depth > 8) return false
  if (Array.isArray(v)) return v.some((x) => hasCutValue(x, depth + 1))
  if (isRecord(v)) return Object.values(v).some((x) => hasCutValue(x, depth + 1))
  return false
}

// ---- Paths -----------------------------------------------------------------------------------------------------

export function pathText(base: string, segs: readonly Seg[]): string {
  return base + segs.map((s) => (typeof s === 'number' ? `[${s}]` : IDENT.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('')
}

export function insertText(base: string, segs: readonly Seg[]): string {
  return `\${${pathText(base, segs)}}`
}

const ARRAY_METHODS = new Set([
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat',
  'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push', 'reduce', 'reduceRight',
  'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'toLocaleString', 'toReversed', 'toSorted', 'toSpliced', 'toString',
  'unshift', 'values', 'with',
])
const STRING_METHODS = new Set([
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'localeCompare',
  'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'slice', 'split',
  'startsWith', 'substr', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toString', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart', 'valueOf',
])
const NUMBER_METHODS = new Set(['toExponential', 'toFixed', 'toLocaleString', 'toPrecision', 'toString', 'valueOf'])
const BOOLEAN_METHODS = new Set(['toString', 'valueOf'])
const OBJECT_METHODS = new Set(['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf'])

export type WalkResult =
  | { ok: true; resolved: boolean; value?: unknown }
  | {
      ok: false
      /** Index of the segment that failed */
      at: number
      /** missing: no such key; member: not a member of that kind of value; empty: nothing to read inside null */
      reason: 'missing' | 'member' | 'empty'
      kind: string
    }

function kindOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'list'
  if (isRecord(v)) return 'object'
  return typeof v
}

/**
 * Whether a path exists in a sample, as JavaScript would read it. Objects: only their keys. Lists: an index or
 * length (a method call such as .map() when `called`). Text and numbers: length or their own methods. A path into
 * null cannot be checked and fails. `null` segments are computed (resolved: false, the caller decides).
 */
export function walkSample(data: unknown, segs: ReadonlyArray<Seg | null>, called = false): WalkResult {
  let cur = data
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === null || s === undefined) return { ok: true, resolved: false }
    const call = called && i === segs.length - 1
    const name = String(s)
    const numeric = typeof s === 'number' || /^\d+$/.test(name)
    const fail = (reason: 'missing' | 'member' | 'empty'): WalkResult => ({ ok: false, at: i, reason, kind: kindOf(cur) })
    if (Array.isArray(cur)) {
      if (call) return ARRAY_METHODS.has(name) ? { ok: true, resolved: false } : fail('member')
      if (numeric) {
        cur = elementOf(cur)
        continue
      }
      if (name === 'length') {
        cur = cur.length
        continue
      }
      return fail('member')
    }
    if (isRecord(cur)) {
      if (call) return OBJECT_METHODS.has(name) ? { ok: true, resolved: false } : fail('missing')
      if (name !== HELP_KEY && Object.hasOwn(cur, name)) {
        cur = cur[name]
        continue
      }
      return fail('missing')
    }
    if (typeof cur === 'string') {
      if (call) return STRING_METHODS.has(name) ? { ok: true, resolved: false } : fail('member')
      if (name === 'length') {
        cur = cur.length
        continue
      }
      if (numeric) {
        cur = cur.charAt(Number(name))
        continue
      }
      return fail('member')
    }
    if (typeof cur === 'number') return call && NUMBER_METHODS.has(name) ? { ok: true, resolved: false } : fail('member')
    if (typeof cur === 'boolean') return call && BOOLEAN_METHODS.has(name) ? { ok: true, resolved: false } : fail('member')
    return fail('empty')
  }
  return { ok: true, resolved: true, value: cur }
}

export interface PathEntry {
  segs: Seg[]
  insert: string
  value: unknown
  leaf: boolean
}

/** Every node of a source's sample (objects, arrays and values), first array item standing for all items. */
export function allPaths(src: SampleSource, limit = 300): PathEntry[] {
  const out: PathEntry[] = []
  const walk = (v: unknown, segs: Seg[], depth: number) => {
    if (out.length >= limit) return
    if (Array.isArray(v)) {
      out.push({ segs, insert: insertText(src.base, segs), value: `array(${v.length})`, leaf: !v.length || depth > 7 })
      if (v.length && depth <= 7) {
        const el = elementOf(v)
        if (isRecord(el) || Array.isArray(el)) walk(el, [...segs, 0], depth + 1)
      }
      return
    }
    if (isRecord(v)) {
      const keys = Object.keys(v).filter((k) => k !== HELP_KEY)
      if (segs.length) out.push({ segs, insert: insertText(src.base, segs), value: 'object', leaf: !keys.length || depth > 7 })
      if (depth > 7) return
      for (const k of keys) walk(v[k], [...segs, k], depth + 1)
      return
    }
    out.push({ segs, insert: insertText(src.base, segs), value: v, leaf: true })
  }
  walk(src.data, [], 0)
  return out
}

export interface VarEntry {
  insert: string
  example: unknown
}

/**
 * Insert texts of a source for the model: leaves and lists, with a value example (only its shape for run data when
 * protected). Keys stay exact, even with protection on: they are structure, and an altered key could not be copied.
 */
export function variablesOf(src: SampleSource, strip: boolean, max = 60): VarEntry[] {
  const showValues = !strip || src.origin === 'documented'
  return allPaths(src, max * 3)
    .filter((p) => p.leaf || (typeof p.value === 'string' && p.value.startsWith('array(')))
    .slice(0, max)
    .map((p) => {
      const v = p.value
      const example =
        typeof v === 'string' && (v.startsWith('array(') || v === 'object') ? v : showValues ? (typeof v === 'string' ? truncate(v, 60) : v) : shapeOf(v)
      return { insert: p.insert, example }
    })
}

// ---- Flow order and positions --------------------------------------------------------------------------------

/** Every block key in run order (pre-order through branches), like the editor's stepOrder. */
export function flowOrder(js: JsonScript): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (k: string, depth: number) => {
    for (const child of js.order[k] ?? []) {
      if (seen.has(child) || depth > 12) continue
      seen.add(child)
      out.push(child)
      walk(child, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

function splitAt(js: JsonScript, order: string[], pos: Position): { earlier: string[]; later: string[]; label: string } {
  let idx = order.length
  let label = 'the end of the flow'
  if (pos.at === 'before') {
    // A block outside the run order (left over by an edit) sees what the end of the flow sees.
    const i = order.indexOf(pos.slug)
    if (i >= 0) idx = i
    label = `step "${pos.slug}"`
  } else if (pos.at === 'insert') {
    if (pos.afterSlug) {
      const i = order.indexOf(pos.afterSlug)
      if (i >= 0) idx = i + 1 + descendants(js, pos.afterSlug).size
      label = `a new step after "${pos.afterSlug}"`
    } else if (pos.parent === 'root') {
      idx = pos.atStart ? 0 : order.length
      label = pos.atStart ? 'a new first step' : 'a new step at the end'
    } else {
      const i = order.indexOf(pos.parent)
      if (i >= 0) idx = pos.atStart ? i + 1 : i + 1 + descendants(js, pos.parent).size
      label = `a new step in "${pos.parent}"`
    }
  }
  return { earlier: order.slice(0, idx), later: order.slice(idx), label }
}

// ---- Building the catalogue ----------------------------------------------------------------------------------

/** The documented sample of the action version the trigger is pinned to (what drafttrigger copied). */
async function documentedTriggerSample(ctx: ToolContext, trigger: Trigger): Promise<{ known: boolean; value?: unknown }> {
  const avid = str(trigger.actionVersionId)
  if (!avid || !ROW_ID_RE.test(avid)) return { known: false }
  const key = `${ctx.vs.env.apiBase}|${avid}`
  if (documentedCache.has(key)) return { known: true, value: documentedCache.get(key) }
  try {
    const row = await getActionVersionRow(ctx, avid)
    const value = parseMaybeJson(row.sampledata)
    keep(documentedCache, key, value)
    return { known: true, value }
  } catch (e) {
    if (isAbortError(e)) throw e
    return { known: false }
  }
}

/**
 * Runs execute the live version (published_json_script). Its data stands for the draft's trigger only when the live
 * trigger is the same app event (or the same kind for webhooks); a never-published flow's live trigger is a webhook.
 */
export function runMatchesTrigger(row: FlowRow): boolean {
  const draft = row.json_script.trigger
  const live = row.published_json_script?.trigger
  return !!draft && !!live && !!triggerKind(draft) && triggerIdentity(draft) === triggerIdentity(live)
}

/** A run's output of a step stands for the draft step only when the live step is the same step and the same action. */
function runMatchesStep(row: FlowRow, slug: string, b: Block, pd: PluginData | null | undefined): boolean {
  const live = row.published_json_script?.blocks[slug]
  if (!live || !b.identifier || live.identifier !== b.identifier || live.type !== b.type) return false
  if (b.type !== 'plugin') return true
  const draftVersion = str(pd?.actionVersionId) ?? str(b.service?.actionVersionId)
  const liveVersion = str(live.service?.actionVersionId)
  const draftEvent = str(pd?.selectedCreate) ?? str(b.service?.eventId)
  const liveEvent = str(live.service?.eventId)
  if (draftVersion && liveVersion && draftVersion !== liveVersion) return false
  if (draftEvent && liveEvent && draftEvent !== liveEvent) return false
  return true
}

function noTriggerDataNote(kind: string | undefined): string {
  if (!kind) return 'The flow has no trigger yet; set one with vs_set_trigger.'
  if (kind === 'cron') return 'Schedule triggers carry no event data.'
  if (kind === 'webhook' || kind === 'email') return 'No data received yet: ask the user to send one real request, then run vs_test_trigger.'
  return 'Not tested yet: run vs_test_trigger.'
}

// ---- Webhook and schedule triggers: Get Data, loop key, one run per item -------------------------------------
//
// At run time the VM builds context.req.body for a webhook or schedule in this order: the incoming body; then the
// Get Data output (it REPLACES the body); then the loop key (body = the value at that path); then, when the loop is
// on and the body is a list, one run per item (body = that item, headers = the loop's own headers, query copied).
// Run-if is evaluated after all of that, per item. The catalogue follows the same order.

/** Step names the VM logs for these stages; a run that has them did not keep the raw request body. */
const PRE_STAGE_KEYS = ['WEBHOOK_PRE_PROCESS', 'CRON_PRE_PROCESS', 'CRON_PRE_PROCESS_FILTER', 'ACTUAL_BODY']

/** False when a run's body was already changed by Get Data or a loop (a loop's child run gets one item). */
export function runBodyIsRaw(run: ParsedRun): boolean {
  if (PRE_STAGE_KEYS.some((k) => Object.hasOwn(run.res, k))) return false
  const headers = Object.fromEntries(Object.entries(run.headers).map(([k, v]) => [k.toLowerCase(), v]))
  return headers.parentflowhitid === undefined && headers.viasocketclient === undefined
}

/** The headers a loop's child run gets instead of the caller's (values are placeholders of the right type). */
function loopChildHeaders(title: unknown): Record<string, unknown> {
  return { viasocketclient: typeof title === 'string' ? title : 'flow', viasocketclientcount: 0, 'content-type': 'application/json', isdryrun: false, parentflowhitid: 'parent-run-id' }
}

/** lodash get with its path syntax: data.items, data.items[0].lines, ["a b"].c */
export function getAtPath(data: unknown, path: string): unknown {
  const segs: Seg[] = []
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]|\[["']([^"'\]]+)["']\]/g)) {
    if (m[2] !== undefined) segs.push(Number(m[2]))
    else segs.push(m[3] ?? m[1] ?? '')
  }
  let cur = data
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[s as string]
  }
  return cur
}

/** Paths to every list in a body, in the loop key's syntax ('' = the body itself), first item standing for all. */
export function arrayPaths(data: unknown, limit = 40): Array<{ path: string; length: number; itemKeys?: string[] }> {
  const out: Array<{ path: string; length: number; itemKeys?: string[] }> = []
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= limit || depth > 6) return
    if (Array.isArray(v)) {
      const el = v.length ? elementOf(v) : undefined
      out.push({ path, length: v.length, itemKeys: isRecord(el) ? Object.keys(el).filter((k) => k !== HELP_KEY).slice(0, 12) : undefined })
      if (isRecord(el) || Array.isArray(el)) walk(el, `${path}[0]`, depth + 1)
      return
    }
    if (!isRecord(v)) return
    for (const [k, x] of Object.entries(v)) {
      if (k === HELP_KEY) continue
      const sub = /^[A-Za-z_$][\w$]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`
      walk(x, sub, depth + 1)
    }
  }
  walk(data, '', 0)
  return out
}

export interface LoopList {
  /** Value for vs_set_trigger_loop arrayKey; absent when the body itself is the list (omit arrayKey) */
  arrayKey?: string
  items: number
  itemKeys?: string[]
}

/**
 * Lists in a body that "run once per item" can loop over, each with the exact arrayKey to pass. Lists nested inside
 * another list's items are left out: a key through [0] would loop over the first item's list only.
 */
export function loopLists(data: unknown, limit = 12): LoopList[] {
  return arrayPaths(data, 40)
    .filter((p) => !p.path.includes('[0]'))
    .slice(0, limit)
    .map((p) => ({ ...(p.path ? { arrayKey: p.path } : {}), items: p.length, itemKeys: p.itemKeys?.length ? p.itemKeys : undefined }))
}

export interface TriggerStages {
  kind?: string
  /** The request as it reaches the flow, before Get Data (webhook); schedules have none */
  raw: SampleSource
  hasGetData: boolean
  /** The body after Get Data (the incoming body when there is none), before the loop key */
  processed?: { data: unknown; origin: SampleOrigin; compacted?: boolean; what: string }
  loopKey?: string
  loops: boolean
  /** What steps (and run-if) see as context.req.body */
  final: SampleSource
}

/** The saved Get Data output (stored with it by vs_set_get_data), unless it is only the app's documented example. */
function savedGetDataSample(pre: Record<string, unknown>): unknown {
  const saved = parseMaybeJson(pre.sampleData)
  if (!meaningful(saved) || saved === TOO_LARGE) return undefined
  if (str(pre.type) === 'plugin') {
    const documented = parseMaybeJson(asRecord(pre.code).sampleData)
    if (meaningful(documented) && deepEqual(cleanSample(saved), cleanSample(documented))) return undefined
  }
  return saved
}

/** The trigger body at each stage, for webhook and schedule triggers. `trigger` may be a planned (unsaved) one. */
export function triggerStages(ctx: ToolContext, t: FlowTarget, row: FlowRow, run: ParsedRun | null, trigger: Trigger | undefined = row.json_script.trigger): TriggerStages {
  const kind = triggerKind(trigger)
  const src: SampleSource = { id: 'trigger', ref: 'req', base: 'context.req.body', type: kind ?? 'none' }
  let raw: SampleSource = { ...src, note: noTriggerDataNote(kind) }
  if (kind === 'webhook') {
    const h = held.get(`${flowKey(ctx, t)}|trigger`)
    if (h && h.identity === triggerIdentity(trigger) && meaningful(h.data)) {
      raw = { ...src, origin: 'tested', data: cleanSample(parseMaybeJson(h.data)), query: h.query, headers: h.headers, note: 'Request received (tested in this session).' }
    } else if (run && meaningful(run.body) && runMatchesTrigger(row)) {
      raw = runBodyIsRaw(run)
        ? { ...src, origin: 'run', data: cleanSample(run.body), query: run.query, headers: run.headers, note: `Request of the latest run${run.at ? ` (${run.at})` : ''}.` }
        : { ...src, query: run.query, headers: run.headers, note: 'The latest run already went through Get Data or a loop, so the original request body is unknown. Ask the user to send one real request, then run vs_test_trigger.' }
    } else if (run && meaningful(run.body)) {
      raw = { ...raw, note: `${raw.note ?? ''} The latest run came from the live trigger, which is not this draft trigger, so its data is not used.`.trim() }
    }
  }
  const pre = isRecord(trigger?.preProcess) ? (trigger?.preProcess as Record<string, unknown>) : undefined
  const loopsOn = asRecord(trigger?.loops).loopsEnabled === true
  const filter = asRecord(trigger?.preProcessFilter)
  const loopKey = filter.type === 'filterByKey' ? str(asRecord(filter.value).value) || undefined : undefined
  let processed: TriggerStages['processed']
  let missing: string | undefined
  if (pre) {
    const h = held.get(`${flowKey(ctx, t)}|getdata`)
    if (h && h.identity === getDataIdentity(pre) && meaningful(h.data)) processed = { data: cleanSample(parseMaybeJson(h.data)), origin: 'tested', what: 'Get Data output (tested in this session)' }
    else {
      const saved = savedGetDataSample(pre)
      if (saved !== undefined) processed = { data: cleanSample(saved), origin: 'tested', compacted: true, what: 'Get Data output (saved from its last test)' }
      else missing = 'Get Data replaces context.req.body and has not been tested yet, so the fields are unknown: test it with vs_set_get_data action "test".'
    }
  } else if (raw.origin) processed = { data: raw.data, origin: raw.origin, what: raw.origin === 'tested' ? 'the request received' : 'the request of the latest run' }
  const base: TriggerStages = { kind, raw, hasGetData: !!pre, processed, loopKey, loops: loopsOn, final: { ...src, note: missing ?? raw.note } }
  if (!processed) return base
  let body = processed.data
  const parts = [processed.what]
  if (loopKey) {
    body = getAtPath(body, loopKey)
    if (body === undefined) return { ...base, final: { ...src, note: `The loop key "${loopKey}" does not exist in ${processed.what}. Pick a real list with vs_set_trigger_loop.` } }
    parts.push(`narrowed to "${loopKey}"`)
  }
  let headers: unknown = raw.headers
  if (loopsOn && Array.isArray(body)) {
    if (!body.length) return { ...base, final: { ...src, note: `The list ${loopKey ? `"${loopKey}"` : 'in the body'} is empty in ${processed.what}, so the fields of one item are unknown.` } }
    body = elementOf(body)
    headers = loopChildHeaders(row.title)
    parts.push('one item per run (loop on)')
  }
  return {
    ...base,
    final: { ...src, origin: processed.origin, data: body, compacted: processed.compacted, query: kind === 'webhook' ? raw.query : undefined, headers: kind === 'webhook' ? headers : undefined, note: `context.req.body = ${parts.join(', ')}.` },
  }
}

async function triggerSource(ctx: ToolContext, t: FlowTarget, row: FlowRow, run: ParsedRun | null, payload: unknown, rawTrigger = false): Promise<SampleSource> {
  const trigger = row.json_script.trigger
  const kind = triggerKind(trigger)
  const src: SampleSource = { id: 'trigger', ref: 'req', base: 'context.req.body', type: kind ?? 'none', app: trigger?.serviceName, action: trigger?.actionName }
  if (payload !== undefined) return { ...src, origin: 'tested', viaPayload: true, data: triggerBody(payload), note: 'Payload given for this test.' }
  if (!trigger || !kind) return { ...src, note: noTriggerDataNote(undefined) }
  if (kind === 'webhook' || kind === 'cron') {
    const stages = triggerStages(ctx, t, row, run, trigger)
    return rawTrigger ? stages.raw : stages.final
  }
  const h = held.get(`${flowKey(ctx, t)}|trigger`)
  if (h && h.identity === triggerIdentity(trigger) && meaningful(h.data)) {
    return { ...src, origin: 'tested', data: triggerBody(h.data), query: h.query, headers: h.headers, note: 'Tested in this session.' }
  }

  const isApp = !['webhook', 'email', 'cron'].includes(kind)
  let documented: unknown
  if (isApp) {
    const saved = parseMaybeJson(trigger.sampleData)
    if (meaningful(saved)) {
      if (trigger.isDrafted === true) documented = saved
      else {
        const doc = await documentedTriggerSample(ctx, trigger)
        // When the documented example cannot be read, a saved sample cannot be told apart from it: treat it as documented.
        if (!doc.known || deepEqual(cleanSample(saved), cleanSample(doc.value))) documented = saved
        else return { ...src, origin: 'tested', data: triggerBody(saved), note: 'Saved from an earlier test.' }
      }
    }
  }
  let runNote = ''
  if (run && meaningful(run.body)) {
    if (runMatchesTrigger(row)) {
      return { ...src, origin: 'run', data: triggerBody(run.body), query: run.query, headers: run.headers, note: `From the latest run${run.at ? ` (${run.at})` : ''}.` }
    }
    runNote = ' The latest run came from the live trigger, which is not this draft trigger, so its data is not used.'
  }
  if (isApp && documented === undefined) {
    const doc = await documentedTriggerSample(ctx, trigger)
    if (doc.known) documented = doc.value
  }
  if (meaningful(documented)) {
    return { ...src, origin: 'documented', data: triggerBody(documented), note: `Only the app's documented example, not real data: test the trigger (vs_test_trigger).${runNote}` }
  }
  return { ...src, note: noTriggerDataNote(kind) + runNote }
}

function stepSource(
  ctx: ToolContext,
  t: FlowTarget,
  row: FlowRow,
  slug: string,
  b: Block,
  fnById: Map<string, FunctionRow>,
  fnsLoaded: boolean,
  run: ParsedRun | null,
): SampleSource | null {
  const ref = b.type === 'variable' ? 'vals' : DATA_TYPES.has(b.type) ? 'res' : null
  if (!ref || b.status === 'DELETE') return null
  const src: SampleSource = { id: slug, ref, base: `context.${ref}.${slug}`, stepId: b.identifier, type: b.type, declined: isDeclined(ctx, t, b.identifier) }
  let documented: unknown
  let pd: PluginData | null = null
  if (b.type === 'plugin') {
    pd = pluginDataOf(b, b.identifier ? fnById.get(b.identifier) : undefined)
    // A saved app step keeps its definition in the functions table; if that could not be read, it is unknown.
    if (!b.metaData && !fnsLoaded) pd = null
    src.app = pd?.serviceName
    src.action = pd?.actionName
    documented = parseMaybeJson(pd?.sampleData)
  }
  const h = b.identifier ? held.get(`${flowKey(ctx, t)}|step|${b.identifier}`) : undefined
  if (h && meaningful(h.data)) return { ...src, origin: 'tested', data: cleanSample(h.data), note: 'Tested in this session.' }
  const saved = parseMaybeJson(b.sampleData)
  if (meaningful(saved)) {
    // Steps added in the editor start with the app's example as their sample. When the example cannot be read (no
    // app definition), a saved sample cannot be told apart from it, so it counts as documented.
    const isDocumented = b.type === 'plugin' && (!pd || (meaningful(documented) && deepEqual(cleanSample(saved), cleanSample(documented))))
    if (!isDocumented) return { ...src, origin: 'tested', compacted: true, data: cleanSample(saved), note: 'Saved from an earlier test.' }
    if (!meaningful(documented)) documented = saved
  }
  const fromRun = run && runMatchesStep(row, slug, b, pd) ? run[ref][slug] : undefined
  if (meaningful(fromRun)) return { ...src, origin: 'run', data: cleanSample(fromRun), note: 'From the latest run.' }
  if (meaningful(documented)) {
    return {
      ...src,
      origin: 'documented',
      data: cleanSample(documented),
      note: `Only the app's documented example, not real output: test it (vs_test_step "${slug}").${src.declined ? ' The user declined that test.' : ''}`,
    }
  }
  src.note = b.status === 'DRAFTED' ? 'Unsaved draft: finish it with vs_update_step, then test it.' : `Not tested yet: run vs_test_step "${slug}".`
  return src
}

export interface CatalogueOptions {
  /** Use the latest run as a sample source (default true) */
  useRun?: boolean
  /** A payload given for a test, used as the trigger sample */
  payload?: unknown
  /**
   * Webhook and schedule triggers: the request as it arrives, before Get Data, the loop key and the per-item split
   * (what Get Data itself can read). Default: what the steps see.
   */
  rawTrigger?: boolean
}

export async function buildCatalogue(ctx: ToolContext, t: FlowTarget, row: FlowRow, pos: Position, opts: CatalogueOptions = {}): Promise<Catalogue> {
  const js = row.json_script
  const { earlier, later, label } = splitAt(js, flowOrder(js), pos)
  let run: ParsedRun | null = null
  if (opts.useRun !== false) {
    try {
      run = await getRecentRun(ctx, t)
    } catch (e) {
      if (isAbortError(e)) throw e
    }
  }
  const sources: SampleSource[] = [await triggerSource(ctx, t, row, run, opts.payload, opts.rawTrigger === true)]
  let fns: FunctionRow[] = []
  let fnsLoaded = true
  // Saved app steps keep their documented example only in the functions table.
  if (earlier.some((s) => js.blocks[s]?.type === 'plugin' && !js.blocks[s]?.metaData)) {
    try {
      fns = await listFunctionRows(ctx, t)
    } catch (e) {
      if (isAbortError(e)) throw e
      fnsLoaded = false
    }
  }
  const fnById = new Map(fns.map((f) => [f.id, f]))
  for (const slug of earlier) {
    const b = js.blocks[slug]
    const src = b ? stepSource(ctx, t, row, slug, b, fnById, fnsLoaded, run) : null
    if (src) sources.push(src)
  }
  return { sources, byId: new Map(sources.map((s) => [s.id, s])), triggerKind: triggerKind(js.trigger), earlier, later, js, position: label, run }
}

/**
 * A documented example is never real data. It may stand in only for a step whose test the user declined, and only
 * when the caller says so (allowDocumentedSample); never for the trigger, whose test only reads.
 */
export function documentedAllowed(src: SampleSource | undefined, allowDocumented: boolean): boolean {
  return !!src && src.origin === 'documented' && allowDocumented && src.id !== 'trigger' && src.declined === true
}

export function usable(src: SampleSource | undefined, allowDocumented: boolean): boolean {
  return !!src?.origin && (src.origin !== 'documented' || documentedAllowed(src, allowDocumented))
}

/** variables.context for a dry run: the trigger sample as req (body, query, headers), earlier steps under res / vals. */
export function testContext(cat: Catalogue, allowDocumented: boolean): RunContext {
  const trigger = cat.byId.get('trigger')
  const ok = usable(trigger, allowDocumented)
  const context: RunContext = {
    req: {
      body: ok ? (trigger?.data ?? {}) : {},
      headers: ok ? asRecord(trigger?.headers) : {},
      query: ok && isRecord(trigger?.query) ? trigger.query : {},
    },
    res: {},
    vals: {},
  }
  for (const s of cat.sources) {
    if (s.id === 'trigger' || !usable(s, allowDocumented)) continue
    if (s.ref === 'res') context.res[s.id] = s.data
    else if (s.ref === 'vals') context.vals[s.id] = s.data
  }
  return context
}
