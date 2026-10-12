// Voice status strip in the panel: model download progress, listening meter, transcribing, permission, error.

import type { SttEngine, VoiceState } from '../../shared/messages'
import { h } from './dom'

const MAX_DETAIL = 90

export class VoiceRow {
  readonly el: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly bar: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly meter: HTMLDivElement
  private readonly allow: HTMLButtonElement
  private state: VoiceState = 'off'
  private engine: SttEngine = 'whisper-local'
  private detail: string | undefined
  private progress: number | undefined

  /** onAllowMic gets the engine: browser speech needs the site's permission, Whisper the extension's */
  constructor(onAllowMic: (engine: SttEngine) => void) {
    this.label = h('span', { class: 'voice-label' })
    this.fill = h('div', { class: 'bar-fill' })
    this.bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.fill)
    this.meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span'))
    this.allow = h('button', { type: 'button', class: 'btn primary small', text: 'Allow microphone' })
    this.allow.addEventListener('click', () => onAllowMic(this.engine))
    this.el = h(
      'div',
      { class: 'voice', role: 'status', 'aria-live': 'polite', hidden: true },
      h('span', { class: 'voice-dot', 'aria-hidden': 'true' }),
      this.meter,
      this.label,
      this.bar,
      this.allow,
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
      case 'needs-permission':
        text =
          this.engine === 'browser'
            ? lines.noMicSite ?? 'Browser speech needs microphone access for this site.'
            : lines.noMic ?? 'I need microphone access to hear you.'
        break
      case 'error':
        text = extra || 'Voice input failed.'
        break
      default:
        text = ''
    }
    if (extra && state !== 'error' && state !== 'loading-model') text = `${text} ${extra}`
    this.label.textContent = text
    this.bar.hidden = state !== 'loading-model'
    this.meter.hidden = state !== 'listening'
    this.allow.hidden = state !== 'needs-permission'
    this.allow.textContent = this.engine === 'browser' ? 'Open settings' : 'Allow microphone'
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
