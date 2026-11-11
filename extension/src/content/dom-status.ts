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

  // 1. Step, action, and service title from slider header
  let stepTitle: string | undefined
  let actionTitle: string | undefined
  let serviceTitle: string | undefined

  const headerEl = slider.querySelector<HTMLElement>(
    'h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], [data-testid="action-title"], .MuiTypography-h6'
  )
  if (headerEl?.textContent) {
    const raw = headerEl.textContent.trim()
    if (raw && !/^(change|close)$/i.test(raw)) {
      stepTitle = raw
      actionTitle = raw
    }
  }
  if (!stepTitle) {
    const urlParams = new URLSearchParams(location.search)
    stepTitle = urlParams.get('slugName') || urlParams.get('stepId') || undefined
  }

  const serviceIcon = slider.querySelector<HTMLImageElement>('img[alt], [data-testid="plugin-icon"]')
  if (serviceIcon) {
    const alt = serviceIcon.getAttribute('alt') || serviceIcon.getAttribute('title')
    if (alt && !/icon|logo/i.test(alt)) serviceTitle = alt.trim()
  }

  // 2. Connection and Auth ID
  let connection: string | undefined
  let authId: string | undefined

  const authTitleRow = slider.querySelector<HTMLElement>('[data-auth-title-row]')
  if (authTitleRow) {
    const parts: string[] = []
    const labelEl = authTitleRow.querySelector<HTMLElement>(
      'button, .truncate, .MuiChip-label, .MuiTypography-root'
    )
    if (labelEl?.textContent?.trim()) {
      const text = labelEl.textContent.trim()
      if (!/^(using connection|add title|\*)$/i.test(text)) parts.push(text)
    }
    const descEl = authTitleRow.querySelector<HTMLElement>(
      '[data-testid="auth-connection-title-textfield"], p, span'
    )
    if (descEl?.textContent?.trim()) {
      const descText = descEl.textContent.trim().replace(/^\[|\]$/g, '')
      if (descText && !/add title/i.test(descText) && !parts.includes(descText)) {
        parts.push(descText)
      }
    }
    if (parts.length > 0) {
      connection = parts.join(' ')
    } else if (authTitleRow.textContent?.trim()) {
      const clean = authTitleRow.textContent.replace(/add title/gi, '').trim()
      if (clean) connection = clean
    }
  }

  if (!connection) {
    const authCard = slider.querySelector<HTMLElement>(
      '[data-testid="auth-connection-card"], [data-testid="plugin-authentication-section"]'
    )
    if (authCard) {
      const texts = Array.from(authCard.querySelectorAll('p, span, button, [class*="chip"]'))
        .map((el) => el.textContent?.trim() || '')
        .filter((t) => t && !/^(using connection|add title|\*)$/i.test(t))
      if (texts.length > 0) {
        connection = Array.from(new Set(texts)).join(' ')
      }
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

  const authSelectInput = slider.querySelector<HTMLInputElement>(
    '[data-testid="auth-connection-select"] input[type="hidden"], [data-testid="auth-connection-select"] .MuiSelect-nativeInput'
  )
  if (authSelectInput && authSelectInput.value && authSelectInput.value !== 'select') {
    authId = authSelectInput.value.trim()
  }

  // 3. Form fields, mappings, and validation errors
  const selectedFields: Record<string, string> = {}
  const draftMappings: Record<string, string> = {}
  const fieldErrors: Record<string, string> = {}
  const emptyRequiredFields: string[] = []

  const allFieldRows = Array.from(
    slider.querySelectorAll<HTMLElement>(
      '[data-testid^="plugin-field-"]:not([data-testid^="plugin-field-label-"]), .plugin-field-row, [data-testid="custom-field-box"]'
    )
  )
  // Leaf field rows: rows that do not contain other matching field rows
  const leafRows = allFieldRows.filter((row) => {
    return !allFieldRows.some((other) => other !== row && row.contains(other))
  })
  const fieldRows = leafRows.length > 0 ? leafRows : allFieldRows

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

    const isRequired = Boolean(
      labelEl.textContent?.includes('*') ||
      labelEl.querySelector('[color="error"], .MuiFormLabel-asterisk, span.text-red-500, [data-required="true"]') ||
      row.getAttribute('id')?.startsWith('scroll-') ||
      row.getAttribute('data-required') === 'true'
    )

    let value: string | undefined

    // a) Autocomplete chips (e.g. Spreadsheet: "Google Sheets Testing Sheet", Sheet: "Sheet1", Columns: "name")
    const chips = row.querySelectorAll<HTMLElement>(
      '[data-testid^="dropdown-chip-"], .MuiChip-label, .MuiAutocomplete-tag, .chip'
    )
    if (chips.length > 0) {
      const vals = Array.from(chips)
        .map((c) => c.textContent?.trim())
        .filter((t): t is string => Boolean(t && t !== '×' && !/^(add title|choose)$/i.test(t)))
      const uniqueVals = Array.from(new Set(vals))
      if (uniqueVals.length > 0) {
        value = uniqueVals.join(', ')
      }
    }

    // b) Radio buttons / toggle buttons
    if (!value) {
      const checkedRadio = row.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      if (checkedRadio) {
        const radioLabel = checkedRadio.closest('label')?.textContent?.trim() || checkedRadio.value
        if (radioLabel) value = radioLabel.trim()
      }
    }

    // c) Checkbox
    if (!value) {
      const checkedCheckbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]:checked')
      if (checkedCheckbox) {
        value = 'true'
      }
    }

    // d) Text / select input
    if (!value) {
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select'
      )
      if (input && input.value?.trim()) {
        value = input.value.trim()
      }
    }

    // e) Textarea / CustomAutoSuggestV2 / Mentions
    if (!value) {
      const textarea = row.querySelector<HTMLTextAreaElement>('textarea')
      if (textarea && textarea.value?.trim()) {
        value = textarea.value.trim()
      }
    }

    // f) Custom chips or elements inside CustomAutoSuggest
    if (!value) {
      const suggestChips = row.querySelectorAll<HTMLElement>(
        '.customAutoSuggestForPlugin .MuiChip-label, [data-testid="custom-autosuggest"] .MuiChip-label, .mentions__mention'
      )
      if (suggestChips.length > 0) {
        const vals = Array.from(suggestChips).map((c) => c.textContent?.trim()).filter(Boolean)
        if (vals.length > 0) value = vals.join(' ')
      }
    }

    // Validation error text inside this field row
    let fieldError: string | undefined
    const errorEls = row.querySelectorAll<HTMLElement>(
      '[color="error"], .MuiTypography-colorError, .Mui-error, [role="alert"], [data-testid="local-notification-alert"], .text-red-500, .text-danger, p.MuiFormHelperText-root.Mui-error'
    )
    for (const errEl of Array.from(errorEls)) {
      const t = errEl.textContent?.trim()
      if (t && t !== '*' && !/^\*+$/.test(t)) {
        fieldError = t
        break
      }
    }
    if (!fieldError) {
      const text = row.innerText || ''
      const match = text.match(/(this field can't be empty\.?|enter valid number[^.\n]*|invalid value[^.\n]*)/i)
      if (match && match[1]) {
        fieldError = match[1].trim()
      }
    }
    if (fieldError) {
      fieldErrors[rawLabel] = fieldError
    }

    // Check if required field is empty
    if (isRequired && (!value || value.trim() === '')) {
      emptyRequiredFields.push(rawLabel)
    }

    const isMappingField = Boolean(
      row.querySelector('textarea, .customAutoSuggestForPlugin, [data-testid="custom-autosuggest"]') ||
      row.querySelector('textarea[placeholder*="Map data"], input[placeholder*="Map data"]')
    )
    if (isMappingField) {
      draftMappings[rawLabel] = value || ''
    }

    if (value) {
      selectedFields[rawLabel] = value
    }
  })

  // 4. Slider alerts / notifications
  const sliderErrors: string[] = []
  const alerts = slider.querySelectorAll<HTMLElement>(
    '[data-testid="local-notification-alert"], .MuiAlert-root[class*="Error"], .MuiAlert-standardError, .MuiAlert-filledError'
  )
  alerts.forEach((alert) => {
    const t = alert.textContent?.trim()
    if (t && !sliderErrors.includes(t)) sliderErrors.push(t)
  })

  // 5. Has Unsaved Changes
  const discardBtn = Array.from(slider.querySelectorAll('button')).find((b) =>
    /discard changes/i.test(b.textContent || '')
  )
  if (discardBtn || /unsaved changes/i.test(slider.innerText) || hasUnsavedChanges) {
    hasUnsavedChanges = true
  }

  // 6. Tested in UI / Sample response
  let testedInUi = false
  let hasSampleResponse = false
  const sliderText = slider.innerText || ''
  if (/sample response|sample data/i.test(sliderText)) {
    hasSampleResponse = true
    const codeBlock = slider.querySelector('pre, code, [data-testid="sample-response"]')
    if (codeBlock?.textContent?.trim() || /"success":\s*true|"data":/i.test(sliderText)) {
      testedInUi = true
    }
  }

  // 7. Can save button
  const saveBtn = slider.querySelector<HTMLButtonElement>(
    '[data-testid="save-button"], [data-testid="trigger-save-button"]'
  ) || Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
  )
  const canSave = Boolean(saveBtn && !saveBtn.disabled && !saveBtn.getAttribute('aria-disabled'))

  // 8. In-memory Redux draft step data (synced by main-world hook into data-vs-draft-step attribute)
  let draftInputData: Record<string, unknown> | undefined
  let reduxStepId: string | undefined
  let reduxSlugName: string | undefined
  let serviceId: string | undefined
  let selectedCreate: string | undefined
  let actionVersionId: string | undefined

  try {
    const rawAttr = document.documentElement.getAttribute('data-vs-draft-step')
    if (rawAttr) {
      const parsed = JSON.parse(rawAttr)
      if (parsed && typeof parsed === 'object') {
        if (parsed.inputData && typeof parsed.inputData === 'object') draftInputData = parsed.inputData
        if (typeof parsed.stepId === 'string') reduxStepId = parsed.stepId
        if (typeof parsed.slugName === 'string') reduxSlugName = parsed.slugName
        if (typeof parsed.serviceId === 'string') serviceId = parsed.serviceId
        if (typeof parsed.selectedCreate === 'string') selectedCreate = parsed.selectedCreate
        if (typeof parsed.actionVersionId === 'string') actionVersionId = parsed.actionVersionId
        if (!connection && typeof parsed.connectionLabel === 'string') connection = parsed.connectionLabel
        if (!authId && typeof parsed.authId === 'string') authId = parsed.authId
      }
    }
  } catch {
    // ignore parse error
  }

  return {
    panelOpen: true,
    stepTitle,
    actionTitle,
    serviceTitle,
    connection,
    authId,
    selectedFields,
    draftMappings: Object.keys(draftMappings).length > 0 ? draftMappings : undefined,
    draftInputData,
    stepId: reduxStepId,
    slugName: reduxSlugName,
    serviceId,
    selectedCreate,
    actionVersionId,
    fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    emptyRequiredFields: emptyRequiredFields.length > 0 ? emptyRequiredFields : undefined,
    sliderErrors: sliderErrors.length > 0 ? sliderErrors : undefined,
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
