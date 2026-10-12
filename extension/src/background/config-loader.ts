// Loads the declarative config: remote repo (per channel) -> last-known-good in storage -> copy bundled in dist/defaults.
// A remote config is only adopted when the manifest and EVERY file validate, so a half-published or broken
// commit in the config repo can never leave the extension with a mixed or invalid config.

import * as z from '../shared/zod'
import {
  configManifestSchema,
  flagsFileSchema,
  mascotFileSchema,
  providerSchema,
  providersFileSchema,
  selectorsFileSchema,
  toolsFileSchema,
  voiceFileSchema,
  type FullConfig,
} from '../shared/config'
import { CONFIG_BRANCH_PREFIX, CONFIG_REFRESH_MINUTES, CONFIG_REMOTE_BASE, EXT_VERSION } from '../shared/constants'
import { SETTINGS_KEY, loadSettings, type UserSettings } from '../shared/settings'

type Channel = UserSettings['configChannel']
type Manifest = z.infer<typeof configManifestSchema>

const FETCH_TIMEOUT_MS = 8000
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_JSON_BYTES = 512 * 1024
const CACHE_PREFIX = 'configCache:'
/**
 * raw.githubusercontent.com caches each file for about 5 minutes, so a download right after a release can mix new
 * and old files that each validate. After a download that changed the config, the ETag is not used until a full
 * download taken after this window confirms the same content.
 */
const CDN_SETTLE_MS = 6 * 60_000
const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._\/-]{0,200}$/

const cachedConfigSchema = z.object({
  configVersion: z.string().min(1),
  channel: z.string(),
  loadedAt: z.number(),
  providers: z.array(providerSchema),
  selectors: selectorsFileSchema,
  mascot: mascotFileSchema,
  flags: flagsFileSchema,
  tools: toolsFileSchema,
  voice: voiceFileSchema,
  prompts: z.object({ system: z.string(), flowBuilder: z.string(), devHub: z.string(), reactions: z.string() }),
})

const cacheEntrySchema = z.object({
  configVersion: z.string(),
  etag: z.string().optional(),
  minExtensionVersion: z.string(),
  checkedAt: z.number(),
  /** Set after a download that changed the config: re-download everything (no ETag) until it is confirmed */
  recheckAfter: z.number().optional(),
  config: cachedConfigSchema,
})
type CacheEntry = z.infer<typeof cacheEntrySchema>

let current: FullConfig | null = null
let channelMemo: Channel | null = null
// Bumped on every channel switch so results that were in flight for the old channel are not applied.
let generation = 0
let loading: { channel: Channel; promise: Promise<FullConfig> } | null = null
let bundledMemo: FullConfig | null = null
let lastAutoRefreshAt = 0
const inflight = new Map<Channel, Promise<FullConfig>>()
const listeners = new Set<(config: FullConfig) => void>()

// ---------- helpers ----------

function normalizeChannel(v: unknown): Channel {
  return v === 'beta' ? 'beta' : 'stable'
}

function parseSemver(v: string): number[] {
  return (v.split(/[-+]/)[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0)
}

/** -1 / 0 / 1 like a comparator. Pre-release and build suffixes are ignored. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

function describe(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ')
  }
  return e instanceof Error ? e.message : String(e)
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + stableStringify(val)).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

/** Identity of the config content, ignoring where and when it was loaded. */
function fingerprint(c: object): string {
  const { source: _source, loadedAt: _loadedAt, channel: _channel, ...content } = c as Record<string, unknown>
  return stableStringify(content)
}

function emit(config: FullConfig): void {
  for (const cb of listeners) {
    try {
      cb(config)
    } catch (e) {
      console.warn('[config] listener failed:', describe(e))
    }
  }
}

/** Makes `next` current and notifies listeners when its content differs from `prev`. */
function apply(next: FullConfig, prev: FullConfig | null): void {
  current = next
  if (prev && fingerprint(prev) !== fingerprint(next)) emit(next)
}

// ---------- fetching ----------

function safePath(path: string): string {
  const segments = path.split('/')
  if (!FILE_PATH.test(path) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe file path in manifest: ${path.slice(0, 80)}`)
  }
  return path
}

type FetchResult = { notModified: true } | { notModified: false; text: string; etag?: string }

async function fetchText(url: string, maxBytes: number, etag?: string): Promise<FetchResult> {
  const headers: Record<string, string> = {}
  if (etag) headers['If-None-Match'] = etag
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 304) return { notModified: true }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`larger than ${maxBytes} bytes`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > maxBytes) throw new Error(`larger than ${maxBytes} bytes`)
  return { notModified: false, text: new TextDecoder().decode(buf), etag: res.headers.get('etag') ?? undefined }
}

async function fetchFile(base: string, path: string, maxBytes: number): Promise<string> {
  try {
    const r = await fetchText(`${base}/${safePath(path)}`, maxBytes)
    if (r.notModified) throw new Error('unexpected 304')
    return r.text
  } catch (e) {
    throw new Error(`${path}: ${describe(e)}`)
  }
}

async function fetchJson<S extends z.ZodType>(base: string, path: string, schema: S): Promise<z.output<S>> {
  const text = await fetchFile(base, path, MAX_JSON_BYTES)
  try {
    return schema.parse(JSON.parse(text))
  } catch (e) {
    throw new Error(`${path}: ${describe(e)}`)
  }
}

type LoadResult = { notModified: true } | { notModified: false; config: FullConfig; manifest: Manifest; etag?: string }

async function loadFrom(base: string, source: 'remote' | 'bundled', channel: Channel, etag?: string): Promise<LoadResult> {
  const m = await fetchText(`${base}/manifest.json`, MAX_JSON_BYTES, etag)
  if (m.notModified) return m
  let manifest: Manifest
  try {
    manifest = configManifestSchema.parse(JSON.parse(m.text))
  } catch (e) {
    throw new Error(`manifest.json: ${describe(e)}`)
  }
  if (compareSemver(manifest.minExtensionVersion, EXT_VERSION) > 0) {
    const why = `config ${manifest.configVersion} needs extension ${manifest.minExtensionVersion}, this is ${EXT_VERSION}`
    // The bundled copy shipped with this very build, so it is still the best available fallback.
    if (source === 'remote') throw new Error(why)
    console.warn('[config] bundled', why)
  }

  const f = manifest.files
  const [providers, selectors, mascot, flags, tools, voice, system, flowBuilder, devHub, reactions] = await Promise.all([
    fetchJson(base, f.providers, providersFileSchema),
    fetchJson(base, f.selectors, selectorsFileSchema),
    fetchJson(base, f.mascot, mascotFileSchema),
    fetchJson(base, f.flags, flagsFileSchema),
    fetchJson(base, f.tools, toolsFileSchema),
    fetchJson(base, f.voice, voiceFileSchema),
    fetchFile(base, f.prompts.system, MAX_PROMPT_BYTES),
    fetchFile(base, f.prompts.flowBuilder, MAX_PROMPT_BYTES),
    fetchFile(base, f.prompts.devHub, MAX_PROMPT_BYTES),
    fetchFile(base, f.prompts.reactions, MAX_PROMPT_BYTES),
  ])

  const config: FullConfig = {
    configVersion: manifest.configVersion,
    source,
    channel,
    loadedAt: Date.now(),
    providers: providers.providers,
    selectors,
    mascot,
    flags,
    tools,
    voice,
    prompts: { system, flowBuilder, devHub, reactions },
  }
  return { notModified: false, config, manifest, etag: m.etag }
}

async function loadBundled(channel: Channel): Promise<FullConfig> {
  if (!bundledMemo) {
    const base = chrome.runtime.getURL('defaults/').replace(/\/+$/, '')
    try {
      const r = await loadFrom(base, 'bundled', channel)
      if (r.notModified) throw new Error('unexpected 304')
      bundledMemo = r.config
    } catch (e) {
      throw new Error(`The bundled config in defaults/ is missing or invalid (${describe(e)}). The extension build is broken.`)
    }
  }
  return { ...bundledMemo, channel, loadedAt: Date.now() }
}

/** Orders YYYY.MM.DD-N config versions; null when either is in another format (then the remote one wins as before). */
export function compareConfigVersion(a: string, b: string): number | null {
  const parse = (v: string) => /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d+)$/.exec(v)?.slice(1).map(Number)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/**
 * The copy built into this extension when a downloaded or cached config is older than it. A new build ships with
 * the config it was written for; until that config is published, the older one online must not undercut it.
 */
async function newerBundled(config: FullConfig, channel: Channel): Promise<FullConfig | null> {
  try {
    const bundled = await loadBundled(channel)
    const cmp = compareConfigVersion(config.configVersion, bundled.configVersion)
    return cmp !== null && cmp < 0 ? bundled : null
  } catch {
    return null
  }
}

// ---------- storage cache ----------

async function readCache(channel: Channel): Promise<CacheEntry | null> {
  const key = CACHE_PREFIX + channel
  try {
    const raw: unknown = (await chrome.storage.local.get(key))[key]
    if (!raw) return null
    // Re-validated on every read: an extension update may have tightened a schema since it was stored.
    const entry = cacheEntrySchema.parse(raw)
    if (compareSemver(entry.minExtensionVersion, EXT_VERSION) > 0) return null
    return entry
  } catch (e) {
    console.warn('[config] ignoring invalid cached config:', describe(e))
    return null
  }
}

async function writeCache(channel: Channel, entry: CacheEntry): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_PREFIX + channel]: entry })
  } catch (e) {
    console.warn('[config] could not store config cache:', describe(e))
  }
}

// ---------- public API ----------

async function activeChannel(): Promise<Channel> {
  if (!channelMemo) channelMemo = normalizeChannel((await loadSettings()).configChannel)
  return channelMemo
}

async function loadInitial(channel: Channel): Promise<FullConfig> {
  const gen = generation
  const entry = await readCache(channel)
  const cached: FullConfig | null = entry ? { ...entry.config, source: 'cache', channel } : null
  const config: FullConfig = cached ? ((await newerBundled(cached, channel)) ?? cached) : await loadBundled(channel)
  if (gen === generation && !current) current = config

  const stale = !entry || Date.now() - entry.checkedAt > CONFIG_REFRESH_MINUTES * 60_000
  if (CONFIG_REMOTE_BASE && stale && Date.now() - lastAutoRefreshAt > CONFIG_REFRESH_MINUTES * 60_000) {
    lastAutoRefreshAt = Date.now()
    refreshConfig().catch((e: unknown) => console.warn('[config]', describe(e)))
  }
  return config
}

/** Current config: memory -> last-known-good in storage -> bundled defaults. Never throws. */
export async function getConfig(): Promise<FullConfig> {
  const channel = await activeChannel()
  if (current && current.channel === channel) return current
  if (!loading || loading.channel !== channel) {
    const promise = loadInitial(channel).finally(() => {
      if (loading?.promise === promise) loading = null
    })
    loading = { channel, promise }
  }
  return loading.promise
}

async function doRefresh(channel: Channel, force: boolean): Promise<FullConfig> {
  let prev: FullConfig | null = null
  try {
    prev = await getConfig()
  } catch (e) {
    // Only a broken bundle gets here; a valid remote config can still rescue the session.
    console.warn('[config]', describe(e))
  }
  if (!CONFIG_REMOTE_BASE) return prev ?? getConfig()

  const gen = generation
  const entry = await readCache(channel)
  const useEtag = !force && entry?.recheckAfter === undefined
  try {
    const r = await loadFrom(`${CONFIG_REMOTE_BASE}/${CONFIG_BRANCH_PREFIX}${channel}`, 'remote', channel, useEtag ? entry?.etag : undefined)
    if (r.notModified) {
      if (entry) await writeCache(channel, { ...entry, checkedAt: Date.now() })
      return prev ?? getConfig()
    }
    const now = Date.now()
    const changed = !entry || fingerprint(entry.config) !== fingerprint(r.config)
    // Confirmed once an unchanged download happens after the window; a change (or an early download) keeps checking.
    const recheckAfter = changed ? now + CDN_SETTLE_MS : entry?.recheckAfter !== undefined && now < entry.recheckAfter ? entry.recheckAfter : undefined
    await writeCache(channel, {
      configVersion: r.config.configVersion,
      etag: r.etag,
      minExtensionVersion: r.manifest.minExtensionVersion,
      checkedAt: now,
      ...(recheckAfter !== undefined ? { recheckAfter } : {}),
      config: r.config,
    })
    // The channel changed while we were fetching: the result is cached for its channel but not applied.
    if (gen !== generation || channel !== channelMemo) return getConfig()
    // Cached either way (ETag bookkeeping), but an online config older than this build's own is not used.
    const adopted = (await newerBundled(r.config, channel)) ?? r.config
    apply(adopted, prev)
    return adopted
  } catch (e) {
    console.warn(`[config] remote ${channel} config not adopted, keeping ${prev?.configVersion ?? 'none'}:`, describe(e))
    return prev ?? getConfig()
  }
}

/** Re-fetches the remote config (ETag-aware). Keeps the current config when the remote is invalid. */
export async function refreshConfig(opts?: { force?: boolean }): Promise<FullConfig> {
  const channel = await activeChannel()
  const force = opts?.force === true
  const running = inflight.get(channel)
  if (running && !force) return running
  const run = doRefresh(channel, force).finally(() => {
    if (inflight.get(channel) === run) inflight.delete(channel)
  })
  inflight.set(channel, run)
  return run
}

export function onConfigChanged(cb: (config: FullConfig) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

async function switchChannel(channel: Channel): Promise<void> {
  generation++
  const prev = current
  channelMemo = channel
  current = null
  try {
    const next = await getConfig()
    if (prev && fingerprint(prev) !== fingerprint(next)) emit(next)
    await refreshConfig()
  } catch (e) {
    console.warn('[config]', describe(e))
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  const change = changes[SETTINGS_KEY]
  if (!change) return
  const next = normalizeChannel((change.newValue as Partial<UserSettings> | undefined)?.configChannel)
  if (next === channelMemo) return
  // Nothing has been loaded yet, so there is nothing to reload; the next getConfig() reads the new channel.
  if (channelMemo === null) {
    channelMemo = next
    return
  }
  void switchChannel(next)
})
