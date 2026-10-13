// Field rules of app steps and app triggers, mirroring the viaSocket editor's step panel:
// - which fields are required and visible (required flag, input groups, visibilityCondition, dependsOn);
// - what is still missing, phrased as questions the assistant can ask the user;
// - dropdown options, static (inputJson children) or loaded by the field's own `source` through the execute route,
//   and the check that a saved choice is one of them;
// - default values, filled in like the panel does for visible empty fields;
// - input groups whose fields the app generates (a group with a `source`), loaded and merged into inputJson;
// - values from an earlier, incomplete call, kept for this service-worker lifetime so a follow-up call can finish
//   the step (viaSocket itself cannot store a half-configured step: saving marks it complete).
//
// visibilityCondition is a JavaScript expression. eval is unavailable in MV3 service workers, so a small evaluator
// handles the common forms (comparisons, &&, ||, !, includes) and answers "unknown" for anything else.

import type { ToolContext } from '../types'
import { ToolError } from './errors'
import { encodeInputData } from './input-data'
import { executeDryRun, type DryRunResult } from './runs'
import type { AuthData, FieldDef, FlowTarget, InputJson } from './types'
import { asArray, asRecord, isRecord, str, truncate } from './util'

export const CUSTOM_INPUT = 'CUSTOM_INPUT'
const MAX_OPTIONS = 100
const CACHE_MAX = 300

/** Same rule as the editor: booleans and numbers count, empty strings, arrays and objects do not. */
export function valueExists(v: unknown): boolean {
  if (typeof v === 'boolean' || typeof v === 'number') return true
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (isRecord(v)) return Object.keys(v).length > 0
  return false
}

function isGroup(def: FieldDef | undefined): boolean {
  return typeof def?.type === 'string' && def.type.toLowerCase() === 'input groups'
}

function typeOf(def: FieldDef | undefined): string {
  return typeof def?.type === 'string' ? def.type.toLowerCase() : 'string'
}

/** Field definitions reachable from the root (what the dry run expects as inputFieldsBlocks). */
export function reachableFields(ij: InputJson): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const walk = (loc: string, depth: number) => {
    for (const k of ij.steps[loc] ?? []) {
      if (k in out) continue
      const b = ij.blocks[k]
      if (b) out[k] = b
      if (ij.steps[k] && depth < 5) walk(k, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

/** The field a stored inputData key belongs to: `_x`, `_x-Type`, `x_extraValue` and `g["_c"]` map to x / g["c"]. */
function fieldKeyOf(k: string): string {
  const nested = /^(.+)\["_?([^"\]]+?)(?:-Type)?"\]$/.exec(k)
  if (nested) return `${nested[1]}["${nested[2]}"]`
  return k.replace(/^_/, '').replace(/-Type$/, '').replace(/_extraValue$/, '')
}

/**
 * inputData limited to fields that exist and are not hidden, plus the keys the runtime reads besides fields. The
 * editor sends exactly this to dry runs and to saves of steps and triggers (removeGarbageDataFromSelectedValues).
 */
export function cleanInputData(inputData: Record<string, unknown>, ij: InputJson): Record<string, unknown> {
  const values = conditionValues(inputData)
  const keep = new Set<string>()
  const walk = (loc: string, depth: number) => {
    for (const k of ij.steps[loc] ?? []) {
      const def = ij.blocks[k]
      if (def?.visibilityCondition && evalCondition(String(def.visibilityCondition), values) === false) continue
      keep.add(k)
      if (ij.steps[k] && depth < 5) walk(k, depth + 1)
    }
  }
  walk('root', 0)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputData)) {
    if (k === 'hookUrl' || k === 'performSubscribe' || k === 'scheduledTime' || keep.has(fieldKeyOf(k))) out[k] = v
  }
  return out
}

/** context.inputData as visibility conditions and option loaders see it: values only, underscore copies removed. */
export function conditionValues(inputData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputData)) {
    if (k.startsWith('_') || k.endsWith('-Type') || k.includes('["_')) continue
    const m = /^([^[\]]+)\["([^"\]]+)"\]$/.exec(k)
    if (m && m[1] && m[2]) {
      const group = isRecord(out[m[1]]) ? (out[m[1]] as Record<string, unknown>) : {}
      group[m[2]] = v
      out[m[1]] = group
    } else out[k] = v
  }
  return out
}

/** Sibling fields an option loader reads (context.inputData.X), unless the definition lists them. */
export function fieldDeps(key: string, def: FieldDef): string[] {
  if (Array.isArray(def.dependsOn) && def.dependsOn.length) return def.dependsOn.filter((d): d is string => typeof d === 'string' && d !== key)
  return usedInputs(def.source, key)
}

/** The editor's extractUsedVariables: context.inputData.X (and ["X"]) read by a source. */
function usedInputs(source: unknown, key: string): string[] {
  const src = typeof source === 'string' ? source.replaceAll('?.', '.') : ''
  const out = new Set<string>()
  for (const m of src.matchAll(/context\.inputData\.([A-Za-z_$][\w$]*)/g)) if (m[1] && m[1] !== key) out.add(m[1])
  for (const m of src.matchAll(/context\.inputData\[\s*["']([^"']+)["']\s*\]/g)) if (m[1] && m[1] !== key) out.add(m[1])
  return [...out]
}

function visible(def: FieldDef, values: Record<string, unknown>): boolean | undefined {
  return def.visibilityCondition ? evalCondition(String(def.visibilityCondition), values) : true
}

export interface FieldOption {
  label: string
  value: unknown
  key?: unknown
  extraValue?: unknown
  /** The option object as the app returned it (stored in inputJson when picked, like the editor) */
  raw?: Record<string, unknown>
}

function toOption(o: unknown): FieldOption | null {
  if (!isRecord(o)) return null
  if (o.value === CUSTOM_INPUT) return null
  const value = o.value !== undefined ? o.value : o.key
  if (value === undefined) return null
  const out: FieldOption = { label: truncate(String(o.label ?? (typeof value === 'object' ? JSON.stringify(value) : value)), 100), value, raw: o }
  if (o.key !== undefined) out.key = o.key
  if (o.extraValue !== undefined) out.extraValue = o.extraValue
  return out
}

/** Fixed choices of a field: its children (the app's options), plus a default value that is not among them. */
export function staticOptions(def: FieldDef): FieldOption[] {
  const out = asArray(def.children).map(toOption).filter((o): o is FieldOption => !!o)
  const dv = toOption(def.defaultValue)
  if (dv && !out.some((o) => sameValue(o.value, dv.value))) out.push(dv)
  if (!out.length && typeOf(def) === 'boolean') {
    return [
      { label: 'true', value: true },
      { label: 'false', value: false },
    ]
  }
  return out
}

function hasSource(def: FieldDef): boolean {
  return typeof def.source === 'string' && def.source.trim().length > 0
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}

// ---- Required and missing fields ---------------------------------------------------------------------------

/** A group whose fields the app generates and that has not generated them yet (the editor counts it required). */
function ungenerated(ij: InputJson, key: string): boolean {
  const def = ij.blocks[key]
  return !!def && isGroup(def) && hasSource(def) && ij.steps[key] === undefined
}

function requiredIn(ij: InputJson, loc: string): string[] {
  return (ij.steps[loc] ?? []).filter((k) => {
    const def = ij.blocks[k]
    return !!def && (def.required === true || (isGroup(def) && hasRequiredChildren(ij, k, 0)))
  })
}

function hasRequiredChildren(ij: InputJson, key: string, depth: number): boolean {
  if (depth > 5) return false
  if (ungenerated(ij, key)) return true
  return (ij.steps[key] ?? []).some((c) => {
    const def = ij.blocks[c]
    return !!def && (def.required === true || (isGroup(def) && hasRequiredChildren(ij, c, depth + 1)))
  })
}

function dictionaryFilled(v: unknown): boolean {
  return Object.values(asRecord(v)).some((e) => {
    const r = asRecord(e)
    return valueExists(r.key) && valueExists(r._key) && valueExists(r.value) && valueExists(r._value)
  })
}

export interface NeedInput {
  key: string
  label?: string
  required: boolean
  hasOptions: boolean
  hint: string
  dependsOn?: string[]
  shownWhen?: string
  /** An input group whose fields the app generates (they load once its parents and the connection are set) */
  generatesFields?: boolean
  /** Insert texts of tested data whose names match this field (for fields that usually come from earlier data) */
  candidateInserts?: string[]
}

export function needFor(key: string, def: FieldDef, values: Record<string, unknown>, required: boolean, extraHint?: string): NeedInput {
  const deps = fieldDeps(key, def).filter((d) => !valueExists(values[d]))
  const options = staticOptions(def)
  const dynamic = hasSource(def)
  const group = isGroup(def)
  let hint: string
  if (group) {
    hint = deps.length
      ? `Its fields come from the app once ${deps.join(', ')} ${deps.length > 1 ? 'are' : 'is'} filled; fill that first, then call again to see them.`
      : 'Its fields come from the app: they load with the connection (vs_get_field_options with this key lists them), then ask for the required ones.'
  } else if (deps.length) hint = `Fill ${deps.join(', ')} first; ${dynamic ? 'then load its choices with vs_get_field_options' : 'then ask for this one'}.`
  else if (dynamic) hint = 'Load the real choices with vs_get_field_options and ask the user to pick one.'
  else if (options.length) {
    const labels = options.slice(0, 6).map((o) => o.label)
    hint = `Ask the user to pick one: ${labels.join(' / ')}${options.length > 6 ? ` (+${options.length - 6} more, see vs_get_field_options)` : ''}.`
  } else {
    const help = def.help ? truncate(String(def.help).replace(/<[^>]*>/g, ''), 120) : def.placeholder ? `e.g. ${truncate(String(def.placeholder), 60)}` : ''
    hint = `Ask the user for it${help ? ` (${help})` : ''}.`
  }
  if (extraHint) hint = `${extraHint} ${hint}`
  return {
    key,
    label: str(def.label),
    required,
    hasOptions: !group && (dynamic || options.length > 0),
    hint,
    dependsOn: deps.length ? deps : undefined,
    shownWhen: def.visibilityCondition ? truncate(String(def.visibilityCondition), 120) : undefined,
    generatesFields: group || undefined,
  }
}

/**
 * Required fields that are visible and still empty, in panel order (the editor's getMissingRequiredFields).
 * `blocking` must be filled before the step can be saved; `maybe` are required fields whose visibility rule could
 * not be evaluated here, so they may or may not apply. A group whose fields the app has not generated yet blocks.
 */
export function missingInputs(ij: InputJson, inputData: Record<string, unknown>): { blocking: NeedInput[]; maybe: NeedInput[] } {
  const values = conditionValues(inputData)
  const blocking: NeedInput[] = []
  const maybe: NeedInput[] = []
  const walk = (loc: string, depth: number) => {
    for (const key of requiredIn(ij, loc)) {
      const def = ij.blocks[key]
      if (!def) continue
      const vis = visible(def, values)
      if (vis === false) continue
      if (isGroup(def)) {
        if (ungenerated(ij, key)) {
          if (vis === undefined) maybe.push(needFor(key, def, values, false, 'May be required (its visibility rule could not be checked).'))
          else blocking.push(needFor(key, def, values, true))
        } else if (ij.steps[key] && depth < 5) walk(key, depth + 1)
        continue
      }
      const filled = def.type === 'dictionary' ? dictionaryFilled(inputData[key]) : valueExists(inputData[key])
      if (filled) continue
      if (vis === undefined) maybe.push(needFor(key, def, values, false, 'May be required (its visibility rule could not be checked).'))
      else blocking.push(needFor(key, def, values, true))
    }
  }
  walk('root', 0)
  return { blocking, maybe }
}

// ---- Default values ------------------------------------------------------------------------------------------

export interface AppliedDefault {
  key: string
  label?: string
  value: unknown
}

/**
 * Fills visible, empty fields that have a defaultValue, as the panel does when it shows them (pluginHocV2
 * setDefaultValue): dropdowns and booleans take the default option's value, multiselects the values of the default
 * options, other fields the default itself. A dropdown or multiselect default is also recorded as the picked option.
 * Mutates inputData; returns inputJson with the picks and what was filled.
 */
export function applyDefaults(ij: InputJson, inputData: Record<string, unknown>): { ij: InputJson; applied: AppliedDefault[] } {
  const applied: AppliedDefault[] = []
  let steps = ij.steps
  let blocks = ij.blocks
  const walk = (loc: string, depth: number) => {
    for (const key of ij.steps[loc] ?? []) {
      const def = ij.blocks[key]
      if (!def) continue
      const values = conditionValues(inputData)
      if (visible(def, values) !== true) continue
      if (isGroup(def)) {
        if (ij.steps[key] && depth < 5) walk(key, depth + 1)
        continue
      }
      const dv = def.defaultValue
      if (dv === undefined || dv === null || dv === '' || valueExists(inputData[key])) continue
      if (fieldDeps(key, def).some((d) => !valueExists(values[d]))) continue
      const type = typeOf(def)
      if (['dictionary', 'help', 'aifield', 'input groups'].includes(type)) continue
      let value: unknown
      const picks: Record<string, unknown>[] = []
      if (type === 'dropdown' || type === 'boolean') {
        value = isRecord(dv) ? dv.value : dv
        if (type === 'dropdown' && isRecord(dv)) picks.push(dv)
      } else if (type === 'multiselect') {
        const list = asArray(dv).filter(isRecord)
        if (!list.length) continue
        value = list.map((o) => o.value)
        picks.push(...list)
      } else value = dv
      if (!valueExists(value)) continue
      Object.assign(inputData, encodeInputData({ [key]: value }, ij, inputData).inputData)
      if (picks.length) {
        const merged = withPicks({ steps, blocks }, key, picks)
        steps = merged.steps
        blocks = merged.blocks
      }
      applied.push({ key, label: str(def.label), value: typeof value === 'string' ? truncate(value, 80) : value })
    }
  }
  walk('root', 0)
  return { ij: applied.length ? { steps, blocks } : ij, applied }
}

/** convertToNewStructure(options, field, false): the picked options under steps[field] and their blocks. */
function withPicks(ij: InputJson, field: string, options: Record<string, unknown>[]): InputJson {
  const steps = { ...ij.steps }
  const blocks = { ...ij.blocks }
  for (const old of steps[field] ?? []) if (old.startsWith(`${field}[`) || old.startsWith(`${field}.`)) delete blocks[old]
  const keys: string[] = []
  for (const o of options) {
    const id = o.key !== undefined ? o.key : o.value
    const childKey = `${field}[${JSON.stringify(id)}]`
    keys.push(childKey)
    blocks[childKey] = { ...o } as FieldDef
  }
  steps[field] = keys
  return { steps, blocks }
}

// ---- Fields generated by the app (input groups with a source) ------------------------------------------------

function dictionaryEntries(result: InputJson, key: string, item: Record<string, unknown>): void {
  const row = `${key}[${JSON.stringify(Math.random().toString(36).slice(2, 7))}]`
  const template = asRecord(item.template)
  for (const part of ['key', 'value'] as const) {
    const def: FieldDef = { ...asRecord(template[part]), key: `${row}["${part}"]` }
    if (def.option !== undefined) def.children = def.option as FieldDef['children']
    result.blocks[`${row}["${part}"]`] = def
  }
  result.blocks[row] = { type: 'dictionary' }
  result.blocks[key] = item as FieldDef
  result.steps[row] = [`${row}["key"]`, `${row}["value"]`]
  result.steps[key] = [row]
}

/**
 * The editor's convertToNewStructure: field definitions (as an app's source returns them) as steps/blocks under
 * `location`. Child keys of a group are location["childKey"]; input groups recurse; options and generators are
 * renamed the way the editor reads them.
 */
export function toInputJson(defs: unknown[], location: string, addDependsOn = true): InputJson {
  const result: InputJson = { steps: { [location]: [] }, blocks: {} }
  const process = (item: Record<string, unknown>, includeLocation: boolean, depth: number) => {
    const id = item.key !== undefined ? item.key : item.value
    const key = includeLocation ? `${location}[${JSON.stringify(id)}]` : String(id)
    const type = String(item.type ?? '').toLowerCase()
    if (type === 'dictionary') dictionaryEntries(result, key, item)
    else if (type === 'input groups') {
      const { children, fields, fieldsGenerator, ...rest } = item
      const block: FieldDef = { ...rest }
      if (fieldsGenerator) block.source = String(fieldsGenerator)
      result.blocks[key] = block
      const kids = Array.isArray(children) ? children : Array.isArray(fields) ? fields : undefined
      if (kids && depth < 5) {
        result.steps[key] = []
        for (const child of kids) {
          if (!isRecord(child)) continue
          const childKey = `${key}[${JSON.stringify(child.key)}]`
          result.steps[key].push(childKey)
          process({ ...child, key: childKey }, false, depth + 1)
        }
      }
    } else {
      const block: FieldDef = { ...item }
      if (Array.isArray(item.options)) block.children = item.options as FieldDef['children']
      if (item.optionsGenerator) block.source = String(item.optionsGenerator)
      if (item.suggestionGenerator) block.source = String(item.suggestionGenerator)
      result.blocks[key] = block
    }
    const made = result.blocks[key]
    if (addDependsOn && made) made.dependsOn = usedInputs(made.source, key)
    if (type === 'multiselect' && Array.isArray(item.defaultValue)) {
      for (const el of item.defaultValue) if (isRecord(el)) result.blocks[`${key}.${String(el.value)}`] = el as FieldDef
    }
  }
  for (const raw of defs) {
    if (!isRecord(raw)) continue
    // makeKeyStringInInputGroup: non-string keys become their JSON text.
    const item = raw.key !== undefined && raw.key !== null && typeof raw.key !== 'string' ? { ...raw, key: JSON.stringify(raw.key) } : raw
    const id = item.key !== undefined ? item.key : item.value
    result.steps[location]?.push(location === 'root' ? String(id) : `${location}[${JSON.stringify(id)}]`)
    process(item, location !== 'root', 0)
  }
  return result
}

/** Generated fields replace the group's earlier ones (their blocks and nested steps). */
function mergeGroup(ij: InputJson, group: string, frag: InputJson): InputJson {
  const steps = { ...ij.steps }
  const blocks = { ...ij.blocks }
  const drop = (k: string, depth: number) => {
    for (const c of steps[k] ?? []) {
      if (depth < 6) drop(c, depth + 1)
      delete blocks[c]
      delete steps[c]
    }
  }
  drop(group, 0)
  for (const [k, list] of Object.entries(frag.steps)) steps[k] = list
  for (const [k, b] of Object.entries(frag.blocks)) blocks[k] = b
  if (!steps[group]) steps[group] = []
  return { steps, blocks }
}
// ---- visibilityCondition evaluator ---------------------------------------------------------------------------

class Unknown extends Error {}
/** Reading a property of undefined throws in the editor, which then treats the rule as false. */
class EvalFalse extends Error {}

type Tok = { t: 'str' | 'num' | 'id' | 'op'; v: string }

const OPS = ['===', '!==', '?.[', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '!', '<', '>', '(', ')', '[', ']', '.', ',']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1] ?? ''
          j += 2
          continue
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') throw new Unknown()
        s += src[j]
        j++
      }
      if (j >= src.length) throw new Unknown()
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Unknown()
    out.push({ t: 'op', v: op })
    i += op.length
  }
  return out
}

const CONTEXT = Symbol('context')

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null
  if (typeof a === typeof b) return a === b
  const na = typeof a === 'boolean' ? Number(a) : a
  const nb = typeof b === 'boolean' ? Number(b) : b
  if (typeof na === 'number' && typeof nb === 'string') return na === Number(nb)
  if (typeof na === 'string' && typeof nb === 'number') return Number(na) === nb
  return na === nb
}

/**
 * true / false for a visibility rule over context.inputData, or undefined when the rule uses anything this small
 * evaluator does not know (other context data, functions, assignments).
 */
export function evalCondition(src: string, inputValues: Record<string, unknown>): boolean | undefined {
  let toks: Tok[]
  try {
    toks = tokenize(src)
  } catch {
    return undefined
  }
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new Unknown()
    p++
  }

  const member = (obj: unknown, key: unknown, optional: boolean): unknown => {
    if (obj === CONTEXT) {
      if (key === 'inputData') return inputValues
      throw new Unknown()
    }
    if (obj == null) {
      if (optional) return undefined
      throw new EvalFalse()
    }
    if (typeof key !== 'string' && typeof key !== 'number') throw new Unknown()
    if (key === 'length' && (typeof obj === 'string' || Array.isArray(obj))) return obj.length
    if (isRecord(obj) || Array.isArray(obj)) return (obj as Record<string, unknown>)[key as string]
    return undefined
  }

  const callMethod = (obj: unknown, name: string, args: unknown[]): unknown => {
    if (typeof obj === 'string') {
      const a = args[0]
      switch (name) {
        case 'includes':
          return typeof a === 'string' && obj.includes(a)
        case 'startsWith':
          return typeof a === 'string' && obj.startsWith(a)
        case 'endsWith':
          return typeof a === 'string' && obj.endsWith(a)
        case 'trim':
          return obj.trim()
        case 'toLowerCase':
          return obj.toLowerCase()
        case 'toUpperCase':
          return obj.toUpperCase()
      }
    }
    if (Array.isArray(obj) && name === 'includes') return obj.some((x) => x === args[0])
    if (obj == null && (name === 'includes' || name === 'startsWith' || name === 'endsWith')) return false
    throw new Unknown()
  }

  const primary = (): unknown => {
    const tk = peek()
    if (!tk) throw new Unknown()
    p++
    if (tk.t === 'str') return tk.v
    if (tk.t === 'num') return Number(tk.v)
    if (tk.t === 'id') {
      if (tk.v === 'true') return true
      if (tk.v === 'false') return false
      if (tk.v === 'null') return null
      if (tk.v === 'undefined') return undefined
      if (tk.v === 'context') return CONTEXT
      throw new Unknown()
    }
    if (tk.v === '(') {
      const v = expr()
      expectOp(')')
      return v
    }
    if (tk.v === '[') {
      const items: unknown[] = []
      while (!isOp(']')) {
        items.push(expr())
        if (isOp(',')) p++
        else break
      }
      expectOp(']')
      return items
    }
    throw new Unknown()
  }

  const postfix = (): unknown => {
    let v = primary()
    for (;;) {
      if (isOp('.') || isOp('?.')) {
        const optional = peek()?.v === '?.'
        p++
        const name = peek()
        if (name?.t !== 'id') throw new Unknown()
        p++
        if (isOp('(')) {
          p++
          const args: unknown[] = []
          while (!isOp(')')) {
            args.push(expr())
            if (isOp(',')) p++
            else break
          }
          expectOp(')')
          v = callMethod(v, name.v, args)
        } else v = member(v, name.v, optional)
      } else if (isOp('[') || isOp('?.[')) {
        const optional = peek()?.v === '?.['
        p++
        const key = expr()
        expectOp(']')
        v = member(v, key, optional)
      } else return v
    }
  }

  const unary = (): unknown => {
    if (isOp('!')) {
      p++
      return !truthy(unary())
    }
    return postfix()
  }
  const truthy = (v: unknown): boolean => {
    if (v === CONTEXT) return true
    return !!v
  }
  const relational = (): unknown => {
    let v = unary()
    while (isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
      const op = peek()?.v
      p++
      const r = unary()
      if ((typeof v !== 'number' && typeof v !== 'string') || (typeof r !== 'number' && typeof r !== 'string')) throw new Unknown()
      v = op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r
    }
    return v
  }
  const equality = (): unknown => {
    let v = relational()
    while (isOp('===') || isOp('!==') || isOp('==') || isOp('!=')) {
      const op = peek()?.v
      p++
      const r = relational()
      if (v === CONTEXT || r === CONTEXT) throw new Unknown()
      v = op === '===' ? v === r : op === '!==' ? v !== r : op === '==' ? looseEq(v, r) : !looseEq(v, r)
    }
    return v
  }
  const and = (): unknown => {
    let v = equality()
    while (isOp('&&')) {
      p++
      const r = equality()
      v = truthy(v) ? r : v
    }
    return v
  }
  const or = (): unknown => {
    let v = and()
    while (isOp('||') || isOp('??')) {
      const op = peek()?.v
      p++
      const r = and()
      v = op === '||' ? (truthy(v) ? v : r) : v ?? r
    }
    return v
  }
  const expr = (): unknown => or()

  try {
    const v = expr()
    if (p !== toks.length) return undefined
    return truthy(v)
  } catch (e) {
    return e instanceof EvalFalse ? false : undefined
  }
}

// ---- Values from incomplete calls, and options already shown -------------------------------------------------

export interface Pending {
  values: Record<string, unknown>
  connectionId?: string
  /** The saved value of each held key when it was held: a key the user changed in the panel since is dropped */
  saved?: Record<string, string>
  /** The saved connection when the values were held: a connection the user picked in the panel since wins */
  savedAuthId?: string
}

/** What is saved right now (to tell values the user changed in the panel from values still waiting). */
export interface SavedState {
  inputData: Record<string, unknown>
  authId?: string
}

const pending = new Map<string, Pending>()
const optionCache = new Map<string, FieldOption[]>()
const groupCache = new Map<string, InputJson>()

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > CACHE_MAX) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

export function flowKey(ctx: ToolContext, t: FlowTarget): string {
  return `${ctx.vs.env.apiBase}|${t.orgId}|${t.scriptId}`
}

/** Key of one step (by its id) or of the trigger of one app event in a flow. */
export function stepKey(ctx: ToolContext, t: FlowTarget, stepIdOrTrigger: string): string {
  return `${flowKey(ctx, t)}|${stepIdOrTrigger}`
}

export function getPending(key: string): Pending | undefined {
  return pending.get(key)
}

export function clearPending(key: string): void {
  pending.delete(key)
}

function snap(v: unknown): string {
  return JSON.stringify(v ?? null)
}

/**
 * Values to save: the ones held from an earlier incomplete call, overridden by the ones given now. Held values the
 * user has since changed in the panel (the saved value differs from when they were held) are dropped, and so is a
 * held connection when the saved connection changed. null stays in: it tells the encoder to clear that field.
 */
export function mergePending(
  key: string,
  values: Record<string, unknown> | undefined,
  saved: SavedState,
): { values: Record<string, unknown>; connectionId?: string; dropped: string[] } {
  const p = pending.get(key)
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(p?.values ?? {})) {
    if (p?.saved && Object.hasOwn(p.saved, k) && p.saved[k] !== snap(saved.inputData[k])) dropped.push(k)
    else out[k] = v
  }
  let connectionId = p?.connectionId
  if (connectionId && p && p.savedAuthId !== saved.authId) {
    connectionId = undefined
    dropped.push('connection')
  }
  for (const [k, v] of Object.entries(values ?? {})) out[k] = v
  return { values: out, connectionId, dropped }
}

/** Remembers values (and the saved state they were given against) for a follow-up call; null entries are dropped. */
export function holdValues(key: string, values: Record<string, unknown>, connectionId: string | undefined, saved: SavedState): void {
  const kept: Record<string, unknown> = {}
  const snapshot: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue
    kept[k] = v
    snapshot[k] = snap(saved.inputData[k])
  }
  bounded(pending, key, { values: kept, connectionId, saved: snapshot, savedAuthId: saved.authId })
}

/** Which parent values a field's dynamic choices (or generated fields) were loaded for. */
export function depsSignature(key: string, def: FieldDef, inputData: Record<string, unknown>): string {
  const values = conditionValues(inputData)
  return JSON.stringify(fieldDeps(key, def).map((d) => values[d] ?? null))
}

export function rememberOptions(holdKey: string, fieldKey: string, sig: string, options: FieldOption[]): void {
  bounded(optionCache, `${holdKey}|${fieldKey}|${sig}`, options.slice(0, MAX_OPTIONS))
}

function cachedOptions(holdKey: string, fieldKey: string, sig: string): FieldOption[] | undefined {
  return optionCache.get(`${holdKey}|${fieldKey}|${sig}`)
}

// ---- Checking dropdown choices -------------------------------------------------------------------------------

export interface ChoiceRequest {
  ij: InputJson
  /** Field values to save (held and given), keyed by field key */
  values: Record<string, unknown>
  /** Encoded inputData, for parent values and visibility */
  inputData: Record<string, unknown>
  authData: AuthData | undefined
  actionVersionId: string
  isTrigger: boolean
  slug?: string
  holdKey: string
  /** Fields whose value the user typed themselves (free text in a dropdown) */
  customInput: ReadonlySet<string>
  noConnection?: boolean
}

export interface ChoiceResult {
  /** The values with option labels replaced by option values */
  values: Record<string, unknown>
  /** The option objects picked per field */
  picked: Map<string, FieldOption[]>
  problems: string[]
  /** Dropdowns whose choices cannot be loaded yet to check the value (parents or connection missing) */
  needsChoices: NeedInput[]
  notes: string[]
  /** Dropdowns holding free text the user typed (the editor's custom input mode) */
  customDropdowns: string[]
}

function shown(v: unknown): string {
  return typeof v === 'string' ? `"${truncate(v, 40)}"` : truncate(JSON.stringify(v) ?? String(v), 40)
}

/**
 * Every dropdown and multiselect value must be one of the field's real choices: fixed ones, or the ones the app
 * loads (loaded now if they were not shown yet). An option's label is accepted and replaced by its value. A data
 * insert text (${...}) is the editor's dynamic input and is left to the mapping check; free text only for fields
 * the user typed (customInput).
 */
export async function checkChoices(ctx: ToolContext, t: FlowTarget, r: ChoiceRequest): Promise<ChoiceResult> {
  const out: ChoiceResult = { values: { ...r.values }, picked: new Map(), problems: [], needsChoices: [], notes: [], customDropdowns: [] }
  const condValues = conditionValues(r.inputData)
  for (const [field, raw] of Object.entries(r.values)) {
    const def = r.ij.blocks[field]
    const type = typeOf(def)
    if (!def || (type !== 'dropdown' && type !== 'multiselect') || raw === null || raw === undefined) continue
    const items = type === 'multiselect' ? (Array.isArray(raw) ? raw : [raw]) : [raw]
    if (!items.length || visible(def, condValues) === false) continue
    if (items.some((x) => typeof x === 'string' && x.includes('${'))) continue
    const label = str(def.label) ?? field
    if (items.some((x) => x === CUSTOM_INPUT)) {
      out.problems.push(`${label} (${field}): "${CUSTOM_INPUT}" is not a value. Save the option's value, or the text the user typed with customInput: ["${field}"].`)
      continue
    }
    if (r.customInput.has(field)) {
      if (type === 'dropdown') out.customDropdowns.push(field)
      continue
    }
    let options = staticOptions(def)
    let partial = false
    if (hasSource(def)) {
      const sig = depsSignature(field, def, r.inputData)
      let loaded = cachedOptions(r.holdKey, field, sig)
      if (!loaded) {
        const res = await loadFieldOptions(
          ctx,
          t,
          { ij: r.ij, fieldKey: field, authData: r.authData, inputData: r.inputData, actionVersionId: r.actionVersionId, isTrigger: r.isTrigger, slug: r.slug, noConnection: r.noConnection },
          MAX_OPTIONS,
        )
        if (res.needsFirst || res.needsConnection) {
          out.needsChoices.push(needFor(field, def, condValues, true, `Its choices load from the app${res.needsConnection ? ' with the connection' : ''}, so ${shown(raw)} cannot be checked yet.`))
          continue
        }
        if (res.error) {
          out.problems.push(`${label} (${field}): its choices could not be loaded to check ${shown(raw)} (${res.error}). Load them with vs_get_field_options.`)
          continue
        }
        loaded = res.options
        rememberOptions(r.holdKey, field, sig, loaded)
        partial = !!res.more || res.total > loaded.length
      }
      for (const o of loaded) if (!options.some((x) => sameValue(x.value, o.value))) options.push(o)
      if (def.enableSearchApi === true) partial = true
    }
    // No list to check against: the field takes free input.
    if (!options.length) continue
    const values: unknown[] = []
    const hits: FieldOption[] = []
    const bad: unknown[] = []
    for (const x of items) {
      const byLabel = (o: FieldOption) => typeof x === 'string' && o.label.trim().toLowerCase() === x.trim().toLowerCase()
      const hit = options.find((o) => sameValue(o.value, x)) ?? options.find(byLabel)
      if (!hit) {
        bad.push(x)
        continue
      }
      values.push(hit.value)
      hits.push(hit)
      if (!sameValue(hit.value, x)) out.notes.push(`${label}: saved the value of the choice "${hit.label}".`)
    }
    if (bad.length) {
      if (partial) {
        out.notes.push(`${label}: ${bad.map(shown).join(', ')} is not among the first choices loaded, so it could not be confirmed; kept as given.`)
        values.push(...bad)
      } else {
        const labels = options.slice(0, 8).map((o) => o.label)
        out.problems.push(
          `${label} (${field}): ${bad.map(shown).join(', ')} is not one of its choices (${labels.join(' / ')}${options.length > 8 ? ` +${options.length - 8} more` : ''}). Ask the user to pick one (vs_get_field_options) and save that choice's value; only text the user typed themselves may be saved as is, with customInput: ["${field}"].`,
        )
        continue
      }
    }
    out.values[field] = type === 'multiselect' ? values : values[0]
    if (hits.length) out.picked.set(field, hits)
  }
  return out
}

/**
 * The picked option objects merged into inputJson the way the editor does when a choice is made (dropdown:
 * steps[key] = [key["value"]], blocks[key["value"]] = option; multiselect: one entry per option), so the panel shows
 * the chosen labels. A picked option's extraValue is stored as key_extraValue, as the editor does.
 */
export function withPickedOptions(ij: InputJson, picked: Map<string, FieldOption[]>, inputData: Record<string, unknown>): InputJson {
  let cur = ij
  for (const [field, options] of picked) {
    const type = typeOf(ij.blocks[field])
    const list = type === 'multiselect' ? options : options.slice(0, 1)
    if (!list.length) continue
    cur = withPicks(
      cur,
      field,
      list.map((o) => o.raw ?? { label: o.label, value: o.value, ...(o.key !== undefined ? { key: o.key } : {}) }),
    )
    const first = list[0]
    if (type === 'dropdown' && first && first.extraValue !== undefined) inputData[`${field}_extraValue`] = first.extraValue
  }
  return cur
}

/** pluginData.dynamicInputRequired with mapped or free-text dropdowns switched to manual input, as the editor does. */
export function withDynamicInput(existing: unknown, fields: string[]): Record<string, unknown> | undefined {
  if (!fields.length) return isRecord(existing) ? existing : undefined
  const out: Record<string, unknown> = { ...asRecord(existing) }
  for (const f of fields) out[f] = true
  return out
}

// ---- Loading choices and generated fields with the field's own source ----------------------------------------

export interface OptionsRequest {
  ij: InputJson
  fieldKey: string
  authData: AuthData | undefined
  inputData: Record<string, unknown>
  actionVersionId: string
  isTrigger: boolean
  /** Step slug (used as the run name, like the editor); the trigger runs as 'testName' */
  slug?: string
  search?: string
  /** The panel shows no connection for this trigger (NoAuth, manual webhook): run without one */
  noConnection?: boolean
}

export interface OptionsResult {
  options: FieldOption[]
  total: number
  dynamic: boolean
  help?: string
  more?: boolean
  needsFirst?: string[]
  needsConnection?: boolean
  error?: string
}

type SourceRun = { run: DryRunResult } | { needsFirst: string[] } | { needsConnection: true }

/** Runs a field's source through the execute route (performType 'source'), as the panel does when it shows the field. */
async function runSource(ctx: ToolContext, t: FlowTarget, r: OptionsRequest, what: string): Promise<SourceRun> {
  const def = r.ij.blocks[r.fieldKey]
  if (!def) throw new ToolError(`No field "${r.fieldKey}".`)
  const values = conditionValues(r.inputData)
  const missing = fieldDeps(r.fieldKey, def).filter((d) => !valueExists(values[d]))
  if (missing.length) return { needsFirst: missing }
  if (!r.authData?.id && !r.noConnection) return { needsConnection: true }
  let source = String(def.source)
  if (def.enableSearchApi === true) {
    // The search text comes from the model: JSON.stringify makes it a safe JS string literal.
    source = `async function callSourceWithSearchData(__searchText) {\n${source}\n}\nreturn await callSourceWithSearchData(${JSON.stringify(r.search ?? '')});`
  }
  const code: Record<string, unknown> = { source, selectedValues: { authData: r.authData ?? {}, inputData: r.inputData }, actionVersionId: r.actionVersionId }
  if (def.authInfo !== undefined) code.authInfo = def.authInfo
  const body = {
    type: 'plugin',
    code,
    name: r.isTrigger ? 'testName' : r.slug || 'testName',
    variables: { context: { req: { body: {}, query: {}, headers: {} }, res: {}, vals: {}, paginateData: {} } },
    performType: 'source',
    pluginType: r.isTrigger ? 'trigger' : 'action',
    pluginBlockLocation: r.fieldKey,
    isUserOnDh: false,
  }
  await ctx.vs.alignOrg(ctx.signal)
  return { run: await executeDryRun(ctx, t, body, what) }
}

/** A source's answer: a list, or {data|children, offset, message}; 401 is a refused connection. */
function sourceList(run: DryRunResult): { list?: unknown[]; help?: string; more: boolean; unauthorized: boolean } {
  const message = run.message
  let list: unknown[] | undefined
  let help: string | undefined
  let more = false
  if (Array.isArray(message)) list = message
  else if (isRecord(message)) {
    if (Array.isArray(message.data) || Array.isArray(message.children)) {
      list = Array.isArray(message.data) ? message.data : (message.children as unknown[])
      more = message.offset !== undefined && message.offset !== null && message.offset !== ''
    }
    if (typeof message.message === 'string') help = truncate(message.message, 300)
    if (Number(message.status) === 401) return { help, more, unauthorized: true }
  }
  return { list, help, more, unauthorized: false }
}

/** Choices of one field: static children, or the result of running the field's source with the current values. */
export async function loadFieldOptions(ctx: ToolContext, t: FlowTarget, r: OptionsRequest, limit: number): Promise<OptionsResult> {
  const def = r.ij.blocks[r.fieldKey]
  if (!def) throw new ToolError(`No field "${r.fieldKey}".`)
  const fixed = staticOptions(def)
  if (!hasSource(def)) return { options: fixed.slice(0, limit), total: fixed.length, dynamic: false }
  const label = str(def.label) ?? r.fieldKey
  const res = await runSource(ctx, t, r, `Loading the choices of "${label}"`)
  if ('needsFirst' in res) return { options: [], total: 0, dynamic: true, needsFirst: res.needsFirst }
  if ('needsConnection' in res) return { options: [], total: 0, dynamic: true, needsConnection: true }
  const { list, help, more, unauthorized } = sourceList(res.run)
  if (unauthorized) {
    return { options: [], total: 0, dynamic: true, error: `viaSocket could not load the choices: the connection was refused (${help ?? 'unauthorized'}). Reconnect with vs_connect_app.` }
  }
  if (!res.run.success && !list) return { options: [], total: 0, dynamic: true, error: `Loading the choices of "${label}" failed${help ? `: ${help}` : ''}.` }
  const options = (list ?? []).map(toOption).filter((o): o is FieldOption => !!o)
  for (const o of fixed) if (!options.some((x) => sameValue(x.value, o.value))) options.push(o)
  return {
    options: options.slice(0, limit),
    total: options.length,
    dynamic: true,
    help: options.length ? help : (help ?? `No choices came back for "${label}".`),
    more: more || undefined,
  }
}

export interface GroupFieldsResult {
  /** The generated fields under the group (steps/blocks to merge) */
  fields?: InputJson
  needsFirst?: string[]
  needsConnection?: boolean
  error?: string
  help?: string
}

/** The fields an input group's source generates (e.g. one field per sheet column), in inputJson form. */
export async function loadGroupFields(ctx: ToolContext, t: FlowTarget, r: OptionsRequest): Promise<GroupFieldsResult> {
  const def = r.ij.blocks[r.fieldKey]
  const label = str(def?.label) ?? r.fieldKey
  const res = await runSource(ctx, t, r, `Loading the fields of "${label}"`)
  if ('needsFirst' in res) return { needsFirst: res.needsFirst }
  if ('needsConnection' in res) return { needsConnection: true }
  const { list, help, unauthorized } = sourceList(res.run)
  if (unauthorized) return { error: `the connection was refused (${help ?? 'unauthorized'}); reconnect with vs_connect_app` }
  if (!res.run.success || !list) return { error: `loading the fields of "${label}" failed${help ? `: ${help}` : ''}` }
  return { fields: toInputJson(list, r.fieldKey), help }
}

/** Visible input groups (any depth) whose fields come from a source. */
function sourceGroups(ij: InputJson, inputData: Record<string, unknown>): string[] {
  const values = conditionValues(inputData)
  const out: string[] = []
  const walk = (loc: string, depth: number) => {
    for (const key of ij.steps[loc] ?? []) {
      const def = ij.blocks[key]
      if (!def || !isGroup(def) || visible(def, values) === false) continue
      if (hasSource(def)) out.push(key)
      if (ij.steps[key] && depth < 5) walk(key, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

export interface ExpandRequest extends Omit<OptionsRequest, 'fieldKey' | 'search'> {
  holdKey: string
  /** Field keys set in this call: a group whose parents changed loads its fields again */
  changed: ReadonlySet<string>
}

/**
 * Loads the fields of every visible input group that generates them and has not (or whose parent values just
 * changed), as the panel does once the group's parents are filled. Groups whose parents or connection are missing
 * stay as they are (missingInputs reports them). Results are cached per parent values.
 */
export async function expandSourceGroups(ctx: ToolContext, t: FlowTarget, r: ExpandRequest): Promise<{ ij: InputJson; expanded: string[]; problems: string[] }> {
  let ij = r.ij
  const expanded: string[] = []
  const problems: string[] = []
  const done = new Set<string>()
  for (let pass = 0; pass < 3; pass++) {
    let grew = false
    for (const g of sourceGroups(ij, r.inputData)) {
      if (done.has(g)) continue
      const def = ij.blocks[g]
      if (!def) continue
      const deps = fieldDeps(g, def)
      if (ij.steps[g] !== undefined && !deps.some((d) => r.changed.has(d))) continue
      const values = conditionValues(r.inputData)
      if (deps.some((d) => !valueExists(values[d])) || (!r.authData?.id && !r.noConnection)) continue
      done.add(g)
      const cacheKey = `${r.holdKey}|${g}|${depsSignature(g, def, r.inputData)}`
      let frag = groupCache.get(cacheKey)
      if (!frag) {
        const res = await loadGroupFields(ctx, t, { ...r, ij, fieldKey: g })
        if (!res.fields) {
          if (res.error) problems.push(`${str(def.label) ?? g}: ${res.error}`)
          continue
        }
        frag = res.fields
        bounded(groupCache, cacheKey, frag)
      }
      ij = mergeGroup(ij, g, frag)
      expanded.push(g)
      grew = true
    }
    if (!grew) break
  }
  return { ij, expanded, problems }
}

/** Generated fields loaded for a group by vs_get_field_options, kept so the save uses the same ones. */
export function rememberGroupFields(holdKey: string, group: string, sig: string, fields: InputJson): void {
  bounded(groupCache, `${holdKey}|${group}|${sig}`, fields)
}

/**
 * Dropdown and multiselect fields: their values are checked against the real choices (checkChoices), so the mapping
 * check reads them as literal text (a choice such as "trigger.fired" is not a typed path); ${...} is still checked.
 */
export function choiceKeys(ij: InputJson): Set<string> {
  const out = new Set<string>()
  for (const [k, def] of Object.entries(ij.blocks)) {
    const type = typeOf(def)
    if (type === 'dropdown' || type === 'multiselect') out.add(k)
  }
  return out
}

export function isInputGroup(def: FieldDef | undefined): boolean {
  return isGroup(def)
}

export function generatesFields(def: FieldDef | undefined): boolean {
  return !!def && isGroup(def) && hasSource(def)
}
