// Content-script controller. Runs in the isolated world on viaSocket app pages (top frame only) and wires
// the mascot UI to the service worker port, the MAIN-world hook, the route watcher, the hotkey and browser STT.
// It holds no secrets: the LLM key and the viaSocket token stay in the service worker.

import { resolveEnv } from '../background/tools/env'
import type { ClientConfig } from '../shared/config'
import type { ChatLine } from '../shared/mascot'
import type { BackgroundToContent, VoiceState } from '../shared/messages'
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY, type UserSettings } from '../shared/settings'
import { createBrowserStt, browserSttSupported } from './browser-stt'
import { initFlowMenu } from './flow-menu'
import { createHotkey } from './hotkey'
import { createMascot } from './mascot'
import type { MascotCallbacks, MascotController } from './mascot/api'
import { createPageBridge } from './page-bridge'
import { watchPage } from './page-watch'
import { connectPort } from './port'
import { initStepMenu } from './step-menu'
import { destroyToasts } from './toast'
import { createWakeWordListener, type WakeWordListener } from './wake-word'

const RUN_MARK = '__vsAssistantContentRunning'
const DEFAULT_HOLD_MS = 180
const MAX_USER_TEXT = 4000
const CANT_SEE = "I can't see that element on the page right now. It may be hidden or the panel may be closed."
const NAV_BUSY = 'The page was still busy with a save, test or publish when I opened the new page. If something looks wrong, reload the page.'

type StorageListener = Parameters<typeof chrome.storage.onChanged.addListener>[0]

function systemNote(text: string): ChatLine {
  return { id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'system-note', text, at: Date.now() }
}

async function main(): Promise<void> {
  if (window.top !== window) return
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return
  const env = resolveEnv(location.host)
  if (!env) return
  // Guards against a second injection of this script into the same tab.
  const g = globalThis as unknown as Record<string, unknown>
  if (g[RUN_MARK]) return
  g[RUN_MARK] = true

  let settings: UserSettings = await loadSettings().catch(() => DEFAULT_SETTINGS)
  let config: ClientConfig | null = null
  let talking = false
  let usingFallbackStt = false
  /** The worker reported 'listening' during the current hold (Whisper engine only) */
  let workerListened = false
  let dead = false

  /** The config can switch the mascot off on an app host; it can never add hosts beyond the compiled env table. */
  const hostAllowed = (): boolean => {
    const hosts = config?.selectors.appHosts ?? []
    return hosts.length === 0 || hosts.includes(location.host)
  }
  const active = (): boolean => settings.mascotEnabled && hostAllowed() && !dead

  // ---------- voice ----------

  let wakeWord: WakeWordListener | null = null

  const stt = createBrowserStt({
    language: () => settings.sttLanguage,
    onState(state, detail) {
      if (state !== 'listening') {
        talking = false
        wakeWord?.resume()
      }
      if (!dead) mascot.setVoiceState(state, detail)
    },
    onTranscript: (text, final) => {
      if (!dead) mascot.setTranscript(text, final)
    },
    onFinal: (text) => port.send({ type: 'user-input', text: text.slice(0, MAX_USER_TEXT), source: 'voice' }),
  })

  function voiceStart(): void {
    if (!settings.voiceEnabled || talking || dead) return
    talking = true
    workerListened = false
    usingFallbackStt = false
    wakeWord?.pause()
    if (settings.sttEngine === 'browser') {
      stt.start()
    } else {
      port.send({ type: 'voice', action: 'start' })
    }
  }

  function voiceStop(): void {
    if (!talking) return
    talking = false
    if (settings.sttEngine === 'browser' || usingFallbackStt) {
      stt.stop()
    } else {
      port.send({ type: 'voice', action: 'stop' })
    }
  }

  /**
   * The worker owns Whisper's state and may stop on its own (silence, max length, errors). Mirror that so the
   * next hold starts a new recording instead of being swallowed as a duplicate start.
   */
  function syncTalking(state: VoiceState): void {
    if (state === 'listening') workerListened = true
    const stopped = state === 'transcribing' || state === 'error' || state === 'needs-permission' || state === 'off'
    if (stopped || (state === 'ready' && workerListened)) {
      talking = false
      wakeWord?.resume()
    }
  }

  function voiceCancel(): void {
    if (!talking) return
    talking = false
    wakeWord?.resume()
    if (settings.sttEngine === 'browser' || usingFallbackStt) {
      stt.cancel()
    } else {
      port.send({ type: 'voice', action: 'cancel' })
    }
  }

  /** The browser keyboard command (chrome.commands) arrives via the worker; push-to-talk state lives here. */
  function voiceCommand(action: 'start' | 'stop' | 'toggle'): void {
    if (!active() || !settings.voiceEnabled) return
    if (action === 'start' || (action === 'toggle' && !talking)) voiceStart()
    else voiceStop()
  }

  // ---------- mascot ----------

  const callbacks: MascotCallbacks = {
    onUserText(text) {
      const t = text.trim()
      if (t) port.send({ type: 'user-input', text: t.slice(0, MAX_USER_TEXT), source: 'text' })
    },
    onMicDown: voiceStart,
    onMicUp: voiceStop,
    onConfirm: (id, approved) => port.send({ type: 'confirm-response', id, approved }),
    onSuggestion: (id, action) => port.send({ type: 'suggestion-response', id, action }),
    onCancel() {
      voiceCancel()
      port.send({ type: 'cancel' })
    },
    onOpenSettings: (section) => port.send(section ? { type: 'open-options', section } : { type: 'open-options' }),
    onClearThread: () => port.send({ type: 'clear-thread' }),
    onHighlightMissed: () => mascot.addChat(systemNote(CANT_SEE)),
  }
  const mascot: MascotController = createMascot(callbacks)

  // ---------- wake word ----------

  wakeWord = createWakeWordListener({
    enabled: () => active() && settings.voiceEnabled && settings.wakeWordEnabled,
    onWake(trailingText) {
      mascot.openPanel()
      if (trailingText) {
        port.send({ type: 'user-input', text: trailingText.slice(0, MAX_USER_TEXT), source: 'voice' })
        setTimeout(() => {
          if (!talking && !dead) wakeWord?.resume()
        }, 1200)
      } else {
        voiceStart()
      }
    },
  })

  // ---------- route ----------

  const pageWatch = watchPage((page) => {
    mascot.setPage(page)
    port.send({ type: 'page-changed', page })
  })
  mascot.setPage(pageWatch.current())
  function applyEnabled(): void {
    mascot.setSttEngine(settings.sttEngine)
    mascot.setVoiceEnabled(settings.voiceEnabled)
    mascot.setEnabled(settings.mascotEnabled && hostAllowed())
    if (!active() || !settings.voiceEnabled) {
      voiceCancel()
      wakeWord?.stop()
    } else if (settings.wakeWordEnabled) {
      wakeWord?.start()
    } else {
      wakeWord?.stop()
    }
  }
  applyEnabled()

  // ---------- service worker ----------

  function handle(msg: BackgroundToContent): void {
    switch (msg.type) {
      case 'config':
        config = msg.config
        mascot.setConfig(msg.config)
        applyEnabled()
        break
      case 'mascot':
        mascot.setMode(msg.mode, msg.text)
        break
      case 'thinking-text':
        mascot.setThinking(msg.text)
        break
      case 'chat':
        mascot.addChat(msg.line)
        break
      case 'history':
        mascot.setHistory(msg.lines)
        break
      case 'plan':
        mascot.setPlan(msg.plan)
        break
      case 'suggestion':
        mascot.showSuggestion(msg.suggestion)
        break
      case 'suggestions-clear':
        mascot.dismissSuggestions(msg.ids)
        break
      case 'highlight':
        // A target that doesn't show up within a few seconds is reported through onHighlightMissed.
        if (!mascot.highlight(msg.target, msg.note)) mascot.addChat(systemNote(CANT_SEE))
        break
      case 'clear-highlight':
        mascot.clearHighlight()
        break
      case 'navigate':
        if (!bridge.navigate(msg.url, msg.replace === true)) {
          const hint = bridge.ready ? '' : ' Reload the page and ask me again.'
          mascot.addChat(systemNote(`I couldn't open that page from here.${hint}`))
        }
        break
      case 'reload-page':
        location.reload()
        break
      case 'confirm-request':
        mascot.showConfirm(msg.request)
        break
      case 'confirm-cancel':
        mascot.dismissConfirm(msg.id)
        break
      case 'voice-command':
        voiceCommand(msg.action)
        break
      case 'voice-state':
        if (settings.sttEngine !== 'browser') {
          const wasTalking = talking
          syncTalking(msg.state)
          if ((msg.state === 'needs-permission' || msg.state === 'error') && browserSttSupported() && wasTalking) {
            console.warn('[voice] Whisper unavailable, falling back to browser speech recognition')
            usingFallbackStt = true
            talking = true
            stt.start()
            return
          }
        }
        mascot.setVoiceState(msg.state, msg.detail, msg.progress)
        break
      case 'voice-level':
        mascot.setVoiceLevel(msg.level)
        break
      case 'transcript':
        mascot.setTranscript(msg.text, msg.final)
        break
      case 'busy':
        mascot.setBusy(msg.busy)
        break
      case 'status':
        mascot.setStatus(msg.llmReady, msg.reason)
        break
      default: {
        const unknown: never = msg
        void unknown
      }
    }
  }

  // ---------- MAIN-world hook ----------

  const bridge = createPageBridge({
    apiHosts: [new URL(env.apiBase).host],
    onObserved: (event) => port.send({ type: 'observed', event }),
    onNavigated: () => pageWatch.poke(),
    onNavigateBusy: () => mascot.addChat(systemNote(NAV_BUSY)),
  })

  // ---------- hotkey ----------

  const hotkey = createHotkey({
    setting: () => settings.hotkey,
    holdMs: () => config?.voice.hotkey.holdMs ?? DEFAULT_HOLD_MS,
    enabled: () => active() && settings.voiceEnabled && settings.hotkeyEnabled,
    onStart: voiceStart,
    onStop: voiceStop,
    onCancel: voiceCancel,
  })

  // ---------- settings ----------

  const onStorage: StorageListener = (changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return
    loadSettings()
      .then((next) => {
        if (dead) return
        settings = next
        applyEnabled()
      })
      .catch(() => undefined)
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(onStorage)
  }

  // Connected last: connectPort() may report a dead context synchronously, and shutdown() needs everything above.
  const port = connectPort({
    currentPage: () => pageWatch.current(),
    onMessage(msg) {
      try {
        handle(msg)
      } catch (e) {
        console.warn('[viaSocket Assistant] could not handle', msg.type, e)
      }
    },
    onDead: shutdown,
  })

  // ---------- injected menus (step copy / paste, flow export / import) ----------

  // The step menu bumps the editor's ?timestamp after a paste, which must ride the MAIN-world history hook
  // (react-router only sees navigations made there).
  const stepMenu = initStepMenu({ navigate: (url, replace) => bridge.navigate(url, replace) })
  const flowMenu = initFlowMenu()

  // The extension was reloaded, updated or removed: this copy of the script is orphaned, so tidy up for good.
  // Each teardown runs even when another throws (an orphan's chrome.* calls throw "Extension context
  // invalidated") - bridge.destroy() in particular must always run, or the MAIN-world hook stays paired to
  // this dead script and the new one can never navigate.
  function shutdown(): void {
    if (dead) return
    dead = true
    const safe = (fn: () => void): void => {
      try {
        fn()
      } catch {
        // context already invalidated
      }
    }
    safe(() => {
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(onStorage)
      }
    })
    safe(() => stepMenu.destroy())
    safe(() => flowMenu.destroy())
    safe(() => destroyToasts())
    safe(() => wakeWord?.destroy())
    safe(() => stt.cancel())
    safe(() => hotkey.destroy())
    safe(() => bridge.destroy())
    safe(() => pageWatch.destroy())
    safe(() => mascot.setEnabled(false))
    safe(() => mascot.destroy())
  }
}

main().catch((e: unknown) => console.warn('[viaSocket Assistant] failed to start', e))
