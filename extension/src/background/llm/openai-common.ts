// Pieces shared by the two OpenAI request formats: chat completions (openai.ts) and the Responses API
// (openai-responses.ts). Kept apart so the two adapters do not import each other.

import { asRecord } from './http'
import type { ResolvedProvider } from './types'

/** OpenAI's limit on a function description; applied to every provider since routers pass them on to OpenAI. */
const OPENAI_MAX_DESCRIPTION = 1024

/**
 * chrome.storage.session key of the remembered request-shape refusals below. Session storage survives the service
 * worker stopping when idle (so a new turn does not pay for the same failed request again) and is cleared when the
 * browser closes, so a model that later gains support is tried again. Only provider:model names are stored.
 */
const REMEMBERED_KEY = 'llm:remembered'
/** Most recent entries kept per list. */
const MAX_REMEMBERED = 200

/** A remembered set of provider:model keys, kept in memory and mirrored to chrome.storage.session. */
export interface RememberedSet {
  has(key: string): boolean
  add(key: string): void
}

const lists = new Map<string, Set<string>>()
let loading: Promise<void> | undefined
let saving: Promise<void> = Promise.resolve()

function sessionArea(): chrome.storage.StorageArea | undefined {
  try {
    return typeof chrome === 'undefined' ? undefined : chrome.storage?.session
  } catch {
    return undefined
  }
}

function listFor(name: string): Set<string> {
  let set = lists.get(name)
  if (!set) {
    set = new Set()
    lists.set(name, set)
  }
  return set
}

function addBounded(set: Set<string>, key: string): void {
  set.delete(key)
  set.add(key)
  while (set.size > MAX_REMEMBERED) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/** Loads the remembered refusals once per worker start. Adapters await it before building a request. */
export function loadRemembered(): Promise<void> {
  loading ??= (async () => {
    const area = sessionArea()
    if (!area) return
    try {
      const raw = asRecord((await area.get(REMEMBERED_KEY))[REMEMBERED_KEY])
      for (const [name, entries] of Object.entries(raw ?? {})) {
        if (!Array.isArray(entries)) continue
        const set = listFor(name)
        // Merged rather than replaced: nothing added in memory before the load finished is lost.
        for (const key of entries.slice(-MAX_REMEMBERED)) if (typeof key === 'string' && !set.has(key)) addBounded(set, key)
      }
    } catch {
      // Storage unavailable: the lists stay in memory for this worker's lifetime.
    }
  })()
  return loading
}

function save(): void {
  const area = sessionArea()
  if (!area) return
  // Written after the load, so a snapshot taken before it cannot overwrite what was stored.
  saving = saving
    .then(() => loadRemembered())
    .then(() => area.set({ [REMEMBERED_KEY]: Object.fromEntries([...lists].map(([name, set]) => [name, [...set]])) }))
    .catch(() => undefined)
}

export function rememberedSet(name: string): RememberedSet {
  const set = listFor(name)
  return {
    has: (key) => set.has(key),
    add: (key) => {
      if (set.has(key)) return
      addBounded(set, key)
      save()
    },
  }
}

/**
 * provider:model pairs that refused a custom temperature, so later steps do not pay for a failed request first.
 * Shared by both request formats: a model that refuses it on one refuses it on the other.
 */
export const noTemperature = rememberedSet('noTemperature')

export function openaiHeaders(p: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { ...p.extraHeaders }
  if (p.key) headers.Authorization = `Bearer ${p.key}`
  return headers
}

/** FNV-1a hash, used to derive stable wire ids (a call and its result are mapped separately and must stay equal). */
export function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function fitDescription(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const end = cut.lastIndexOf('. ')
  return `${end > max / 2 ? cut.slice(0, end + 1) : cut}…`
}

export function fitToolDescription(text: string): string {
  return fitDescription(text, OPENAI_MAX_DESCRIPTION)
}

/** The built-in OpenAI provider talking to OpenAI itself (not a proxy or another OpenAI-compatible server). */
export function isOpenAiPlatform(p: ResolvedProvider): boolean {
  if (p.id !== 'openai') return false
  try {
    return new URL(p.baseUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}
