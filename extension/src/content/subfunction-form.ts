// The inputs of an app action inside the subfunctions panel, laid out and gated like the step panel of a manual flow:
// cards of fields (label beside the control), input groups and dictionaries as blocks of their own, required fields
// shown, optional ones offered as links under their card, and each field opening once the fields it depends on are
// filled. Choices of dynamic dropdowns and the fields of generated groups load from the app through the service
// worker. The rules themselves live in shared/subfunction-inputs.ts; this file only draws them.
//
// Dynamic text is only ever set with textContent; the static SVG constants are the only markup.

import { childName, InputsModel, kindOf, plainValues, type FieldValue } from '../shared/subfunction-inputs'
import type { SubfnFieldSpec, SubfnGroupResult, SubfnOptionsResult } from '../shared/subfunctions'

const SEARCH_DEBOUNCE_MS = 500
/** Choices older than this load again when the dropdown opens */
const STALE_MS = 30_000
/** Typing in a field a generated group reads reloads the group after this pause */
const GROUP_RELOAD_DELAY_MS = 600
const MANY_OPTIONS = 8

const SVG = {
  chevron: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  refresh: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  variable: `<svg width="16" height="16" viewBox="0 0 35 35" fill="none"><rect width="35" height="35" rx="6" fill="#F97316"/><path d="M13.8837 25.8141C13.4949 26.1951 12.8727 26.1951 12.4838 25.8141L4.7288 18.2142C4.3287 17.8221 4.3287 17.1779 4.7288 16.7858L12.4838 9.18592C12.8727 8.80488 13.4949 8.80487 13.8837 9.18592L14.6361 9.92328C15.0362 10.3154 15.0362 10.9596 14.6361 11.3517L9.05282 16.8233C8.65272 17.2154 8.65272 17.8596 9.05282 18.2517L14.5978 23.6858C14.9979 24.0779 14.9979 24.7221 14.5978 25.1142L13.8837 25.8141ZM22.5162 25.8141C22.1273 26.1951 21.5051 26.1951 21.1163 25.8141L20.3639 25.0767C19.9638 24.6846 19.9638 24.0404 20.3639 23.6483L25.9472 18.1767C26.3473 17.7846 26.3473 17.1404 25.9472 16.7483L20.4021 11.3142C20.002 10.9221 20.0021 10.2779 20.4021 9.88578L21.1163 9.18592C21.5051 8.80487 22.1273 8.80487 22.5162 9.18592L30.2712 16.7858C30.6713 17.1779 30.6713 17.8221 30.2712 18.2142L22.5162 25.8141Z" fill="white"/></svg>`,
} as const

export const FORM_CSS = `
.vs-sf-inputs { display: flex; flex-direction: column; gap: 10px; }
.vs-sf-fcard { background: var(--vs-bg-card); border: 1px solid var(--vs-border); border-radius: 8px; padding: 4px 12px; display: flex; flex-direction: column; }
.vs-sf-frow { display: grid; grid-template-columns: minmax(110px, 34%) 1fr; column-gap: 12px; align-items: start; padding: 8px 0; }
.vs-sf-frow + .vs-sf-frow { border-top: 1px solid var(--vs-border); }
.vs-sf-frow.vs-sf-stacked { grid-template-columns: 1fr; row-gap: 6px; }
@media (max-width: 700px) { .vs-sf-frow { grid-template-columns: 1fr; row-gap: 6px; } .vs-sf-flabel { padding-top: 0; } }
.vs-sf-flabel { font-size: 13px; font-weight: 500; color: var(--vs-text-primary); padding-top: 6px; display: flex; align-items: flex-start; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.vs-sf-fcontrol { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.vs-sf-fhelp { font-size: 11.5px; color: var(--vs-text-faint); line-height: 1.4; overflow-wrap: anywhere; }
.vs-sf-ferror { font-size: 11.5px; color: var(--vs-danger); }
.vs-sf-invalid .vs-sf-input, .vs-sf-invalid .vs-sf-pick { border-color: var(--vs-danger); }
.vs-sf-unadd { background: none; border: none; padding: 0 2px; margin-left: auto; color: var(--vs-text-faint); cursor: pointer; display: inline-flex; }
.vs-sf-unadd:hover { color: var(--vs-text-primary); }
.vs-sf-links { text-align: right; padding: 6px 0 8px; border-top: 1px solid var(--vs-border); font-size: 12px; color: var(--vs-text-faint); line-height: 1.7; }
.vs-sf-fcard > .vs-sf-links:first-child { border-top: none; }
.vs-sf-optlink { background: none; border: none; padding: 0; font: inherit; font-size: 12px; color: var(--vs-link); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.vs-sf-block { border: 1px solid var(--vs-border); border-radius: 8px; background: var(--vs-bg-card); display: flex; flex-direction: column; }
.vs-sf-block-head { display: flex; align-items: center; gap: 6px; padding: 9px 12px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--vs-border); }
.vs-sf-block-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.vs-sf-block-body > .vs-sf-fcard { background: var(--vs-bg-secondary); }
.vs-sf-textarea { resize: none; overflow: hidden; line-height: 1.45; min-height: 34px; display: block; }
.vs-sf-pick { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 6px; padding: 5px 8px 5px 10px; border: 1px solid var(--vs-border-medium); border-radius: 6px; background: var(--vs-bg-input); color: var(--vs-text-primary); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.vs-sf-pick:hover:not(:disabled) { background: var(--vs-bg-hover); }
.vs-sf-pick:disabled { cursor: default; color: var(--vs-text-faint); }
.vs-sf-pick-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vs-sf-pick-text.vs-sf-placeholder { color: var(--vs-text-faint); }
.vs-sf-chiprow { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
.vs-sf-vchip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 4px 1px 8px; border-radius: 4px; background: var(--vs-bg-tertiary); border: 1px solid var(--vs-border); font-size: 12px; }
.vs-sf-vchip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vs-sf-dd { position: fixed; z-index: 6; background: var(--vs-bg-primary); border: 1px solid var(--vs-border-medium); border-radius: 8px; box-shadow: var(--vs-dropdown-shadow); display: flex; flex-direction: column; max-height: 300px; overflow: hidden; }
.vs-sf-dd-search { margin: 6px; width: auto; }
.vs-sf-dd-list { overflow-y: auto; padding: 4px; display: flex; flex-direction: column; }
.vs-sf-dd-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: none; border-radius: 4px; background: transparent; color: var(--vs-text-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.vs-sf-dd-item:hover, .vs-sf-dd-item[aria-selected="true"] { background: var(--vs-bg-hover); }
.vs-sf-dd-item .vs-sf-dd-check { width: 12px; display: inline-flex; color: var(--vs-text-primary); flex-shrink: 0; }
.vs-sf-dd-item.vs-sf-dd-manual { color: var(--vs-text-secondary); font-size: 11.5px; letter-spacing: 0.02em; text-transform: uppercase; }
.vs-sf-dd-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--vs-border); font-size: 11.5px; color: var(--vs-text-faint); }
.vs-sf-dd-note { padding: 10px; font-size: 12px; color: var(--vs-text-faint); }
.vs-sf-rel { position: relative; }
.vs-sf-rows { display: flex; flex-direction: column; gap: 6px; }
.vs-sf-kv { display: grid; grid-template-columns: minmax(80px, 35%) 1fr auto; gap: 6px; align-items: start; }
.vs-sf-mini { background: none; border: none; padding: 0; font: inherit; font-size: 12px; color: var(--vs-link); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; }
.vs-sf-mini:disabled { color: var(--vs-text-faint); cursor: default; }
`

export type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const c of children) if (c) e.append(c)
  return e
}

/** A static icon; `svg` must be one of the SVG constants. */
export function icon(svg: string, cls = ''): HTMLElement {
  const s = el('span', cls)
  s.style.display = 'inline-flex'
  s.innerHTML = svg
  return s
}

function btn(cls: string, content: Child[], onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', cls, ...content)
  b.type = 'button'
  if (title) {
    b.title = title
    if (!content.some((c) => typeof c === 'string')) b.setAttribute('aria-label', title)
  }
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return b
}

/**
 * Places a popover under its anchor (or above it when there is no room), in viewport coordinates, so the scrolling
 * form around it never clips it. The form closes popovers when it scrolls.
 */
export function placePopover(pop: HTMLElement, anchor: HTMLElement, width?: number): void {
  const r = anchor.getBoundingClientRect()
  const w = Math.min(width ?? r.width, window.innerWidth - 16)
  const below = window.innerHeight - r.bottom - 8
  const above = r.top - 8
  const up = below < 200 && above > below
  pop.style.position = 'fixed'
  pop.style.width = `${w}px`
  pop.style.left = `${Math.max(8, Math.min(width ? r.right - w : r.left, window.innerWidth - w - 8))}px`
  pop.style.maxHeight = `${Math.max(140, Math.min(300, (up ? above : below) - 4))}px`
  if (up) {
    pop.style.top = ''
    pop.style.bottom = `${window.innerHeight - r.top + 4}px`
  } else {
    pop.style.bottom = ''
    pop.style.top = `${r.bottom + 4}px`
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}

function shownValue(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
}

export interface InputsHost {
  model: InputsModel
  /** Data the user can map, e.g. context.req.body.email */
  variables: string[]
  /** A connection is chosen, or the action needs none: the panel shows inputs only then */
  connectionReady(): boolean
  /** Changes whenever the connection does (loaded choices belong to one connection) */
  connectionKey(): string
  loadOptions(key: string, search?: string): Promise<SubfnOptionsResult>
  loadGroup(key: string): Promise<SubfnGroupResult>
  /** Popovers of the modal, closed on clicks elsewhere */
  popovers: Set<HTMLElement>
  closePopovers(): void
  alive(): boolean
}

export interface InputsView {
  element: HTMLElement
  /** Re-checks which fields show (after a connection change, for instance) */
  refresh(force?: boolean): void
  /** Labels of shown required fields that are empty; marks them and scrolls to the first */
  validate(): string[]
}

interface GroupLoad {
  sig: string
  state: 'loading' | 'loaded' | 'waiting' | 'error'
  text?: string
}

export function renderInputs(host: InputsHost): InputsView {
  const { model } = host
  const root = el('div', 'vs-sf-inputs')
  const optionLoads = new Map<string, { sig: string; result: Promise<SubfnOptionsResult> }>()
  const groupLoads = new Map<string, GroupLoad>()
  const invalid = new Set<string>()
  /** Dropdowns switched to typed or mapped input (the panel's "provide manual / dynamic input") */
  const manual = new Set<string>()
  for (const [k, e] of model.values) if (e.value.kind === 'text') manual.add(k)
  let shownSig = ''

  const label = (spec: SubfnFieldSpec) => spec.label ?? childName(spec.key, model.locationOf(spec.key))

  /** Parents' values: choices and generated fields load again when they change. */
  function depsSig(key: string): string {
    const spec = model.spec(key)
    const plain = plainValues(model.values)
    const loc = model.locationOf(key)
    const deps = (spec?.dependsOn ?? []).map((d) => plain[d] ?? (loc !== 'root' ? plain[`${loc}[${JSON.stringify(d)}]`] : undefined) ?? null)
    return JSON.stringify([host.connectionKey(), deps])
  }

  function options(key: string, fresh = false): Promise<SubfnOptionsResult> | undefined {
    const spec = model.spec(key)
    if (!spec?.dynamic || !host.connectionReady()) return undefined
    const sig = depsSig(key)
    const hit = optionLoads.get(key)
    if (hit && hit.sig === sig && !fresh) return hit.result
    const result = host.loadOptions(key).catch((e: unknown) => ({ options: [], error: errorText(e) }) as SubfnOptionsResult)
    optionLoads.set(key, { sig, result })
    return result
  }

  function ensureGroup(key: string, fresh = false): void {
    const spec = model.spec(key)
    if (!spec?.generates || !host.connectionReady()) return
    const sig = depsSig(key)
    const cur = groupLoads.get(key)
    if (cur && cur.sig === sig && !fresh && cur.state !== 'error') return
    const load: GroupLoad = { sig, state: 'loading' }
    groupLoads.set(key, load)
    host
      .loadGroup(key)
      .then(
        (res) => {
          if (groupLoads.get(key) !== load || !host.alive()) return
          if (res.form) {
            model.groupLoaded(key, res.form)
            load.state = 'loaded'
          } else if (res.needsFirst?.length) {
            load.state = 'waiting'
            load.text = `Fill ${res.needsFirst.join(', ')} first.`
          } else if (res.needsConnection) {
            load.state = 'waiting'
            load.text = 'Choose the account first.'
          } else {
            load.state = 'error'
            load.text = res.error ?? 'The fields could not be loaded.'
          }
        },
        (e: unknown) => {
          if (groupLoads.get(key) !== load) return
          load.state = 'error'
          load.text = errorText(e)
        },
      )
      .finally(() => {
        if (groupLoads.get(key) === load && host.alive()) refresh(true)
      })
  }

  /**
   * Generated groups whose parents' values changed since their fields loaded load them again, as the panel does (its
   * fetch is keyed on those values). A hidden group reloads when it shows again (render calls ensureGroup).
   */
  function reloadStaleGroups(): void {
    for (const [key, load] of groupLoads) {
      if (load.sig !== depsSig(key) && model.state(key) !== 'hidden') ensureGroup(key)
    }
  }

  let groupTimer: ReturnType<typeof setTimeout> | undefined

  /** A value the user set: fields reading it lose their pick (their choices change) and the layout is checked. */
  function changed(key: string, value: FieldValue | null): void {
    if (value) model.set(key, value)
    else model.clear(key)
    const wasInvalid = invalid.delete(key)
    let dropped = false
    for (const d of model.dependents(key)) {
      const kind = kindOf(model.spec(d) as SubfnFieldSpec)
      if ((kind === 'dropdown' || kind === 'multiselect') && !manual.has(d) && model.values.delete(d)) dropped = true
    }
    // Typing reloads groups once it pauses; a pick reloads them now.
    clearTimeout(groupTimer)
    groupTimer = undefined
    if (value && value.kind !== 'choice' && value.kind !== 'choices') {
      groupTimer = setTimeout(() => {
        groupTimer = undefined
        if (!host.alive()) return
        reloadStaleGroups()
        refresh()
      }, GROUP_RELOAD_DELAY_MS)
    } else reloadStaleGroups()
    // A cleared field with a default shows the default again, as the panel does.
    // A dropped pick leaves the layout unchanged, so force the redraw or its button keeps showing the old choice.
    refresh(dropped || wasInvalid || (!value && model.spec(key)?.defaultValue !== undefined))
  }

  function signature(): string {
    const states = Object.keys(model.form.fields).map((k) => `${k}:${model.state(k)}`)
    const groups = [...groupLoads].map(([k, g]) => `${k}:${g.state}:${g.sig}`)
    return JSON.stringify([host.connectionReady(), states, groups, [...invalid], [...manual]])
  }

  function refresh(force = false): void {
    if (!host.alive()) return
    model.reconcile()
    const sig = signature()
    if (!force && sig === shownSig) return
    shownSig = sig
    // Keep the caret where the user is typing across a re-render.
    const active = document.activeElement as HTMLElement | null
    const focusKey = active && root.contains(active) ? active.dataset.vsField : undefined
    const focusPart = active?.dataset.vsPart
    const sel: [number | null, number | null] | null =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null
    host.closePopovers()
    // Every field is rebuilt below with its own popover; drop the detached ones.
    host.popovers.clear()
    root.replaceChildren(...(host.connectionReady() ? renderLocation('root', 0) : [el('div', 'vs-sf-note', 'Choose the account to see the inputs of this action.')]))
    if (focusKey) {
      const target = root.querySelector<HTMLElement>(`[data-vs-field="${CSS.escape(focusKey)}"]${focusPart ? `[data-vs-part="${CSS.escape(focusPart)}"]` : ''}`)
      if (target) {
        target.focus()
        if (sel && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) target.setSelectionRange(sel[0], sel[1])
      }
    }
  }

  // ---------- layout ----------

  function standalone(spec: SubfnFieldSpec): boolean {
    const k = kindOf(spec)
    return k === 'group' || k === 'dictionary' || k === 'help' || spec.type === 'html' || spec.type === 'markdown'
  }

  function linksLine(keys: string[]): HTMLElement {
    const line = el('div', 'vs-sf-links')
    keys.forEach((k, i) => {
      const spec = model.spec(k) as SubfnFieldSpec
      line.append(
        btn('vs-sf-optlink', [label(spec)], () => {
          model.revealed.add(k)
          refresh()
          root.querySelector<HTMLElement>(`[data-vs-field="${CSS.escape(k)}"]`)?.focus()
        }, `Add ${label(spec)}`),
      )
      if (i < keys.length - 1) line.append(', ')
    })
    return line
  }

  function renderLocation(loc: string, depth: number): Node[] {
    const out: Node[] = []
    let card: HTMLElement | null = null
    let cardLinks: string[] = []
    const closeCard = () => {
      if (card && cardLinks.length) card.append(linksLine(cardLinks))
      card = null
      cardLinks = []
    }
    const pendingLinks: string[] = []
    for (const key of model.form.steps[loc] ?? []) {
      const spec = model.spec(key)
      if (!spec) continue
      const state = model.state(key, loc)
      if (state === 'hidden') continue
      if (state === 'link') {
        if (card) cardLinks.push(key)
        else pendingLinks.push(key)
        continue
      }
      if (standalone(spec)) {
        closeCard()
        out.push(renderBlock(spec, depth))
        continue
      }
      if (!card) {
        card = el('div', 'vs-sf-fcard')
        out.push(card)
        cardLinks.push(...pendingLinks.splice(0))
      }
      ;(card as HTMLElement).append(renderRow(spec, loc))
    }
    closeCard()
    if (pendingLinks.length) {
      const holder = el('div', 'vs-sf-fcard')
      holder.append(linksLine(pendingLinks))
      out.push(holder)
    }
    // Keys the code passes here that the action does not define stay, editable as code.
    const extras = model.extras.get(loc)
    if (extras && Object.keys(extras).length) out.push(extrasBlock(loc, extras))
    if (!out.length && loc === 'root') out.push(el('div', 'vs-sf-note', 'This action takes no inputs.'))
    return out
  }

  function removable(spec: SubfnFieldSpec, loc: string): HTMLElement | null {
    // Optional fields the user added can be taken away again (their value goes with them).
    if (spec.required || !model.revealed.has(spec.key) || model.state(spec.key, loc) !== 'shown') return null
    return btn('vs-sf-unadd', [icon(SVG.close)], () => {
      model.revealed.delete(spec.key)
      changed(spec.key, null)
    }, `Remove ${label(spec)}`)
  }

  function fieldHead(spec: SubfnFieldSpec, loc: string): HTMLElement {
    return el('div', 'vs-sf-flabel', el('span', '', label(spec)), spec.required ? el('span', 'vs-sf-req', '*') : null, removable(spec, loc))
  }

  function renderRow(spec: SubfnFieldSpec, loc: string): HTMLElement {
    const row = el('div', `vs-sf-frow${invalid.has(spec.key) ? ' vs-sf-invalid' : ''}`)
    row.dataset.vsRow = spec.key
    const control = el('div', 'vs-sf-fcontrol', renderControl(spec))
    if (invalid.has(spec.key)) control.append(el('div', 'vs-sf-ferror', "This field can't be empty."))
    if (spec.help) control.append(el('div', 'vs-sf-fhelp', spec.help))
    row.append(fieldHead(spec, loc), control)
    return row
  }

  function renderBlock(spec: SubfnFieldSpec, depth: number): HTMLElement {
    const kind = kindOf(spec)
    const loc = model.locationOf(spec.key)
    if (kind === 'help') return el('div', 'vs-sf-note', spec.help ?? label(spec))
    // Like the panel, a group's header has no required mark (its fields carry them).
    const head = el('div', 'vs-sf-block-head', el('span', '', label(spec)), spec.required && kind !== 'group' ? el('span', 'vs-sf-req', '*') : null)
    const body = el('div', 'vs-sf-block-body')
    const block = el('div', `vs-sf-block${invalid.has(spec.key) ? ' vs-sf-invalid' : ''}`, head, body)
    block.dataset.vsRow = spec.key
    const unadd = removable(spec, loc)
    if (unadd) head.append(unadd)

    if (kind === 'group') {
      if (spec.generates) {
        head.append(btn('vs-sf-unadd', [icon(SVG.refresh)], () => ensureGroup(spec.key, true), `Reload ${label(spec)}`))
        ensureGroup(spec.key)
        const load = groupLoads.get(spec.key)
        if (model.form.steps[spec.key] === undefined || load?.state !== 'loaded') {
          const text =
            load?.state === 'loading' || !load
              ? 'Loading fields…'
              : (load.text ?? 'The fields could not be loaded.')
          body.append(el('div', load?.state === 'error' ? 'vs-sf-ferror' : 'vs-sf-fhelp', text))
          if (spec.help) body.append(el('div', 'vs-sf-fhelp', spec.help))
          return block
        }
      }
      body.append(...(depth < 5 ? renderLocation(spec.key, depth + 1) : []))
      if (!body.childNodes.length) body.append(el('div', 'vs-sf-fhelp', 'No fields to fill.'))
      if (spec.help) body.append(el('div', 'vs-sf-fhelp', spec.help))
      return block
    }
    if (kind === 'dictionary') {
      body.append(dictionaryControl(spec))
      if (spec.help) body.append(el('div', 'vs-sf-fhelp', spec.help))
      return block
    }
    // html / markdown: a larger text field of its own
    body.append(textControl(spec, 4))
    if (spec.help) body.append(el('div', 'vs-sf-fhelp', spec.help))
    return block
  }

  function extrasBlock(loc: string, extras: Record<string, string>): HTMLElement {
    const body = el('div', 'vs-sf-block-body')
    for (const name of Object.keys(extras)) {
      const input = el('textarea', 'vs-sf-input vs-sf-textarea vs-sf-code')
      input.rows = 1
      input.spellcheck = false
      input.value = extras[name] ?? ''
      input.setAttribute('aria-label', name)
      input.dataset.vsField = `${loc}::extra::${name}`
      autoGrow(input)
      input.addEventListener('input', () => {
        extras[name] = input.value
        autoGrow(input)
      })
      body.append(el('div', 'vs-sf-frow', el('div', 'vs-sf-flabel vs-sf-code', name), el('div', 'vs-sf-fcontrol', input, el('div', 'vs-sf-fhelp', 'Not an input of this action; kept as code. Clear it to remove it.'))))
    }
    return el('div', 'vs-sf-block', el('div', 'vs-sf-block-head', 'Other inputs in the code'), body)
  }

  // ---------- controls ----------

  function renderControl(spec: SubfnFieldSpec): HTMLElement {
    const kind = kindOf(spec)
    const v = model.values.get(spec.key)?.value
    if (v?.kind === 'code') return codeControl(spec)
    if (kind === 'dropdown' || kind === 'boolean') return manual.has(spec.key) ? manualControl(spec) : choiceControl(spec, false)
    if (kind === 'multiselect') return manual.has(spec.key) ? manualControl(spec) : choiceControl(spec, true)
    if (kind === 'list') return listControl(spec)
    return textControl(spec, 1)
  }

  function autoGrow(t: HTMLTextAreaElement): void {
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight + 2, 220)}px`
  }

  /** A growing text input with the data-mapping button. */
  function mappedText(key: string, part: string, value: string, placeholder: string, onInput: (text: string) => void, rows = 1, code = false): HTMLElement {
    const input = el('textarea', `vs-sf-input vs-sf-textarea${code ? ' vs-sf-code' : ''}`)
    input.rows = rows
    input.spellcheck = false
    input.value = value
    input.placeholder = placeholder
    input.dataset.vsField = key
    input.dataset.vsPart = part
    input.setAttribute('aria-label', placeholder)
    input.addEventListener('input', () => {
      autoGrow(input)
      onInput(input.value)
    })
    requestAnimationFrame(() => autoGrow(input))
    return el('div', 'vs-sf-map', input, variablePicker(input, code, () => onInput(input.value)))
  }

  function textControl(spec: SubfnFieldSpec, rows: number): HTMLElement {
    const v = model.values.get(spec.key)?.value
    const text = v?.kind === 'text' ? v.text : ''
    const kind = kindOf(spec)
    const placeholder = spec.placeholder ?? (kind === 'number' ? 'Number or mapped data' : kind === 'date' ? (spec.dateFormat ?? 'Date or mapped data') : `Enter ${label(spec).toLowerCase()}`)
    return mappedText(spec.key, 'value', text, placeholder, (t) => changed(spec.key, t.trim() ? { kind: 'text', text: t } : null), rows)
  }

  function codeControl(spec: SubfnFieldSpec): HTMLElement {
    const v = model.values.get(spec.key)?.value
    const code = v?.kind === 'code' ? v.code : ''
    return el(
      'div',
      'vs-sf-fcontrol',
      mappedText(spec.key, 'code', code, 'JavaScript expression', (t) => changed(spec.key, t.trim() ? { kind: 'code', code: t } : null), 1, true),
      el('div', 'vs-sf-fhelp', 'This value is JavaScript code in the call.'),
    )
  }

  /** Typed or mapped input instead of a choice (the panel's "provide manual/dynamic input"). */
  function manualControl(spec: SubfnFieldSpec): HTMLElement {
    const v = model.values.get(spec.key)?.value
    const text = v?.kind === 'text' ? v.text : ''
    return el(
      'div',
      'vs-sf-fcontrol',
      mappedText(spec.key, 'value', text, 'Type a value or map data', (t) => changed(spec.key, t.trim() ? { kind: 'text', text: t } : null)),
      btn('vs-sf-mini', ['Choose from the list'], () => {
        manual.delete(spec.key)
        changed(spec.key, null)
      }),
    )
  }

  function listControl(spec: SubfnFieldSpec): HTMLElement {
    const v = model.values.get(spec.key)?.value
    const items = v?.kind === 'list' ? [...v.items] : ['']
    if (!items.length) items.push('')
    const wrap = el('div', 'vs-sf-rows')
    const commit = () => changed(spec.key, items.some((x) => x.trim()) ? { kind: 'list', items: [...items] } : null)
    const draw = () => {
      wrap.replaceChildren(
        ...items.map((item, i) =>
          el(
            'div',
            'vs-sf-kv',
            el('div', '', `#${i + 1}`),
            mappedText(spec.key, `item${i}`, item, 'Value or mapped data', (t) => {
              items[i] = t
              commit()
            }),
            items.length > 1
              ? btn('vs-sf-unadd', [icon(SVG.close)], () => {
                  items.splice(i, 1)
                  commit()
                  draw()
                }, 'Remove')
              : el('span'),
          ),
        ),
        btn('vs-sf-mini', [icon(SVG.plus), 'Add'], () => {
          items.push('')
          draw()
        }),
      )
    }
    draw()
    return wrap
  }

  function dictionaryControl(spec: SubfnFieldSpec): HTMLElement {
    const v = model.values.get(spec.key)?.value
    const rows = v?.kind === 'dict' ? v.rows.map((r) => ({ ...r })) : [{ key: '', value: '' }]
    if (!rows.length) rows.push({ key: '', value: '' })
    const wrap = el('div', 'vs-sf-rows')
    const commit = () => changed(spec.key, rows.some((r) => r.key.trim()) ? { kind: 'dict', rows: rows.map((r) => ({ ...r })) } : null)
    const draw = () => {
      wrap.replaceChildren(
        ...rows.map((r, i) =>
          el(
            'div',
            'vs-sf-kv',
            mappedText(spec.key, `key${i}`, r.key, 'Key', (t) => {
              r.key = t
              commit()
            }),
            mappedText(spec.key, `value${i}`, r.value, 'Value or mapped data', (t) => {
              r.value = t
              commit()
            }),
            btn('vs-sf-unadd', [icon(SVG.close)], () => {
              rows.splice(i, 1)
              if (!rows.length) rows.push({ key: '', value: '' })
              commit()
              draw()
            }, 'Remove row'),
          ),
        ),
        btn('vs-sf-mini', [icon(SVG.plus), 'Add row'], () => {
          rows.push({ key: '', value: '' })
          draw()
        }),
      )
    }
    draw()
    return wrap
  }

  /** The panel's dropdown: a field showing the pick(s), opening a searchable list with the manual-input choice. */
  function choiceControl(spec: SubfnFieldSpec, multi: boolean): HTMLElement {
    const key = spec.key
    const isBool = kindOf(spec) === 'boolean'
    const fixed: Array<{ label: string; value: unknown }> = isBool
      ? (spec.options?.length ? spec.options : [{ label: 'Yes', value: true }, { label: 'No', value: false }])
      : (spec.options ?? [])
    let loaded: SubfnOptionsResult | undefined
    let loadedAt = 0
    let searchResult: SubfnOptionsResult | undefined
    let loading = false
    const wrap = el('div', 'vs-sf-rel')
    const status = el('div', 'vs-sf-fhelp')
    status.hidden = true

    const all = (): Array<{ label: string; value: unknown }> => {
      const list = [...(searchResult?.options ?? loaded?.options ?? [])]
      for (const o of fixed) if (!list.some((x) => sameValue(x.value, o.value))) list.push(o)
      return list
    }
    const picked = (): Array<{ value: unknown; label?: string }> => {
      const v = model.values.get(key)?.value
      if (v?.kind === 'choice') return [{ value: v.value, label: v.label }]
      if (v?.kind === 'choices') return v.items
      return []
    }
    const labelOf = (p: { value: unknown; label?: string }) => p.label ?? all().find((o) => sameValue(o.value, p.value))?.label ?? shownValue(p.value)

    const pickBtn = el('button', 'vs-sf-pick')
    pickBtn.type = 'button'
    pickBtn.dataset.vsField = key
    pickBtn.dataset.vsPart = 'pick'
    pickBtn.setAttribute('aria-haspopup', 'listbox')
    pickBtn.setAttribute('aria-label', label(spec))

    const drawButton = () => {
      const picks = picked()
      const content: Node[] = []
      if (multi && picks.length) {
        const chips = el('span', 'vs-sf-chiprow')
        for (const p of picks) {
          chips.append(
            el(
              'span',
              'vs-sf-vchip',
              el('span', '', labelOf(p)),
              btn('vs-sf-unadd', [icon(SVG.close)], () => {
                const rest = picks.filter((x) => !sameValue(x.value, p.value))
                changed(key, rest.length ? { kind: 'choices', items: rest } : null)
              }, `Remove ${labelOf(p)}`),
            ),
          )
        }
        content.push(chips)
      } else {
        const t = el('span', `vs-sf-pick-text${picks.length ? '' : ' vs-sf-placeholder'}`)
        t.textContent = picks.length ? labelOf(picks[0] as { value: unknown; label?: string }) : loading ? 'Loading…' : multi ? 'Select values' : 'Select'
        content.push(t)
      }
      content.push(icon(SVG.chevron))
      pickBtn.replaceChildren(...content)
    }

    const pop = el('div', 'vs-sf-dd')
    pop.hidden = true
    host.popovers.add(pop)
    const search = el('input', 'vs-sf-input vs-sf-dd-search')
    search.placeholder = spec.searchable ? 'Search' : 'Filter'
    search.setAttribute('aria-label', `Search ${label(spec)}`)
    const list = el('div', 'vs-sf-dd-list')
    list.setAttribute('role', 'listbox')
    const foot = el('div', 'vs-sf-dd-foot')
    pop.append(search, list, foot)

    const choose = (o: { label: string; value: unknown }) => {
      if (multi) {
        const picks = picked()
        const has = picks.some((p) => sameValue(p.value, o.value))
        const next = has ? picks.filter((p) => !sameValue(p.value, o.value)) : [...picks, { value: o.value, label: o.label }]
        changed(key, next.length ? { kind: 'choices', items: next } : null)
        drawButton()
        drawList()
      } else {
        pop.hidden = true
        changed(key, { kind: 'choice', value: o.value, label: o.label })
        drawButton()
        pickBtn.focus()
      }
    }

    const drawList = () => {
      const q = spec.searchable ? '' : search.value.trim().toLowerCase()
      const picks = picked()
      const items: Node[] = [
        btn('vs-sf-dd-item vs-sf-dd-manual', ['Provide manual / dynamic input'], () => {
          pop.hidden = true
          manual.add(key)
          changed(key, null)
        }),
      ]
      const shown = all().filter((o) => !q || o.label.toLowerCase().includes(q) || shownValue(o.value).toLowerCase().includes(q))
      for (const o of shown.slice(0, 300)) {
        const sel = picks.some((p) => sameValue(p.value, o.value))
        const item = btn('vs-sf-dd-item', [el('span', 'vs-sf-dd-check', sel ? icon(SVG.check) : null), el('span', 'vs-sf-pick-text', o.label || shownValue(o.value))], () => choose(o))
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(sel))
        items.push(item)
      }
      if (loading) items.push(el('div', 'vs-sf-dd-note', 'Loading choices…'))
      else if (!shown.length) items.push(el('div', 'vs-sf-dd-note', loaded?.error ?? loaded?.help ?? (q ? 'No match.' : 'No choices.')))
      list.replaceChildren(...items)
      const res = searchResult ?? loaded
      foot.replaceChildren(
        el('span', '', res?.more ? 'More results exist: search to narrow them.' : `${shown.length} choice${shown.length === 1 ? '' : 's'}`),
        spec.dynamic ? btn('vs-sf-mini', [icon(SVG.refresh), 'Refresh'], () => void load(true)) : el('span'),
      )
      search.hidden = !spec.searchable && all().length <= MANY_OPTIONS
    }

    const showStatus = () => {
      const res = loaded
      const text = res?.error ?? (res?.needsConnection ? 'Choose the account first.' : res?.needsFirst?.length ? `Fill ${res.needsFirst.join(', ')} first.` : '')
      status.textContent = text
      status.className = res?.error ? 'vs-sf-ferror' : 'vs-sf-fhelp'
      status.hidden = !text
    }

    async function load(fresh = false): Promise<void> {
      const p = options(key, fresh)
      if (!p) return
      loading = true
      drawButton()
      if (!pop.hidden) drawList()
      loaded = await p
      loadedAt = Date.now()
      loading = false
      if (!host.alive()) return
      drawButton()
      showStatus()
      if (!pop.hidden) drawList()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    search.addEventListener('input', () => {
      if (!spec.searchable) return drawList()
      clearTimeout(timer)
      timer = setTimeout(async () => {
        const text = search.value.trim()
        if (!text) {
          searchResult = undefined
          return drawList()
        }
        loading = true
        drawList()
        searchResult = await host.loadOptions(key, text).catch((e: unknown) => ({ options: [], error: errorText(e) }))
        loading = false
        if (!pop.hidden) drawList()
      }, SEARCH_DEBOUNCE_MS)
    })
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const first = list.querySelector<HTMLButtonElement>('.vs-sf-dd-item:not(.vs-sf-dd-manual)')
        first?.click()
      }
    })

    pickBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const open = pop.hidden
      host.closePopovers()
      pop.hidden = !open
      if (open) {
        drawList()
        placePopover(pop, pickBtn)
        // Opening refreshes choices that are not fresh, as the panel does on open; a changed parent field always
        // reloads (options() reuses its cache only while the fields it depends on are unchanged).
        if (spec.dynamic) void load(!loaded || !!loaded.error || Date.now() - loadedAt > STALE_MS)
        setTimeout(() => (search.hidden ? list.querySelector<HTMLElement>('.vs-sf-dd-item')?.focus() : search.focus()), 20)
      }
    })
    pickBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && pop.hidden) pickBtn.click()
    })

    drawButton()
    wrap.append(pickBtn, pop, status)
    // Choices load when the field shows (its parents are filled by then).
    if (spec.dynamic) void load()
    return wrap
  }

  /** The mapping button: lists the step's mappable data and inserts `${...}` at the caret. */
  function variablePicker(input: HTMLTextAreaElement, code: boolean, onChange: () => void): HTMLElement {
    const wrap = el('span')
    const pop = el('div', 'vs-sf-pop')
    pop.hidden = true
    host.popovers.add(pop)
    const search = el('input', 'vs-sf-input')
    search.placeholder = 'Search data (context.req.body…)'
    search.setAttribute('aria-label', 'Search data')
    const list = el('div', 'vs-sf-pop-list')
    pop.append(el('div', 'vs-sf-dd-search', search), list)
    const render = () => {
      const q = search.value.trim().toLowerCase()
      const vars = host.variables.filter((v) => !q || v.toLowerCase().includes(q))
      if (!vars.length) {
        return list.replaceChildren(el('div', 'vs-sf-dd-note', host.variables.length ? 'No match.' : 'No data to map yet: test the trigger and earlier steps first.'))
      }
      list.replaceChildren(
        ...vars.slice(0, 100).map((v) =>
          btn('vs-sf-pop-item vs-sf-code', [v], () => {
            const text = code ? v : `\${${v}}`
            const start = input.selectionStart ?? input.value.length
            const end = input.selectionEnd ?? start
            input.value = input.value.slice(0, start) + text + input.value.slice(end)
            pop.hidden = true
            onChange()
            autoGrow(input)
            input.focus()
            input.setSelectionRange(start + text.length, start + text.length)
          }),
        ),
      )
    }
    search.addEventListener('input', render)
    wrap.append(
      btn('vs-sf-map-btn', [icon(SVG.variable)], () => {
        const open = pop.hidden
        host.closePopovers()
        pop.hidden = !open
        if (open) {
          render()
          placePopover(pop, input, 340)
          setTimeout(() => search.focus(), 20)
        }
      }, 'Map data from the trigger or earlier steps'),
      pop,
    )
    return wrap
  }

  function validate(): string[] {
    invalid.clear()
    const missing: string[] = []
    const walk = (loc: string, depth: number) => {
      for (const key of model.form.steps[loc] ?? []) {
        const spec = model.spec(key)
        if (!spec || model.state(key, loc) !== 'shown') continue
        const kind = kindOf(spec)
        if (kind === 'group') {
          if (spec.generates && model.form.steps[key] === undefined) {
            if (model.groupRequired(key)) {
              invalid.add(key)
              missing.push(label(spec))
            }
          } else if (depth < 5) walk(key, depth + 1)
          continue
        }
        if (spec.required && !model.filled(key)) {
          invalid.add(key)
          missing.push(label(spec))
        }
      }
    }
    if (host.connectionReady()) walk('root', 0)
    refresh(true)
    const first = [...invalid][0]
    if (first) root.querySelector<HTMLElement>(`[data-vs-row="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return missing
  }

  refresh(true)
  return { element: root, refresh, validate }
}
