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
const HOVER_HIDE_DELAY_MS = 220

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

const CODE_ICON_SVG = `
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; display: block;">
  <polyline points="16 18 22 12 16 6"></polyline>
  <polyline points="8 6 2 12 8 18"></polyline>
</svg>
`

const CSS = `
:root {
  --vs-res-bg: #ffffff;
  --vs-res-text: #1a1b19;
  --vs-res-text-sec: #5f5e5b;
  --vs-res-border: rgba(0, 0, 0, 0.12);
  --vs-res-hover: rgba(0, 0, 0, 0.05);
  --vs-res-shadow: 0px 4px 16px rgba(0, 0, 0, 0.14);
  --vs-res-badge-bg: rgba(37, 99, 235, 0.08);
  --vs-res-badge-text: #2563eb;
  --vs-res-badge-border: rgba(37, 99, 235, 0.22);
}

@media (prefers-color-scheme: dark) {
  :root {
    --vs-res-bg: #1c2128;
    --vs-res-text: #f0f6fc;
    --vs-res-text-sec: #8b949e;
    --vs-res-border: #30363d;
    --vs-res-hover: rgba(255, 255, 255, 0.08);
    --vs-res-shadow: 0px 4px 16px rgba(0, 0, 0, 0.45);
    --vs-res-badge-bg: rgba(59, 130, 246, 0.16);
    --vs-res-badge-text: #60a5fa;
    --vs-res-badge-border: rgba(59, 130, 246, 0.35);
  }
}

html[data-theme='dark'], body[data-theme='dark'], html.dark, body.dark {
  --vs-res-bg: #1c2128;
  --vs-res-text: #f0f6fc;
  --vs-res-text-sec: #8b949e;
  --vs-res-border: #30363d;
  --vs-res-hover: rgba(255, 255, 255, 0.08);
  --vs-res-shadow: 0px 4px 16px rgba(0, 0, 0, 0.45);
  --vs-res-badge-bg: rgba(59, 130, 246, 0.16);
  --vs-res-badge-text: #60a5fa;
  --vs-res-badge-border: rgba(59, 130, 246, 0.35);
}

html[data-theme='light'], body[data-theme='light'], html.light, body.light {
  --vs-res-bg: #ffffff;
  --vs-res-text: #1a1b19;
  --vs-res-text-sec: #5f5e5b;
  --vs-res-border: rgba(0, 0, 0, 0.12);
  --vs-res-hover: rgba(0, 0, 0, 0.05);
  --vs-res-shadow: 0px 4px 16px rgba(0, 0, 0, 0.14);
  --vs-res-badge-bg: rgba(37, 99, 235, 0.08);
  --vs-res-badge-text: #2563eb;
  --vs-res-badge-border: rgba(37, 99, 235, 0.22);
}

.${COPY_BTN_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  margin: 0;
  font-family: var(--font-family-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  color: var(--col-text-secondary, var(--vs-res-text-sec));
  background: var(--col-surface-raised, var(--vs-res-bg));
  border: 1px solid var(--col-border, var(--vs-res-border));
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
}

.${COPY_BTN_CLASS}:hover {
  background: var(--col-action-hover, var(--vs-res-hover));
  color: var(--col-text-primary, var(--vs-res-text));
  border-color: var(--col-link, #3b82f6);
}

.${COPY_BTN_CLASS}.copied {
  color: #10b981 !important;
  border-color: rgba(16, 185, 129, 0.4) !important;
  background: rgba(16, 185, 129, 0.12) !important;
  transform: scale(1.02);
}

.${ARRAY_BADGE_CLASS} {
  position: absolute !important;
  top: 1px !important;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  height: 16px;
  font-family: var(--font-family-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  color: var(--vs-res-badge-text);
  background: var(--vs-res-badge-bg);
  border: 1px solid var(--vs-res-badge-border);
  border-radius: 9px;
  user-select: none;
  pointer-events: none;
  white-space: nowrap;
  z-index: 5;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

#${HOVER_PILL_ID} {
  position: fixed;
  z-index: 100000;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  font-family: var(--font-family-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  font-size: 11px;
  line-height: 1;
  background: var(--col-surface-raised, var(--vs-res-bg));
  border: 1px solid var(--col-border, var(--vs-res-border));
  border-radius: 5px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
  user-select: none;
  animation: vsResPillFade 0.12s cubic-bezier(0.16, 1, 0.3, 1);
  backdrop-filter: blur(8px);
}

@keyframes vsResPillFade {
  from { opacity: 0; transform: translateY(-2px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.vs-res-pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  padding: 0;
  color: var(--col-text-secondary, var(--vs-res-text-sec));
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s ease;
}

.vs-res-pill-btn:hover {
  background: var(--col-action-hover, var(--vs-res-hover));
  color: var(--col-text-primary, var(--vs-res-text));
}

.vs-res-pill-btn.copied {
  color: #10b981 !important;
  background: rgba(16, 185, 129, 0.15) !important;
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
  observer?: MutationObserver
}

function makeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Robust cross-platform clipboard copy */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** Parses standard formatted JSON into a line-by-line map of paths, values, and array counts */
export function parseJsonLines(jsonStr: string): Map<number, LineInfo> {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return new Map()
  }

  const lines = jsonStr.split(/\r?\n/)
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

      if (Array.isArray(val)) {
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
          isArray: true,
          arrayCount: val.length,
        })
        if (valPart === '[') {
          stack.push({
            type: 'array',
            path: fullPath,
            index: 0,
          })
        }
      } else if (val !== null && typeof val === 'object') {
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
        })
        if (valPart === '{') {
          stack.push({
            type: 'object',
            path: fullPath,
            index: 0,
          })
        }
      } else {
        lineMap.set(lineIdx + 1, {
          path: fullPath,
          key,
          value: val,
        })
      }
      continue
    }

    // Object inside an array: { or empty object on single line
    if (cur.type === 'array' && (line === '{}' || line === '{},')) {
      const idx = cur.index
      const fullPath = `${cur.path}[${idx}]`
      lineMap.set(lineIdx + 1, {
        path: fullPath,
        key: `[${idx}]`,
        value: resolveValue(fullPath),
      })
      cur.index++
      continue
    }

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

/** Fallback extractor: joins lines currently visible or contained in Monaco */
function extractRawTextFromMonaco(monacoEl: HTMLElement): string | null {
  const viewLines = monacoEl.querySelectorAll<HTMLElement>('.view-lines .view-line')
  if (viewLines.length > 0) {
    const lines: string[] = []
    for (const vl of viewLines) {
      lines.push(vl.textContent || '')
    }
    const joined = lines.join('\n').trim()
    if (joined.startsWith('{') || joined.startsWith('[')) {
      return joined
    }
  }
  return null
}

/**
 * Builds an executable JavaScript path ready to be used in JS code:
 * E.g. context?.res?.List_Row?.data?.[0]?.address
 * Or for trigger: context?.req?.body?.address, context?.req?.query?.name
 */
export function buildExecutablePath(relPath: string, headerLabel?: string | null, urlSlug?: string | null): string {
  const cleanLabel = (headerLabel || '').trim()
  const cleanSlug = (urlSlug || '').trim()

  const isTrigger = ['body', 'query', 'headers', 'attachment'].includes(cleanLabel.toLowerCase())

  let prefix = ''
  if (isTrigger) {
    prefix = `context?.req?.${cleanLabel.toLowerCase()}`
  } else {
    let stepName = cleanLabel || cleanSlug
    if (!stepName || stepName.toLowerCase() === 'response' || stepName.toLowerCase() === 'payload') {
      stepName = cleanSlug || 'step'
    }
    const safeStep = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stepName) ? stepName : JSON.stringify(stepName)
    prefix = safeStep.startsWith('"') ? `context?.res?.[${safeStep}]` : `context?.res?.${safeStep}`
  }

  if (!relPath) return prefix

  // Tokenize relative path (handles dot notation and bracket notation, e.g. "data[0].address")
  const tokens = relPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let result = prefix

  for (const token of tokens) {
    if (!Number.isNaN(Number(token))) {
      result += `?.[${token}]`
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) {
      result += `?.${token}`
    } else {
      result += `?.[${JSON.stringify(token)}]`
    }
  }

  return result
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
    if (textarea?.getAttribute('aria-readonly') === 'true' || textarea?.hasAttribute('readonly')) {
      return true
    }
    return false
  }

  async function loadEditorData(state: EditorState, force = false): Promise<void> {
    if ((state.rawJson && !force) || state.loading || dead) return
    state.loading = true
    try {
      let text = await bridge.getEditorText(state.editorId)
      if (!text) {
        text = extractRawTextFromMonaco(state.monacoEl)
      }
      if (typeof text === 'string' && text.length > 0) {
        state.rawJson = text
        state.lineMap = parseJsonLines(text)
        applyArrayBadges(state)
      }
    } finally {
      state.loading = false
    }
  }

  function getLineNumberForViewLine(monacoEl: HTMLElement, viewLine: HTMLElement): number {
    const vlTop = Math.round(parseFloat(viewLine.style.top || '0'))
    const vlRect = viewLine.getBoundingClientRect()

    const gutterNums = monacoEl.querySelectorAll<HTMLElement>('.margin-view-overlays .line-numbers')
    if (gutterNums.length === 0) return 0

    // 1. Match by row element style.top in gutter
    for (const g of gutterNums) {
      const rowEl = (g.closest('.margin-view-overlays > div') as HTMLElement) || g.parentElement || g
      const topStr = rowEl.style.top || g.style.top || ''
      if (topStr) {
        const topPx = Math.round(parseFloat(topStr))
        if (Math.abs(topPx - vlTop) <= 2) {
          const num = parseInt(g.textContent?.trim() || '0', 10)
          if (num > 0) return num
        }
      }
    }

    // 2. Match by bounding client rect Y / top (immune to coordinate system differences)
    for (const g of gutterNums) {
      const gRect = g.getBoundingClientRect()
      if (Math.abs(gRect.top - vlRect.top) <= 5) {
        const num = parseInt(g.textContent?.trim() || '0', 10)
        if (num > 0) return num
      }
    }

    // 3. Fallback: line height offset from first visible gutter element
    const firstGutter = gutterNums[0]
    if (firstGutter) {
      const firstLineNum = parseInt(firstGutter.textContent?.trim() || '0', 10)
      const firstRow = (firstGutter.closest('.margin-view-overlays > div') as HTMLElement) || firstGutter.parentElement || firstGutter
      const firstTop = Math.round(parseFloat(firstRow.style.top || firstGutter.style.top || '0'))
      const rowHeight = parseFloat(viewLine.style.height || '') || (gutterNums.length > 1 ? Math.round(parseFloat(((gutterNums[1]?.closest('.margin-view-overlays > div') as HTMLElement) || gutterNums[1]?.parentElement)?.style.top || '0') - firstTop) : 19)
      if (firstLineNum > 0 && rowHeight > 0) {
        const diffLines = Math.round((vlTop - firstTop) / rowHeight)
        const estimatedLine = firstLineNum + diffLines
        if (estimatedLine > 0) return estimatedLine
      }
    }

    return 0
  }

  let isApplyingBadges = false
  function applyArrayBadges(state: EditorState): void {
    if (isApplyingBadges || !state.lineMap || !state.monacoEl.isConnected) return
    isApplyingBadges = true

    try {
      // Find all visible .view-line elements inside Monaco
      const viewLines = state.monacoEl.querySelectorAll<HTMLElement>('.view-lines .view-line')
      if (viewLines.length === 0) return

      for (const vl of viewLines) {
        const lineText = vl.textContent || ''
        const existingBadge = vl.querySelector<HTMLElement>(`.${ARRAY_BADGE_CLASS}`)

        // Only lines that actually define an array can have an array count badge.
        // Lines with null, primitives, objects, or closing braces are strictly excluded.
        if (!lineText.includes('[') || lineText.includes('null') || lineText.includes('undefined')) {
          if (existingBadge) existingBadge.remove()
          continue
        }

        const lineNum = getLineNumberForViewLine(state.monacoEl, vl)
        if (!lineNum || lineNum <= 0) {
          if (existingBadge) existingBadge.remove()
          continue
        }

        const info = state.lineMap.get(lineNum)

        if (info && info.isArray && Array.isArray(info.value) && typeof info.arrayCount === 'number') {
          const text = `${info.arrayCount} ${info.arrayCount === 1 ? 'item' : 'items'}`

          // Calculate exact horizontal position right after the text of this line
          const vlRect = vl.getBoundingClientRect()
          let rightmost = 0
          const tokenSpans = vl.querySelectorAll('span:not(.' + ARRAY_BADGE_CLASS + ')')
          for (const t of tokenSpans) {
            const r = t.getBoundingClientRect()
            if (r.right > rightmost) rightmost = r.right
          }

          let leftPx = rightmost > vlRect.left ? Math.round(rightmost - vlRect.left + 8) : 0
          if (leftPx === 0) {
            const textSpan = vl.querySelector<HTMLElement>(':scope > span')
            if (textSpan && textSpan.offsetWidth > 0) {
              leftPx = textSpan.offsetLeft + textSpan.offsetWidth + 8
            } else {
              leftPx = Math.max(90, Math.round(lineText.length * 8.2 + 8))
            }
          }

          if (existingBadge) {
            if (existingBadge.textContent !== text) existingBadge.textContent = text
            if (leftPx > 0) existingBadge.style.left = `${leftPx}px`
          } else {
            const badge = document.createElement('span')
            badge.className = ARRAY_BADGE_CLASS
            badge.textContent = text
            badge.title = `${info.arrayCount} items in array`
            if (leftPx > 0) badge.style.left = `${leftPx}px`
            vl.appendChild(badge)
          }
        } else if (existingBadge) {
          existingBadge.remove()
        }
      }
    } finally {
      isApplyingBadges = false
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
    viewLine: HTMLElement,
    clientX: number
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

    const headerLabel =
      state.monacoEl.closest('.flex.flex-col')?.querySelector<HTMLElement>(
        '.flex.justify-between.items-center .MuiTypography-caption, .justify-between span, .justify-between p'
      )?.textContent?.trim() || ''

    const urlParams = new URLSearchParams(window.location.search)
    const urlSlug = urlParams.get('slugName') || urlParams.get('stepId') || ''

    const fullExecPath = buildExecutablePath(info.path || info.key, headerLabel, urlSlug)

    // Minimal Button 1: Copy Path (icon only)
    const copyPathBtn = document.createElement('button')
    copyPathBtn.type = 'button'
    copyPathBtn.className = 'vs-res-pill-btn'
    copyPathBtn.title = `Copy Path: ${fullExecPath}`
    copyPathBtn.setAttribute('aria-label', 'Copy Path')
    copyPathBtn.innerHTML = CODE_ICON_SVG

    copyPathBtn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      await copyText(fullExecPath)
      copyPathBtn.classList.add('copied')
      copyPathBtn.innerHTML = CHECK_ICON_SVG
      copyPathBtn.title = 'Path Copied!'
      setTimeout(() => {
        if (copyPathBtn.isConnected) {
          copyPathBtn.classList.remove('copied')
          copyPathBtn.innerHTML = CODE_ICON_SVG
          copyPathBtn.title = `Copy Path: ${fullExecPath}`
        }
      }, 1200)
    })
    pill.appendChild(copyPathBtn)

    // Minimal Button 2: Copy Value (icon only)
    const copyValBtn = document.createElement('button')
    copyValBtn.type = 'button'
    copyValBtn.className = 'vs-res-pill-btn'
    copyValBtn.title = 'Copy Value'
    copyValBtn.setAttribute('aria-label', 'Copy Value')
    copyValBtn.innerHTML = COPY_ICON_SVG

    copyValBtn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
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

      await copyText(valStr)
      copyValBtn.classList.add('copied')
      copyValBtn.innerHTML = CHECK_ICON_SVG
      copyValBtn.title = 'Value Copied!'
      setTimeout(() => {
        if (copyValBtn.isConnected) {
          copyValBtn.classList.remove('copied')
          copyValBtn.innerHTML = COPY_ICON_SVG
          copyValBtn.title = 'Copy Value'
        }
      }, 1200)
    })
    pill.appendChild(copyValBtn)

    // Position minimal pill right above or below the line near cursor
    const vlRect = viewLine.getBoundingClientRect()
    const monacoRect = state.monacoEl.getBoundingClientRect()

    let top = vlRect.top - 24
    if (top < monacoRect.top + 4) {
      top = vlRect.bottom + 2
    }

    let left = clientX - 25
    if (left + 54 > monacoRect.right - 6) {
      left = monacoRect.right - 60
    }
    if (left < monacoRect.left + 6) {
      left = monacoRect.left + 6
    }

    pill.style.top = `${Math.max(4, Math.round(top))}px`
    pill.style.left = `${Math.round(left)}px`

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
    let hoverShowTimer: number | undefined
    let pendingHoverLine: number | null = null

    function cancelHoverTimer(): void {
      if (hoverShowTimer !== undefined) {
        clearTimeout(hoverShowTimer)
        hoverShowTimer = undefined
      }
      pendingHoverLine = null
    }

    // 1. Mouse movement with slight settle delay (140ms) to avoid flashing pills during casual mouse travel
    monacoEl.addEventListener('mousemove', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const viewLine = target?.closest<HTMLElement>('.view-line')
      if (!viewLine) {
        cancelHoverTimer()
        scheduleCloseHoverPill()
        return
      }

      if (!state.lineMap) {
        void loadEditorData(state)
        return
      }

      // Resolve line number accurately from gutter or view-line position
      const lineNum = getLineNumberForViewLine(monacoEl, viewLine)

      if (lineNum <= 0) {
        cancelHoverTimer()
        scheduleCloseHoverPill()
        return
      }

      // If active pill is already showing for this exact line, keep it alive
      if (activeHoverLine === lineNum && activePill && activePill.isConnected) {
        if (hidePillTimer !== undefined) {
          clearTimeout(hidePillTimer)
          hidePillTimer = undefined
        }
        return
      }

      if (pendingHoverLine === lineNum && hoverShowTimer !== undefined) {
        return
      }

      cancelHoverTimer()
      pendingHoverLine = lineNum
      const clientX = e.clientX

      hoverShowTimer = window.setTimeout(() => {
        hoverShowTimer = undefined
        pendingHoverLine = null
        if (!monacoEl.isConnected) return

        const info = state.lineMap?.get(lineNum)
        if (info && (info.key || info.path)) {
          showHoverPill(state, lineNum, info, viewLine, clientX)
        } else {
          scheduleCloseHoverPill()
        }
      }, 140)
    })

    monacoEl.addEventListener('mouseleave', () => {
      cancelHoverTimer()
      scheduleCloseHoverPill()
    })

    // 2. Click listener on editor (e.g. folding/unfolding arrays) to reposition badges
    monacoEl.addEventListener('click', () => {
      cancelHoverTimer()
      requestAnimationFrame(() => applyArrayBadges(state))
    })

    // 3. Immediately dismiss hover pill on scroll or wheel in editor
    const dismissOnScroll = (): void => {
      cancelHoverTimer()
      closeHoverPill()
    }

    monacoEl.addEventListener('wheel', dismissOnScroll, { passive: true })

    const scrollContainer = monacoEl.querySelector<HTMLElement>('.monaco-scrollable-element')
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', () => {
        dismissOnScroll()
        applyArrayBadges(state)
      }, { passive: true })
    }

    // 4. MutationObserver on .view-lines to ensure array count badges ALWAYS stay visible
    const viewLinesEl = monacoEl.querySelector('.view-lines')
    if (viewLinesEl) {
      const mo = new MutationObserver(() => {
        applyArrayBadges(state)
      })
      mo.observe(viewLinesEl, { childList: true, subtree: true })
      state.observer = mo
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

      // 1. Fetch fresh text if needed
      let textToCopy = state.rawJson
      if (!textToCopy) {
        textToCopy = (await bridge.getEditorText(state.editorId)) || extractRawTextFromMonaco(state.monacoEl) || undefined
        if (textToCopy) {
          state.rawJson = textToCopy
          state.lineMap = parseJsonLines(textToCopy)
          applyArrayBadges(state)
        }
      }

      // 2. Perform clipboard copy
      if (textToCopy) {
        await copyText(textToCopy)
      }

      // 3. Play Copied animation
      btn.classList.add('copied')
      btn.innerHTML = `${CHECK_ICON_SVG}<span>Copied!</span>`
      setTimeout(() => {
        if (btn.isConnected) {
          btn.classList.remove('copied')
          btn.innerHTML = `${COPY_ICON_SVG}<span>Copy Response</span>`
        }
      }, 1800)
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
    for (const [el, s] of editors) {
      if (!el.isConnected) {
        s.observer?.disconnect()
        editors.delete(el)
      }
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

  const handleGlobalScroll = (): void => {
    closeHoverPill()
  }
  window.addEventListener('scroll', handleGlobalScroll, { capture: true, passive: true })

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
      window.removeEventListener('scroll', handleGlobalScroll, { capture: true })
      if (scanTimer !== undefined) clearTimeout(scanTimer)
      if (hidePillTimer !== undefined) clearTimeout(hidePillTimer)
      closeHoverPill()
      for (const [el, s] of editors) {
        s.observer?.disconnect()
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
