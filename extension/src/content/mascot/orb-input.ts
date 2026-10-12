// Pointer/keyboard handling on the orb: click toggles the panel, drag parks it, double-click un-parks.

import type { Motion } from './motion'
import type { ParkSpot } from './park-store'

const DBLCLICK_MS = 260
const DRAG_THRESHOLD_PX = 5

export interface OrbInputHooks {
  onActivity(): void
  onDragStart(): void
  onDragEnd(spot: ParkSpot): void
  onUnpark(): void
  onToggle(): void
  onEscape(): void
}

interface DragState {
  id: number
  startX: number
  startY: number
  offX: number
  offY: number
  moved: boolean
}

export class OrbInput {
  private drag: DragState | null = null
  private suppressClick = false
  private clickTimer = 0

  constructor(
    private readonly btn: HTMLButtonElement,
    private readonly motion: Motion,
    private readonly hooks: OrbInputHooks,
  ) {
    btn.addEventListener('pointerdown', this.onDown)
    btn.addEventListener('pointermove', this.onMove)
    btn.addEventListener('pointerup', this.onEnd)
    btn.addEventListener('pointercancel', this.onEnd)
    btn.addEventListener('lostpointercapture', this.onEnd)
    btn.addEventListener('click', this.onClick)
    btn.addEventListener('dblclick', this.onDblClick)
    btn.addEventListener('keydown', this.onKey)
  }

  /** A pointer is down on the orb (possibly about to drag) */
  get pressed(): boolean {
    return this.drag !== null
  }

  get dragging(): boolean {
    return this.drag?.moved === true
  }

  destroy(): void {
    clearTimeout(this.clickTimer)
    // The button is removed with the host; listeners go with it.
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.motion.placed) return
    const p = this.motion.position
    this.drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, offX: e.clientX - p.x, offY: e.clientY - p.y, moved: false }
    try {
      this.btn.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return
      d.moved = true
      this.motion.startDrag()
      this.hooks.onDragStart()
    }
    this.motion.dragTo(e.clientX - d.offX, e.clientY - d.offY)
  }

  private readonly onEnd = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    if (!d.moved) return
    // The click that follows this pointerup belongs to the drag, not to "open the panel".
    this.suppressClick = true
    window.setTimeout(() => {
      this.suppressClick = false
    }, 0)
    this.hooks.onDragEnd(this.motion.endDrag())
  }

  private readonly onClick = (e: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    this.hooks.onActivity()
    // Mouse click while parked: wait briefly in case it is the first half of a double-click.
    if (this.motion.parked && e.detail > 0) {
      clearTimeout(this.clickTimer)
      this.clickTimer = window.setTimeout(() => {
        this.clickTimer = 0
        this.hooks.onToggle()
      }, DBLCLICK_MS)
      return
    }
    if (e.detail > 1) return
    this.hooks.onToggle()
  }

  private readonly onDblClick = (): void => {
    clearTimeout(this.clickTimer)
    this.clickTimer = 0
    if (!this.motion.parked) return
    this.motion.setPark(null)
    this.hooks.onUnpark()
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    this.hooks.onEscape()
  }
}
