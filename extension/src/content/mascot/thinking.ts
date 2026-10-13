// One short line next to the orb with a typewriter effect. Lives inside the orb's mover so it travels with it;
// it only decides which side to sit on. A "resting" line (the plan's current item) stays while the assistant is idle:
// transient lines take over and it comes back once they fade.

import { h } from './dom'

const TYPE_MS = 18
const FADE_AFTER_MS = 6000
const GAP = 10
const EDGE = 8

export class ThinkingLine {
  readonly el: HTMLDivElement
  private readonly text: HTMLSpanElement
  private full = ''
  private shown = 0
  private resting = ''
  /** The line on screen is the resting one, not a transient line */
  private showingResting = false
  private width = 0
  private busy = false
  private side: 'left' | 'right' = 'right'
  private typeTimer = 0
  private fadeTimer = 0
  private lastX = 0
  private size = 44

  constructor() {
    this.text = h('span', { class: 'think-text' })
    this.el = h('div', { class: 'think', 'aria-hidden': 'true' }, this.text)
  }

  /** Returns the text actually shown (after truncation), for the screen-reader live region */
  set(raw: string, maxChars: number, instant: boolean): string {
    const clean = raw.replace(/\s+/g, ' ').trim()
    clearTimeout(this.typeTimer)
    clearTimeout(this.fadeTimer)
    if (!clean) {
      this.fadeOut()
      return ''
    }
    this.full = fit(clean, maxChars)
    this.showingResting = false

    // Measure the final width once so the side does not flip while typing.
    this.text.textContent = this.full
    this.el.classList.add('show')
    this.width = this.el.offsetWidth
    this.place(this.lastX, this.size)

    if (instant) {
      this.shown = this.full.length
      this.afterTyped()
    } else {
      this.shown = 0
      this.text.textContent = ''
      this.typeNext()
    }
    return this.full
  }

  /** Hides whatever is showing; the resting line comes back with the next setResting(). */
  clear(): void {
    clearTimeout(this.typeTimer)
    clearTimeout(this.fadeTimer)
    this.hide()
  }

  /** The idle line ('' for none). Shown at once unless a transient line is on screen or a run is going. */
  setResting(raw: string, maxChars: number): void {
    const clean = raw.replace(/\s+/g, ' ').trim()
    this.resting = clean ? fit(clean, maxChars) : ''
    if (!this.full || this.showingResting) this.showResting()
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    if (busy) {
      clearTimeout(this.fadeTimer)
      // During a run the line shows what the assistant is doing, not the resting text.
      if (this.showingResting) this.hide()
    } else if (!this.full) this.showResting()
    else if (!this.showingResting && this.shown >= this.full.length) this.scheduleFade()
  }

  /** Called whenever the orb moves: sit on whichever side has room */
  place(x: number, size: number): void {
    this.lastX = x
    this.size = size
    if (!this.full) return
    const vw = document.documentElement.clientWidth || window.innerWidth
    const roomRight = vw - (x + size + GAP) - EDGE
    const roomLeft = x - GAP - EDGE
    const side = roomRight >= this.width || roomRight >= roomLeft ? 'right' : 'left'
    if (side !== this.side) {
      this.side = side
      this.el.classList.toggle('left', side === 'left')
    }
  }

  destroy(): void {
    clearTimeout(this.typeTimer)
    clearTimeout(this.fadeTimer)
  }

  private typeNext(): void {
    // Two characters per tick on long lines keeps the whole effect around a second.
    this.shown = Math.min(this.full.length, this.shown + (this.full.length > 40 ? 2 : 1))
    this.text.textContent = this.full.slice(0, this.shown)
    if (this.shown < this.full.length) this.typeTimer = window.setTimeout(() => this.typeNext(), TYPE_MS)
    else this.afterTyped()
  }

  private afterTyped(): void {
    this.text.textContent = this.full
    if (!this.busy) this.scheduleFade()
  }

  private scheduleFade(): void {
    clearTimeout(this.fadeTimer)
    this.fadeTimer = window.setTimeout(() => this.fadeOut(), FADE_AFTER_MS)
  }

  /** A transient line is done: the resting line takes its place, or the pill goes. */
  private fadeOut(): void {
    if (this.resting && !this.busy) this.showResting()
    else this.hide()
  }

  private showResting(): void {
    clearTimeout(this.typeTimer)
    clearTimeout(this.fadeTimer)
    if (!this.resting || this.busy) {
      this.hide()
      return
    }
    this.full = this.resting
    this.shown = this.full.length
    this.showingResting = true
    this.text.textContent = this.full
    this.el.classList.add('show')
    this.width = this.el.offsetWidth
    this.place(this.lastX, this.size)
  }

  private hide(): void {
    this.full = ''
    this.shown = 0
    this.showingResting = false
    this.el.classList.remove('show')
  }
}

function fit(clean: string, maxChars: number): string {
  const limit = Math.max(8, Math.floor(maxChars))
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean
}
