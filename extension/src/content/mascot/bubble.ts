// The orb itself: a round "Strobi-style" blob with two eyes. Pure presentation; position is set by Motion
// on `mover`, behaviour (click, drag) is wired by the controller on `button`.

import type { MascotMode } from '../../shared/mascot'
import { h } from './dom'

const BLINK_MIN_MS = 2400
const BLINK_MAX_MS = 6500

export class Bubble {
  /** Positioned by Motion (translate3d). Also hosts the thinking line so it travels with the orb. */
  readonly mover: HTMLDivElement
  readonly button: HTMLButtonElement
  private readonly orb: HTMLDivElement
  private readonly eyes: HTMLDivElement
  private mode: MascotMode = 'idle'
  private blinkTimer = 0
  private stretchTimer = 0
  private look = { x: 0, y: 0 }
  private level = 0

  constructor() {
    this.eyes = h('div', { class: 'eyes' }, h('span', { class: 'eye' }), h('span', { class: 'eye' }))
    this.orb = h('div', { class: 'orb' }, h('span', { class: 'ring' }), h('span', { class: 'shine' }), this.eyes)
    const zzz = h('div', { class: 'zzz' }, h('span', { text: 'z' }), h('span', { text: 'z' }), h('span', { text: 'z' }))
    const anim = h('div', { class: 'anim', 'aria-hidden': 'true' }, this.orb, zzz)
    this.button = h(
      'button',
      {
        type: 'button',
        class: 'orb-btn',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-label': 'viaSocket Assistant. Click to chat, drag to move.',
      },
      anim,
      h('span', { class: 'badge', 'aria-hidden': 'true' }),
    )
    this.mover = h('div', { class: 'mover m-idle' }, this.button)
    this.scheduleBlink()
  }

  setMode(mode: MascotMode): void {
    if (mode === this.mode) return
    this.mover.classList.replace(`m-${this.mode}`, `m-${mode}`)
    this.mode = mode
  }

  setColor(color: string): void {
    this.mover.style.setProperty('--orb', color)
  }

  setSize(px: number): void {
    this.mover.style.setProperty('--size', `${px}px`)
  }

  /** Microphone level 0..1, smoothed so the pulse doesn't flicker */
  setLevel(level: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))
    this.level = this.level * 0.55 + clamped * 0.45
    this.mover.style.setProperty('--lvl', this.level.toFixed(3))
  }

  resetLevel(): void {
    this.level = 0
    this.mover.style.setProperty('--lvl', '0')
  }

  /** Eye direction, each axis -1..1 */
  setLook(x: number, y: number): void {
    if (Math.abs(x - this.look.x) < 0.05 && Math.abs(y - this.look.y) < 0.05) return
    this.look = { x, y }
    this.mover.style.setProperty('--lx', x.toFixed(2))
    this.mover.style.setProperty('--ly', y.toFixed(2))
  }

  setBadge(on: boolean): void {
    this.mover.classList.toggle('has-badge', on)
  }

  setExpanded(open: boolean): void {
    this.button.setAttribute('aria-expanded', String(open))
  }

  setParked(parked: boolean): void {
    this.mover.classList.toggle('parked', parked)
    this.button.setAttribute(
      'aria-label',
      parked
        ? 'viaSocket Assistant (parked). Click to chat, double-click to let it roam again.'
        : 'viaSocket Assistant. Click to chat, drag to move.',
    )
  }

  setDragging(dragging: boolean): void {
    this.mover.classList.toggle('dragging', dragging)
  }

  setVisible(visible: boolean): void {
    this.mover.classList.toggle('placed', visible)
  }

  /** One-off stretch, used when waking straight into another mode */
  stretch(): void {
    this.orb.classList.remove('stretch')
    void this.orb.offsetWidth // restart the animation
    this.orb.classList.add('stretch')
    clearTimeout(this.stretchTimer)
    this.stretchTimer = window.setTimeout(() => this.orb.classList.remove('stretch'), 700)
  }

  destroy(): void {
    clearTimeout(this.blinkTimer)
    clearTimeout(this.stretchTimer)
  }

  private scheduleBlink(): void {
    const wait = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS)
    this.blinkTimer = window.setTimeout(() => {
      if (this.mode !== 'sleeping' && !document.hidden) {
        this.blink()
        if (Math.random() < 0.18) window.setTimeout(() => this.blink(), 260)
      }
      this.scheduleBlink()
    }, wait)
  }

  private blink(): void {
    this.eyes.classList.add('blink')
    window.setTimeout(() => this.eyes.classList.remove('blink'), 130)
  }
}
