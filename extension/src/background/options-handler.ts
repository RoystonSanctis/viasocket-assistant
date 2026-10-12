// Requests from the options page. Replies never contain a key: only whether one exists and its last 4 characters.

import type { FullConfig, ProviderConfig } from '../shared/config'
import type { KeyTestResult, OptionsRequest, OptionsResponse, OptionsState, ProviderView } from '../shared/messages'
import { getConfig, refreshConfig } from './config-loader'
import { getKey, keySummaries, removeKey, saveKey } from './keys'
import { clearModelCache, listModelsFor } from './llm/models'
import { BUILT_IN_BASE_URLS, providerBaseUrl, resolveProvider } from './llm/registry'
import { testProvider } from './llm/test-provider'
import { LlmError, type ModelInfo } from './llm/types'
import { warmupStt } from './voice'

const PROVIDER_ID = /^[a-z0-9-]{1,64}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const MAX_KEY_CHARS = 600
const MAX_URL_CHARS = 500

type KeySummaries = Awaited<ReturnType<typeof keySummaries>>

export async function handleOptionsRequest(msg: OptionsRequest): Promise<OptionsResponse> {
  try {
    return { ok: true, data: await dispatch(msg) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function dispatch(msg: OptionsRequest): Promise<unknown> {
  switch (msg.type) {
    case 'options:get-state':
      return getState()
    case 'options:save-key':
      return saveProviderKey(msg.providerId, msg.key, msg.baseUrl)
    case 'options:remove-key': {
      const id = checkProviderId(msg.providerId)
      await removeKey(id)
      clearModelCache(id)
      return null
    }
    case 'options:test-key':
      return testKey(msg.providerId)
    case 'options:list-models':
      return listModels(msg.providerId)
    case 'options:refresh-config': {
      const config = await refreshConfig({ force: true })
      return { configVersion: config.configVersion, configSource: config.source }
    }
    case 'options:stt-warmup':
      await warmupStt()
      return null
    default: {
      const unknown: never = msg
      throw new Error(`Unknown request ${(unknown as { type?: string }).type ?? ''}`)
    }
  }
}

function checkProviderId(id: unknown): string {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw new Error('Unknown provider.')
  return id
}

function findProvider(config: FullConfig, id: unknown): ProviderConfig {
  const p = config.providers.find((x) => x.id === checkProviderId(id))
  if (!p || p.enabled === false) throw new Error('That provider is not available in this version of the config.')
  return p
}

function isBuiltIn(id: string): boolean {
  return Object.hasOwn(BUILT_IN_BASE_URLS, id)
}

function permissionPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`
}

async function hasHostPermission(baseUrl: string | null): Promise<boolean> {
  if (!baseUrl) return false
  try {
    return await chrome.permissions.contains({ origins: [permissionPattern(baseUrl)] })
  } catch {
    return false
  }
}

async function providerView(p: ProviderConfig, summaries: KeySummaries): Promise<ProviderView> {
  const summary = summaries[p.id]
  // A custom provider without a configured address is bound to whatever address its key was saved with.
  const configured = providerBaseUrl(p)
  const baseUrl = configured ?? (summary ? (await getKey(p.id))?.baseUrl ?? null : null)
  const noKey = p.noKey === true
  return {
    id: p.id,
    name: p.name,
    adapter: p.adapter,
    baseUrl,
    builtIn: isBuiltIn(p.id),
    noKey,
    badges: p.badges ?? [],
    setupTip: p.setupTip,
    keyPageUrl: p.keyPageUrl,
    keyPattern: p.keyPattern,
    recommendedModels: p.recommendedModels ?? [],
    hasKey: noKey || !!summary,
    keyLast4: noKey ? undefined : summary?.last4,
    hasPermission: await hasHostPermission(baseUrl),
  }
}

async function getState(): Promise<OptionsState> {
  const [config, summaries] = await Promise.all([getConfig(), keySummaries()])
  const providers = await Promise.all(config.providers.filter((p) => p.enabled !== false).map((p) => providerView(p, summaries)))
  return {
    configVersion: config.configVersion,
    configSource: config.source,
    providers,
    sttModels: config.voice.stt.models.map((m) => ({
      id: m.id,
      label: m.label,
      approxSizeMb: m.approxSizeMb,
      multilingual: m.multilingual,
      note: m.note,
    })),
    defaultSttModel: config.voice.stt.defaultModel,
  }
}

/** https anywhere; plain http only on this computer. */
function checkBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The provider address is not a valid URL.')
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    throw new Error('The provider address must start with https:// (plain http is only allowed for localhost).')
  }
  return url
}

function keyMatchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern).test(key)
  } catch {
    // A broken pattern in the config must not block saving.
    return true
  }
}

function patternHint(p: ProviderConfig, pattern: string): string {
  const prefix = /^\^([A-Za-z0-9_-]+)/.exec(pattern)?.[1]
  return prefix ? `${p.name} keys start with "${prefix}".` : `Expected format: ${pattern}`
}

async function saveProviderKey(providerId: unknown, rawKey: unknown, rawBaseUrl: unknown): Promise<ProviderView> {
  const config = await getConfig()
  const p = findProvider(config, providerId)
  if (p.noKey) throw new Error(`${p.name} runs on your computer and does not need a key.`)

  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!key) throw new Error('Paste your API key first.')
  if (key.length > MAX_KEY_CHARS) throw new Error('That does not look like an API key (too long).')
  if (p.keyPattern && !keyMatchesPattern(p.keyPattern, key)) {
    throw new Error(`That doesn't look like a ${p.name} key. ${patternHint(p, p.keyPattern)}`)
  }

  // Built-in addresses are compiled in. A configured address wins over a typed one, because the provider
  // registry only uses a key with the exact address it resolves for that provider.
  const typed = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim().slice(0, MAX_URL_CHARS) : ''
  const base = isBuiltIn(p.id) ? BUILT_IN_BASE_URLS[p.id] : providerBaseUrl(p) ?? (typed || null)
  if (!base) throw new Error(`Enter the API address (base URL) for ${p.name}.`)
  const url = checkBaseUrl(base)

  // The options page asks for the host permission (a user gesture) before sending this request.
  if (!(await hasHostPermission(url.href))) {
    throw new Error(`Allow the extension to reach ${url.origin} first, then save the key again.`)
  }
  await saveKey(p.id, key, base)
  clearModelCache(p.id)
  return providerView(p, await keySummaries())
}

async function testKey(providerId: unknown): Promise<KeyTestResult> {
  const config = await getConfig()
  const p = findProvider(config, providerId)
  try {
    const resolved = await resolveProvider(p.id, config)
    return await testProvider(resolved, p.validatePath)
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, message: e.message }
    throw e
  }
}

async function listModels(providerId: unknown): Promise<ModelInfo[]> {
  const config = await getConfig()
  const p = findProvider(config, providerId)
  const resolved = await resolveProvider(p.id, config)
  const models = await listModelsFor(resolved, p)
  return models.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength, supportsTools: m.supportsTools, free: m.free }))
}
