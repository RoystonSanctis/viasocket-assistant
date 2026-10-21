// A small "Beautify" button on viaSocket's Monaco code editors: JS steps, API bodies, Developer Hub code and any other
// editable JavaScript or JSON editor. It shows in the editor's top-right corner while the pointer is over the editor,
// and formats the code only when clicked. The MAIN-world hook does the formatting next to the editor (the code never
// crosses postMessage) as one undoable edit that the app treats like typing; this file only places the button and
// reports the outcome. Dynamic text is set with textContent; the static SVG below is the only markup.

import { EDITOR_ID_ATTR, type EditorActionResult } from '../shared/messages'
import type { PageBridge } from './page-bridge'
import { showToast } from './toast'

const STYLE_ID = 'vs-beautify-styles'
const BTN_CLASS = 'vs-beautify-btn'
const LABEL = 'Beautify'
const SCAN_DELAY_MS = 300
/** Whether an editor is editable can change (e.g. a Developer Hub version gets published); re-asked on hover */
const RECHECK_MS = 1500
const FEEDBACK_MS = 1600

// Static markup only — never interpolate data into this.
const ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="5" x2="20" y2="5"></line><line x1="10" y1="12" x2="20" y2="12"></line><line x1="10" y1="19" x2="20" y2="19"></line><polyline points="4 10 6.5 12.5 4 15"></polyline></svg>`

// viaSocket's own tokens (light and dark themes set them), with its light values as fallbacks.
const CSS = `
button.${BTN_CLASS} {
  position: absolute; top: 6px; right: 18px; z-index: 12;
  display: inline-flex; align-items: center; gap: 5px; height: 22px; margin: 0; padding: 0 8px;
  border: 1px solid var(--col-control-edge, rgba(26, 27, 25, 0.16)); border-radius: 6px;
  background: var(--col-surface-raised, #ffffff); color: var(--col-text-secondary, #3f3f3a);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif);
  font-size: 11.5px; font-weight: 500; line-height: 1; white-space: nowrap; user-select: none; cursor: pointer;
  opacity: 0; pointer-events: none; transition: opacity 0.12s ease, background-color 0.12s ease;
}
button.${BTN_CLASS}[data-ready], button.${BTN_CLASS}[data-feedback] { pointer-events: auto; }
:hover > button.${BTN_CLASS}[data-ready], button.${BTN_CLASS}[data-ready]:focus-visible, button.${BTN_CLASS}[data-feedback] { opacity: 1; }
button.${BTN_CLASS}:hover { background: var(--col-control-hover, #f1f0ec); }
button.${BTN_CLASS}:focus-visible { outline: 2px solid var(--col-control-edge, rgba(26, 27, 25, 0.16)); outline-offset: 1px; }
button.${BTN_CLASS} svg { flex-shrink: 0; }
`

interface Entry {
  id: string
  host: HTMLElement
  button: HTMLButtonElement
  label: HTMLElement
  checkedAt: number
  checking: boolean
  busy: boolean
  feedbackTimer?: number
  onEnter: () => void
}

export interface BeautifyController {
  destroy(): void
}

function makeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mutations inside an editor (typing) or our own button never add or remove an editor */
function irrelevant(target: Node): boolean {
  const el = target instanceof Element ? target : target.parentElement
  return !!el?.closest(`.monaco-editor, .${BTN_CLASS}`)
}

export function initBeautify(bridge: PageBridge): BeautifyController {
  const entries = new Map<HTMLElement, Entry>()
  let scanTimer: number | undefined
  let dead = false

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  async function check(entry: Entry): Promise<void> {
    if (entry.checking || dead) return
    entry.checking = true
    try {
      const result = await bridge.editorAction(entry.id, 'check')
      if (result === null) return // the hook did not answer (yet); ask again on the next hover
      entry.checkedAt = Date.now()
      entry.button.toggleAttribute('data-ready', result === 'ready')
    } finally {
      entry.checking = false
    }
  }

  function feedback(entry: Entry, text: string): void {
    clearTimeout(entry.feedbackTimer)
    entry.label.textContent = text
    entry.button.setAttribute('data-feedback', '')
    entry.feedbackTimer = window.setTimeout(() => {
      entry.label.textContent = LABEL
      entry.button.removeAttribute('data-feedback')
    }, FEEDBACK_MS)
  }

  async function beautify(entry: Entry): Promise<void> {
    if (entry.busy || dead) return
    entry.busy = true
    let result: EditorActionResult | null = null
    try {
      result = await bridge.editorAction(entry.id, 'beautify')
    } finally {
      entry.busy = false
    }
    if (dead) return
    switch (result) {
      case 'formatted':
        feedback(entry, 'Beautified')
        break
      case 'unchanged':
        feedback(entry, 'Already tidy')
        break
      case 'read-only':
        entry.button.removeAttribute('data-ready')
        feedback(entry, 'Read-only')
        break
      case 'unsupported':
        entry.button.removeAttribute('data-ready')
        break
      case 'unsafe':
        feedback(entry, 'Not changed')
        showToast({
          type: 'info',
          title: "Couldn't beautify this code",
          message: 'It may have a syntax error, or formatting would change how it runs. Nothing was changed.',
        })
        break
      case 'too-large':
        feedback(entry, 'Not changed')
        showToast({ type: 'info', title: "Couldn't beautify this code", message: 'It is too large to format here.' })
        break
      default:
        feedback(entry, 'Not changed')
        showToast({
          type: 'error',
          title: "Couldn't beautify this code",
          message: bridge.ready ? 'The editor did not respond. Try again.' : 'Reload the page and try again.',
        })
    }
  }

  function attach(editorEl: HTMLElement): void {
    // @monaco-editor/react: <section style="position: relative"> > <div container> > .monaco-editor
    const host = editorEl.parentElement?.parentElement
    if (!host || getComputedStyle(host).position === 'static') return
    const id = editorEl.getAttribute(EDITOR_ID_ATTR) || makeId()
    editorEl.setAttribute(EDITOR_ID_ATTR, id)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = BTN_CLASS
    button.title = 'Re-indent and format this code (Ctrl/Cmd+Z undoes it)'
    button.setAttribute('aria-label', 'Beautify code')
    const icon = document.createElement('span')
    icon.style.cssText = 'display: inline-flex;'
    icon.innerHTML = ICON
    const label = document.createElement('span')
    label.textContent = LABEL
    button.append(icon, label)

    const entry: Entry = { id, host, button, label, checkedAt: 0, checking: false, busy: false, onEnter: () => {} }
    entry.onEnter = () => {
      if (Date.now() - entry.checkedAt > RECHECK_MS) void check(entry)
    }

    // The page must not see these events (wrapper click handlers, click-away listeners), and mousedown must not move
    // focus out of the editor.
    const stop = (e: Event): void => e.stopPropagation()
    for (const type of ['pointerdown', 'pointerup', 'mouseup', 'dblclick'] as const) button.addEventListener(type, stop)
    button.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void beautify(entry)
    })

    host.addEventListener('pointerenter', entry.onEnter)
    host.appendChild(button)
    entries.set(editorEl, entry)
    void check(entry)
  }

  function detach(editorEl: HTMLElement, entry: Entry): void {
    clearTimeout(entry.feedbackTimer)
    entry.host.removeEventListener('pointerenter', entry.onEnter)
    entry.button.remove()
    entries.delete(editorEl)
  }

  function scan(): void {
    scanTimer = undefined
    if (dead) return
    for (const [el, entry] of entries) {
      if (!el.isConnected || !entry.button.isConnected) detach(el, entry)
    }
    for (const el of document.querySelectorAll<HTMLElement>('.monaco-editor')) {
      if (entries.has(el)) continue
      // Monaco's own nested editors (peek views) and diff editors are not the app's editors.
      if (el.parentElement?.closest('.monaco-editor') || el.closest('.monaco-diff-editor')) continue
      attach(el)
    }
  }

  const observer = new MutationObserver((records) => {
    if (scanTimer !== undefined || dead) return
    if (records.every((r) => irrelevant(r.target))) return
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return {
    destroy() {
      dead = true
      observer.disconnect()
      clearTimeout(scanTimer)
      for (const [el, entry] of [...entries]) {
        detach(el, entry)
        el.removeAttribute(EDITOR_ID_ATTR)
      }
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
