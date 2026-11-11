// Content-script controller. Runs in the isolated world on viaSocket app pages (top frame only) and wires
// the mascot UI to the service worker port, the MAIN-world hook, the route watcher, the hotkey and browser STT.
// It holds no secrets: the LLM key and the viaSocket token stay in the service worker.

import { resolveEnv } from '../background/tools/env'
import type { ClientConfig } from '../shared/config'
import type { ChatLine } from '../shared/mascot'
import type { BackgroundToContent, VoiceState } from '../shared/messages'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_KEY, type UserSettings } from '../shared/settings'
import { createBrowserStt, browserSttSupported, requestMicrophonePermission, isIframeMicBlocked, EMBED_MIC_BLOCKED_MSG } from './browser-stt'
import { isVoiceExit, parseConfirmIntent } from '../shared/voice-intent'
import { initFlowMenu } from './flow-menu'
import { createHotkey } from './hotkey'
import { createMascot } from './mascot'
import type { MascotCallbacks, MascotController } from './mascot/api'
import { createPageBridge, type PageBridge } from './page-bridge'
import { watchPage } from './page-watch'
import { watchDomStatus } from './dom-status'
import { connectPort } from './port'
import { initStepMenu } from './step-menu'
import { initSubfunctionsUI } from './subfunctions-ui'
import { initBeautify } from './beautify-ui'
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
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return
  const env = resolveEnv(location.host)
  if (!env) return
  // Allow running inside the embed iframe (env.embed), but bail out for any other nested frame
  // (oauth popups, step-test iframes, etc.) where the mascot would be misplaced or broken.
  if (window.top !== window && !env.embed) return
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
    if (env.embed) return true
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
  /** Chrome runs one speech recognizer at a time, so only the viaSocket tab the user is on listens for the wake word. */
  let voiceFront = false

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
    const delaySec = Math.max(0.5, settings.wakeWordSilenceDelay ?? 3)
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
    async onRequestMic() {
      if (isIframeMicBlocked()) {
        mascot.setVoiceState('needs-permission', EMBED_MIC_BLOCKED_MSG)
        return
      }
      const granted = await requestMicrophonePermission()
      if (granted) {
        mascot.setVoiceState('ready', 'Microphone enabled!')
        wakeWord?.start()
        voiceStart('manual')
      } else {
        mascot.setVoiceState('needs-permission', 'Microphone was not allowed in the browser prompt.')
      }
    },
    onSwitchEngine: (engine) => {
      void saveSettings({ sttEngine: engine })
    },
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
    enabled: () => voiceFront && active() && settings.voiceEnabled && settings.wakeWordEnabled,
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

  const domWatcher = watchDomStatus((status) => {
    port.send({ type: 'dom-status', status })
  })

  // ---------- MAIN-world hook ----------

  const bridge = createPageBridge({
    apiHosts: [new URL(env.apiBase).host],
    onObserved: (event) => port.send({ type: 'observed', event }),
    onNavigated: () => pageWatch.poke(),
    onNavigateBusy: () => mascot.addChat(systemNote(NAV_BUSY)),
  })

  function applyEnabled(): void {
    mascot.setSttEngine(settings.sttEngine)
    mascot.setVoiceEnabled(settings.voiceEnabled)
    mascot.setEnabled(settings.mascotEnabled && hostAllowed())
    if (!active() || !settings.voiceEnabled) {
      voiceCancel()
      wakeWord?.stop()
    } else if (settings.wakeWordEnabled && voiceFront) {
      wakeWord?.start()
    } else {
      wakeWord?.stop()
    }
  }
  applyEnabled()

  /** The tab became visible or focused: take the wake word over from the other viaSocket tabs. */
  function claimVoice(): void {
    if (voiceFront || dead || document.visibilityState !== 'visible') return
    voiceFront = true
    port.send({ type: 'voice-front' })
    applyEnabled()
  }

  /** The tab was hidden or another tab took over: stop listening and end a hands-free session. */
  function yieldVoice(): void {
    if (!voiceFront) return
    voiceFront = false
    continuousVoice = false
    voiceCancel()
    applyEnabled()
  }

  const onVisibility = (): void => (document.visibilityState === 'visible' ? claimVoice() : yieldVoice())
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', claimVoice)

  // ---------- service worker ----------

  function handle(msg: BackgroundToContent): void {
    switch (msg.type) {
      case 'get-dom-status':
        port.send({ type: 'dom-status-response', requestId: msg.requestId, status: domWatcher.getStatus() })
        break
      case 'fill-field': {
        const executeFill = async () => {
          // 1. Try pageBridge (Main-world hook with React fiber access)
          if (bridge.ready) {
            const hookRes = await bridge.setFieldValue(msg.fieldLabel, msg.value, msg.clickSave)
            if (hookRes.success) {
              port.send({ type: 'fill-field-response', requestId: msg.requestId, success: true })
              return
            }
          }

          // 2. DOM-level fallback in content script
          const slider = document.querySelector<HTMLElement>(
            '[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider'
          )
          if (!slider) {
            port.send({ type: 'fill-field-response', requestId: msg.requestId, success: false, error: 'Side panel is not open.' })
            return
          }

          const allFieldRows = Array.from(
            slider.querySelectorAll<HTMLElement>(
              '[data-testid^="plugin-field-"]:not([data-testid^="plugin-field-label-"]), .plugin-field-row, [data-testid="custom-field-box"]'
            )
          )
          const targetRow = allFieldRows.find((row) => {
            const lbl = (row.querySelector('[data-testid^="plugin-field-label-"], label')?.textContent || '')
              .replace(/[*:]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            const norm = msg.fieldLabel.replace(/[*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
            return lbl === norm || lbl.includes(norm) || norm.includes(lbl)
          })

          if (!targetRow) {
            port.send({
              type: 'fill-field-response',
              requestId: msg.requestId,
              success: false,
              error: `Field "${msg.fieldLabel}" was not found in the open panel.`,
            })
            return
          }

          const input = targetRow.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="hidden"])')
          if (!input) {
            port.send({
              type: 'fill-field-response',
              requestId: msg.requestId,
              success: false,
              error: `No editable input found for field "${msg.fieldLabel}".`,
            })
            return
          }

          const proto = Object.getPrototypeOf(input)
          const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (nativeSet) nativeSet.call(input, msg.value)
          else input.value = msg.value

          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
          input.dispatchEvent(new Event('blur', { bubbles: true, composed: true }))

          if (msg.clickSave) {
            setTimeout(() => {
              const saveBtn = Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
                /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
              )
              if (saveBtn && !saveBtn.disabled) saveBtn.click()
            }, 150)
          }

          port.send({ type: 'fill-field-response', requestId: msg.requestId, success: true })
        }
        executeFill().catch((err) => {
          port.send({ type: 'fill-field-response', requestId: msg.requestId, success: false, error: String(err) })
        })
        break
      }
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
      case 'refresh-step':
        bridge.refreshStep(msg.scriptId, msg.stepId, msg.slugName)
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
      case 'voice-yield':
        yieldVoice()
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

  // ---------- hotkey ----------

  const hotkey = createHotkey({
    setting: () => settings.hotkey,
    holdMs: () => config?.voice.hotkey.holdMs ?? DEFAULT_HOLD_MS,
    enabled: () => active() && settings.voiceEnabled && settings.hotkeyEnabled,
    onStart: () => voiceStart('hotkey'),
    onStop: voiceStop,
    onCancel: voiceCancel,
  })

  // ---------- spacebar toggle shortcut ----------

  const NON_TEXT_INPUTS = new Set([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
  ])

  function getDeepActiveElement(): Element | null {
    let el: Element | null = document.activeElement
    while (el?.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement
    }
    return el
  }

  function isEditingText(target: EventTarget | null): boolean {
    const deepActive = getDeepActiveElement()
    for (const el of [target instanceof Element ? target : null, deepActive]) {
      if (!el) continue
      if (el instanceof HTMLTextAreaElement) return true
      if (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)) return true
      if (el instanceof HTMLSelectElement) return true
      if (el instanceof HTMLElement && el.isContentEditable) return true
      if (
        el.closest?.(
          'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable="true"], .monaco-editor, .cm-editor, .ace_editor',
        )
      ) {
        return true
      }
    }
    return false
  }

  function isInteractiveElement(target: EventTarget | null): boolean {
    const deepActive = getDeepActiveElement()
    for (const el of [target instanceof Element ? target : null, deepActive]) {
      if (!el) continue
      if (el instanceof HTMLButtonElement) return true
      if (el instanceof HTMLAnchorElement && el.href) return true
      if (el.closest?.('button, a[href], [role="button"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="switch"]')) {
        return true
      }
    }
    return false
  }

  const onWindowKeyDown = (e: KeyboardEvent): void => {
    const shortcut = settings.chatToggleShortcut ?? 'shift-space'
    if (shortcut === 'off') return

    const isSpaceKey = e.code === 'Space' || e.key === ' '
    if (!isSpaceKey) return

    let matched = false
    if (shortcut === 'shift-space') {
      matched = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    } else if (shortcut === 'alt-space') {
      matched = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    } else if (shortcut === 'space') {
      matched = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
      if (matched && (isEditingText(e.target) || isInteractiveElement(e.target))) {
        return
      }
    }

    if (!matched) return
    if (e.repeat) return
    if (!active()) return

    e.preventDefault()
    e.stopPropagation()
    mascot.togglePanel()
  }

  window.addEventListener('keydown', onWindowKeyDown, true)

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
  claimVoice()

  // ---------- injected menus (step copy / paste, flow export / import) ----------

  // The step menu bumps the editor's ?timestamp after a paste, which must ride the MAIN-world history hook
  // (react-router only sees navigations made there).
  const stepMenu = initStepMenu({ navigate: (url, replace) => bridge.navigate(url, replace) })
  const flowMenu = initFlowMenu({ navigate: (url, replace) => bridge.navigate(url, replace) })
  const subfunctionsUI = initSubfunctionsUI(bridge)
  const beautify = initBeautify(bridge)

  const onRuntimeMessage = (
    raw: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (!raw || typeof raw !== 'object') return false
    const msg = raw as { target?: unknown; type?: unknown; mode?: unknown; cookieName?: unknown; apiBase?: unknown }

    if (msg.target === 'content' && msg.type === 'vs-proxy-fetch') {
      const fetchMsg = raw as {
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: unknown
      }
      if (!fetchMsg.url) {
        sendResponse({ ok: false, error: 'missing url' })
        return true
      }
      ;(async () => {
        try {
          const res = await fetch(fetchMsg.url!, {
            method: fetchMsg.method || 'GET',
            headers: fetchMsg.headers,
            body: fetchMsg.body !== undefined ? JSON.stringify(fetchMsg.body) : undefined,
            credentials: 'include',
          })
          const text = await res.text()
          let parsed: any
          try {
            parsed = text ? JSON.parse(text) : undefined
          } catch {
            parsed = text
          }
          sendResponse({ ok: res.ok, status: res.status, body: parsed })
        } catch (e) {
          sendResponse({ ok: false, error: String(e) })
        }
      })()
      return true
    }

    if (msg.target === 'content' && msg.type === 'get-auth-token') {
      ;(async () => {
        try {
          const clean = (v: string | null): string | null => {
            if (!v) return null
            let s = v.trim()
            if (!s) return null
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            if (s.includes('%')) {
              try { s = decodeURIComponent(s).trim() } catch {}
            }
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              s = s.slice(1, -1).trim()
            }
            return s.length > 0 ? s : null
          }
          const isJwt = (s: string | null): boolean =>
            Boolean(s && s.startsWith('ey') && s.includes('.') && s.length > 20)

          const splitEq = (s: string): [string, string] => {
            const idx = s.indexOf('=')
            if (idx === -1) return [s.trim(), '']
            return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()]
          }

          const isEmbedMode =
            msg.mode === 'embed' ||
            location.pathname.startsWith('/integrations/embed/') ||
            new URLSearchParams(location.search).get('mode') === 'embed'

          if (isEmbedMode) {
            // Embed mode: read sessionStorage.ssoEmbedToken (primary) or localStorage.proxy_auth_token
            const sso = clean(sessionStorage.getItem('ssoEmbedToken')) || clean(sessionStorage.getItem('proxy_auth_token'))
            if (sso) {
              sendResponse({ ok: true, token: sso })
              return
            }
            const local = clean(localStorage.getItem('proxy_auth_token')) || clean(localStorage.getItem('ssoEmbedToken'))
            if (local) {
              sendResponse({ ok: true, token: local })
              return
            }
          } else {
            // Flow mode:
            // 1. Primary: Fetch /auth/token endpoint from page origin with credentials include
            const apiBase = typeof msg.apiBase === 'string' && msg.apiBase ? msg.apiBase : 'https://flow-api.viasocket.com'
            try {
              const res = await fetch(`${apiBase}/auth/token`, { credentials: 'include' })
              if (res.ok) {
                const data = await res.json()
                const tok = clean(data?.data?.token)
                if (tok) {
                  sendResponse({ ok: true, token: tok })
                  return
                }
              }
            } catch {
              // ignore
            }

            // 2. Read document.cookie for preferred name, candidates, JWT, and localStorage
            const preferredCookie = typeof msg.cookieName === 'string' && msg.cookieName ? msg.cookieName : 'prod'
            const parsedCookies = new Map<string, string>()
            for (const raw of (document.cookie || '').split(';')) {
              const [k, v] = splitEq(raw)
              if (k && v) {
                const val = clean(v)
                if (val) parsedCookies.set(k, val)
              }
            }

            // 2a. Preferred cookie name
            if (preferredCookie && parsedCookies.has(preferredCookie)) {
              sendResponse({ ok: true, token: parsedCookies.get(preferredCookie) })
              return
            }

            // 2b. Candidate cookie names
            const candidates = ['prod', 'testing', 'proxy_auth_token', 'beta', 'token', 'auth_token', 'accessToken', 'access_token', 'authToken']
            for (const name of candidates) {
              if (parsedCookies.has(name)) {
                sendResponse({ ok: true, token: parsedCookies.get(name) })
                return
              }
            }

            // 2c. Any cookie with a likely JWT value
            for (const val of parsedCookies.values()) {
              if (isJwt(val)) {
                sendResponse({ ok: true, token: val })
                return
              }
            }

            // 2d. LocalStorage candidates
            const storageKeys = ['proxy_auth_token', 'token', 'auth_token', 'prod', 'testing', 'accessToken', 'access_token', 'authToken']
            for (const key of storageKeys) {
              const val = clean(localStorage.getItem(key))
              if (val) {
                sendResponse({ ok: true, token: val })
                return
              }
            }

            // 2e. Any LocalStorage item with a JWT value
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i)
              if (key) {
                const val = clean(localStorage.getItem(key))
                if (isJwt(val)) {
                  sendResponse({ ok: true, token: val })
                  return
                }
              }
            }

            // 2f. SessionStorage fallback
            const sso = clean(sessionStorage.getItem('ssoEmbedToken')) || clean(sessionStorage.getItem('proxy_auth_token'))
            if (sso) {
              sendResponse({ ok: true, token: sso })
              return
            }
          }
        } catch {
          // ignore
        }
        sendResponse({ ok: false })
      })()
      return true
    }
    return false
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage)

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
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      }
    })
    safe(() => {
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(onStorage)
      }
    })
    safe(() => stepMenu.destroy())
    safe(() => flowMenu.destroy())
    safe(() => subfunctionsUI.destroy())
    safe(() => beautify.destroy())
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
    safe(() => window.removeEventListener('keydown', onWindowKeyDown, true))
    safe(() => document.removeEventListener('visibilitychange', onVisibility))
    safe(() => window.removeEventListener('focus', claimVoice))
    safe(() => hotkey.destroy())
    safe(() => bridge.destroy())
    safe(() => pageWatch.destroy())
    safe(() => domWatcher.destroy())
    safe(() => mascot.setEnabled(false))
    safe(() => mascot.destroy())
  }
}

main().catch((e: unknown) => console.warn('[viaSocket Assistant] failed to start', e))
