// Content-script controller. Runs in the isolated world on viaSocket app pages (top frame only) and wires
// the mascot UI to the service worker port, the MAIN-world hook, the route watcher, the hotkey and browser STT.
// It holds no secrets: the LLM key and the viaSocket token stay in the service worker.

import { resolveEnv } from '../background/tools/env'
import type { ClientConfig } from '../shared/config'
import type { ChatLine } from '../shared/mascot'
import type { BackgroundToContent, VoiceState } from '../shared/messages'
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY, type UserSettings } from '../shared/settings'
import { createBrowserStt, browserSttSupported } from './browser-stt'
import { isVoiceExit, parseConfirmIntent } from '../shared/voice-intent'
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

  type VoiceSource = 'wake-word' | 'manual' | 'hotkey'
  let activeVoiceSource: VoiceSource = 'manual'
  let initialSilenceTimer: ReturnType<typeof setTimeout> | undefined
  let speechSilenceTimer: ReturnType<typeof setTimeout> | undefined
  let heardSpeechInTurn = false
  let wakeWord: WakeWordListener | null = null

  let continuousVoice = false
  let pendingConfirmId: string | null = null
  let pendingConfirmLabel: string | undefined = undefined
  let ttsSpeaking = false
  let isBusy = false
  let autoListenTimer: ReturnType<typeof setTimeout> | undefined

  function clearSilenceTimers(): void {
    if (initialSilenceTimer) {
      clearTimeout(initialSilenceTimer)
      initialSilenceTimer = undefined
    }
    if (speechSilenceTimer) {
      clearTimeout(speechSilenceTimer)
      speechSilenceTimer = undefined
    }
    heardSpeechInTurn = false
  }

  function scheduleAutoListen(delayMs = 350): void {
    if (autoListenTimer) {
      clearTimeout(autoListenTimer)
      autoListenTimer = undefined
    }
    if (!continuousVoice || talking || ttsSpeaking || dead) return
    if (isBusy && !pendingConfirmId) return
    if (!mascot.isPanelOpen()) return
    autoListenTimer = setTimeout(() => {
      autoListenTimer = undefined
      if (!continuousVoice || talking || ttsSpeaking || dead) return
      if (isBusy && !pendingConfirmId) return
      if (!mascot.isPanelOpen()) return
      voiceStart('wake-word')
    }, delayMs)
  }

  function startInitialSilenceTimer(): void {
    initialSilenceTimer = setTimeout(() => {
      if (talking && activeVoiceSource === 'wake-word' && !heardSpeechInTurn) {
        continuousVoice = false
        voiceCancel()
      }
    }, 7500)
  }

  function onSpeechActivity(): void {
    if (activeVoiceSource !== 'wake-word' || !talking) return
    heardSpeechInTurn = true
    if (initialSilenceTimer) {
      clearTimeout(initialSilenceTimer)
      initialSilenceTimer = undefined
    }
    if (speechSilenceTimer) {
      clearTimeout(speechSilenceTimer)
      speechSilenceTimer = undefined
    }
    const delaySec = Math.max(1.5, settings.wakeWordSilenceDelay ?? 3)
    speechSilenceTimer = setTimeout(() => {
      if (talking && activeVoiceSource === 'wake-word' && heardSpeechInTurn) {
        voiceStop()
      }
    }, delaySec * 1000)
  }

  const stt = createBrowserStt({
    language: () => settings.sttLanguage,
    onState(state, detail) {
      if (state !== 'listening') {
        talking = false
        clearSilenceTimers()
        if (!continuousVoice && !ttsSpeaking) wakeWord?.resume()
      }
      const note = state === 'listening' && activeVoiceSource === 'wake-word' ? '(auto-sends on pause)' : detail
      if (!dead) mascot.setVoiceState(state, note)
    },
    onTranscript: (text, final) => {
      if (!dead) mascot.setTranscript(text, final)
      if (text.trim().length > 0) {
        onSpeechActivity()
      }
    },
    onFinal: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return

      if (isVoiceExit(trimmed)) {
        continuousVoice = false
        if (pendingConfirmId) {
          const id = pendingConfirmId
          pendingConfirmId = null
          pendingConfirmLabel = undefined
          mascot.dismissConfirm(id)
          port.send({ type: 'confirm-response', id, approved: false })
        }
        voiceCancel()
        mascot.addChat(systemNote('Voice session ended.'))
        return
      }

      if (pendingConfirmId) {
        const intent = parseConfirmIntent(trimmed, pendingConfirmLabel)
        if (intent !== null) {
          const id = pendingConfirmId
          pendingConfirmId = null
          pendingConfirmLabel = undefined
          mascot.dismissConfirm(id)
          mascot.addChat({ id: `local-voice-${Date.now()}`, role: 'user', text: trimmed, at: Date.now() })
          port.send({ type: 'confirm-response', id, approved: intent })
          return
        }
      }

      port.send({ type: 'user-input', text: trimmed.slice(0, MAX_USER_TEXT), source: 'voice' })
    },
  })

  function voiceStart(source: VoiceSource = 'manual'): void {
    if (!settings.voiceEnabled || talking || dead) return
    if (autoListenTimer) {
      clearTimeout(autoListenTimer)
      autoListenTimer = undefined
    }
    if (source === 'wake-word' || source === 'manual') {
      continuousVoice = true
    }
    activeVoiceSource = source
    clearSilenceTimers()
    talking = true
    workerListened = false
    usingFallbackStt = false
    wakeWord?.pause()
    if (settings.sttEngine === 'browser') {
      stt.start()
    } else {
      port.send({ type: 'voice', action: 'start' })
    }
    if (source === 'wake-word') {
      startInitialSilenceTimer()
    }
  }

  function voiceStop(): void {
    clearSilenceTimers()
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
      clearSilenceTimers()
      if (!continuousVoice && !ttsSpeaking) wakeWord?.resume()
    }
  }

  function voiceCancel(): void {
    clearSilenceTimers()
    if (autoListenTimer) {
      clearTimeout(autoListenTimer)
      autoListenTimer = undefined
    }
    if (!talking) return
    talking = false
    if (!continuousVoice && !ttsSpeaking) wakeWord?.resume()
    if (settings.sttEngine === 'browser' || usingFallbackStt) {
      stt.cancel()
    } else {
      port.send({ type: 'voice', action: 'cancel' })
    }
  }

  /** The browser keyboard command (chrome.commands) arrives via the worker; push-to-talk state lives here. */
  function voiceCommand(action: 'start' | 'stop' | 'toggle'): void {
    if (!active() || !settings.voiceEnabled) return
    if (action === 'start' || (action === 'toggle' && !talking)) voiceStart('hotkey')
    else voiceStop()
  }

  // ---------- mascot ----------

  const callbacks: MascotCallbacks = {
    onUserText(text) {
      continuousVoice = false
      if (autoListenTimer) {
        clearTimeout(autoListenTimer)
        autoListenTimer = undefined
      }
      const t = text.trim()
      if (t) port.send({ type: 'user-input', text: t.slice(0, MAX_USER_TEXT), source: 'text' })
    },
    onMicDown: () => voiceStart('manual'),
    onMicUp: voiceStop,
    onConfirm: (id, approved) => {
      if (pendingConfirmId === id) {
        pendingConfirmId = null
        pendingConfirmLabel = undefined
      }
      port.send({ type: 'confirm-response', id, approved })
    },
    onSuggestion: (id, action) => port.send({ type: 'suggestion-response', id, action }),
    onCancel() {
      continuousVoice = false
      if (autoListenTimer) {
        clearTimeout(autoListenTimer)
        autoListenTimer = undefined
      }
      pendingConfirmId = null
      pendingConfirmLabel = undefined
      voiceCancel()
      port.send({ type: 'cancel' })
    },
    onOpenSettings: (section) => port.send(section ? { type: 'open-options', section } : { type: 'open-options' }),
    onClearThread: () => port.send({ type: 'clear-thread' }),
    onHighlightMissed: () => mascot.addChat(systemNote(CANT_SEE)),
    onPanelOpenChange: (open) => {
      if (!open) {
        continuousVoice = false
        if (autoListenTimer) {
          clearTimeout(autoListenTimer)
          autoListenTimer = undefined
        }
        pendingConfirmId = null
        pendingConfirmLabel = undefined
        voiceCancel()
      }
    },
  }
  const mascot: MascotController = createMascot(callbacks)
  mascot.setSettings(settings)

  // ---------- wake word ----------

  wakeWord = createWakeWordListener({
    enabled: () => active() && settings.voiceEnabled && settings.wakeWordEnabled,
    onWake(trailingText) {
      mascot.openPanel()
      continuousVoice = true
      if (trailingText) {
        const trimmed = trailingText.trim()
        if (isVoiceExit(trimmed)) {
          continuousVoice = false
          mascot.addChat(systemNote('Voice session ended.'))
          return
        }
        if (pendingConfirmId) {
          const intent = parseConfirmIntent(trimmed, pendingConfirmLabel)
          if (intent !== null) {
            const id = pendingConfirmId
            pendingConfirmId = null
            pendingConfirmLabel = undefined
            mascot.dismissConfirm(id)
            mascot.addChat({ id: `local-voice-${Date.now()}`, role: 'user', text: trimmed, at: Date.now() })
            port.send({ type: 'confirm-response', id, approved: intent })
            return
          }
        }
        port.send({ type: 'user-input', text: trimmed.slice(0, MAX_USER_TEXT), source: 'voice' })
        setTimeout(() => {
          if (!talking && !dead && !continuousVoice && !ttsSpeaking) wakeWord?.resume()
        }, 1200)
      } else {
        voiceStart('wake-word')
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
        pendingConfirmId = msg.request.id
        pendingConfirmLabel = msg.request.confirmLabel
        mascot.showConfirm(msg.request)
        if (!ttsSpeaking && continuousVoice) {
          scheduleAutoListen(350)
        }
        break
      case 'confirm-cancel':
        if (pendingConfirmId === msg.id) {
          pendingConfirmId = null
          pendingConfirmLabel = undefined
        }
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
        const note = msg.state === 'listening' && activeVoiceSource === 'wake-word' ? '(auto-sends on pause)' : msg.detail
        mascot.setVoiceState(msg.state, note, msg.progress)
        break
      case 'voice-level':
        mascot.setVoiceLevel(msg.level)
        if (msg.level > 0.08) {
          onSpeechActivity()
        }
        break
      case 'transcript':
        mascot.setTranscript(msg.text, msg.final)
        if (msg.text.trim().length > 0) {
          onSpeechActivity()
        }
        if (msg.final && isVoiceExit(msg.text)) {
          continuousVoice = false
          if (pendingConfirmId) {
            mascot.dismissConfirm(pendingConfirmId)
            pendingConfirmId = null
            pendingConfirmLabel = undefined
          }
          voiceCancel()
        }
        break
      case 'busy':
        isBusy = msg.busy
        mascot.setBusy(msg.busy)
        if (!isBusy && !ttsSpeaking && continuousVoice) {
          scheduleAutoListen(350)
        }
        break
      case 'tts-state':
        ttsSpeaking = msg.speaking
        if (!ttsSpeaking && continuousVoice && (!isBusy || pendingConfirmId)) {
          scheduleAutoListen(250)
        }
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
    onStart: () => voiceStart('hotkey'),
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
        mascot.setSettings(next)
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
    safe(() => {
      continuousVoice = false
      if (autoListenTimer) {
        clearTimeout(autoListenTimer)
        autoListenTimer = undefined
      }
    })
    safe(() => clearSilenceTimers())
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
