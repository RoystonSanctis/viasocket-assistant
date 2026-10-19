// One Session per tab that has the content script connected. Sessions live only in service-worker memory;
// anything that must survive a worker restart (the conversation) is kept in chrome.storage.session, except for
// incognito tabs, whose conversation stays in memory (see conversation.ts).

import type { BackgroundToContent, DomPageStatus } from '../../shared/messages'
import type { Suggestion } from '../../shared/mascot'
import type { ObservedEvent } from '../../shared/observed'
import type { PageContext } from '../../shared/page'
import { resolveEnv } from '../tools/env'
import { ViaSocketClient } from '../tools/viasocket-client'
import type { UiBridge } from '../tools/types'
import { threadFor } from './conversation'
import { createUiBridge } from './ui-bridge'

const RECENT_EVENTS = 10
const MAX_PENDING_SUGGESTIONS = 20
const KEEP_ALIVE_MS = 20_000
/** A voice turn whose end never arrives (the offscreen document went away) stops counting as work after this. */
const VOICE_TURN_MAX_MS = 10 * 60_000

interface CookieScope {
  storeId?: string
  incognito: boolean
}

export interface PendingSuggestion {
  suggestion: Suggestion
  /** The event an "Explain" suggestion is about; kept here so the content script cannot alter what gets explained */
  event?: ObservedEvent
}

export class Session {
  page: PageContext | null = null
  vs: ViaSocketClient | null = null
  domStatus: DomPageStatus | null = null
  busy = false
  voiceActive = false
  closed = false
  /**
   * A full reload the user confirmed during a run. Reloading replaces the page and this session, which would abort
   * the run, so it is sent once the run has posted its last reply (see finishRun in loop.ts).
   */
  pendingReload: string | null = null
  /**
   * Latest queued page update. 'hello' and 'page-changed' await setPage (cookie-store lookup) while other port
   * messages are handled concurrently; input queued during a reconnect must wait for it or it finds no client.
   */
  pageUpdate: Promise<void> = Promise.resolve()
  private _voiceTurn = false
  private voiceTurnTimer: ReturnType<typeof setTimeout> | undefined
  readonly ui: UiBridge
  /** An incognito tab: its conversation is kept apart and never written to storage (see threadFor) */
  readonly incognito: boolean
  readonly pendingConfirms = new Map<string, (approved: boolean) => void>()
  readonly pendingSuggestions = new Map<string, PendingSuggestion>()
  readonly recentEvents: ObservedEvent[] = []
  readonly reactionCooldowns = new Map<string, number>()
  private pendingDomStatus = new Map<string, (status: DomPageStatus) => void>()

  private abortCtl: AbortController | null = null
  /** Thread a run started on. A run that navigates (e.g. into a flow it just created) keeps writing here. */
  private runThread: string | null = null
  /** When the current run started (the user's message); a plan proposed after it awaits the user's reply */
  runStartedAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private idleWaiters: Array<() => void> = []
  private cookieScope: Promise<CookieScope | null> | null = null

  constructor(readonly port: chrome.runtime.Port, readonly tabId: number) {
    this.incognito = port.sender?.tab?.incognito === true
    this.ui = createUiBridge(this)
  }

  send(msg: BackgroundToContent): void {
    if (this.closed) return
    try {
      this.port.postMessage(msg)
    } catch {
      // Port already gone; onDisconnect will clean up.
    }
  }

  /** A voice turn (recording through transcription) is in progress for this tab. */
  get voiceTurn(): boolean {
    return this._voiceTurn
  }

  set voiceTurn(on: boolean) {
    this._voiceTurn = on
    clearTimeout(this.voiceTurnTimer)
    if (on) {
      this.voiceTurnTimer = setTimeout(() => {
        this.voiceTurn = false
      }, VOICE_TURN_MAX_MS)
    }
    this.updateKeepAlive()
  }

  async setPage(page: PageContext): Promise<void> {
    const prev = this.page
    this.page = page
    const env = resolveEnv(page.host)
    if (!env) {
      this.vs = null
      return
    }
    if (this.vs && prev && prev.host === page.host && prev.orgId === page.orgId) return
    this.vs = null
    this.cookieScope ??= findCookieScope(this.tabId, this.incognito)
    const scope = await this.cookieScope
    if (!scope) this.cookieScope = null
    // A newer page arrived meanwhile and builds its own client.
    if (this.page !== page || this.closed || !scope) return
    this.vs = new ViaSocketClient(env, page, scope)
  }

  /** Thread chat lines and messages belong to right now. */
  get threadKey(): string | null {
    if (this.busy && this.runThread) return this.runThread
    return this.page ? this.threadOf(this.page) : null
  }

  /** The conversation key for a page in this tab. */
  threadOf(page: PageContext): string {
    return threadFor(page, this.incognito)
  }

  get signal(): AbortSignal | undefined {
    return this.abortCtl?.signal
  }

  beginRun(): AbortSignal {
    this.clearIdleTimer()
    this.busy = true
    this.updateKeepAlive()
    this.abortCtl = new AbortController()
    this.runStartedAt = Date.now()
    this.runThread = this.page ? this.threadOf(this.page) : null
    this.send({ type: 'busy', busy: true })
    return this.abortCtl.signal
  }

  /** Returns the thread the run wrote to, so the caller can carry it over if the page moved on. */
  endRun(): string | null {
    const thread = this.runThread
    this.busy = false
    this.updateKeepAlive()
    this.abortCtl = null
    this.runThread = null
    this.pendingReload = null
    this.send({ type: 'busy', busy: false })
    for (const wake of this.idleWaiters.splice(0)) wake()
    return thread
  }

  /** Resolves once the current run has fully finished (including its last save), or after timeoutMs. */
  whenIdle(timeoutMs: number): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.idleWaiters.push(done)
    })
  }

  cancelRun(): void {
    this.abortCtl?.abort()
    this.rejectConfirms()
  }

  addConfirm(id: string, resolve: (approved: boolean) => void): void {
    this.pendingConfirms.set(id, resolve)
  }

  resolveConfirm(id: string, approved: boolean): void {
    const resolve = this.pendingConfirms.get(id)
    if (!resolve) return
    this.pendingConfirms.delete(id)
    resolve(approved)
  }

  addSuggestion(entry: PendingSuggestion): void {
    this.pendingSuggestions.set(entry.suggestion.id, entry)
    while (this.pendingSuggestions.size > MAX_PENDING_SUGGESTIONS) {
      const oldest = this.pendingSuggestions.keys().next().value
      if (oldest === undefined) break
      this.pendingSuggestions.delete(oldest)
    }
  }

  pushEvent(event: ObservedEvent): void {
    this.recentEvents.push(event)
    if (this.recentEvents.length > RECENT_EVENTS) this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENTS)
  }

  /** Return the mascot to idle after a short beat, unless a run is in progress by then. */
  settleMascot(delayMs: number): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.busy) this.send({ type: 'mascot', mode: 'idle' })
    }, delayMs)
  }

  close(): void {
    if (this.closed) return
    this.cancelRun()
    this.closed = true
    clearTimeout(this.voiceTurnTimer)
    this.updateKeepAlive()
    this.clearIdleTimer()
    this.pendingSuggestions.clear()
    for (const wake of this.idleWaiters.splice(0)) wake()
  }

  private rejectConfirms(): void {
    for (const [id, resolve] of this.pendingConfirms) {
      resolve(false)
      this.send({ type: 'confirm-cancel', id })
    }
    this.pendingConfirms.clear()
  }

  setDomStatus(status: DomPageStatus): void {
    this.domStatus = status
  }

  resolveDomStatus(requestId: string, status: DomPageStatus): void {
    this.domStatus = status
    const resolver = this.pendingDomStatus.get(requestId)
    if (resolver) {
      this.pendingDomStatus.delete(requestId)
      resolver(status)
    }
  }

  async getDomStatus(timeoutMs = 250): Promise<DomPageStatus | null> {
    if (this.closed) return this.domStatus
    const requestId = crypto.randomUUID()
    return new Promise<DomPageStatus | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDomStatus.delete(requestId)
        resolve(this.domStatus)
      }, timeoutMs)
      this.pendingDomStatus.set(requestId, (status) => {
        clearTimeout(timer)
        resolve(status)
      })
      this.send({ type: 'get-dom-status', requestId })
    })
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private updateKeepAlive(): void {
    if (!this.closed && (this.busy || this._voiceTurn)) workingSessions.add(this)
    else workingSessions.delete(this)
    if (workingSessions.size > 0 && !keepAliveTimer) {
      // Any extension API call resets the worker's 30 s idle timer. The content script's heartbeat alone is not
      // enough: Chrome throttles or freezes timers in hidden tabs, and a long LLM call makes no API calls.
      keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo().catch(() => undefined)
      }, KEEP_ALIVE_MS)
    } else if (workingSessions.size === 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
  }
}

/** Sessions with a run or voice turn in progress; while there are any, the worker keeps itself alive. */
const workingSessions = new Set<Session>()
let keepAliveTimer: ReturnType<typeof setInterval> | null = null

/**
 * The tab's cookie store. Incognito tabs share this worker (spanning mode) but have their own store, so reading the
 * token without it would act as whoever is signed in to the regular profile. Null when it cannot be determined for
 * an incognito tab: no client is better than the wrong account.
 */
async function findCookieScope(tabId: number, incognito: boolean): Promise<CookieScope | null> {
  const stores = await chrome.cookies.getAllCookieStores().catch(() => [])
  const storeId = stores.find((s) => s.tabIds.includes(tabId))?.id
  if (incognito && !storeId) return null
  return { storeId, incognito }
}

const sessions = new Map<number, Session>()

export function openSession(port: chrome.runtime.Port, tabId: number): Session {
  // A full page reload can connect the new port before the old one reports its disconnect.
  sessions.get(tabId)?.close()
  const session = new Session(port, tabId)
  sessions.set(tabId, session)
  return session
}

export function closeSession(session: Session): void {
  session.close()
  if (sessions.get(session.tabId) === session) sessions.delete(session.tabId)
}

export function getSession(tabId: number): Session | undefined {
  return sessions.get(tabId)
}

export function allSessions(): Session[] {
  return [...sessions.values()]
}
