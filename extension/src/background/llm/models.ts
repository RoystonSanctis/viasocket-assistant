// Model list for the settings picker: recommended first, then tool-capable, then free. Cached briefly because
// some providers (OpenRouter) return several hundred models.

import type { ProviderConfig } from '../../shared/config'
import { adapterFor } from './registry'
import type { ModelInfo, ResolvedProvider } from './types'

const TTL_MS = 10 * 60_000
// Endpoints listed next to chat models that cannot drive the agent (speech, images, embeddings, legacy completions).
const NON_CHAT = /(embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|-audio|image-gen|gpt-image)/i

interface Entry {
  at: number
  models: Promise<ModelInfo[]>
}

const cache = new Map<string, Entry>()

function cacheKey(p: ResolvedProvider): string {
  return `${p.id}|${p.baseUrl}`
}

export function clearModelCache(providerId?: string): void {
  if (!providerId) return cache.clear()
  for (const k of cache.keys()) if (k.startsWith(providerId + '|')) cache.delete(k)
}

function toolRank(m: ModelInfo): number {
  return m.supportsTools === true ? 0 : m.supportsTools === undefined ? 1 : 2
}

export function sortModels(models: ModelInfo[], recommended: string[]): ModelInfo[] {
  const recIndex = new Map(recommended.map((id, i) => [id, i]))
  const seen = new Set<string>()
  const unique = models.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return recIndex.has(m.id) || !NON_CHAT.test(m.id)
  })
  return unique.sort((a, b) => {
    const ra = recIndex.get(a.id) ?? Infinity
    const rb = recIndex.get(b.id) ?? Infinity
    if (ra !== rb) return ra - rb
    const ta = toolRank(a)
    const tb = toolRank(b)
    if (ta !== tb) return ta - tb
    if (!!a.free !== !!b.free) return a.free ? -1 : 1
    return (a.name ?? a.id).localeCompare(b.name ?? b.id)
  })
}

export async function listModelsFor(p: ResolvedProvider, providerCfg: ProviderConfig): Promise<ModelInfo[]> {
  const key = cacheKey(p)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models

  const models = adapterFor(p.adapter)
    .listModels(p)
    .then((list) => sortModels(list, providerCfg.recommendedModels ?? []))
  cache.set(key, { at: Date.now(), models })
  // Failures are not cached, so the next open of the picker retries.
  models.catch(() => {
    if (cache.get(key)?.models === models) cache.delete(key)
  })
  return models
}

/** Context window of `model` if the settings picker already listed it recently; never makes a request. */
export async function knownContextLength(p: ResolvedProvider, model: string): Promise<number | undefined> {
  const hit = cache.get(cacheKey(p))
  if (!hit || Date.now() - hit.at >= TTL_MS) return undefined
  try {
    return (await hit.models).find((m) => m.id === model)?.contextLength
  } catch {
    return undefined
  }
}
