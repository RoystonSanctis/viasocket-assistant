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

const SECTIONS = ['provider', 'model', 'voice', 'assistant', 'privacy', 'about'] as const
type SectionId = typeof SECTIONS[number]

const SUBSECTION_MAP: Record<string, SectionId> = {
  mic: 'voice',
  'site-mic': 'voice',
}

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

/** Updates active navigation tab and displays only the selected section */
function showSection(sectionId: SectionId, subId?: string): void {
  for (const id of SECTIONS) {
    const tab = document.getElementById(`tab-${id}`)
    const sec = document.getElementById(id)
    const isCurrent = id === sectionId
    if (tab) {
      tab.classList.toggle('active', isCurrent)
      tab.setAttribute('aria-selected', String(isCurrent))
      tab.tabIndex = isCurrent ? 0 : -1
    }
    if (sec) {
      sec.classList.toggle('active', isCurrent)
    }
  }

  if (subId) {
    const target = document.getElementById(subId)
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
      const focusable =
        subId === 'mic'
          ? byId('mic-allow', HTMLButtonElement)
          : (target.querySelector<HTMLElement>('h2[tabindex], h3, button, [tabindex]') ?? target)
      focusable.focus({ preventScroll: true })
      return
    }
  }

  const activeSec = document.getElementById(sectionId)
  if (activeSec) {
    window.scrollTo({ top: 0, behavior: 'auto' })
    const focusable = activeSec.querySelector<HTMLElement>('h2[tabindex]') ?? activeSec
    focusable.focus({ preventScroll: true })
  }
}

function navigateFromHash(): void {
  const hash = decodeURIComponent(location.hash.slice(1))
  let activeSectionId: SectionId = 'provider'
  let subTargetId: string | undefined

  if (SECTIONS.includes(hash as SectionId)) {
    activeSectionId = hash as SectionId
  } else if (hash in SUBSECTION_MAP && SUBSECTION_MAP[hash]) {
    activeSectionId = SUBSECTION_MAP[hash] as SectionId
    subTargetId = hash
  } else if (hash) {
    const el = document.getElementById(hash)
    const closestSection = el?.closest<HTMLElement>('.card-section')
    if (closestSection && SECTIONS.includes(closestSection.id as SectionId)) {
      activeSectionId = closestSection.id as SectionId
      subTargetId = hash
    }
  }

  showSection(activeSectionId, subTargetId)
}

function initNavigation(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav-item'))
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', (e) => {
      const targetHash = tab.getAttribute('href')
      if (location.hash === targetHash) {
        e.preventDefault()
        navigateFromHash()
      }
    })

    tab.addEventListener('keydown', (e) => {
      let nextIndex = -1
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        nextIndex = (index + 1) % tabs.length
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        nextIndex = (index - 1 + tabs.length) % tabs.length
      } else if (e.key === 'Home') {
        nextIndex = 0
      } else if (e.key === 'End') {
        nextIndex = tabs.length - 1
      }
      if (nextIndex >= 0) {
        const nextTab = tabs[nextIndex]
        if (nextTab) {
          e.preventDefault()
          nextTab.focus()
          nextTab.click()
        }
      }
    })
  })
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
    initNavigation()

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && SETTINGS_KEY in changes) void reloadSettings()
    })
    const refreshQuietly = () => void refreshState().catch(() => undefined)
    chrome.permissions.onAdded.addListener(refreshQuietly)
    chrome.permissions.onRemoved.addListener(refreshQuietly)
    loadRetry.addEventListener('click', () => void loadState())
    window.addEventListener('hashchange', navigateFromHash)

    await reloadSettings()
    await loadState()
    navigateFromHash()
  } catch (err) {
    console.warn('[viaSocket Assistant] options main initialization error:', err)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main())
} else {
  void main()
}
