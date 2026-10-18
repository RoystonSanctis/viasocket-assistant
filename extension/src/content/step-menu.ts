// Injects "Copy" and "Paste" into viaSocket's step three-dot menus: the canvas step-card menu and the step
// slider header menu, on flow-editor pages only. Menus are recognised by their anchors (the expanded trigger
// button and the containers it sits in), never by menu-item text, so the flow-level menu, dashboard menus and
// Developer Hub menus — which share ids and item labels with the step menus — are left untouched.
//
// The copied step lives in chrome.storage.local only. It can contain unmasked header values and code, so it
// must never be mirrored into page-readable storage (and chrome.storage already crosses tabs and accounts).

import { parsePage } from '../shared/page'
import {
  COPIED_STEP_STORAGE_KEY,
  type CopiedStepData,
  type StepClipboardRequest,
  type StepClipboardResponse,
} from '../shared/step-clipboard'
import { showToast } from './toast'

const COPY_SVG = `<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall css-vh810p" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="margin-right: 8px; width: 18px; height: 18px; flex-shrink: 0;"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2m0 16H8V7h11z"></path></svg>`
const PASTE_SVG = `<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall css-vh810p" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="margin-right: 8px; width: 18px; height: 18px; flex-shrink: 0;"><path fill="currentColor" d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"></path></svg>`

/** Real steps have 12-alphanumeric ids; the editor's pseudo-panels (trigger setup, cron pre-process, add step, ...) do not. */
const STEP_ID_RE = /^[A-Za-z0-9]{12}$/

/** Canvas step cards wrap their menu trigger in a container whose id is the step slug plus this suffix. */
const CARD_ID_SUFFIX = 'actionbutton'

export interface StepMenuController {
  destroy(): void
}

export interface StepMenuOptions {
  /**
   * Replace-navigates the editor through the MAIN-world history hook (react-router compatible); returns false
   * when the hook is not paired. Used to bump ?timestamp after a paste so the editor refetches the flow.
   */
  navigate?: (url: string, replace: boolean) => boolean
}

// ---------- helpers shared with flow-menu ----------

/**
 * Closes one MUI menu without touching anything else on the page. The editor keeps the step drawer open
 * purely through URL params and closes it from a window-level Escape listener, so a synthetic Escape (or any
 * event that can escape this menu's portal) must never be dispatched globally: it would close the drawer —
 * or, bubbling through a canvas card's click handler, open one.
 */
export function closeMenuPopover(popover: Element | null): void {
  if (!popover) return
  // Primary: call the menu's own onClose through its React fiber — no DOM event at all. The first onClose at
  // or above the popover root belongs to the menu itself; stop at it whether or not the call succeeds, so a
  // failure can never escalate into some ancestor's close handler.
  const fiberKey = Object.keys(popover).find((k) => k.startsWith('__reactFiber$'))
  let fiber: any = fiberKey ? (popover as unknown as Record<string, unknown>)[fiberKey] : null
  while (fiber) {
    const onClose = fiber.memoizedProps?.onClose
    if (typeof onClose === 'function') {
      try {
        onClose({ preventDefault: () => {}, stopPropagation: () => {} }, 'backdropClick')
        return
      } catch {
        break
      }
    }
    fiber = fiber.return
  }
  // Fallback: Escape dispatched on this popover's root only. It bubbles through the menu's own modal root,
  // whose keydown handler stops propagation, so it can never reach the window listener that closes the drawer.
  popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
}

export interface InjectedMenuItem {
  action: string
  testid: string
  label: string
  /** Static markup owned by this extension — never flow or user data. */
  iconSvg: string
  onActivate: () => void
}

/** Clones an existing MenuItem for the app's styling and fills it with our own, text-only content. */
export function buildMenuItem(template: Element, item: InjectedMenuItem): HTMLElement {
  const li = template.cloneNode(false) as HTMLElement
  li.setAttribute('data-assistant-action', item.action)
  li.setAttribute('data-testid', item.testid)
  li.setAttribute('role', 'menuitem')
  li.setAttribute('tabindex', '-1')
  li.setAttribute('aria-label', item.label)
  li.style.display = 'flex'
  li.style.alignItems = 'center'

  const icon = document.createElement('span')
  icon.style.cssText = 'display: inline-flex; align-items: center;'
  icon.innerHTML = item.iconSvg
  const label = document.createElement('span')
  label.textContent = item.label
  li.append(icon, label)

  // The page must never see these clicks: menu portals bubble events back into the owning component tree,
  // where e.g. a canvas card's own click handler would open that step's panel.
  const stop = (e: Event): void => e.stopPropagation()
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    li.addEventListener(type, stop)
  }
  li.addEventListener('click', (ev) => {
    ev.stopPropagation()
    ev.preventDefault()
    item.onActivate()
  })
  return li
}

// ---------- step menu ----------

export function initStepMenu(opts: StepMenuOptions = {}): StepMenuController {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return { destroy() {} }
  }

  let lastCopied: CopiedStepData | null = null

  // Older builds mirrored the clipboard into page localStorage; scrub any leftover copy — it can hold
  // unmasked header values and is readable by page scripts of whichever account is signed in.
  try {
    window.localStorage.removeItem(COPIED_STEP_STORAGE_KEY)
  } catch {
    // Page storage blocked; nothing to scrub then.
  }

  chrome.storage?.local
    ?.get(COPIED_STEP_STORAGE_KEY)
    .then((items) => {
      if (!items) return
      const stored = items[COPIED_STEP_STORAGE_KEY] as CopiedStepData | undefined
      if (stored && !lastCopied) {
        lastCopied = stored
        scan()
      }
    })
    .catch(() => undefined)

  const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(COPIED_STEP_STORAGE_KEY in changes)) return
    lastCopied = (changes[COPIED_STEP_STORAGE_KEY]?.newValue as CopiedStepData | undefined) ?? null
    // An open step menu may need its Paste item added or removed.
    scan()
  }
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(onStorageChanged)
  }

  /**
   * The open step menu and the slug of the step it belongs to, or null for any other open menu. The menu is
   * portaled to <body>, so step identity comes from its anchor: the trigger button expanded while it is open.
   */
  function findOpenStepMenu(): { popover: HTMLElement; menu: Element; slug: string } | null {
    // Closed MUI menus unmount, so this id lookup is the cheap bail-out the mutation observer relies on.
    const popover = document.getElementById('long-menu')
    if (!popover) return null
    const menu = popover.querySelector('[role="menu"]')
    if (!menu) return null

    const page = parsePage(window.location.href)
    if (page.kind !== 'flow-editor' || !page.scriptId) return null

    const trigger = document.querySelector('button[aria-controls="long-menu"][aria-expanded="true"]')
    if (!trigger) return null

    // Canvas step card: its container id is the step slug plus a fixed suffix.
    const card = trigger.closest(`[id$="${CARD_ID_SUFFIX}"]`)
    if (card) {
      const slug = card.id.slice(0, -CARD_ID_SUFFIX.length)
      return slug ? { popover, menu, slug } : null
    }

    // Step slider header: the open step is named by the same URL params the editor reads. Pseudo-panels
    // (trigger setup, cron pre-process, ...) use non-step ids and are not copyable.
    if (trigger.closest('#step-name-component')) {
      if (page.slugName && page.stepId && STEP_ID_RE.test(page.stepId)) {
        return { popover, menu, slug: page.slugName }
      }
    }

    // Anything else reusing the same menu component (if/multipath cards, other pages) is not copyable.
    return null
  }

  function scan(): void {
    const found = findOpenStepMenu()
    if (!found) return
    const { popover, menu, slug } = found

    const existingCopy = menu.querySelector('[data-assistant-action="copy"]')
    const existingPaste = menu.querySelector('[data-assistant-action="paste"]')
    const wantPaste = lastCopied !== null
    if (existingCopy && !!existingPaste === wantPaste) return
    existingCopy?.remove()
    existingPaste?.remove()

    const template = menu.querySelector('li[role="menuitem"]')
    if (!template) return

    menu.appendChild(
      buildMenuItem(template, {
        action: 'copy',
        testid: 'assistant-copy',
        label: 'Copy',
        iconSvg: COPY_SVG,
        onActivate: () => {
          closeMenuPopover(popover)
          void copyStep(slug)
        },
      }),
    )
    if (wantPaste) {
      menu.appendChild(
        buildMenuItem(template, {
          action: 'paste',
          testid: 'assistant-paste',
          label: 'Paste',
          iconSvg: PASTE_SVG,
          onActivate: () => {
            closeMenuPopover(popover)
            void pasteStep(slug)
          },
        }),
      )
    }
  }

  async function copyStep(slug: string): Promise<void> {
    const page = parsePage(window.location.href)
    const msg: StepClipboardRequest = {
      target: 'background',
      type: 'step:copy',
      slugName: slug,
      scriptId: page.scriptId,
      projectId: page.projectId,
      orgId: page.orgId,
      host: window.location.host,
    }
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as StepClipboardResponse<{
        stepTitle?: string
        copied?: CopiedStepData
      }>
      if (res && res.ok) {
        const title = res.data?.stepTitle || slug
        // Optimistic; the chrome.storage write the background makes confirms it for every tab.
        if (res.data?.copied) lastCopied = res.data.copied
        showToast({ title: 'Copied', message: `"${title}" is ready to paste below any step`, type: 'success' })
      } else {
        showToast({ title: 'Copy failed', message: (res && !res.ok && res.error) || 'No response from the extension', type: 'error' })
      }
    } catch (e) {
      showToast({ title: 'Copy error', message: errorText(e), type: 'error' })
    }
  }

  /**
   * Bumps the editor's ?timestamp so it refetches the flow and shows the pasted step even when the server's
   * live-apply push was missed (dropped websocket). True when nothing needed refreshing or the bump was
   * delivered; false when the editor may still show the stale flow.
   */
  function bumpEditorTimestamp(scriptId: string | undefined): boolean {
    if (!opts.navigate) return false
    const now = parsePage(window.location.href)
    // The user moved to another page while the paste ran: nothing here to refresh.
    if (now.kind !== 'flow-editor' || !scriptId || now.scriptId !== scriptId) return true
    try {
      const u = new URL(window.location.href)
      const prev = Number(u.searchParams.get('timestamp'))
      const stamp = Number.isFinite(prev) && prev >= Date.now() ? prev + 1 : Date.now()
      u.searchParams.set('timestamp', String(stamp))
      return opts.navigate(u.pathname + u.search + u.hash, true)
    } catch {
      return false
    }
  }

  async function pasteStep(targetSlug: string): Promise<void> {
    if (!lastCopied) {
      showToast({ title: 'Nothing to paste', message: 'Copy a step first.', type: 'info' })
      return
    }
    const page = parsePage(window.location.href)
    const progress = showToast({
      title: 'Pasting…',
      message: `Inserting "${lastCopied.source.stepTitle}" below "${targetSlug}"`,
      type: 'info',
      durationMs: 0,
    })
    const msg: StepClipboardRequest = {
      target: 'background',
      type: 'step:paste',
      targetSlugName: targetSlug,
      scriptId: page.scriptId,
      projectId: page.projectId,
      orgId: page.orgId,
      host: window.location.host,
    }
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as StepClipboardResponse<{ title?: string; note?: string }>
      progress.dismiss()
      if (res && res.ok) {
        // The live-apply push alone can be missed; the bump makes the open editor refetch the flow.
        const refreshed = bumpEditorTimestamp(page.scriptId)
        const note = res.data?.note || `"${res.data?.title || targetSlug}" pasted below "${targetSlug}"`
        showToast({
          title: 'Pasted',
          message: refreshed ? note : `${note} Refresh the page if the step does not appear.`,
          type: 'success',
          durationMs: 4500,
        })
      } else {
        showToast({ title: 'Paste failed', message: (res && !res.ok && res.error) || 'No response from the extension', type: 'error' })
      }
    } catch (e) {
      progress.dismiss()
      showToast({ title: 'Paste error', message: errorText(e), type: 'error' })
    }
  }

  const observer = new MutationObserver(() => {
    try {
      scan()
    } catch (e) {
      console.warn('[step-menu] scan failed:', e)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return {
    destroy() {
      // Called when this copy of the script is orphaned, where chrome.* APIs throw "Extension context
      // invalidated" - the rest of the shutdown must still run.
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
          chrome.storage.onChanged.removeListener(onStorageChanged)
        }
      } catch {
        // context already invalidated
      }
      observer.disconnect()
    },
  }
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Could not reach the extension background'
}
