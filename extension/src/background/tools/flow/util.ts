// Small helpers shared by the flow and UI tools.

import { newStepId } from '../ids'
import { redactKey, shapeOf } from '../redact'

export const ORG_ID_RE = /^[0-9]{1,15}$/
export const PROJECT_ID_RE = /^[A-Za-z0-9]{4,32}$/
/** DbDash row ids: apps, actions, action versions, auth versions */
export const ROW_ID_RE = /^[A-Za-z0-9]{3,32}$/
/** Connection ids look like 'auth2FvZLyE0_rowbu58rc' (underscore + app id suffix) */
export const AUTH_ID_RE = /^[A-Za-z0-9_]{3,64}$/
/** Block keys: step slugs plus server-made keys such as 'ifcbAb12Cd34' or 'Untitled_1' */
export const SLUG_RE = /^[A-Za-z0-9_]{1,75}$/

export const FLOW_PAGES = ['flow-editor', 'project', 'home'] as const

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {}
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

/** Snapshots and stored code may be JSON strings or already-parsed objects. */
export function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

/** Hosts of the http(s) URLs in code or text (at most 8), for test-run warnings. */
export function hostsIn(text: string): string[] {
  const hosts = new Set<string>()
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s'"`<>()[\]{}]+/gi)) {
    try {
      hosts.add(new URL(m[0]).host)
    } catch {
      // Not a parseable URL (e.g. a ${...} template); skip it.
    }
    if (hosts.size >= 8) break
  }
  return [...hosts]
}

/** Short label from model-provided args for mascot text; never trusted beyond display. */
export function label(v: unknown, fallback: string, max = 32): string {
  return typeof v === 'string' && v.trim() ? truncate(v.trim().replace(/\s+/g, ' '), max) : fallback
}

export function randomAlnum(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/** Step ids keep the UI's 4-char type prefix; the 12-char total is load-bearing (see ids.ts). */
export function prefixedStepId(prefix: 'func' | 'vari' | 'ifcb' | 'swtc' | 'cmnt' | 'btkc'): string {
  return prefix + newStepId().slice(4)
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface TrimLimits {
  array: number
  keys: number
  depth: number
}

const STRIPPED: TrimLimits = { array: 2, keys: 30, depth: 6 }
const FULL: TrimLimits = { array: 5, keys: 60, depth: 8 }
const FULL_STRING_CHARS = 400

/**
 * Run data (payloads, step outputs) shrunk for the LLM. With `strip` only the structure survives: field names and
 * value shapes such as "<email>" or "<string:12>" (see redact.ts), enough to map fields by path without shipping
 * customer data. Keys that look like data (emails, long numbers) are replaced too.
 */
export function trimData(v: unknown, strip: boolean): unknown {
  return trim(v, strip, strip ? STRIPPED : FULL, 0)
}

function trim(v: unknown, strip: boolean, lim: TrimLimits, depth: number): unknown {
  if (v === null || typeof v !== 'object') {
    if (strip) return shapeOf(v)
    return typeof v === 'string' ? truncate(v, FULL_STRING_CHARS) : v
  }
  if (depth >= lim.depth) return Array.isArray(v) ? `[array(${v.length})]` : '[object]'
  if (Array.isArray(v)) {
    const out = v.slice(0, lim.array).map((x) => trim(x, strip, lim, depth + 1))
    if (v.length > lim.array) out.push(`…${v.length - lim.array} more`)
    return out
  }
  const out: Record<string, unknown> = {}
  const keys = Object.keys(v)
  for (const k of keys.slice(0, lim.keys)) {
    const shown = strip ? redactKey(k) : k
    let key = shown
    for (let n = 2; Object.hasOwn(out, key); n++) key = `${shown}#${n}`
    out[key] = trim((v as Record<string, unknown>)[k], strip, lim, depth + 1)
  }
  if (keys.length > lim.keys) out['…'] = `${keys.length - lim.keys} more keys`
  return out
}

/**
 * "context.req.body.email: string" style list, so the model can reference real paths in field mappings. With
 * `strip`, keys that look like data are shown as <key>.
 */
export function leafPaths(v: unknown, prefix: string, limit = 150, strip = false): string[] {
  const out: string[] = []
  const walk = (x: unknown, path: string, depth: number) => {
    if (out.length >= limit) return
    if (Array.isArray(x)) {
      if (!x.length || depth > 7) return void out.push(`${path}: array(${x.length})`)
      walk(x[0], `${path}[0]`, depth + 1)
      return
    }
    if (isRecord(x)) {
      const keys = Object.keys(x)
      if (!keys.length || depth > 7) return void out.push(`${path}: object`)
      for (const k of keys) {
        const shown = strip ? redactKey(k) : k
        const sub = shown !== k ? `${path}[${shown}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`
        walk(x[k], sub, depth + 1)
      }
      return
    }
    out.push(`${path}: ${x === null ? 'null' : typeof x}`)
  }
  walk(v, prefix, 0)
  return out
}

/** Keeps a tool result under the configured size; the agent may truncate further. */
export function bounded(value: unknown, maxChars: number): unknown {
  const json = JSON.stringify(value) ?? ''
  if (json.length <= maxChars) return value
  return { truncated: true, json: json.slice(0, Math.max(200, maxChars - 200)) }
}

const SECRET_NAME = /auth|token|key|secret|pass|cookie|session|signature/i
export const MASK = '•••(set)'

/**
 * Header, query and form values that look like credentials are masked before they reach the LLM. Other values are
 * shown whole (the tool result as a whole is bounded): they are echoed back on save, so a cut value would be saved cut.
 */
export function maskHeaders(list: unknown): Array<{ name: string; value: string }> {
  return asArray(list)
    .filter(isRecord)
    .map((h) => {
      const name = str(h.name) ?? ''
      const value = str(h.value) ?? ''
      return { name, value: SECRET_NAME.test(name) && value ? MASK : value }
    })
}

/** Dynamic variables (named constants of function/API steps) with credential-looking values masked like headers. */
export function maskVariables(vars: unknown): Record<string, unknown> | undefined {
  if (!isRecord(vars) || !Object.keys(vars).length) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(vars)) out[k] = SECRET_NAME.test(k) && v !== '' && v != null ? MASK : v
  return out
}
