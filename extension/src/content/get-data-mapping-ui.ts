// Implements the native viaSocket cascading hover mapping menu for Get Data (CRON_PRE_PROCESS)
// custom mapping field boxes, exactly matching the appearance and behavior in Actions (Image 2).
//
// When the user clicks the [+] AddBoxTwoTone button:
// 1. A root menu opens showing "Trigger" with sections: query, body, headers, attachment.
// 2. Hovering over any item with children (e.g. query >) immediately flies out a submenu to the left,
//    displaying primary (key) and secondary (sample value) labels.
// 3. Hovering deeper nested objects flies out level 3 submenus.
// 4. Clicking any item inserts the expression (e.g. ${context.req.query.name}) into the input
//    and updates React Fiber (getHtmlAndValue) and Redux draft state via page-bridge.
// 5. Closes cleanly on outside click, Escape key, or scroll.

import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-get-data-mapping-styles'
const BTN_CLASS = 'vs-mapping-plus-btn'
const MENU_ROOT_ID = 'vs-mapping-root-menu'
const SCAN_DELAY_MS = 200

// Exact SVG equivalent of Material-UI AddBoxTwoTone
const ADD_BOX_TWO_TONE_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 19px; height: 19px; display: block;">
  <path d="M5 19h14V5H5v14zm2-8h4V7h2v4h4v2h-4v4h-2v-4H7v-2z" opacity="0.3" fill="currentColor"></path>
  <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-8-2h2v-4h4v-2h-4V7h-2v4H7v2h4z" fill="currentColor"></path>
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

.vs-viasocket-menu-card {
  position: fixed;
  z-index: 1000000;
  min-width: 200px;
  max-width: 280px;
  max-height: 340px;
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

.vs-menu-chevron {
  width: 18px;
  height: 18px;
  color: var(--col-text-secondary, #9e9e9e);
  margin-left: auto;
  flex-shrink: 0;
}
`

export interface GetDataMappingController {
  destroy(): void
}

export function initGetDataMappingUI(bridge: PageBridge): GetDataMappingController {
  let dead = false
  let scanTimer: number | undefined
  let activeBtn: HTMLButtonElement | null = null
  let activeTargetContainer: HTMLElement | null = null
  let openMenus: HTMLElement[] = []
  const attachedContainers = new Set<HTMLElement>()

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
      'h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], .MuiTypography-h6'
    )
    if (header && /get data/i.test(header.textContent || '')) return true

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

  function closeAllMenus(): void {
    if (activeBtn) {
      activeBtn.classList.remove('active')
      activeBtn = null
    }
    activeTargetContainer = null
    for (const menu of openMenus) {
      menu.remove()
    }
    openMenus = []
  }

  function getTriggerTreeData(): { title: string; iconUrl: string; data: Record<string, unknown> } {
    try {
      const raw = document.documentElement.getAttribute('data-vs-trigger-tree')
      if (raw) {
        const parsed = JSON.parse(raw) as { title?: string; iconUrl?: string; data?: Record<string, unknown> }
        if (parsed && typeof parsed.data === 'object' && parsed.data !== null) {
          return {
            title: parsed.title || 'Trigger',
            iconUrl: parsed.iconUrl || WEBHOOK_ICON_URL,
            data: parsed.data,
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
    }
  }

  function insertVariable(container: HTMLElement, varPath: string): void {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
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
    const fieldRow = container.closest<HTMLElement>(
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
    if (!fieldLabel && container.id) {
      fieldLabel = container.id.replace(/^scroll-/, '').replace(/-/g, ' ')
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
  ): void {
    // Close any submenus at this level or deeper
    while (openMenus.length > level) {
      const m = openMenus.pop()
      m?.remove()
    }

    // Un-highlight sibling items in this parent menu
    const parentCard = parentRow.closest('.vs-viasocket-menu-card')
    if (parentCard) {
      for (const row of parentCard.querySelectorAll('.vs-menu-item-row')) {
        row.classList.remove('active')
      }
    }
    parentRow.classList.add('active')

    if (!isNonEmptyObject(childData) && !isNonEmptyArray(childData)) {
      return
    }

    const card = document.createElement('div')
    card.className = 'vs-viasocket-menu-card vs-submenu'
    card.setAttribute('data-level', String(level))

    // Position submenu directly to the left of the parent row (matching Image 2)
    const rowRect = parentRow.getBoundingClientRect()
    const cardWidth = 240
    let left = rowRect.left - cardWidth - 4
    if (left < 10) {
      // If no room on left, open to right
      left = rowRect.right + 4
    }

    let top = rowRect.top - 6
    if (top + 280 > window.innerHeight) {
      top = Math.max(10, window.innerHeight - 290)
    }
    card.style.left = `${left}px`
    card.style.top = `${top}px`
    card.style.zIndex = String(1000000 + level)

    if (isNonEmptyArray(childData)) {
      childData.forEach((item, index) => {
        const itemPath = `${parentPath}[${index}]`
        const hasChildren = isNonEmptyObject(item) || isNonEmptyArray(item)
        const row = createMenuItemRow(
          `[${index}]`,
          hasChildren ? undefined : String(item ?? ''),
          hasChildren,
          null,
          () => {
            if (activeTargetContainer) {
              insertVariable(activeTargetContainer, itemPath)
              closeAllMenus()
            }
          },
          (r) => {
            if (hasChildren) openSubmenu(r, item, itemPath, level + 1)
            else {
              while (openMenus.length > level) openMenus.pop()?.remove()
            }
          }
        )
        card.appendChild(row)
      })
    } else if (isNonEmptyObject(childData)) {
      for (const [key, val] of Object.entries(childData)) {
        const itemPath = formatPath(parentPath, key)
        const hasChildren = isNonEmptyObject(val) || isNonEmptyArray(val)
        let displayVal: string | undefined
        if (!hasChildren && val !== undefined && val !== null) {
          displayVal = String(val)
        }

        const row = createMenuItemRow(
          key,
          displayVal,
          hasChildren,
          null,
          () => {
            if (activeTargetContainer) {
              insertVariable(activeTargetContainer, itemPath)
              closeAllMenus()
            }
          },
          (r) => {
            if (hasChildren) openSubmenu(r, val, itemPath, level + 1)
            else {
              while (openMenus.length > level) openMenus.pop()?.remove()
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

    document.body.appendChild(card)
    openMenus.push(card)
  }

  function createMenuItemRow(
    primary: string,
    secondary: string | undefined,
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
      const img = document.createElement('img')
      img.src = iconUrl
      img.alt = primary
      avatar.appendChild(img)
      row.appendChild(avatar)
    }

    const textWrap = document.createElement('div')
    textWrap.className = 'vs-menu-text-wrap'

    const primarySpan = document.createElement('span')
    primarySpan.className = 'vs-menu-primary-text'
    primarySpan.textContent = primary
    textWrap.appendChild(primarySpan)

    if (secondary) {
      const secondarySpan = document.createElement('span')
      secondarySpan.className = 'vs-menu-secondary-text'
      secondarySpan.textContent = secondary
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

  function showRootMenu(button: HTMLButtonElement, container: HTMLElement): void {
    if (activeBtn === button) {
      closeAllMenus()
      return
    }
    closeAllMenus()

    activeBtn = button
    activeTargetContainer = container
    button.classList.add('active')

    const tree = getTriggerTreeData()

    const rootCard = document.createElement('div')
    rootCard.id = MENU_ROOT_ID
    rootCard.className = 'vs-viasocket-menu-card'

    // Position root menu right next to the [+] button
    const btnRect = button.getBoundingClientRect()
    const cardWidth = 230
    let right = window.innerWidth - btnRect.left
    if (right + cardWidth > window.innerWidth - 10) {
      right = window.innerWidth - 10 - cardWidth
    }

    let top = btnRect.bottom + 2
    if (top + 260 > window.innerHeight) {
      top = Math.max(10, btnRect.top - 260)
    }

    rootCard.style.right = `${right}px`
    rootCard.style.top = `${top}px`

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
          // If clicked and has no children (e.g. empty body/attachment), insert top-level path
          insertVariable(container, secPath)
          closeAllMenus()
        },
        (r) => {
          if (hasChildren) {
            openSubmenu(r, childData, secPath, 1)
          } else {
            // Close any open submenus
            while (openMenus.length > 1) openMenus.pop()?.remove()
            for (const otherRow of rootCard.querySelectorAll('.vs-menu-item-row')) {
              otherRow.classList.remove('active')
            }
            r.classList.add('active')
          }
        }
      )
      rootCard.appendChild(row)
    }

    // Stop events inside root menu
    for (const evt of ['click', 'mousedown', 'pointerdown'] as const) {
      rootCard.addEventListener(evt, (e) => e.stopPropagation())
    }

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
      showRootMenu(button, container)
    })

    if (existingIconBox) {
      existingIconBox.appendChild(button)
    } else {
      container.appendChild(button)
    }

    attachedContainers.add(container)
  }

  function scan(): void {
    scanTimer = undefined
    if (dead) return

    const slider = document.querySelector<HTMLElement>(
      '[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider'
    )

    if (!slider || !isGetDataSlider(slider)) {
      closeAllMenus()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      return
    }

    for (const container of attachedContainers) {
      if (!container.isConnected) attachedContainers.delete(container)
    }

    const containers = slider.querySelectorAll<HTMLElement>(
      '[data-testid="custom-autosuggest-input-container"], [data-testid="custom-autosuggest-wrapper"]'
    )

    for (const container of containers) {
      attachButton(container)
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
      document.removeEventListener('click', onGlobalClick, true)
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      window.removeEventListener('scroll', onGlobalScroll, true)
      closeAllMenus()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
