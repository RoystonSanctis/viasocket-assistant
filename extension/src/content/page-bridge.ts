// Content-script side of the window.postMessage channel to the MAIN-world hook (src/main-world/hook.ts).
//
// Every message is wrapped in one namespaced key (PAGE_KEY) because viaSocket's own 'message' listeners react to
// top-level keys like type/id/error and to strings. Inbound messages must come from this window, carry the wrapper
// and our nonce; their contents are still re-validated because any page script can see the nonce once posted.

import {
  EDITOR_ACTION_RESULTS,
  PAGE_KEY,
  type ContentToPageMsg,
  type EditorAction,
  type EditorActionResult,
  type PageEnvelope,
  type StepContextData,
} from '../shared/messages'
import type { ObservedEvent } from '../shared/observed'
import { ERROR_TEXT_MAX, isObservedKind, PATH_MAX, SLUG_MAX } from '../shared/classify'
import type { SubfunctionRef } from '../shared/subfunctions'

const INIT_RETRY_MS = 400
const INIT_MAX_TRIES = 12
/** Simple flood guard: at most this many observed events per window */
const RATE_LIMIT = 40
const RATE_WINDOW_MS = 10_000
const STEP_CONTEXT_TIMEOUT_MS = 2500
/** Formatting a large script takes a moment */
const EDITOR_ACTION_TIMEOUT_MS = 5000
const CODE_MAX = 307_200
const VARIABLES_MAX = 300

export interface PageBridgeOptions {
  /** API hosts the hook should watch in addition to its defaults */
  apiHosts: string[]
  onObserved(event: ObservedEvent): void
  /** The app changed its route (pushState/replaceState) */
  onNavigated(url: string): void
  /** A requested navigation went ahead while the page's own save, test or publish was still in flight */
  onNavigateBusy(): void
}

export interface PageBridge {
  /** Router-friendly in-app navigation. Returns false when the URL is not a same-origin app path or the hook is missing. */
  navigate(url: string, replace?: boolean): boolean
  /**
   * Invalidate step data in Redux so that MasterSliderComponent refetches and renders fresh values. After a save of
   * the open step, pass what the save returned (the flow and the step's row): see the refresh-step message.
   */
  refreshStep(scriptId?: string, stepId?: string, slugName?: string, saved?: { flowJson?: Record<string, unknown>; stepRow?: Record<string, unknown> }): void
  /** The open JS step's code (as the editor shows it), subfunctions and mappable variables; null when unavailable */
  getStepContext(scriptId?: string, stepId?: string, slugName?: string): Promise<StepContextData | null>
  /** Checks or beautifies the Monaco editor marked with EDITOR_ID_ATTR = editorId; null when the hook does not answer */
  editorAction(editorId: string, action: EditorAction): Promise<EditorActionResult | null>
  /** The MAIN-world hook answered (it is missing in tabs that were open before an extension update) */
  readonly ready: boolean
  destroy(): void
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Accepts '/path?query' or an absolute URL on this origin; returns the path+query+hash or null. */
export function toAppPath(url: string): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null
  if (url.startsWith('//')) return null
  let target: URL
  try {
    target = new URL(url, location.origin)
  } catch {
    return null
  }
  if (target.origin !== location.origin) return null
  return target.pathname + target.search + target.hash
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined
}

function sanitizeStepContext(raw: unknown): StepContextData | null {
  if (!isObj(raw)) return null
  const scriptId = shortStr(raw.scriptId, 32)
  const stepId = shortStr(raw.stepId, 32)
  const slugName = shortStr(raw.slugName, SLUG_MAX)
  if (!scriptId || !stepId || !slugName || typeof raw.code !== 'string' || raw.code.length > CODE_MAX) return null
  const subfunctions: SubfunctionRef[] = []
  for (const item of Array.isArray(raw.subfunctions) ? raw.subfunctions.slice(0, 50) : []) {
    if (!isObj(item)) continue
    const name = shortStr(item.name, 64)
    if (name) subfunctions.push({ name, actionId: shortStr(item.actionId, 40) ?? '', authId: shortStr(item.authId, 40) ?? '' })
  }
  const strings = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, max)
  let dynamicVariables: Record<string, string> | undefined
  if (isObj(raw.dynamicVariables)) {
    dynamicVariables = {}
    for (const [k, v] of Object.entries(raw.dynamicVariables).slice(0, 100)) {
      if (typeof v === 'string' && k.length <= 64) dynamicVariables[k] = v.slice(0, 10_000)
    }
  }
  const otherSubfunctions: StepContextData['otherSubfunctions'] = []
  for (const item of Array.isArray(raw.otherSubfunctions) ? raw.otherSubfunctions.slice(0, 200) : []) {
    if (!isObj(item)) continue
    const name = shortStr(item.name, 64)
    if (name) otherSubfunctions.push({ name, authId: shortStr(item.authId, 40) ?? '' })
  }
  const connectedApps: StepContextData['connectedApps'] = []
  for (const app of Array.isArray(raw.connectedApps) ? raw.connectedApps.slice(0, 200) : []) {
    if (!isObj(app)) continue
    const serviceId = shortStr(app.serviceId, 40)
    const name = shortStr(app.name, 80)
    const iconUrl = typeof app.iconUrl === 'string' && /^https:\/\//.test(app.iconUrl) ? app.iconUrl.slice(0, 500) : undefined
    if (serviceId && name) connectedApps.push({ serviceId, name, iconUrl })
  }
  return {
    scriptId,
    stepId,
    slugName,
    stepType: shortStr(raw.stepType, 32),
    code: raw.code,
    subfunctions,
    dynamicVariables,
    otherSubfunctions,
    connectedApps,
    variables: strings(raw.variables, VARIABLES_MAX),
  }
}

function sanitizeObserved(raw: unknown): ObservedEvent | null {
  if (!isObj(raw) || !isObservedKind(raw.kind)) return null
  if (typeof raw.method !== 'string' || typeof raw.path !== 'string' || typeof raw.status !== 'number') return null
  const e: ObservedEvent = {
    kind: raw.kind,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
    method: raw.method.slice(0, 10).toUpperCase(),
    path: raw.path.slice(0, PATH_MAX),
    status: Number.isFinite(raw.status) ? Math.trunc(raw.status) : 0,
    ok: raw.ok === true,
    byAssistant: raw.byAssistant === true,
  }
  if (typeof raw.scriptId === 'string' && /^[A-Za-z0-9]{1,32}$/.test(raw.scriptId)) e.scriptId = raw.scriptId
  if (typeof raw.slugName === 'string' && raw.slugName) e.slugName = raw.slugName.slice(0, SLUG_MAX)
  if (typeof raw.errorText === 'string' && raw.errorText) e.errorText = raw.errorText.slice(0, ERROR_TEXT_MAX)
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) e.durationMs = Math.max(0, Math.round(raw.durationMs))
  return e
}

export function createPageBridge(opts: PageBridgeOptions): PageBridge {
  const nonce = makeNonce()
  let hookReady = false
  let tries = 0
  let retry: ReturnType<typeof setInterval> | undefined
  let windowStart = Date.now()
  let windowCount = 0

  function post(msg: ContentToPageMsg): void {
    const envelope: PageEnvelope<ContentToPageMsg> = { [PAGE_KEY]: { ...msg, nonce } }
    window.postMessage(envelope, location.origin)
  }

  function sendInit(): void {
    if (hookReady || tries >= INIT_MAX_TRIES) {
      clearInterval(retry)
      retry = undefined
      return
    }
    tries++
    post({ type: 'init', apiHosts: opts.apiHosts })
  }

  function allowEvent(): boolean {
    const now = Date.now()
    if (now - windowStart > RATE_WINDOW_MS) {
      windowStart = now
      windowCount = 0
    }
    return ++windowCount <= RATE_LIMIT
  }

  const pendingContext = new Map<string, (data: StepContextData | null) => void>()
  const pendingEditor = new Map<string, (result: EditorActionResult | null) => void>()

  function onMessage(ev: MessageEvent): void {
    if (ev.source !== window || ev.origin !== location.origin) return
    const data: unknown = ev.data
    if (!isObj(data)) return
    const inner = data[PAGE_KEY]
    if (!isObj(inner) || inner.nonce !== nonce) return
    switch (inner.type) {
      case 'hook-ready':
        hookReady = true
        clearInterval(retry)
        retry = undefined
        break
      case 'observed': {
        const event = sanitizeObserved(inner.event)
        if (event && allowEvent()) opts.onObserved(event)
        break
      }
      case 'navigated':
        if (typeof inner.url === 'string') opts.onNavigated(inner.url)
        break
      case 'navigate-busy':
        opts.onNavigateBusy()
        break
      case 'step-context-response': {
        const handler = typeof inner.requestId === 'string' ? pendingContext.get(inner.requestId) : undefined
        if (handler) handler(sanitizeStepContext(inner.data))
        break
      }
      case 'editor-action-response': {
        const handler = typeof inner.requestId === 'string' ? pendingEditor.get(inner.requestId) : undefined
        const known = (EDITOR_ACTION_RESULTS as readonly unknown[]).includes(inner.result)
        if (handler) handler(known ? (inner.result as EditorActionResult) : null)
        break
      }
      default:
        // our own init/navigate echoes, or junk
        break
    }
  }

  window.addEventListener('message', onMessage)
  sendInit()
  retry = setInterval(sendInit, INIT_RETRY_MS)

  return {
    navigate(url, replace = false) {
      const path = toAppPath(url)
      // Only the hook can see the page's in-flight saves; changing the route under one files its result under the
      // wrong flow or step, so without the hook there is no navigation at all.
      if (path === null || !hookReady) return false
      post({ type: 'navigate', url: path, replace })
      return true
    },
    refreshStep(scriptId, stepId, slugName, saved) {
      post({
        type: 'refresh-step',
        scriptId,
        stepId,
        slugName,
        ...(saved?.flowJson ? { flowJson: saved.flowJson } : {}),
        ...(saved?.stepRow ? { stepRow: saved.stepRow } : {}),
      })
    },
    getStepContext(scriptId, stepId, slugName) {
      if (!hookReady) return Promise.resolve(null)
      const requestId = makeNonce()
      return new Promise<StepContextData | null>((resolve) => {
        const finish = (data: StepContextData | null) => {
          clearTimeout(timer)
          pendingContext.delete(requestId)
          resolve(data)
        }
        const timer = setTimeout(() => finish(null), STEP_CONTEXT_TIMEOUT_MS)
        pendingContext.set(requestId, finish)
        post({ type: 'get-step-context', requestId, scriptId, stepId, slugName })
      })
    },
    editorAction(editorId, action) {
      if (!hookReady) return Promise.resolve(null)
      const requestId = makeNonce()
      return new Promise<EditorActionResult | null>((resolve) => {
        const finish = (result: EditorActionResult | null) => {
          clearTimeout(timer)
          pendingEditor.delete(requestId)
          resolve(result)
        }
        const timer = setTimeout(() => finish(null), EDITOR_ACTION_TIMEOUT_MS)
        pendingEditor.set(requestId, finish)
        post({ type: 'editor-action', requestId, editorId, action })
      })
    },
    get ready() {
      return hookReady
    },
    destroy() {
      clearInterval(retry)
      retry = undefined
      window.removeEventListener('message', onMessage)
      for (const finish of [...pendingContext.values()]) finish(null)
      for (const finish of [...pendingEditor.values()]) finish(null)
      // Called when this copy is orphaned. The page hook stays installed and only answers its first partner, so
      // without this the copy injected after an extension update would never get hook-ready.
      if (hookReady) post({ type: 'release' })
    },
  }
}
