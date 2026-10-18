// Page-wide state: the user's settings and the worker's OptionsState. Sections subscribe and update in place.

import type { OptionsState, ProviderView } from '../shared/messages'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings'
import type { UserSettings } from '../shared/settings'
import { rpc } from './rpc'

export interface Store {
  settings: UserSettings
  state: OptionsState | null
}

export const store: Store = { settings: DEFAULT_SETTINGS, state: null }

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): void {
  listeners.add(fn)
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (e) {
      console.warn('[viaSocket Assistant] options render failed', e)
    }
  }
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  store.settings = await saveSettings(patch)
  emit()
  return store.settings
}

export async function reloadSettings(): Promise<void> {
  store.settings = await loadSettings()
  emit()
}

export async function refreshState(): Promise<OptionsState> {
  store.state = await rpc.getState()
  emit()
  return store.state
}

export function providerById(id: string): ProviderView | undefined {
  return store.state?.providers.find((p) => p.id === id)
}

export function activeProvider(): ProviderView | undefined {
  return providerById(store.settings.providerId)
}

/** True while focus is inside the element, so a background refresh never overwrites what the user is editing. */
export function isEditing(el: HTMLElement): boolean {
  return el === document.activeElement || el.contains(document.activeElement)
}
