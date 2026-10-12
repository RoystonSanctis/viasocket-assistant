// User settings kept in chrome.storage.local. The provider key lives in its own record (see background/keys.ts)
// and is never part of these settings, so settings can be freely read by any extension context.

export type Proactivity = 'quiet' | 'helpful' | 'proactive'

export interface HotkeySetting {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** Optional non-modifier key (KeyboardEvent.code). Empty = hold the modifiers alone. */
  code: string
}

export interface UserSettings {
  providerId: string
  model: string
  /** Extra models tried in order when the main one fails (OpenRouter sends these as `models`) */
  fallbackModels: string[]
  proactivity: Proactivity
  sttEngine: 'whisper-local' | 'browser'
  sttModel: string
  sttLanguage: string
  speakReplies: boolean
  hotkey: HotkeySetting
  configChannel: 'stable' | 'beta'
  /** Power users can replace the remote system prompt entirely */
  customSystemPrompt: string
  mascotEnabled: boolean
  /** Acknowledged the data-sharing notice for free/third-party models */
  privacyAcknowledged: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  providerId: 'openrouter',
  model: '',
  fallbackModels: [],
  proactivity: 'helpful',
  sttEngine: 'whisper-local',
  sttModel: '',
  sttLanguage: '',
  speakReplies: true,
  hotkey: { ctrl: true, alt: true, shift: false, meta: false, code: '' },
  configChannel: 'stable',
  customSystemPrompt: '',
  mascotEnabled: true,
  privacyAcknowledged: false,
}

export const SETTINGS_KEY = 'settings'

export async function loadSettings(): Promise<UserSettings> {
  const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<UserSettings> | undefined
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}), hotkey: { ...DEFAULT_SETTINGS.hotkey, ...(raw?.hotkey ?? {}) } }
}

export async function saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const next = { ...(await loadSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}
