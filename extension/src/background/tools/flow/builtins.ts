// Built-in tools of the editor's "Add step" panel, found in viaSocket's app catalog at run time. Action ids are
// never hard-coded: they differ per environment, and the catalog is the source of truth.
//
// - Built-in apps: catalog apps flagged as built-in plugs (Summarize Text, Translate Text, Convert HTML to PDF, ...).
//   Every published action of them can be added as an app step.
// - The panel's own tools that are catalog actions underneath: Delay, Human Intervention (one action per channel),
//   Call AI Agent (Instant / Background), Flow in Flow and Workspace Memory. They are matched by name among the
//   built-in apps, or through an app search, and confirmed after creation by what viaSocket attaches: a delay or
//   approval pause, or the step's built-in connection.
// - Action rows of built-ins are read without the workspace filter, as the panel does: some are hidden from the
//   public catalog. Only ids that came from these lookups are read that way.

import type { ToolContext } from '../types'
import { type ActionRow, getActionRow, isPaidAction, normalizeInputJson, fieldList } from './catalog'
import { call, isAbortError, ToolError } from './errors'
import { requireOrg } from './flow-api'
import type { Block, FieldDef, InputJson } from './types'
import { asArray, asRecord, isRecord, parseMaybeJson, ROW_ID_RE, str, truncate } from './util'

export type SpecialKind = 'delay' | 'approval' | 'ai_agent' | 'ai_agent_background' | 'flow_in_flow' | 'memory'

const CACHE_MS = 30 * 60_000
const EMPTY_CACHE_MS = 5 * 60_000
const ACTION_FIELDS = ['type', 'rowid', 'name', 'pluginrecordid', 'pluginname', 'iconurl', 'actionversionrecordid', 'description', 'authidlookup', 'authtype', 'meta_data', 'category'].join(',')

export interface BuiltinApp {
  rowid: string
  name?: string
  description?: string
}

interface CatalogEntry {
  at: number
  apps: BuiltinApp[]
  actions: ActionRow[]
}

const catalogs = new Map<string, CatalogEntry>()
const specials = new Map<string, { at: number; rows: ActionRow[] }>()
/** Ids that came from built-in lookups: only these may be read without the workspace filter */
const knownBuiltinIds = new Map<string, SpecialKind | 'app'>()

function rowsOf(body: unknown): Record<string, unknown>[] {
  const d = asRecord(body).data
  if (Array.isArray(d)) return d.filter(isRecord)
  const rows = asRecord(d).rows
  if (Array.isArray(rows)) return rows.filter(isRecord)
  return asArray(asRecord(asRecord(d).data).rows).filter(isRecord)
}

function nameOf(a: ActionRow): string {
  return (str(a.name) ?? '').trim()
}

async function actionsOfApps(ctx: ToolContext, appIds: string[]): Promise<ActionRow[]> {
  const ids = appIds.filter((id) => ROW_ID_RE.test(id)).slice(0, 50)
  if (!ids.length) return []
  const body = await call('Listing built-in tool actions', () =>
    ctx.vs.request({
      method: 'GET',
      path: '/dbdash/getpluginbyplugid/action',
      // No orgId, as the panel: the workspace filter hides some built-in actions.
      query: { pluginrecordid: ids.join(','), type: 'action', status: 'published', fields: ACTION_FIELDS },
      signal: ctx.signal,
    }),
  )
  return rowsOf(body).filter((r): r is ActionRow => typeof r.rowid === 'string' && ROW_ID_RE.test(r.rowid))
}

/** Built-in apps and their published actions (cached per environment). */
export async function builtinCatalog(ctx: ToolContext): Promise<CatalogEntry> {
  const key = ctx.vs.env.apiBase
  const cached = catalogs.get(key)
  if (cached && Date.now() - cached.at < (cached.apps.length ? CACHE_MS : EMPTY_CACHE_MS)) return cached
  const body = await call('Listing built-in tools', () =>
    ctx.vs.request({ method: 'GET', path: '/dbdash/getplugin', query: { categoryFilter: 'isbuiltinplugin=true', limit: 50 }, signal: ctx.signal }),
  )
  const apps = rowsOf(body)
    .filter((r) => typeof r.rowid === 'string' && ROW_ID_RE.test(r.rowid))
    .map((r) => ({ rowid: String(r.rowid), name: str(r.name), description: r.description ? truncate(String(r.description), 140) : undefined }))
  const actions = await actionsOfApps(
    ctx,
    apps.map((a) => a.rowid),
  )
  for (const a of actions) if (!knownBuiltinIds.has(a.rowid)) knownBuiltinIds.set(a.rowid, 'app')
  const entry = { at: Date.now(), apps, actions }
  catalogs.set(key, entry)
  return entry
}

const isAgent = (a: ActionRow) => /\bai[\s_]*agent\b/i.test(nameOf(a))
const isBackground = (a: ActionRow) => /background|batch|async|slow/i.test(`${nameOf(a)} ${str(a.description) ?? ''}`)

const RULES: Record<SpecialKind, { queries: string[]; app?: RegExp; match: (a: ActionRow) => boolean }> = {
  delay: { queries: ['viaSocket utilities'], app: /viasocket/i, match: (a) => /^(pause[\s_]*workflow|delay)$/i.test(nameOf(a)) },
  flow_in_flow: { queries: ['viaSocket utilities', 'Flow in Flow'], match: (a) => /^flow[\s_]*in[\s_]*flow$/i.test(nameOf(a)) },
  ai_agent: { queries: ['AI Agent', 'GTWY'], match: (a) => isAgent(a) && !isBackground(a) },
  ai_agent_background: { queries: ['AI Agent', 'GTWY'], match: (a) => isAgent(a) && isBackground(a) },
  approval: { queries: ['Human Intervention', 'Approval'], match: (a) => /intervention|approval/i.test(`${nameOf(a)} ${str(a.pluginname) ?? ''}`) },
  memory: { queries: ['Memory'], app: /memory/i, match: (a) => /memory/i.test(`${str(a.pluginname) ?? ''} ${nameOf(a)}`) },
}

async function searchServices(ctx: ToolContext, query: string): Promise<Array<{ id: string; name: string }>> {
  const body = await call('Searching built-in tools', () =>
    ctx.vs.request({ method: 'GET', path: '/dbdash/getPluginByQuery', query: { query, mode: 'flow' }, signal: ctx.signal }),
  )
  return asArray(asRecord(body).data)
    .map((item) => (isRecord(item) && isRecord(item._source) ? item._source : item))
    .filter(isRecord)
    .map((r) => ({ id: str(r.rowid) ?? '', name: str(r.name) ?? '' }))
    .filter((r) => ROW_ID_RE.test(r.id))
    .slice(0, 3)
}

/**
 * Catalog actions behind one of the panel's tools. Found among the built-in apps first, then through an app
 * search; an empty list means this environment does not offer it (or it could not be found).
 */
export async function resolveSpecial(ctx: ToolContext, kind: SpecialKind): Promise<ActionRow[]> {
  const key = `${ctx.vs.env.apiBase}|${kind}`
  const cached = specials.get(key)
  if (cached && Date.now() - cached.at < (cached.rows.length ? CACHE_MS : EMPTY_CACHE_MS)) return cached.rows
  const rule = RULES[kind]
  let rows: ActionRow[] = []
  try {
    rows = (await builtinCatalog(ctx)).actions.filter(rule.match)
  } catch (e) {
    if (isAbortError(e)) throw e
  }
  if (!rows.length) {
    await ctx.vs.alignOrg(ctx.signal)
    const seen = new Set<string>()
    for (const q of rule.queries) {
      let services: Array<{ id: string; name: string }> = []
      try {
        services = await searchServices(ctx, q)
      } catch (e) {
        if (isAbortError(e)) throw e
        continue
      }
      const ids = services.filter((s) => !seen.has(s.id) && (!rule.app || rule.app.test(s.name))).map((s) => s.id)
      ids.forEach((id) => seen.add(id))
      try {
        rows.push(...(await actionsOfApps(ctx, ids)).filter(rule.match))
      } catch (e) {
        if (isAbortError(e)) throw e
      }
      if (rows.length) break
    }
  }
  const unique = [...new Map(rows.map((r) => [r.rowid, r])).values()]
  for (const r of unique) knownBuiltinIds.set(r.rowid, kind)
  specials.set(key, { at: Date.now(), rows: unique })
  return unique
}

/** A built-in found by these lookups, read whole (fields, sample, perform) without the workspace filter. */
async function fullBuiltinRow(ctx: ToolContext, actionId: string): Promise<ActionRow> {
  const body = await call('Reading the built-in tool', () =>
    ctx.vs.request({ method: 'GET', path: '/dbdash/getpluginbyplugid/action', query: { rowid: actionId }, signal: ctx.signal }),
  )
  const row = rowsOf(body)[0]
  if (!row || typeof row.rowid !== 'string') throw new ToolError(`Built-in tool ${actionId} was not found.`)
  return row as ActionRow
}

/**
 * Full action row of an app action, or of a built-in tool from vs_list_builtin_tools (some are hidden from the
 * workspace-filtered catalog). Fails for unknown ids.
 */
export async function getActionRowAny(ctx: ToolContext, actionId: string): Promise<ActionRow> {
  try {
    return await getActionRow(ctx, actionId)
  } catch (e) {
    if (!(e instanceof ToolError)) throw e
    if (!knownBuiltinIds.has(actionId)) {
      try {
        await builtinCatalog(ctx)
      } catch (err) {
        if (isAbortError(err)) throw err
      }
    }
    if (!knownBuiltinIds.has(actionId)) throw e
    return fullBuiltinRow(ctx, actionId)
  }
}

/** Which of the panel's tools an action is, when the lookups above identified it. */
export function knownKind(actionId: string | undefined): SpecialKind | undefined {
  const k = actionId ? knownBuiltinIds.get(actionId) : undefined
  return k && k !== 'app' ? k : undefined
}

export function rememberBuiltin(actionId: string, kind: SpecialKind): void {
  knownBuiltinIds.set(actionId, kind)
}

/** Panel tools that run with viaSocket's hidden built-in connection (never a user connection). */
export const HIDDEN_AUTH_KINDS: ReadonlySet<SpecialKind> = new Set(['ai_agent', 'ai_agent_background', 'flow_in_flow'])

/**
 * Which panel tool an action is. The ids found by earlier lookups live only as long as this service worker, so
 * after a restart the lookups for the hidden-connection tools run again (cached) before an id counts as ordinary.
 */
export async function identifySpecial(ctx: ToolContext, actionId: string | undefined): Promise<SpecialKind | undefined> {
  if (!actionId) return undefined
  const known = knownKind(actionId)
  if (known || knownBuiltinIds.get(actionId) === 'app') return known
  for (const kind of ['ai_agent', 'ai_agent_background', 'flow_in_flow'] as const) {
    try {
      await resolveSpecial(ctx, kind)
    } catch (e) {
      if (isAbortError(e)) throw e
    }
    const k = knownKind(actionId)
    if (k) return k
  }
  return undefined
}

/**
 * Which panel tool a saved or new step is, from what viaSocket attached to it (survives restarts): a delay or
 * approval pause, or its hidden built-in connection plus an agent or flow picker.
 */
export function kindFromStep(block: Block | undefined, pd: { inputJson?: unknown; selectedValues?: { authData?: unknown } } | null | undefined): SpecialKind | undefined {
  const bp = asRecord(block?.breakPoint)
  if (bp.isDelay === true) return 'delay'
  if (bp.isIntervention === true) return 'approval'
  const auth = asRecord(pd?.selectedValues?.authData ?? asRecord(block?.metaData?.selectedValues).authData)
  if (auth.hidden !== true) return undefined
  const ij = normalizeInputJson(pd?.inputJson ?? block?.metaData?.inputJson)
  if (findField(ij, 'agent')) return bp.asyncPlugin === true ? 'ai_agent_background' : 'ai_agent'
  if (findField(ij, 'flow')) return 'flow_in_flow'
  return undefined
}

// ---- Fields of these tools (their keys live in the catalog, not in viaSocket's code) ---------------------------

function textOf(key: string, def: FieldDef): string {
  return `${key} ${str(def.label) ?? ''}`.toLowerCase()
}

function isChoice(def: FieldDef): boolean {
  const type = String(def.type ?? '').toLowerCase()
  return type === 'dropdown' || type === 'multiselect' || (typeof def.source === 'string' && !!def.source.trim()) || Array.isArray(def.children)
}

/** The field of a built-in tool that holds the agent, the user message, the conversation id or the flow to run. */
export function findField(ij: InputJson, role: 'agent' | 'message' | 'thread' | 'flow'): string | undefined {
  const fields = fieldList(ij)
  const pick = (test: (key: string, def: FieldDef) => boolean) => fields.find((f) => !f.group && ij.blocks[f.key] && test(f.key, ij.blocks[f.key] as FieldDef))?.key
  switch (role) {
    case 'agent':
      return pick((k, d) => isChoice(d) && /agent|bridge|assistant|bot/.test(textOf(k, d)))
    case 'flow':
      return pick((k, d) => isChoice(d) && /flow|script/.test(textOf(k, d)))
    case 'thread':
      return pick((k, d) => !isChoice(d) && /thread|conversation/.test(textOf(k, d)))
    case 'message':
      return (
        pick((k, d) => !isChoice(d) && /user message|message|query|question/.test(textOf(k, d)) && !/system|instruction|thread|conversation/.test(textOf(k, d))) ??
        pick((k, d) => !isChoice(d) && /prompt|input|text/.test(textOf(k, d)) && !/system|instruction|thread|conversation/.test(textOf(k, d)))
      )
  }
}

/** The delay value field: the first field of the Delay tool (viaSocket's save requires inputFields[0]). */
export function delayField(meta: Record<string, unknown> | undefined): string | undefined {
  const first = asArray(meta?.inputFields)[0]
  const key = isRecord(first) ? str(first.key) : undefined
  if (key) return key
  return normalizeInputJson(meta?.inputJson).steps.root?.[0]
}

export interface DelaySpec {
  duration?: number
  unit?: 'minutes' | 'hours' | 'days'
  until?: string
  delayFrom?: string
}

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const
/** The scheduler resumes a paused run after 0..43200 minutes (30 days); the Delay tool asks for at least 1. */
export const MAX_DELAY_MINUTES = 43_200

/**
 * The Delay field value: a whole number of minutes, or a template that computes them when the step runs (until a
 * date), or an insert text from earlier data. display is what the canvas shows.
 */
export function delayValue(d: DelaySpec, now = Date.now()): { value: string; display: string; minutes?: number } | { error: string } {
  const modes = [d.duration !== undefined, d.until !== undefined, d.delayFrom !== undefined].filter(Boolean).length
  if (modes !== 1) return { error: 'give exactly one of: duration (with unit), until, or delayFrom' }
  if (d.duration !== undefined) {
    const unit = d.unit ?? 'minutes'
    const minutes = Math.round(d.duration * UNIT_MINUTES[unit])
    if (!Number.isFinite(minutes) || minutes < 1) return { error: 'the delay must be at least 1 minute' }
    if (minutes > MAX_DELAY_MINUTES) return { error: `the delay can be at most 30 days (${MAX_DELAY_MINUTES} minutes); this is ${minutes} minutes` }
    const shown = Number.isInteger(d.duration) ? String(d.duration) : String(Math.round(d.duration * 100) / 100)
    return { value: String(minutes), display: `${shown} ${d.duration === 1 ? unit.replace(/s$/, '') : unit}`, minutes }
  }
  if (d.until !== undefined) {
    const text = d.until.trim()
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
      return { error: 'until must be an ISO date-time with its timezone offset, e.g. 2026-12-01T09:00:00+05:30' }
    }
    const at = Date.parse(text)
    if (!Number.isFinite(at)) return { error: 'until is not a valid date-time' }
    const ahead = Math.ceil((at - now) / 60_000)
    if (ahead < 1) return { error: 'until is in the past' }
    if (ahead > MAX_DELAY_MINUTES) return { error: 'until is more than 30 days ahead, the longest a run can wait' }
    // Computed when the step runs, so the wait ends at that moment whenever the flow reaches the step.
    const value = `\${Math.min(${MAX_DELAY_MINUTES}, Math.max(1, Math.ceil((Date.parse(${JSON.stringify(text)}) - Date.now()) / 60000)))}`
    return { value, display: `until ${text}` }
  }
  const from = (d.delayFrom ?? '').trim()
  if (!/^\$\{[^}]+\}$/.test(from)) return { error: 'delayFrom must be one insert text from vs_get_variables (a number of minutes), e.g. ${context.res.Compute_Wait.minutes}' }
  return { value: from, display: from }
}

// ---- Checks after creation ---------------------------------------------------------------------------------

/** What viaSocket attaches to a correctly created tool; a mismatch means the catalog match was wrong. */
export function verifyCreated(kind: SpecialKind, block: Block): string | undefined {
  const bp = asRecord(block.breakPoint)
  const auth = asRecord(asRecord(block.metaData?.selectedValues).authData)
  switch (kind) {
    case 'delay':
      return bp.isDelay === true ? undefined : 'viaSocket did not mark it as a Delay (no pause attached)'
    case 'approval':
      return bp.isIntervention === true ? undefined : 'viaSocket did not mark it as a Human Intervention step (no approval pause attached)'
    case 'ai_agent':
      if (!str(auth.id)) return "viaSocket did not attach the step's built-in connection"
      // An Instant agent never pauses; a pause for an async answer means this is the Background action.
      return bp.asyncPlugin === true ? 'viaSocket made it a background agent step (it pauses for the answer), not an Instant one' : undefined
    case 'ai_agent_background':
    case 'flow_in_flow':
      return str(auth.id) ? undefined : "viaSocket did not attach the step's built-in connection"
    default:
      return undefined
  }
}

/** True when an action is a paid one (each run uses AI credits). */
export function paidAction(row: ActionRow | undefined, block: Block | undefined): boolean {
  return (row ? isPaidAction(row) : false) || block?.isPaidAction === true || asRecord(block?.metaData).isPaidAction === true
}

const blockedCache = new Map<string, { at: number; value: boolean | undefined }>()

/** Whether the workspace's AI credits ran out (paid flows then stop). Best-effort; undefined when unknown. */
export async function paidFlowsBlocked(ctx: ToolContext): Promise<boolean | undefined> {
  const orgId = requireOrg(ctx)
  const key = `${ctx.vs.env.apiBase}|${orgId}`
  const c = blockedCache.get(key)
  if (c && Date.now() - c.at < 5 * 60_000) return c.value
  let value: boolean | undefined
  try {
    const body = await ctx.vs.request({ method: 'GET', path: `/billing/${orgId}/lago/subscription/all`, signal: ctx.signal })
    const d = asRecord(asRecord(body).data)
    const flag = d.arePaidFlowsBlocked ?? asRecord(d.data).arePaidFlowsBlocked
    value = typeof flag === 'boolean' ? flag : undefined
  } catch (e) {
    if (isAbortError(e)) throw e
    value = undefined
  }
  blockedCache.set(key, { at: Date.now(), value })
  return value
}

export const CREDITS_NOTE = 'This is a paid action: every run uses AI credits (1 AI credit = 4 tasks). Tell the user.'

/** A short catalog entry for the model. */
export function actionEntry(a: ActionRow): Record<string, unknown> {
  return {
    actionId: a.rowid,
    name: nameOf(a) || undefined,
    app: str(a.pluginname),
    description: a.description ? truncate(String(a.description), 140) : undefined,
    needsConnection: !!a.authtype && a.authtype !== 'NoAuth' ? true : undefined,
    isPaidAction: isPaidAction(a) || undefined,
  }
}

/** The documented sample of an action row, for the create body (as the panel sends it). */
export function documentedSample(row: ActionRow): unknown {
  const s = parseMaybeJson(row.sampledata)
  return s === null || s === '' ? undefined : s
}
