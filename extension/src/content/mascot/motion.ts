// Where the orb should be, frame by frame. Priority: drag > highlight > park > dock beside an open panel >
// roam (or hover in place while held). Whatever the target, the orb never sits on the field being edited.
// The controller drives step() from its frame loop; step() returns true while the orb is still travelling.

import type { MascotConfig } from '../../shared/config'
import type { PageContext } from '../../shared/page'
import { isEditable } from './dom'
import type { HighlightAnchor } from './highlight'
import type { ParkSpot } from './park-store'
import {
  boxAt, center, clampPoint, contains, distance, hasArea, inflate, intersection, intersects, rectOf, viewport,
  type Point, type Rect,
} from './geometry'
import { queryAll, queryOne, type Selectors } from './selectors'

const MARGIN = 12
const GAP = 14
const OBSTACLE_PAD = 10
const FLY_SPEED = 0.16
/** px per ms; keeps long roams from looking like teleports and short ones from crawling at the end */
const MAX_VELOCITY = 0.9
const MIN_VELOCITY = 0.03
const DOM_CACHE_MS = 300
const ACTIVE_CACHE_MS = 200
const HOLD_GRACE_MS = 1500
const PREFERRED_HOP = 220
/** A panel wider than this share of the viewport (full-width DH section, 100vw slider) leaves no room to dock beside */
const MAX_DOCK_SHARE = 0.6
/** obstacles() queries the whole page, so a resting orb checks what it covers only this often */
const NUDGE_CHECK_MS = 1000

export interface MotionDeps {
  mover: HTMLElement
  host: HTMLElement
  sel: Selectors
  /** True when the orb should hover in place instead of roaming (busy, listening, user typing, panel open…) */
  isHeld(): boolean
  highlightAnchor(): HighlightAnchor | null
  onMoved(x: number, y: number): void
}

export class Motion {
  private x = Number.NaN
  private y = Number.NaN
  private appliedX = Number.NaN
  private appliedY = Number.NaN
  private size = 44
  private roam: MascotConfig['roam'] = { enabled: true, speed: 0.015, restSeconds: [4, 12], sleepAfterSeconds: 45 }
  private reduced = false
  private page: PageContext | null = null
  private park: ParkSpot | null = null
  private wander: Point | null = null
  /** Short move off something clickable the resting orb ended up covering */
  private nudge: Point | null = null
  private nudgeAt = -Infinity
  private restUntil = 0
  private dragging = false
  private lastFrame = 0
  private dockEl: Element | null = null
  private dockAt = -Infinity
  private activeRectCache: Rect | null = null
  private activeAt = -Infinity
  /** Eye direction -1..1 */
  readonly look: Point = { x: 0, y: 0 }

  constructor(private readonly deps: MotionDeps) {}

  setSize(px: number): void {
    this.size = px
  }

  setRoam(roam: MascotConfig['roam']): void {
    this.roam = roam
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced
    if (reduced) this.wander = null
  }

  setPage(page: PageContext): void {
    this.page = page
    this.dockAt = -Infinity
    this.wander = null
    this.nudge = null
  }

  setPark(spot: ParkSpot | null): void {
    this.park = spot
    this.nudge = null
    if (!spot) this.restUntil = 0
  }

  get parked(): boolean {
    return this.park !== null
  }

  get position(): Point {
    return { x: this.x, y: this.y }
  }

  get placed(): boolean {
    return Number.isFinite(this.x)
  }

  /** Puts the orb at its start position right away (e.g. the panel opens before the first frame) */
  ensurePlaced(): void {
    if (this.placed) return
    this.place(viewport(MARGIN))
    this.apply()
  }

  /** Forget cached DOM lookups (page changed, config changed) */
  invalidate(): void {
    this.dockAt = -Infinity
    this.activeAt = -Infinity
  }

  startDrag(): void {
    this.dragging = true
    this.wander = null
    this.nudge = null
  }

  dragTo(x: number, y: number): void {
    const p = clampPoint({ x, y }, this.size, viewport(4))
    this.x = p.x
    this.y = p.y
    this.apply()
  }

  /** Ends a drag and returns the spot to persist */
  endDrag(): ParkSpot {
    this.dragging = false
    const vp = viewport()
    const spot = {
      rx: clamp01(this.x / Math.max(1, vp.right - this.size)),
      ry: clamp01(this.y / Math.max(1, vp.bottom - this.size)),
    }
    this.park = spot
    return spot
  }

  step(now: number): boolean {
    const dt = this.lastFrame ? Math.min(64, Math.max(1, now - this.lastFrame)) : 16
    this.lastFrame = now
    const vp = viewport(MARGIN)
    if (!this.placed) this.place(vp)
    if (this.dragging) return true

    let target: Point | null = null
    let speed = this.roam.speed
    const anchor = this.deps.highlightAnchor()
    const dock = anchor ? null : this.dockRect(now)

    if (anchor) {
      target = this.beside(anchor, vp)
      speed = FLY_SPEED
      this.lookAt(center(anchor.rect))
    } else {
      const parkPoint = this.park ? this.parkPoint(vp) : null
      const dockPoint = !parkPoint && dock ? this.dockPoint(dock, vp) : null
      if (parkPoint) {
        // The user's spot wins over docking; if an open panel covers it, wait just off the panel's nearest edge.
        target = parkPoint
        if (dock && intersects(boxAt(parkPoint, this.size), dock)) {
          target = this.evade(parkPoint, dock, vp) ?? parkPoint
          speed = FLY_SPEED
        }
      } else if (dockPoint) {
        target = dockPoint
        speed = FLY_SPEED
      } else {
        target = this.roamTarget(now)
        if (target) this.nudge = null
        else target = this.nudgeTarget(now, vp)
        if (target && target === this.nudge) speed = FLY_SPEED
      }

      const active = this.activeRect(now)
      if (active) {
        const from = target ?? { x: this.x, y: this.y }
        if (intersects(boxAt(from, this.size), inflate(active, 6))) {
          target = this.evade(from, active, vp) ?? target
          speed = FLY_SPEED
        }
      }
    }

    // Window resized or orb pushed off-screen while hovering
    if (!target && !contains(vp, boxAt({ x: this.x, y: this.y }, this.size))) target = { x: this.x, y: this.y }
    if (!target) return this.settle()

    target = clampPoint(target, this.size, vp)
    const dx = target.x - this.x
    const dy = target.y - this.y
    const d = Math.hypot(dx, dy)
    if (d < 0.5 || this.reduced) {
      this.x = target.x
      this.y = target.y
      this.nudge = null
      if (target === this.wander || (this.wander && distance(target, this.wander) < 1)) this.arrived(now)
      return this.settle()
    }

    const k = 1 - Math.pow(1 - speed, dt / 16.667)
    const len = Math.min(d, Math.max(d * k, MIN_VELOCITY * dt), MAX_VELOCITY * dt)
    this.x += (dx / d) * len
    this.y += (dy / d) * len
    if (!anchor) {
      this.look.x = dx / d
      this.look.y = (dy / d) * 0.6
    }
    this.apply()
    return true
  }

  private settle(): false {
    if (!this.deps.highlightAnchor()) {
      this.look.x = 0
      this.look.y = 0
    }
    this.apply()
    return false
  }

  private apply(): void {
    const rx = Math.round(this.x)
    const ry = Math.round(this.y)
    if (rx === this.appliedX && ry === this.appliedY) return
    this.appliedX = rx
    this.appliedY = ry
    this.deps.mover.style.transform = `translate3d(${rx}px, ${ry}px, 0)`
    this.deps.onMoved(rx, ry)
  }

  private place(vp: Rect): void {
    const start = this.park
      ? this.parkPoint(vp)
      : { x: vp.right - this.size - 16, y: vp.bottom - this.size - 96 }
    const p = clampPoint(start, this.size, vp)
    this.x = p.x
    this.y = p.y
    this.restUntil = performance.now() + 2500
  }

  private arrived(now: number): void {
    this.wander = null
    const [lo, hi] = this.roam.restSeconds
    const min = Math.max(0.5, Math.min(lo, hi))
    const max = Math.max(min, Math.max(lo, hi))
    this.restUntil = now + (min + Math.random() * (max - min)) * 1000
  }

  private parkPoint(vp: Rect): Point {
    const spot = this.park ?? { rx: 1, ry: 1 }
    const full = viewport()
    const p = { x: spot.rx * (full.right - this.size), y: spot.ry * (full.bottom - this.size) }
    return clampPoint(p, this.size, vp)
  }

  // ---------- roaming ----------

  private roamTarget(now: number): Point | null {
    if (!this.roam.enabled || this.reduced || this.deps.isHeld()) {
      this.wander = null
      this.restUntil = Math.max(this.restUntil, now + HOLD_GRACE_MS)
      return null
    }
    if (this.wander) return this.wander
    if (now < this.restUntil) return null
    this.wander = this.pickWander()
    if (!this.wander) this.restUntil = now + 3000
    return this.wander
  }

  private roamBounds(): Rect {
    const vp = viewport(MARGIN)
    const canvas = queryOne(this.deps.sel.flow('canvasViewport'))
    if (canvas) {
      const r = intersection(inflate(rectOf(canvas), -MARGIN), vp)
      if (r && r.right - r.left > this.size * 3 && r.bottom - r.top > this.size * 3) return r
    }
    return vp
  }

  private obstacles(): Rect[] {
    const sel = this.deps.sel
    const list = [
      ...sel.avoid(),
      '[data-testid^="step-node-"]',
      sel.flow('triggerNode'),
      sel.flow('navbar'),
      sel.flow('controls'),
      sel.flow('stepPanel'),
      sel.devHub('sidebar'),
    ]
    const rects: Rect[] = []
    for (const s of list) {
      for (const el of queryAll(s)) {
        const r = rectOf(el)
        if (hasArea(r)) rects.push(inflate(r, OBSTACLE_PAD))
      }
    }
    return rects
  }

  /** A resting orb that ends up over a node, button or dialog (one appeared under it) moves just clear of it */
  private nudgeTarget(now: number, vp: Rect): Point | null {
    if (this.nudge) return this.nudge
    if (now - this.nudgeAt < NUDGE_CHECK_MS) return null
    this.nudgeAt = now
    const here = { x: this.x, y: this.y }
    const blocked = this.obstacles()
    const hit = blocked.find((o) => intersects(o, boxAt(here, this.size)))
    if (!hit) return null
    const away = this.evade(here, hit, vp)
    this.nudge = away && !blocked.some((o) => intersects(o, boxAt(away, this.size))) ? away : null
    return this.nudge
  }

  private pickWander(): Point | null {
    const b = this.roamBounds()
    const maxX = b.right - this.size
    const maxY = b.bottom - this.size
    if (maxX <= b.left || maxY <= b.top) return null
    const blocked = this.obstacles()
    const here = { x: this.x, y: this.y }
    let best: Point | null = null
    let bestScore = Infinity
    for (let i = 0; i < 28; i++) {
      const p = { x: b.left + Math.random() * (maxX - b.left), y: b.top + Math.random() * (maxY - b.top) }
      const box = boxAt(p, this.size)
      if (blocked.some((o) => intersects(o, box))) continue
      const score = Math.abs(distance(p, here) - PREFERRED_HOP)
      if (score < bestScore) {
        best = p
        bestScore = score
      }
    }
    return best
  }

  // ---------- docking / placement ----------

  private dockRect(now: number): Rect | null {
    if (now - this.dockAt > DOM_CACHE_MS || (this.dockEl && !this.dockEl.isConnected)) {
      this.dockEl = this.findDock()
      this.dockAt = now
    }
    if (!this.dockEl) return null
    const r = rectOf(this.dockEl)
    const vp = viewport()
    if (r.right - r.left > (vp.right - vp.left) * MAX_DOCK_SHARE) return null
    return hasArea(r) && intersects(r, vp) ? r : null
  }

  private findDock(): Element | null {
    const sel = this.deps.sel
    const panel = queryOne(sel.flow('stepPanel'))
    if (panel) return panel
    if (this.page?.kind === 'developer-hub-plugin' && this.page.sectionKey) return queryOne(sel.devHub('section'))
    return null
  }

  /** Beside the panel, or null when there is no room beside it (the orb then roams or holds instead) */
  private dockPoint(dock: Rect, vp: Rect): Point | null {
    const y = (dock.top + dock.bottom) / 2 - this.size / 2
    let x = dock.left - this.size - GAP
    // DH: the section may start right after the sidebar; sit just inside the section instead of on the sidebar.
    const sidebar = queryOne(this.deps.sel.devHub('sidebar'))
    if (sidebar) {
      const s = rectOf(sidebar)
      if (hasArea(s) && intersects(boxAt({ x, y }, this.size), s)) x = s.right + GAP / 2
    }
    const p = clampPoint({ x, y }, this.size, vp)
    return intersects(boxAt(p, this.size), dock) ? null : p
  }

  private beside(anchor: HighlightAnchor, vp: Rect): Point {
    const r = anchor.rect
    const s = this.size
    const cy = (r.top + r.bottom) / 2 - s / 2
    const cx = (r.left + r.right) / 2 - s / 2
    const spots: Record<'left' | 'right' | 'above' | 'below', Point> = {
      right: { x: r.right + GAP, y: cy },
      left: { x: r.left - GAP - s, y: cy },
      below: { x: cx, y: r.bottom + GAP },
      above: { x: cx, y: r.top - GAP - s },
    }
    const order = anchor.prefer === 'right'
      ? (['right', 'left', 'below', 'above'] as const)
      : (['left', 'right', 'above', 'below'] as const)
    // Prefer staying inside the target's visible area (e.g. not on the step slider next to a canvas node).
    const inside = anchor.bounds ? intersection(anchor.bounds, vp) : null
    for (const area of inside ? [inside, vp] : [vp]) {
      for (const side of order) {
        if (contains(area, boxAt(spots[side], s))) return spots[side]
      }
    }
    return spots[order[0]]
  }

  private activeRect(now: number): Rect | null {
    if (now - this.activeAt < ACTIVE_CACHE_MS) return this.activeRectCache
    this.activeAt = now
    this.activeRectCache = null
    const a = document.activeElement
    if (!a || a === this.deps.host || a === document.body || !isEditable(a)) return null
    // Monaco focuses a tiny hidden textarea; the editor box is what the user is looking at.
    const box = a.closest('.monaco-editor') ?? a
    const r = rectOf(box)
    if (hasArea(r)) this.activeRectCache = r
    return this.activeRectCache
  }

  private evade(from: Point, avoid: Rect, vp: Rect): Point | null {
    const s = this.size
    const options = [
      { x: avoid.left - s - GAP, y: from.y },
      { x: avoid.right + GAP, y: from.y },
      { x: from.x, y: avoid.top - s - GAP },
      { x: from.x, y: avoid.bottom + GAP },
    ].filter((p) => contains(vp, boxAt(p, s)))
    options.sort((a, b) => distance(a, from) - distance(b, from))
    return options[0] ?? null
  }

  private lookAt(p: Point): void {
    const c = { x: this.x + this.size / 2, y: this.y + this.size / 2 }
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1
    this.look.x = (p.x - c.x) / d
    this.look.y = ((p.y - c.y) / d) * 0.6
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}
