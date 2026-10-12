// Readers for Developer Hub rows. Rows come straight from the network (DbDash may return booleans as strings),
// so nothing here trusts declared types: every value goes through these narrowing helpers.

export type Row = Record<string, unknown>

export function isRow(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function rowsOf(v: unknown): Row[] {
  return Array.isArray(v) ? v.filter(isRow) : []
}

export function obj(v: unknown): Row | undefined {
  return isRow(v) ? v : undefined
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

export function flag(v: unknown): boolean {
  return v === true || v === 'true'
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function time(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max))}… [+${s.length - max} chars]`
}

/** Returns the value itself when its JSON fits, else a clipped JSON string the model can still read. */
export function fitJson(v: unknown, max: number): unknown {
  let s: string
  try {
    s = JSON.stringify(v ?? null) ?? 'null'
  } catch {
    return clip(String(v), max)
  }
  return s.length <= max ? v : clip(s, max)
}

export function clipJson(v: unknown, max: number): string {
  let s: string
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  } catch {
    s = String(v)
  }
  return clip(s, max)
}

// ---------- action versions ----------

export const CODE_SLIDERS = [
  'perform', 'performlist', 'performsubscribe', 'performunsubscribe', 'modifytriggerdata', 'transferoption',
] as const
export type CodeSlider = (typeof CODE_SLIDERS)[number]

export const TRIGGER_TYPES = ['hook', 'polling', 'manual_webhook'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

export type EntityKind = 'action' | 'trigger'

export const SCHEDULE_MINUTES = [5, 15, 60, 720, 1440] as const

export function kindOf(action: Row): EntityKind {
  return str(action.type) === 'trigger' ? 'trigger' : 'action'
}

export function triggerTypeOf(version: Row): TriggerType {
  const t = str(version.triggertype)
  return t === 'polling' || t === 'manual_webhook' ? t : 'hook'
}

/** Sliders the editor shows for this entity (the others exist as columns but are invisible and never run). */
export function slidersFor(kind: EntityKind, triggerType: TriggerType): CodeSlider[] {
  if (kind === 'action') return ['perform']
  if (triggerType === 'polling') return ['perform', 'performlist', 'transferoption']
  if (triggerType === 'manual_webhook') return ['perform', 'performlist', 'modifytriggerdata']
  return ['performsubscribe', 'performlist', 'modifytriggerdata', 'performunsubscribe', 'transferoption']
}

/** Sliders the publish dialog insists have saved code. */
export function requiredForPublish(kind: EntityKind, triggerType: TriggerType): CodeSlider[] {
  if (kind === 'action') return ['perform']
  if (triggerType === 'polling') return ['perform', 'performlist']
  if (triggerType === 'manual_webhook') return ['performlist']
  return ['performsubscribe', 'performunsubscribe', 'performlist']
}

export function versionNumber(v: Row): number {
  const m = /^V(\d+)$/i.exec(str(v.versionid) ?? '')
  return m ? Number(m[1]) : 0
}

/** The GET is unsorted and includes soft-deleted versions; this is the list the user actually sees, oldest first. */
export function liveVersions(rows: Row[]): Row[] {
  return rows
    .filter((r) => !flag(r.isdeleted) && typeof r.rowid === 'string')
    .sort((a, b) => versionNumber(a) - versionNumber(b) || time(a.createdat) - time(b.createdat))
}

/** Why a version must not be edited in place, or undefined when it is an editable draft. */
export function lockReason(v: Row, action?: Row): string | undefined {
  if (flag(v.isdeleted)) return 'it is deleted'
  // The live version can still be 'drafted' (a half-finished publish, or a backend path that only moves the action
  // pointer); the server lock would let an edit through and change live behaviour without a confirmation.
  if (action && str(action.status) === 'published' && str(action.actionversionrecordid) === str(v.rowid)) {
    return 'it is the live (published) version of the action'
  }
  const status = str(v.status) ?? 'drafted'
  if (status !== 'drafted') return `its status is '${status}'`
  const verification = str(v.verificationstatus)
  if (verification && verification !== 'NOT_VERIFIED') return `its verification status is '${verification}'`
  return undefined
}

export function scheduleOf(v: Row): number[] | undefined {
  const raw = obj(v.metadata)?.scheduleTimeOptions ?? v.scheduleTimeOptions
  if (!Array.isArray(raw)) return undefined
  return raw.map(num).filter((n): n is number => n !== undefined)
}

export function inputFieldsOf(v: Row): Row[] {
  return rowsOf(obj(v.inputjson)?.inputFields)
}

/** sampledata is a JSON column: booleans are stored as null and raw strings must be JSON-encoded. */
export function normalizeSampleValue(v: unknown): unknown {
  if (v === undefined || typeof v === 'boolean') return null
  if (typeof v === 'string') return JSON.stringify(v)
  return v
}

// ---------- connections (oauth_details) ----------

/** Connection code columns are JSON strings of {source}; tolerate legacy plain strings. */
export function decodeAuthCode(v: unknown): string {
  if (isRow(v)) return typeof v.source === 'string' ? v.source : ''
  if (typeof v !== 'string' || !v) return ''
  try {
    const parsed: unknown = JSON.parse(v)
    if (isRow(parsed)) return typeof parsed.source === 'string' ? parsed.source : ''
    return v
  } catch {
    return v
  }
}

export function encodeAuthCode(source: string): string {
  return JSON.stringify({ source })
}

export function parseQueryParams(v: unknown): Record<string, unknown> {
  if (isRow(v)) return { ...v }
  if (typeof v !== 'string' || !v) return {}
  try {
    const parsed: unknown = JSON.parse(v)
    return isRow(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function authVersionNumber(a: Row): number {
  const m = /^V(\d+)$/i.exec(str(a.authversion) ?? '')
  return m ? Number(m[1]) : 0
}

export function authFieldsOf(a: Row): Row[] {
  return rowsOf(obj(obj(a.authfields)?.authentication)?.fields)
}

/** Order-insensitive structural equality for JSON-ish values, used to skip no-op writes. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (isRow(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
