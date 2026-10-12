// Provider resolution. The config repo chooses which providers are offered, but the addresses of built-in
// providers are compiled in here, and a saved key is only ever used with the exact base URL it was saved for.

import { ALLOWED_EXTRA_HEADERS, type FullConfig, type ProviderConfig } from '../../shared/config'
import { getKey, normalizeBaseUrl } from '../keys'
import { anthropicAdapter } from './anthropic'
import { openaiAdapter } from './openai'
import { LlmError, type LlmAdapter, type ResolvedProvider } from './types'

/** Base URLs compiled into the extension. A config entry with the same id can never override these. */
export const BUILT_IN_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  xai: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
}

export function isBuiltInProvider(id: string): boolean {
  return Object.hasOwn(BUILT_IN_BASE_URLS, id)
}

export function providerBaseUrl(p: ProviderConfig): string | null {
  if (isBuiltInProvider(p.id)) return BUILT_IN_BASE_URLS[p.id] ?? null
  if (!p.baseUrl) return null
  try {
    // Normalized the same way saveKey stores it, so the equality check in resolveProvider is meaningful.
    return normalizeBaseUrl(p.baseUrl)
  } catch {
    return null
  }
}

const HEADER_VALUE = /^[\x20-\x7e]{1,256}$/

export function allowedExtraHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const canonical = ALLOWED_EXTRA_HEADERS.find((h) => h.toLowerCase() === name.toLowerCase())
    if (canonical && typeof value === 'string' && HEADER_VALUE.test(value)) out[canonical] = value
  }
  return out
}

/** Throws LlmError(kind 'auth') when there is no key, the key is bound to another origin, or permission is missing. */
export async function resolveProvider(providerId: string, config: FullConfig): Promise<ResolvedProvider> {
  const p = config.providers.find((x) => x.id === providerId)
  if (!p || p.enabled === false) {
    throw new LlmError(`The provider "${providerId}" is not available. Pick another one in settings.`, 0, 'auth')
  }

  const record = p.noKey ? null : await getKey(p.id)
  if (!p.noKey && !record) throw new LlmError(`No API key saved for ${p.name}. Add one in settings.`, 0, 'auth')

  // A provider without a configured address uses the one the user typed when saving the key.
  const base = providerBaseUrl(p) ?? record?.baseUrl ?? null
  if (!base) throw new LlmError(`${p.name} has no address configured. Set it up again in settings.`, 0, 'auth')
  const origin = new URL(base).origin

  if (record && (record.baseUrl !== base || record.origin !== origin)) {
    throw new LlmError(
      `The address for ${p.name} changed (now ${origin}). Your key is only sent to the address it was saved with, ` +
        'so re-save the key in settings to use the new address.',
      0,
      'auth',
    )
  }

  const granted = await chrome.permissions.contains({ origins: [origin + '/*'] })
  if (!granted) {
    throw new LlmError(`Permission to reach ${p.name} is missing. Re-save the key in settings.`, 0, 'auth')
  }

  const resolved: ResolvedProvider = {
    id: p.id,
    name: p.name,
    adapter: p.adapter,
    baseUrl: base,
    key: record?.key ?? '',
    extraHeaders: allowedExtraHeaders(p.extraHeaders),
  }
  if (p.modelsPath) resolved.modelsPath = p.modelsPath
  if (p.validatePath) resolved.validatePath = p.validatePath
  return resolved
}

export function adapterFor(kind: 'openai' | 'anthropic'): LlmAdapter {
  return kind === 'anthropic' ? anthropicAdapter : openaiAdapter
}
