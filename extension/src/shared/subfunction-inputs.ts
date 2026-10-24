// The inputs of an app action as the step panel runs them, kept free of the DOM so it can be tested.
//
// Mirrors socket-flow-UI's plugin panel (PluginSwitch, PluginHocV2, ShowMoreOption, plugin_utility):
// - a field shows once every field in its dependsOn has a value (dependsOn comes from the field's own source);
// - required fields show; optional ones are offered as links to add, except fields with dependsOn (they appear once
//   their parents are filled) and fields with a visibility rule (they show when it holds);
// - a visibility rule that is false hides the field and drops its value; a rule over a mapped value shows the field;
// - defaults fill empty fields that may show (also optional ones not added yet), and a value equal to the default
//   still counts as "not filled" for offering the field as a link;
// - all fields of a group show when the group is required or has a rule or parents of its own.
//
// A subfunction gets inputData exactly as written in the code (no coercion, no defaults, no flattening at run time),
// so values are written as the final JS object: groups nested, dictionaries as plain objects, numbers, booleans,
// lists and dates as real values.

import { conditionValues, evalCondition, valueExists } from './field-rules'
import type { SubfnFieldSpec, SubfnForm } from './subfunctions'
import { displayValue, formatInputData, jsValue, parseArrayItems, parseObjectEntries, singleMapping } from './subfunctions-parser'

export type FieldValue =
  | { kind: 'text'; text: string }
  /** A JavaScript expression kept as code (the form cannot show it as a plain value) */
  | { kind: 'code'; code: string }
  | { kind: 'choice'; value: unknown; label?: string }
  | { kind: 'choices'; items: Array<{ value: unknown; label?: string }> }
  | { kind: 'list'; items: string[] }
  | { kind: 'dict'; rows: Array<{ key: string; value: string }> }

export interface FieldEntry {
  value: FieldValue
  /** The expression the code has now: written back unchanged until the value is edited */
  raw?: string
  /** Filled from the action's default */
  fromDefault?: boolean
}

export type Values = Map<string, FieldEntry>

export type FieldKind = 'text' | 'number' | 'date' | 'boolean' | 'dropdown' | 'multiselect' | 'list' | 'dictionary' | 'group' | 'help'

export function kindOf(spec: SubfnFieldSpec): FieldKind {
  switch (spec.type) {
    case 'input groups':
      return 'group'
    case 'help':
      return 'help'
    case 'boolean':
      return 'boolean'
    case 'dropdown':
    case 'hidefields':
      return 'dropdown'
    case 'multiselect':
      return 'multiselect'
    case 'dictionary':
      return 'dictionary'
    case 'number':
      return spec.list ? 'list' : 'number'
    case 'date':
      return 'date'
    default:
      return spec.list ? 'list' : 'text'
  }
}

/** The name a field has inside its location: `group["child"]` -> child, a root key stays as it is. */
export function childName(key: string, location: string): string {
  if (location === 'root') return key
  const prefix = `${location}[`
  if (!key.startsWith(prefix) || !key.endsWith(']')) return key
  const inner = key.slice(prefix.length, -1)
  try {
    const v: unknown = JSON.parse(inner)
    return typeof v === 'string' ? v : String(v)
  } catch {
    return inner
  }
}

function emptyValue(v: FieldValue): boolean {
  switch (v.kind) {
    case 'text':
      return !v.text.trim()
    case 'code':
      return !v.code.trim()
    case 'choice':
      return v.value === undefined || v.value === null || v.value === ''
    case 'choices':
      return v.items.length === 0
    case 'list':
      return !v.items.some((x) => x.trim())
    case 'dict':
      return !v.rows.some((r) => r.key.trim() && r.value.trim())
  }
}

/** The value as the panel's context.inputData has it (for rules, parents and the app's own option loaders). */
export function plainOf(v: FieldValue): unknown {
  switch (v.kind) {
    case 'text':
      return v.text
    case 'code':
      return v.code
    case 'choice':
      return v.value
    case 'choices':
      return v.items.map((i) => i.value)
    case 'list':
      return v.items.filter((x) => x.trim())
    case 'dict': {
      const out: Record<string, string> = {}
      for (const r of v.rows) if (r.key.trim()) out[r.key.trim()] = r.value
      return out
    }
  }
}

/** Filled values by full field key, for loading choices and generated fields. */
export function plainValues(values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, e] of values) if (!emptyValue(e.value)) out[k] = plainOf(e.value)
  return out
}

/** Labels of choices, in the shape the default and option lists use. */
function optionOf(o: unknown): { value: unknown; label?: string } {
  if (o && typeof o === 'object' && !Array.isArray(o) && 'value' in o) {
    const r = o as { value: unknown; label?: unknown }
    return { value: r.value, label: typeof r.label === 'string' ? r.label : undefined }
  }
  return { value: o }
}

/** The value a field takes from its default, or undefined when it has none usable. */
export function defaultEntry(spec: SubfnFieldSpec): FieldEntry | undefined {
  const dv = spec.defaultValue
  if (dv === undefined || dv === null || dv === '') return undefined
  const kind = kindOf(spec)
  let value: FieldValue | undefined
  if (kind === 'dropdown') value = { kind: 'choice', ...optionOf(dv) }
  else if (kind === 'boolean') {
    const v = optionOf(dv).value
    value = { kind: 'choice', value: v === true || v === 'true' ? true : v === false || v === 'false' ? false : v }
  } else if (kind === 'multiselect') value = { kind: 'choices', items: (Array.isArray(dv) ? dv : [dv]).map(optionOf) }
  else if (kind === 'list') value = { kind: 'list', items: (Array.isArray(dv) ? dv : [dv]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) }
  else if (kind === 'group' || kind === 'help' || kind === 'dictionary') return undefined
  else value = { kind: 'text', text: typeof dv === 'string' ? dv : JSON.stringify(dv) }
  return emptyValue(value) ? undefined : { value, fromDefault: true }
}

// ---------- which fields show ----------

export type FieldState = 'shown' | 'link' | 'hidden'

export class InputsModel {
  /** Keys the code passes that the action does not define, per location ('root' or a group): kept as code */
  readonly extras = new Map<string, Record<string, string>>()

  constructor(
    public form: SubfnForm,
    public values: Values = new Map(),
    /** Optional fields the user added */
    public revealed: Set<string> = new Set(),
  ) {}

  spec(key: string): SubfnFieldSpec | undefined {
    return this.form.fields[key]
  }

  /** The group a key belongs to ('root' for top-level fields). */
  locationOf(key: string): string {
    for (const [loc, keys] of Object.entries(this.form.steps)) if (keys.includes(key)) return loc
    return 'root'
  }

  private flatPlain(): Record<string, unknown> {
    return plainValues(this.values)
  }

  /** context.inputData as a visibility rule sees it: groups nested. */
  conditionContext(): Record<string, unknown> {
    return conditionValues(this.flatPlain())
  }

  /** A required child (any depth) of a group, or a group whose fields are not generated yet. */
  groupRequired(key: string, depth = 0): boolean {
    const spec = this.spec(key)
    if (!spec || depth > 5) return false
    if (spec.generates && this.form.steps[key] === undefined) return true
    return (this.form.steps[key] ?? []).some((c) => {
      const s = this.spec(c)
      return !!s && (s.required === true || (kindOf(s) === 'group' && this.groupRequired(c, depth + 1)))
    })
  }

  /** The panel's flag: a leaf has a value; a group has all its required fields filled. */
  filled(key: string, depth = 0): boolean {
    const spec = this.spec(key)
    if (!spec || depth > 5) return false
    if (kindOf(spec) === 'group') {
      if (spec.generates && this.form.steps[key] === undefined) return false
      return (this.form.steps[key] ?? []).every((c) => {
        const s = this.spec(c)
        if (!s || !(s.required || (kindOf(s) === 'group' && this.groupRequired(c)))) return true
        if (this.condition(c) === false) return true
        return this.filled(c, depth + 1)
      })
    }
    const e = this.values.get(key)
    return !!e && !emptyValue(e.value) && valueExists(plainOf(e.value))
  }

  /** Every parent (dependsOn) has a value. A parent is a top-level field, or a sibling inside the same group. */
  parentsReady(key: string): boolean {
    const spec = this.spec(key)
    const deps = spec?.dependsOn ?? []
    if (!deps.length) return true
    const loc = this.locationOf(key)
    return deps.every((d) => {
      if (this.spec(d)) return this.filled(d)
      const sibling = loc === 'root' ? undefined : `${loc}[${JSON.stringify(d)}]`
      return !!sibling && !!this.spec(sibling) && this.filled(sibling)
    })
  }

  /** The field's visibility rule: true, false, or undefined when it cannot be evaluated here (then it shows). */
  condition(key: string): boolean | undefined {
    const rule = this.spec(key)?.visibleWhen
    if (!rule) return true
    // A rule over a mapped value or a code expression (a local variable, an earlier result) cannot be decided
    // before the run: the panel shows the field, and its value must never be dropped as hidden.
    for (const m of rule.matchAll(/inputData\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      const e = m[1] ? this.values.get(m[1]) : undefined
      if (e && (e.value.kind === 'code' || (e.value.kind === 'text' && e.value.text.includes('${')))) return true
    }
    return evalCondition(rule, this.conditionContext())
  }

  /** The value differs from the default (an edited or loaded value). */
  private ownValue(key: string): boolean {
    const e = this.values.get(key)
    return !!e && !e.fromDefault && !emptyValue(e.value)
  }

  /** Whether every field of `group` shows, optional ones included. */
  private showsAll(group: string): boolean {
    const spec = this.spec(group)
    if (!spec) return false
    return spec.required === true || (!spec.generates && (!!spec.visibleWhen || !!spec.dependsOn?.length))
  }

  state(key: string, location = this.locationOf(key)): FieldState {
    const spec = this.spec(key)
    if (!spec) return 'hidden'
    if (this.condition(key) === false || !this.parentsReady(key)) return 'hidden'
    if (spec.type === 'help' || spec.required || spec.visibleWhen || spec.dependsOn?.length) return 'shown'
    if (location !== 'root' && this.showsAll(location)) return 'shown'
    if (this.revealed.has(key) || this.ownValue(key)) return 'shown'
    if (kindOf(spec) === 'group') {
      if (spec.generates || this.groupRequired(key)) return 'shown'
      if ((this.form.steps[key] ?? []).some((c) => this.state(c, key) === 'shown')) return 'shown'
    }
    return 'link'
  }

  /**
   * Keeps values in line with the rules, as the panel does after every change: a field whose rule turned false loses
   * its value, and empty fields that may show take their default.
   */
  reconcile(): void {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false
      const walk = (loc: string, depth: number) => {
        for (const key of this.form.steps[loc] ?? []) {
          const spec = this.spec(key)
          if (!spec) continue
          if (this.condition(key) === false) {
            if (this.values.delete(key)) changed = true
            continue
          }
          if (kindOf(spec) === 'group') {
            if (depth < 5) walk(key, depth + 1)
            continue
          }
          const e = this.values.get(key)
          if ((!e || emptyValue(e.value)) && this.parentsReady(key)) {
            const d = defaultEntry(spec)
            if (d) {
              this.values.set(key, d)
              changed = true
            }
          }
        }
      }
      walk('root', 0)
      if (!changed) break
    }
  }

  /** Sets a value the user chose (no longer the code's or the default's). */
  set(key: string, value: FieldValue): void {
    this.values.set(key, { value })
    this.reconcile()
  }

  clear(key: string): void {
    this.values.delete(key)
    this.reconcile()
  }

  /** Fields that read `key` (directly or through others): their loaded choices no longer apply. */
  dependents(key: string): string[] {
    const name = childName(key, this.locationOf(key))
    const out = new Set<string>()
    const queue = [key, name]
    while (queue.length) {
      const k = queue.shift() as string
      for (const [other, spec] of Object.entries(this.form.fields)) {
        if (out.has(other) || other === key) continue
        if (spec.dependsOn?.includes(k)) {
          out.add(other)
          queue.push(other, childName(other, this.locationOf(other)))
        }
      }
    }
    return [...out]
  }

  // ---------- reading and writing the call ----------

  /** inputData of the call: top-level names and their JS expressions (groups as nested object literals). */
  inputDataFields(location = 'root', depth = 0): Record<string, string> {
    const out: Record<string, string> = {}
    for (const key of this.form.steps[location] ?? []) {
      const spec = this.spec(key)
      if (!spec || this.state(key, location) === 'hidden') continue
      const kind = kindOf(spec)
      if (kind === 'help') continue
      const name = childName(key, location)
      const entry = this.values.get(key)
      if (kind === 'group') {
        if (this.form.steps[key] === undefined || depth >= 5) {
          // Fields not generated yet: what the code had stays.
          if (entry?.raw) out[name] = entry.raw
          continue
        }
        // An optional group nobody opened writes nothing.
        if (this.state(key, location) === 'link' && !entry?.raw && !this.extras.get(key)) continue
        const inner = this.inputDataFields(key, depth + 1)
        if (Object.keys(inner).length) out[name] = formatInputData(inner, '')
        continue
      }
      if (!entry || emptyValue(entry.value)) continue
      const expr = entry.raw !== undefined ? entry.raw : expressionOf(spec, entry.value)
      if (expr) out[name] = expr
    }
    for (const [name, raw] of Object.entries(this.extras.get(location) ?? {})) if (!(name in out) && raw.trim()) out[name] = raw.trim()
    return out
  }

  /**
   * Values from the inputData of an existing call. Keys the action does not define are returned as `extra` (they
   * stay in the code). A group whose fields are not generated yet keeps its expression until they are.
   */
  load(fields: Record<string, string>, location = 'root', depth = 0): Record<string, string> {
    const extra: Record<string, string> = { ...fields }
    const keys = this.form.steps[location] ?? []
    const used = new Set<string>()
    // Generated fields can be keyed by an id (a column letter) while the code names them by their label: inside a
    // group, a name that matches no key takes the field whose key or label differs only in case and punctuation.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const fieldFor = (name: string): string | undefined => {
      const exact = keys.find((k) => childName(k, location) === name)
      const n = norm(name)
      if (exact || location === 'root' || !n) return exact
      return keys.find((k) => !used.has(k) && (norm(childName(k, location)) === n || norm(this.spec(k)?.label ?? '') === n))
    }
    for (const [name, raw] of Object.entries(fields)) {
      const key = fieldFor(name)
      const spec = key ? this.spec(key) : undefined
      if (!key || !spec || used.has(key)) continue
      used.add(key)
      delete extra[name]
      if (kindOf(spec) === 'group') {
        const nested = parseObjectEntries(raw)
        if (nested && this.form.steps[key] !== undefined && depth < 5) this.load(nested, key, depth + 1)
        else this.values.set(key, { value: { kind: 'code', code: raw }, raw })
        continue
      }
      this.values.set(key, { value: valueFromCode(spec, raw), raw })
    }
    if (Object.keys(extra).length) this.extras.set(location, extra)
    else this.extras.delete(location)
    return extra
  }

  /** Generated fields arrived for a group: values the code had for it are read into them. */
  groupLoaded(group: string, fragment: SubfnForm): void {
    for (const [k, list] of Object.entries(fragment.steps)) this.form.steps[k] = list
    for (const [k, spec] of Object.entries(fragment.fields)) this.form.fields[k] = spec
    const kept = this.values.get(group)
    const nested = kept?.raw ? parseObjectEntries(kept.raw) : null
    if (nested) {
      this.values.delete(group)
      this.load(nested, group)
    } else {
      // Values read while the group had no fields yet wait as extras: they belong to the fields that arrived now.
      const waiting = this.extras.get(group)
      if (waiting) this.load(waiting, group)
    }
    this.reconcile()
  }
}

// ---------- values <-> JS expressions ----------

/** JSON for a choice value (strings, numbers, booleans, objects, lists). */
function literal(v: unknown): string {
  return v === undefined ? '' : (JSON.stringify(v) ?? '')
}

/** The JS expression a value is written as. */
export function expressionOf(spec: SubfnFieldSpec, v: FieldValue): string {
  const kind = kindOf(spec)
  switch (v.kind) {
    case 'code':
      return v.code.trim()
    case 'choice':
      return literal(v.value)
    case 'choices':
      return `[${v.items.map((i) => literal(i.value)).join(', ')}]`
    case 'list': {
      const items = v.items.map((x) => x.trim()).filter(Boolean)
      return items.length ? `[${items.map((x) => jsValue(x, spec.type === 'number' ? 'number' : 'string')).join(', ')}]` : ''
    }
    case 'dict': {
      const rows = v.rows.filter((r) => r.key.trim())
      if (!rows.length) return ''
      const fields: Record<string, string> = {}
      const computed: string[] = []
      for (const r of rows) {
        const val = jsValue(r.value, 'string') || '""'
        if (r.key.includes('${')) computed.push(`[${jsValue(r.key, 'string')}]: ${val}`)
        else fields[r.key.trim()] = val
      }
      const literalPart = formatInputData(fields, '')
      if (!computed.length) return literalPart
      const body = [...Object.entries(fields).map(([k, val]) => `  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${val}`), ...computed.map((c) => `  ${c}`)]
      return `{\n${body.join(',\n')}\n}`
    }
    case 'text': {
      const t = v.text
      if (!t.trim()) return ''
      // A value that is exactly one mapping keeps the mapped data's own type where the field is not plain text.
      const mapped = singleMapping(t)
      switch (kind) {
        case 'number':
          return jsValue(t, 'number')
        case 'date':
          // The action reads a Date (the panel's run-time coercion gives one) unless the field asks for text.
          return spec.dateFormat ? jsValue(t, 'string') : `new Date(${mapped ?? jsValue(t, 'string')})`
        case 'boolean':
          return mapped ?? jsValue(t, 'boolean')
        case 'dropdown':
          return mapped ?? jsValue(t, 'string')
        case 'multiselect':
        case 'dictionary':
          return mapped ?? jsValue(t, 'json')
        case 'list':
          return mapped ?? jsValue(t, 'list')
        default:
          return jsValue(t, 'string')
      }
    }
  }
}

/** A value read from the code for a field; anything the form cannot show plainly stays as code. */
export function valueFromCode(spec: SubfnFieldSpec, raw: string): FieldValue {
  const kind = kindOf(spec)
  const v = raw.trim()
  const json = (s: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(s) }
    } catch {
      const d = displayValue(s)
      return d.expression ? { ok: false } : { ok: true, value: d.text }
    }
  }
  if (kind === 'dropdown' || kind === 'boolean') {
    const r = json(v)
    return r.ok && (typeof r.value !== 'string' || !r.value.includes('${')) ? { kind: 'choice', value: r.value } : textOrCode(v)
  }
  if (kind === 'multiselect') {
    const items = parseArrayItems(v)
    if (!items) return { kind: 'code', code: v }
    const parsed = items.map(json)
    return parsed.every((p) => p.ok) ? { kind: 'choices', items: parsed.map((p) => ({ value: (p as { value: unknown }).value })) } : { kind: 'code', code: v }
  }
  if (kind === 'list') {
    const items = parseArrayItems(v)
    if (!items) return { kind: 'code', code: v }
    const shown = items.map((x) => displayValue(x))
    return shown.every((s) => !s.expression) ? { kind: 'list', items: shown.map((s) => s.text) } : { kind: 'code', code: v }
  }
  if (kind === 'dictionary') {
    const entries = parseObjectEntries(v)
    if (!entries) return { kind: 'code', code: v }
    const rows = Object.entries(entries).map(([key, val]) => {
      const d = displayValue(val)
      return { key, value: d.expression ? `\${${val}}` : d.text }
    })
    return { kind: 'dict', rows }
  }
  if (kind === 'date') {
    const m = /^new\s+Date\(([\s\S]*)\)$/.exec(v)
    if (m) {
      const inner = (m[1] ?? '').trim()
      const d = displayValue(inner)
      return d.expression ? { kind: 'text', text: `\${${inner}}` } : { kind: 'text', text: d.text }
    }
  }
  return textOrCode(v)
}

/** A plain read of flow data (context.req…, context.res…, context.vals…), shown as a mapping like the panel does. */
const DATA_PATH = /^context\.(?:req|res|vals)(?:\??\.[A-Za-z_$][\w$]*|\??\.?\[(?:\d+|"[^"\\]*"|'[^'\\]*')\])*$/

function textOrCode(v: string): FieldValue {
  if (DATA_PATH.test(v)) return { kind: 'text', text: `\${${v}}` }
  const d = displayValue(v)
  return d.expression ? { kind: 'code', code: v } : { kind: 'text', text: d.text }
}
