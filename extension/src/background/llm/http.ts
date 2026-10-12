// HTTP plumbing shared by the LLM adapters: the base-URL guard, timeouts/cancellation and error mapping.
// Every request goes through providerUrl(), so a key can only ever reach the base URL it was resolved with.

import { LlmError, type ResolvedProvider } from './types'

export const CHAT_TIMEOUT_MS = 120_000
export const LIST_TIMEOUT_MS = 20_000

// Paths come from code or config (modelsPath/validatePath): plain path, optional simple query, no traversal.
const SAFE_PATH = /^\/[A-Za-z0-9._~\/-]*(\?[A-Za-z0-9._~=&%-]*)?$/

export function providerUrl(p: ResolvedProvider, path: string): URL {
  if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) {
    throw new LlmError(`Refusing unexpected provider path ${path.slice(0, 60)}`, 0, 'bad-request')
  }
  const full = p.baseUrl + path
  const url = new URL(full)
  if (!full.startsWith(p.baseUrl + '/') || url.origin !== new URL(p.baseUrl).origin) {
    throw new LlmError('Refusing to send the key outside the provider address it was saved with', 0, 'bad-request')
  }
  return url
}

export function isLocal(p: ResolvedProvider): boolean {
  const host = new URL(p.baseUrl).hostname
  return host === 'localhost' || host === '127.0.0.1'
}

export interface LlmFetchInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs: number
}

/** Fetches JSON from the provider. Throws LlmError for every failure, never a raw fetch error. */
export async function llmFetch(p: ResolvedProvider, url: URL, init: LlmFetchInit): Promise<unknown> {
  const timeout = AbortSignal.timeout(init.timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      cache: 'no-store',
      // A redirect could carry custom auth headers (x-api-key) to another origin, so never follow one.
      redirect: 'error',
      signal,
    })
    text = await res.text()
  } catch (e) {
    if (init.signal?.aborted) throw new LlmError('Cancelled', 0, 'aborted')
    if (timeout.aborted) throw new LlmError(`${p.name} took too long to answer. Try again or pick a faster model.`, 0, 'network')
    if ((e as Error).name === 'AbortError') throw new LlmError('Cancelled', 0, 'aborted')
    const hint = isLocal(p)
      ? ' Is it running, and does it allow requests from the extension?'
      : ' Check your internet connection.'
    throw new LlmError(`Could not reach ${p.name}.${hint}`, 0, 'network')
  }

  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) throw httpError(p, res.status, body, res.headers)
  if (body === undefined || typeof body !== 'object' || body === null) {
    throw new LlmError(`${p.name} sent an unreadable answer.`, res.status, 'server')
  }
  return body
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** Gemini's OpenAI-compatible endpoint can wrap its error object in a one-element array. */
function unwrap(body: unknown): unknown {
  return Array.isArray(body) && body.length === 1 ? body[0] : body
}

/** Best-effort provider error text (OpenAI, OpenRouter, Anthropic, Gemini and Ollama shapes). */
export function providerMessage(body: unknown): string {
  body = unwrap(body)
  if (typeof body === 'string') return body.trim().startsWith('<') ? '' : body.trim()
  const b = asRecord(body)
  if (!b) return ''
  const err = b.error
  if (typeof err === 'string') return err
  const e = asRecord(err)
  let msg = typeof e?.message === 'string' ? e.message : typeof b.message === 'string' ? b.message : ''
  if (!msg && typeof b.detail === 'string') msg = b.detail
  // OpenRouter wraps the upstream provider's own error in metadata.raw, which is usually the useful part.
  const raw = asRecord(e?.metadata)?.raw
  if (typeof raw === 'string' && raw && !msg.includes(raw)) msg = msg ? `${msg} (${raw})` : raw
  return msg
}

function clean(p: ResolvedProvider, msg: string): string {
  let out = msg.replace(/\s+/g, ' ').trim()
  if (p.key) out = out.split(p.key).join('***')
  return out.length > 300 ? out.slice(0, 297) + '...' : out
}

/** Longest provider-requested wait the agent sits out inside a run; anything longer is a daily or account cap. */
export const MAX_RETRY_WAIT_MS = 30_000
const AUTH_DETAIL = /key|auth|unauthori[sz]ed|credential|permission/i

function errorObject(body: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(unwrap(body))?.error)
}

/** Gemini (google.rpc) error details, e.g. RetryInfo and QuotaFailure entries. */
function errorDetails(body: unknown): Record<string, unknown>[] {
  const details = errorObject(body)?.details
  return Array.isArray(details) ? details.map(asRecord).filter((d): d is Record<string, unknown> => !!d) : []
}

function retryAfterMs(body: unknown, headers?: Headers): number | undefined {
  const header = headers?.get('retry-after')
  if (header) {
    const secs = Number(header)
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  // OpenRouter: error.metadata.headers['X-RateLimit-Reset'] is an epoch in milliseconds.
  const meta = asRecord(errorObject(body)?.metadata)
  const metaHeaders = asRecord(meta?.headers)
  const reset = Number(metaHeaders?.['X-RateLimit-Reset'] ?? metaHeaders?.['x-ratelimit-reset'])
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset > 1e12 ? reset - Date.now() : reset * 1000 - Date.now()
    if (ms > 0) return ms
  }
  const retry = Number(meta?.retry_after ?? meta?.retryAfter)
  if (Number.isFinite(retry) && retry > 0) return Math.round(retry * 1000)
  // Gemini: {"@type": "...RetryInfo", "retryDelay": "33s"}
  for (const d of errorDetails(body)) {
    if (typeof d['@type'] !== 'string' || !d['@type'].endsWith('RetryInfo') || typeof d.retryDelay !== 'string') continue
    const secs = Number.parseFloat(d.retryDelay)
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  }
  return undefined
}

/** A 429 that waiting inside the run will not fix: no credit left, or a daily/account cap. */
function isQuota429(body: unknown, detail: string, wait: number | undefined): boolean {
  const err = errorObject(body)
  if (err?.code === 'insufficient_quota' || err?.type === 'insufficient_quota') return true
  const quotaIds = errorDetails(body).flatMap((d) =>
    Array.isArray(d.violations) ? d.violations.map((v) => String(asRecord(v)?.quotaId ?? '')) : [],
  )
  if (/per.?day|daily/i.test(detail) || quotaIds.some((q) => /PerDay/i.test(q))) return true
  return wait !== undefined && wait > MAX_RETRY_WAIT_MS
}

function bodyText(body: unknown): string {
  try {
    return typeof body === 'string' ? body : JSON.stringify(body) ?? ''
  } catch {
    return ''
  }
}

export function httpError(p: ResolvedProvider, status: number, body: unknown, headers?: Headers): LlmError {
  const detail = clean(p, providerMessage(body))
  const suffix = detail ? `: ${detail}` : '.'
  const keyRejected = () =>
    new LlmError(`${p.name} rejected the API key (${status})${suffix} Check or re-save it in settings.`, status, 'auth')
  if (status === 401) return keyRejected()
  if (status === 403) {
    // A 403 is not always about the key: gateways refuse flagged input, local servers refuse unknown origins.
    if (/flag|moderat/i.test(detail)) {
      return new LlmError(`${p.name} refused the request because its moderation flagged the input${suffix}`, status, 'bad-request')
    }
    if (isLocal(p) && !(p.key && AUTH_DETAIL.test(detail))) {
      return new LlmError(
        `${p.name} refused the request from the extension (403). Allow requests from chrome-extension://* ` +
          '(for Ollama, set OLLAMA_ORIGINS=chrome-extension://*) and restart it.',
        status,
        'bad-request',
      )
    }
    if (!detail || AUTH_DETAIL.test(detail)) return keyRejected()
    return new LlmError(`${p.name} refused the request (403)${suffix}`, status, 'bad-request')
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/.test(`${detail} ${bodyText(body)}`)) return keyRejected()
  if (status === 402) {
    return new LlmError(`${p.name} says the account is out of credits${suffix}`, status, 'quota')
  }
  if (status === 429) {
    const wait = retryAfterMs(body, headers)
    const when = wait !== undefined ? ` Try again in about ${formatWait(wait)}.` : ''
    if (isQuota429(body, detail, wait)) {
      return new LlmError(`${p.name} usage limit reached${suffix}${when}`, status, 'quota', wait)
    }
    return new LlmError(`${p.name} rate limit reached${suffix}${when}`, status, 'rate-limit', wait)
  }
  if (status === 408) return new LlmError(`${p.name} timed out${suffix}`, status, 'network')
  if (status >= 500) return new LlmError(`${p.name} is having problems (${status})${suffix}`, status, 'server')
  return new LlmError(`${p.name} refused the request (${status})${suffix}`, status, 'bad-request')
}

function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000)
  if (s < 90) return `${s} seconds`
  const m = Math.ceil(s / 60)
  if (m < 90) return `${m} minutes`
  return `${Math.ceil(m / 60)} hours`
}

/** OpenRouter (and a few proxies) report upstream failures as HTTP 200 with an `error` object. */
export function errorInBody(p: ResolvedProvider, body: unknown): LlmError | null {
  const err = asRecord(unwrap(body))?.error
  if (!err) return null
  const code = Number(asRecord(err)?.code)
  return httpError(p, Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, body)
}

export function newCallId(): string {
  return 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
}
