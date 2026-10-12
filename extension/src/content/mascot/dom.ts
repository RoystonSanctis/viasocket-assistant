// Tiny DOM builders. Dynamic strings only ever go through textContent / setAttribute, never innerHTML,
// so text from the model, the page or the network can never turn into markup.

type AttrValue = string | number | boolean | undefined
type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (name === 'class') el.className = String(value)
    else if (name === 'text') el.textContent = String(value)
    else el.setAttribute(name, value === true ? '' : String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child)
  }
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// Static path data (24x24 viewBox). Never built from runtime input.
const ICONS = {
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z',
  send: 'M3.4 20.4 21 12 3.4 3.6v6.5L15 12 3.4 13.9z',
  stop: 'M7 7h10v10H7z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
} as const

export type IconName = keyof typeof ICONS

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name])
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}

export function iconButton(name: IconName, label: string, className = 'icon-btn'): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: className, 'aria-label': label, title: label })
  btn.append(icon(name))
  return btn
}

export function isEditable(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !NON_TEXT_INPUTS.has(el.type)
  }
  return el instanceof HTMLElement && el.isContentEditable
}

const NON_TEXT_INPUTS = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
])
