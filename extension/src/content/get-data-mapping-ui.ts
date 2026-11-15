// Implements the native viaSocket cascading hover mapping menu for Get Data (CRON_PRE_PROCESS):
// 1. App Actions in Get Data: injects [+] AddBoxTwoTone button on custom mapping fields.
// 2. JS Code in Get Data: injects (+) Data chip on Monaco code editor toolbar, exactly matching Action JS Code.
// 3. Includes "+ Add new variable" functionality and dynamic variables display at the bottom of the menu.
//
// When the user clicks the [+] button or (+) Data chip:
// 1. A root menu opens showing "Trigger" with sections: query, body, headers, attachment, plus dynamic variables.
// 2. Hovering over any item with children (e.g. query >) immediately flies out a submenu to the left,
//    displaying primary (key) and secondary (sample value) labels with 0 gap.
// 3. Hover resilience (grace timers + invisible hover bridge) prevents vanishing on diagonal movements.
// 4. Sample values are colored by data type:
//    - Boolean: Warm amber/orange (#f59e0b)
//    - Number: Blue (#3b82f6)
//    - String: Normal secondary text color
//    - Null / Undefined: Muted italic grey (#8b949e)
// 5. "+ Add new variable" button allows inline creation of dynamic variables, saving to Redux and inserting into code.
// 6. Clicking any item inserts:
//    - In App Action inputs: ${context.req.query.name} or ${varName}
//    - In JS Code editors: context.req.query.name or varName (valid JavaScript code)
//    and updates React Fiber (getHtmlAndValue / Monaco) and Redux draft state via page-bridge.
// 7. Closes cleanly on outside click, Escape key, or window scroll.

import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-get-data-mapping-styles'
const BTN_CLASS = 'vs-mapping-plus-btn'
const DATA_CHIP_CLASS = 'vs-mapping-data-chip'
const MENU_ROOT_ID = 'vs-mapping-root-menu'
const SCAN_DELAY_MS = 200
const EDITOR_ID_ATTR = 'data-vs-editor-id'

// Exact SVG equivalent of Material-UI AddBoxTwoTone
const ADD_BOX_TWO_TONE_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 19px; height: 19px; display: block;">
  <path d="M5 19h14V5H5v14zm2-8h4V7h2v4h4v2h-4v4h-2v-4H7v-2z" opacity="0.3" fill="currentColor"></path>
  <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-8-2h2v-4h4v-2h-4V7h-2v4H7v2h4z" fill="currentColor"></path>
</svg>
`

// Exact SVG equivalent of Material-UI AddCircle
const ADD_CIRCLE_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 17px; height: 17px; display: block; margin-right: 4px;" data-testid="AddCircleIcon">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" fill="currentColor"></path>
</svg>
`

const ADD_ICON_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 15px; height: 15px; display: block;">
  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"></path>
</svg>
`

const CODE_VAR_ICON_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 15px; height: 15px; display: block;">
  <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" fill="currentColor"></path>
</svg>
`

const CHEVRON_RIGHT_SVG = `
<svg class="MuiSvgIcon-root vs-menu-chevron" focusable="false" aria-hidden="true" viewBox="0 0 24 24">
  <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"></path>
</svg>
`

const WEBHOOK_ICON_URL = 'https://stuff.thingsofbrand.com/viasocket.com/images/imge_Webhook-bg.svg'

const CSS = `
.${BTN_CLASS} {
  position: absolute;
  right: 4px;
  bottom: 5px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  color: var(--col-icon, #757575);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: color 0.12s ease, background-color 0.12s ease;
}
.${BTN_CLASS}:hover {
  color: var(--col-primary, #3b82f6);
  background-color: rgba(59, 130, 246, 0.08);
}
.${BTN_CLASS}.active {
  color: var(--col-primary, #3b82f6);
  background-color: rgba(59, 130, 246, 0.14);
}
.${BTN_CLASS}:focus-visible {
  outline: 2px solid var(--col-primary, #3b82f6);
  outline-offset: 1px;
}

.${DATA_CHIP_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 10px 0 6px;
  background-color: var(--col-chip, rgba(255, 255, 255, 0.08));
  color: var(--col-text-primary, #ffffff);
  border: 1px solid var(--col-border, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  cursor: pointer;
  user-select: none;
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 12px;
  font-weight: 500;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  margin-top: 4px;
  box-sizing: border-box;
}

.${DATA_CHIP_CLASS}:hover {
  background-color: var(--col-action-hover, rgba(255, 255, 255, 0.14));
  border-color: rgba(255, 255, 255, 0.24);
}

.${DATA_CHIP_CLASS}.active {
  background-color: rgba(59, 130, 246, 0.2);
  border-color: var(--col-primary, #3b82f6);
  color: var(--col-primary, #3b82f6);
}

.vs-viasocket-menu-card {
  position: fixed;
  z-index: 1000000;
  min-width: 200px;
  max-width: 280px;
  max-height: 380px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background-color: var(--col-surface-raised, #181a1f);
  color: var(--col-text-primary, #ffffff);
  border: 1px solid var(--col-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0px 4px 16px rgba(0, 0, 0, 0.35);
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  padding: 4px 0;
  user-select: none;
}

.vs-viasocket-menu-card::-webkit-scrollbar {
  width: 6px;
}
.vs-viasocket-menu-card::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 3px;
}

.vs-menu-section-title {
  padding: 6px 12px 2px 12px;
  font-size: 11px;
  font-weight: 500;
  color: var(--col-text-secondary, #9e9e9e);
  letter-spacing: 0.2px;
}

.vs-menu-divider {
  height: 1px;
  background-color: var(--col-border, rgba(255, 255, 255, 0.12));
  margin: 4px 0;
}

.vs-menu-footer {
  padding: 4px 8px 6px 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.vs-menu-add-var-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: var(--col-primary, #3b82f6);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background-color 0.12s ease;
}

.vs-menu-add-var-btn:hover {
  background-color: rgba(59, 130, 246, 0.08);
}

.vs-menu-add-var-btn svg {
  fill: currentColor;
}

.vs-menu-add-var-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  width: 100%;
  box-sizing: border-box;
}

.vs-menu-add-var-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--col-border, rgba(255, 255, 255, 0.2));
  border-radius: 4px;
  color: #ffffff;
  font-family: inherit;
  font-size: 12.5px;
  outline: none;
  box-sizing: border-box;
}

.vs-menu-add-var-input:focus {
  border-color: var(--col-primary, #3b82f6);
}

.vs-menu-add-var-submit {
  height: 28px;
  padding: 0 10px;
  background-color: var(--col-primary, #3b82f6);
  border: none;
  border-radius: 4px;
  color: #ffffff;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.12s ease;
}

.vs-menu-add-var-submit:hover {
  opacity: 0.9;
}

.vs-menu-item-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 38px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
  position: relative;
}

.vs-menu-item-row:hover,
.vs-menu-item-row.active {
  background-color: var(--col-action-hover, rgba(255, 255, 255, 0.08));
}

/* Invisible hover bridge to eliminate seam/gap when gliding cursor towards flyout */
.vs-menu-item-row.active.flyout-left::after {
  content: '';
  position: absolute;
  top: -4px;
  bottom: -4px;
  left: -16px;
  width: 20px;
  background: transparent;
  pointer-events: auto;
  z-index: 10;
}

.vs-menu-item-row.active.flyout-right::after {
  content: '';
  position: absolute;
  top: -4px;
  bottom: -4px;
  right: -16px;
  width: 20px;
  background: transparent;
  pointer-events: auto;
  z-index: 10;
}

.vs-menu-avatar-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background-color: rgba(255, 255, 255, 0.04);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  color: var(--col-text-secondary, #9e9e9e);
}

.vs-menu-avatar-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.vs-menu-text-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.vs-menu-primary-text {
  font-size: 13.5px;
  font-weight: 400;
  color: var(--col-text-primary, #ffffff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}

.vs-menu-secondary-text {
  font-size: 11.5px;
  color: var(--col-text-secondary, #9e9e9e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
  margin-top: 1px;
}

/* Data type syntax colors */
.vs-menu-secondary-text.vs-val-boolean {
  color: #f59e0b !important;
  font-weight: 500;
}

.vs-menu-secondary-text.vs-val-number {
  color: #3b82f6 !important;
  font-weight: 500;
}

.vs-menu-secondary-text.vs-val-string {
  color: var(--col-text-secondary, #9e9e9e) !important;
}

.vs-menu-secondary-text.vs-val-null,
.vs-menu-secondary-text.vs-val-undefined {
  color: #8b949e !important;
  font-style: italic;
}

.vs-menu-chevron {
  width: 18px;
  height: 18px;
  color: var(--col-text-secondary, #9e9e9e);
  margin-left: auto;
  flex-shrink: 0;
}
`

export interface ValueClassification {
  text: string
  colorClass: string
}

export function classifyValue(val: unknown): ValueClassification {
  if (val === null) {
    return { text: 'null', colorClass: 'vs-val-null' }
  }
  if (val === undefined) {
    return { text: 'undefined', colorClass: 'vs-val-undefined' }
  }

  // Boolean check: literal boolean or "true"/"false" string
  if (typeof val === 'boolean') {
    return { text: String(val), colorClass: 'vs-val-boolean' }
  }
  if (typeof val === 'string') {
    const trimmed = val.trim()
    if (trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false') {
      return { text: trimmed, colorClass: 'vs-val-boolean' }
    }
    // Number check: numeric string (e.g. "919535420531", "100", "-5.2")
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed.length > 0) {
      return { text: trimmed, colorClass: 'vs-val-number' }
    }
    if (trimmed.length === 0) {
      return { text: '""', colorClass: 'vs-val-string' }
    }
    return { text: val, colorClass: 'vs-val-string' }
  }

  // Number literal
  if (typeof val === 'number') {
    if (Number.isNaN(val)) {
      return { text: 'NaN', colorClass: 'vs-val-null' }
    }
    return { text: String(val), colorClass: 'vs-val-number' }
  }

  if (Array.isArray(val) && val.length === 0) {
    return { text: '[]', colorClass: 'vs-val-string' }
  }
  if (typeof val === 'object' && Object.keys(val as object).length === 0) {
    return { text: '{}', colorClass: 'vs-val-string' }
  }

  return { text: String(val), colorClass: 'vs-val-string' }
}

function makeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface GetDataMappingController {
  destroy(): void
}

export function initGetDataMappingUI(bridge: PageBridge): GetDataMappingController {
  let dead = false
  let scanTimer: number | undefined
  let submenuOpenTimer: number | undefined
  let submenuCloseTimer: number | undefined
  const activeRowByLevel = new Map<number, HTMLElement>()

  let activeBtn: HTMLElement | null = null
  let activeTarget: HTMLElement | null = null
  let activeIsCodeEditor = false
  let openMenus: HTMLElement[] = []
  const attachedContainers = new Set<HTMLElement>()
  const attachedChips = new Set<HTMLElement>()

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function isGetDataSlider(slider: HTMLElement): boolean {
    const urlParams = new URLSearchParams(location.search)
    const stepId = urlParams.get('stepId')
    const slugName = urlParams.get('slugName')
    if (stepId === 'CRON_PRE_PROCESS' || slugName === 'CRON_PRE_PROCESS') return true

    const header = slider.querySelector<HTMLElement>(
      '#step-name-component, .step-header, h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], .MuiTypography-h6'
    )
    if (header && /get data/i.test(header.textContent || '')) return true

    const anyHeader = slider.querySelector<HTMLElement>('.step-header, #step-name-component')
    if (anyHeader && /get data/i.test(anyHeader.innerText || anyHeader.textContent || '')) return true

    try {
      const rawDraft = document.documentElement.getAttribute('data-vs-draft-step')
      if (rawDraft) {
        const parsed = JSON.parse(rawDraft) as { stepId?: string; slugName?: string }
        if (parsed?.stepId === 'CRON_PRE_PROCESS' || parsed?.slugName === 'CRON_PRE_PROCESS') return true
      }
    } catch {
      // ignore
    }
    return false
  }

  function clearTimers(): void {
    if (submenuOpenTimer !== undefined) {
      clearTimeout(submenuOpenTimer)
      submenuOpenTimer = undefined
    }
    if (submenuCloseTimer !== undefined) {
      clearTimeout(submenuCloseTimer)
      submenuCloseTimer = undefined
    }
  }

  function closeAllMenus(): void {
    clearTimers()
    for (const [, r] of activeRowByLevel.entries()) {
      r.classList.remove('active', 'flyout-left', 'flyout-right')
    }
    activeRowByLevel.clear()

    if (activeBtn) {
      activeBtn.classList.remove('active')
      activeBtn = null
    }
    activeTarget = null
    activeIsCodeEditor = false
    for (const menu of openMenus) {
      menu.remove()
    }
    openMenus = []
  }

  function scheduleOpenSubmenu(
    row: HTMLElement,
    childData: unknown,
    itemPath: string,
    targetLevel: number
  ): void {
    clearTimers()

    // If this row is already active and its submenu is currently open, keep it open
    const currentActive = activeRowByLevel.get(targetLevel - 1)
    if (currentActive === row && openMenus.length > targetLevel) {
      return
    }

    // Small debounce (130ms) allows cursor to glide smoothly across rows without premature flyouts
    submenuOpenTimer = window.setTimeout(() => {
      if (!row.isConnected) return

      // Un-highlight previous active row at this level
      const prev = activeRowByLevel.get(targetLevel - 1)
      if (prev && prev !== row) {
        prev.classList.remove('active', 'flyout-left', 'flyout-right')
      }

      row.classList.add('active')
      activeRowByLevel.set(targetLevel - 1, row)

      openSubmenu(row, childData, itemPath, targetLevel)
    }, 130)
  }

  function scheduleCloseSubmenusAbove(level: number): void {
    if (submenuOpenTimer !== undefined) {
      clearTimeout(submenuOpenTimer)
      submenuOpenTimer = undefined
    }
    if (submenuCloseTimer !== undefined) {
      clearTimeout(submenuCloseTimer)
      submenuCloseTimer = undefined
    }

    // 180ms grace buffer before closing child submenus
    submenuCloseTimer = window.setTimeout(() => {
      while (openMenus.length > level + 1) {
        const m = openMenus.pop()
        m?.remove()
      }
      for (const [lvl, r] of activeRowByLevel.entries()) {
        if (lvl > level) {
          r.classList.remove('active', 'flyout-left', 'flyout-right')
          activeRowByLevel.delete(lvl)
        }
      }
    }, 180)
  }

  function getTriggerTreeData(): {
    title: string
    iconUrl: string
    data: Record<string, unknown>
    dynamicVariables?: Record<string, string>
  } {
    let dynVars: Record<string, string> | undefined
    try {
      const rawDraft = document.documentElement.getAttribute('data-vs-draft-step')
      if (rawDraft) {
        const parsed = JSON.parse(rawDraft) as { dynamicVariables?: Record<string, string> }
        if (parsed && typeof parsed.dynamicVariables === 'object' && parsed.dynamicVariables !== null) {
          dynVars = parsed.dynamicVariables
        }
      }
    } catch {
      // ignore
    }

    try {
      const raw = document.documentElement.getAttribute('data-vs-trigger-tree')
      if (raw) {
        const parsed = JSON.parse(raw) as {
          title?: string
          iconUrl?: string
          data?: Record<string, unknown>
          dynamicVariables?: Record<string, string>
        }
        if (parsed && typeof parsed.data === 'object' && parsed.data !== null) {
          return {
            title: parsed.title || 'Trigger',
            iconUrl: parsed.iconUrl || WEBHOOK_ICON_URL,
            data: parsed.data,
            dynamicVariables: parsed.dynamicVariables || dynVars,
          }
        }
      }
    } catch {
      // ignore
    }

    return {
      title: 'Trigger',
      iconUrl: WEBHOOK_ICON_URL,
      data: {
        query: {},
        body: {},
        headers: {},
        attachment: null,
      },
      dynamicVariables: dynVars,
    }
  }

  function insertVariable(target: HTMLElement, varPath: string, isCodeEditor: boolean): void {
    if (isCodeEditor) {
      // In JS Code, insert plain JavaScript expression (e.g. context.req.query.name or varName)
      let editorId = target.getAttribute(EDITOR_ID_ATTR)
      if (!editorId) {
        editorId = makeId()
        target.setAttribute(EDITOR_ID_ATTR, editorId)
      }
      bridge.editorInsert(editorId, varPath).catch(() => undefined)
      return
    }

    const input = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'textarea, input:not([type="hidden"])'
    )
    if (!input) return

    const insertText = `\${${varPath}}`
    const currentVal = input.value || ''
    let newVal = ''

    if (input.selectionStart !== null && input.selectionEnd !== null) {
      const start = input.selectionStart
      const end = input.selectionEnd
      newVal = currentVal.substring(0, start) + insertText + currentVal.substring(end)
      const nextPos = start + insertText.length
      setTimeout(() => {
        try {
          input.focus()
          input.setSelectionRange(nextPos, nextPos)
        } catch {
          // ignore
        }
      }, 50)
    } else if (!currentVal.trim()) {
      newVal = insertText
    } else {
      newVal = `${currentVal} ${insertText}`
    }

    // 1. Native property setter & dispatch events
    const proto = Object.getPrototypeOf(input)
    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSet) nativeSet.call(input, newVal)
    else input.value = newVal
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))

    // 2. Resolve field label from row & notify React fiber/Redux through page-bridge
    const fieldRow = target.closest<HTMLElement>(
      '[data-testid^="plugin-field-"]:not([data-testid^="plugin-field-label-"]), .plugin-field-row, [data-testid="custom-field-box"]'
    )
    let fieldLabel = ''
    if (fieldRow) {
      fieldLabel = (
        fieldRow.querySelector('[data-testid^="plugin-field-label-"], label')?.textContent ||
        fieldRow.getAttribute('data-testid')?.replace(/^plugin-field-/, '') ||
        ''
      )
        .replace(/[*:[\]"']/g, '')
        .trim()
    }
    if (!fieldLabel && target.id) {
      fieldLabel = target.id.replace(/^scroll-/, '').replace(/-/g, ' ')
    }

    if (fieldLabel) {
      bridge.setFieldValue(fieldLabel, newVal, false).catch(() => undefined)
    }
  }

  function formatPath(parentPath: string, key: string): string {
    const isIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
    if (!parentPath) return key
    if (isIdentifier) return `${parentPath}.${key}`
    return `${parentPath}['${key.replace(/'/g, "\\'")}']`
  }

  function isNonEmptyObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0)
  }

  function isNonEmptyArray(val: unknown): val is unknown[] {
    return Boolean(Array.isArray(val) && val.length > 0)
  }

  // Opens a cascading submenu for an item at level >= 1
  function openSubmenu(
    parentRow: HTMLElement,
    childData: unknown,
    parentPath: string,
    level: number
  ): HTMLElement | null {
    // Close any submenus already at this level or deeper
    while (openMenus.length > level) {
      const m = openMenus.pop()
      m?.remove()
    }

    if (!isNonEmptyObject(childData) && !isNonEmptyArray(childData)) {
      return null
    }

    const parentCard = (parentRow.closest('.vs-viasocket-menu-card') as HTMLElement) || parentRow
    const parentCardRect = parentCard.getBoundingClientRect()
    const rowRect = parentRow.getBoundingClientRect()

    const card = document.createElement('div')
    card.className = 'vs-viasocket-menu-card vs-submenu'
    card.setAttribute('data-level', String(level))

    // Position submenu flush against parent card with 1px border overlap (Zero Gap)
    const spaceOnLeft = parentCardRect.left
    const spaceOnRight = window.innerWidth - parentCardRect.right
    const openToLeft = spaceOnLeft >= 210 || spaceOnLeft > spaceOnRight

    if (openToLeft) {
      card.style.right = `${window.innerWidth - parentCardRect.left + 1}px`
      card.style.left = 'auto'
      parentRow.classList.add('flyout-left')
      parentRow.classList.remove('flyout-right')
    } else {
      card.style.left = `${parentCardRect.right - 1}px`
      card.style.right = 'auto'
      parentRow.classList.add('flyout-right')
      parentRow.classList.remove('flyout-left')
    }

    let top = rowRect.top - 4
    card.style.top = `${top}px`
    card.style.zIndex = String(1000000 + level)

    if (isNonEmptyArray(childData)) {
      childData.forEach((item, index) => {
        const itemPath = `${parentPath}[${index}]`
        const hasChildren = isNonEmptyObject(item) || isNonEmptyArray(item)
        const secondaryInfo = hasChildren ? undefined : classifyValue(item)
        const row = createMenuItemRow(
          `[${index}]`,
          secondaryInfo,
          hasChildren,
          null,
          () => {
            if (activeTarget) {
              insertVariable(activeTarget, itemPath, activeIsCodeEditor)
              closeAllMenus()
            }
          },
          (r) => {
            if (hasChildren) {
              scheduleOpenSubmenu(r, item, itemPath, level + 1)
            } else {
              scheduleCloseSubmenusAbove(level)
            }
          }
        )
        card.appendChild(row)
      })
    } else if (isNonEmptyObject(childData)) {
      for (const [key, val] of Object.entries(childData)) {
        const itemPath = formatPath(parentPath, key)
        const hasChildren = isNonEmptyObject(val) || isNonEmptyArray(val)
        const secondaryInfo = hasChildren ? undefined : classifyValue(val)
        const row = createMenuItemRow(
          key,
          secondaryInfo,
          hasChildren,
          null,
          () => {
            if (activeTarget) {
              insertVariable(activeTarget, itemPath, activeIsCodeEditor)
              closeAllMenus()
            }
          },
          (r) => {
            if (hasChildren) {
              scheduleOpenSubmenu(r, val, itemPath, level + 1)
            } else {
              scheduleCloseSubmenusAbove(level)
            }
          }
        )
        card.appendChild(row)
      }
    }

    // Stop click/scroll propagation inside card
    for (const evt of ['click', 'mousedown', 'pointerdown'] as const) {
      card.addEventListener(evt, (e) => e.stopPropagation())
    }

    // Keep submenu open when hovering into it
    card.addEventListener('mouseenter', () => {
      clearTimers()
    })

    // Grace period when moving mouse out of submenu
    card.addEventListener('mouseleave', (e) => {
      const related = e.relatedTarget as Node | null
      if (related) {
        if (parentCard.contains(related)) return
        for (const m of openMenus) {
          if (m.contains(related)) return
        }
      }
      scheduleCloseSubmenusAbove(level - 1)
    })

    document.body.appendChild(card)
    openMenus.push(card)

    // Adjust vertical position if card overflows bottom of viewport
    const cardRect = card.getBoundingClientRect()
    if (cardRect.bottom > window.innerHeight - 10) {
      const adjustedTop = Math.max(10, window.innerHeight - cardRect.height - 10)
      card.style.top = `${adjustedTop}px`
    }

    return card
  }

  function createMenuItemRow(
    primary: string,
    secondaryInfo: ValueClassification | undefined,
    hasChildren: boolean,
    iconUrl: string | null,
    onClick: () => void,
    onHover: (r: HTMLElement) => void
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'vs-menu-item-row'

    if (iconUrl) {
      const avatar = document.createElement('div')
      avatar.className = 'vs-menu-avatar-icon'
      if (iconUrl.startsWith('<svg')) {
        avatar.innerHTML = iconUrl
      } else {
        const img = document.createElement('img')
        img.src = iconUrl
        img.alt = primary
        avatar.appendChild(img)
      }
      row.appendChild(avatar)
    }

    const textWrap = document.createElement('div')
    textWrap.className = 'vs-menu-text-wrap'

    const primarySpan = document.createElement('span')
    primarySpan.className = 'vs-menu-primary-text'
    primarySpan.textContent = primary
    textWrap.appendChild(primarySpan)

    if (secondaryInfo) {
      const secondarySpan = document.createElement('span')
      secondarySpan.className = `vs-menu-secondary-text ${secondaryInfo.colorClass}`
      secondarySpan.textContent = secondaryInfo.text
      textWrap.appendChild(secondarySpan)
    }

    row.appendChild(textWrap)

    if (hasChildren) {
      const chevron = document.createElement('span')
      chevron.innerHTML = CHEVRON_RIGHT_SVG
      row.appendChild(chevron)
    }

    row.addEventListener('mouseenter', () => onHover(row))
    row.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    })

    return row
  }

  function showRootMenu(button: HTMLElement, target: HTMLElement, isCodeEditor: boolean): void {
    if (activeBtn === button) {
      closeAllMenus()
      return
    }
    closeAllMenus()

    activeBtn = button
    activeTarget = target
    activeIsCodeEditor = isCodeEditor
    button.classList.add('active')

    const tree = getTriggerTreeData()

    const rootCard = document.createElement('div')
    rootCard.id = MENU_ROOT_ID
    rootCard.className = 'vs-viasocket-menu-card'

    const btnRect = button.getBoundingClientRect()
    const cardWidth = 230
    let right = window.innerWidth - btnRect.right
    if (right + cardWidth > window.innerWidth - 10) {
      right = window.innerWidth - 10 - cardWidth
    }

    if (isCodeEditor || btnRect.bottom + 260 > window.innerHeight) {
      // For Code editor chip at the bottom or near screen bottom: open UPWARDS directly above button
      const bottom = window.innerHeight - btnRect.top + 4
      rootCard.style.bottom = `${bottom}px`
      rootCard.style.top = 'auto'
    } else {
      let top = btnRect.bottom + 2
      if (top + 260 > window.innerHeight) {
        top = Math.max(10, btnRect.top - 260)
      }
      rootCard.style.top = `${top}px`
      rootCard.style.bottom = 'auto'
    }

    rootCard.style.right = `${Math.max(10, right)}px`
    rootCard.style.left = 'auto'

    // Section header: Trigger
    const sectionTitle = document.createElement('div')
    sectionTitle.className = 'vs-menu-section-title'
    sectionTitle.textContent = tree.title || 'Trigger'
    rootCard.appendChild(sectionTitle)

    // Four standard Trigger sections: query, body, headers, attachment
    const sections: Array<{ key: string; label: string }> = [
      { key: 'query', label: 'query' },
      { key: 'body', label: 'body' },
      { key: 'headers', label: 'headers' },
      { key: 'attachment', label: 'attachment' },
    ]

    for (const sec of sections) {
      const childData = tree.data?.[sec.key]
      const hasChildren = isNonEmptyObject(childData) || isNonEmptyArray(childData)
      const secPath = `context.req.${sec.key}`

      const row = createMenuItemRow(
        sec.label,
        undefined,
        hasChildren,
        tree.iconUrl,
        () => {
          // If clicked and has no children, insert top-level path
          insertVariable(target, secPath, isCodeEditor)
          closeAllMenus()
        },
        (r) => {
          if (hasChildren) {
            scheduleOpenSubmenu(r, childData, secPath, 1)
          } else {
            // Sibling without children hovered
            scheduleCloseSubmenusAbove(0)
            clearTimeout(submenuOpenTimer)
            submenuOpenTimer = window.setTimeout(() => {
              if (r.isConnected) {
                const prev = activeRowByLevel.get(0)
                if (prev && prev !== r) {
                  prev.classList.remove('active', 'flyout-left', 'flyout-right')
                }
                r.classList.add('active')
                activeRowByLevel.set(0, r)
              }
            }, 130)
          }
        }
      )
      rootCard.appendChild(row)
    }

    // Dynamic Variables section (if any exist in current draft)
    const dynEntries = Object.entries(tree.dynamicVariables || {})
    if (dynEntries.length > 0) {
      const divider = document.createElement('div')
      divider.className = 'vs-menu-divider'
      rootCard.appendChild(divider)

      const dynSectionTitle = document.createElement('div')
      dynSectionTitle.className = 'vs-menu-section-title'
      dynSectionTitle.textContent = 'Variables'
      rootCard.appendChild(dynSectionTitle)

      for (const [varName, varVal] of dynEntries) {
        const row = createMenuItemRow(
          varName,
          varVal ? classifyValue(varVal) : undefined,
          false,
          CODE_VAR_ICON_SVG,
          () => {
            insertVariable(target, varName, isCodeEditor)
            closeAllMenus()
          },
          (r) => {
            scheduleCloseSubmenusAbove(0)
            clearTimeout(submenuOpenTimer)
            submenuOpenTimer = window.setTimeout(() => {
              if (r.isConnected) {
                const prev = activeRowByLevel.get(0)
                if (prev && prev !== r) {
                  prev.classList.remove('active', 'flyout-left', 'flyout-right')
                }
                r.classList.add('active')
                activeRowByLevel.set(0, r)
              }
            }, 130)
          }
        )
        rootCard.appendChild(row)
      }
    }

    // Add new variable footer button
    const footerDivider = document.createElement('div')
    footerDivider.className = 'vs-menu-divider'
    rootCard.appendChild(footerDivider)

    const footer = document.createElement('div')
    footer.className = 'vs-menu-footer'

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'vs-menu-add-var-btn'
    addBtn.setAttribute('data-testid', 'context-menu-add-variable-link')
    addBtn.innerHTML = `${ADD_ICON_SVG}<span>Add new variable</span>`

    addBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // Replace button with inline input form
      footer.innerHTML = ''
      const form = document.createElement('div')
      form.className = 'vs-menu-add-var-form'

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'vs-menu-add-var-input'
      input.setAttribute('data-testid', 'context-menu-add-variable-input')
      input.placeholder = "Enter Variable's name"
      input.maxLength = 50

      const submitBtn = document.createElement('button')
      submitBtn.type = 'button'
      submitBtn.className = 'vs-menu-add-var-submit'
      submitBtn.setAttribute('data-testid', 'context-menu-add-variable-button')
      submitBtn.textContent = 'Add'

      const doSubmit = () => {
        const name = input.value.trim()
        if (!name) return
        insertVariable(target, name, isCodeEditor)
        bridge.addDynamicVariable(name).catch(() => undefined)
        closeAllMenus()
      }

      submitBtn.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        doSubmit()
      })

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          ev.stopPropagation()
          doSubmit()
        }
      })

      form.appendChild(input)
      form.appendChild(submitBtn)
      footer.appendChild(form)

      setTimeout(() => input.focus(), 50)
    })

    footer.appendChild(addBtn)
    rootCard.appendChild(footer)

    // Stop events inside root menu
    for (const evt of ['click', 'mousedown', 'pointerdown'] as const) {
      rootCard.addEventListener(evt, (e) => e.stopPropagation())
    }

    rootCard.addEventListener('mouseenter', () => {
      clearTimers()
    })

    rootCard.addEventListener('mouseleave', (e) => {
      const related = e.relatedTarget as Node | null
      if (related) {
        for (const m of openMenus) {
          if (m.contains(related)) return
        }
        if (activeBtn?.contains(related)) return
      }
      scheduleCloseSubmenusAbove(0)
    })

    document.body.appendChild(rootCard)
    openMenus.push(rootCard)
  }

  function attachButton(container: HTMLElement): void {
    if (container.querySelector(`.${BTN_CLASS}, [data-testid="add-variable-button"]`)) {
      return
    }

    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'textarea, input:not([type="hidden"])'
    )
    if (input) {
      input.style.paddingRight = '32px'
    }

    const existingIconBox = container.querySelector<HTMLElement>('.absolute.right-1, .right-1')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = BTN_CLASS
    button.setAttribute('data-testid', 'add-variable-button')
    button.setAttribute('role', 'button')
    button.setAttribute('aria-label', 'Field mapping')
    button.title = 'Click for Field Mapping'
    button.innerHTML = ADD_BOX_TWO_TONE_SVG

    button.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showRootMenu(button, container, false)
    })

    if (existingIconBox) {
      existingIconBox.appendChild(button)
    } else {
      container.appendChild(button)
    }

    attachedContainers.add(container)
  }

  function attachDataChip(monacoEl: HTMLElement): void {
    // If chip already attached in this editor container, skip
    const existing = monacoEl.closest('.flex.flex-col')?.querySelector<HTMLElement>(
      `.${DATA_CHIP_CLASS}, [data-testid="add-variable-data-chip"]`
    )
    if (existing) return

    // Locate or create the toolbar container right below the Monaco editor in CustomAceEditor
    let toolbar = monacoEl.closest('.flex.flex-col')?.querySelector<HTMLElement>(
      '.flex.justify-end, .justify-end'
    )

    if (!toolbar) {
      toolbar = document.createElement('div')
      toolbar.className = 'flex justify-end items-center w-full vs-code-toolbar'
      toolbar.style.padding = '4px 0'
      const parent = monacoEl.parentElement?.parentElement || monacoEl.parentElement
      parent?.appendChild(toolbar)
    }

    const chip = document.createElement('div')
    chip.className = DATA_CHIP_CLASS
    chip.setAttribute('role', 'button')
    chip.setAttribute('tabindex', '0')
    chip.setAttribute('data-testid', 'add-variable-data-chip')
    chip.setAttribute('aria-label', 'Field mapping')
    chip.title = 'Click for Field Mapping'
    chip.innerHTML = `${ADD_CIRCLE_SVG}<span>Data</span>`

    chip.addEventListener('mousedown', (e) => {
      // Prevent mousedown from taking focus away from Monaco editor
      e.preventDefault()
      e.stopPropagation()
    })

    chip.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showRootMenu(chip, monacoEl, true)
    })

    toolbar.appendChild(chip)
    attachedChips.add(chip)
  }

  function scan(): void {
    scanTimer = undefined
    if (dead) return

    const candidateSliders = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider, .customSliderParent, .sliderChild'
      )
    )

    let slider = candidateSliders.find((s) => s.offsetParent !== null && isGetDataSlider(s))
    if (!slider) {
      slider = candidateSliders.find((s) => isGetDataSlider(s))
    }
    if (!slider) {
      const header = document.querySelector<HTMLElement>('#step-name-component')
      if (header && /get data/i.test(header.textContent || '')) {
        slider = header.closest<HTMLElement>('.custom_slider, [data-slider-container="true"], .customSliderParent, body') || document.body
      }
    }

    if (!slider || !isGetDataSlider(slider)) {
      closeAllMenus()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      for (const chip of attachedChips) {
        chip.remove()
      }
      attachedChips.clear()
      return
    }

    // Clean up disconnected containers
    for (const container of attachedContainers) {
      if (!container.isConnected) attachedContainers.delete(container)
    }
    for (const chip of attachedChips) {
      if (!chip.isConnected) attachedChips.delete(chip)
    }

    // 1. App Action custom field mapping inputs
    const containers = slider.querySelectorAll<HTMLElement>(
      '[data-testid="custom-autosuggest-input-container"], [data-testid="custom-autosuggest-wrapper"]'
    )
    for (const container of containers) {
      attachButton(container)
    }

    // 2. Monaco Code Editor (JS Code in Get Data)
    const monacoEditors = slider.querySelectorAll<HTMLElement>('.monaco-editor')
    for (const monacoEl of monacoEditors) {
      if (monacoEl.parentElement?.closest('.monaco-editor') || monacoEl.closest('.monaco-diff-editor')) continue
      attachDataChip(monacoEl)
    }
  }

  function onGlobalClick(e: MouseEvent): void {
    if (openMenus.length === 0) return
    const target = e.target as Node | null
    if (target) {
      if (activeBtn?.contains(target)) return
      if (openMenus.some((m) => m.contains(target))) return
    }
    closeAllMenus()
  }

  function onGlobalKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && openMenus.length > 0) {
      closeAllMenus()
    }
  }

  function onGlobalScroll(e: Event): void {
    if (openMenus.length === 0) return
    const target = e.target as Node | null
    if (target && openMenus.some((m) => m.contains(target))) return
    closeAllMenus()
  }

  const observer = new MutationObserver(() => {
    if (scanTimer !== undefined || dead) return
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS)
  })

  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', onGlobalClick, true)
  window.addEventListener('keydown', onGlobalKeyDown, true)
  window.addEventListener('scroll', onGlobalScroll, { capture: true, passive: true })

  scan()

  return {
    destroy() {
      dead = true
      observer.disconnect()
      clearTimeout(scanTimer)
      clearTimers()
      document.removeEventListener('click', onGlobalClick, true)
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      window.removeEventListener('scroll', onGlobalScroll, true)
      closeAllMenus()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      for (const chip of attachedChips) {
        chip.remove()
      }
      attachedChips.clear()
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
