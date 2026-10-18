// Finds the element a HighlightTarget refers to and draws a spotlight ring + note that track it every frame
// (the canvas zooms and pans with a CSS transition, and React may replace the node at any time).

import type { HighlightTarget } from '../../shared/mascot'
import { h, iconButton } from './dom'
import { center, contains, hasArea, inflate, intersection, intersects, rectOf, viewport, type Rect } from './geometry'
import { queryAll, queryOne, type Selectors } from './selectors'

export type TargetKind = 'canvas' | 'field' | 'other'

export interface ResolvedTarget {
  el: Element
  kind: TargetKind
}

export interface HighlightAnchor {
  /** Visible part of the target in viewport coordinates */
  rect: Rect
  /** Side the orb prefers to sit on */
  prefer: 'left' | 'right'
  /** Where the orb should stay so it doesn't cover what hides the target (the canvas minus the step slider) */
  bounds?: Rect
}

const MAX_SLUG = 200
const MAX_LABEL = 200
const LABEL_TESTID_PREFIX = 'plugin-field-label-'
const ROW_TESTID_PREFIX = 'plugin-field-'
const RING_PAD = 6
const RERESOLVE_MS = 400
const LOST_GIVE_UP_MS = 8000
/** A target that never appeared (e.g. a slider still opening after navigation) is reported after this */
const PENDING_GIVE_UP_MS = 3000
/** A target that is on the page but outside every visible area (scrolled, panned, under the slider) */
const HIDDEN_GIVE_UP_MS = 2500
const MAX_HIGHLIGHT_MS = 90_000
/** The canvas transform animates for 0.3s; give a pan this long before falling back to zoom-to-fit */
const PAN_SETTLE_MS = 700
/** A plain (no ctrl/meta) wheel event on the canvas pans it by -delta * 1.2 */
const WHEEL_PAN_FACTOR = 1.2

// ---------- resolution ----------

function cleanQuery(query: string): string {
  return query
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\b(?:the\s+)?(?:button|btn|link|tab|icon|section|menu|option)\b\s*$/i, '')
    .trim()
}

function normalizeQueryText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[+*✨>•#&]/g, ' ')
    .replace(/[\s\-_]+/g, ' ')
    .trim()
}

export function findByText(query: string): Element | null {
  const raw = cleanQuery(query)
  if (!raw) return null
  const norm = normalizeQueryText(raw)
  if (!norm) return null
  const normNoArticles = norm.replace(/\b(?:a|an|the)\b\s*/g, '').trim()

  // 1. First priority: Interactive elements (buttons, links, menu items, tabs, chip buttons, list items)
  const interactiveSel =
    'button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"], .MuiButton-root, .MuiButtonBase-root, .MuiListItemButton-root, .MuiChip-root, .MuiTab-root, input[type="button"], input[type="submit"]'
  const interactives = Array.from(document.querySelectorAll(interactiveSel)).filter((el) => hasArea(rectOf(el)))

  // Pass 1A: Exact normalized text or aria-label/title match on interactive elements
  for (const el of interactives) {
    const t = normalizeQueryText(el.textContent ?? '')
    if (t === norm || (normNoArticles && t.replace(/\b(?:a|an|the)\b\s*/g, '').trim() === normNoArticles)) return el
    const aria = normalizeQueryText(el.getAttribute('aria-label') ?? '')
    if (aria === norm || (normNoArticles && aria.replace(/\b(?:a|an|the)\b\s*/g, '').trim() === normNoArticles)) return el
    const title = normalizeQueryText(el.getAttribute('title') ?? '')
    if (title === norm) return el
  }

  // Pass 1B: Interactive text contains target or target contains interactive text
  for (const el of interactives) {
    const t = normalizeQueryText(el.textContent ?? '')
    const tNoArt = t.replace(/\b(?:a|an|the)\b\s*/g, '').trim()
    if (t && (t.includes(norm) || norm.includes(t) || (normNoArticles && (tNoArt.includes(normNoArticles) || normNoArticles.includes(tNoArt))))) {
      return el
    }
  }

  // Pass 1C: All key words in query present in interactive element
  const words = (normNoArticles || norm).split(' ').filter((w) => w.length > 2)
  if (words.length > 0) {
    for (const el of interactives) {
      const t = normalizeQueryText(el.textContent ?? '')
      if (words.every((w) => t.includes(w))) {
        return el
      }
    }
  }

  // 2. Second priority: Any visible leaf or near-leaf elements (spans, headings, table cells, labels)
  const leafSel = 'span, p, h1, h2, h3, h4, h5, h6, td, th, label, div, [data-testid]'
  const leaves = Array.from(document.querySelectorAll(leafSel)).filter(
    (el) => el.children.length <= 3 && hasArea(rectOf(el)),
  )

  for (const el of leaves) {
    const t = normalizeQueryText(el.textContent ?? '')
    const tNoArt = t.replace(/\b(?:a|an|the)\b\s*/g, '').trim()
    if (t === norm || (normNoArticles && tNoArt === normNoArticles) || t.includes(norm)) {
      const clickable = el.closest(
        'button, a, [role="button"], [role="tab"], [role="menuitem"], .MuiButtonBase-root, .MuiListItemButton-root, .MuiChip-root, .MuiTableRow-root, li',
      )
      if (clickable && hasArea(rectOf(clickable))) {
        return clickable
      }
      return el
    }
  }

  // Pass 2B: Word matching on leaves
  if (words.length > 0) {
    for (const el of leaves) {
      const t = normalizeQueryText(el.textContent ?? '')
      if (words.every((w) => t.includes(w))) {
        const clickable = el.closest(
          'button, a, [role="button"], [role="tab"], [role="menuitem"], .MuiButtonBase-root, .MuiListItemButton-root, .MuiChip-root, .MuiTableRow-root, li',
        )
        if (clickable && hasArea(rectOf(clickable))) {
          return clickable
        }
        return el
      }
    }
  }

  return null
}

export function resolveTarget(t: HighlightTarget, sel: Selectors): ResolvedTarget | null {
  // Most specific first: visible text on a button or clickable control
  if (typeof t.text === 'string') {
    const el = findByText(t.text)
    if (el) return { el, kind: inCanvas(el, sel) ? 'canvas' : 'other' }
  }
  if (typeof t.fieldLabel === 'string') {
    const el = findField(t.fieldLabel, sel) ?? findByText(t.fieldLabel)
    if (el) return { el, kind: 'field' }
  }
  if (typeof t.slugName === 'string') {
    const el = findStep(t.slugName, sel) ?? findByText(t.slugName)
    if (el) return { el, kind: 'canvas' }
  }
  if (typeof t.selectorKey === 'string') {
    const el = firstVisible(sel.named(t.selectorKey)) ?? findByText(t.selectorKey)
    if (el) return { el, kind: inCanvas(el, sel) ? 'canvas' : 'other' }
  }
  if (typeof t.css === 'string') {
    const el = firstVisible(t.css)
    if (el) return { el, kind: inCanvas(el, sel) ? 'canvas' : 'other' }
  }
  return null
}

function inCanvas(el: Element, sel: Selectors): boolean {
  const canvasSel = sel.flow('canvasViewport')
  if (!canvasSel) return false
  try {
    return el.closest(canvasSel) !== null
  } catch {
    return false
  }
}

function findStep(slug: string, sel: Selectors): Element | null {
  if (!slug || slug.length > MAX_SLUG) return null
  if (slug === 'trigger') {
    const trigger = firstVisible(sel.flow('triggerNode')) ?? firstVisible('[data-testid^="inflow-node-"]')
    if (trigger) return trigger
  }
  const esc = CSS.escape(slug)
  const template = sel.flow('stepNode')
  const candidates = [
    template?.includes('{slugName}') ? template.split('{slugName}').join(esc) : undefined,
    `[data-testid="step-node-${esc}"]`,
    `[data-testid="delay-step-node-${esc}"]`,
    `[data-testid="if-component-${esc}"]`,
    `[data-testid="break-component-${esc}"]`,
  ]
  for (const c of candidates) {
    const el = firstVisible(c)
    if (el) return el
  }
  return null
}

/** Hidden copies (closed sliders kept in the DOM, display:none templates) must not count as "found" */
function firstVisible(sel: string | undefined, root: ParentNode = document): Element | null {
  return queryAll(sel, root).find((el) => hasArea(rectOf(el))) ?? null
}

function normaliseLabel(s: string): string {
  return s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function findField(label: string, sel: Selectors): Element | null {
  const want = normaliseLabel(label.slice(0, MAX_LABEL))
  if (!want) return null
  let container: Element | null = null
  for (const c of sel.fieldContainers()) {
    container = firstVisible(c)
    if (container) break
  }
  if (!container) return null

  let prefixMatch: Element | null = null
  for (const labelSel of sel.fieldLabels()) {
    for (const el of queryAll(labelSel, container)) {
      if (!hasArea(rectOf(el))) continue
      const text = normaliseLabel(el.textContent ?? '')
      if (!text) continue
      if (text === want) return fieldRow(el, container)
      if (!prefixMatch && text.startsWith(want)) prefixMatch = el
    }
  }
  return prefixMatch ? fieldRow(prefixMatch, container) : null
}

function fieldRow(label: Element, container: Element): Element {
  const labelBox = label.closest(`[data-testid^="${LABEL_TESTID_PREFIX}"]`)
  const key = labelBox?.getAttribute('data-testid')?.slice(LABEL_TESTID_PREFIX.length)
  if (key) {
    const row = queryOne(`[data-testid="${ROW_TESTID_PREFIX}${CSS.escape(key)}"]`, container)
    if (row) return row
  }
  for (let p = label.parentElement; p && p !== container; p = p.parentElement) {
    const id = p.getAttribute('data-testid')
    if (id?.startsWith(ROW_TESTID_PREFIX) && !id.startsWith(LABEL_TESTID_PREFIX)) return p
  }
  return label.parentElement ?? label
}

// ---------- spotlight ----------

export class Spotlight {
  readonly ring: HTMLDivElement
  readonly note: HTMLDivElement
  private readonly noteText: HTMLDivElement
  private target: HighlightTarget | null = null
  private el: Element | null = null
  private kind: TargetKind = 'other'
  private vis: Rect | null = null
  private clip: Rect | null = null
  private startedAt = 0
  private lastResolve = 0
  private lostSince = 0
  private hiddenSince = 0
  /** The element has been found at least once (and scrolled to if needed) */
  private revealed = false
  /** The ring has actually been drawn, so the user saw the target */
  private seen = false
  /** 0: not panned yet, 1: canvas panned, 2: zoom-to-fit tried as well */
  private panStage = 0
  private panAt = 0
  private noteSize = { w: 0, h: 0 }
  private drawn = ''
  private clipEl: Element | null = null
  private coverEl: Element | null = null
  private clipAt = 0

  constructor(
    private readonly sel: Selectors,
    /** Target vanished, stayed out of sight or timed out; `unseen` when the user never got to see it */
    private readonly onLost: (unseen: boolean) => void,
    /** User closed the note */
    onDismiss: () => void,
  ) {
    this.ring = h('div', { class: 'spot', 'aria-hidden': 'true' })
    this.noteText = h('div', { class: 'note-text' })
    const close = iconButton('close', 'Dismiss highlight', 'icon-btn note-close')
    close.addEventListener('click', onDismiss)
    this.note = h('div', { class: 'note', role: 'note' }, this.noteText, close)
  }

  get active(): boolean {
    return this.target !== null
  }

  /** `resolved` may be null: the target is then looked for again every frame until PENDING_GIVE_UP_MS */
  show(target: HighlightTarget, resolved: ResolvedTarget | null, note: string | undefined, now: number): void {
    this.target = target
    this.el = resolved?.el ?? null
    this.kind = resolved?.kind ?? 'other'
    this.startedAt = now
    this.lastResolve = now
    this.lostSince = 0
    this.hiddenSince = 0
    this.revealed = false
    this.seen = false
    this.panStage = 0
    this.drawn = ''
    this.vis = null
    this.clip = null
    this.clipEl = null
    this.coverEl = null
    this.clipAt = 0

    const text = (note ?? '').trim()
    this.noteText.textContent = text
    this.note.classList.toggle('has-text', text.length > 0)
    if (text) {
      this.note.classList.add('measuring')
      this.noteSize = { w: this.note.offsetWidth, h: this.note.offsetHeight }
      this.note.classList.remove('measuring')
    }
    // Restart the ring's intro animation (pulse + brief dim) for a new target.
    this.ring.classList.remove('on', 'intro')
    void this.ring.offsetWidth
    this.ring.classList.add('intro')

    if (resolved) this.reveal(resolved)
  }

  clear(): void {
    this.target = null
    this.el = null
    this.vis = null
    this.clip = null
    this.drawn = ''
    this.ring.classList.remove('on', 'intro')
    this.note.classList.remove('on')
  }

  anchor(): HighlightAnchor | null {
    if (!this.target || !this.vis) return null
    const a: HighlightAnchor = { rect: this.vis, prefer: this.kind === 'canvas' ? 'right' : 'left' }
    if (this.kind === 'canvas' && this.clip) a.bounds = this.clip
    return a
  }

  /** Re-measures and redraws; returns true while a highlight is active (so the frame loop keeps running) */
  update(now: number): boolean {
    if (!this.target) return false
    if (now - this.startedAt > MAX_HIGHLIGHT_MS) {
      this.onLost(false)
      return false
    }

    if (!this.el || !this.el.isConnected) {
      this.el = null
      if (now - this.lastResolve > RERESOLVE_MS) {
        this.lastResolve = now
        const again = resolveTarget(this.target, this.sel)
        if (again) {
          this.el = again.el
          this.kind = again.kind
          this.clipAt = 0
          if (!this.revealed) this.reveal(again)
        }
      }
      if (!this.el) {
        if (!this.lostSince) this.lostSince = now
        // Never found: report soon. Found before: React may just be re-rendering it, so wait longer.
        const gaveUp = this.revealed ? now - this.lostSince > LOST_GIVE_UP_MS : now - this.startedAt > PENDING_GIVE_UP_MS
        if (gaveUp) {
          this.onLost(!this.seen)
          return false
        }
        this.hideVisuals()
        return true
      }
    }
    this.lostSince = 0

    const r = rectOf(this.el)
    const clip = this.clipRect(now)
    this.clip = clip
    const vis = clip && hasArea(r) ? intersection(r, clip) : null
    this.vis = vis
    if (clip && hasArea(r)) this.panIntoView(r, clip, vis !== null, now)
    if (!vis) {
      if (!this.hiddenSince) this.hiddenSince = now
      else if (now - this.hiddenSince > HIDDEN_GIVE_UP_MS) {
        this.onLost(!this.seen)
        return false
      }
      this.hideVisuals()
      return true
    }
    this.hiddenSince = 0
    this.seen = true
    this.draw(inflate(vis, RING_PAD))
    return true
  }

  private reveal(resolved: ResolvedTarget): void {
    this.revealed = true
    // Never scroll the canvas (it is transform-panned and overflow:hidden); panel and DH fields may scroll.
    // Fields always scroll: they sit in their own scroll container, so "inside the viewport" proves nothing.
    if (resolved.kind === 'field' || (resolved.kind === 'other' && !fullyInViewport(resolved.el))) {
      resolved.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  /** Canvas nodes can't be scrolled to, so pan the canvas once the way a trackpad would; then try zoom-to-fit */
  private panIntoView(r: Rect, clip: Rect, visible: boolean, now: number): void {
    if (this.kind !== 'canvas' || this.panStage >= 2) return
    // Once the node has been fully in view, any later move is the user panning: never fight it.
    if (contains(clip, r)) {
      this.panStage = 2
      return
    }
    if (this.panStage === 1) {
      if (visible || now - this.panAt < PAN_SETTLE_MS) return
      this.panStage = 2
      const fit = firstVisible(this.sel.flow('zoomFitButton'))
      if (fit instanceof HTMLElement) fit.click()
      return
    }
    this.panStage = 1
    this.panAt = now
    const canvas = firstVisible(this.sel.flow('canvasViewport'))
    if (!canvas) return
    const want = center(clip)
    const have = center(r)
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: (have.x - want.x) / WHEEL_PAN_FACTOR,
        deltaY: (have.y - want.y) / WHEEL_PAN_FACTOR,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: want.x,
        clientY: want.y,
        bubbles: true,
        cancelable: true,
      }),
    )
  }

  /**
   * Canvas nodes are clipped by the canvas viewport minus the step slider over it, and fields by their panel, so the
   * ring never floats over the navbar or the slider. Null when nothing of that area is visible.
   */
  private clipRect(now: number): Rect | null {
    const vp = viewport()
    if (this.kind === 'other') return vp
    const stale = (el: Element | null): boolean => el !== null && !el.isConnected
    if (now - this.clipAt > 500 || stale(this.clipEl) || stale(this.coverEl)) {
      const canvas = this.kind === 'canvas'
      this.clipEl = canvas ? queryOne(this.sel.flow('canvasViewport')) : this.firstContainer()
      this.coverEl = canvas ? firstVisible(this.sel.flow('stepPanel')) : null
      this.clipAt = now
    }
    if (!this.clipEl) return vp
    const clip = intersection(rectOf(this.clipEl), vp) ?? vp
    return this.coverEl ? uncovered(clip, rectOf(this.coverEl)) : clip
  }

  private firstContainer(): Element | null {
    for (const c of this.sel.fieldContainers()) {
      const el = firstVisible(c)
      if (el) return el
    }
    return null
  }

  private draw(ring: Rect): void {
    const l = Math.round(ring.left)
    const t = Math.round(ring.top)
    const w = Math.round(ring.right - ring.left)
    const hgt = Math.round(ring.bottom - ring.top)
    const key = `${l},${t},${w},${hgt}`
    if (key === this.drawn) return
    this.drawn = key

    this.ring.style.transform = `translate3d(${l}px, ${t}px, 0)`
    this.ring.style.width = `${w}px`
    this.ring.style.height = `${hgt}px`
    this.ring.classList.add('on')

    if (!this.note.classList.contains('has-text')) return
    const vp = viewport(8)
    const { w: nw, h: nh } = this.noteSize
    let top = ring.bottom + 10
    if (top + nh > vp.bottom) top = ring.top - 10 - nh
    top = Math.min(Math.max(top, vp.top), Math.max(vp.top, vp.bottom - nh))
    const left = Math.min(Math.max(ring.left, vp.left), Math.max(vp.left, vp.right - nw))
    this.note.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
    this.note.classList.add('on')
  }

  private hideVisuals(): void {
    if (this.drawn === 'hidden') return
    this.drawn = 'hidden'
    this.ring.classList.remove('on')
    this.note.classList.remove('on')
  }
}

/** The part of `clip` not under `cover` (the step slider overlays the canvas from one side, usually the right) */
function uncovered(clip: Rect, cover: Rect): Rect | null {
  if (!hasArea(cover) || !intersects(clip, cover)) return clip
  if (cover.left > clip.left) return intersection(clip, { ...clip, right: cover.left })
  if (cover.right < clip.right) return intersection(clip, { ...clip, left: cover.right })
  return null
}

function fullyInViewport(el: Element): boolean {
  const r = rectOf(el)
  const vp = viewport()
  return r.top >= vp.top && r.bottom <= vp.bottom && r.left >= vp.left && r.right <= vp.right
}
