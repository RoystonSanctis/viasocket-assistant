// Content-script side of the window.postMessage channel to the MAIN-world hook (src/main-world/hook.ts).
//
// Every message is wrapped in one namespaced key (PAGE_KEY) because viaSocket's own 'message' listeners react to
// top-level keys like type/id/error and to strings. Inbound messages must come from this window, carry the wrapper
// and our nonce; their contents are still re-validated because any page script can see the nonce once posted.

import { PAGE_KEY, type ContentToPageMsg, type PageEnvelope } from '../shared/messages'
import type { ObservedEvent } from '../shared/observed'
import { ERROR_TEXT_MAX, isObservedKind, PATH_MAX, SLUG_MAX } from '../shared/classify'

const INIT_RETRY_MS = 400
const INIT_MAX_TRIES = 12
/** Simple flood guard: at most this many observed events per window */
const RATE_LIMIT = 40
const RATE_WINDOW_MS = 10_000

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
    get ready() {
      return hookReady
    },
    destroy() {
      clearInterval(retry)
      retry = undefined
      window.removeEventListener('message', onMessage)
      // Called when this copy is orphaned. The page hook stays installed and only answers its first partner, so
      // without this the copy injected after an extension update would never get hook-ready.
      if (hookReady) post({ type: 'release' })
    },
  }
}
