// Whether the assistant can think right now, computed without any network call.

import type { FullConfig } from '../../shared/config'
import type { BackgroundToContent } from '../../shared/messages'
import { loadSettings, type UserSettings } from '../../shared/settings'
import { resolveProvider } from '../llm/registry'
import { LlmError } from '../llm/types'

type StatusMessage = Extract<BackgroundToContent, { type: 'status' }>

/** The model to use: the user's choice, else the provider's first recommended model. */
export function pickModel(settings: UserSettings, config: FullConfig): string | null {
  if (settings.model.trim()) return settings.model.trim()
  const provider = config.providers.find((p) => p.id === settings.providerId)
  return provider?.recommendedModels?.[0] ?? null
}

export const NO_MODEL_MESSAGE = 'Pick a model in settings first.'

export async function computeStatus(config: FullConfig): Promise<StatusMessage> {
  if (config.flags.disabled) {
    return { type: 'status', llmReady: false, reason: config.flags.disabledMessage ?? 'The assistant is switched off for now.' }
  }
  const settings = await loadSettings()
  try {
    await resolveProvider(settings.providerId, config)
  } catch (e) {
    const reason = e instanceof LlmError ? e.message : config.mascot.lines.noKey ?? 'Add an AI key in settings.'
    return { type: 'status', llmReady: false, reason }
  }
  if (!pickModel(settings, config)) return { type: 'status', llmReady: false, reason: NO_MODEL_MESSAGE }
  return { type: 'status', llmReady: true }
}
