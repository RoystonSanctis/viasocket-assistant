// Assistant section: proactivity, mascot visibility, custom system prompt and the remote config channel.

import type { OptionsState } from '../shared/messages'
import type { Proactivity } from '../shared/settings'
import { byId, checkedValue, errorMessage, radios, setChecked, setStatus } from './dom'
import { rpc } from './rpc'
import { refreshState, store, subscribe, updateSettings } from './store'

const PROACTIVITY: readonly Proactivity[] = ['quiet', 'helpful', 'proactive']
/** The worker uses at most this much of the custom prompt (MAX_CUSTOM_PROMPT_CHARS in background/agent/prompt.ts) */
const MAX_PROMPT_CHARS = 32 * 1024
const SOURCE_LABELS: Record<OptionsState['configSource'], string> = {
  remote: 'downloaded from GitHub',
  cache: 'saved copy',
  bundled: 'built into the extension',
}

const mascot = byId('mascot-enabled', HTMLInputElement)
const prompt = byId('custom-prompt', HTMLTextAreaElement)
const promptSave = byId('custom-prompt-save', HTMLButtonElement)
const promptClear = byId('custom-prompt-clear', HTMLButtonElement)
const promptStatus = byId('custom-prompt-status', HTMLParagraphElement)
const configInfo = byId('config-info', HTMLElement)
const refreshButton = byId('config-refresh', HTMLButtonElement)
const configStatus = byId('config-status', HTMLParagraphElement)

/** Unsaved edits in the prompt box; refreshes from storage must not wipe them */
let promptDirty = false

export function initAssistant(): void {
  subscribe(render)
  for (const r of radios('proactivity')) {
    r.addEventListener('change', () => {
      const value = PROACTIVITY.find((p) => p === checkedValue('proactivity'))
      if (r.checked && value) void updateSettings({ proactivity: value })
    })
  }
  mascot.addEventListener('change', () => void updateSettings({ mascotEnabled: mascot.checked }))
  prompt.addEventListener('input', () => {
    promptDirty = prompt.value !== store.settings.customSystemPrompt
    setStatus(promptStatus, promptDirty ? 'Unsaved changes.' : '', 'info')
  })
  promptSave.addEventListener('click', () => void savePrompt(prompt.value))
  promptClear.addEventListener('click', () => {
    prompt.value = ''
    void savePrompt('')
  })
  for (const r of radios('config-channel')) {
    r.addEventListener('change', () => {
      if (r.checked) void changeChannel(checkedValue('config-channel') === 'beta' ? 'beta' : 'stable')
    })
  }
  refreshButton.addEventListener('click', () => void checkForUpdates())
}

function describeConfig(state: OptionsState | null): string {
  return state ? `${state.configVersion} (${SOURCE_LABELS[state.configSource]})` : 'unknown'
}

function render(): void {
  const s = store.settings
  setChecked('proactivity', s.proactivity)
  mascot.checked = s.mascotEnabled
  if (!promptDirty) prompt.value = s.customSystemPrompt
  setChecked('config-channel', s.configChannel)
  configInfo.textContent = describeConfig(store.state)
}

async function savePrompt(value: string): Promise<void> {
  const text = value.trim() ? value.replace(/\s+$/, '') : ''
  if (text.length > MAX_PROMPT_CHARS) {
    setStatus(promptStatus, `The prompt is ${text.length.toLocaleString()} characters; the limit is ${MAX_PROMPT_CHARS.toLocaleString()}. Shorten it and save again.`, 'error')
    return
  }
  try {
    await updateSettings({ customSystemPrompt: text })
    promptDirty = false
    setStatus(
      promptStatus,
      text ? 'Saved. Your prompt now replaces the base persona prompt; page guidance still applies.' : 'Cleared. The built-in prompt is used again.',
      'ok',
    )
  } catch (e) {
    setStatus(promptStatus, errorMessage(e), 'error')
  }
}

async function changeChannel(channel: 'stable' | 'beta'): Promise<void> {
  try {
    await updateSettings({ configChannel: channel })
  } catch (e) {
    setStatus(configStatus, errorMessage(e), 'error')
    return
  }
  await checkForUpdates()
}

async function checkForUpdates(): Promise<void> {
  refreshButton.disabled = true
  setStatus(configStatus, 'Checking for config updates…', 'busy')
  try {
    await rpc.refreshConfig()
    const state = await refreshState()
    if (state.configSource === 'bundled') {
      setStatus(configStatus, "Couldn't reach the config on GitHub, so the copy built into the extension is in use.", 'warn')
    } else {
      setStatus(configStatus, `Up to date: ${describeConfig(state)}.`, 'ok')
    }
  } catch (e) {
    setStatus(configStatus, errorMessage(e), 'error')
  } finally {
    refreshButton.disabled = false
  }
}
