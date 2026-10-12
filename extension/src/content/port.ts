// Long-lived port to the service worker.
//
// MV3 service workers stop when idle and restart on demand, which disconnects the port. We reconnect with backoff
// and re-introduce ourselves with the current page. When the extension itself is reloaded, updated or removed,
// chrome.runtime.id disappears and this content script is orphaned for good, so we stop and tell the caller.

import { PORT_NAME, type BackgroundToContent, type ContentToBackground } from '../shared/messages'
import type { PageContext } from '../shared/page'

const HEARTBEAT_MS = 20_000
const BACKOFF_START_MS = 500
const BACKOFF_MAX_MS = 10_000
/** A connection that lasted this long proves the worker is healthy, so the backoff starts over */
const STABLE_MS = 5_000
const QUEUE_MAX = 50

export interface PortOptions {
  /** Page sent in 'hello' on every (re)connect */
  currentPage(): PageContext
  onMessage(msg: BackgroundToContent): void
  /** The extension context is gone (reload/update/uninstall); nothing will ever reconnect */
  onDead(): void
}

export interface PortClient {
  /** Sends now, or queues until reconnected. Heartbeats are never queued. */
  send(msg: ContentToBackground): void
  isConnected(): boolean
  stop(): void
}

function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id)
  } catch {
    return false
  }
}

export function connectPort(opts: PortOptions): PortClient {
  let port: chrome.runtime.Port | null = null
  let stopped = false
  let delay = BACKOFF_START_MS
  let openedAt = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const queue: ContentToBackground[] = []

  function teardown(): void {
    clearInterval(heartbeat)
    heartbeat = undefined
    const p = port
    port = null
    if (p) {
      try {
        p.onMessage.removeListener(onPortMessage)
        p.onDisconnect.removeListener(onDisconnect)
        p.disconnect()
      } catch {
        // already gone
      }
    }
  }

  function die(): void {
    if (stopped) return
    stop()
    opts.onDead()
  }

  /** Posts on the open port; on failure treats the port as dead and schedules a reconnect. */
  function raw(msg: ContentToBackground): boolean {
    if (!port) return false
    try {
      port.postMessage(msg)
      return true
    } catch {
      teardown()
      if (extensionAlive()) scheduleReconnect()
      else die()
      return false
    }
  }

  function flush(): void {
    while (queue.length && port) {
      const next = queue[0]
      if (!next || !raw(next)) return
      queue.shift()
    }
  }

  function onPortMessage(msg: unknown): void {
    // Any message proves the worker is up.
    delay = BACKOFF_START_MS
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') return
    opts.onMessage(msg as BackgroundToContent)
  }

  function onDisconnect(p: chrome.runtime.Port): void {
    try {
      // Reading lastError marks it handled, so Chrome does not log "Unchecked runtime.lastError".
      void chrome.runtime.lastError
    } catch {
      // context invalidated
    }
    if (p !== port) return
    teardown()
    if (!extensionAlive()) return die()
    if (Date.now() - openedAt > STABLE_MS) delay = BACKOFF_START_MS
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(connect, delay)
    delay = Math.min(delay * 2, BACKOFF_MAX_MS)
  }

  function connect(): void {
    reconnectTimer = undefined
    if (stopped) return
    if (!extensionAlive()) return die()
    let p: chrome.runtime.Port
    try {
      p = chrome.runtime.connect({ name: PORT_NAME })
    } catch {
      if (extensionAlive()) scheduleReconnect()
      else die()
      return
    }
    port = p
    openedAt = Date.now()
    p.onMessage.addListener(onPortMessage)
    p.onDisconnect.addListener(onDisconnect)
    if (!raw({ type: 'hello', page: opts.currentPage() })) return
    // Started before flushing so a failed flush (teardown) also clears it.
    heartbeat = setInterval(() => raw({ type: 'heartbeat' }), HEARTBEAT_MS)
    flush()
  }

  function send(msg: ContentToBackground): void {
    if (stopped) return
    if (msg.type === 'heartbeat') {
      raw(msg)
      return
    }
    if (port && queue.length === 0 && raw(msg)) return
    // 'hello' on reconnect already carries the current page, so queued page changes would be stale noise.
    if (msg.type === 'page-changed') return
    queue.push(msg)
    if (queue.length > QUEUE_MAX) queue.shift()
    if (port) flush()
  }

  function stop(): void {
    stopped = true
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    teardown()
    queue.length = 0
  }

  connect()

  return { send, isConnected: () => port !== null, stop }
}
