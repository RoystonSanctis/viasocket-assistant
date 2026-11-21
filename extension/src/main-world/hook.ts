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
  type StepInputDataResult,
  type FlowGraphData,
  type FlowGraphNode,
  type FlowGraphPort,
  type FlowGraphConnection,
} from '../shared/messages'
import type { ObservedEvent } from '../shared/observed'
import { resolveEnv } from '../background/tools/env'
import {
  editorAction,
  getEditorValue,
  insertIntoEditor,
  mountMonacoViewer,
  updateMonacoViewer,
  disposeMonacoViewer,
} from './editors'
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
      const activeUrlStepId = new URLSearchParams(location.search).get('stepId')
      const currentActiveStepId =
        activeUrlStepId ||
        (isObj(state.appInfo) && typeof state.appInfo.currentStepId === 'string' && state.appInfo.currentStepId ? state.appInfo.currentStepId : undefined)

      if (
        stepRow &&
        openFlow &&
        slugName &&
        stepId &&
        stepRow.id === stepId &&
        (!stepRow.script_id || stepRow.script_id === resolvedScriptId) &&
        (!currentActiveStepId || currentActiveStepId === stepId)
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
          syncDraftToDom()
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
        syncDraftToDom()
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

      // Mappable data: the trigger's sample, live invocation data, earlier steps, and Input Values (dynamicVariables)
      const variables: string[] = []
      const invState = obj(obj(state.invocationV2)[scriptId])
      const invCtxRaw = obj(invState.context)
      const invCtx = obj(isObj(invCtxRaw.context) ? invCtxRaw.context : invCtxRaw)
      const invReq = obj(invCtx.req)
      const invRes = obj(invCtx.res)
      const sample = obj(obj(flowJson.trigger).sampleData)

      const queryData = isObj(invReq.query) && Object.keys(invReq.query).length ? invReq.query : isObj(sample.query) ? sample.query : {}
      const bodyData = isObj(invReq.body) && Object.keys(invReq.body).length ? invReq.body : isObj(sample.body) ? sample.body : sample
      const headersData = isObj(invReq.headers) && Object.keys(invReq.headers).length ? invReq.headers : isObj(sample.headers) ? sample.headers : {}
      const attachmentData = isObj(invReq.attachment) ? invReq.attachment : isObj(sample.attachment) ? sample.attachment : {}

      function collectPaths(root: unknown, prefix: string, depth = 0): void {
        if (depth > 4 || !isObj(root)) return
        for (const [k, val] of Object.entries(root)) {
          const path = `${prefix}.${k}`
          variables.push(path)
          if (isObj(val) && !Array.isArray(val)) {
            collectPaths(val, path, depth + 1)
          }
        }
      }

      collectPaths(queryData, 'context.req.query')
      collectPaths(bodyData, 'context.req.body')
      collectPaths(headersData, 'context.req.headers')

      const stepsData: Record<string, { label: string; type?: string; data: unknown }> = {}
      if (!isPreProcess) {
        const order = Array.isArray(flowState.stepOrder) ? flowState.stepOrder.filter((k): k is string => typeof k === 'string') : []
        const here = order.indexOf(slugName)
        const earlier = here >= 0 ? order.slice(0, here) : Object.keys(blocks).filter((k) => k !== slugName)
        for (const slug of earlier) {
          const b = obj(blocks[slug])
          if (b.status === 'DELETE' || b.status === 'DRAFTED') continue
          const outData = isObj(invRes[slug]) ? invRes[slug] : b.sampleData ?? {}
          stepsData[slug] = {
            label: slug,
            type: typeof b.type === 'string' ? b.type : 'function',
            data: outData,
          }
          if (b.type === 'function' || b.type === 'api' || b.type === 'plugin') {
            variables.push(`context.res.${slug}`)
            collectPaths(outData, `context.res.${slug}`)
          } else if (b.type === 'variable') {
            variables.push(`context.vals.${slug}`)
            collectPaths(outData, `context.vals.${slug}`)
          }
        }
      }

      const dynVars = isObj(draft.dynamicVariables)
        ? (draft.dynamicVariables as Record<string, string>)
        : isObj(block.dynamicVariables)
          ? (block.dynamicVariables as Record<string, string>)
          : {}

      for (const varName of Object.keys(dynVars)) {
        variables.push(varName)
      }

      const contextTree: StepContextData['contextTree'] = {
        trigger: {
          query: queryData,
          body: bodyData,
          headers: headersData,
          attachment: attachmentData,
        },
        steps: stepsData,
        variables: dynVars,
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
        dynamicVariables: Object.keys(dynVars).length ? dynVars : undefined,
        otherSubfunctions,
        connectedApps,
        variables,
        contextTree,
      }
    } catch {
      return null
    }
  }

  /**
   * Resolves the active step's input data from Redux state (invocation data, plugin used variables,
   * API stepRequestSnapshot, function used variables, or trigger incoming data).
   */
  function readStepInputData(msg: { scriptId?: string; stepId?: string; slugName?: string }): StepInputDataResult | null {
    try {
      const state = findReduxStore()?.getState()
      if (!state) return null
      const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {})
      const route = /\/workflow\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/.exec(location.pathname)
      const scriptId =
        msg.scriptId ||
        (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : '') ||
        route?.[1] ||
        Object.keys(obj(state.flowJsonV2))[0] ||
        Object.keys(obj(state.invocationV2))[0] ||
        ''
      if (!scriptId) return null

      const flowState = obj(obj(state.flowJsonV2)[scriptId])
      const flowJson = obj(flowState.flowJson)
      const blocks = obj(flowJson.blocks)
      const params = new URLSearchParams(location.search)

      let slugName =
        msg.slugName ||
        params.get('slugName') ||
        (isObj(state.appInfo) && typeof state.appInfo.currentSlugName === 'string' ? state.appInfo.currentSlugName : '')
      let stepId =
        msg.stepId ||
        params.get('stepId') ||
        (isObj(state.appInfo) && typeof state.appInfo.currentStepId === 'string' ? state.appInfo.currentStepId : '')

      if (!slugName && stepId) {
        slugName = Object.keys(blocks).find((k) => obj(blocks[k]).identifier === stepId || obj(blocks[k]).id === stepId) ?? stepId
      }
      if (!stepId && slugName) {
        const found = obj(blocks[slugName])
        stepId = String(found.identifier || found.id || slugName)
      }

      // If still empty, check current step in stepsDataV3
      if (!stepId && !slugName) {
        const stepsMap = obj(obj(state.stepsDataV3)[scriptId])
        const firstStepId = Object.keys(stepsMap)[0]
        if (firstStepId) {
          stepId = firstStepId
          slugName = Object.keys(blocks).find((k) => obj(blocks[k]).identifier === stepId) ?? stepId
        }
      }

      // Locate invocation data
      const invState = obj(obj(state.invocationV2)[scriptId])
      let invData = obj(invState.invocationData)
      if (!Object.keys(invData).length) {
        invData = obj(obj(obj(state.invocationV2)['selectedLog']).invocationData)
      }
      if (!Object.keys(invData).length) {
        for (const v of Object.values(obj(state.invocationV2))) {
          const cand = obj(obj(v).invocationData)
          if (Object.keys(cand).length > 0) {
            invData = cand
            break
          }
        }
      }

      const flowHitId = String(invData.flowHitId || params.get('flowhitid') || '')
      const timestamp = typeof invData.requestTimestamp === 'string' ? invData.requestTimestamp : undefined

      const tryParse = (val: unknown): unknown => {
        if (typeof val === 'string') {
          try {
            return JSON.parse(val)
          } catch {
            return val
          }
        }
        return val ?? {}
      }

      const requestSnapshot = obj(tryParse(invData.requestSnapshotJsonData || invData.requestSnapshot))
      const responseSnapshot = obj(tryParse(invData.responseSnapshotJsonData || invData.responseSnapshot))
      const vals = obj(tryParse(invData.valsJson || invData.vals))
      const stepRequestSnapshot = obj(tryParse(invData.stepRequestSnapshot))

      const context: Record<string, unknown> = {
        req: requestSnapshot,
        res: responseSnapshot,
        vals,
      }

      const block = obj(blocks[slugName])
      const stepTitle =
        typeof block.name === 'string'
          ? block.name
          : typeof block.title === 'string'
            ? block.title
            : slugName

      const isTrigger = slugName === 'trigger' || TRIGGER_SLUGS.has(slugName) || stepId === 'trigger' || slugName === 'SET_TRIGGER'

      let stepType = isTrigger ? 'trigger' : typeof block.type === 'string' ? block.type : 'plugin'
      if (slugName === 'CRON_PRE_PROCESS' || slugName === 'WEBHOOK_PRE_PROCESS') {
        stepType = 'trigger'
      }

      let inputData: unknown = undefined
      let source: StepInputDataResult['source'] = 'none'

      // Helper for template evaluation and unflattening
      function unflattenAndEval(flatObj: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {}
        for (const [rawKey, rawVal] of Object.entries(flatObj)) {
          if (
            rawKey.includes('-Type') ||
            rawKey.includes('["_') ||
            rawKey.includes("['_") ||
            rawKey.startsWith('_') ||
            rawKey.endsWith('-Type')
          ) continue
          let val = rawVal
          if (typeof val === 'string') {
            const trimmed = val.trim()
            if (/^-?\d+$/.test(trimmed)) {
              val = Number(trimmed)
            } else {
              const singleExpr = trimmed.match(/^\$\{([^}]+)\}$/)
              if (singleExpr) {
                try {
                  const fn = new Function('context', 'req', 'res', 'vals', `try { return (${singleExpr[1]}); } catch(e) { return undefined; }`)
                  const evaled = fn(context, requestSnapshot, responseSnapshot, vals)
                  if (evaled !== undefined) val = evaled
                } catch {
                  // keep string
                }
              } else if (val.includes('${')) {
                val = val.replace(/\$\{([^}]+)\}/g, (_, expr) => {
                  try {
                    const fn = new Function('context', 'req', 'res', 'vals', `try { return (${expr}); } catch(e) { return undefined; }`)
                    const evaled = fn(context, requestSnapshot, responseSnapshot, vals)
                    return evaled !== undefined ? (typeof evaled === 'object' ? JSON.stringify(evaled) : String(evaled)) : `\${${expr}}`
                  } catch {
                    return `\${${expr}}`
                  }
                })
              }
            }
          }

          // Unflatten path like "paging[page_size]" or "paging.page_size"
          const tokens = rawKey.replace(/\[(["']?)(.*?)\1\]/g, '.$2').split('.').filter(Boolean)
          if (tokens.length > 1) {
            let curr: any = out
            for (let i = 0; i < tokens.length - 1; i++) {
              const t = tokens[i]!
              const nextT = tokens[i + 1] ?? ''
              const isArr = /^\d+$/.test(nextT)
              if (!curr[t] || typeof curr[t] !== 'object') {
                curr[t] = isArr ? [] : {}
              }
              curr = curr[t]
            }
            const lastToken = tokens[tokens.length - 1]!
            curr[lastToken] = val
          } else if (tokens.length === 1 && tokens[0]) {
            out[tokens[0]] = val
          } else {
            out[rawKey] = val
          }
        }
        return out
      }

      if (isTrigger) {
        source = 'trigger'
        inputData = isObj(requestSnapshot.body) && Object.keys(requestSnapshot.body).length > 0 ? requestSnapshot.body : requestSnapshot
      } else if (stepType === 'api') {
        source = 'api'
        inputData = stepRequestSnapshot[slugName] ?? stepRequestSnapshot[stepId]
      } else if (stepType === 'function' || stepType === 'js') {
        source = 'function'

        // Retrieve function step definitions from Redux
        const stepEntry = obj(obj(state.stepsDataV3)[scriptId])[stepId] ?? obj(obj(state.stepsDataV3)[scriptId])[slugName]
        const draft = obj(isObj(stepEntry) ? stepEntry.draft || stepEntry.publish || stepEntry : {})
        const block = obj(blocks[slugName] ?? blocks[stepId])

        const dynamicVars = {
          ...obj(block.dynamicVariables),
          ...obj(draft.dynamicVariables),
        }

        const codeStr =
          (typeof draft.code === 'string' && draft.code) ||
          (typeof block.code === 'string' && block.code) ||
          ''

        const usedVarsFromRedux: string[] = [
          ...(Array.isArray(draft.usedVariables) ? draft.usedVariables : []),
          ...(Array.isArray(block.usedVariables) ? block.usedVariables : []),
        ]

        const invUsedVars = obj(invData.usedVariables)
        const fnUsed = obj(invUsedVars.functions)
        const fnVars = fnUsed[slugName] ?? fnUsed[stepId]
        if (Array.isArray(fnVars)) {
          usedVarsFromRedux.push(...fnVars)
        }

        function evalExpr(expr: string): unknown {
          if (!expr || typeof expr !== 'string') return expr
          let clean = expr.trim()
          if (clean.startsWith('${') && clean.endsWith('}')) {
            clean = clean.slice(2, -1).trim()
          }
          if (!clean) return undefined
          try {
            const fn = new Function(
              'context',
              'req',
              'res',
              'vals',
              'body',
              'steps',
              `try { return (${clean}); } catch(e) { return undefined; }`
            )
            return fn(
              context,
              requestSnapshot,
              responseSnapshot,
              vals,
              requestSnapshot.body ?? {},
              responseSnapshot
            )
          } catch {
            return undefined
          }
        }

        function normalizePath(str: string): string {
          if (!str || typeof str !== 'string') return ''
          let p = str.trim()
          if (p.startsWith('${') && p.endsWith('}')) {
            p = p.slice(2, -1).trim()
          }
          return p
            .replace(/\?\.\[/g, '[')
            .replace(/\?\./g, '.')
            .replace(/context\.req\.body/g, 'body')
            .replace(/req\.body/g, 'body')
            .replace(/context\.res/g, 'steps')
            .replace(/res\b/g, 'steps')
            .replace(/context\.vals/g, 'vals')
            .replace(/\[(["']?)(.*?)\1\]/g, '.$2')
            .replace(/\.{2,}/g, '.')
            .replace(/^\.+/, '')
            .trim()
        }

        function extractDirectPathsFromCode(str: string): string[] {
          if (!str || typeof str !== 'string') return []
          const results = new Set<string>()
          const regex = /\b(context|req|res|body|steps)\b/g
          const matches = Array.from(str.matchAll(regex))

          for (const match of matches) {
            const iStart = match.index
            if (iStart === undefined) continue
            if (iStart > 0 && /[\w.$]/.test(str[iStart - 1]!)) continue

            let depth = 0
            let variable = ''

            for (let i = iStart; i < str.length; i++) {
              const ch = str[i]!
              variable += ch

              if (ch === '[') depth++
              else if (ch === ']') depth--

              if (depth === 0) {
                const next = str[i + 1] || ''
                if (/[\s+\-*/%,;)}"'`]/.test(next)) break
                const funcCallMatch = /^\.\w+\s*\(/.exec(str.slice(i + 1))
                if (funcCallMatch) break
              }
            }

            variable = variable
              .replace(/\?\.(?=[a-zA-Z_$])/g, '.')
              .replace(/\?\.\[/g, '[')
              .replace(/(\?\.)+$/, '')
              .replace(/\?$/, '')
              .trim()

            if (variable.includes('.') || variable.includes('[')) {
              results.add(variable)
            }
          }
          return Array.from(results)
        }

        const resolvedVars: Record<string, unknown> = {}
        const coveredNormPaths = new Set<string>()

        // 1. Process all input variables (dynamicVariables)
        for (const [varName, varExpr] of Object.entries(dynamicVars)) {
          if (typeof varExpr === 'string') {
            coveredNormPaths.add(normalizePath(varExpr))
            const val = evalExpr(varExpr)
            resolvedVars[varName] = val !== undefined ? val : null
          } else {
            resolvedVars[varName] = varExpr
          }
        }

        // 2. Process all direct paths in code and usedVariables
        const codeDirectPaths = extractDirectPathsFromCode(codeStr)
        const allDirectPaths = Array.from(new Set([...usedVarsFromRedux, ...codeDirectPaths]))

        for (const p of allDirectPaths) {
          if (typeof p !== 'string') continue
          const norm = normalizePath(p)
          if (coveredNormPaths.has(norm)) continue

          const val = evalExpr(p)
          if (val !== undefined) {
            resolvedVars[p] = val
            coveredNormPaths.add(norm)
          }
        }

        if (Object.keys(resolvedVars).length > 0) {
          inputData = resolvedVars
        } else {
          inputData = stepRequestSnapshot[slugName] ?? stepRequestSnapshot[stepId]
        }
      } else {
        // Plugin / Action step
        source = 'plugin'
        // 1. Check stepRequestSnapshot
        const reqSnap = stepRequestSnapshot[slugName] ?? stepRequestSnapshot[stepId]
        if (isObj(reqSnap) && Object.keys(reqSnap).length > 0) {
          inputData = reqSnap
        } else {
          // 2. Check plugin used variables in flowJson
          const isDryRun = Boolean(invData.isDryRun)
          const flowUsed = isDryRun ? obj(flowState.usedVariables) : obj(flowState.publishUsedVariables)
          const pluginVars =
            obj(flowUsed.plugin)[slugName] ??
            obj(flowUsed.plugin)[stepId] ??
            obj(obj(flowState.usedVariables).plugin)[slugName] ??
            obj(obj(flowState.usedVariables).plugin)[stepId] ??
            obj(obj(flowState.publishUsedVariables).plugin)[slugName] ??
            obj(obj(flowState.publishUsedVariables).plugin)[stepId] ??
            {}
          if (isObj(pluginVars) && Object.keys(pluginVars).length > 0) {
            inputData = unflattenAndEval(pluginVars as Record<string, unknown>)
          } else if (isObj(invData.inputData) && ((invData.inputData as any)[slugName] || (invData.inputData as any)[stepId])) {
            inputData = (invData.inputData as any)[slugName] ?? (invData.inputData as any)[stepId]
          } else {
            // 3. Check stepsDataV3 draft inputs
            const stepEntry = obj(obj(state.stepsDataV3)[scriptId])[stepId] ?? obj(obj(state.stepsDataV3)[scriptId])[slugName]
            const draft = obj(isObj(stepEntry) ? stepEntry.draft || stepEntry : {})
            const pluginData = obj(draft.pluginData)
            const selVals = obj(isObj(pluginData.selectedValues) ? pluginData.selectedValues : draft.selectedValues)
            const draftInputs = obj(selVals.inputData)
            if (Object.keys(draftInputs).length > 0) {
              inputData = unflattenAndEval(draftInputs)
              source = 'draft'
            }
          }
        }
      }

      const hasInputData =
        inputData !== undefined &&
        inputData !== null &&
        (typeof inputData !== 'object' || Object.keys(inputData as object).length > 0)

      return {
        scriptId,
        stepId,
        slugName,
        stepTitle,
        stepType,
        inputData: inputData ?? null,
        hasInputData,
        source: hasInputData ? source : 'none',
        flowHitId: flowHitId || undefined,
        timestamp,
      }
    } catch {
      return null
    }
  }

  function readFlowGraphData(msg: { scriptId?: string }): FlowGraphData | null {
    try {
      const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? (v as Record<string, unknown>) : {})
      const store = findReduxStore()
      if (!store) return null
      const state = store.getState()
      const scriptId =
        msg.scriptId ||
        extractScriptId(location.pathname) ||
        (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)
      if (!scriptId) return null

      const flowState = obj(obj(state.flowJsonV2)[scriptId])
      const flowJson = obj(flowState.flowJson)
      const blocks = obj(flowJson.blocks)
      const trigger = obj(flowJson.trigger)
      const rawStepOrder = Array.isArray(flowState.stepOrder)
        ? (flowState.stepOrder as string[])
        : Array.isArray(obj(flowJson.order).root)
          ? (obj(flowJson.order).root as string[])
          : Object.keys(blocks)
      const stepOrder = rawStepOrder.filter((s) => s && s !== 'response')

      const invState = obj(obj(state.invocationV2)[scriptId])
      let invData = obj(invState.invocationData)
      if (!Object.keys(invData).length) {
        invData = obj(obj(obj(state.invocationV2)['selectedLog']).invocationData)
      }
      if (!Object.keys(invData).length) {
        for (const v of Object.values(obj(state.invocationV2))) {
          const cand = obj(obj(v).invocationData)
          if (Object.keys(cand).length > 0) {
            invData = cand
            break
          }
        }
      }
      const flowHitId = typeof invData.flowHitId === 'string' ? invData.flowHitId : new URLSearchParams(location.search).get('flowhitid') || undefined
      const timestamp = typeof invData.requestTimestamp === 'string' ? invData.requestTimestamp : undefined

      const requestSnapshot = isObj(invData.requestSnapshot)
        ? (invData.requestSnapshot as Record<string, unknown>)
        : isObj(invData.requestSnapshotJsonData)
          ? (invData.requestSnapshotJsonData as Record<string, unknown>)
          : {}
      const responseSnapshot = isObj(invData.responseSnapshot)
        ? (invData.responseSnapshot as Record<string, unknown>)
        : isObj(invData.responseSnapshotJsonData)
          ? (invData.responseSnapshotJsonData as Record<string, unknown>)
          : {}
      const vals = isObj(invData.vals)
        ? (invData.vals as Record<string, unknown>)
        : isObj(invData.valsJson)
          ? (invData.valsJson as Record<string, unknown>)
          : {}

      const isDryRun = Boolean(invData.isDryRun)
      let usedVars = isDryRun ? obj(flowState.usedVariables) : obj(flowState.publishUsedVariables)
      if (!usedVars || Object.keys(usedVars).length === 0) {
        usedVars = obj(flowState.usedVariables)
      }

      const tryParse = (val: unknown): unknown => {
        if (typeof val === 'string') {
          try {
            return JSON.parse(val)
          } catch {
            return val
          }
        }
        return val
      }

      const stepRequestSnapshot = obj(tryParse(invData.stepRequestSnapshot))
      const rawInputData = obj(tryParse(invData.inputData))

      function evalExpr(expr: string): unknown {
        if (!expr || typeof expr !== 'string') return undefined
        let clean = expr.trim()
        if (clean.startsWith('${') && clean.endsWith('}')) {
          clean = clean.slice(2, -1).trim()
        }
        if (!clean) return undefined
        try {
          const fn = new Function(
            'context',
            'req',
            'res',
            'vals',
            'body',
            'steps',
            `try { return (${clean}); } catch(e) { return undefined; }`
          )
          return fn(
            { req: requestSnapshot, res: responseSnapshot, vals, steps: responseSnapshot },
            requestSnapshot,
            responseSnapshot,
            vals,
            requestSnapshot.body ?? {},
            responseSnapshot
          )
        } catch {
          return undefined
        }
      }

      function formatVal(v: unknown): string {
        if (v === undefined) return 'undefined'
        if (v === null) return 'null'
        if (typeof v === 'string') return v.length > 24 ? v.slice(0, 21) + '...' : v
        if (typeof v === 'number' || typeof v === 'boolean') return String(v)
        if (Array.isArray(v)) return `[${v.length} items]`
        if (typeof v === 'object') {
          const keys = Object.keys(v as object)
          return `{${keys.slice(0, 2).join(', ')}${keys.length > 2 ? '...' : ''}}`
        }
        return String(v)
      }

      // 1. Build Trigger Node
      const triggerOutputs: FlowGraphPort[] = []
      const triggerFields = new Set<string>()

      const variablesMap = obj(usedVars.variables)
      for (const varKey of Object.keys(variablesMap)) {
        if (varKey.includes('req.body') || varKey.includes('req.')) {
          const field = varKey
            .replace(/context\.req\.body\b/g, '')
            .replace(/req\.body\b/g, '')
            .replace(/context\.req\b/g, '')
            .replace(/\[["'](.*?)["']\]/g, '$1')
            .replace(/^\.+/, '')
          if (field) triggerFields.add(field)
        }
      }

      const reqBody = obj(requestSnapshot.body)
      for (const k of Object.keys(reqBody)) {
        if (triggerFields.has(k) || triggerFields.size < 6) {
          triggerFields.add(k)
        }
      }

      for (const f of triggerFields) {
        const val = reqBody[f] ?? evalExpr(`context.req.body.${f}`)
        const usedBy =
          (obj(variablesMap[`context.req.body.${f}`]).usedInFunctions as string[]) ||
          (obj(variablesMap[`context.req.body["${f}"]`]).usedInFunctions as string[]) ||
          []
        if (usedBy.length === 0 && (val === '' || val === null || val === undefined)) {
          continue
        }
        triggerOutputs.push({
          id: `trigger-out-${f}`,
          key: f,
          value: val,
          displayValue: formatVal(val),
          usedBySlugs: usedBy,
        })
      }

      const triggerType = typeof trigger.triggerType === 'string' ? trigger.triggerType : 'webhook'
      const triggerNode: FlowGraphNode = {
        id: 'trigger',
        slugName: 'trigger',
        title: triggerType === 'webhook' ? 'Webhook' : triggerType.toUpperCase(),
        type: 'trigger',
        depth: 0,
        isIndependent: false,
        upstreamSlugs: [],
        inputs: [],
        outputs: triggerOutputs,
      }

      // 2. Build Step Nodes
      const stepNodes: FlowGraphNode[] = []
      const connections: FlowGraphConnection[] = []
      const funcsMap = obj(usedVars.functions)
      const pluginMap = obj(usedVars.plugin)

      for (const slug of stepOrder) {
        const block = obj(blocks[slug])
        const stepType = typeof block.type === 'string' ? block.type : 'function'
        const iconUrl = typeof block.iconUrl === 'string' ? block.iconUrl : undefined
        const inputs: FlowGraphPort[] = []
        const upstreamSlugsSet = new Set<string>()
        const seenInputKeys = new Set<string>()

        const stepId = typeof block.id === 'string' ? block.id : ''
        const stepEntry = obj(obj(state.stepsDataV3)[scriptId])[stepId] ?? obj(obj(state.stepsDataV3)[scriptId])[slug]
        const draft = obj(isObj(stepEntry) ? stepEntry.draft || stepEntry : {})
        const pluginData = obj(draft.pluginData)
        const selVals = obj(isObj(pluginData.selectedValues) ? pluginData.selectedValues : draft.selectedValues)
        const draftInputs = obj(selVals.inputData)

        const rawInputsMap = new Map<string, { value: unknown; expr?: string }>()

        const registerInput = (k: string, v: unknown) => {
          if (!k || typeof k !== 'string') return
          if (k.startsWith('_') || k.endsWith('-Type') || k.endsWith('_Type')) return
          if (v === undefined || v === null || v === '' || typeof v === 'function') return
          const normalizedKey = k
            .replace(/\[["']_?(.*?)["']\]/g, '.$1')
            .replace(/\._/g, '.')
            .replace(/^\.+/, '')
          if (!normalizedKey) return

          if (
            typeof v === 'string' &&
            (v.includes('${') ||
              v.startsWith('context.req') ||
              v.startsWith('context.res') ||
              v.startsWith('req.') ||
              v.startsWith('res.') ||
              v.startsWith('steps.'))
          ) {
            rawInputsMap.set(normalizedKey, { value: undefined, expr: v })
          } else {
            rawInputsMap.set(normalizedKey, { value: v })
          }
        }

        // 1. Invocation snapshots (lowest priority fallback)
        const reqSnap = obj(tryParse(stepRequestSnapshot[slug] ?? (stepId ? stepRequestSnapshot[stepId] : undefined)))
        for (const [k, v] of Object.entries(reqSnap)) registerInput(k, v)

        const rawInput = obj(tryParse(rawInputData[slug] ?? (stepId ? rawInputData[stepId] : undefined)))
        for (const [k, v] of Object.entries(rawInput)) registerInput(k, v)

        // 2. Used variables / functions
        if (stepType === 'function') {
          const codeStr = typeof draft.code === 'string' ? draft.code : (typeof block.data === 'string' ? block.data : '')
          const list = Array.isArray(funcsMap[slug]) ? (funcsMap[slug] as string[]) : []
          if (codeStr) {
            for (const item of list) {
              if (typeof item === 'string') {
                const propName = item.split('.').pop()?.replace(/[[\]"']/g, '') || ''
                if (codeStr.includes(item) || (propName && codeStr.includes(propName))) {
                  registerInput(item, item)
                }
              }
            }
            const matches = codeStr.matchAll(/context(?:\.|\?\.)(?:req(?:(?:\.|\?\.)body)?|res(?:\.|\?\.)[a-zA-Z0-9_-]+|steps(?:\.|\?\.)[a-zA-Z0-9_-]+)(?:(?:\.|\?\.)[a-zA-Z0-9_$-]+|\[["'][a-zA-Z0-9_$-]+["']\])*/g)
            for (const m of matches) {
              const cleaned = m[0].replace(/\?\./g, '.')
              registerInput(cleaned, cleaned)
            }
          } else {
            for (const item of list) {
              if (typeof item === 'string') {
                registerInput(item, item)
              }
            }
          }
        } else if (stepType === 'plugin') {
          const pVars = obj(pluginMap[slug])
          for (const [k, v] of Object.entries(pVars)) {
            registerInput(k, v)
          }
        }

        // 3. Saved block configuration in flowJson.blocks
        const blockSelVals = obj(block.selectedValues)
        const blockInputs = obj(blockSelVals.inputData || block.data)
        if (isObj(blockInputs)) {
          for (const [k, v] of Object.entries(blockInputs)) {
            registerInput(k, v)
          }
        }

        // 4. Active / draft inputs in stepsDataV3 (highest priority - user's direct edits & saves)
        const parsedDraftCode = typeof draft.code === 'string' ? obj(tryParse(draft.code)) : obj(draft.code)
        const draftCodeInputs = obj(obj(parsedDraftCode.selectedValues).inputData)
        for (const [k, v] of Object.entries(draftCodeInputs)) {
          registerInput(k, v)
        }
        for (const [k, v] of Object.entries(draftInputs)) {
          registerInput(k, v)
        }

        // Convert rawInputsMap to FlowGraphPort[] inputs & connections
        for (const [key, inputInfo] of rawInputsMap.entries()) {
          const portId = `in-${slug}-${key}`
          if (inputInfo.expr) {
            const expr = inputInfo.expr
            const val = evalExpr(expr)
            let sourceSlug: string | undefined = undefined
            let sourceField: string | undefined = undefined

            if (expr.includes('req.body') || expr.includes('req.')) {
              sourceSlug = 'trigger'
              sourceField = expr
                .replace(/context\.req\.body\b/g, '')
                .replace(/req\.body\b/g, '')
                .replace(/context\.req\b/g, '')
                .replace(/\[["'](.*?)["']\]/g, '$1')
                .replace(/^\.+/, '')
            } else if (expr.includes('res.') || expr.includes('steps.')) {
              const m = /(?:res|steps)\.([a-zA-Z0-9_-]+)\??\.(.+)/.exec(expr)
              if (m) {
                sourceSlug = m[1]
                sourceField = m[2]?.replace(/[}].*$/, '')?.replace(/\?.*$/, '')
              }
            }

            if (sourceSlug && sourceSlug !== slug) {
              upstreamSlugsSet.add(sourceSlug)
            }

            inputs.push({
              id: portId,
              key,
              expression: expr,
              sourceSlug,
              sourceField,
              value: val,
              displayValue: formatVal(val),
            })

            if (sourceSlug && sourceField) {
              connections.push({
                id: `conn-${sourceSlug}-${sourceField}-${slug}-${key}`,
                fromNodeId: sourceSlug,
                fromSlug: sourceSlug,
                fromPortId: sourceSlug === 'trigger' ? `trigger-out-${sourceField}` : `out-${sourceSlug}-${sourceField}`,
                fromField: sourceField,
                toNodeId: slug,
                toSlug: slug,
                toPortId: portId,
                toField: key,
                expression: expr,
                valuePreview: formatVal(val),
              })
            }
          } else {
            inputs.push({
              id: portId,
              key,
              value: inputInfo.value,
              displayValue: formatVal(inputInfo.value),
            })
          }
        }

        // Collect outputs from responseSnapshot
        const outputs: FlowGraphPort[] = []
        const stepResp = responseSnapshot[slug]
        if (isObj(stepResp)) {
          for (const [k, v] of Object.entries(stepResp as Record<string, unknown>)) {
            const usedBy = (obj(variablesMap[`context.res.${slug}.${k}`]).usedInFunctions as string[]) || []
            outputs.push({
              id: `out-${slug}-${k}`,
              key: k,
              value: v,
              displayValue: formatVal(v),
              usedBySlugs: usedBy,
            })
          }
        } else if (stepResp !== undefined) {
          outputs.push({
            id: `out-${slug}-output`,
            key: 'output',
            value: stepResp,
            displayValue: formatVal(stepResp),
            usedBySlugs: [],
          })
        }

        const stepTitle =
          (typeof block.name === 'string' && block.name) ||
          (typeof block.title === 'string' && block.title) ||
          (typeof draft.title === 'string' && draft.title) ||
          slug.replace(/_/g, ' ')
        const upstreamSlugs = Array.from(upstreamSlugsSet)
        stepNodes.push({
          id: slug,
          slugName: slug,
          title: stepTitle,
          type: stepType,
          iconUrl,
          depth: 1,
          isIndependent: upstreamSlugs.length === 0,
          upstreamSlugs,
          inputs,
          outputs,
        })
      }

      // Ensure any missing ports referenced in connections exist on upstream nodes
      for (const conn of connections) {
        const sourceNode = conn.fromSlug === 'trigger' ? triggerNode : stepNodes.find((s) => s.slugName === conn.fromSlug)
        if (sourceNode && !sourceNode.outputs.some((p) => p.key === conn.fromField)) {
          const val = evalExpr(conn.expression)
          sourceNode.outputs.push({
            id: conn.fromPortId,
            key: conn.fromField,
            value: val,
            displayValue: formatVal(val),
            usedBySlugs: [conn.toSlug],
          })
        }
      }

      // Compute topological depths
      const depthMap: Record<string, number> = { trigger: 0 }
      let changed = true
      let iterations = 0
      while (changed && iterations < 15) {
        changed = false
        iterations++
        for (const node of stepNodes) {
          if (node.upstreamSlugs.length === 0) {
            if (depthMap[node.slugName] !== 0) {
              depthMap[node.slugName] = 0
              changed = true
            }
          } else {
            const maxUpstream = Math.max(...node.upstreamSlugs.map((u) => depthMap[u] ?? 0))
            const newDepth = maxUpstream + 1
            if (depthMap[node.slugName] !== newDepth) {
              depthMap[node.slugName] = newDepth
              changed = true
            }
          }
        }
      }

      for (const node of stepNodes) {
        node.depth = depthMap[node.slugName] ?? 1
      }

      const summary = {
        totalSteps: stepNodes.length,
        dependentSteps: stepNodes.filter((s) => !s.isIndependent).length,
        independentSteps: stepNodes.filter((s) => s.isIndependent).length,
      }

      return {
        scriptId,
        flowHitId,
        timestamp,
        trigger: triggerNode,
        steps: stepNodes,
        connections,
        summary,
      }
    } catch {
      return null
    }
  }

  function computeFlowSignature(state: Record<string, unknown>, scriptId: string): string {
    const asObj = (v: unknown): Record<string, unknown> => (isObj(v) ? (v as Record<string, unknown>) : {})
    const flowState = asObj(asObj(state.flowJsonV2)[scriptId])
    const flowJson = asObj(flowState.flowJson)
    const blocks = asObj(flowJson.blocks)
    const rawStepOrder = Array.isArray(flowState.stepOrder)
      ? (flowState.stepOrder as string[])
      : Array.isArray(asObj(flowJson.order).root)
        ? (asObj(flowJson.order).root as string[])
        : Object.keys(blocks)

    const usedVars = asObj(flowState.usedVariables)
    const funcs = JSON.stringify(usedVars.functions || '')
    const plugins = JSON.stringify(usedVars.plugin || '')

    const stepsData = asObj(asObj(state.stepsDataV3)[scriptId])
    const stepDrafts: string[] = []
    for (const [sId, entry] of Object.entries(stepsData)) {
      if (!isObj(entry)) continue
      const e = entry as Record<string, unknown>
      const draft = asObj(e.draft || e)
      const pData = asObj(draft.pluginData)
      const sel = asObj(pData.selectedValues || draft.selectedValues)
      const inData = asObj(sel.inputData)
      const code = typeof draft.code === 'string' ? draft.code : ''
      const title = typeof draft.title === 'string' ? draft.title : ''
      stepDrafts.push(`${sId}:${title}:${code}:${JSON.stringify(inData)}`)
    }

    const blockInputs: string[] = []
    for (const [bKey, bVal] of Object.entries(blocks)) {
      if (!isObj(bVal)) continue
      const b = bVal as Record<string, unknown>
      const bSel = asObj(b.selectedValues)
      blockInputs.push(`${bKey}:${b.name || b.title || ''}:${JSON.stringify(bSel.inputData || b.data || '')}`)
    }

    return `${rawStepOrder.join(',')}|${Object.keys(blocks).sort().join(',')}|${funcs}|${plugins}|${stepDrafts.sort().join(';')}|${blockInputs.sort().join(';')}`
  }

  let lastFlowSignature = ''
  function checkFlowChange(): void {
    try {
      const store = findReduxStore()
      if (!store) return
      const state = store.getState()
      const scriptId =
        extractScriptId(location.pathname) ||
        (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)
      if (!scriptId) return

      const sig = computeFlowSignature(state, scriptId)
      if (lastFlowSignature && sig !== lastFlowSignature) {
        lastFlowSignature = sig
        post({ type: 'flow-graph-changed' })
      } else if (!lastFlowSignature) {
        lastFlowSignature = sig
      }
    } catch {
      // ignore
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
      const stepId =
        urlParams.get('stepId') ||
        (isObj(state.appInfo) && typeof state.appInfo.currentStepId === 'string' && state.appInfo.currentStepId ? state.appInfo.currentStepId : undefined)
      const slugName =
        urlParams.get('slugName') ||
        (isObj(state.appInfo) && typeof state.appInfo.currentSlugName === 'string' && state.appInfo.currentSlugName ? state.appInfo.currentSlugName : undefined)
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
        selectedValues,
      }
      const serialized = JSON.stringify(info)
      if (document.documentElement.getAttribute('data-vs-draft-step') !== serialized) {
        document.documentElement.setAttribute('data-vs-draft-step', serialized)
      }

      // Sync trigger variables to DOM for Get Data mapping UI
      try {
        const flowState = isObj(state.flowJsonV2) ? (state.flowJsonV2 as Record<string, unknown>)[scriptId] : undefined
        const flowJson = isObj(flowState) ? (flowState as Record<string, unknown>).flowJson : undefined
        const trigger = isObj(flowJson) ? (flowJson as Record<string, unknown>).trigger : undefined
        const sample = isObj(trigger) ? (trigger as Record<string, unknown>).sampleData : undefined
        const invocation = isObj(state.invocationV2) ? (state.invocationV2 as Record<string, unknown>)[scriptId] : undefined
        const req = isObj(invocation)
          ? ((invocation as Record<string, unknown>).context as Record<string, unknown>)?.req ||
            ((invocation as Record<string, unknown>).invocationData as Record<string, unknown>)?.requestSnapshot
          : undefined

        const vars: Array<{ path: string; label: string; value?: string; group: string }> = []
        const seen = new Set<string>()
        const addVar = (path: string, label: string, val: unknown, group: string) => {
          if (seen.has(path)) return
          seen.add(path)
          let displayVal: string | undefined
          if (val !== undefined && val !== null) {
            displayVal = typeof val === 'object' ? (Array.isArray(val) ? `[${val.length}]` : '{...}') : String(val)
          }
          vars.push({ path, label, value: displayVal, group })
        }

        const crawl = (objData: unknown, prefix: string, group: string, depth = 0) => {
          if (!isObj(objData) || depth > 2) return
          for (const [k, v] of Object.entries(objData as Record<string, unknown>)) {
            const p = `${prefix}.${k}`
            if (isObj(v) && !Array.isArray(v) && Object.keys(v).length > 0) {
              crawl(v, p, group, depth + 1)
            } else {
              addVar(p, k, v, group)
            }
          }
        }

        const q =
          isObj(req) && isObj((req as Record<string, unknown>).query)
            ? (req as Record<string, unknown>).query
            : isObj(sample)
              ? (sample as Record<string, unknown>).query
              : undefined
        crawl(q, 'context.req.query', 'query')

        const b =
          isObj(req) && isObj((req as Record<string, unknown>).body)
            ? (req as Record<string, unknown>).body
            : isObj(sample) && isObj((sample as Record<string, unknown>).body)
              ? (sample as Record<string, unknown>).body
              : isObj(sample) && !q
                ? sample
                : undefined
        crawl(b, 'context.req.body', 'body')

        const h =
          isObj(req) && isObj((req as Record<string, unknown>).headers)
            ? (req as Record<string, unknown>).headers
            : isObj(sample)
              ? (sample as Record<string, unknown>).headers
              : undefined
        crawl(h, 'context.req.headers', 'headers')

        const p =
          isObj(req) && isObj((req as Record<string, unknown>).params)
            ? (req as Record<string, unknown>).params
            : isObj(sample)
              ? (sample as Record<string, unknown>).params
              : undefined
        crawl(p, 'context.req.params', 'params')

        if (vars.length === 0) {
          addVar('context.req.query', 'query', undefined, 'query')
          addVar('context.req.body', 'body', undefined, 'body')
          addVar('context.req.headers', 'headers', undefined, 'headers')
        }

        const trigPayload = {
          type:
            isObj(trigger) && typeof (trigger as Record<string, unknown>).type === 'string'
              ? (trigger as Record<string, unknown>).type
              : 'webhook',
          title:
            isObj(trigger) && typeof (trigger as Record<string, unknown>).title === 'string'
              ? (trigger as Record<string, unknown>).title
              : 'Trigger',
          vars,
        }
        const trigSerialized = JSON.stringify(trigPayload)
        if (document.documentElement.getAttribute('data-vs-trigger-vars') !== trigSerialized) {
          document.documentElement.setAttribute('data-vs-trigger-vars', trigSerialized)
        }

        // Full hierarchical tree for the viaSocket flyout hover menu
        const trigTree = {
          triggerType: trigPayload.type,
          title: 'Trigger',
          iconUrl:
            isObj(trigger) && typeof (trigger as Record<string, unknown>).iconUrl === 'string'
              ? (trigger as Record<string, unknown>).iconUrl
              : 'https://stuff.thingsofbrand.com/viasocket.com/images/imge_Webhook-bg.svg',
          data: {
            query: q || {},
            body: b || {},
            headers: h || {},
            attachment:
              isObj(req) && (req as Record<string, unknown>).attachment !== undefined
                ? (req as Record<string, unknown>).attachment
                : isObj(sample) && (sample as Record<string, unknown>).attachment !== undefined
                  ? (sample as Record<string, unknown>).attachment
                  : null,
          },
          dynamicVariables: isObj(draft.dynamicVariables) ? draft.dynamicVariables : undefined,
        }
        const serializedTree = JSON.stringify(trigTree)
        if (document.documentElement.getAttribute('data-vs-trigger-tree') !== serializedTree) {
          document.documentElement.setAttribute('data-vs-trigger-tree', serializedTree)
        }
      } catch {
        // never disturb the page
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

      // 2. Native input setter & event dispatch (DO NOT dispatch blur - blur triggers onBlur with stale localData)
      const input = targetRow.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="hidden"])')
      if (input) {
        const proto = Object.getPrototypeOf(input)
        const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (nativeSet) nativeSet.call(input, value)
        else input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      }

      // 3. Redux Store update: dispatch setValueOnKey & mark hasUnsavedCode: true
      try {
        const store = findReduxStore()
        if (store) {
          const state = store.getState()
          const scriptId =
            extractScriptId(location.pathname) ||
            (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : undefined)
          const urlParams = new URLSearchParams(location.search)
          const stepId =
            urlParams.get('stepId') ||
            (isObj(state.appInfo) && typeof state.appInfo.currentStepId === 'string' ? state.appInfo.currentStepId : undefined)

          const fieldKey =
            targetRow.getAttribute('data-testid')?.replace(/^plugin-field-/, '') ||
            targetRow.id?.replace(/^scroll-/, '')?.replace(/-/g, '.') ||
            norm

          if (scriptId && stepId) {
            store.dispatch({
              type: 'stepsDataV3/setValueOnKey',
              urlData: { sectionIdOrScriptId: scriptId, versionIdOrStepId: stepId, tabName: 'draft' },
              payload: {
                [fieldKey]: value,
                [`_${fieldKey}`]: value,
                [`_${fieldKey}-Type`]: 'string',
              },
            })
            store.dispatch({
              type: 'stepsDataV3/setKeyValueInstance',
              urlData: { sectionIdOrScriptId: scriptId, versionIdOrStepId: stepId, tabName: 'draft' },
              payload: { hasUnsavedCode: true },
            })
            store.dispatch({
              type: 'notification/cancelNotification',
              payload: `${stepId}_PLUGIN_REQUIRED_FIELD_${fieldKey}`,
            })
            store.dispatch({
              type: 'notification/cancelNotification',
              payload: `${stepId}_PLUGIN_WRONG_INPUT_${fieldKey}`,
            })
          }
          const notifs =
            isObj(state.notification) && isObj((state.notification as Record<string, unknown>).localNotification)
              ? ((state.notification as Record<string, unknown>).localNotification as Record<string, unknown>)
              : undefined
          if (notifs) {
            const cleanKey = norm.replace(/[*:[\]"']/g, '')
            for (const k of Object.keys(notifs)) {
              if (k.toLowerCase().includes(cleanKey)) {
                delete notifs[k]
              }
            }
          }
        }
      } catch {
        // ignore
      }

      if (clickSave) {
        setTimeout(() => {
          const saveBtn =
            slider.querySelector<HTMLButtonElement>('[data-testid="save-button"], [data-testid="trigger-save-button"]') ||
            Array.from(slider.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
              /^(save|save & continue)$/i.test(b.textContent?.trim() || '')
            )
          if (saveBtn && !saveBtn.disabled) saveBtn.click()
        }, 250)
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
    if (inner.type === 'get-step-input-data' && typeof inner.requestId === 'string') {
      return {
        type: 'get-step-input-data',
        requestId: inner.requestId.slice(0, 64),
        scriptId: typeof inner.scriptId === 'string' ? inner.scriptId : undefined,
        stepId: typeof inner.stepId === 'string' ? inner.stepId : undefined,
        slugName: typeof inner.slugName === 'string' ? inner.slugName : undefined,
        nonce: inner.nonce,
      }
    }
    if (inner.type === 'get-flow-graph-data' && typeof inner.requestId === 'string') {
      return {
        type: 'get-flow-graph-data',
        requestId: inner.requestId.slice(0, 64),
        scriptId: typeof inner.scriptId === 'string' ? inner.scriptId : undefined,
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
      inner.type === 'editor-insert' &&
      typeof inner.requestId === 'string' &&
      typeof inner.editorId === 'string' &&
      typeof inner.text === 'string'
    ) {
      return {
        type: 'editor-insert',
        requestId: inner.requestId.slice(0, 64),
        editorId: inner.editorId,
        text: inner.text,
        nonce: inner.nonce,
      }
    }
    if (
      inner.type === 'add-dynamic-variable' &&
      typeof inner.requestId === 'string' &&
      typeof inner.name === 'string'
    ) {
      return {
        type: 'add-dynamic-variable',
        requestId: inner.requestId.slice(0, 64),
        name: inner.name.slice(0, 64),
        nonce: inner.nonce,
      }
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
    if (
      inner.type === 'get-editor-text' &&
      typeof inner.requestId === 'string' &&
      typeof inner.editorId === 'string'
    ) {
      return {
        type: 'get-editor-text',
        requestId: inner.requestId.slice(0, 64),
        editorId: inner.editorId,
        nonce: inner.nonce,
      }
    }
    if (
      inner.type === 'mount-monaco-viewer' &&
      typeof inner.requestId === 'string' &&
      typeof inner.containerId === 'string' &&
      typeof inner.value === 'string'
    ) {
      return {
        type: 'mount-monaco-viewer',
        requestId: inner.requestId.slice(0, 64),
        containerId: inner.containerId,
        value: inner.value,
        language: typeof inner.language === 'string' ? inner.language : undefined,
        nonce: inner.nonce,
      }
    }
    if (
      inner.type === 'update-monaco-viewer' &&
      typeof inner.requestId === 'string' &&
      typeof inner.containerId === 'string' &&
      typeof inner.value === 'string'
    ) {
      return {
        type: 'update-monaco-viewer',
        requestId: inner.requestId.slice(0, 64),
        containerId: inner.containerId,
        value: inner.value,
        nonce: inner.nonce,
      }
    }
    if (inner.type === 'dispose-monaco-viewer' && typeof inner.containerId === 'string') {
      return {
        type: 'dispose-monaco-viewer',
        containerId: inner.containerId,
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
      if (msg.type === 'get-step-input-data') {
        post({ type: 'step-input-data-response', requestId: msg.requestId, data: readStepInputData(msg) })
        return
      }
      if (msg.type === 'get-flow-graph-data') {
        post({ type: 'flow-graph-data-response', requestId: msg.requestId, data: readFlowGraphData(msg) })
        return
      }
      if (msg.type === 'editor-action') {
        post({ type: 'editor-action-response', requestId: msg.requestId, result: editorAction(msg.editorId, msg.action) })
        return
      }
      if (msg.type === 'editor-insert') {
        const success = insertIntoEditor(msg.editorId, msg.text, findReduxStore)
        post({ type: 'editor-insert-response', requestId: msg.requestId, success })
        return
      }
      if (msg.type === 'get-editor-text') {
        const text = getEditorValue(msg.editorId)
        post({ type: 'editor-text-response', requestId: msg.requestId, text })
        return
      }
      if (msg.type === 'mount-monaco-viewer') {
        const success = mountMonacoViewer(msg.containerId, msg.value, msg.language)
        post({ type: 'mount-monaco-viewer-response', requestId: msg.requestId, success })
        return
      }
      if (msg.type === 'update-monaco-viewer') {
        const success = updateMonacoViewer(msg.containerId, msg.value)
        post({ type: 'update-monaco-viewer-response', requestId: msg.requestId, success })
        return
      }
      if (msg.type === 'dispose-monaco-viewer') {
        disposeMonacoViewer(msg.containerId)
        return
      }
      if (msg.type === 'add-dynamic-variable') {
        try {
          const store = findReduxStore()
          if (!store) {
            post({ type: 'add-dynamic-variable-response', requestId: msg.requestId, success: false })
            return
          }
          const state = store.getState()
          const scriptId =
            extractScriptId(location.pathname) ||
            (isObj(state.appInfo) && typeof state.appInfo.currentScriptId === 'string' ? state.appInfo.currentScriptId : '')
          const urlParams = new URLSearchParams(location.search)
          const stepId =
            urlParams.get('stepId') ||
            (isObj(state.appInfo) && typeof state.appInfo.currentStepId === 'string' && state.appInfo.currentStepId ? state.appInfo.currentStepId : 'CRON_PRE_PROCESS')
          const tabName = urlParams.get('tabName') || 'draft'
          const slugName =
            urlParams.get('slugName') ||
            (isObj(state.appInfo) && typeof state.appInfo.currentSlugName === 'string' && state.appInfo.currentSlugName ? state.appInfo.currentSlugName : 'CRON_PRE_PROCESS')

          const stepsData = isObj(state.stepsDataV3) ? (state.stepsDataV3 as Record<string, unknown>)[scriptId] : undefined
          const stepEntry = isObj(stepsData) ? (stepsData as Record<string, unknown>)[stepId] : undefined
          const draft = (isObj(stepEntry) ? ((stepEntry as Record<string, unknown>).draft || stepEntry) : {}) as Record<string, unknown>
          const currentVars = isObj(draft.dynamicVariables) ? (draft.dynamicVariables as Record<string, string>) : {}

          const newVars = {
            ...currentVars,
            [msg.name]: '',
          }

          store.dispatch({
            type: 'stepsDataV3/setKeyValueInstance',
            urlData: { scriptId, stepId, tabName, slugName },
            payload: {
              dynamicVariables: newVars,
              variablesChanged: true,
              hasUnsavedCode: true,
            },
          })
          syncDraftToDom()
          post({ type: 'add-dynamic-variable-response', requestId: msg.requestId, success: true })
          return
        } catch {
          post({ type: 'add-dynamic-variable-response', requestId: msg.requestId, success: false })
          return
        }
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
      if (httpOk && (c.kind === 'step-saved' || c.kind === 'step-tested' || c.kind === 'trigger-saved' || c.kind === 'step-created' || c.kind === 'step-deleted')) {
        post({ type: 'flow-graph-changed' })
        setTimeout(checkFlowChange, 50)
        setTimeout(checkFlowChange, 250)
        setTimeout(checkFlowChange, 600)
      }
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

  // Synchronize draft step state from Redux and monitor flow structure changes
  let storeSubscribed = false
  function onStoreUpdate(): void {
    syncDraftToDom()
    checkFlowChange()
  }

  function ensureStoreSubscription(): void {
    if (storeSubscribed) return
    const store = findReduxStore()
    if (store && typeof (store as unknown as Record<string, unknown>).subscribe === 'function') {
      try {
        ;(store as unknown as { subscribe: (fn: () => void) => void }).subscribe(onStoreUpdate)
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
    checkFlowChange()
  }, 500)
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
