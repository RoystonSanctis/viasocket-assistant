// HTTP client for the viaSocket backend, used only from the service worker.
//
// - Auth: the raw proxy_auth_token from the env-named cookie, sent as the `proxy_auth_token` header.
//   Never credentials:'include' (the backend answers CORS with '*'), and the token never leaves this module.
// - Live editor: mutations send `sent-by-fbai: true` so the open editor applies the new json_script itself.
// - Serialization: every mutation re-writes the whole flow JSON server-side, so mutations on one flow are queued
//   (across all tabs: the queue is shared by every client in this worker).
// - Scope: only the env's API host is reachable, plus the VM draft-test endpoint. Nothing else. Redirects are
//   refused, because fetch would carry the custom token header to the redirect target.

import type { PageContext } from '../../shared/page'
import type { ViaSocketEnv } from './env'

export type VsErrorKind = 'logged-out' | 'auth' | 'forbidden' | 'not-found' | 'validation' | 'server' | 'network' | 'aborted' | 'blocked'

export class VsError extends Error {
  constructor(message: string, readonly kind: VsErrorKind, readonly status = 0, readonly body?: unknown) {
    super(message)
  }
}

export interface VsRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path on the API host, starting with '/'. Query goes in `query`, not in the path. */
  path: string
  base?: 'api' | 'vm'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Adds `sent-by-fbai: true` so the open flow editor live-applies the change */
  live?: boolean
  signal?: AbortSignal
}

const VM_ALLOWED = /^\/func\/[A-Za-z0-9]{12}\/test$/
const ORG_ALIGN_TTL_MS = 5 * 60_000

/** Tail of the mutation queue per `${apiBase}|${scriptId}`; module-level so tabs on the same flow share it. */
const FLOW_QUEUES = new Map<string, Promise<unknown>>()
const ACTIVE_MUTATIONS = new Set<string>()

function cleanToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s.length > 0 ? s : null
}

function isLikelyJwt(s: string): boolean {
  return typeof s === 'string' && s.startsWith('ey') && s.includes('.') && s.length > 20
}

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str)
  } catch {
    return str
  }
}

export class ViaSocketClient {
  private orgAlignedAt = 0

  /**
   * storeId: the tab's cookie store (incognito tabs have their own); incognito: open auth popups there too.
   * tabId / frameId: required for embed mode and storage fallback, where the token is read via scripting.
   * `page` follows the tab while the client is reused for the same host and org (Session.setPage), so it is the
   * page open now; agent runs read their own pinned page instead.
   */
  constructor(
    readonly env: ViaSocketEnv,
    public page: PageContext,
    readonly opts: { storeId?: string; incognito?: boolean; tabId?: number; frameId?: number } = {},
  ) {}

  /** The org the user is looking at. Tools act only on this org. */
  get orgId(): string | undefined {
    return this.page.orgId
  }

  async token(): Promise<string> {
    const readStorageScript = () => {
      try {
        const clean = (v: string | null): string | null => {
          if (!v) return null
          let s = v.trim()
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            s = s.slice(1, -1).trim()
          }
          return s.length > 0 ? s : null
        }
        const isJwt = (s: string | null): boolean =>
          Boolean(s && s.startsWith('ey') && s.includes('.') && s.length > 20)
        const safeDec = (s: string): string => {
          try {
            return decodeURIComponent(s)
          } catch {
            return s
          }
        }
        const splitEq = (s: string): [string, string] => {
          const idx = s.indexOf('=')
          if (idx === -1) return [s.trim(), '']
          return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()]
        }

        const candidateKeys = ['proxy_auth_token', 'token', 'auth_token', 'authToken', 'ssoEmbedToken', 'prod', 'testing']
        for (const k of candidateKeys) {
          const local = clean(localStorage.getItem(k))
          if (local) return local
          const sso = clean(sessionStorage.getItem(k))
          if (sso) return sso
        }

        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k) {
              const val = clean(localStorage.getItem(k))
              if (val && isJwt(val)) return val
            }
          }
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i)
            if (k) {
              const val = clean(sessionStorage.getItem(k))
              if (val && isJwt(val)) return val
            }
          }
        } catch {
          // ignore storage scan error
        }

        const pairs = (document.cookie || '').split(';')
        for (const part of pairs) {
          const [k, rawV] = splitEq(part)
          if (!k) continue
          const v = clean(safeDec(rawV))
          if (v && (candidateKeys.includes(k) || isJwt(v))) {
            return v
          }
        }
      } catch {
        return null
      }
      return null
    }

    const tabId = this.opts.tabId

    // 1. If tabId is available, try reading from the page directly via scripting.
    // Handles top-level flow pages, embeds (sessionStorage.ssoEmbedToken), and dynamic storage tokens.
    if (tabId) {
      try {
        const target: chrome.scripting.InjectionTarget =
          this.opts.frameId !== undefined && this.opts.frameId !== 0
            ? { tabId, frameIds: [this.opts.frameId] }
            : { tabId }
        const res = await chrome.scripting
          .executeScript({
            target,
            world: 'MAIN',
            func: readStorageScript,
          })
          .catch(() => null)
        const t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) return t

        // Fallback: try all frames in the tab
        const allRes = await chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: readStorageScript,
          })
          .catch(() => null)
        const fallbackT = allRes?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (fallbackT) return fallbackT
      } catch {
        // ignore
      }

      // Query content script directly as message fallback
      try {
        const opts = this.opts.frameId !== undefined ? { frameId: this.opts.frameId } : undefined
        const msgRes = (await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'get-auth-token' }, opts).catch(() => null)) as
          | { ok?: boolean; token?: string }
          | null
          | undefined
        const msgToken = cleanToken(msgRes?.token)
        if (msgToken) return msgToken
      } catch {
        // ignore
      }
    }

    // 2. Cookie discovery across candidates, candidate URLs, and stores
    const candidateNames = Array.from(new Set([this.env.cookieName, 'proxy_auth_token', 'prod', 'testing', 'token', 'auth_token']))
    const candidateUrls = Array.from(
      new Set([
        this.env.cookieUrl,
        'https://flow.viasocket.com/',
        'https://viasocket.com/',
        'https://beta-flow.viasocket.com/',
        'https://dev-flow.viasocket.com/',
      ]),
    )

    // With specific storeId (incognito tabs, etc.)
    if (this.opts.storeId) {
      for (const url of candidateUrls) {
        for (const name of candidateNames) {
          const c = await chrome.cookies.get({ url, name, storeId: this.opts.storeId }).catch(() => null)
          const val = cleanToken(c?.value ? safeDecode(c.value) : null)
          if (val) return val
        }
      }
    }

    // Default store
    for (const url of candidateUrls) {
      for (const name of candidateNames) {
        const c = await chrome.cookies.get({ url, name }).catch(() => null)
        const val = cleanToken(c?.value ? safeDecode(c.value) : null)
        if (val) return val
      }
    }

    // chrome.cookies.getAll by candidate URLs
    for (const url of candidateUrls) {
      try {
        const byUrl = await chrome.cookies.getAll({ url }).catch(() => [])
        for (const name of candidateNames) {
          const c = byUrl.find((cookie) => cookie.name === name && cookie.value)
          const val = cleanToken(c?.value ? safeDecode(c.value) : null)
          if (val) return val
        }
        for (const c of byUrl) {
          const val = cleanToken(c.value ? safeDecode(c.value) : null)
          if (val && isLikelyJwt(val)) return val
        }
      } catch {
        // ignore
      }
    }

    // chrome.cookies.getAll by domain viasocket.com
    for (const domain of ['viasocket.com', '.viasocket.com']) {
      try {
        const all = await chrome.cookies.getAll({ domain }).catch(() => [])
        for (const name of candidateNames) {
          const c = all.find((cookie) => cookie.name === name && cookie.value)
          const val = cleanToken(c?.value ? safeDecode(c.value) : null)
          if (val) return val
        }
        for (const c of all) {
          const val = cleanToken(c.value ? safeDecode(c.value) : null)
          if (val && isLikelyJwt(val)) return val
        }
      } catch {
        // ignore
      }
    }

    console.warn('[viaSocket Assistant] token resolution failed', {
      env: this.env.name,
      tabId: this.opts.tabId,
      frameId: this.opts.frameId,
      storeId: this.opts.storeId,
    })

    if (this.env.embed) {
      throw new VsError('You are not signed in to viaSocket. Open the embed and try again.', 'logged-out')
    }
    throw new VsError('You are signed out of viaSocket. Sign in and try again.', 'logged-out')
  }

  async request<T = any>(req: VsRequest): Promise<T> {
    const base = req.base === 'vm' ? this.env.vmBase : this.env.apiBase
    if (!req.path.startsWith('/') || req.path.includes('://') || req.path.includes('..')) {
      throw new VsError(`Refusing unexpected path ${req.path}`, 'blocked')
    }
    if (req.base === 'vm' && !VM_ALLOWED.test(req.path)) {
      throw new VsError('Only the draft-test endpoint may be called on the VM', 'blocked')
    }
    const url = new URL(base + req.path)
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (req.base !== 'vm') headers.proxy_auth_token = await this.token()
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'
    if (req.live) headers['sent-by-fbai'] = 'true'

    let res: Response
    try {
      res = await fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: req.signal,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new VsError('Cancelled', 'aborted')
      throw new VsError('Could not reach viaSocket. Check your connection.', 'network')
    }

    const text = await res.text()
    let body: any = undefined
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    if (res.ok) return body as T

    // Backend errors are {success:false, message, data}; auth failures are {message:'unauthorized user'}.
    const message = (body && typeof body === 'object' && typeof body.message === 'string' ? body.message : '') || `HTTP ${res.status}`
    const kind: VsErrorKind =
      res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not-found' : res.status >= 500 ? 'server' : 'validation'
    throw new VsError(message, kind, res.status, body)
  }

  /**
   * Runs `fn` after every earlier mutation on the same flow has settled. The backend loads, mutates and rewrites
   * the whole json_script per request, so concurrent writes would silently overwrite each other.
   */
  mutate<T>(scriptId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.env.apiBase}|${scriptId}`
    if (ACTIVE_MUTATIONS.has(key)) {
      return fn()
    }
    const prev = FLOW_QUEUES.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(async () => {
      ACTIVE_MUTATIONS.add(key)
      try {
        return await fn()
      } finally {
        ACTIVE_MUTATIONS.delete(key)
      }
    })
    const tail = next.catch(() => undefined)
    FLOW_QUEUES.set(key, tail)
    void tail.then(() => {
      if (FLOW_QUEUES.get(key) === tail) FLOW_QUEUES.delete(key)
    })
    return next
  }

  /**
   * Makes the token's active org equal the org in the page URL. Several write routes use the token's cached org
   * without checking (and broadcast live updates on that org's channel), while org-scoped GETs switch it.
   * Calling an org-scoped GET first keeps writes, live updates and the user's tab on the same org.
   * `force` skips the cache, for routes that do not realign themselves: another tab may have switched the org.
   */
  async alignOrg(signal?: AbortSignal, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (!this.orgId) throw new VsError('Open a viaSocket workspace first.', 'validation')
    if (!force && Date.now() - this.orgAlignedAt < ORG_ALIGN_TTL_MS) return
    try {
      await this.request({ method: 'GET', path: `/orgs/${encodeURIComponent(this.orgId)}/projects`, query: { type: 'flow' }, signal })
      this.orgAlignedAt = Date.now()
    } catch (e) {
      if (this.env.embed) {
        this.orgAlignedAt = Date.now()
        return
      }
      throw e
    }
  }
}
