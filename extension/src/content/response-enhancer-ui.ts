// Response Enhancer UI Controller:
// 1. Adds "Copy Response" button on all response / console / payload blocks across viaSocket.
// 2. On key hover in any response block, displays floating "Copy Path" and "Copy Value" actions with path preview.
// 3. Mentions array item counts inline next to arrays (e.g. "data: [ 2 items ]") and in hover inspection.
//
// Supports all response blocks: Action steps, Get Data, JS Code, Webhooks, API steps, Console & Payload tabs.
// Fully supports light and dark themes with viaSocket semantic tokens.

import { EDITOR_ID_ATTR } from '../shared/messages'
import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-response-enhancer-styles'
const COPY_BTN_CLASS = 'vs-response-copy-btn'
const ARRAY_BADGE_CLASS = 'vs-response-array-badge'
const HOVER_PILL_ID = 'vs-response-hover-pill'
const SCAN_DELAY_MS = 250
const HOVER_HIDE_DELAY_MS = 280

// Static SVG Icons
const COPY_ICON_SVG = `
<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; display: block;">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
</svg>
`

const CHECK_ICON_SVG = `
<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; display: block;">
  <polyline points="20 6 9 17 4 12"></polyline>
</svg>
`

const KEY_ICON_SVG = `
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; display: block; opacity: 0.75;">
  <path d="M21 2l-2 2m-1.5 1.5L16 7l-1.5-1.5M19 4l-4 4m-3.5 3.5a5 5 0 1 1-7-7 5 5 0 0 1 7 7z"></path>
</svg>
`

const CSS = `
:root {
  --vs-res-bg: #ffffff;
  --vs-res-text: #1a1b19;
  --vs-res-text-sec: #5f5e5b;
  --vs-res-border: rgba(0, 0, 0, 0.12);
  --vs-res-hover: rgba(0, 0, 0, 0.05);
  --vs-res-shadow: 0px 4px 14px rgba(0, 0, 0, 0.12);
  --vs-res-badge-bg: rgba(37, 99, 235, 0.08);
  --vs-res-badge-text: #2563eb;
  --vs-res-badge-border: rgba(37, 99, 235, 0.2);
}

@media (prefers-color-scheme: dark) {
  :root {
    --vs-res-bg: #1c2128;
    --vs-res-text: #f0f6fc;
    --vs-res-text-sec: #8b949e;
    --vs-res-border: #30363d;
    --vs-res-hover: rgba(255, 255, 255, 0.08);
    --vs-res-shadow: 0px 4px 14px rgba(0, 0, 0, 0.45);
    --vs-res-badge-bg: rgba(59, 130, 246, 0.15);
    --vs-res-badge-text: #60a5fa;
    --vs-res-badge-border: rgba(59, 130, 246, 0.3);
  }
}

html[data-theme='dark'], body[data-theme='dark'], html.dark, body.dark {
  --vs-res-bg: #1c2128;
  --vs-res-text: #f0f6fc;
  --vs-res-text-sec: #8b949e;
  --vs-res-border: #30363d;
  --vs-res-hover: rgba(255, 255, 255, 0.08);
  --vs-res-shadow: 0px 4px 14px rgba(0, 0, 0, 0.45);
  --vs-res-badge-bg: rgba(59, 130, 246, 0.15);
  --vs-res-badge-text: #60a5fa;
  --vs-res-badge-border: rgba(59, 130, 246, 0.3);
}

html[data-theme='light'], body[data-theme='light'], html.light, body.light {
  --vs-res-bg: #ffffff;
  --vs-res-text: #1a1b19;
  --vs-res-text-sec: #5f5e5b;
  --vs-res-border: rgba(0, 0, 0, 0.12);
  --vs-res-hover: rgba(0, 0, 0, 0.05);
  --vs-res-shadow: 0px 4px 14px rgba(0, 0, 0, 0.12);
  --vs-res-badge-bg: rgba(37, 99, 235, 0.08);
  --vs-res-badge-text: #2563eb;
  --vs-res-badge-border: rgba(37, 99, 235, 0.2);
}

.${COPY_BTN_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  margin: 0;
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  color: var(--col-text-secondary, var(--vs-res-text-sec));
  background: var(--col-surface-raised, var(--vs-res-bg));
  border: 1px solid var(--col-border, var(--vs-res-border));
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: all 0.12s ease;
  white-space: nowrap;
}

.${COPY_BTN_CLASS}:hover {
  background: var(--col-action-hover, var(--vs-res-hover));
  color: var(--col-text-primary, var(--vs-res-text));
  border-color: var(--col-link, #3b82f6);
}

.${COPY_BTN_CLASS}.copied {
  color: #10b981;
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.08);
}

.${ARRAY_BADGE_CLASS} {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  padding: 0 6px;
  height: 16px;
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  color: var(--vs-res-badge-text);
  background: var(--vs-res-badge-bg);
  border: 1px solid var(--vs-res-badge-border);
  border-radius: 10px;
  user-select: none;
  pointer-events: none;
  vertical-align: middle;
}

#${HOVER_PILL_ID} {
  position: fixed;
  z-index: 100000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 11px;
  line-height: 1;
  background: var(--col-surface-raised, var(--vs-res-bg));
  color: var(--col-text-primary, var(--vs-res-text));
  border: 1px solid var(--col-border, var(--vs-res-border));
  border-radius: 6px;
  box-shadow: var(--vs-res-shadow);
  pointer-events: auto;
  user-select: none;
  animation: vsResPillFade 0.1s ease-out;
}

@keyframes vsResPillFade {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

.vs-res-pill-path {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--col-text-primary, var(--vs-res-text));
  font-weight: 600;
  padding-right: 2px;
}

.vs-res-pill-count {
  font-size: 10px;
  font-weight: 500;
  color: var(--vs-res-badge-text);
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--vs-res-badge-bg);
}

.vs-res-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--col-text-secondary, var(--vs-res-text-sec));
  background: transparent;
  border: 1px solid var(--col-border, var(--vs-res-border));
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s ease;
}

.vs-res-pill-btn:hover {
  background: var(--col-action-hover, var(--vs-res-hover));
  color: var(--col-text-primary, var(--vs-res-text));
  border-color: var(--col-link, #3b82f6);
}

.vs-res-pill-btn.copied {
  color: #10b981;
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.08);
}
`

export interface ResponseEnhancerController {
  destroy(): void
}

interface LineInfo {
  path: string
  key: string
  value: unknown
  isArray?: boolean
  arrayCount?: number
}

interface EditorState {
  editorId: string
  monacoEl: HTMLElement
  rawJson?: string
  lineMap?: Map<number, LineInfo>
  loading?: boolean
}

function makeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Parses standard formatted JSON into a line-by-line map of paths, values, and array counts */
export function parseJsonLines(jsonStr: string): Map<number, LineInfo> {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return new Map()
  }

  const lines = jsonStr.split('\n')
  const lineMap = new Map<number, LineInfo>()

  const stack: Array<{ type: 'object' | 'array'; path: string; index: number }> = [
    { type: Array.isArray(parsed) ? 'array' : 'object', path: '', index: 0 },
  ]

  function resolveValue(path: string): unknown {
    if (!path) return parsed
    const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    let cur: any = parsed
    for (const t of tokens) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[t]
    }
    return cur
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx] ?? ''
    const line = rawLine.trim()
    if (!line) continue

    // Root opening bracket / brace
    if (lineIdx === 0 && (line === '{' || line === '[')) {
      if (Array.isArray(parsed)) {
        lineMap.set(1, {
          path: '',
          key: 'response',
          value: parsed,
          isArray: true,
          arrayCount: parsed.length,
        })
      }
      continue
    }

    const cur = stack[stack.length - 1]
    if (!cur) break

    // Closing brace or bracket
    if (line === '}' || line === '},' || line === ']' || line === '],') {
      stack.pop()
      const parent = stack[stack.length - 1]
      if (parent && parent.type === 'array') {
        parent.index++
      }
      continue
    }

    // Property line: "key": value
    const propMatch = line.match(/^"([^"]+)":\s*(.*)$/)
    if (propMatch) {
      const key = propMatch[1] ?? ''
      let valPart = (propMatch[2] ?? '').trim()
      if (valPart.endsWith(',')) valPart = valPart.slice(0, -1).trim()

      const fullPath = cur.path ? `${cur.path}.${key}` : key
      const val = resolveValue(fullPath)

      if (valPart === '[') {
        const count = Array.isArray(val) ? val.length : 0
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
          isArray: true,
          arrayCount: count,
        })
        stack.push({
          type: 'array',
          path: fullPath,
          index: 0,
        })
      } else if (valPart === '{') {
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
        })
        stack.push({
          type: 'object',
          path: fullPath,
          index: 0,
        })
      } else {
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
        })
      }
      continue
    }

    // Object inside an array: {
    if (cur.type === 'array' && (line === '{' || line === '{\r')) {
      const idx = cur.index
      const fullPath = `${cur.path}[${idx}]`
      stack.push({
        type: 'object',
        path: fullPath,
        index: 0,
      })
      continue
    }

    // Primitive element inside an array
    if (cur.type === 'array') {
      const idx = cur.index
      const fullPath = `${cur.path}[${idx}]`
      const val = resolveValue(fullPath)
      lineMap.set(lineIdx + 1, {
        path: fullPath,
        key: `[${idx}]`,
        value: val,
      })
      cur.index++
    }
  }

  return lineMap
}

export function initResponseEnhancerUI(bridge: PageBridge): ResponseEnhancerController {
  const editors = new Map<HTMLElement, EditorState>()
  let scanTimer: number | undefined
  let hidePillTimer: number | undefined
  let activePill: HTMLElement | null = null
  let activeHoverLine: number | null = null
  let dead = false

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function isResponseViewer(el: HTMLElement): boolean {
    if (
      el.closest(
        '[role="tabpanel"], [id*="tabpanel"], [aria-labelledby*="simple-tab-"], [class*="responseAndConsole"], [class*="responseFlowData"], [class*="JsonViewer"], .json-viewer, [class*="ReadOnlyMonaco"], [data-testid*="response"], [data-testid*="console"], [data-testid*="payload"]'
      )
    ) {
      return true
    }
    const textarea = el.querySelector('textarea')
    if (textarea?.getAttribute('aria-readonly') === 'true') {
      return true
    }
    return false
  }

  async function loadEditorData(state: EditorState, force = false): Promise<void> {
    if ((state.rawJson && !force) || state.loading || dead) return
    state.loading = true
    try {
      const text = await bridge.getEditorText(state.editorId)
      if (typeof text === 'string' && text.length > 0) {
        state.rawJson = text
        state.lineMap = parseJsonLines(text)
        applyArrayBadges(state)
      }
    } finally {
      state.loading = false
    }
  }

  function applyArrayBadges(state: EditorState): void {
    if (!state.lineMap || !state.monacoEl.isConnected) return

    // Find all visible .view-line elements inside Monaco
    const viewLines = state.monacoEl.querySelectorAll<HTMLElement>('.view-lines .view-line')
    if (viewLines.length === 0) return

    // Build map of topPx -> line number from line-numbers gutter
    const gutterNums = state.monacoEl.querySelectorAll<HTMLElement>('.margin-view-overlays .line-numbers')
    const lineByTop = new Map<string, number>()
    for (const g of gutterNums) {
      const lineNum = parseInt(g.textContent?.trim() || '0', 10)
      if (lineNum > 0 && g.style.top) {
        lineByTop.set(g.style.top, lineNum)
      }
    }

    for (const vl of viewLines) {
      const lineNum = lineByTop.get(vl.style.top) ?? (vl.style.top ? Math.round(parseFloat(vl.style.top) / 18) + 1 : 0)
      if (lineNum <= 0) continue

      const info = state.lineMap.get(lineNum)
      const existingBadge = vl.querySelector(`.${ARRAY_BADGE_CLASS}`)

      if (info && info.isArray && typeof info.arrayCount === 'number') {
        const text = `${info.arrayCount} ${info.arrayCount === 1 ? 'item' : 'items'}`
        if (existingBadge) {
          if (existingBadge.textContent !== text) existingBadge.textContent = text
        } else {
          const badge = document.createElement('span')
          badge.className = ARRAY_BADGE_CLASS
          badge.textContent = text
          vl.appendChild(badge)
        }
      } else if (existingBadge) {
        existingBadge.remove()
      }
    }
  }

  function closeHoverPill(): void {
    if (activePill) {
      activePill.remove()
      activePill = null
    }
    activeHoverLine = null
  }

  function scheduleCloseHoverPill(): void {
    if (hidePillTimer !== undefined) clearTimeout(hidePillTimer)
    hidePillTimer = window.setTimeout(closeHoverPill, HOVER_HIDE_DELAY_MS)
  }

  function showHoverPill(
    state: EditorState,
    lineNum: number,
    info: LineInfo,
    viewLine: HTMLElement
  ): void {
    if (hidePillTimer !== undefined) {
      clearTimeout(hidePillTimer)
      hidePillTimer = undefined
    }

    if (activeHoverLine === lineNum && activePill && activePill.isConnected) {
      return
    }

    closeHoverPill()
    activeHoverLine = lineNum

    const pill = document.createElement('div')
    pill.id = HOVER_PILL_ID

    // Path preview badge
    const pathSpan = document.createElement('span')
    pathSpan.className = 'vs-res-pill-path'
    pathSpan.innerHTML = `${KEY_ICON_SVG}<span>${info.path || info.key}</span>`
    pathSpan.title = info.path || info.key
    pill.appendChild(pathSpan)

    // Array count indicator
    if (info.isArray && typeof info.arrayCount === 'number') {
      const countSpan = document.createElement('span')
      countSpan.className = 'vs-res-pill-count'
      countSpan.textContent = `${info.arrayCount} ${info.arrayCount === 1 ? 'item' : 'items'}`
      pill.appendChild(countSpan)
    }

    // Copy Path button
    const copyPathBtn = document.createElement('button')
    copyPathBtn.type = 'button'
    copyPathBtn.className = 'vs-res-pill-btn'
    copyPathBtn.title = `Copy path: ${info.path || info.key}`
    copyPathBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy Path</span>`

    copyPathBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pathToCopy = info.path || info.key
      try {
        await navigator.clipboard.writeText(pathToCopy)
        copyPathBtn.classList.add('copied')
        copyPathBtn.innerHTML = `${CHECK_ICON_SVG}<span>Path Copied!</span>`
        setTimeout(() => {
          if (copyPathBtn.isConnected) {
            copyPathBtn.classList.remove('copied')
            copyPathBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy Path</span>`
          }
        }, 1500)
      } catch {
        // clipboard access failure fallback
      }
    })
    pill.appendChild(copyPathBtn)

    // Copy Value button
    const copyValBtn = document.createElement('button')
    copyValBtn.type = 'button'
    copyValBtn.className = 'vs-res-pill-btn'
    copyValBtn.title = 'Copy value'
    copyValBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy Value</span>`

    copyValBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      let valStr: string
      if (typeof info.value === 'string') {
        valStr = info.value
      } else if (info.value === null) {
        valStr = 'null'
      } else if (typeof info.value === 'object') {
        try {
          valStr = JSON.stringify(info.value, null, 2)
        } catch {
          valStr = String(info.value)
        }
      } else {
        valStr = String(info.value)
      }

      try {
        await navigator.clipboard.writeText(valStr)
        copyValBtn.classList.add('copied')
        copyValBtn.innerHTML = `${CHECK_ICON_SVG}<span>Value Copied!</span>`
        setTimeout(() => {
          if (copyValBtn.isConnected) {
            copyValBtn.classList.remove('copied')
            copyValBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy Value</span>`
          }
        }, 1500)
      } catch {
        // clipboard fallback
      }
    })
    pill.appendChild(copyValBtn)

    // Position pill right at the line
    const vlRect = viewLine.getBoundingClientRect()
    const monacoRect = state.monacoEl.getBoundingClientRect()

    pill.style.top = `${Math.max(4, vlRect.top - 2)}px`
    pill.style.right = `${window.innerWidth - monacoRect.right + 12}px`

    pill.addEventListener('mouseenter', () => {
      if (hidePillTimer !== undefined) {
        clearTimeout(hidePillTimer)
        hidePillTimer = undefined
      }
    })

    pill.addEventListener('mouseleave', () => {
      scheduleCloseHoverPill()
    })

    document.body.appendChild(pill)
    activePill = pill
  }

  function attachEditorHandlers(state: EditorState): void {
    const { monacoEl } = state

    // 1. Mouse movement to detect hovered line
    monacoEl.addEventListener('mousemove', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const viewLine = target?.closest<HTMLElement>('.view-line')
      if (!viewLine) return

      if (!state.lineMap) {
        void loadEditorData(state)
        return
      }

      // Resolve line number from gutter
      const gutterNums = monacoEl.querySelectorAll<HTMLElement>('.margin-view-overlays .line-numbers')
      let lineNum = 0
      for (const g of gutterNums) {
        if (g.style.top === viewLine.style.top) {
          lineNum = parseInt(g.textContent?.trim() || '0', 10)
          break
        }
      }
      if (lineNum <= 0 && viewLine.style.top) {
        lineNum = Math.round(parseFloat(viewLine.style.top) / 18) + 1
      }

      if (lineNum > 0) {
        const info = state.lineMap.get(lineNum)
        if (info && (info.key || info.path)) {
          showHoverPill(state, lineNum, info, viewLine)
        }
      }
    })

    monacoEl.addEventListener('mouseleave', () => {
      scheduleCloseHoverPill()
    })

    // 2. Scroll listener to keep array badges positioned
    const scrollContainer = monacoEl.querySelector<HTMLElement>('.monaco-scrollable-element')
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', () => {
        applyArrayBadges(state)
      }, { passive: true })
    }
  }

  function attachCopyResponseButton(state: EditorState): void {
    const { monacoEl } = state

    // Check if copy button already mounted
    if (
      monacoEl.parentElement?.querySelector(`.${COPY_BTN_CLASS}`) ||
      monacoEl.closest('.flex.flex-col')?.querySelector(`.${COPY_BTN_CLASS}`)
    ) {
      return
    }

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = COPY_BTN_CLASS
    btn.title = 'Copy response JSON'
    btn.setAttribute('data-testid', 'copy-response-button')
    btn.innerHTML = `${COPY_ICON_SVG}<span>Copy Response</span>`

    btn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()

      // Fetch fresh text if needed
      await loadEditorData(state, true)
      const textToCopy = state.rawJson

      if (textToCopy) {
        try {
          await navigator.clipboard.writeText(textToCopy)
          btn.classList.add('copied')
          btn.innerHTML = `${CHECK_ICON_SVG}<span>Copied!</span>`
          setTimeout(() => {
            if (btn.isConnected) {
              btn.classList.remove('copied')
              btn.innerHTML = `${COPY_ICON_SVG}<span>Copy Response</span>`
            }
          }, 1800)
        } catch {
          // ignore
        }
      }
    })

    // Try finding the header row in JsonViewer
    const headerRow = monacoEl.closest('.flex.flex-col')?.querySelector<HTMLElement>(
      '.flex.justify-between.items-center, .justify-between'
    )

    if (headerRow) {
      headerRow.appendChild(btn)
    } else {
      // Floating button in top-right of Monaco container
      btn.style.position = 'absolute'
      btn.style.top = '6px'
      btn.style.right = '14px'
      btn.style.zIndex = '10'
      const parent = monacoEl.parentElement || monacoEl
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'
      }
      parent.appendChild(btn)
    }
  }

  function scan(): void {
    scanTimer = undefined
    if (dead) return

    // Clean up disconnected editors
    for (const [el] of editors) {
      if (!el.isConnected) editors.delete(el)
    }

    // Query all Monaco editors across the document
    const allMonaco = document.querySelectorAll<HTMLElement>('.monaco-editor')

    for (const monacoEl of allMonaco) {
      if (monacoEl.parentElement?.closest('.monaco-editor') || monacoEl.closest('.monaco-diff-editor')) {
        continue
      }

      // Check if this editor is in a response, console, or read-only output panel
      if (!isResponseViewer(monacoEl)) {
        continue
      }

      let state = editors.get(monacoEl)
      if (!state) {
        let editorId = monacoEl.getAttribute(EDITOR_ID_ATTR)
        if (!editorId) {
          editorId = makeId()
          monacoEl.setAttribute(EDITOR_ID_ATTR, editorId)
        }

        state = {
          editorId,
          monacoEl,
        }
        editors.set(monacoEl, state)
        attachEditorHandlers(state)
      }

      attachCopyResponseButton(state)
      void loadEditorData(state)
    }
  }

  const observer = new MutationObserver(() => {
    if (scanTimer !== undefined || dead) return
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS)
  })

  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return {
    destroy() {
      dead = true
      observer.disconnect()
      if (scanTimer !== undefined) clearTimeout(scanTimer)
      if (hidePillTimer !== undefined) clearTimeout(hidePillTimer)
      closeHoverPill()
      for (const [el] of editors) {
        el.closest('.flex.flex-col')?.querySelector(`.${COPY_BTN_CLASS}`)?.remove()
        el.parentElement?.querySelector(`.${COPY_BTN_CLASS}`)?.remove()
        for (const badge of el.querySelectorAll(`.${ARRAY_BADGE_CLASS}`)) {
          badge.remove()
        }
      }
      editors.clear()
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
