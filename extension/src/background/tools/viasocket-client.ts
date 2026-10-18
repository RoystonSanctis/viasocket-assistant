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

export class ViaSocketClient {
  private orgAlignedAt = 0

  /** storeId: the tab's cookie store (incognito tabs have their own); incognito: open auth popups there too. */
  constructor(readonly env: ViaSocketEnv, readonly page: PageContext, readonly opts: { storeId?: string; incognito?: boolean } = {}) {}

  /** The org the user is looking at. Tools act only on this org. */
  get orgId(): string | undefined {
    return this.page.orgId
  }

  async token(): Promise<string> {
    const c = await chrome.cookies.get({
      url: this.env.cookieUrl,
      name: this.env.cookieName,
      ...(this.opts.storeId ? { storeId: this.opts.storeId } : {}),
    })
    if (!c?.value) throw new VsError('You are signed out of viaSocket. Sign in and try again.', 'logged-out')
    return decodeURIComponent(c.value)
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
    await this.request({ method: 'GET', path: `/orgs/${encodeURIComponent(this.orgId)}/projects`, query: { type: 'flow' }, signal })
    this.orgAlignedAt = Date.now()
  }
}
