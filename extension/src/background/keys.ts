// LLM API keys. They live in the extension origin's IndexedDB, opened only from the service worker: content
// scripts use the page origin's IndexedDB and cannot reach it, unlike chrome.storage.local, which they can read and
// whose change events carry new values into every viaSocket tab. Each key is bound to the base URL it was saved
// with; registry.ts refuses to send it anywhere else. Keys are never logged.

export interface KeyRecord {
  providerId: string
  /** Origin the key is bound to; it is never sent anywhere else */
  origin: string
  /** Full base URL (origin + path) saved with the key, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string
  key: string
  savedAt: number
}

/** Where older versions kept the keys; moved out by migrateLegacyKeys() */
const LEGACY_STORAGE_KEY = 'llmKeys'
const DB_NAME = 'llm-keys'
const DB_STORE = 'keys'
/** The whole provider map is one record, so a save is a single atomic put. */
const DB_RECORD = 'all'
const PROVIDER_ID = /^[a-z0-9-]+$/
// Printable ASCII without spaces: anything else would be rejected as a header value or is a paste accident.
const KEY_CHARS = /^[\x21-\x7e]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * Canonical form of a provider base URL: https anywhere, plain http only on this computer, no credentials,
 * query or fragment, no trailing slash. Throws an Error with a user-facing message otherwise.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('The provider address is not a valid URL.')
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    throw new Error('The provider address must start with https:// (plain http is only allowed for localhost).')
  }
  if (url.username || url.password) throw new Error('The provider address must not contain a user name or password.')
  if (url.search || url.hash) throw new Error('The provider address must not contain ? or #.')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function isKeyRecord(v: unknown): v is KeyRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.providerId === 'string' &&
    typeof r.origin === 'string' &&
    typeof r.baseUrl === 'string' &&
    typeof r.key === 'string' &&
    typeof r.savedAt === 'number'
  )
}

function sanitize(raw: unknown): Record<string, KeyRecord> {
  const out: Record<string, KeyRecord> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (PROVIDER_ID.test(id) && isKeyRecord(rec) && rec.providerId === id) out[id] = rec
  }
  return out
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('Could not open the key store.'))
  }).catch((e: unknown) => {
    dbPromise = null
    throw e
  })
  return dbPromise
}

async function dbGet(): Promise<unknown> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_RECORD)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not read the key store.'))
  })
}

async function dbPut(map: Record<string, KeyRecord>): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite')
    tx.objectStore(DB_STORE).put(map, DB_RECORD)
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not save to the key store.'))
  })
}

let migration: Promise<void> | null = null

/**
 * Moves keys saved by older versions out of chrome.storage.local. The old entry is removed only after the keys are
 * safely in IndexedDB; a key saved there already is newer and wins.
 */
export function migrateLegacyKeys(): Promise<void> {
  migration ??= (async () => {
    const legacy: unknown = (await chrome.storage.local.get(LEGACY_STORAGE_KEY))[LEGACY_STORAGE_KEY]
    if (legacy === undefined) return
    const moved = sanitize(legacy)
    if (Object.keys(moved).length) await dbPut({ ...moved, ...sanitize(await dbGet()) })
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY)
    notifyChanged()
  })().catch((e: unknown) => {
    migration = null
    throw e
  })
  return migration
}

async function readAll(): Promise<Record<string, KeyRecord>> {
  await migrateLegacyKeys()
  return sanitize(await dbGet())
}

let writes: Promise<unknown> = Promise.resolve()

/** Read-modify-write steps run one at a time, so two quick saves cannot drop each other's key. */
function mutate(change: (map: Record<string, KeyRecord>) => boolean): Promise<void> {
  const run = writes.then(async () => {
    const map = await readAll()
    if (!change(map)) return
    await dbPut(map)
    notifyChanged()
  })
  writes = run.catch(() => undefined)
  return run
}

const changeListeners = new Set<() => void>()

/** Called after keys are saved or removed (keys no longer pass through chrome.storage.onChanged). */
export function onKeysChanged(listener: () => void): void {
  changeListeners.add(listener)
}

function notifyChanged(): void {
  for (const listener of changeListeners) listener()
}

export async function getKey(providerId: string): Promise<KeyRecord | null> {
  if (!PROVIDER_ID.test(providerId)) return null
  return (await readAll())[providerId] ?? null
}

export async function saveKey(providerId: string, key: string, baseUrl: string): Promise<void> {
  if (!PROVIDER_ID.test(providerId)) throw new Error('Unknown provider.')
  const trimmed = key.trim()
  if (!trimmed) throw new Error('The key is empty.')
  if (!KEY_CHARS.test(trimmed)) throw new Error('The key contains spaces or unusual characters. Copy it again.')
  if (trimmed.length > 512) throw new Error('That does not look like an API key (too long).')
  const normalized = normalizeBaseUrl(baseUrl)
  await mutate((map) => {
    map[providerId] = {
      providerId,
      origin: new URL(normalized).origin,
      baseUrl: normalized,
      key: trimmed,
      savedAt: Date.now(),
    }
    return true
  })
}

export async function removeKey(providerId: string): Promise<void> {
  await mutate((map) => {
    if (!(providerId in map)) return false
    delete map[providerId]
    return true
  })
}

export async function keySummaries(): Promise<Record<string, { last4: string; origin: string }>> {
  const out: Record<string, { last4: string; origin: string }> = {}
  for (const [id, rec] of Object.entries(await readAll())) {
    out[id] = { last4: rec.key.slice(-4), origin: rec.origin }
  }
  return out
}
