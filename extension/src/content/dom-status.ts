// Inspects the live DOM on viaSocket flow pages to capture what the user has open,
// selected, or tested in the side panel. Changes in the UI are draft-only in React state
// until the user clicks Save or the assistant calls vs_update_step.

import type { DomPageStatus } from '../shared/messages'

const DEBOUNCE_MS = 250

export function extractDomPageStatus(): DomPageStatus {
  const empty: DomPageStatus = {
    panelOpen: false,
    selectedFields: {},
    hasUnsavedChanges: false,
    testedInUi: false,
    hasSampleResponse: false,
    canSave: false,
  }

  if (typeof document === 'undefined') return empty

  const slider = document.querySelector<HTMLElement>(
    '[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider'
  )
  const isSliderVisible = Boolean(slider && (slider.offsetWidth > 0 || slider.offsetHeight > 0 || slider.getClientRects().length > 0))

  // Also check if any step node on the canvas shows "Unsaved Changes"
  let hasUnsavedChanges = false
  const unsavedBadge = document.querySelector('[data-testid^="step-node-"]')
  if (unsavedBadge && /unsaved changes/i.test(document.body.innerText)) {
    hasUnsavedChanges = true
  }

  if (!slider || !isSliderVisible) {
    return {
      ...empty,
      hasUnsavedChanges,
    }
  }

  // 1. Step or trigger title from slider header
  let stepTitle: string | undefined
  const headerEl = slider.querySelector<HTMLElement>(
    'h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], [data-testid="action-title"], .MuiTypography-h6'
  )
  if (headerEl?.textContent) {
    const raw = headerEl.textContent.trim()
    if (raw && !/^(change|close)$/i.test(raw)) {
      stepTitle = raw
    }
  }
  if (!stepTitle) {
    const urlParams = new URLSearchParams(location.search)
    stepTitle = urlParams.get('slugName') || urlParams.get('stepId') || undefined
  }

  // 2. Connection
  let connection: string | undefined
  const authEl = slider.querySelector<HTMLElement>(
    '[data-testid="plugin-authentication-section"], [data-auth-title-row], [data-testid="auth-connection-title-textfield"]'
  )
  if (authEl) {
    const desc = authEl.querySelector('button, [data-testid="auth-connection-title-textfield"], .MuiTypography-root')
    if (desc?.textContent?.trim()) {
      const text = desc.textContent.trim()
      if (!/add title/i.test(text)) connection = text
    }
  }
  if (!connection) {
    // Look for "Using Connection" text in slider
    const walker = document.createTreeWalker(slider, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.textContent && /using connection/i.test(node.textContent)) {
        const parent = node.parentElement
        const sibling = parent?.nextElementSibling || parent?.parentElement?.querySelector('button, .MuiChip-root')
        if (sibling?.textContent?.trim()) {
          connection = sibling.textContent.trim()
          break
        }
      }
    }
  }

  // 3. Selected fields in slider
  const selectedFields: Record<string, string> = {}
  const fieldRows = slider.querySelectorAll<HTMLElement>(
    '[data-testid^="plugin-field-"], [data-testid="plugin-form-container"] > div, .plugin-field-row'
  )

  fieldRows.forEach((row) => {
    const labelEl = row.querySelector<HTMLElement>(
      '[data-testid^="plugin-field-label-"], label, .MuiFormLabel-root'
    )
    if (!labelEl) return
    const rawLabel = (labelEl.textContent || '')
      .replace(/[*:]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!rawLabel || /^(using connection|add title)$/i.test(rawLabel)) return

    // Find value:
    // a) Autocomplete chips (e.g. Spreadsheet: "msg91", Sheet: "Notes")
    const chips = row.querySelectorAll<HTMLElement>(
      '[data-testid^="dropdown-chip-"], .MuiChip-label, .MuiAutocomplete-tag'
    )
    if (chips.length > 0) {
      const vals = Array.from(chips)
        .map((c) => c.textContent?.trim())
        .filter(Boolean)
      if (vals.length > 0) {
        selectedFields[rawLabel] = vals.join(', ')
        return
      }
    }

    // b) Radio buttons / toggle buttons (e.g. "Does your first row contain column name?: Yes")
    const checkedRadio = row.querySelector<HTMLInputElement>('input[type="radio"]:checked')
    if (checkedRadio) {
      const radioLabel = checkedRadio.closest('label')?.textContent?.trim() || checkedRadio.value
      if (radioLabel) {
        selectedFields[rawLabel] = radioLabel
        return
      }
    }

    // c) Text / select input
    const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(
      'input[type="text"]:not([type="hidden"]), select'
    )
    if (input && input.value?.trim()) {
      selectedFields[rawLabel] = input.value.trim()
      return
    }
  })

  // 4. Has Unsaved Changes
  const discardBtn = Array.from(slider.querySelectorAll('button')).find((b) =>
    /discard changes/i.test(b.textContent || '')
  )
  if (discardBtn || /unsaved changes/i.test(slider.innerText) || hasUnsavedChanges) {
    hasUnsavedChanges = true
  }

  // 5. Tested in UI / Sample response
  let testedInUi = false
  let hasSampleResponse = false
  const sliderText = slider.innerText || ''
  if (/sample response|sample data/i.test(sliderText)) {
    hasSampleResponse = true
    // Check if there is actual output below Sample Response
    const codeBlock = slider.querySelector('pre, code, [data-testid="sample-response"]')
    if (codeBlock?.textContent?.trim() || /"success":\s*true|"data":/i.test(sliderText)) {
      testedInUi = true
    }
  }

  // 6. Can save button
  const saveBtn = slider.querySelector<HTMLButtonElement>(
    '[data-testid="save-button"], [data-testid="trigger-save-button"]'
  ) || Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
  )
  const canSave = Boolean(saveBtn && !saveBtn.disabled)

  return {
    panelOpen: true,
    stepTitle,
    connection,
    selectedFields,
    hasUnsavedChanges,
    testedInUi,
    hasSampleResponse,
    canSave,
  }
}

export function watchDomStatus(onChange: (status: DomPageStatus) => void): {
  getStatus(): DomPageStatus
  destroy(): void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSerialized = ''

  function check(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const current = extractDomPageStatus()
      const serialized = JSON.stringify(current)
      if (serialized !== lastSerialized) {
        lastSerialized = serialized
        onChange(current)
      }
    }, DEBOUNCE_MS)
  }

  const observer = new MutationObserver(check)
  if (typeof document !== 'undefined' && document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-testid', 'value', 'checked'],
    })
  }

  const onEvent = () => check()
  window.addEventListener('input', onEvent, { capture: true, passive: true })
  window.addEventListener('change', onEvent, { capture: true, passive: true })
  window.addEventListener('click', onEvent, { capture: true, passive: true })

  // Initial immediate check
  check()

  return {
    getStatus: () => extractDomPageStatus(),
    destroy() {
      clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('input', onEvent, true)
      window.removeEventListener('change', onEvent, true)
      window.removeEventListener('click', onEvent, true)
    },
  }
}
