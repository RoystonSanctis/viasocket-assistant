// Adds the mapping "+" button to custom mapping field boxes in Get Data (CRON_PRE_PROCESS)
// when an app is added. In viaSocket, the native AddVariableButton was omitted for CRON_PRE_PROCESS,
// leaving custom input fields without a way to pick trigger variables (context.req.query, body, etc.).
//
// This controller detects when the Get Data slider is active, injects the AddBoxTwoTone button
// onto every custom mapping input container, and displays an accessible variable picker popover
// that inserts selected variables (e.g. ${context.req.query.name}) into both the input element
// and the underlying React Fiber / Redux state via page-bridge.

import type { PageBridge } from './page-bridge'

const STYLE_ID = 'vs-get-data-mapping-styles'
const BTN_CLASS = 'vs-mapping-plus-btn'
const POPOVER_ID = 'vs-mapping-popover'
const SCAN_DELAY_MS = 200

// Exact SVG equivalent of Material-UI AddBoxTwoTone
const ADD_BOX_TWO_TONE_SVG = `
<svg class="MuiSvgIcon-root" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width: 19px; height: 19px; display: block;">
  <path d="M5 19h14V5H5v14zm2-8h4V7h2v4h4v2h-4v4h-2v-4H7v-2z" opacity="0.3" fill="currentColor"></path>
  <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-8-2h2v-4h4v-2h-4V7h-2v4H7v2h4z" fill="currentColor"></path>
</svg>
`

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

#${POPOVER_ID} {
  position: fixed;
  z-index: 99999;
  width: 290px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  background: var(--col-surface-raised, #ffffff);
  color: var(--col-text-primary, #1a1a1a);
  border: 1px solid var(--col-control-edge, rgba(0, 0, 0, 0.14));
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  font-family: var(--font-family-ui, 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  font-size: 13px;
  overflow: hidden;
  animation: vsMappingFadeIn 0.12s ease-out;
}
@keyframes vsMappingFadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
.vs-mapping-popover-header {
  padding: 8px 10px;
  border-bottom: 1px solid var(--col-control-edge, rgba(0, 0, 0, 0.08));
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--col-surface, #f8f9fa);
}
.vs-mapping-popover-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.vs-mapping-popover-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--col-text-secondary, #666);
}
.vs-mapping-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--col-control-edge, rgba(0, 0, 0, 0.18));
  border-radius: 4px;
  background: var(--col-surface-raised, #fff);
  color: var(--col-text-primary, #1a1a1a);
  outline: none;
}
.vs-mapping-search-input:focus {
  border-color: var(--col-primary, #3b82f6);
}
.vs-mapping-popover-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  max-height: 290px;
}
.vs-mapping-group-title {
  padding: 6px 12px 2px 12px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--col-text-secondary, #888);
  letter-spacing: 0.4px;
}
.vs-mapping-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s ease;
}
.vs-mapping-item:hover {
  background: var(--col-control-hover, rgba(59, 130, 246, 0.08));
}
.vs-mapping-item-name {
  font-family: var(--font-family-mono, monospace);
  font-size: 12px;
  color: var(--col-primary, #2563eb);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vs-mapping-item-val {
  font-size: 11px;
  color: var(--col-text-secondary, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
  text-align: right;
}
.vs-mapping-empty {
  padding: 16px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--col-text-secondary, #888);
}
`

export interface TriggerVariableItem {
  path: string
  label: string
  value?: string
  group: string
}

export interface GetDataMappingController {
  destroy(): void
}

export function initGetDataMappingUI(bridge: PageBridge): GetDataMappingController {
  let dead = false
  let scanTimer: number | undefined
  let activePopover: HTMLElement | null = null
  let activeBtn: HTMLButtonElement | null = null
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

    // Check heading in slider
    const header = slider.querySelector<HTMLElement>(
      'h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], .MuiTypography-h6'
    )
    if (header && /get data/i.test(header.textContent || '')) return true

    // Check synced DOM draft attribute
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

  function closePopover(): void {
    if (activeBtn) {
      activeBtn.classList.remove('active')
      activeBtn = null
    }
    if (activePopover) {
      activePopover.remove()
      activePopover = null
    }
  }

  function getTriggerVariables(): { triggerTitle: string; items: TriggerVariableItem[] } {
    try {
      const raw = document.documentElement.getAttribute('data-vs-trigger-vars')
      if (raw) {
        const parsed = JSON.parse(raw) as { title?: string; vars?: TriggerVariableItem[] }
        if (Array.isArray(parsed?.vars) && parsed.vars.length > 0) {
          return {
            triggerTitle: parsed.title || 'Trigger (Webhook)',
            items: parsed.vars,
          }
        }
      }
    } catch {
      // ignore
    }

    // Default trigger variables fallback
    return {
      triggerTitle: 'Trigger (Webhook)',
      items: [
        { path: 'context.req.query', label: 'query', group: 'query' },
        { path: 'context.req.body', label: 'body', group: 'body' },
        { path: 'context.req.headers', label: 'headers', group: 'headers' },
      ],
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

  function showPopover(button: HTMLButtonElement, container: HTMLElement): void {
    if (activePopover && activeBtn === button) {
      closePopover()
      return
    }
    closePopover()

    activeBtn = button
    button.classList.add('active')

    const { triggerTitle, items } = getTriggerVariables()

    const popover = document.createElement('div')
    popover.id = POPOVER_ID

    // Calculate position
    const rect = button.getBoundingClientRect()
    const popoverWidth = 290
    const popoverHeight = 320
    let left = rect.right - popoverWidth
    if (left < 10) left = 10
    if (left + popoverWidth > window.innerWidth - 10) left = window.innerWidth - popoverWidth - 10

    let top = rect.bottom + 6
    if (top + popoverHeight > window.innerHeight - 10) {
      top = rect.top - popoverHeight - 6
    }
    if (top < 10) top = 10

    popover.style.left = `${left}px`
    popover.style.top = `${top}px`

    // Header
    const header = document.createElement('div')
    header.className = 'vs-mapping-popover-header'

    const titleRow = document.createElement('div')
    titleRow.className = 'vs-mapping-popover-title-row'
    const title = document.createElement('span')
    title.className = 'vs-mapping-popover-title'
    title.textContent = triggerTitle
    titleRow.appendChild(title)
    header.appendChild(titleRow)

    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.className = 'vs-mapping-search-input'
    searchInput.placeholder = 'Search trigger variables...'
    searchInput.autocomplete = 'off'
    header.appendChild(searchInput)
    popover.appendChild(header)

    // Body
    const body = document.createElement('div')
    body.className = 'vs-mapping-popover-body'
    popover.appendChild(body)

    function renderList(query = ''): void {
      body.innerHTML = ''
      const q = query.trim().toLowerCase()
      const filtered = items.filter((item) => {
        if (!q) return true
        return (
          item.label.toLowerCase().includes(q) ||
          item.path.toLowerCase().includes(q) ||
          (item.value && item.value.toLowerCase().includes(q))
        )
      })

      if (filtered.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'vs-mapping-empty'
        empty.textContent = query ? 'No matching variables found' : 'No trigger variables available'
        body.appendChild(empty)
        return
      }

      // Group items
      const groups = new Map<string, TriggerVariableItem[]>()
      for (const item of filtered) {
        const g = item.group || 'variables'
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(item)
      }

      for (const [groupName, groupItems] of groups) {
        const gTitle = document.createElement('div')
        gTitle.className = 'vs-mapping-group-title'
        gTitle.textContent = groupName
        body.appendChild(gTitle)

        for (const item of groupItems) {
          const row = document.createElement('div')
          row.className = 'vs-mapping-item'
          row.title = `Insert \${${item.path}}`

          const nameSpan = document.createElement('span')
          nameSpan.className = 'vs-mapping-item-name'
          nameSpan.textContent = item.label || item.path

          row.appendChild(nameSpan)

          if (item.value) {
            const valSpan = document.createElement('span')
            valSpan.className = 'vs-mapping-item-val'
            valSpan.textContent = item.value
            row.appendChild(valSpan)
          }

          row.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            insertVariable(container, item.path)
            closePopover()
          })

          body.appendChild(row)
        }
      }
    }

    renderList()

    searchInput.addEventListener('input', () => {
      renderList(searchInput.value)
    })

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePopover()
      }
    })

    // Stop events from reaching slider / backdrop
    for (const evt of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup'] as const) {
      popover.addEventListener(evt, (e) => e.stopPropagation())
    }

    document.body.appendChild(popover)
    activePopover = popover

    setTimeout(() => {
      try {
        searchInput.focus()
      } catch {
        // ignore
      }
    }, 40)
  }

  function attachButton(container: HTMLElement): void {
    if (container.querySelector(`.${BTN_CLASS}, [data-testid="add-variable-button"]`)) {
      return
    }

    // Ensure input has right padding so text doesn't overlap the button
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'textarea, input:not([type="hidden"])'
    )
    if (input) {
      input.style.paddingRight = '32px'
    }

    // Look for existing right icon box in CustomAutoSuggest
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
      showPopover(button, container)
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
      closePopover()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      return
    }

    // Clean up disconnected containers
    for (const container of attachedContainers) {
      if (!container.isConnected) attachedContainers.delete(container)
    }

    // Find all custom mapping input containers inside Get Data slider
    const containers = slider.querySelectorAll<HTMLElement>(
      '[data-testid="custom-autosuggest-input-container"], [data-testid="custom-autosuggest-wrapper"]'
    )

    for (const container of containers) {
      attachButton(container)
    }
  }

  function onGlobalClick(e: MouseEvent): void {
    if (!activePopover) return
    const target = e.target as Node | null
    if (target && (activePopover.contains(target) || activeBtn?.contains(target))) {
      return
    }
    closePopover()
  }

  function onGlobalKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && activePopover) {
      closePopover()
    }
  }

  const observer = new MutationObserver(() => {
    if (scanTimer !== undefined || dead) return
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS)
  })

  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', onGlobalClick, true)
  window.addEventListener('keydown', onGlobalKeyDown, true)

  scan()

  return {
    destroy() {
      dead = true
      observer.disconnect()
      clearTimeout(scanTimer)
      document.removeEventListener('click', onGlobalClick, true)
      window.removeEventListener('keydown', onGlobalKeyDown, true)
      closePopover()
      for (const container of attachedContainers) {
        container.querySelector(`.${BTN_CLASS}`)?.remove()
      }
      attachedContainers.clear()
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
