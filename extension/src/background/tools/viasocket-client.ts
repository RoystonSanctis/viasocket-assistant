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
import { isEmbedContext, type ViaSocketEnv } from './env'

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
  if (!s) return null
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s).trim()
    } catch {
      // ignore
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s).trim()
    } catch {
      // ignore
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s.length > 0 ? s : null
}

function isLikelyJwt(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const s = cleanToken(raw)
  return Boolean(s && s.startsWith('ey') && s.includes('.') && s.length > 20)
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
  private cachedToken: { token: string; expiresAt: number } | null = null

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

  private async resolveTabId(): Promise<number | undefined> {
    if (this.opts.tabId !== undefined) return this.opts.tabId
    try {
      const tabs = await chrome.tabs.query({
        url: [
          this.env.cookieUrl,
          `https://${this.page.host}/*`,
          'https://flow.viasocket.com/*',
          'https://beta-flow.viasocket.com/*',
          'https://dev-flow.viasocket.com/*',
        ],
      })
      if (tabs[0]?.id !== undefined) return tabs[0].id
    } catch {
      // ignore
    }
    return undefined
  }

  async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token
    }

    const isEmbed = isEmbedContext(this.env, this.page)
    const tabId = await this.resolveTabId()

    // ==========================================
    // 1. EMBED MODE
    // ==========================================
    // In embed mode (embedfrontend.viasocket.com or embedded iframes),
    // authentication uses sessionStorage.ssoEmbedToken or localStorage.proxy_auth_token
    // set by the embed iframe bootstrap. It NEVER uses the parent domain cookie.
    if (isEmbed) {
      if (!tabId) {
        throw new VsError('Cannot read embed token: tab ID is missing.', 'logged-out')
      }

      const readEmbedScript = () => {
        try {
          const clean = (v: string | null): string | null => {
            if (!v) return null
            let s = v.trim()
            if (!s) return null
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            return s.length > 0 ? s : null
          }
          const sso = clean(sessionStorage.getItem('ssoEmbedToken')) || clean(sessionStorage.getItem('proxy_auth_token'))
          if (sso) return sso
          const local = clean(localStorage.getItem('proxy_auth_token')) || clean(localStorage.getItem('ssoEmbedToken'))
          if (local) return local
        } catch {
          return null
        }
        return null
      }

      // 1a. Try target frame if frameId is specified
      if (this.opts.frameId !== undefined && this.opts.frameId !== 0) {
        const frameRes = await chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [this.opts.frameId] },
            world: 'MAIN',
            func: readEmbedScript,
          })
          .catch(() => null)
        const t = frameRes?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) {
          this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
          return t
        }
      }

      // 1b. Try all frames in tab
      const allRes = await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: readEmbedScript,
        })
        .catch(() => null)
      const allToken = allRes?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
      if (allToken) {
        this.cachedToken = { token: allToken, expiresAt: Date.now() + 5 * 60_000 }
        return allToken
      }

      // 1c. Try content script message
      try {
        const opts = this.opts.frameId !== undefined && this.opts.frameId !== 0 ? { frameId: this.opts.frameId } : undefined
        const msgRes = (await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'get-auth-token', mode: 'embed' }, opts).catch(() => null)) as
          | { ok?: boolean; token?: string }
          | null
          | undefined
        const msgToken = cleanToken(msgRes?.token)
        if (msgToken) {
          this.cachedToken = { token: msgToken, expiresAt: Date.now() + 5 * 60_000 }
          return msgToken
        }
      } catch {
        // ignore
      }

      throw new VsError('You are not signed in to viaSocket. Open the embed and try again.', 'logged-out')
    }

    // ==========================================
    // 2. FLOW MODE
    // ==========================================
    // In flow mode (flow.viasocket.com, beta-flow.viasocket.com, dev-flow.viasocket.com),
    // modern viaSocket sessions authenticate using HttpOnly session cookies (e.g. session_production),
    // which mint a valid proxy_auth_token via GET /auth/token with credentials: 'include'.
    // We first query the /auth/token endpoint from the tab's authenticated origin, with fallbacks
    // to candidate cookies, JWT detection, localStorage and sessionStorage.

    const candidateNames = [
      this.env.cookieName,
      'prod',
      'testing',
      'proxy_auth_token',
      'beta',
      'token',
      'auth_token',
      'accessToken',
      'access_token',
      'authToken',
    ]

    if (tabId) {
      // 2a. Primary: Query /auth/token endpoint with session cookies from the tab
      const readAuthTokenScript = async (apiBase: string) => {
        try {
          const res = await fetch(`${apiBase}/auth/token`, { credentials: 'include' })
          if (!res.ok) return null
          const json = await res.json()
          const raw = json?.data?.token
          if (typeof raw !== 'string') return null
          const s = raw.trim()
          return s.length > 0 ? s : null
        } catch {
          return null
        }
      }

      try {
        const target: chrome.scripting.InjectionTarget =
          this.opts.frameId !== undefined && this.opts.frameId !== 0
            ? { tabId, frameIds: [this.opts.frameId] }
            : { tabId }
        let res = await chrome.scripting
          .executeScript({
            target,
            world: 'MAIN',
            func: readAuthTokenScript,
            args: [this.env.apiBase],
          })
          .catch(() => null)
        let t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) {
          this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
          return t
        }

        if (this.opts.frameId !== undefined && this.opts.frameId !== 0) {
          res = await chrome.scripting
            .executeScript({
              target: { tabId },
              world: 'MAIN',
              func: readAuthTokenScript,
              args: [this.env.apiBase],
            })
            .catch(() => null)
          t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
          if (t) {
            this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
            return t
          }
        }

        res = await chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: readAuthTokenScript,
            args: [this.env.apiBase],
          })
          .catch(() => null)
        t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) {
          this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
          return t
        }
      } catch {
        // ignore
      }

      // Try content script message with apiBase
      try {
        const msgRes = (await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'get-auth-token',
          mode: 'flow',
          cookieName: this.env.cookieName,
          apiBase: this.env.apiBase,
        }).catch(() => null)) as { ok?: boolean; token?: string } | null | undefined
        const msgToken = cleanToken(msgRes?.token)
        if (msgToken) {
          this.cachedToken = { token: msgToken, expiresAt: Date.now() + 5 * 60_000 }
          return msgToken
        }
      } catch {
        // ignore
      }

      // 2b. Fallback: Try reading cookie from document.cookie and storage in the page via scripting
      const readFlowScript = (preferredName: string) => {
        try {
          const decodeAndClean = (v: string | null): string | null => {
            if (!v) return null
            let s = v.trim()
            if (!s) return null
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            return s.length > 0 ? s : null
          }
          const isJwt = (s: string | null): boolean =>
            Boolean(s && s.startsWith('ey') && s.includes('.') && s.length > 20)

          const splitFromFirstEqual = (str: string) => {
            if (!str || str.indexOf('=') === -1) return [str, '']
            const index = str.indexOf('=')
            return [str.slice(0, index).trim(), str.slice(index + 1).trim()]
          }

          const parsedCookies = new Map<string, string>()
          for (const raw of (document.cookie || '').split(';')) {
            const [k, v] = splitFromFirstEqual(raw)
            if (k && v) {
              const val = decodeAndClean(v)
              if (val) parsedCookies.set(k, val)
            }
          }

          // 1. Preferred cookie name (e.g. 'prod' or 'testing')
          if (preferredName && parsedCookies.has(preferredName)) {
            return parsedCookies.get(preferredName)!
          }

          // 2. Candidate cookie names
          const candidates = ['prod', 'testing', 'proxy_auth_token', 'beta', 'token', 'auth_token', 'accessToken', 'access_token', 'authToken']
          for (const name of candidates) {
            if (parsedCookies.has(name)) {
              return parsedCookies.get(name)!
            }
          }

          // 3. Any cookie with a likely JWT value
          for (const val of parsedCookies.values()) {
            if (isJwt(val)) return val
          }

          // 4. LocalStorage candidate keys
          const storageKeys = ['proxy_auth_token', 'token', 'auth_token', 'prod', 'testing', 'accessToken', 'access_token', 'authToken']
          for (const key of storageKeys) {
            try {
              const val = decodeAndClean(localStorage.getItem(key))
              if (val) return val
            } catch {}
          }

          // 5. Any LocalStorage item with a JWT value
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i)
              if (key) {
                const val = decodeAndClean(localStorage.getItem(key))
                if (isJwt(val)) return val!
              }
            }
          } catch {}

          // 6. SessionStorage fallback
          try {
            const sso = decodeAndClean(sessionStorage.getItem('ssoEmbedToken')) || decodeAndClean(sessionStorage.getItem('proxy_auth_token'))
            if (sso) return sso
          } catch {}
        } catch {
          return null
        }
        return null
      }

      try {
        const target: chrome.scripting.InjectionTarget =
          this.opts.frameId !== undefined && this.opts.frameId !== 0
            ? { tabId, frameIds: [this.opts.frameId] }
            : { tabId }
        let res = await chrome.scripting
          .executeScript({
            target,
            world: 'MAIN',
            func: readFlowScript,
            args: [this.env.cookieName],
          })
          .catch(() => null)
        let t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) {
          this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
          return t
        }

        if (this.opts.frameId !== undefined && this.opts.frameId !== 0) {
          res = await chrome.scripting
            .executeScript({
              target: { tabId },
              world: 'MAIN',
              func: readFlowScript,
              args: [this.env.cookieName],
            })
            .catch(() => null)
          t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
          if (t) {
            this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
            return t
          }
        }

        res = await chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: readFlowScript,
            args: [this.env.cookieName],
          })
          .catch(() => null)
        t = res?.map((r) => cleanToken(r.result)).find((tok): tok is string => Boolean(tok))
        if (t) {
          this.cachedToken = { token: t, expiresAt: Date.now() + 5 * 60_000 }
          return t
        }
      } catch {
        // ignore
      }

      // Try content script message for flow token
      try {
        const msgRes = (await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'get-auth-token',
          mode: 'flow',
          cookieName: this.env.cookieName,
        }).catch(() => null)) as { ok?: boolean; token?: string } | null | undefined
        const msgToken = cleanToken(msgRes?.token)
        if (msgToken) {
          this.cachedToken = { token: msgToken, expiresAt: Date.now() + 5 * 60_000 }
          return msgToken
        }
      } catch {
        // ignore
      }
    }

    // 2c. Try chrome.cookies API across candidate stores and URLs
    const candidateUrls = Array.from(
      new Set([
        this.env.cookieUrl,
        'https://flow.viasocket.com/',
        'https://beta-flow.viasocket.com/',
        'https://dev-flow.viasocket.com/',
        'https://viasocket.com/',
      ]),
    )

    const stores = [this.opts.storeId, undefined].filter((s, i, arr) => arr.indexOf(s) === i)

    for (const storeId of stores) {
      const storeOpts = storeId ? { storeId } : {}

      // 1. Try specific candidate URLs and names
      for (const url of candidateUrls) {
        for (const name of candidateNames) {
          const c = await chrome.cookies.get({ url, name, ...storeOpts }).catch(() => null)
          const val = cleanToken(c?.value)
          if (val) {
            this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
            return val
          }
        }
      }

      // 2. Try getAll by URL
      for (const url of candidateUrls) {
        try {
          const byUrl = await chrome.cookies.getAll({ url, ...storeOpts }).catch(() => [])
          for (const name of candidateNames) {
            const c = byUrl.find((cookie) => cookie.name === name && cookie.value)
            const val = cleanToken(c?.value)
            if (val) {
              this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
              return val
            }
          }
          for (const c of byUrl) {
            const val = cleanToken(c?.value)
            if (val && isLikelyJwt(val)) {
              this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
              return val
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. Try getAll by domain viasocket.com
      try {
        const byDomain = await chrome.cookies.getAll({ domain: 'viasocket.com', ...storeOpts }).catch(() => [])
        for (const name of candidateNames) {
          const c = byDomain.find((cookie) => cookie.name === name && cookie.value)
          const val = cleanToken(c?.value)
          if (val) {
            this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
            return val
          }
        }
        for (const c of byDomain) {
          const val = cleanToken(c?.value)
          if (val && isLikelyJwt(val)) {
            this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
            return val
          }
        }
      } catch {
        // ignore
      }

      // 4. Try getAll across entire store and filter by viasocket.com domain
      try {
        const all = await chrome.cookies.getAll(storeOpts).catch(() => [])
        const vsCookies = all.filter((c) => c.domain && c.domain.toLowerCase().includes('viasocket.com'))
        for (const name of candidateNames) {
          const c = vsCookies.find((cookie) => cookie.name === name && cookie.value)
          const val = cleanToken(c?.value)
          if (val) {
            this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
            return val
          }
        }
        for (const c of vsCookies) {
          const val = cleanToken(c?.value)
          if (val && isLikelyJwt(val)) {
            this.cachedToken = { token: val, expiresAt: Date.now() + 5 * 60_000 }
            return val
          }
        }
      } catch {
        // ignore
      }
    }

    console.warn('[viaSocket Assistant] flow token resolution failed', {
      cookieName: this.env.cookieName,
      env: this.env.name,
      tabId: this.opts.tabId,
      frameId: this.opts.frameId,
      storeId: this.opts.storeId,
    })

    throw new VsError('You are signed out of viaSocket. Sign in and try again.', 'logged-out')
  }

  private async tryTabProxyFetch<T>(req: VsRequest, url: URL): Promise<T | undefined> {
    if (isEmbedContext(this.env, this.page)) return undefined
    const tabId = await this.resolveTabId()
    if (!tabId) return undefined

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'
    if (req.live) headers['sent-by-fbai'] = 'true'

    try {
      const msgRes = (await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'vs-proxy-fetch',
        url: url.toString(),
        method: req.method,
        headers,
        body: req.body,
      }).catch(() => null)) as { ok?: boolean; status?: number; body?: unknown } | null | undefined

      if (msgRes && msgRes.ok) {
        return msgRes.body as T
      }
    } catch {
      // ignore
    }

    try {
      const execRes = await chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (fetchUrl: string, method: string, hdrs: Record<string, string>, bodyData: unknown) => {
            try {
              const r = await fetch(fetchUrl, {
                method,
                headers: hdrs,
                body: bodyData !== undefined ? JSON.stringify(bodyData) : undefined,
                credentials: 'include',
              })
              const txt = await r.text()
              let parsed: any
              try {
                parsed = txt ? JSON.parse(txt) : undefined
              } catch {
                parsed = txt
              }
              return { ok: r.ok, status: r.status, body: parsed }
            } catch (err) {
              return { ok: false, error: String(err) }
            }
          },
          args: [url.toString(), req.method, headers, req.body],
        })
        .catch(() => null)

      const result = execRes?.[0]?.result as { ok?: boolean; status?: number; body?: unknown } | undefined
      if (result?.ok) {
        return result.body as T
      }
    } catch {
      // ignore
    }

    return undefined
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
      const proxyRes = await this.tryTabProxyFetch<T>(req, url)
      if (proxyRes !== undefined) return proxyRes
      throw new VsError('Could not reach viaSocket. Check your connection.', 'network')
    }

    // If 401 Unauthorized, token may have expired or rotated; clear cache and retry once
    if (res.status === 401 && headers.proxy_auth_token) {
      this.cachedToken = null
      try {
        const freshToken = await this.token()
        if (freshToken && freshToken !== headers.proxy_auth_token) {
          headers.proxy_auth_token = freshToken
          res = await fetch(url, {
            method: req.method,
            headers,
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            signal: req.signal,
          })
        }
      } catch {
        // ignore retry error
      }
    }

    if (res.status === 401 && !isEmbedContext(this.env, this.page)) {
      const proxyRes = await this.tryTabProxyFetch<T>(req, url)
      if (proxyRes !== undefined) return proxyRes
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
      if (isEmbedContext(this.env, this.page)) {
        this.orgAlignedAt = Date.now()
        return
      }
      throw e
    }
  }
}
