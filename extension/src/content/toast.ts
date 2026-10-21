// Bottom-right toasts for the assistant's injected menu actions (step copy/paste, flow export/import).
// Every dynamic string — titles, step names, warnings, error text — is rendered via textContent so that
// flow data (which after a cross-account copy or import is another account's data) can never inject markup.
// Only the static icon constants below go through innerHTML.

const CONTAINER_ID = 'vs-assistant-toast-container'

export interface ToastOptions {
  title: string
  message?: string
  type?: 'success' | 'info' | 'error'
  /** How long the toast stays, in ms. 0 keeps it until dismissed by click or through its handle. */
  durationMs?: number
}

export interface ToastHandle {
  dismiss(): void
}

// Static markup only — never interpolate data into these.
const ICON_SUCCESS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5DCAA5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:2px;"><polyline points="20 6 9 17 4 12"></polyline></svg>`
const ICON_ERROR = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F09595" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:2px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
const ICON_INFO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#85B7EB" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:2px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`

const ICONS = { success: ICON_SUCCESS, error: ICON_ERROR, info: ICON_INFO } as const

function container(): HTMLElement {
  let el = document.getElementById(CONTAINER_ID)
  if (!el) {
    el = document.createElement('div')
    el.id = CONTAINER_ID
    el.style.cssText =
      'position: fixed; bottom: 24px; right: 24px; z-index: 9999999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;'
    document.body.appendChild(el)
  }
  return el
}

export function showToast({ title, message, type = 'info', durationMs = 3800 }: ToastOptions): ToastHandle {
  const toast = document.createElement('div')
  toast.style.cssText =
    'pointer-events: auto; background: var(--vs-bg-secondary, #1a1c1e); color: var(--vs-text-secondary, #f0f2f5); border: 1px solid var(--vs-border, rgba(255,255,255,0.14)); border-radius: 10px; padding: 11px 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); display: flex; align-items: flex-start; gap: 12px; font-size: 13px; line-height: 1.4; max-width: 380px; opacity: 0; transform: translateY(10px); transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); cursor: pointer;'

  const icon = document.createElement('span')
  icon.style.cssText = 'display: inline-flex; flex-shrink: 0;'
  icon.innerHTML = ICONS[type]

  const body = document.createElement('div')
  body.style.flex = '1'
  const titleEl = document.createElement('div')
  titleEl.style.cssText = `font-weight: 600; color: var(--vs-text-primary, #ffffff); margin-bottom: ${message ? '2px' : '0'};`
  titleEl.textContent = title
  body.appendChild(titleEl)
  if (message) {
    const messageEl = document.createElement('div')
    messageEl.style.cssText = 'font-size: 12px; color: var(--vs-text-muted, #a9adb3);'
    messageEl.textContent = message
    body.appendChild(messageEl)
  }
  toast.append(icon, body)

  let gone = false
  let timer: number | undefined
  const dismiss = (): void => {
    if (gone) return
    gone = true
    if (timer !== undefined) clearTimeout(timer)
    toast.style.opacity = '0'
    toast.style.transform = 'translateY(8px)'
    setTimeout(() => toast.remove(), 250)
  }
  toast.addEventListener('click', dismiss)

  container().appendChild(toast)
  requestAnimationFrame(() => {
    toast.style.opacity = '1'
    toast.style.transform = 'translateY(0)'
  })
  if (durationMs > 0) timer = window.setTimeout(dismiss, durationMs)

  return { dismiss }
}

/** Removes the toast container (and any toasts in it); used when the content script shuts down. */
export function destroyToasts(): void {
  document.getElementById(CONTAINER_ID)?.remove()
}
