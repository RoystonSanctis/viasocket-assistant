// Options page entry. Settings live in chrome.storage.local (shared/settings); keys, providers and models come
// from the service worker over 'options:*' messages.

import { REPO_URL } from '../shared/constants'
import { SETTINGS_KEY } from '../shared/settings'
import { initAssistant } from './assistant'
import { byId, errorMessage } from './dom'
import { initHotkey } from './hotkey'
import { initMic } from './mic'
import { initModel } from './model'
import { initPrivacy } from './privacy'
import { initProvider } from './provider'
import { refreshState, reloadSettings } from './store'
import { initVoice } from './voice'

const loadError = byId('load-error', HTMLDivElement)
const loadErrorText = byId('load-error-text', HTMLParagraphElement)
const loadRetry = byId('load-retry', HTMLButtonElement)

function initAbout(): void {
  byId('about-version', HTMLElement).textContent = chrome.runtime.getManifest().version
  byId('repo-link', HTMLAnchorElement).href = REPO_URL
  byId('issues-link', HTMLAnchorElement).href = `${REPO_URL}/issues`
  byId('license-link', HTMLAnchorElement).href = `${REPO_URL}/blob/main/LICENSE`
}

async function loadState(): Promise<void> {
  loadError.hidden = true
  try {
    await refreshState()
  } catch (e) {
    loadErrorText.textContent = `Couldn't load your providers and models. ${errorMessage(e)}`
    loadError.hidden = false
  }
}

/** Content is built after load, so the browser's own jump to #section happens too early; redo it once rendered. */
function focusHash(): void {
  const id = decodeURIComponent(location.hash.slice(1))
  const target = id ? document.getElementById(id) : null
  if (!target) return
  target.scrollIntoView({ block: 'start' })
  const focusable = id === 'mic' ? byId('mic-allow', HTMLButtonElement) : (target.querySelector<HTMLElement>('h2[tabindex]') ?? target)
  focusable.focus({ preventScroll: true })
}

async function main(): Promise<void> {
  try {
    initAbout()
    initPrivacy()
    initProvider()
    initModel()
    initVoice()
    initMic()
    initHotkey()
    initAssistant()

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && SETTINGS_KEY in changes) void reloadSettings()
    })
    const refreshQuietly = () => void refreshState().catch(() => undefined)
    chrome.permissions.onAdded.addListener(refreshQuietly)
    chrome.permissions.onRemoved.addListener(refreshQuietly)
    loadRetry.addEventListener('click', () => void loadState())
    window.addEventListener('hashchange', focusHash)

    await reloadSettings()
    await loadState()
    focusHash()
  } catch (err) {
    console.warn('[viaSocket Assistant] options main initialization error:', err)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main())
} else {
  void main()
}
