// The "Subfunctions" panel above the code of a JS step.
//
// A subfunction lets step code call an app action: the step's `subfunctions` lists {name, actionId, authId}, and the
// backend declares `async function <name>({ inputData })` for each entry, bound to that connection. This panel adds
// and edits them the way an app step is configured: app -> action -> connection -> input fields. Saving writes
// `const r = await <name>({ inputData: {...} })` into the code (or rewrites the inputData of the existing call) and
// saves the step to the flow's draft. Nothing is published.
//
// The page is only read, through the MAIN-world hook (the step's code and subfunctions as the editor holds them).
// Every viaSocket call goes through the service worker (background/subfunctions.ts). Dynamic text is only ever set
// with textContent; the static SVG constants below are the only markup.

import type { StepContextData } from '../shared/messages'
import {
  NO_AUTH_ID,
  type SubfnAction,
  type SubfnActionDetail,
  type SubfnApp,
  type SubfnConnection,
  type SubfnGroupResult,
  type SubfnOptionsResult,
  type SubfnRequest,
  type SubfnResponse,
  type SubfnSaveResult,
  type SubfunctionRef,
} from '../shared/subfunctions'
import {
  countCalls,
  declaresName,
  findSubfunctionCalls,
  insertSubfunctionCall,
  isSubfunctionName,
  removeCallStatements,
  renameSubfunction,
  replaceCallInput,
  subfunctionNameFor,
  type SubfunctionCall,
} from '../shared/subfunctions-parser'
import { InputsModel, plainValues } from '../shared/subfunction-inputs'
import type { PageBridge } from './page-bridge'
import { FORM_CSS, renderInputs, type InputsView } from './subfunction-form'
import { showToast } from './toast'

const BAR_ID = 'vs-subfunctions-bar'
const MODAL_ID = 'vs-subfunctions-modal'
const THEME_STYLE_ID = 'vs-global-styles'
const PANEL_STYLE_ID = 'vs-subfunctions-styles'
/** Rendered only for JS steps: the editor's wrapper around the step's code */
const CODE_ANCHOR_ID = 'code-editor-ref'
const POLL_MS = 1000
const SEARCH_DEBOUNCE_MS = 300
const CONNECT_POLL_MS = 3000
const CONNECT_POLL_MAX_MS = 180_000

// Static markup only — never interpolate data into these.
const SVG = {
  bolt: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  edit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  variable: `<svg width="16" height="16" viewBox="0 0 35 35" fill="none"><rect width="35" height="35" rx="6" fill="#F97316"/><path d="M13.8837 25.8141C13.4949 26.1951 12.8727 26.1951 12.4838 25.8141L4.7288 18.2142C4.3287 17.8221 4.3287 17.1779 4.7288 16.7858L12.4838 9.18592C12.8727 8.80488 13.4949 8.80487 13.8837 9.18592L14.6361 9.92328C15.0362 10.3154 15.0362 10.9596 14.6361 11.3517L9.05282 16.8233C8.65272 17.2154 8.65272 17.8596 9.05282 18.2517L14.5978 23.6858C14.9979 24.0779 14.9979 24.7221 14.5978 25.1142L13.8837 25.8141ZM22.5162 25.8141C22.1273 26.1951 21.5051 26.1951 21.1163 25.8141L20.3639 25.0767C19.9638 24.6846 19.9638 24.0404 20.3639 23.6483L25.9472 18.1767C26.3473 17.7846 26.3473 17.1404 25.9472 16.7483L20.4021 11.3142C20.002 10.9221 20.0021 10.2779 20.4021 9.88578L21.1163 9.18592C21.5051 8.80487 22.1273 8.80487 22.5162 9.18592L30.2712 16.7858C30.6713 17.1779 30.6713 17.8221 30.2712 18.2142L22.5162 25.8141Z" fill="white"/></svg>`,
} as const

// viaSocket's own design tokens (src/scss/base/_var.scss: --col-surface-*, --col-text-*, --col-divider,
// --col-control-edge, --col-primary-button, --col-link, …) are defined on <html> for light and dark mode, so the panel
// looks and switches like the editor around it. The fallbacks are the light values. toast.ts reads the same variables.
const THEME_CSS = `
:root {
  --vs-bg-primary: var(--col-surface-paper, #ffffff);
  --vs-bg-secondary: var(--col-surface-default, #fafaf8);
  --vs-bg-tertiary: var(--col-surface-sunken, #f2f2ef);
  --vs-bg-card: var(--col-surface-raised, #ffffff);
  --vs-bg-hover: var(--col-control-hover, #f1f0ec);
  --vs-bg-input: var(--col-surface-paper, #ffffff);
  --vs-border: var(--col-divider, rgba(26, 27, 25, 0.1));
  --vs-border-subtle: var(--col-divider, rgba(26, 27, 25, 0.1));
  --vs-border-medium: var(--col-control-edge, rgba(26, 27, 25, 0.16));
  --vs-text-primary: var(--col-text-primary, #1a1b19);
  --vs-text-secondary: var(--col-text-secondary, #3f3f3a);
  --vs-text-muted: var(--col-text-secondary, #3f3f3a);
  --vs-text-faint: var(--col-text-disabled, #8a8a83);
  --vs-primary: var(--col-primary-button, #2e2d29);
  --vs-primary-hover: var(--col-primary-button-hover, #1a1b19);
  --vs-primary-text: var(--col-primary-button-contrast, #faf9f6);
  --vs-link: var(--col-link, #1a4fa0);
  --vs-focus: var(--col-focus-ring, #1a1b19);
  --vs-danger: var(--col-error-text, #ff3b30);
  --vs-warn: var(--col-warning, #ed6c02);
  --vs-ok: var(--col-success, #2e7d32);
  --vs-modal-overlay: rgba(0, 0, 0, 0.45);
  --vs-modal-shadow: 0 16px 40px var(--col-shadow, rgba(0, 0, 0, 0.25));
  --vs-dropdown-shadow: 0 8px 24px var(--col-shadow, rgba(0, 0, 0, 0.25));
  --vs-bar-shadow: none;
}
@keyframes vs-spin { to { transform: rotate(360deg); } }
`

const PANEL_CSS = `
.vs-sf-bar, .vs-sf-overlay { font: 13px/1.45 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--vs-text-primary); box-sizing: border-box; }
.vs-sf-bar *, .vs-sf-overlay * { box-sizing: border-box; }
.vs-sf-bar [hidden], .vs-sf-overlay [hidden] { display: none !important; }
.vs-sf-bar :focus-visible, .vs-sf-overlay :focus-visible { outline: 2px solid var(--vs-focus); outline-offset: 1px; }
.vs-sf-bar { margin: 8px 0 12px; padding: 10px 12px; background: var(--vs-bg-card); border: 1px solid var(--vs-border); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
.vs-sf-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vs-sf-spread { justify-content: space-between; }
.vs-sf-grow { flex: 1; min-width: 0; }
.vs-sf-title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.vs-sf-bolt { color: var(--vs-text-secondary); display: inline-flex; }
.vs-sf-count { background: var(--vs-bg-tertiary); color: var(--vs-text-secondary); font-size: 11px; padding: 0 7px; border-radius: 10px; font-weight: 600; line-height: 18px; }
.vs-sf-btn { background: var(--vs-bg-card); border: 1px solid var(--vs-border-medium); color: var(--vs-text-primary); padding: 5px 11px; border-radius: 6px; font-family: inherit; font-size: 12.5px; font-weight: 500; line-height: 1.3; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }
.vs-sf-btn:hover:not(:disabled) { background: var(--vs-bg-hover); }
.vs-sf-btn:disabled { opacity: 0.55; cursor: default; }
.vs-sf-btn svg { flex-shrink: 0; }
.vs-sf-primary { background: var(--vs-primary); border-color: var(--vs-primary); color: var(--vs-primary-text); font-weight: 600; padding: 7px 16px; }
.vs-sf-primary:hover:not(:disabled) { background: var(--vs-primary-hover); }
.vs-sf-icon-btn { background: transparent; border: none; color: var(--vs-text-faint); padding: 4px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; }
.vs-sf-icon-btn:hover:not(:disabled) { color: var(--vs-text-primary); background: var(--vs-bg-hover); }
.vs-sf-danger:hover:not(:disabled) { color: var(--vs-danger); }
.vs-sf-chips { display: flex; flex-direction: column; gap: 6px; }
/* One full-width row per subfunction: name and app on the left, badges and buttons at the right edge. */
.vs-sf-chip { display: flex; align-items: center; gap: 7px; width: 100%; background: var(--vs-bg-secondary); border: 1px solid var(--vs-border); border-radius: 6px; padding: 4px 4px 4px 8px; font-size: 12px; }
.vs-sf-chip-text { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.vs-sf-chip .vs-sf-badge { max-width: 260px; flex-shrink: 1; min-width: 0; }
.vs-sf-chip .vs-sf-icon-btn { flex-shrink: 0; }
.vs-sf-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.vs-sf-chip-name { font-weight: 600; }
.vs-sf-chip-meta { font-size: 11px; color: var(--vs-text-faint); }
.vs-sf-badge { font-size: 11px; padding: 0 6px; border-radius: 4px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; line-height: 18px; border: 1px solid var(--vs-border); color: var(--vs-text-secondary); }
.vs-sf-badge-info, .vs-sf-badge-ok { background: var(--vs-bg-card); }
.vs-sf-badge-warn { color: var(--vs-warn); border-color: currentColor; }
.vs-sf-muted { color: var(--vs-text-secondary); font-size: 12px; }
.vs-sf-faint { color: var(--vs-text-faint); font-size: 11.5px; }
.vs-sf-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vs-sf-app-icon { width: 22px; height: 22px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; color: var(--vs-text-secondary); background: var(--vs-bg-tertiary); }
.vs-sf-app-icon img { width: 100%; height: 100%; object-fit: contain; }
/* Logos sit on viaSocket's icon plate (IconWrapper): the same near-white in both modes, so dark logos stay visible. */
.vs-sf-app-icon.vs-sf-logo { box-sizing: border-box; padding: 2px; border: 1px solid var(--vs-border); background: var(--col-icon-bg, #f9fafb); }
.vs-sf-overlay { position: fixed; inset: 0; z-index: 2147483000; background: var(--vs-modal-overlay); display: flex; align-items: center; justify-content: center; padding: 20px; }
.vs-sf-modal { background: var(--vs-bg-primary); width: 100%; max-width: 640px; max-height: 88vh; border: 1px solid var(--vs-border); border-radius: 8px; box-shadow: var(--vs-modal-shadow); display: flex; flex-direction: column; overflow: hidden; }
.vs-sf-head { padding: 12px 16px; border-bottom: 1px solid var(--vs-border); display: flex; align-items: center; gap: 8px; }
.vs-sf-head-title { font-size: 15px; font-weight: 600; letter-spacing: -0.004em; }
.vs-sf-steps { font-size: 11.5px; color: var(--vs-text-faint); }
.vs-sf-body { padding: 14px 16px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 120px; background: var(--vs-bg-secondary); }
.vs-sf-foot { padding: 10px 16px; border-top: 1px solid var(--vs-border); display: flex; align-items: center; gap: 8px; }
.vs-sf-error { color: var(--vs-danger); font-size: 12px; flex: 1; }
.vs-sf-input, .vs-sf-select { background: var(--vs-bg-input); border: 1px solid var(--vs-border-medium); color: var(--vs-text-primary); padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 13px; outline: none; width: 100%; }
.vs-sf-input:focus, .vs-sf-select:focus { border-color: var(--vs-focus); }
.vs-sf-input::placeholder { color: var(--vs-text-faint); }
.vs-sf-input.vs-sf-code { font-size: 12.5px; }
.vs-sf-section { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vs-text-faint); margin-top: 4px; }
.vs-sf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.vs-sf-list { display: flex; flex-direction: column; gap: 6px; }
.vs-sf-card { background: var(--vs-bg-card); border: 1px solid var(--vs-border); border-radius: 8px; padding: 9px 11px; display: flex; align-items: center; gap: 10px; cursor: pointer; text-align: left; color: var(--vs-text-primary); font: inherit; width: 100%; }
.vs-sf-card:hover:not(:disabled) { background: var(--vs-bg-hover); }
.vs-sf-card:disabled { opacity: 0.55; cursor: default; }
.vs-sf-card-text { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 1px; }
.vs-sf-card-name { font-weight: 500; font-size: 13px; }
.vs-sf-req { color: var(--vs-danger); }
.vs-sf-map { position: relative; display: flex; align-items: flex-start; width: 100%; }
.vs-sf-map .vs-sf-input { padding-right: 34px; }
.vs-sf-map-btn { position: absolute; right: 6px; top: 7px; background: transparent; border: none; cursor: pointer; padding: 1px; display: flex; border-radius: 4px; }
.vs-sf-map-btn:hover { background: var(--vs-bg-hover); }
.vs-sf-pop { position: absolute; top: calc(100% + 4px); right: 0; width: 340px; max-width: 90vw; max-height: 260px; background: var(--vs-bg-primary); border: 1px solid var(--vs-border-medium); border-radius: 8px; box-shadow: var(--vs-dropdown-shadow); z-index: 6; display: flex; flex-direction: column; overflow: hidden; }
.vs-sf-pop-list { overflow-y: auto; padding: 4px; display: flex; flex-direction: column; }
.vs-sf-pop-item { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; color: var(--vs-text-primary); background: transparent; border: none; text-align: left; }
.vs-sf-pop-item:hover { background: var(--vs-bg-hover); }
.vs-sf-note { font-size: 12px; color: var(--vs-text-secondary); padding: 8px 10px; background: var(--vs-bg-card); border: 1px solid var(--vs-border); border-radius: 8px; }
.vs-sf-center { padding: 26px 12px; text-align: center; color: var(--vs-text-faint); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.vs-sf-spinner { width: 16px; height: 16px; border: 2px solid var(--vs-border-medium); border-top-color: var(--vs-text-primary); border-radius: 50%; animation: vs-spin 0.8s linear infinite; }
`

type Child = Node | string | null | undefined | false

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const c of children) if (c) e.append(c)
  return e
}

/** A static icon; `svg` must be one of the SVG constants. */
function icon(svg: string, cls = ''): HTMLElement {
  const s = el('span', cls)
  s.style.display = 'inline-flex'
  s.innerHTML = svg
  return s
}

function button(cls: string, content: Child[], onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el('button', cls, ...content)
  b.type = 'button'
  if (title) {
    b.title = title
    // Icon-only buttons get the title as their name; visible text stays the name otherwise.
    if (!content.some((c) => typeof c === 'string')) b.setAttribute('aria-label', title)
  }
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick(e)
  })
  return b
}

function appIcon(url?: string): HTMLElement {
  const box = el('span', 'vs-sf-app-icon')
  const fallback = () => {
    box.classList.remove('vs-sf-logo')
    box.replaceChildren(icon(SVG.bolt))
  }
  if (url && /^https:\/\//i.test(url)) {
    box.classList.add('vs-sf-logo')
    const img = el('img')
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.onerror = fallback
    img.src = url
    box.append(img)
  } else fallback()
  return box
}

function spinner(text: string): HTMLElement {
  return el('div', 'vs-sf-center', el('div', 'vs-sf-spinner'), el('div', '', text))
}

/** Adds or updates a stylesheet (an older copy may be left in the page by the extension before an update). */
function ensureStyle(id: string, css: string): void {
  const existing = document.getElementById(id)
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const s = el('style')
  s.id = id
  s.textContent = css
  ;(document.head ?? document.documentElement).append(s)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type WithoutTarget<T> = T extends unknown ? Omit<T, 'target'> : never

/** One request to the service worker; throws its error text. */
async function ask<T>(req: WithoutTarget<SubfnRequest>): Promise<T> {
  let res: SubfnResponse<T> | undefined
  try {
    res = (await chrome.runtime.sendMessage({ target: 'background', ...req })) as SubfnResponse<T> | undefined
  } catch {
    throw new Error('The extension was updated or reloaded. Reload this page and try again.')
  }
  if (!res) throw new Error('No answer from the extension. Reload this page and try again.')
  if (!res.ok) throw new Error(res.error)
  return res.data
}

interface Modal {
  readonly stepId: string
  setHead(title: string, steps?: string, onBack?: () => void): void
  readonly body: HTMLElement
  readonly foot: HTMLElement
  /** Closes the variable pickers of this modal */
  closePopovers(): void
  readonly popovers: Set<HTMLElement>
  close(): void
  readonly closed: boolean
}

/** What the add/edit flow has collected so far. */
interface Draft {
  ctx: StepContextData
  /** The subfunction being edited; absent when adding */
  original?: SubfunctionRef
  app?: { serviceId: string; name: string; iconUrl?: string }
  action?: SubfnAction
  authId?: string
}

export interface SubfunctionsUIController {
  destroy(): void
}

export function initSubfunctionsUI(bridge: PageBridge): SubfunctionsUIController {
  let destroyed = false
  let ticking = false
  let modal: Modal | null = null
  /** Signature of what the bar shows, so it is rebuilt only when that changes */
  let shownSig = ''

  // Catalog data does not change while a page is open; connection lists are re-read when asked to refresh.
  const actionDetails = new Map<string, Promise<SubfnActionDetail>>()
  const appActions = new Map<string, Promise<SubfnAction[]>>()
  const connectionLists = new Map<string, Promise<SubfnConnection[]>>()

  function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    let p = fresh ? undefined : map.get(key)
    if (!p) {
      p = load()
      map.set(key, p)
      p.catch(() => {
        if (map.get(key) === p) map.delete(key)
      })
    }
    return p
  }

  const actionDetail = (actionId: string) => cached(actionDetails, actionId, () => ask<SubfnActionDetail>({ type: 'subfn:get-action', actionId }))
  const actionsOf = (serviceId: string) => cached(appActions, serviceId, () => ask<SubfnAction[]>({ type: 'subfn:list-actions', serviceId }))
  function connectionsOf(a: { serviceId?: string; authIdLookup?: string }, fresh = false): Promise<SubfnConnection[]> {
    if (!a.serviceId || !a.authIdLookup) return Promise.resolve([])
    const { serviceId, authIdLookup } = a
    return cached(connectionLists, `${serviceId}|${authIdLookup}`, () => ask<SubfnConnection[]>({ type: 'subfn:list-connections', serviceId, authIdLookup }), fresh)
  }

  ensureStyle(THEME_STYLE_ID, THEME_CSS)
  ensureStyle(PANEL_STYLE_ID, PANEL_CSS + FORM_CSS)

  // ---------- the bar above the code ----------

  function removeBar(): void {
    document.getElementById(BAR_ID)?.remove()
    shownSig = ''
  }

  async function tick(): Promise<void> {
    if (ticking || destroyed) return
    ticking = true
    try {
      const anchor = document.getElementById(CODE_ANCHOR_ID)
      const params = new URLSearchParams(location.search)
      const stepParam = params.get('stepId')
      // The step the modal edits was closed or another one opened: what it shows no longer matches the page.
      if (modal && ((stepParam && stepParam !== modal.stepId) || (!stepParam && !params.get('slugName')))) modal.close()
      if (!anchor || !bridge.ready) return removeBar()
      if (modal) return
      const ctx = await bridge.getStepContext()
      if (destroyed || modal) return
      if (!ctx || !anchor.isConnected) return removeBar()
      renderBar(anchor, ctx)
    } finally {
      ticking = false
    }
  }

  function renderBar(anchor: HTMLElement, ctx: StepContextData): void {
    const calls = ctx.subfunctions.map((s) => countCalls(ctx.code, s.name))
    const sig = JSON.stringify([ctx.stepId, ctx.subfunctions, calls])
    let bar = document.getElementById(BAR_ID)
    if (bar && bar.nextElementSibling === anchor && sig === shownSig) return
    shownSig = sig
    if (!bar) {
      bar = el('div', 'vs-sf-bar')
      bar.id = BAR_ID
    }
    if (bar.nextElementSibling !== anchor) anchor.before(bar)

    const header = el(
      'div',
      'vs-sf-row vs-sf-spread',
      el('div', 'vs-sf-title', icon(SVG.bolt, 'vs-sf-bolt'), 'Subfunctions', el('span', 'vs-sf-count', String(ctx.subfunctions.length))),
      button('vs-sf-btn', [icon(SVG.plus), 'Add app action'], () => void openAdd(), 'Call an app action from this code'),
    )
    const chips = el('div', 'vs-sf-chips')
    if (ctx.subfunctions.length === 0) {
      chips.append(el('div', 'vs-sf-muted', 'Call an app action (send a Slack message, add a sheet row, …) from this code: pick the app, action, connection and inputs, and the call is written for you.'))
    }
    ctx.subfunctions.forEach((sub, i) => chips.append(chip(ctx, sub, calls[i] ?? 0)))
    bar.replaceChildren(header, chips)
  }

  function chip(ctx: StepContextData, sub: SubfunctionRef, calls: number): HTMLElement {
    const iconBox = el('span', '', appIcon())
    const meta = el('span', 'vs-sf-chip-meta vs-sf-ellipsis', 'Loading…')
    const status = el('span', 'vs-sf-badge vs-sf-badge-info')
    status.hidden = true
    const usage = el('span', 'vs-sf-badge')
    if (calls === 0) {
      usage.className = 'vs-sf-badge vs-sf-badge-warn'
      usage.textContent = 'not used in code'
      usage.title = 'Edit it and save to write the call into the code'
    } else if (calls > 1) {
      usage.className = 'vs-sf-badge vs-sf-badge-info'
      usage.textContent = `${calls} calls`
    } else usage.hidden = true

    const node = el(
      'div',
      'vs-sf-chip',
      iconBox,
      el('span', 'vs-sf-chip-text', el('span', 'vs-sf-chip-name vs-sf-code vs-sf-ellipsis', sub.name), meta),
      status,
      usage,
      button('vs-sf-icon-btn', [icon(SVG.edit)], () => void openEdit(sub), `Edit ${sub.name}`),
      button('vs-sf-icon-btn vs-sf-danger', [icon(SVG.trash)], () => void remove(sub), `Remove ${sub.name}`),
    )

    const setStatus = (text: string, warn: boolean) => {
      status.textContent = text
      status.className = `vs-sf-badge ${warn ? 'vs-sf-badge-warn' : 'vs-sf-badge-ok'}`
      status.hidden = false
    }
    actionDetail(sub.actionId).then(
      async (d) => {
        meta.textContent = `${d.appName ?? 'App'} · ${d.name}`
        iconBox.replaceChildren(appIcon(d.iconUrl))
        if (!d.needsConnection) return
        const list = await connectionsOf(d)
        const conn = list.find((c) => c.id === sub.authId)
        if (!conn) setStatus('connection missing', true)
        else if (!conn.valid) setStatus('connection expired', true)
        else setStatus(conn.label ?? 'connected', false)
      },
      () => {
        meta.textContent = 'Action not available'
        setStatus('check action', true)
      },
    )
    return node
  }

  // ---------- modal ----------

  function openModal(stepId: string): Modal {
    modal?.close()
    const overlay = el('div', 'vs-sf-overlay')
    overlay.id = MODAL_ID
    const back = button('vs-sf-icon-btn', [icon(SVG.back)], () => onBack?.(), 'Back')
    const title = el('div', 'vs-sf-head-title vs-sf-ellipsis')
    const steps = el('div', 'vs-sf-steps')
    const body = el('div', 'vs-sf-body')
    const foot = el('div', 'vs-sf-foot')
    const box = el(
      'div',
      'vs-sf-modal',
      el('div', 'vs-sf-head', back, el('div', 'vs-sf-grow', title, steps), button('vs-sf-icon-btn', [icon(SVG.close)], () => m.close(), 'Close')),
      body,
      foot,
    )
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    overlay.append(box)
    let onBack: (() => void) | undefined
    let closed = false
    const popovers = new Set<HTMLElement>()

    // Keys typed here are not the editor's shortcuts; Escape closes.
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') m.close()
    })
    overlay.addEventListener('keyup', (e) => e.stopPropagation())
    overlay.addEventListener('keypress', (e) => e.stopPropagation())
    overlay.addEventListener('click', (e) => {
      for (const p of popovers) if (!p.parentElement?.contains(e.target as Node)) p.hidden = true
    })
    // Popovers sit in viewport coordinates: close them when the form moves under them.
    const onResize = () => m.closePopovers()
    body.addEventListener('scroll', onResize, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })

    const m: Modal = {
      stepId,
      body,
      foot,
      popovers,
      setHead(text, stepText, backFn) {
        title.textContent = text
        steps.textContent = stepText ?? ''
        onBack = backFn
        back.hidden = !backFn
      },
      closePopovers() {
        for (const p of popovers) p.hidden = true
      },
      close() {
        if (closed) return
        closed = true
        window.removeEventListener('resize', onResize)
        overlay.remove()
        if (modal === m) modal = null
      },
      get closed() {
        return closed
      },
    }
    modal = m
    document.body.append(overlay)
    return m
  }

  function stepLabel(n: number, needsConnection = true): string {
    const names = needsConnection ? ['App', 'Action', 'Connection', 'Inputs'] : ['App', 'Action', 'Inputs']
    return names.map((s, i) => (i === Math.min(n, names.length - 1) ? `● ${s}` : s)).join('  ›  ')
  }

  // ---------- add: app -> action -> connection -> inputs ----------

  async function openAdd(): Promise<void> {
    const ctx = await bridge.getStepContext()
    if (!ctx) return void showToast({ title: 'Open a JS code step first', type: 'error' })
    showApps(openModal(ctx.stepId), { ctx })
  }

  function showApps(m: Modal, d: Draft): void {
    m.setHead('Add an app action', stepLabel(0))
    m.foot.replaceChildren(el('div', 'vs-sf-faint', 'Your connected apps are listed first. Search for any other app.'))
    const search = el('input', 'vs-sf-input')
    search.placeholder = 'Search apps (Slack, Google Sheets, Notion…)'
    search.setAttribute('aria-label', 'Search apps')
    const results = el('div', 'vs-sf-list')
    m.body.replaceChildren(el('div', 'vs-sf-map', search), results)

    const pick = (app: Draft['app']) => {
      d.app = app
      d.action = undefined
      showActions(m, d)
    }
    const card = (app: { serviceId: string; name: string; iconUrl?: string; sub?: string }) =>
      button(
        'vs-sf-card',
        [appIcon(app.iconUrl), el('span', 'vs-sf-card-text', el('span', 'vs-sf-card-name vs-sf-ellipsis', app.name), app.sub && el('span', 'vs-sf-faint vs-sf-ellipsis', app.sub))],
        () => pick({ serviceId: app.serviceId, name: app.name, iconUrl: app.iconUrl }),
      )

    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const render = async () => {
      const mine = ++seq
      const q = search.value.trim()
      const ql = q.toLowerCase()
      const connected = d.ctx.connectedApps.filter((a) => !ql || a.name.toLowerCase().includes(ql)).sort((a, b) => a.name.localeCompare(b.name))
      const parts: Node[] = []
      if (connected.length) {
        parts.push(el('div', 'vs-sf-section', 'Connected apps'))
        const grid = el('div', 'vs-sf-grid')
        for (const a of connected) grid.append(card({ ...a, sub: 'Connected' }))
        parts.push(grid)
      }
      if (q.length < 2) {
        if (!connected.length) parts.push(el('div', 'vs-sf-center', icon(SVG.search), 'Type an app name to search.'))
        results.replaceChildren(...parts)
        return
      }
      results.replaceChildren(...parts, spinner('Searching apps…'))
      let found: SubfnApp[]
      try {
        found = await ask<SubfnApp[]>({ type: 'subfn:search-apps', query: q })
      } catch (e) {
        if (mine === seq && !m.closed) results.replaceChildren(...parts, el('div', 'vs-sf-error', errorText(e)))
        return
      }
      if (mine !== seq || m.closed) return
      const known = new Set(connected.map((a) => a.serviceId))
      const others = found.filter((a) => !known.has(a.serviceId))
      if (others.length) {
        parts.push(el('div', 'vs-sf-section', connected.length ? 'Other apps' : 'Apps'))
        const grid = el('div', 'vs-sf-grid')
        for (const a of others) grid.append(card({ serviceId: a.serviceId, name: a.name, iconUrl: a.iconUrl, sub: a.domain ?? a.description }))
        parts.push(grid)
      } else if (!connected.length) parts.push(el('div', 'vs-sf-center', `No app matches "${q}".`))
      results.replaceChildren(...parts)
    }
    search.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => void render(), SEARCH_DEBOUNCE_MS)
    })
    void render()
    setTimeout(() => search.focus(), 30)
  }

  function showActions(m: Modal, d: Draft): void {
    const app = d.app
    if (!app) return showApps(m, d)
    m.setHead(`${app.name}: choose an action`, stepLabel(1), () => showApps(m, d))
    m.foot.replaceChildren()
    const search = el('input', 'vs-sf-input')
    search.placeholder = 'Search actions'
    search.setAttribute('aria-label', 'Search actions')
    const list = el('div', 'vs-sf-list', spinner(`Loading ${app.name} actions…`))
    m.body.replaceChildren(search, list)

    actionsOf(app.serviceId).then(
      (actions) => {
        if (m.closed) return
        const render = () => {
          const q = search.value.trim().toLowerCase()
          const shown = actions.filter((a) => !q || `${a.name} ${a.description ?? ''} ${a.subCategory ?? ''} ${a.category ?? ''}`.toLowerCase().includes(q))
          if (!shown.length) return list.replaceChildren(el('div', 'vs-sf-center', actions.length ? 'No action matches.' : `${app.name} has no actions available here.`))
          const groups = new Map<string, SubfnAction[]>()
          for (const a of shown) {
            const g = (a.subCategory || a.category || 'Other').toUpperCase()
            groups.set(g, [...(groups.get(g) ?? []), a])
          }
          const parts: Node[] = []
          for (const [g, items] of [...groups].sort(([a], [b]) => (a === 'OTHER' ? 1 : b === 'OTHER' ? -1 : a.localeCompare(b)))) {
            parts.push(el('div', 'vs-sf-section', g))
            for (const a of items) {
              parts.push(
                button(
                  'vs-sf-card',
                  [
                    appIcon(a.iconUrl ?? app.iconUrl),
                    el(
                      'span',
                      'vs-sf-card-text',
                      el('span', 'vs-sf-card-name', a.name),
                      a.description && el('span', 'vs-sf-faint', a.description.length > 160 ? `${a.description.slice(0, 160)}…` : a.description),
                    ),
                  ],
                  () => {
                    d.action = a
                    if (!d.app?.iconUrl && a.iconUrl && d.app) d.app.iconUrl = a.iconUrl
                    if (a.needsConnection) showConnections(m, d)
                    else {
                      d.authId = NO_AUTH_ID
                      void showForm(m, d)
                    }
                  },
                ),
              )
            }
          }
          list.replaceChildren(...parts)
        }
        search.addEventListener('input', render)
        render()
        setTimeout(() => search.focus(), 30)
      },
      (e) => {
        if (!m.closed) list.replaceChildren(el('div', 'vs-sf-error', errorText(e)))
      },
    )
  }

  /**
   * Opens viaSocket's connect page in a new tab and waits (while `alive` holds) for a connection that was not there
   * before; the auth tab has no opener, so polling the list is the dependable signal.
   */
  async function connectNew(a: SubfnAction, alive: () => boolean): Promise<SubfnConnection | null> {
    if (!a.serviceId || !a.authIdLookup) throw new Error('This app cannot be connected from here.')
    const before = new Set((await connectionsOf(a, true)).map((c) => c.id))
    await ask<null>({ type: 'subfn:connect', serviceId: a.serviceId, authIdLookup: a.authIdLookup, actionVersionId: a.actionVersionId })
    showToast({ title: `Connect ${a.appName ?? 'the app'} in the new tab`, message: 'The new account is picked here as soon as it appears.', type: 'info', durationMs: 6000 })
    const deadline = Date.now() + CONNECT_POLL_MAX_MS
    while (Date.now() < deadline && alive()) {
      await sleep(CONNECT_POLL_MS)
      if (!alive()) return null
      const list = await connectionsOf(a, true).catch(() => null)
      const fresh = list?.find((c) => !before.has(c.id) && c.valid)
      if (fresh) return fresh
    }
    return null
  }

  function showConnections(m: Modal, d: Draft): void {
    const a = d.action
    if (!a) return showActions(m, d)
    m.setHead(`${a.name}: choose the ${a.appName ?? 'app'} account`, stepLabel(2), () => showActions(m, d))
    const list = el('div', 'vs-sf-list', spinner('Loading connections…'))
    const refreshBtn = button('vs-sf-btn', [icon(SVG.refresh), 'Refresh'], () => void load(true))
    const connectBtn = button('vs-sf-btn', [icon(SVG.plus), `Connect a new ${a.appName ?? ''} account`], () => void connect())
    m.body.replaceChildren(el('div', 'vs-sf-row vs-sf-spread', el('div', 'vs-sf-muted', 'The action runs with this account.'), refreshBtn), list, connectBtn)
    m.foot.replaceChildren()
    let token = 0

    const choose = (id: string) => {
      d.authId = id
      void showForm(m, d)
    }
    const load = async (fresh = false) => {
      list.replaceChildren(spinner('Loading connections…'))
      try {
        const conns = await connectionsOf(a, fresh)
        if (m.closed) return
        if (!conns.length) return list.replaceChildren(el('div', 'vs-sf-note', `No ${a.appName ?? ''} account is connected in this workspace yet. Connect one below.`))
        list.replaceChildren(
          ...conns.map((c) => {
            const b = button(
              'vs-sf-card',
              [appIcon(d.app?.iconUrl), el('span', 'vs-sf-card-text', el('span', 'vs-sf-card-name vs-sf-ellipsis', c.label ?? c.id), !c.valid && el('span', 'vs-sf-faint', 'Expired: reconnect it in viaSocket first'))],
              () => choose(c.id),
            )
            b.disabled = !c.valid
            return b
          }),
        )
      } catch (e) {
        if (!m.closed) list.replaceChildren(el('div', 'vs-sf-error', errorText(e)))
      }
    }
    const connect = async () => {
      const mine = ++token
      connectBtn.disabled = true
      try {
        const fresh = await connectNew(a, () => !m.closed && mine === token && list.isConnected)
        if (fresh && !m.closed) choose(fresh.id)
      } catch (e) {
        showToast({ title: 'Could not open the connect page', message: errorText(e), type: 'error' })
      } finally {
        connectBtn.disabled = false
      }
    }
    void load()
  }

  // ---------- edit ----------

  async function openEdit(sub: SubfunctionRef): Promise<void> {
    const ctx = await bridge.getStepContext()
    if (!ctx) return void showToast({ title: 'Open the JS code step first', type: 'error' })
    const current = ctx.subfunctions.find((s) => s.name === sub.name) ?? sub
    const m = openModal(ctx.stepId)
    m.setHead(`Edit ${current.name}`)
    m.body.replaceChildren(spinner('Loading the action…'))
    m.foot.replaceChildren()
    try {
      const detail = await actionDetail(current.actionId)
      if (m.closed) return
      const d: Draft = {
        ctx,
        original: current,
        action: detail,
        authId: current.authId,
        app: detail.serviceId ? { serviceId: detail.serviceId, name: detail.appName ?? 'App', iconUrl: detail.iconUrl } : undefined,
      }
      await showForm(m, d, detail)
    } catch (e) {
      if (m.closed) return
      m.body.replaceChildren(
        el('div', 'vs-sf-note', `This subfunction's action (${current.actionId}) could not be loaded: ${errorText(e)}. You can still remove it, or edit the call in the code.`),
      )
    }
  }

  // ---------- inputs form ----------

  async function showForm(m: Modal, d: Draft, loaded?: SubfnActionDetail): Promise<void> {
    const a = d.action
    if (!a) return showActions(m, d)
    const editing = !!d.original
    const back = editing ? undefined : () => (a.needsConnection ? showConnections(m, d) : showActions(m, d))
    m.setHead(editing ? `Edit ${d.original?.name}` : `${a.name}`, editing ? `${a.appName ?? 'App'} · ${a.name}` : stepLabel(3, a.needsConnection), back)
    m.body.replaceChildren(spinner('Loading the action…'))
    m.foot.replaceChildren()

    let detail: SubfnActionDetail
    try {
      detail = loaded ?? (await actionDetail(a.actionId))
    } catch (e) {
      if (!m.closed) m.body.replaceChildren(el('div', 'vs-sf-error', errorText(e)))
      return
    }
    if (m.closed) return

    // The call being edited: the first `<name>({ inputData: {...} })` in the code.
    const originalName = d.original?.name
    const call: SubfunctionCall | undefined = originalName ? findSubfunctionCalls(d.ctx.code, [originalName])[0] : undefined
    const totalCalls = originalName ? countCalls(d.ctx.code, originalName) : 0
    const inputsEditable = !call || call.fields !== null

    // A fresh copy of the form: generated group fields are merged into it as they load.
    const model = new InputsModel(structuredClone(detail.form))
    if (call?.fields) model.load(call.fields)
    model.reconcile()

    // Function name: unique in this step and not a name the code declares itself. Each step's subfunctions are its
    // own functions, so numbering starts over in every step; the flow keeps one connection per name, though, so a
    // name another step uses is taken unless it is used there with the same connection.
    const suggestName = (auth: string): string => {
      const taken = [
        ...d.ctx.subfunctions.map((s) => s.name).filter((n) => n !== originalName),
        ...d.ctx.otherSubfunctions.filter((o) => !auth || o.authId !== auth).map((o) => o.name),
      ]
      let name = subfunctionNameFor(detail.name, taken)
      while (shadowed(d.ctx, name)) {
        taken.push(name)
        name = subfunctionNameFor(detail.name, taken)
      }
      return name
    }
    const nameInput = el('input', 'vs-sf-input vs-sf-code')
    nameInput.value = originalName ?? suggestName(detail.needsConnection ? (d.authId ?? '') : NO_AUTH_ID)
    nameInput.spellcheck = false
    nameInput.setAttribute('aria-label', 'Function name')
    const callPreview = el('span', 'vs-sf-code')
    const syncPreview = () => (callPreview.textContent = `await ${nameInput.value.trim() || '…'}({ inputData })`)
    // A name the user typed (or the one being edited) stays; a suggested one follows the chosen connection.
    let nameTouched = !!originalName
    nameInput.addEventListener('input', () => {
      nameTouched = true
      syncPreview()
    })
    syncPreview()
    const setup = el(
      'div',
      'vs-sf-fcard',
      el('div', 'vs-sf-frow', el('div', 'vs-sf-flabel', 'Function name'), el('div', 'vs-sf-fcontrol', nameInput, el('div', 'vs-sf-fhelp', 'Called in your code as ', callPreview, '.'))),
    )

    // Connection: the inputs show once it is chosen, like the step panel.
    let connSelect: HTMLSelectElement | null = null
    let view: InputsView | null = null
    const connectionChanged = () => {
      view?.refresh(true)
      if (nameTouched || !connSelect) return
      nameInput.value = suggestName(connSelect.value)
      syncPreview()
    }
    if (detail.needsConnection) {
      const select = el('select', 'vs-sf-select')
      select.setAttribute('aria-label', 'Connection')
      connSelect = select
      const fillConnections = async (fresh: boolean, pick?: string) => {
        select.disabled = true
        try {
          const conns = await connectionsOf(detail, fresh)
          const want = pick ?? select.value
          const opts = [el('option', '', conns.length ? 'Choose an account' : 'No account connected yet')]
          opts[0]!.value = ''
          for (const c of conns) {
            const o = el('option', '', `${c.label ?? c.id}${c.valid ? '' : ' (expired)'}`)
            o.value = c.id
            o.disabled = !c.valid
            opts.push(o)
          }
          // A saved connection that is gone stays visible, so the user sees why the step would fail.
          if (d.authId && d.authId !== NO_AUTH_ID && !conns.some((c) => c.id === d.authId)) {
            const o = el('option', '', 'Saved connection (no longer available)')
            o.value = d.authId
            o.disabled = true
            opts.push(o)
          }
          select.replaceChildren(...opts)
          select.value = conns.some((c) => c.id === want && c.valid) ? (want ?? '') : ''
        } catch (e) {
          showToast({ title: 'Could not load connections', message: errorText(e), type: 'error' })
        } finally {
          select.disabled = false
          connectionChanged()
        }
      }
      select.addEventListener('change', connectionChanged)
      const connectBtn = button('vs-sf-icon-btn', [icon(SVG.plus)], async () => {
        connectBtn.disabled = true
        try {
          const fresh = await connectNew(detail, () => !m.closed && select.isConnected)
          if (fresh) await fillConnections(true, fresh.id)
        } catch (e) {
          showToast({ title: 'Could not open the connect page', message: errorText(e), type: 'error' })
        } finally {
          connectBtn.disabled = false
        }
      }, `Connect a new ${detail.appName ?? ''} account`)
      setup.append(
        el(
          'div',
          'vs-sf-frow',
          el('div', 'vs-sf-flabel', `${detail.appName ?? 'App'} account`, el('span', 'vs-sf-req', '*')),
          el('div', 'vs-sf-fcontrol', el('div', 'vs-sf-row', el('div', 'vs-sf-grow', select), button('vs-sf-icon-btn', [icon(SVG.refresh)], () => void fillConnections(true), 'Refresh connections'), connectBtn)),
        ),
      )
      void fillConnections(false, d.authId)
    }
    const authId = () => (detail.needsConnection ? (connSelect?.value ?? '') : NO_AUTH_ID)

    const parts: Node[] = [setup]
    if (!inputsEditable) {
      parts.push(el('div', 'vs-sf-note', 'The inputData of this call is built in code (spread or computed keys), so it is not shown as fields. Saving keeps it as it is; edit it in the code.'))
    } else {
      if (totalCalls > 1) parts.push(el('div', 'vs-sf-note', `The code calls ${originalName} ${totalCalls} times; this form edits the inputs of the first call.`))
      view = renderInputs({
        model,
        variables: d.ctx.variables,
        connectionReady: () => !detail.needsConnection || !!authId(),
        connectionKey: authId,
        loadOptions: (key, search) =>
          ask<SubfnOptionsResult>({ type: 'subfn:field-options', actionId: detail.actionId, fieldKey: key, authId: authId(), values: plainValues(model.values), search }),
        loadGroup: (key) => ask<SubfnGroupResult>({ type: 'subfn:group-fields', actionId: detail.actionId, groupKey: key, authId: authId(), values: plainValues(model.values) }),
        popovers: m.popovers,
        closePopovers: () => m.closePopovers(),
        alive: () => !m.closed,
      })
      parts.push(el('div', 'vs-sf-section', 'Inputs'), view.element)
    }
    m.body.replaceChildren(...parts)

    // Footer
    const error = el('div', 'vs-sf-error')
    const saveBtn = button('vs-sf-btn vs-sf-primary', [editing ? 'Save changes' : 'Add to code'], () => void save())
    m.foot.replaceChildren(error, button('vs-sf-btn', ['Cancel'], () => m.close()), saveBtn)

    const fail = (text: string) => {
      error.textContent = text
      return false
    }

    async function save(): Promise<boolean> {
      error.textContent = ''
      const name = nameInput.value.trim()
      if (!isSubfunctionName(name)) return fail('Use a JavaScript name for the function: letters, digits, _ or $, not starting with a digit and not a reserved word.')
      const auth = authId()
      if (!auth) return fail(`Choose the ${detail.appName ?? 'app'} account (or connect one).`)
      const missing = view ? view.validate() : []
      if (missing.length) return fail(`Fill in: ${missing.join(', ')}`)

      saveBtn.disabled = true
      saveBtn.textContent = 'Saving…'
      try {
        // Re-read the step: the code may have changed since the form opened.
        const fresh = await bridge.getStepContext(d.ctx.scriptId, d.ctx.stepId, d.ctx.slugName)
        if (!fresh || fresh.stepId !== d.ctx.stepId) return fail('The step was closed or changed. Reopen it and try again.')
        if (fresh.subfunctions.some((s) => s.name !== originalName && s.name.toLowerCase() === name.toLowerCase())) {
          return fail(`This step already has a subfunction named ${name}.`)
        }
        if (name !== originalName && shadowed(fresh, name)) {
          return fail(`The code or its Input Values already use the name ${name}, which would hide the subfunction. Pick another name.`)
        }

        let code = fresh.code
        if (originalName && originalName !== name) code = renameSubfunction(code, originalName, name)
        const fields = inputsEditable ? model.inputDataFields() : {}
        const target = findSubfunctionCalls(code, [name])[0]
        if (target) {
          if (inputsEditable && target.fields !== null) code = replaceCallInput(code, target, fields)
        } else if (countCalls(code, name) === 0) {
          code = insertSubfunctionCall(code, name, fields)
        }
        // else: called without an inputData literal (hand-written code); that code is left alone.

        const ref: SubfunctionRef = { name, actionId: detail.actionId, authId: auth }
        const subfunctions = originalName ? fresh.subfunctions.map((s) => (s.name === originalName ? ref : s)) : [...fresh.subfunctions, ref]
        const saved = await ask<SubfnSaveResult>({
          type: 'subfn:save',
          scriptId: fresh.scriptId,
          stepId: fresh.stepId,
          slugName: fresh.slugName,
          code,
          subfunctions,
          dynamicVariables: fresh.dynamicVariables,
        })
        bridge.refreshStep(fresh.scriptId, fresh.stepId, fresh.slugName, saved ?? undefined)
        m.close()
        shownSig = ''
        showToast({
          title: editing ? `Updated ${name}` : `Added ${name} to the code`,
          message: "Saved to the step's draft. Test the step to check it, and publish the flow to make it live.",
          type: 'success',
          durationMs: 5000,
        })
        void tick()
        return true
      } catch (e) {
        return fail(errorText(e))
      } finally {
        if (!m.closed) {
          saveBtn.disabled = false
          saveBtn.textContent = editing ? 'Save changes' : 'Add to code'
        }
      }
    }
  }

  /** The step's own code or Input Values declare `name`, which would shadow a subfunction of that name. */
  function shadowed(ctx: StepContextData, name: string): boolean {
    return declaresName(ctx.code, name) || Object.hasOwn(ctx.dynamicVariables ?? {}, name)
  }

  // ---------- remove ----------

  async function remove(sub: SubfunctionRef): Promise<void> {
    const fresh = await bridge.getStepContext()
    if (!fresh) return void showToast({ title: 'Open the JS code step first', type: 'error' })
    const { code, removed, remaining } = removeCallStatements(fresh.code, sub.name)
    if (remaining > 0) {
      return void showToast({
        title: `${sub.name} is still used in the code`,
        message: `Remove the ${remaining} call${remaining > 1 ? 's' : ''} to ${sub.name}(…) that ${remaining > 1 ? 'are' : 'is'} part of other code (or whose result is used), then remove it here.`,
        type: 'error',
        durationMs: 7000,
      })
    }
    const what = removed ? ` and its ${removed} call${removed > 1 ? 's' : ''} in the code` : ''
    if (!window.confirm(`Remove the subfunction ${sub.name}${what}?`)) return
    try {
      const saved = await ask<SubfnSaveResult>({
        type: 'subfn:save',
        scriptId: fresh.scriptId,
        stepId: fresh.stepId,
        slugName: fresh.slugName,
        code,
        subfunctions: fresh.subfunctions.filter((s) => s.name !== sub.name),
        dynamicVariables: fresh.dynamicVariables,
      })
      bridge.refreshStep(fresh.scriptId, fresh.stepId, fresh.slugName, saved ?? undefined)
      shownSig = ''
      showToast({ title: `Removed ${sub.name}`, message: "Saved to the step's draft.", type: 'success' })
      void tick()
    } catch (e) {
      showToast({ title: `Could not remove ${sub.name}`, message: errorText(e), type: 'error' })
    }
  }

  const timer = setInterval(() => void tick(), POLL_MS)
  void tick()

  return {
    destroy() {
      destroyed = true
      clearInterval(timer)
      modal?.close()
      removeBar()
      document.getElementById(PANEL_STYLE_ID)?.remove()
    },
  }
}
