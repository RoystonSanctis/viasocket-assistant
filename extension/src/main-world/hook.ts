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
import { resolveEnv } from '../background/tools/env'
import { editorAction } from './editors'
import {
  classify, dryRunFailed, isObj, isPageMutation, MAX_PARSE_CHARS, outcomeInBody, parseCapped, shortErrorText, SLUG_MAX,
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

function stepSlugInUrl(): string | undefined {
  const params = new URLSearchParams(location.search)
  const v = params.get('slugName')
  // The editor opens a step's slider only from these URL params; page headings show app names, not slugs.
  return v && !TRIGGER_SLUGS.has(v) ? v.slice(0, SLUG_MAX) : undefined
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

      const isPreProcess =
        slugName === 'CRON_PRE_PROCESS' ||
        stepId === 'CRON_PRE_PROCESS' ||
        slugName === 'WEBHOOK_PRE_PROCESS' ||
        stepId === 'WEBHOOK_PRE_PROCESS'

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
        const urlData = {
          sectionIdOrScriptId: resolvedScriptId || scriptId || extractScriptId(location.pathname),
          versionIdOrStepId: stepId,
          tabName: 'draft',
        }
        if (isPreProcess) {
          store.dispatch({
            type: 'stepsDataV3/setFunctionJson/fulfilled',
            payload: {
              data: stepRow,
              draftdecription: '',
              publisheddecription: '',
              aistep: false,
              subfunctions: stepRow.subfunctions,
            },
          })
          store.dispatch({ type: 'stepsDataV3/setKeyValueInstance', urlData, payload: { title: slugName, hasUnsavedCode: false } })
          return
        }

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
        store.dispatch({ type: 'stepsDataV3/setKeyValueInstance', urlData, payload: { title: slugName, hasUnsavedCode: false } })
        if (Object.keys(pending).length) store.dispatch({ type: 'stepsDataV3/setKeyValueInstance', urlData, payload: pending })
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

      // The reducer drops the step from the flow in the URL, so only touch the open flow; never the whole flow's
      // step data (that wipes every step's unsaved draft) and never a step the user has unsaved edits in.
      const urlFlow = resolvedScriptId || scriptId || extractScriptId(location.pathname)
      if (!urlFlow) return
      const drop = (id: string) => {
        store.dispatch({
          type: 'stepsDataV3/deleteStepFromStepData',
          urlData: { sectionIdOrScriptId: urlFlow },
          payload: { stepId: id },
        })
      }

      const urlParams = new URLSearchParams(location.search)
      const urlStepId = urlParams.get('stepId')
      const currentStepId = targetStepId || (urlStepId && !TRIGGER_SLUGS.has(urlStepId) ? urlStepId : undefined)

      if (currentStepId) drop(currentStepId)
      if (urlStepId && urlStepId !== currentStepId && !TRIGGER_SLUGS.has(urlStepId)) drop(urlStepId)
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

      const isPreProcess =
        slugName === 'CRON_PRE_PROCESS' ||
        stepId === 'CRON_PRE_PROCESS' ||
        slugName === 'WEBHOOK_PRE_PROCESS' ||
        stepId === 'WEBHOOK_PRE_PROCESS'

      let block: Record<string, unknown>
      let stepType = 'function'
      let draft: Record<string, unknown>

      if (isPreProcess) {
        slugName = slugName || stepId || 'CRON_PRE_PROCESS'
        stepId = stepId || slugName || 'CRON_PRE_PROCESS'
        const preProcess = obj(obj(flowJson.trigger).preProcess)
        const rawType = params.get('stepType') || (typeof preProcess.type === 'string' ? preProcess.type : '') || 'function'
        stepType = rawType.toLowerCase().startsWith('func') ? 'function' : rawType
        if (stepType !== 'function') return null
        const stepEntry = obj(obj(state.stepsDataV3)[scriptId])[stepId]
        draft = obj(isObj(stepEntry) ? stepEntry.draft || stepEntry : {})
        const code =
          typeof draft.code === 'string'
            ? draft.code
            : typeof preProcess.code === 'string'
              ? preProcess.code
              : ''
        block = {
          type: 'function',
          identifier: stepId,
          code,
          subfunctions: Array.isArray(draft.subfunctions) ? draft.subfunctions : Array.isArray(preProcess.subfunctions) ? preProcess.subfunctions : [],
          dynamicVariables: isObj(draft.dynamicVariables) ? draft.dynamicVariables : isObj(preProcess.dynamicVariables) ? preProcess.dynamicVariables : undefined,
        }
      } else {
        block = obj(blocks[slugName])
        if (!stepId && typeof block.identifier === 'string') stepId = block.identifier
        if (!slugName || !stepId || TRIGGER_SLUGS.has(slugName) || block.type !== 'function') return null
        draft = obj(obj(obj(obj(state.stepsDataV3)[scriptId])[stepId]).draft)
        if (typeof draft.code !== 'string') return null
      }

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
      for (const k of Object.keys(isObj(sample.query) ? sample.query : {})) variables.push(`context.req.query.${k}`)
      for (const k of Object.keys(isObj(sample.headers) ? sample.headers : {})) variables.push(`context.req.headers.${k}`)

      if (!isPreProcess) {
        const order = Array.isArray(flowState.stepOrder) ? flowState.stepOrder.filter((k): k is string => typeof k === 'string') : []
        const here = order.indexOf(slugName)
        const earlier = here >= 0 ? order.slice(0, here) : Object.keys(blocks).filter((k) => k !== slugName)
        for (const slug of earlier) {
          const b = obj(blocks[slug])
          if (b.status === 'DELETE' || b.status === 'DRAFTED') continue
          if (b.type === 'function' || b.type === 'api' || b.type === 'plugin') variables.push(`context.res.${slug}`)
          else if (b.type === 'variable') variables.push(`context.vals.${slug}`)
        }
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
        code: typeof draft.code === 'string' ? draft.code : (block.code as string),
        subfunctions: subfunctions.filter(isObj).map((sf) => ({
          name: String(sf.name ?? ''),
          actionId: String(sf.actionId ?? ''),
          authId: String(sf.authId ?? ''),
        })),
        dynamicVariables: isObj(draft.dynamicVariables)
          ? (draft.dynamicVariables as Record<string, string>)
          : isObj(block.dynamicVariables)
            ? (block.dynamicVariables as Record<string, string>)
            : undefined,
        otherSubfunctions,
        connectedApps,
        variables,
      }
    } catch {
      return null
    }
  }

  function syncDraftToDom(): void {
    try {
      const store = findReduxStore()
      if (!store) return
      const state = store.getState()
      const scriptId =
        extractScriptId(location.pathname) ||
        (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)
      if (!scriptId) return
      const urlParams = new URLSearchParams(location.search)
      const stepId = urlParams.get('stepId')
      const slugName = urlParams.get('slugName')
      if (!stepId) {
        if (document.documentElement.hasAttribute('data-vs-draft-step')) {
          document.documentElement.removeAttribute('data-vs-draft-step')
        }
        return
      }
      const stepsData = isObj(state.stepsDataV3) ? (state.stepsDataV3 as Record<string, unknown>)[scriptId] : undefined
      const stepEntry = isObj(stepsData) ? (stepsData as Record<string, unknown>)[stepId] : undefined
      const draft = isObj(stepEntry) ? ((stepEntry as Record<string, unknown>).draft || stepEntry) : undefined
      if (!isObj(draft)) return
      const pluginData = isObj(draft.pluginData) ? draft.pluginData : undefined
      const selectedValues = isObj(pluginData?.selectedValues)
        ? pluginData.selectedValues
        : isObj(draft.selectedValues)
          ? draft.selectedValues
          : {}
      const authData = isObj(selectedValues.authData) ? selectedValues.authData : undefined
      const inputData = isObj(selectedValues.inputData) ? selectedValues.inputData : undefined

      const info = {
        scriptId,
        stepId,
        slugName: slugName || undefined,
        serviceId: typeof draft.serviceId === 'string' ? draft.serviceId : typeof pluginData?.serviceId === 'string' ? pluginData.serviceId : undefined,
        selectedCreate: typeof draft.selectedCreate === 'string' ? draft.selectedCreate : typeof pluginData?.selectedCreate === 'string' ? pluginData.selectedCreate : undefined,
        actionVersionId: typeof draft.actionVersionId === 'string' ? draft.actionVersionId : typeof pluginData?.actionVersionId === 'string' ? pluginData.actionVersionId : undefined,
        authId: typeof authData?.id === 'string' ? authData.id : undefined,
        connectionLabel: typeof authData?.connection_label === 'string' ? authData.connection_label : undefined,
        inputData,
      }
      const serialized = JSON.stringify(info)
      if (document.documentElement.getAttribute('data-vs-draft-step') !== serialized) {
        document.documentElement.setAttribute('data-vs-draft-step', serialized)
      }
    } catch {
      // never disturb the page
    }
  }

  function setFieldValue(fieldLabel: string, value: string, clickSave?: boolean): { success: boolean; error?: string } {
    try {
      const slider = document.querySelector<HTMLElement>(
        '[data-testid="step-config-slider"], [data-slider-container="true"], .custom_slider'
      )
      if (!slider) return { success: false, error: 'Side panel is not open.' }

      if (!fieldLabel && clickSave) {
        const saveBtn = Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
          /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
        )
        if (saveBtn && !saveBtn.disabled) {
          saveBtn.click()
          return { success: true }
        }
        return { success: false, error: 'Save button is disabled or not found in the open panel.' }
      }

      const allFieldRows = Array.from(
        slider.querySelectorAll<HTMLElement>(
          '[data-testid^="plugin-field-"]:not([data-testid^="plugin-field-label-"]), .plugin-field-row, [data-testid="custom-field-box"]'
        )
      )
      const norm = fieldLabel.replace(/[*:[\]"']/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

      // 1. Exact match on testId, id, or clean label
      let targetRow = allFieldRows.find((row) => {
        const testId = (row.getAttribute('data-testid') || '').toLowerCase().replace(/[*:[\]"']/g, '')
        const id = (row.id || '').toLowerCase().replace(/[*:[\]"']/g, '')
        if (testId === `plugin-field-${norm}` || id === `scroll-${norm}`) return true
        const lbl = (row.querySelector('[data-testid^="plugin-field-label-"], label')?.textContent || '')
          .replace(/[*:[\]"']/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        return lbl === norm
      })

      // 2. Prefix or suffix match on testid/id
      if (!targetRow) {
        targetRow = allFieldRows.find((row) => {
          const testId = (row.getAttribute('data-testid') || '').toLowerCase().replace(/[*:[\]"']/g, '')
          const id = (row.id || '').toLowerCase().replace(/[*:[\]"']/g, '')
          return testId.endsWith(`-${norm}`) || testId.startsWith(`plugin-field-${norm}`) || id.endsWith(`-${norm}`)
        })
      }

      // 3. Fallback: contains match on label
      if (!targetRow) {
        targetRow = allFieldRows.find((row) => {
          const lbl = (row.querySelector('[data-testid^="plugin-field-label-"], label')?.textContent || '')
            .replace(/[*:[\]"']/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          return lbl.includes(norm) || norm.includes(lbl)
        })
      }

      if (!targetRow) return { success: false, error: `Field "${fieldLabel}" was not found in the open panel.` }

      // 1. Fiber getHtmlAndValue (CustomAutoSuggest / React Mentions)
      const autosuggest = targetRow.querySelector<HTMLElement>('[data-testid*="custom-autosuggest-"], [data-testid*="mentions-input"]')
      if (autosuggest) {
        const key = Object.keys(autosuggest).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
        if (key) {
          let f = (autosuggest as unknown as Record<string, unknown>)[key] as { memoizedProps?: Record<string, unknown>; return?: unknown } | undefined
          while (f && !f.memoizedProps?.getHtmlAndValue) f = f.return as typeof f
          if (f && typeof f.memoizedProps?.getHtmlAndValue === 'function') {
            try {
              (f.memoizedProps.getHtmlAndValue as (raw: string, html: string) => void)(value, value)
            } catch {
              // fallback to native input
            }
          }
        }
      }

      // 2. Native input setter & event dispatch
      const input = targetRow.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="hidden"])')
      if (input) {
        const proto = Object.getPrototypeOf(input)
        const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (nativeSet) nativeSet.call(input, value)
        else input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        input.dispatchEvent(new Event('blur', { bubbles: true, composed: true }))
      }

      // 3. Mark hasUnsavedCode: true and clear localNotification error in Redux store
      try {
        const store = findReduxStore()
        if (store) {
          const state = store.getState()
          const scriptId =
            extractScriptId(location.pathname) ||
            (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)
          const urlParams = new URLSearchParams(location.search)
          const stepId = urlParams.get('stepId')
          if (scriptId && stepId) {
            store.dispatch({
              type: 'stepsDataV3/setKeyValueInstance',
              urlData: { sectionIdOrScriptId: scriptId, versionIdOrStepId: stepId, tabName: 'draft' },
              payload: { hasUnsavedCode: true },
            })
          }
          const notifs =
            isObj(state.notification) && isObj((state.notification as Record<string, unknown>).localNotification)
              ? ((state.notification as Record<string, unknown>).localNotification as Record<string, unknown>)
              : undefined
          if (notifs) {
            const cleanKey = fieldLabel.replace(/[*:]/g, '').trim().toLowerCase()
            for (const key of Object.keys(notifs)) {
              if (key.toLowerCase().includes(cleanKey)) {
                delete notifs[key]
              }
            }
          }
        }
      } catch {
        // ignore
      }

      if (clickSave) {
        setTimeout(() => {
          const saveBtn = Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
          )
          if (saveBtn && !saveBtn.disabled) saveBtn.click()
        }, 200)
      }

      syncDraftToDom()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
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
    if (
      inner.type === 'set-field-value' &&
      typeof inner.requestId === 'string' &&
      typeof inner.fieldLabel === 'string' &&
      typeof inner.value === 'string'
    ) {
      return {
        type: 'set-field-value',
        requestId: inner.requestId.slice(0, 64),
        fieldLabel: inner.fieldLabel,
        value: inner.value,
        clickSave: inner.clickSave === true,
        nonce: inner.nonce,
      }
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
      if (msg.type === 'set-field-value') {
        const res = setFieldValue(msg.fieldLabel, msg.value, msg.clickSave)
        post({ type: 'field-value-response', requestId: msg.requestId, success: res.success, error: res.error })
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

  // Synchronize draft step state from Redux
  let storeSubscribed = false
  function ensureStoreSubscription(): void {
    if (storeSubscribed) return
    const store = findReduxStore()
    if (store && typeof (store as unknown as Record<string, unknown>).subscribe === 'function') {
      try {
        ;(store as unknown as { subscribe: (fn: () => void) => void }).subscribe(syncDraftToDom)
        storeSubscribed = true
      } catch {
        // ignore
      }
    }
  }
  ensureStoreSubscription()
  setInterval(() => {
    ensureStoreSubscription()
    syncDraftToDom()
  }, 1000)
}

function alreadyInstalled(): boolean {
  const w = window as unknown as Record<string, unknown>
  if (w[INSTALLED]) return true
  Object.defineProperty(window, INSTALLED, { value: true, enumerable: false, configurable: false, writable: false })
  return false
}

try {
  const env = resolveEnv(location.host)
  if (env && (window.top === window || env.embed) && !alreadyInstalled()) install()
} catch {
  // never throw into the page
}
