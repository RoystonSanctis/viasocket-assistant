// Turns one viaSocket API call (method + path + status) into an ObservedKind, so the assistant can react to what the
// user just did in the app. Used by the MAIN-world hook; pure, no DOM or chrome APIs.
//
// Only paths are inspected, never request or response payloads (except two narrow body probes below that return
// a boolean or a short error message).

import type { ObservedKind } from './observed'

export interface Classification {
  kind: ObservedKind
  /** Normalised path (no query, no trailing slash), capped in length */
  path: string
  scriptId?: string
  slugName?: string
}

/** Every kind, so other contexts can validate events that crossed a trust boundary */
export const OBSERVED_KINDS: Readonly<Record<ObservedKind, true>> = {
  'flow-loaded': true,
  'step-saved': true,
  'step-created': true,
  'step-deleted': true,
  'step-tested': true,
  'trigger-saved': true,
  'flow-published': true,
  'flow-discarded': true,
  'dh-saved': true,
  'dh-dry-run': true,
  'api-error': true,
  'unknown-mutation': true,
}

export function isObservedKind(v: unknown): v is ObservedKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(OBSERVED_KINDS, v)
}

export const PATH_MAX = 300
export const SLUG_MAX = 120
export const ERROR_TEXT_MAX = 200
/** Bodies larger than this are not parsed at all */
export const MAX_PARSE_CHARS = 512_000

const FLOW_GET = /^\/projects\/[^/]+\/scripts\/([^/]+)$/
const STEP_CREATE = /^\/scripts\/[^/]+\/([^/]+)\/stepv2$/
const STEP_ONE = /^\/scripts\/([^/]+)\/stepv2\/([^/]+)$/
const EXECUTE = /^\/[^/]+\/([^/]+)\/execute$/
const TRIGGER = /^\/scripts\/[^/]+\/([^/]+)\/trigger$/
// Sent with an empty body as soon as a trigger app is picked; the trigger is not configured yet.
const DRAFT_TRIGGER = /^\/scripts\/[^/]+\/[^/]+\/drafttrigger\/[^/]+$/
const PUBLISH = /^\/projects\/[^/]+\/scripts\/([^/]+)\/publish$/
const REVERT = /^\/projects\/[^/]+\/scripts\/([^/]+)\/revert$/
const DH_SAVE = /^\/developers\/[^/]+\/(?:update|create)\/[A-Za-z_]+$/
// Background chatter the UI makes on its own (alerts, AI side calls, tokens, health checks, org switching).
const NOISE = /^\/(?:utility\/|openai\/|rtlayer\/|healthcheck$|scripts\/title-description$|orgs\/switchOrg$)/
// Segments that are not flow ids on the execute route (Developer Hub previews and code tests).
const DH_EXECUTE_SEGMENTS = new Set(['devhubPluginPreview', 'developer'])

const SCRIPT_ID = /^[A-Za-z0-9]{12}$/
const SCRIPT_ID_LOOSE = /^scri[A-Za-z0-9]{8}$/
const SLUG_AFTER = new Set(['stepv2', 'duplicatestep', 'reorder'])

export function normalizePath(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return p.slice(0, PATH_MAX)
}

function scriptIdOf(seg: string | undefined): string | undefined {
  return seg && SCRIPT_ID.test(seg) ? seg : undefined
}

function slugOf(seg: string | undefined): string | undefined {
  if (!seg) return undefined
  let s = seg
  try {
    s = decodeURIComponent(seg)
  } catch {
    // keep the raw segment
  }
  return s ? s.slice(0, SLUG_MAX) : undefined
}

/** Best-effort ids for routes the classifier does not know by name */
function genericIds(path: string): { scriptId?: string; slugName?: string } {
  const segs = path.split('/')
  const out: { scriptId?: string; slugName?: string } = {}
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] ?? ''
    if (!out.scriptId && SCRIPT_ID_LOOSE.test(s)) out.scriptId = s
    if (!out.slugName && SLUG_AFTER.has(s)) out.slugName = slugOf(segs[i + 1])
  }
  return out
}

function make(kind: ObservedKind, path: string, scriptId?: string, slugName?: string): Classification {
  const c: Classification = { kind, path }
  if (scriptId) c.scriptId = scriptId
  if (slugName) c.slugName = slugName
  return c
}

/**
 * @param pagePath location.pathname of the page that made the call. On Developer Hub pages the UI can put a stale
 *   flow id in the execute URL, so the page decides whether an execute call is a DH dry run.
 * @returns null for calls that are not worth reporting (reads, noise, retried 304s, aborted unknown calls)
 */
export function classify(method: string, rawPath: string, status: number, pagePath = ''): Classification | null {
  const m = method.toUpperCase()
  const path = normalizePath(rawPath)
  // The UI retries a 304 with a cache-buster, so the retry is the call that matters.
  if (status === 304) return null

  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    const f = m === 'GET' ? FLOW_GET.exec(path) : null
    return f ? make('flow-loaded', path, scriptIdOf(f[1])) : null
  }
  if (NOISE.test(path)) return null

  let r: RegExpExecArray | null
  if (m === 'POST' && (r = STEP_CREATE.exec(path))) return make('step-created', path, scriptIdOf(r[1]))
  if ((m === 'PUT' || m === 'DELETE') && (r = STEP_ONE.exec(path))) {
    return make(m === 'PUT' ? 'step-saved' : 'step-deleted', path, scriptIdOf(r[1]), slugOf(r[2]))
  }
  if (m === 'POST' && (r = EXECUTE.exec(path))) {
    const seg = r[1] ?? ''
    if (DH_EXECUTE_SEGMENTS.has(seg) || pagePath.startsWith('/developer/')) return make('dh-dry-run', path)
    return make('step-tested', path, scriptIdOf(seg))
  }
  if (m === 'POST' && (r = TRIGGER.exec(path))) return make('trigger-saved', path, scriptIdOf(r[1]))
  if (m === 'POST' && DRAFT_TRIGGER.test(path) && status < 400) return null
  if (m === 'PUT' && (r = PUBLISH.exec(path))) return make('flow-published', path, scriptIdOf(r[1]))
  if (m === 'PUT' && (r = REVERT.exec(path))) return make('flow-discarded', path, scriptIdOf(r[1]))
  if (DH_SAVE.test(path)) return make('dh-saved', path)

  // Status 0 is an aborted or offline call; the UI retries or reports those itself.
  if (status === 0) return null
  const ids = genericIds(path)
  return make(status >= 400 ? 'api-error' : 'unknown-mutation', path, ids.scriptId, ids.slugName)
}

/** A write the page's own reducers will apply to whatever the URL says when it settles (not background chatter) */
export function isPageMutation(method: string, rawPath: string): boolean {
  const m = method.toUpperCase()
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !NOISE.test(normalizePath(rawPath))
}

/** True when the call's outcome lives in the response body (dry runs answer HTTP 200 even when the step failed) */
export function outcomeInBody(kind: ObservedKind): boolean {
  return kind === 'step-tested' || kind === 'dh-dry-run'
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Reads only the pass/fail flags of a dry-run response, never its output. */
export function dryRunFailed(body: unknown): boolean {
  const data = isObj(body) ? body.data : undefined
  if (!isObj(data)) return false
  if (data.success === false) return true
  // API steps report the upstream HTTP result inside message instead of success.
  const msg = data.message
  if (!isObj(msg)) return false
  if (typeof msg.status === 'number' && msg.status >= 400) return true
  return isObj(msg.response) && Boolean(msg.response.errorMessage)
}

/** The backend's top-level error `message`, whitespace-collapsed and capped. Nothing else from the body is used. */
export function shortErrorText(body: unknown): string | undefined {
  if (!isObj(body) || typeof body.message !== 'string') return undefined
  const t = body.message.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, ERROR_TEXT_MAX) : undefined
}

export function parseCapped(text: string): unknown {
  if (!text || text.length > MAX_PARSE_CHARS) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
