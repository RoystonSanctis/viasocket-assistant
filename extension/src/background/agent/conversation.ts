// Per-page conversation memory in chrome.storage.session: it survives service-worker restarts, is cleared when
// the browser closes, and is not readable by content scripts (default TRUSTED_CONTEXTS access level).
// Threads from incognito tabs are the exception and live in memory only (see incognitoThreads).

import { normalizePlan, type ChatLine, type ChatRole, type WorkflowPlan } from '../../shared/mascot'
import { threadKey, type PageContext } from '../../shared/page'
import type { ChatMessage } from '../llm/types'
import type { Session } from './session'

export interface Thread {
  messages: ChatMessage[]
  lines: ChatLine[]
  /** The workflow plan shown as a checklist card (ui_plan); kept with the thread so it is cleared and carried with it */
  plan?: WorkflowPlan | null
}

const PREFIX = 'thread:'
const INDEX_KEY = 'threads:index'
const MAX_THREADS = 20
const MAX_LINES = 200
/** Saved tool-call arguments above this (e.g. Developer Hub code) are replaced by a stub; tools can re-read them. */
const MAX_SAVED_ARGUMENT_CHARS = 4000
const OLD_ARGUMENT_CHARS = 1000
const INCOGNITO_PREFIX = 'incognito|'

/**
 * This worker serves incognito tabs too (spanning mode), but chrome.storage.session belongs to the regular profile
 * and outlives the incognito window, so incognito conversations are never written there. They are also kept apart
 * from the regular profile's thread for the same flow, which may belong to another viaSocket account.
 */
const incognitoThreads = new Map<string, Thread>()

/** Storage key of the conversation for a page, as seen from a regular or an incognito tab. */
export function threadFor(page: PageContext, incognito: boolean): string {
  return incognito ? INCOGNITO_PREFIX + threadKey(page) : threadKey(page)
}

export function forgetIncognitoThreads(): void {
  incognitoThreads.clear()
}

// Every write is a read-modify-write of the same keys, so all of them go through one queue.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(fn)
  queue = next.catch(() => undefined)
  return next
}

async function read(key: string): Promise<Thread> {
  const raw = key.startsWith(INCOGNITO_PREFIX)
    ? incognitoThreads.get(key)
    : ((await chrome.storage.session.get(PREFIX + key))[PREFIX + key] as Partial<Thread> | undefined)
  return {
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    lines: Array.isArray(raw?.lines) ? raw.lines : [],
    plan: normalizePlan(raw?.plan),
  }
}

async function write(key: string, thread: Thread): Promise<void> {
  if (key.startsWith(INCOGNITO_PREFIX)) {
    // Copied like storage would, and re-inserted so the Map's order is least recently used first.
    incognitoThreads.delete(key)
    incognitoThreads.set(key, structuredClone(thread))
    for (const k of incognitoThreads.keys()) {
      if (incognitoThreads.size <= MAX_THREADS) break
      incognitoThreads.delete(k)
    }
    return
  }
  const set = () => chrome.storage.session.set({ [PREFIX + key]: thread })
  try {
    await set()
  } catch (e) {
    if (!/quota/i.test(e instanceof Error ? e.message : String(e))) throw e
    // Over the session-storage quota: drop the least recently used threads a few at a time, not all at once.
    for (let keep = MAX_THREADS - 1; ; keep = Math.floor(keep / 2)) {
      await evict(key, keep)
      try {
        await set()
        break
      } catch (again) {
        if (keep <= 1) throw again
      }
    }
  }
  await evict(key, MAX_THREADS)
}

/** Records `key` as most recently used and removes the least recently used threads beyond `keep`. */
async function evict(key: string, keep: number): Promise<void> {
  const index = ((await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY] ?? {}) as Record<string, number>
  index[key] = Date.now()
  const others = Object.keys(index)
    .filter((k) => k !== key)
    .sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0))
  const drop = others.slice(0, Math.max(0, others.length - Math.max(0, keep - 1)))
  for (const k of drop) delete index[k]
  if (drop.length) await chrome.storage.session.remove(drop.map((k) => PREFIX + k))
  await chrome.storage.session.set({ [INDEX_KEY]: index })
}

export function loadThread(key: string): Promise<Thread> {
  return read(key)
}

export async function loadPlan(key: string): Promise<WorkflowPlan | null> {
  return (await read(key)).plan ?? null
}

/** Stores the thread's plan; null removes it. */
export function savePlan(key: string, plan: WorkflowPlan | null): Promise<void> {
  return serialized(async () => {
    const thread = await read(key)
    if (!plan && !thread.plan) return
    await write(key, { ...thread, plan })
  })
}

/** Shows a conversation in the panel: its chat lines, then its plan. Null shows an empty conversation. */
export function showThread(session: Session, thread: Pick<Thread, 'lines' | 'plan'> | null): void {
  session.send({ type: 'history', lines: thread?.lines ?? [] })
  session.send({ type: 'plan', plan: thread?.plan ?? null })
}

/** Sends the stored conversation for `key` to the panel (an empty one for null). */
export async function sendHistory(session: Session, key: string | null): Promise<void> {
  showThread(session, key ? await read(key) : null)
}

export function saveMessages(key: string, messages: ChatMessage[], maxMessages: number): Promise<void> {
  return serialized(async () => {
    const thread = await read(key)
    await write(key, { ...thread, messages: trimMessages(messages, maxMessages).map(forStorage) })
  })
}

/**
 * Provider reasoning state is only replayed within the turn that produced it, and a saved thread is only read back
 * by the next turn, so it is not stored. Oversized arguments are stubbed (as valid JSON, which providers expect).
 */
function forStorage(m: ChatMessage): ChatMessage {
  if (m.role !== 'assistant' || (!m.providerExtras && !m.toolCalls?.length)) return m
  const out: ChatMessage = { role: 'assistant', content: m.content }
  if (m.toolCalls?.length) out.toolCalls = m.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: stubArgs(args, MAX_SAVED_ARGUMENT_CHARS) }))
  return out
}

function stubArgs(args: string, max: number): string {
  return args.length > max ? JSON.stringify({ truncated: true, chars: args.length }) : args
}

export function appendLine(key: string, line: ChatLine): Promise<void> {
  return serialized(async () => {
    const thread = await read(key)
    const lines = [...thread.lines, line].slice(-MAX_LINES)
    await write(key, { ...thread, lines })
  })
}

export function clearThread(key: string): Promise<void> {
  return serialized(async () => {
    if (key.startsWith(INCOGNITO_PREFIX)) incognitoThreads.delete(key)
    else await chrome.storage.session.remove(PREFIX + key)
  })
}

/**
 * Copies a thread to a new page's key when that page has no conversation of its own yet. The plan MOVES: it belongs
 * to the flow being built, and the source (often the org-wide project or home thread) must not keep showing a stale
 * build. When the new page already has a conversation, only the plan moves there (unless it has a plan of its own).
 */
export function carryOver(from: string, to: string): Promise<boolean> {
  if (from === to) return Promise.resolve(false)
  return serialized(async () => {
    const target = await read(to)
    const source = await read(from)
    if (target.messages.length || target.lines.length) {
      if (source.plan && !target.plan) {
        await write(to, { ...target, plan: source.plan })
        await write(from, { ...source, plan: null })
      }
      return false
    }
    if (!source.messages.length && !source.lines.length) return false
    await write(to, source)
    if (source.plan) await write(from, { ...source, plan: null })
    return true
  })
}

/**
 * Keeps at most `max` messages by dropping the oldest whole turns (a turn starts at a user message), so an
 * assistant tool-call message is never separated from its tool results and history never starts with a tool
 * message. If the newest turn alone is too long, its oldest tool-call groups are dropped instead.
 */
export function trimMessages(messages: ChatMessage[], max: number): ChatMessage[] {
  let start = messages.findIndex((m) => m.role === 'user')
  if (start === -1) start = 0
  while (messages.length - start > max) {
    const next = messages.findIndex((m, i) => i > start && m.role === 'user')
    if (next === -1) break
    start = next
  }
  const out = messages.slice(start)
  return out.length > max ? trimWithinTurn(out, max) : out
}

function trimWithinTurn(msgs: ChatMessage[], max: number): ChatMessage[] {
  const out = msgs.slice()
  const head = out[0]?.role === 'user' ? 1 : 0
  while (out.length > max) {
    const first = out[head]
    if (!first) break
    if (first.role === 'tool') {
      out.splice(head, 1)
      continue
    }
    if (first.role !== 'assistant') break
    let end = head + 1
    while (end < out.length && out[end]?.role === 'tool') end++
    // Never drop the newest group: the model must see the latest results.
    if (end >= out.length) break
    out.splice(head, end - head)
  }
  return out
}

function messageChars(m: ChatMessage): number {
  let n = m.content.length + 20
  if (m.role === 'assistant') for (const c of m.toolCalls ?? []) n += c.name.length + c.arguments.length + 40
  return n
}

function totalChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0)
}

/**
 * Fits history into roughly `budgetChars` for one request (the saved thread is not changed): first older tool
 * results and long arguments become stubs, then the oldest whole turns go, then the oldest tool-call groups of the
 * remaining turn. The newest tool-call group is always kept intact.
 */
export function fitBudget(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  if (totalChars(messages) <= budgetChars) return messages
  let lastGroup = -1
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.toolCalls?.length) lastGroup = i
  })
  let out = messages.map((m, i): ChatMessage => {
    if (i >= lastGroup) return m
    if (m.role === 'tool') {
      const stub = JSON.stringify({ truncated: true, tool: m.name })
      return m.content.length > stub.length ? { ...m, content: stub } : m
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return { ...m, toolCalls: m.toolCalls.map((c) => ({ ...c, arguments: stubArgs(c.arguments, OLD_ARGUMENT_CHARS) })) }
    }
    return m
  })
  while (totalChars(out) > budgetChars) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user')
    if (next === -1) break
    out = out.slice(next)
  }
  while (totalChars(out) > budgetChars) {
    const head = out[0]?.role === 'user' ? 1 : 0
    if (out[head]?.role !== 'assistant') break
    let end = head + 1
    while (end < out.length && out[end]?.role === 'tool') end++
    if (!out.slice(end).some((m) => m.role === 'assistant' && m.toolCalls?.length)) break
    out = [...out.slice(0, head), ...out.slice(end)]
  }
  return out
}

/** Sends a chat line to the panel and, unless it is a transient note, stores it with the current thread. */
export function postLine(session: Session, role: ChatRole, text: string, persist = role !== 'system-note'): ChatLine {
  const line: ChatLine = { id: crypto.randomUUID(), role, text, at: Date.now() }
  session.send({ type: 'chat', line })
  const key = session.threadKey
  if (persist && key) {
    appendLine(key, line).catch((e: unknown) => console.warn('[assistant] could not store chat line', (e as Error).message))
  }
  return line
}
