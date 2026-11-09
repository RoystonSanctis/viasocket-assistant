// Injects "Export Flow" and "Import Flow" into the flow-level three-dot menu of the flow
// editor's navbar. The menu is recognised by its anchor — the navbar's more-options button, expanded exactly
// while its menu is open — never by menu-item text, and only on flow-editor pages: the same menu id is reused
// by the avatar and workspace-selector menus, which must stay untouched.
//
// Export downloads the flow as a JSON file; Import reads such a file and asks the background to recreate the
// flow in the current project, then moves to the new flow. Closing the menu uses the same drawer-safe
// technique as the step menus, so an open step panel keeps its exact state through both actions.

import {
  FLOW_EXPORT_NOTE,
  MAX_IMPORT_BYTES,
  type FlowExportResult,
  type FlowImportResult,
  type FlowTransferRequest,
  type FlowTransferResponse,
} from '../shared/flow-transfer'
import { parsePage } from '../shared/page'
import { buildMenuItem, closeMenuPopover, errorText } from './step-menu'
import { showToast } from './toast'

const EXPORT_SVG = `<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall css-vh810p" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="margin-right: 8px; width: 18px; height: 18px; flex-shrink: 0;"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`
const IMPORT_SVG = `<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall css-vh810p" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="margin-right: 8px; width: 18px; height: 18px; flex-shrink: 0;"><path fill="currentColor" d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"></path></svg>`

export interface FlowMenuController {
  destroy(): void
}

export interface FlowMenuOptions {
  /**
   * Replace-navigates the editor through the MAIN-world history hook (react-router compatible).
   * Used to bump ?timestamp after an import so the editor refetches the replaced flow.
   */
  navigate?: (url: string, replace: boolean) => boolean
}

let menuOpts: FlowMenuOptions = {}

export function initFlowMenu(opts: FlowMenuOptions = {}): FlowMenuController {
  menuOpts = opts
  /**
   * The open flow menu, or null when the open menu (if any) is something else. The menu id is shared with the
   * avatar and workspace menus, so the discriminator is the flow trigger's own expanded state.
   */
  function findOpenFlowMenu(): { popover: HTMLElement; menu: Element } | null {
    // Closed MUI menus unmount, so this id lookup is the cheap bail-out the mutation observer relies on.
    const popover = document.getElementById('account-menu')
    if (!popover) return null
    const trigger = document.querySelector('[data-testid="flow-more-options-button"][aria-expanded="true"]')
    if (!trigger) return null

    const page = parsePage(window.location.href)
    if (page.kind !== 'flow-editor' || !page.scriptId || !page.projectId) return null

    const menu = popover.querySelector('[role="menu"]')
    return menu ? { popover, menu } : null
  }

  function scan(): void {
    const found = findOpenFlowMenu()
    if (!found) return
    const { popover, menu } = found
    if (menu.querySelector('[data-assistant-action="flow-export"]')) return

    const items = menu.querySelectorAll('li[role="menuitem"]')
    const template = items[0]
    if (!template) return

    const exportLi = buildMenuItem(template, {
      action: 'flow-export',
      testid: 'assistant-flow-export',
      label: 'Export Flow',
      iconSvg: EXPORT_SVG,
      onActivate: () => {
        closeMenuPopover(popover)
        void exportFlow()
      },
    })
    const importLi = buildMenuItem(template, {
      action: 'flow-import',
      testid: 'assistant-flow-import',
      label: 'Import Flow',
      iconSvg: IMPORT_SVG,
      onActivate: () => {
        closeMenuPopover(popover)
        // Give the menu a beat to actually unmount before the (modal) file picker takes over.
        window.setTimeout(pickImportFile, 50)
      },
    })

    // The menu keeps its destructive action last; our items go just above that final item.
    const last = items[items.length - 1]
    if (last && last.parentElement === menu) {
      last.insertAdjacentElement('beforebegin', exportLi)
      last.insertAdjacentElement('beforebegin', importLi)
    } else {
      menu.append(exportLi, importLi)
    }
  }

  const observer = new MutationObserver(() => {
    try {
      scan()
    } catch (e) {
      console.warn('[flow-menu] scan failed:', e)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return {
    destroy() {
      observer.disconnect()
    },
  }
}

// ---------- export ----------

async function exportFlow(): Promise<void> {
  const page = parsePage(window.location.href)
  if (page.kind !== 'flow-editor' || !page.scriptId || !page.projectId) {
    showToast({ title: 'Export failed', message: 'Open the flow you want to export first.', type: 'error' })
    return
  }
  const msg: FlowTransferRequest = {
    target: 'background',
    type: 'flow:export',
    scriptId: page.scriptId,
    projectId: page.projectId,
    orgId: page.orgId,
    host: window.location.host,
  }
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as FlowTransferResponse<FlowExportResult>
    if (res && res.ok) {
      downloadJson(res.data.fileName, res.data.json)
      const warnings = (res.data.warnings ?? []).join(' ')
      showToast({
        title: 'Flow exported',
        message: `"${res.data.title}" was saved as ${res.data.fileName}${warnings ? ` ${warnings}` : ''}`,
        type: 'success',
        durationMs: warnings ? 9000 : 3800,
      })
      // The file carries every value typed into steps - the one place this HAS to be said is right here.
      showToast({ title: 'Before sharing that file', message: FLOW_EXPORT_NOTE, type: 'info', durationMs: 15000 })
    } else {
      showToast({ title: 'Export failed', message: (res && !res.ok && res.error) || 'No response from the extension', type: 'error' })
    }
  } catch (e) {
    showToast({ title: 'Export error', message: errorText(e), type: 'error' })
  }
}

/** Hands the export JSON to the browser as a file download; the data never leaves the page. */
function downloadJson(fileName: string, json: string): void {
  try {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // The click has handed the blob to the download; the object URL itself can go on the next turn.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    try {
      const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(json)
      const a = document.createElement('a')
      a.href = dataUri
      a.download = fileName
      a.target = '_blank'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e2) {
      console.error('[flow-menu] downloadJson failed:', e2)
    }
  }
}

// ---------- import ----------

/** An import is many serial API calls; a second one started meanwhile would corrupt the flow. */
let importBusy = false

function pickImportFile(): void {
  if (importBusy) {
    showToast({ title: 'Import already running', message: 'Wait for the current import to finish.', type: 'info' })
    return
  }
  importBusy = true
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener(
    'cancel',
    () => {
      input.remove()
      importBusy = false
    },
    { once: true },
  )
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0] ?? null
      input.remove()
      if (file) {
        void importFlow(file).finally(() => {
          importBusy = false
        })
      } else {
        importBusy = false
      }
    },
    { once: true },
  )
  input.click()
}

async function importFlow(file: File): Promise<void> {
  if (file.size > MAX_IMPORT_BYTES) {
    const limitMb = Math.round(MAX_IMPORT_BYTES / (1024 * 1024))
    showToast({
      title: 'Import failed',
      message: `"${file.name}" is larger than ${limitMb} MB — that is not a viaSocket flow export.`,
      type: 'error',
    })
    return
  }
  const page = parsePage(window.location.href)
  if (page.kind !== 'flow-editor' || !page.projectId || !page.scriptId) {
    showToast({ title: 'Import failed', message: 'Open the flow you want to import into first.', type: 'error' })
    return
  }
  let json: string
  try {
    json = await file.text()
  } catch {
    showToast({ title: 'Import failed', message: `Could not read "${file.name}".`, type: 'error' })
    return
  }

  const progress = showToast({ title: 'Importing flow…', message: file.name, type: 'info', durationMs: 0 })
  const msg: FlowTransferRequest = {
    target: 'background',
    type: 'flow:import',
    json,
    scriptId: page.scriptId,
    projectId: page.projectId,
    orgId: page.orgId,
    host: window.location.host,
  }
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as FlowTransferResponse<FlowImportResult>
    progress.dismiss()
    if (res && res.ok) {
      const warnings = (res.data.warnings ?? []).join(' ')
      showToast({
        title: 'Flow imported',
        message: warnings
          ? `Flow replaced successfully. ${warnings}`
          : `Flow replaced successfully. Refreshing flow…`,
        type: 'success',
        durationMs: 4000,
      })

      // Refresh the existing flow in-place so the canvas shows the newly imported flow
      window.setTimeout(() => {
        try {
          if (menuOpts.navigate) {
            const u = new URL(window.location.href)
            u.searchParams.delete('slugName')
            u.searchParams.delete('stepId')
            const prev = Number(u.searchParams.get('timestamp'))
            const stamp = Number.isFinite(prev) && prev >= Date.now() ? prev + 1 : Date.now()
            u.searchParams.set('timestamp', String(stamp))
            menuOpts.navigate(u.pathname + u.search + u.hash, true)
          }
        } catch {}
        // Reload page/iframe to completely refetch and display the replaced flow
        window.location.reload()
      }, 1000)
    } else {
      showToast({ title: 'Import failed', message: (res && !res.ok && res.error) || 'No response from the extension', type: 'error' })
    }
  } catch (e) {
    progress.dismiss()
    showToast({ title: 'Import error', message: errorText(e), type: 'error' })
  }
}

