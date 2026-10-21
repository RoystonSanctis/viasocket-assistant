// Runs in the page's own JavaScript world at document_start (MAIN-world content script, classic IIFE).
//
// 1. Watches the viaSocket app's API traffic (XHR via axios, plus fetch) and reports what the user just did
//    (saved, tested, published, …) to the content script. Only method, path, status, timing, a short backend
//    error message and the step named in the page URL are reported; request and response payloads never leave this file.
// 2. Performs router-friendly navigation for the content script (pushState + popstate, like react-router), held
//    back while the page's own writes are in flight.
// 3. Answers read-only questions from the content script out of the editor's Redux store (the open JS step for the
//    subfunctions panel). Nothing here calls the network: all viaSocket API calls are made by the service worker.
// 4. Beautifies a Monaco code editor for the content script's Beautify button (editors.ts); the code never leaves
//    the page.
//
// Rules for code in the page's world: wrap whatever function is current (Sentry wraps XHR/fetch/history too),
// always call through to it with the original `this`, and never let an exception escape into the page.

import {
  PAGE_KEY,
  type ContentToPageMsg,
  type PageEnvelope,
  type PageToContentMsg,
  type StepContextData,
} from '../shared/messages'
import type { ObservedEvent } from '../shared/observed'
import { SUPPORTED_APP_HOSTS } from '../background/tools/env'
import { editorAction } from './editors'
import {
  classify, dryRunFailed, isPageMutation, MAX_PARSE_CHARS, outcomeInBody, parseCapped, shortErrorText, SLUG_MAX,
} from '../shared/classify'

const DEFAULT_API_HOSTS = ['flow-api.viasocket.com', 'dev-api.viasocket.com']
/** Extra API hosts from 'init' must be viaSocket hosts; anything else is ignored */
const EXTRA_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.viasocket\.com$/
const MAX_EXTRA_HOSTS = 8
const BUFFER_MAX = 20
const FBAI_HEADER = 'sent-by-fbai'
const INSTALLED = '__vsAssistantHookInstalled'
/** ?slugName= values of the trigger panel; they name a trigger type, not a step */
const TRIGGER_SLUGS = new Set(['trigger', 'webhook', 'email', 'cron', 'selecttrigger'])
/** The editor opens a new step's slider only after the create call returns */
const STEP_CREATED_URL_DELAY_MS = 500
const NAV_POLL_MS = 200
const NAV_WAIT_MAX_MS = 15_000
const NAV_QUEUE_MAX = 10

type AnyFn = (this: unknown, ...args: unknown[]) => unknown
type InboundMsg = ContentToPageMsg & { nonce: string }

interface Pending {
  method: string
  url: URL
  /** location.pathname when the call started (decides DH vs flow for execute calls) */
  pagePath: string
  start: number
  byAssistant: boolean
  /** Step slider open (?slugName=) when the call started */
  slugParam: string | undefined
  /** Counted in `inflight` and not yet settled */
  counted?: boolean
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function stepSlugInUrl(): string | undefined {
  const params = new URLSearchParams(location.search)
  const v = params.get('slugName')
  if (v && !TRIGGER_SLUGS.has(v)) return v.slice(0, SLUG_MAX)

  try {
    const slider = document.querySelector('[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider')
    if (slider) {
      const header = slider.querySelector('h5, h6, [data-testid="plugin-header"], [data-testid="step-title"], [data-testid="action-title"], .MuiTypography-h6')
      const text = header?.textContent?.trim()
      if (text && !/^(change|close)$/i.test(text)) {
        return text.replace(/\s+/g, '_').slice(0, SLUG_MAX)
      }
    }
  } catch {
    // ignore DOM errors
  }

  const stepId = params.get('stepId')
  if (stepId && !TRIGGER_SLUGS.has(stepId)) return stepId.slice(0, SLUG_MAX)
  return undefined
}

function install(): void {
  const apiHosts = new Set(DEFAULT_API_HOSTS)
  let nonce: string | null = null
  let quietHistory = false
  const buffer: ObservedEvent[] = []
  // The page's reducers file each response under the ids in the URL at the moment it lands, so the assistant's
  // route changes wait until the page's own writes (save, test, publish) have settled.
  let inflight = 0
  const navQueue: Array<{ url: string; replace: boolean }> = []
  let navTimer: ReturnType<typeof setTimeout> | undefined
  let navWaitSince = 0

  // ---------- messaging with the content script ----------

  function post(msg: PageToContentMsg): void {
    if (!nonce) return
    const envelope: PageEnvelope<PageToContentMsg> = { [PAGE_KEY]: { ...msg, nonce } }
    try {
      window.postMessage(envelope, location.origin)
    } catch {
      // nothing useful to do; never disturb the page
    }
  }

  function report(event: ObservedEvent): void {
    if (nonce) return post({ type: 'observed', event })
    buffer.push(event)
    if (buffer.length > BUFFER_MAX) buffer.shift()
  }

  function addHosts(hosts: unknown): void {
    if (!Array.isArray(hosts)) return
    let added = 0
    for (const h of hosts) {
      if (added >= MAX_EXTRA_HOSTS) break
      if (typeof h !== 'string') continue
      const host = h.toLowerCase()
      if (EXTRA_HOST.test(host) && !apiHosts.has(host)) {
        apiHosts.add(host)
        added++
      }
    }
  }

  function findReduxStore(): { dispatch: (action: unknown) => unknown; getState: () => Record<string, unknown> } | null {
    try {
      const w = window as unknown as Record<string, unknown>
      const checkCandidate = (s: unknown) => {
        if (!isObj(s)) return null
        if (typeof (s as { dispatch?: unknown }).dispatch === 'function' && typeof (s as { getState?: unknown }).getState === 'function') {
          return s as { dispatch: (action: unknown) => unknown; getState: () => Record<string, unknown> }
        }
        return null
      }

      const direct = checkCandidate(w.store) || checkCandidate(w.__viasocketStore) || checkCandidate(w.__REDUX_STORE__)
      if (direct) return direct

      // 1. window.__viasocketRoot (set by viaSocket index.tsx)
      const rootObj = w.__viasocketRoot as { _internalRoot?: { current?: unknown } } | undefined
      if (isObj(rootObj?._internalRoot?.current)) {
        const q: Array<{ fiber: unknown; depth: number }> = [{ fiber: rootObj._internalRoot.current, depth: 0 }]
        while (q.length > 0) {
          const item = q.shift()!
          if (!isObj(item.fiber) || item.depth > 25) continue
          const f = item.fiber as { memoizedProps?: Record<string, unknown>; pendingProps?: Record<string, unknown>; stateNode?: Record<string, unknown>; child?: unknown; sibling?: unknown }
          const s = checkCandidate(f.memoizedProps?.store) || checkCandidate(f.pendingProps?.store) || checkCandidate(f.stateNode?.store)
          if (s) return s
          if (f.child) q.push({ fiber: f.child, depth: item.depth + 1 })
          if (f.sibling) q.push({ fiber: f.sibling, depth: item.depth })
        }
      }

      // 2. DOM #root container fiber
      const rootEl = document.getElementById('root')
      if (rootEl) {
        const containerKey = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'))
        if (containerKey) {
          const q: Array<{ fiber: unknown; depth: number }> = [{ fiber: (rootEl as unknown as Record<string, unknown>)[containerKey], depth: 0 }]
          while (q.length > 0) {
            const item = q.shift()!
            if (!isObj(item.fiber) || item.depth > 25) continue
            const f = item.fiber as { memoizedProps?: Record<string, unknown>; pendingProps?: Record<string, unknown>; stateNode?: Record<string, unknown>; child?: unknown; sibling?: unknown }
            const s = checkCandidate(f.memoizedProps?.store) || checkCandidate(f.pendingProps?.store) || checkCandidate(f.stateNode?.store)
            if (s) return s
            if (f.child) q.push({ fiber: f.child, depth: item.depth + 1 })
            if (f.sibling) q.push({ fiber: f.sibling, depth: item.depth })
          }
        }
      }

      // 3. Walk up from any DOM element inside #root
      const sample = document.querySelector('#root div, #root nav, [class*="slider"], [class*="flow"]')
      if (sample) {
        const fiberKey = Object.keys(sample).find((k) => k.startsWith('__reactFiber$'))
        if (fiberKey) {
          let curr: unknown = (sample as unknown as Record<string, unknown>)[fiberKey]
          let hops = 0
          while (isObj(curr) && hops++ < 40) {
            const f = curr as { memoizedProps?: Record<string, unknown>; stateNode?: Record<string, unknown>; return?: unknown }
            const s = checkCandidate(f.memoizedProps?.store) || checkCandidate(f.stateNode?.store)
            if (s) return s
            curr = f.return
          }
        }
      }
    } catch {
      // never disturb the host page
    }
    return null
  }

  function extractScriptId(pathname: string): string | undefined {
    const m = pathname.match(/\/workflow\/([A-Za-z0-9]+)/)
    return m ? m[1] : undefined
  }

  function invalidateStep(
    scriptId?: string,
    stepId?: string,
    slugName?: string,
    flowJson?: Record<string, unknown>,
    stepRow?: Record<string, unknown>,
  ): void {
    try {
      const store = findReduxStore()
      if (!store) return

      const state = store.getState()
      const resolvedScriptId =
        scriptId ||
        extractScriptId(location.pathname) ||
        (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)

      // Both reducers below take the flow and step ids from the URL, so only the flow (and step) that is open.
      const openFlow = !!scriptId && scriptId === extractScriptId(location.pathname) && isObj(state.flowJsonV2) && isObj(state.flowJsonV2[scriptId])

      // The flow as the save returned it, applied the way the editor applies an assistant save (workFlowNavbar's
      // RTLayer handler: setFlowAndDraftFlowJson), so a step saved for the first time is no longer DRAFTED here.
      if (flowJson && openFlow) store.dispatch({ type: 'flowJsonV2/setFlowAndDraftFlowJson', payload: flowJson })

      // The saved step, stored the way the editor stores a fetched step (resetButtonForSlider: setFunctionJsonThunkV3
      // then setKeyValueInstance). Dropping the step data instead is not enough for a step that was never loaded
      // from the server (a new one): MasterSliderComponent refetches only when dataFromBackend changes, which such a
      // step never had, so the panel stayed empty until it was reopened.
      if (
        stepRow &&
        openFlow &&
        slugName &&
        stepId &&
        stepRow.id === stepId &&
        stepRow.script_id === scriptId &&
        new URLSearchParams(location.search).get('stepId') === stepId
      ) {
        const flowState = isObj(state.flowJsonV2) ? (store.getState().flowJsonV2 as Record<string, unknown>)[scriptId as string] : undefined
        const blockOf = (key: 'flowJson' | 'publishedFlowJson'): Record<string, unknown> => {
          const json = isObj(flowState) ? flowState[key] : undefined
          const blocks = isObj(json) ? json.blocks : undefined
          const block = isObj(blocks) ? blocks[slugName] : undefined
          return isObj(block) ? block : {}
        }
        const draftBlock = blockOf('flowJson')
        // Edits the save did not write stay pending, as they were: a rename (the editor's Save applies it, renaming
        // the step everywhere), a changed description, a changed step connection. Put back after the row, they keep
        // the step marked unsaved so Save stays available.
        const stepsOfFlow = isObj(state.stepsDataV3) ? state.stepsDataV3[scriptId as string] : undefined
        const stepEntry = isObj(stepsOfFlow) ? stepsOfFlow[stepId] : undefined
        const prev = isObj(stepEntry) && isObj(stepEntry.draft) ? stepEntry.draft : {}
        const pending: Record<string, unknown> = {}
        if (typeof prev.title === 'string' && prev.title && prev.title !== slugName) pending.title = prev.title
        if (prev.descriptionChanged === true && typeof prev.description === 'string') {
          pending.description = prev.description
          pending.descriptionChanged = true
        }
        if (typeof prev.authId === 'string' && prev.authId && prev.authId !== stepRow.auth_id) pending.authId = prev.authId
        store.dispatch({
          type: 'stepsDataV3/setFunctionJson/fulfilled',
          payload: {
            data: stepRow,
            draftdecription: draftBlock.description,
            publisheddecription: blockOf('publishedFlowJson').description,
            aistep: draftBlock.aistep,
            subfunctions: draftBlock.subfunctions,
          },
        })
        store.dispatch({ type: 'stepsDataV3/setKeyValueInstance', payload: { title: slugName, hasUnsavedCode: false } })
        if (Object.keys(pending).length) store.dispatch({ type: 'stepsDataV3/setKeyValueInstance', payload: pending })
        return
      }

      let targetStepId = stepId
      if (!targetStepId && slugName && resolvedScriptId && isObj(state.flowJsonV2)) {
        const flowReducer = (state.flowJsonV2 as Record<string, unknown>)[resolvedScriptId]
        if (isObj(flowReducer) && isObj(flowReducer.flowJson) && isObj((flowReducer.flowJson as Record<string, unknown>).blocks)) {
          const blocks = (flowReducer.flowJson as { blocks: Record<string, unknown> }).blocks
          const block = blocks[slugName]
          if (isObj(block) && typeof block.identifier === 'string') {
            targetStepId = block.identifier
          }
        }
      }

      const urlParams = new URLSearchParams(location.search)
      const urlStepId = urlParams.get('stepId')
      const currentStepId = targetStepId || (urlStepId && !TRIGGER_SLUGS.has(urlStepId) ? urlStepId : undefined)

      if (currentStepId) {
        store.dispatch({
          type: 'stepsDataV3/deleteStepFromStepData',
          payload: { stepId: currentStepId },
        })
      }
      if (urlStepId && urlStepId !== currentStepId && !TRIGGER_SLUGS.has(urlStepId)) {
        store.dispatch({
          type: 'stepsDataV3/deleteStepFromStepData',
          payload: { stepId: urlStepId },
        })
      }
      store.dispatch({
        type: 'stepsDataV3/deleteScriptFromStepReducer',
        payload: {},
      })
    } catch {
      // never throw into the page
    }
  }

  /**
   * The open JS step, for the subfunctions panel, read from the editor's Redux store (never fetched). The code is the
   * step's draft as the editor last committed it (Monaco writes it on blur), so unsaved edits are included. Null on
   * the published tab and while the step's data is still loading, so the panel can never save an empty draft.
   */
  function readStepContext(msg: { scriptId?: string; stepId?: string; slugName?: string }): StepContextData | null {
    try {
      const state = findReduxStore()?.getState()
      if (!state) return null
      const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {})
      const route = /\/workflow\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/.exec(location.pathname)
      const scriptId = msg.scriptId || route?.[1]
      if (!scriptId || route?.[2] === 'published') return null

      const flowState = obj(obj(state.flowJsonV2)[scriptId])
      const flowJson = obj(flowState.flowJson)
      const blocks = obj(flowJson.blocks)
      const params = new URLSearchParams(location.search)
      let slugName = msg.slugName || params.get('slugName') || ''
      let stepId = msg.stepId || params.get('stepId') || ''
      if (!slugName && stepId) slugName = Object.keys(blocks).find((k) => obj(blocks[k]).identifier === stepId) ?? ''
      const block = obj(blocks[slugName])
      if (!stepId && typeof block.identifier === 'string') stepId = block.identifier
      if (!slugName || !stepId || TRIGGER_SLUGS.has(slugName) || block.type !== 'function') return null

      const draft = obj(obj(obj(obj(state.stepsDataV3)[scriptId])[stepId]).draft)
      if (typeof draft.code !== 'string') return null

      const otherSubfunctions: StepContextData['otherSubfunctions'] = []
      for (const [slug, raw] of Object.entries(blocks)) {
        const b = obj(raw)
        if (slug === slugName || b.status === 'DELETE') continue
        for (const sf of Array.isArray(b.subfunctions) ? b.subfunctions : []) {
          if (isObj(sf) && typeof sf.name === 'string') otherSubfunctions.push({ name: sf.name, authId: typeof sf.authId === 'string' ? sf.authId : '' })
        }
      }

      // Mappable data: the trigger's sample, and the output of steps that run before this one (stepOrder is the
      // editor's run order; without it every other step is offered).
      const variables: string[] = []
      const sample = obj(obj(flowJson.trigger).sampleData)
      for (const k of Object.keys(isObj(sample.body) ? sample.body : sample)) variables.push(`context.req.body.${k}`)
      const order = Array.isArray(flowState.stepOrder) ? flowState.stepOrder.filter((k): k is string => typeof k === 'string') : []
      const here = order.indexOf(slugName)
      const earlier = here >= 0 ? order.slice(0, here) : Object.keys(blocks).filter((k) => k !== slugName)
      for (const slug of earlier) {
        const b = obj(blocks[slug])
        if (b.status === 'DELETE' || b.status === 'DRAFTED') continue
        if (b.type === 'function' || b.type === 'api' || b.type === 'plugin') variables.push(`context.res.${slug}`)
        else if (b.type === 'variable') variables.push(`context.vals.${slug}`)
      }

      const connectedApps: StepContextData['connectedApps'] = []
      const seen = new Set<string>()
      for (const a of Array.isArray(obj(state.auth).allAuths) ? (obj(state.auth).allAuths as unknown[]) : []) {
        const r = obj(a)
        if (typeof r.service_id !== 'string' || typeof r.service_name !== 'string' || seen.has(r.service_id)) continue
        seen.add(r.service_id)
        connectedApps.push({ serviceId: r.service_id, name: r.service_name, iconUrl: typeof r.iconUrl === 'string' ? r.iconUrl : undefined })
      }

      const subfunctions = Array.isArray(draft.subfunctions) ? draft.subfunctions : Array.isArray(block.subfunctions) ? block.subfunctions : []
      return {
        scriptId,
        stepId,
        slugName,
        stepType: 'function',
        code: draft.code,
        subfunctions: subfunctions.filter(isObj).map((sf) => ({
          name: String(sf.name ?? ''),
          actionId: String(sf.actionId ?? ''),
          authId: String(sf.authId ?? ''),
        })),
        dynamicVariables: isObj(draft.dynamicVariables) ? (draft.dynamicVariables as Record<string, string>) : undefined,
        otherSubfunctions,
        connectedApps,
        variables,
      }
    } catch {
      return null
    }
  }

  function unwrap(data: unknown): InboundMsg | null {
    if (!isObj(data)) return null
    const inner = data[PAGE_KEY]
    if (!isObj(inner) || typeof inner.nonce !== 'string' || inner.nonce.length < 16 || inner.nonce.length > 128) return null
    if (inner.type === 'init') return { type: 'init', apiHosts: Array.isArray(inner.apiHosts) ? inner.apiHosts : [], nonce: inner.nonce }
    if (inner.type === 'navigate' && typeof inner.url === 'string') {
      return { type: 'navigate', url: inner.url, replace: inner.replace === true, nonce: inner.nonce }
    }
    if (inner.type === 'refresh-step') {
      return {
        type: 'refresh-step',
        scriptId: typeof inner.scriptId === 'string' ? inner.scriptId : undefined,
        stepId: typeof inner.stepId === 'string' ? inner.stepId : undefined,
        slugName: typeof inner.slugName === 'string' ? inner.slugName : undefined,
        flowJson: isObj(inner.flowJson) && isObj(inner.flowJson.blocks) && isObj(inner.flowJson.order) ? inner.flowJson : undefined,
        stepRow: isObj(inner.stepRow) && typeof inner.stepRow.id === 'string' && typeof inner.stepRow.code === 'string' ? inner.stepRow : undefined,
        nonce: inner.nonce,
      }
    }
    if (inner.type === 'get-step-context' && typeof inner.requestId === 'string') {
      return {
        type: 'get-step-context',
        requestId: inner.requestId.slice(0, 64),
        scriptId: typeof inner.scriptId === 'string' ? inner.scriptId : undefined,
        stepId: typeof inner.stepId === 'string' ? inner.stepId : undefined,
        slugName: typeof inner.slugName === 'string' ? inner.slugName : undefined,
        nonce: inner.nonce,
      }
    }
    if (
      inner.type === 'editor-action' &&
      typeof inner.requestId === 'string' &&
      typeof inner.editorId === 'string' &&
      (inner.action === 'check' || inner.action === 'beautify')
    ) {
      return { type: 'editor-action', requestId: inner.requestId.slice(0, 64), editorId: inner.editorId, action: inner.action, nonce: inner.nonce }
    }
    if (inner.type === 'release') return { type: 'release', nonce: inner.nonce }
    return null
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    try {
      if (ev.source !== window || ev.origin !== location.origin) return
      const msg = unwrap(ev.data)
      if (!msg) return
      if (msg.type === 'init') {
        // The first init wins; the content script retries with the same nonce until it sees hook-ready.
        if (nonce === null) {
          nonce = msg.nonce
          addHosts(msg.apiHosts)
          for (const e of buffer.splice(0)) post({ type: 'observed', event: e })
        }
        if (msg.nonce === nonce) post({ type: 'hook-ready' })
        return
      }
      if (msg.nonce !== nonce) return
      if (msg.type === 'release') {
        // This hook outlives an extension update, and the re-injected content script brings a new nonce.
        nonce = null
        return
      }
      if (msg.type === 'refresh-step') {
        invalidateStep(msg.scriptId, msg.stepId, msg.slugName, msg.flowJson, msg.stepRow)
        return
      }
      if (msg.type === 'get-step-context') {
        post({ type: 'step-context-response', requestId: msg.requestId, data: readStepContext(msg) })
        return
      }
      if (msg.type === 'editor-action') {
        post({ type: 'editor-action-response', requestId: msg.requestId, result: editorAction(msg.editorId, msg.action) })
        return
      }
      requestNavigate(msg.url, msg.replace === true)
    } catch {
      // never throw into the page
    }
  })

  // ---------- network observation ----------

  function track(method: unknown, rawUrl: unknown): Pending | null {
    if (typeof method !== 'string') return null
    if (typeof rawUrl !== 'string' && !(rawUrl instanceof URL)) return null
    let url: URL
    try {
      url = new URL(String(rawUrl), location.href)
    } catch {
      return null
    }
    if (!apiHosts.has(url.host)) return null
    return {
      method: method.toUpperCase(),
      url,
      pagePath: location.pathname,
      start: performance.now(),
      byAssistant: false,
      slugParam: stepSlugInUrl(),
    }
  }

  /** @returns true when this call started counting the request */
  function countStart(p: Pending): boolean {
    if (p.counted || !isPageMutation(p.method, p.url.pathname)) return false
    p.counted = true
    inflight++
    return true
  }

  function countEnd(p: Pending): void {
    if (!p.counted) return
    p.counted = false
    inflight = Math.max(0, inflight - 1)
  }

  function settle(p: Pending, status: number, readBody: () => Promise<unknown>): void {
    const c = classify(p.method, p.url.pathname, status, p.pagePath)
    if (!c) return
    const at = Date.now()
    const durationMs = Math.max(0, Math.round(performance.now() - p.start))
    const httpOk = status >= 200 && status < 300
    const wantBody = status >= 400 || (httpOk && outcomeInBody(c.kind))

    // Dry-run and create calls carry no slug in their path; the open slider (or the one opened for the new step) names it.
    let slugName = c.slugName ?? (c.kind === 'step-tested' ? p.slugParam : undefined)
    const done = (body: unknown): void => {
      const event: ObservedEvent = {
        kind: c.kind,
        at,
        method: p.method,
        path: c.path,
        status,
        ok: httpOk && !(outcomeInBody(c.kind) && dryRunFailed(body)),
        byAssistant: p.byAssistant,
        durationMs,
      }
      if (c.scriptId) event.scriptId = c.scriptId
      if (slugName) event.slugName = slugName
      if (status >= 400) {
        const text = shortErrorText(body)
        if (text) event.errorText = text
      }
      report(event)
    }

    if (c.kind === 'step-created' && httpOk && !slugName) {
      setTimeout(() => {
        try {
          const slug = stepSlugInUrl()
          if (slug !== p.slugParam) slugName = slug
          done(undefined)
        } catch {
          // ignore
        }
      }, STEP_CREATED_URL_DELAY_MS)
      return
    }
    if (!wantBody) return done(undefined)
    readBody()
      .then(done, () => done(undefined))
      .catch(() => undefined)
  }

  async function readXhrBody(xhr: XMLHttpRequest): Promise<unknown> {
    if (xhr.responseType === 'json') return xhr.response as unknown
    if (xhr.responseType !== '' && xhr.responseType !== 'text') return undefined
    return parseCapped(xhr.responseText)
  }

  async function readFetchBody(res: Response): Promise<unknown> {
    if (!(res.headers.get('content-type') ?? '').includes('json')) return undefined
    if (Number(res.headers.get('content-length') ?? 0) > MAX_PARSE_CHARS) return undefined
    // clone() runs synchronously, before the page's own handlers can consume the body.
    return parseCapped(await res.clone().text())
  }

  function patchXhr(): void {
    const proto = XMLHttpRequest.prototype
    const pending = new WeakMap<XMLHttpRequest, Pending>()
    const origOpen = proto.open as unknown as AnyFn
    const origSetHeader = proto.setRequestHeader
    const origSend = proto.send as unknown as AnyFn

    proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
      try {
        // open() on a busy XHR drops the old request without a loadend for it.
        const prev = pending.get(this)
        if (prev) countEnd(prev)
        pending.delete(this)
        const p = track(args[0], args[1])
        if (p) pending.set(this, p)
      } catch {
        // tracking is optional; the request is not
      }
      origOpen.apply(this, args)
    }

    proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      try {
        const p = pending.get(this)
        if (p && typeof name === 'string' && name.toLowerCase() === FBAI_HEADER) p.byAssistant = true
      } catch {
        // ignore
      }
      origSetHeader.call(this, name, value)
    }

    proto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
      let counted: Pending | undefined
      try {
        const p = pending.get(this)
        if (p) {
          p.start = performance.now()
          if (countStart(p)) counted = p
          const xhr = this
          const onEnd = (): void => {
            try {
              xhr.removeEventListener('loadend', onEnd)
              countEnd(p)
              // open() on a busy XHR silently restarts it; only the request this listener belongs to counts.
              if (pending.get(xhr) !== p) return
              pending.delete(xhr)
              settle(p, xhr.status, () => readXhrBody(xhr))
            } catch {
              // ignore
            }
          }
          xhr.addEventListener('loadend', onEnd)
        }
      } catch {
        // ignore
      }
      try {
        origSend.apply(this, args)
      } catch (e) {
        // A send() that throws (not opened, already sent) never fires loadend, so it must not hold navigation back.
        if (counted) countEnd(counted)
        throw e
      }
    }
  }

  function trackFetch(input: RequestInfo | URL, init: RequestInit | undefined): Pending | null {
    const isReq = typeof Request !== 'undefined' && input instanceof Request
    const method = init?.method ?? (isReq ? input.method : 'GET')
    const p = track(method, isReq ? input.url : input instanceof URL ? input : String(input))
    if (!p) return null
    try {
      const headers = new Headers(init?.headers ?? (isReq ? input.headers : undefined))
      p.byAssistant = headers.has(FBAI_HEADER)
    } catch {
      // malformed headers are the page's problem; keep tracking
    }
    return p
  }

  function patchFetch(): void {
    const origFetch = window.fetch
    if (typeof origFetch !== 'function') return
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      let p: Pending | null = null
      try {
        p = trackFetch(args[0], args[1])
      } catch {
        p = null
      }
      const result = origFetch.apply(this, args)
      if (p) {
        const req = p
        try {
          countStart(req)
          result.then(
            (res) => {
              try {
                countEnd(req)
                settle(req, res.status, () => readFetchBody(res))
              } catch {
                // ignore
              }
            },
            () => {
              try {
                countEnd(req)
                settle(req, 0, async () => undefined)
              } catch {
                // ignore
              }
            },
          )
        } catch {
          // ignore
        }
      }
      // The page gets the original promise, untouched.
      return result
    }
  }

  // ---------- routing ----------

  function patchHistory(): void {
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = history[name]
      history[name] = function (this: History, ...args: Parameters<History['pushState']>): void {
        const before = location.href
        orig.apply(this, args)
        try {
          if (!quietHistory && location.href !== before) post({ type: 'navigated', url: location.href })
        } catch {
          // ignore
        }
      }
    }
  }

  function requestNavigate(url: string, replace: boolean): void {
    navQueue.push({ url, replace })
    if (navQueue.length > NAV_QUEUE_MAX) navQueue.shift()
    if (navTimer !== undefined) return
    navWaitSince = performance.now()
    flushNavigation()
  }

  function flushNavigation(): void {
    navTimer = undefined
    // Capped: a hung request (or a 60s test run) must not hold the assistant's navigation back indefinitely.
    if (inflight > 0 && performance.now() - navWaitSince < NAV_WAIT_MAX_MS) {
      navTimer = setTimeout(flushNavigation, NAV_POLL_MS)
      return
    }
    if (inflight > 0) post({ type: 'navigate-busy' })
    for (const n of navQueue.splice(0)) {
      try {
        navigate(n.url, n.replace)
      } catch {
        // never throw into the page
      }
    }
  }

  function navigate(url: string, replace: boolean): void {
    if (!url.startsWith('/') || url.startsWith('//') || url.length > 2048) return
    let target: URL
    try {
      target = new URL(url, location.origin)
    } catch {
      return
    }
    if (target.origin !== location.origin) return
    const next = target.pathname + target.search + target.hash

    const stepId = target.searchParams.get('stepId')
    const slugName = target.searchParams.get('slugName')
    if (target.searchParams.has('timestamp') || (stepId && !TRIGGER_SLUGS.has(stepId))) {
      const scriptId = extractScriptId(target.pathname)
      invalidateStep(scriptId, stepId ?? undefined, slugName ?? undefined)
    }

    // Same shape react-router (v5Compat history) writes, so its pop handler computes a sane delta.
    const cur: unknown = history.state
    const idx = isObj(cur) && typeof cur.idx === 'number' ? cur.idx : 0
    const state = { usr: null, key: Math.random().toString(36).slice(2, 10), idx: replace ? idx : idx + 1 }
    quietHistory = true
    try {
      if (replace) history.replaceState(state, '', next)
      else history.pushState(state, '', next)
    } finally {
      quietHistory = false
    }
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    post({ type: 'navigated', url: location.href })
  }

  // Each patch is independent so one failing does not take the others down.
  for (const patch of [patchXhr, patchFetch, patchHistory]) {
    try {
      patch()
    } catch {
      // leave that API untouched
    }
  }
}

function alreadyInstalled(): boolean {
  const w = window as unknown as Record<string, unknown>
  if (w[INSTALLED]) return true
  Object.defineProperty(window, INSTALLED, { value: true, enumerable: false, configurable: false, writable: false })
  return false
}

try {
  if (window.top === window && SUPPORTED_APP_HOSTS.includes(location.host) && !alreadyInstalled()) install()
} catch {
  // never throw into the page
}
