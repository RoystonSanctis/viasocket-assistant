// Viewport-space rectangle helpers. Everything the mascot draws is position:fixed, so client rects are enough.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Point {
  x: number
  y: number
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

export function viewport(margin = 0): Rect {
  const w = document.documentElement.clientWidth || window.innerWidth
  const h = document.documentElement.clientHeight || window.innerHeight
  return { left: margin, top: margin, right: w - margin, bottom: h - margin }
}

export function hasArea(r: Rect): boolean {
  return r.right - r.left > 1 && r.bottom - r.top > 1
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return hasArea(r) ? r : null
}

export function inflate(r: Rect, d: number): Rect {
  return { left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d }
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom
}

/** Box of a square of `size` whose top-left corner is `p` */
export function boxAt(p: Point, size: number): Rect {
  return { left: p.x, top: p.y, right: p.x + size, bottom: p.y + size }
}

/** Keeps a `size` square with top-left `p` inside `bounds` */
export function clampPoint(p: Point, size: number, bounds: Rect): Point {
  return {
    x: Math.min(Math.max(p.x, bounds.left), Math.max(bounds.left, bounds.right - size)),
    y: Math.min(Math.max(p.y, bounds.top), Math.max(bounds.top, bounds.bottom - size)),
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function center(r: Rect): Point {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
}
