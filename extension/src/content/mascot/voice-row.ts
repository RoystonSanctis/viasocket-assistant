// Voice status strip in the panel: model download progress, listening meter, transcribing, permission, error.

import type { SttEngine, VoiceState } from '../../shared/messages'
import { h } from './dom'

const MAX_DETAIL = 90

export interface VoiceRowActions {
  onAllowMic?: () => void
  onOpenSettings: (engine: SttEngine) => void
  onSwitchEngine?: (engine: SttEngine) => void
}

export class VoiceRow {
  readonly el: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly bar: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly meter: HTMLDivElement
  private readonly switchBtn: HTMLButtonElement
  private readonly allowBtn: HTMLButtonElement
  private readonly settingsBtn: HTMLButtonElement
  private state: VoiceState = 'off'
  private engine: SttEngine = 'whisper-local'
  private detail: string | undefined
  private progress: number | undefined

  constructor(actions: VoiceRowActions | ((engine: SttEngine) => void)) {
    const act: VoiceRowActions =
      typeof actions === 'function'
        ? { onOpenSettings: actions, onAllowMic: () => actions(this.engine) }
        : actions

    this.label = h('span', { class: 'voice-label' })
    this.fill = h('div', { class: 'bar-fill' })
    this.bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.fill)
    this.meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span'))

    this.switchBtn = h('button', { type: 'button', class: 'btn primary small', text: 'Switch to Whisper', hidden: true })
    this.switchBtn.addEventListener('click', () => act.onSwitchEngine?.('whisper-local'))

    this.allowBtn = h('button', { type: 'button', class: 'btn primary small', text: 'Allow microphone', hidden: true })
    this.allowBtn.addEventListener('click', () => act.onAllowMic?.())

    this.settingsBtn = h('button', { type: 'button', class: 'btn small', text: 'Open settings', hidden: true })
    this.settingsBtn.addEventListener('click', () => act.onOpenSettings(this.engine))

    this.el = h(
      'div',
      { class: 'voice', role: 'status', 'aria-live': 'polite', hidden: true },
      h('span', { class: 'voice-dot', 'aria-hidden': 'true' }),
      this.meter,
      this.label,
      this.bar,
      this.switchBtn,
      this.allowBtn,
      this.settingsBtn,
    )
  }

  get current(): VoiceState {
    return this.state
  }

  setEngine(engine: SttEngine, lines: Record<string, string>): void {
    if (engine === this.engine) return
    this.engine = engine
    this.set(this.state, lines, this.detail, this.progress)
  }

  set(state: VoiceState, lines: Record<string, string>, detail?: string, progress?: number): void {
    this.state = state
    this.detail = detail
    this.progress = progress
    this.el.dataset.state = state
    this.el.hidden = state === 'off' || state === 'ready'
    const extra = detail ? truncate(detail) : ''

    this.switchBtn.hidden = true
    this.allowBtn.hidden = true
    this.settingsBtn.hidden = true

    let text = ''
    switch (state) {
      case 'loading-model': {
        const pct = toPercent(progress)
        text = lines.loadingModel ?? 'Loading the voice model (one-time download)…'
        if (pct !== null) {
          text = `${text} ${pct}%`
          this.fill.style.width = `${pct}%`
          this.bar.setAttribute('aria-valuenow', String(pct))
        } else {
          this.fill.style.width = '0%'
          this.bar.removeAttribute('aria-valuenow')
        }
        break
      }
      case 'listening':
        text = lines.listening ?? 'Listening…'
        break
      case 'transcribing':
        text = lines.transcribing ?? 'Transcribing…'
        break
      case 'needs-permission': {
        if (this.engine === 'whisper-local') {
          text = lines.noMic ?? 'I need microphone access to hear you.'
          this.settingsBtn.hidden = false
          this.settingsBtn.className = 'btn primary small'
          this.settingsBtn.textContent = 'Allow microphone'
        } else {
          const isEmbedBlocked =
            extra.toLowerCase().includes('embed') ||
            (typeof window !== 'undefined' && window.self !== window.top)
          const isPromptFailed =
            extra.toLowerCase().includes('not allowed') ||
            extra.toLowerCase().includes('blocked')

          if (isEmbedBlocked) {
            text =
              extra ||
              'Browser speech is blocked in this embed iframe (missing allow="microphone"). Switch to Whisper for voice.'
            this.switchBtn.hidden = false
            this.switchBtn.className = 'btn primary small'
            this.switchBtn.textContent = 'Switch to Whisper'
            this.settingsBtn.hidden = false
            this.settingsBtn.className = 'btn small'
            this.settingsBtn.textContent = 'Open settings'
          } else if (isPromptFailed) {
            text =
              extra ||
              lines.noMicSite ||
              'Browser speech needs microphone access for this site.'
            this.settingsBtn.hidden = false
            this.settingsBtn.className = 'btn primary small'
            this.settingsBtn.textContent = 'Open settings'
            this.allowBtn.hidden = false
            this.allowBtn.className = 'btn small'
            this.allowBtn.textContent = 'Retry allow'
          } else {
            text = lines.noMicSite ?? 'Browser speech needs microphone access for this site.'
            this.allowBtn.hidden = false
            this.allowBtn.className = 'btn primary small'
            this.allowBtn.textContent = 'Allow microphone'
            this.settingsBtn.hidden = false
            this.settingsBtn.className = 'btn small'
            this.settingsBtn.textContent = 'Open settings'
          }
        }
        break
      }
      case 'error':
        text = extra || 'Voice input failed.'
        break
      default:
        text = ''
    }
    if (extra && state !== 'error' && state !== 'loading-model' && state !== 'needs-permission') {
      text = `${text} ${extra}`
    }
    this.label.textContent = text
    this.bar.hidden = state !== 'loading-model'
    this.meter.hidden = state !== 'listening'
  }

  setLevel(level: number): void {
    this.el.style.setProperty('--lvl', Math.min(1, Math.max(0, level)).toFixed(3))
  }
}

function toPercent(progress: number | undefined): number | null {
  if (progress === undefined || !Number.isFinite(progress) || progress < 0) return null
  // The offscreen document reports whole percents (0..100).
  return Math.round(Math.min(100, progress))
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean
}
