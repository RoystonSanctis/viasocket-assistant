// Trigger features of webhook and schedule flows, stored on the trigger itself (json_script.trigger) and written
// through POST /scripts/:projectId/:scriptId/trigger/preprocess:
//   vs_set_get_data        Get Data: an app action, an API call or JS code that runs right after the trigger fires.
//                          Its output REPLACES context.req.body for the loop, run-if and every step.
//   vs_set_trigger_loop    Run once per item: optional loop key (lodash path to a list in the body); each item becomes
//                          context.req.body of its own run.
//   vs_set_run_condition   Run flow if: one JavaScript expression over context.req.* evaluated before any step (per
//                          item when the loop is on); false, an error or an empty expression skips the run.
//
// Only the keys being changed are sent (the server merges them into the trigger). Get Data inputs read only the
// incoming request (context.req.*), never step outputs, and are checked like step mappings against the real request;
// Get Data is tested before it is saved so later steps map its real output. A Get Data on a webhook never carries
// isPollingActionForTrigger (that would turn the webhook into a schedule).

import { maybeRedactText } from '../redact'
import type { Tool, ToolContext } from '../types'
import { type ActionRow, normalizeInputJson } from './catalog'
import { CREDITS_NOTE, getActionRowAny, identifySpecial, paidAction, paidFlowsBlocked } from './builtins'
import { configure, type Configured } from './configure'
import { resolveConnection } from './connections'
import { call, isAbortError, ToolError } from './errors'
import {
  choiceKeys, cleanInputData, clearPending, holdValues, mergePending, reachableFields, stepKey, withDynamicInput, type SavedState,
} from './fields'
import {
  editorParam, getFlow, liveUnlessEditorOpen, normalizeFlow, openGetDataPanel, openTriggerFeaturePanel, openTriggerPanel, panelResult,
  refreshEditorIfOpen, resolveFlow, triggerKind,
} from './flow-api'
import { checkExpression, checkFunctionCode, checkTemplateText } from './js-check'
import { chainsInCode, checkMappings, dynamicVariableTexts, inputDataTexts, type MapText } from './mapping'
import { consoleOf, contextTooLarge, dryRunErrorText, executeDryRun, getRecentRun, type ParsedRun, type RunContext } from './runs'
import {
  arrayPaths, buildCatalogue, compactSample, forgetGetDataSample, getAtPath, holdGetDataSample, loopLists, meaningful, TOO_LARGE, triggerStages, usable,
  variablesOf, type Catalogue,
} from './samples'
import { defineTool, params, S } from './schema'
import { dynamicVariableProblems } from './slugs'
import { buildApiCode, type ApiSpec, type Pair } from './step-bodies'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, FlowRow, FlowTarget, InputJson, PluginData, Trigger } from './types'
import { asRecord, AUTH_ID_RE, bounded, FLOW_PAGES, isRecord, label, MASK, parseMaybeJson, ROW_ID_RE, str, trimData, truncate } from './util'

const pages = [...FLOW_PAGES]
const NO_AUTH: AuthData = { id: 'NoAuth', type: 'NoAuth' }
const PRE_ID = 'CRON_PRE_PROCESS'
const LOOP_CAP = 1000

function fail(problems: string[]): never {
  throw new ToolError(`Nothing was changed. Fix these first: ${problems.join(' | ')}`)
}

// While this tab shows the flow, pre-process writes skip live-apply and the follow-up panel open (or editor
// refresh) bumps ?timestamp, so the editor and any open trigger/feature panel reload the saved state instead of
// keeping a stale cached copy (see flow-api's editor-sync note).

async function postPreprocess(ctx: ToolContext, t: FlowTarget, body: Record<string, unknown>, what: string): Promise<FlowRow | null> {
  const res = await call(what, () =>
    ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/trigger/preprocess`, body, live: true, signal: ctx.signal }),
  )
  return normalizeFlow(asRecord(res).data)
}

async function deletePreprocess(ctx: ToolContext, t: FlowTarget, body: Record<string, true>, what: string): Promise<void> {
  await call(what, () =>
    ctx.vs.request({ method: 'DELETE', path: `/scripts/${t.scriptId}/trigger/preprocess/delete`, body, live: true, signal: ctx.signal }),
  )
}

async function recentRun(ctx: ToolContext, t: FlowTarget): Promise<ParsedRun | null> {
  try {
    return await getRecentRun(ctx, t)
  } catch (e) {
    if (isAbortError(e)) throw e
    return null
  }
}

/** Webhook or schedule with a saved trigger; anything else is refused with what to do instead. */
function requireRequestTrigger(row: FlowRow, feature: string): { trigger: Trigger; kind: 'webhook' | 'cron' } {
  const trigger = row.json_script.trigger
  const kind = triggerKind(trigger)
  if (!trigger || !kind) throw new ToolError(`The flow has no trigger yet. Set it first with vs_set_trigger (webhook or schedule), then add ${feature}.`)
  if (kind !== 'webhook' && kind !== 'cron') {
    throw new ToolError(
      `${feature} is only for webhook and schedule triggers; this flow starts with ${kind === 'email' ? 'an email trigger' : 'an app trigger'}. App triggers prepare their own data and already run once per item when the app sends a list.`,
    )
  }
  return { trigger, kind }
}

const REQUEST_ONLY =
  'Get Data runs before every step, so it can read only the incoming request (context.req.query, context.req.headers, context.req.body), never step outputs or variables'

/** References Get Data cannot have: step outputs and variables; on a schedule, any request data at all. */
function getDataReferenceProblems(texts: MapText[], kind: string): string[] {
  const out: string[] = []
  for (const t of texts) {
    if (/context\s*\??\.\s*(?:res|vals)\b/.test(t.text)) out.push(`${t.where}: ${REQUEST_ONLY}.`)
    else if (kind === 'cron' && /context\s*\??\.\s*req\b/.test(t.text)) {
      out.push(`${t.where}: a schedule has no incoming request, so Get Data on a schedule takes fixed values only.`)
    }
  }
  return out
}

/** Stored values of an app action's fields, without the editor's companion keys. */
function fieldValuesOf(inputData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputData)) {
    if (k.startsWith('_') || k.endsWith('-Type') || k.includes('["_') || k.endsWith('_extraValue') || k === 'hookUrl') continue
    out[k] = v
  }
  return out
}

/** Every value a Get Data configuration evaluates, for the mapping check. */
function getDataTexts(pre: Record<string, unknown>): MapText[] {
  const type = str(pre.type)
  const code = asRecord(pre.code)
  if (type === 'plugin') {
    const ij = normalizeInputJson(code.inputJson)
    return inputDataTexts(fieldValuesOf(asRecord(asRecord(code.selectedValues).inputData)), 'inputData', choiceKeys(ij))
  }
  const out: MapText[] = [...dynamicVariableTexts(asRecord(pre.dynamicVariables))]
  if (type === 'api') {
    if (typeof code.url === 'string') out.push({ where: 'url', text: code.url, mode: 'template' })
    const post = asRecord(code.postData)
    for (const [list, name] of [
      [code.headers, 'headers'],
      [code.queryString, 'queryParams'],
      [post.params, 'formFields'],
    ] as const) {
      for (const p of Array.isArray(list) ? list : []) {
        if (isRecord(p) && typeof p.value === 'string') out.push({ where: `${name}.${str(p.name) ?? ''}`, text: p.value, mode: 'template' })
      }
    }
    const mime = str(post.mimeType)
    if (mime !== 'multipart/form-data' && mime !== 'application/x-www-form-urlencoded' && typeof post.text === 'string' && post.text.trim()) {
      out.push({ where: 'body', text: post.text, mode: 'code' })
    }
    return out
  }
  if (typeof pre.code === 'string') out.push({ where: 'code', text: pre.code, mode: 'code' })
  return out
}

function rawContext(cat: Catalogue): RunContext {
  const src = cat.byId.get('trigger')
  const ok = usable(src, false)
  return {
    req: { body: ok ? (src?.data ?? {}) : {}, query: ok && isRecord(src?.query) ? src.query : {}, headers: ok ? asRecord(src?.headers) : {} },
    res: {},
    vals: {},
  }
}

/** The request as Get Data sees it (no steps before it). */
function rawCatalogue(ctx: ToolContext, t: FlowTarget, row: FlowRow): Promise<Catalogue> {
  return buildCatalogue(ctx, t, row, { at: 'insert', parent: 'root', atStart: true }, { rawTrigger: true })
}

function testBody(pre: Record<string, unknown>, context: RunContext): Record<string, unknown> {
  const type = str(pre.type)
  if (type === 'plugin') {
    const code = asRecord(pre.code)
    const ij = normalizeInputJson(code.inputJson)
    const sv = asRecord(code.selectedValues)
    return {
      type: 'plugin',
      // No code.source: the backend loads the action's perform code when it is absent.
      code: {
        selectedValues: { authData: asRecord(sv.authData), inputData: cleanInputData(asRecord(sv.inputData), ij) },
        inputFieldsBlocks: reachableFields(ij),
        inputFieldsSteps: ij.steps,
        actionVersionId: str(code.actionVersionId),
      },
      name: 'plugin',
      stepId: PRE_ID,
      variables: { context },
      performType: 'perform',
      pluginType: 'action',
      isUserOnDh: false,
    }
  }
  if (type === 'api') return { type: 'api', code: pre.code, name: 'test', variables: { context }, dynamicVariables: asRecord(pre.dynamicVariables) }
  const body: Record<string, unknown> = { type: 'function', code: pre.code, name: PRE_ID, variables: { context }, dynamicVariables: asRecord(pre.dynamicVariables), isUserOnDh: false }
  if (Array.isArray(pre.subfunctions) && pre.subfunctions.length) body.subfunctions = pre.subfunctions
  return body
}

interface GetDataTest {
  success: boolean
  output: unknown
  error?: string
  console?: string
}

async function runGetDataTest(ctx: ToolContext, t: FlowTarget, pre: Record<string, unknown>, context: RunContext): Promise<GetDataTest> {
  if (contextTooLarge(context)) throw new ToolError('The request sample is too large to test Get Data with.')
  await ctx.vs.alignOrg(ctx.signal)
  const res = await executeDryRun(ctx, t, testBody(pre, context), 'Testing Get Data')
  let success = res.success
  let output = res.message
  if (str(pre.type) === 'api') {
    const m = asRecord(res.message)
    const status = Number(m.status)
    success = res.data.success !== false && status > 0 && status < 400 && !asRecord(m.response).errorMessage
    // At run time the VM hands the whole reply wrapper to the flow as context.req.body ({response, request, status,
    // fileData, isAttachment}), not only the response body, so the sample keeps that shape for mapping.
    if (isRecord(res.message)) output = apiReplyWrapper(m)
  }
  return { success, output, error: success ? undefined : dryRunErrorText(res.message), console: consoleOf(res.console) }
}

/** The API reply as Get Data passes it on, with the request's header values masked (they may hold credentials). */
function apiReplyWrapper(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...m }
  if (isRecord(m.request)) {
    const request: Record<string, unknown> = { ...m.request }
    if (isRecord(request.headers)) request.headers = Object.fromEntries(Object.keys(request.headers).map((k) => [k, MASK]))
    out.request = request
  }
  return out
}

const API_WRAPPER_NOTE =
  'An API call as Get Data passes on its whole reply: the response body is under context.req.body.response (also .status and .request). Map and loop over response.<field>; for a clean body use source "code" (return (await axios.get(url)).data).'

function hostsIn(text: string): string[] {
  const hosts = new Set<string>()
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s'"`<>()[\]{}]+/gi)) {
    try {
      hosts.add(new URL(m[0]).host)
    } catch {
      // A ${...} template, not a URL.
    }
    if (hosts.size >= 6) break
  }
  return [...hosts]
}

const READ_VERB = /^(get|list|find|search|retrieve|fetch|read|lookup|look up|count|download)\b/i
/** Words that make a "get ..." name do more than read ("Find or Create", "Search and Delete", "Get and Mark"). */
const WRITE_WORD =
  /\b(or|and|create|add|update|upsert|delete|remove|send|post|mark|move|archive|insert|write|set|assign|check[\s_-]*in|unsubscribe|subscribe|cancel|approve|reply|publish|upload|copy)\b/i

/**
 * Only an app action whose name clearly just reads (a read verb, no write word) runs without asking. API calls and
 * JS code always ask: a request can do anything and send request data to any host, which the card shows.
 */
export function readsOnly(pre: Record<string, unknown>, paid = false): boolean {
  if (paid || str(pre.type) !== 'plugin') return false
  const name = (str(asRecord(pre.code).actionName) ?? '').replace(/_/g, ' ').trim()
  return READ_VERB.test(name) && !WRITE_WORD.test(name)
}

function testPreview(pre: Record<string, unknown>): string {
  const type = str(pre.type)
  const code = asRecord(pre.code)
  if (type === 'plugin') {
    return `Get Data runs the ${str(code.serviceName) ?? 'app'} action "${(str(code.actionName) ?? '').replace(/_/g, ' ')}" now, for real, with the values being saved.`
  }
  if (type === 'api') return `Get Data sends its real request now: ${(str(code.method) ?? 'GET').toUpperCase()} ${truncate(str(code.url) ?? '', 200)}. Whatever it does really happens.`
  const text = typeof pre.code === 'string' ? pre.code : ''
  const hosts = hostsIn(text)
  return [`The Get Data code runs now. It can call external services${hosts.length ? ` (${hosts.join(', ')})` : ''}.`, truncate(text, 400)].join('\n\n')
}

/** Pending app-action Get Data per flow (not saved yet), so vs_get_field_options can load its dropdowns. */
const pendingGetData = new Map<string, { actionId: string; pd: PluginData }>()

function pendingKey(ctx: ToolContext, t: FlowTarget): string {
  return stepKey(ctx, t, 'GET_DATA')
}

/** What vs_get_field_options uses for slugName "CRON_PRE_PROCESS": the Get Data app action being set up, or the saved one. */
export function getDataPluginForOptions(
  ctx: ToolContext,
  t: FlowTarget,
  trigger: Trigger | undefined,
): { pd: PluginData; holdKey: string; saved: SavedState; savedAuth?: AuthData } | undefined {
  const pending = pendingGetData.get(pendingKey(ctx, t))
  const pre = asRecord(trigger?.preProcess)
  const savedCode = str(pre.type) === 'plugin' ? (asRecord(pre.code) as PluginData) : undefined
  const pd = pending?.pd ?? savedCode
  if (!pd) return undefined
  const actionId = str(pd.selectedCreate) ?? ''
  const same = !!savedCode && str(savedCode.selectedCreate) === actionId
  const sv = asRecord(savedCode?.selectedValues)
  const authData = asRecord(sv.authData) as AuthData
  return {
    pd,
    holdKey: stepKey(ctx, t, `GET_DATA:${actionId}`),
    saved: same ? { inputData: asRecord(sv.inputData), authId: str(authData.id) } : { inputData: {} },
    savedAuth: same && authData.id ? authData : undefined,
  }
}

/** The editor's createPluginDataFromAction for an action used as Get Data. */
function pluginDataFromAction(a: ActionRow): PluginData {
  const ij = asRecord(parseMaybeJson(a.inputjson))
  return {
    type: 'action',
    selectedCreate: a.rowid,
    actionVersionId: str(a.actionversionrecordid),
    serviceId: str(a.pluginrecordid),
    serviceName: str(a.pluginname),
    inputFields: ij.inputFields,
    inputJson: { steps: isRecord(ij.steps) ? (ij.steps as InputJson['steps']) : { root: [] }, blocks: isRecord(ij.blocks) ? (ij.blocks as InputJson['blocks']) : {} },
    authIdLookup: str(a.authidlookup),
    authType: str(a.authtype),
    iconUrl: str(a.iconurl),
    selectedValues: { authData: {}, inputData: {} },
    actionName: (str(a.name) ?? '').trim().replace(/[^a-zA-Z0-9]/g, '_'),
    description: a.description,
    sampleData: parseMaybeJson(a.sampledata),
    performList: null,
    performSubscribe: null,
    performUnsubscribe: null,
    modifyTriggerData: null,
    transferOption: false,
  }
}

/**
 * The editor's dynamicInputRequired for Get Data: true for dropdowns mapped from the request (their picked-option
 * list is then empty), false for dropdowns with a picked choice.
 */
function getDataDynamicInput(pd: PluginData, cfg: Configured): { inputJson: Configured['inputJson']; dynamicInputRequired?: Record<string, unknown> } {
  const inputJson = { ...cfg.inputJson, steps: { ...cfg.inputJson.steps } }
  const out: Record<string, unknown> = { ...(withDynamicInput(pd.dynamicInputRequired, cfg.dynamicInput) ?? {}) }
  for (const [k, def] of Object.entries(cfg.ij.blocks)) {
    const type = String(def.type ?? '').toLowerCase()
    if (type !== 'dropdown' || cfg.cleaned[k] === undefined) continue
    if (cfg.dynamicInput.includes(k)) {
      inputJson.steps[k] = []
      out[k] = true
    } else if (out[k] === undefined) out[k] = false
  }
  return { inputJson, dynamicInputRequired: Object.keys(out).length ? out : undefined }
}

interface GetDataArgs {
  action?: 'set' | 'test' | 'remove'
  source?: 'app' | 'api' | 'code'
  actionId?: string
  connectionId?: string
  inputData?: Record<string, unknown>
  customInput?: string[]
  code?: string
  dynamicVariables?: Record<string, string | null>
  url?: string
  method?: string
  headers?: Pair[]
  queryParams?: Pair[]
  bodyType?: ApiSpec['bodyType']
  body?: string
  formFields?: Pair[]
  skipTest?: boolean
  scriptId?: string
}

function precheckGetData(a: GetDataArgs): void {
  const action = a.action ?? 'set'
  const problems: string[] = []
  if (action !== 'set') {
    if (a.source || a.actionId || a.code !== undefined || a.url !== undefined || a.inputData) problems.push(`action "${action}" takes no configuration; use action "set" to change Get Data.`)
    if (problems.length) fail(problems)
    return
  }
  if (!a.source) problems.push('source is required: "app" (an app action from vs_list_app_actions or vs_list_builtin_tools), "api" or "code".')
  if (a.source === 'app' && !a.actionId) problems.push('actionId is required for source "app".')
  if (a.source !== 'app' && (a.actionId || a.connectionId || a.inputData || a.customInput)) problems.push('actionId, connectionId, inputData and customInput are only for source "app".')
  if (a.source !== 'code' && a.code !== undefined) problems.push('code is only for source "code".')
  if (a.source !== 'api' && (a.url !== undefined || a.method || a.headers || a.queryParams || a.bodyType || a.body !== undefined || a.formFields)) {
    problems.push('url, method, headers, queryParams, bodyType, body and formFields are only for source "api".')
  }
  if (a.source === 'app' && a.dynamicVariables) problems.push('dynamicVariables are only for source "api" or "code".')
  problems.push(...dynamicVariableProblems(a.dynamicVariables))
  if (a.code !== undefined) {
    const r = checkFunctionCode(a.code)
    if (r.error) problems.push(`code: ${r.error}`)
    else if (r.warning) problems.push(`code: it must return the data (whatever it returns becomes context.req.body).`)
  }
  if (a.url !== undefined) {
    const p = checkTemplateText(a.url)
    if (p) problems.push(`url: ${p}`)
  }
  if (problems.length) fail(problems)
}

function mergeVars(saved: unknown, changes: GetDataArgs['dynamicVariables']): Record<string, unknown> {
  const out: Record<string, unknown> = { ...asRecord(saved) }
  const problems: string[] = []
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (v === null) delete out[k]
    else if (v !== MASK) out[k] = v
    else if (!Object.hasOwn(out, k)) problems.push(`dynamicVariables.${k}: no saved value to keep; ask the user for it.`)
  }
  if (problems.length) fail(problems)
  return out
}

/** A Get Data app action still missing a connection or values: nothing is saved, the values are held. */
class IncompleteGetData extends Error {
  constructor(readonly result: Record<string, unknown>) {
    super('incomplete')
  }
}

/** The Get Data configuration to save (not saved yet), from the arguments and the saved one. */
async function buildGetData(
  ctx: ToolContext,
  t: FlowTarget,
  a: GetDataArgs,
  trigger: Trigger,
  kind: string,
): Promise<{ pre: Record<string, unknown>; holdKey?: string; paid?: boolean }> {
  const saved = asRecord(trigger.preProcess)
  const savedType = str(saved.type)
  const common = { title: PRE_ID, stepId: PRE_ID, steps: '2' }
  if (a.source === 'code') {
    const code = a.code ?? (savedType === 'function' && typeof saved.code === 'string' ? saved.code : undefined)
    if (!code) fail(['code is required: Get Data has no saved code.'])
    const vars = mergeVars(savedType === 'function' ? saved.dynamicVariables : undefined, a.dynamicVariables)
    return { pre: { type: 'function', ...common, code, dynamicVariables: vars, auth_id: null } }
  }
  if (a.source === 'api') {
    const spec: ApiSpec = { url: a.url, method: a.method, headers: a.headers, queryParams: a.queryParams, bodyType: a.bodyType, body: a.body, formFields: a.formFields }
    const { code, problems } = buildApiCode(spec, savedType === 'api' ? asRecord(saved.code) : {})
    if (problems.length) fail(problems)
    const vars = mergeVars(savedType === 'api' ? saved.dynamicVariables : undefined, a.dynamicVariables)
    return { pre: { type: 'api', ...common, code, dynamicVariables: vars } }
  }

  // An app action, set up like a step in the Get Data panel (connection, required fields, real choices).
  const actionId = a.actionId ?? ''
  const special = await identifySpecial(ctx, actionId)
  if (special === 'ai_agent' || special === 'ai_agent_background' || special === 'flow_in_flow') {
    throw new ToolError(
      'The assistant cannot set up an AI agent or Flow in Flow as Get Data (their built-in connection is made only for steps). Use an app action, an API call or JS code, or let the user pick it in the Get Data panel.',
    )
  }
  if (special) throw new ToolError(`That built-in tool (${special.replace(/_/g, ' ')}) is not offered as Get Data.`)
  const row = await getActionRowAny(ctx, actionId)
  if (row.type === 'trigger') throw new ToolError('That is a trigger. Get Data runs an action (usually one that gets or lists records); use vs_list_app_actions with kind "action".')
  if (row.type === 'custom_action' || row.type === 'custom_api') throw new ToolError('Custom actions cannot be configured by the assistant; use an API call (source "api") instead.')
  if (!str(row.actionversionrecordid) || !ROW_ID_RE.test(String(row.actionversionrecordid))) throw new ToolError('This action has no published version.')
  const savedCode = savedType === 'plugin' ? (asRecord(saved.code) as PluginData) : undefined
  const same = !!savedCode && str(savedCode.selectedCreate) === actionId
  const pd: PluginData = same && savedCode ? { ...savedCode } : pluginDataFromAction(row)
  delete pd.source
  const holdKey = stepKey(ctx, t, `GET_DATA:${actionId}`)
  pendingGetData.set(pendingKey(ctx, t), { actionId, pd })
  const sv = asRecord(savedCode?.selectedValues)
  const savedState: SavedState = same ? { inputData: asRecord(sv.inputData), authId: str(asRecord(sv.authData).id) } : { inputData: {} }
  const merged = mergePending(holdKey, a.inputData, savedState)
  const connectionId = a.connectionId ?? merged.connectionId
  const noAuth = (str(pd.authType) ?? row.authtype) === 'NoAuth'
  let authData: AuthData | undefined
  if (noAuth) authData = NO_AUTH
  else if (connectionId) {
    const serviceId = str(pd.serviceId) ?? row.pluginrecordid ?? ''
    const lookup = str(pd.authIdLookup) ?? row.authidlookup ?? ''
    if (!ROW_ID_RE.test(serviceId) || !ROW_ID_RE.test(lookup)) throw new ToolError('This action has no connection settings.')
    authData = await resolveConnection(ctx, connectionId, serviceId, lookup, t)
  } else if (same && asRecord(sv.authData).id) authData = asRecord(sv.authData) as AuthData
  const customInput = new Set(a.customInput ?? [])
  let cfg: Configured
  try {
    cfg = await configure(ctx, t, {
      holdKey,
      pd,
      values: merged.values,
      changed: new Set(Object.keys(a.inputData ?? {})),
      base: savedState.inputData,
      authData,
      isTrigger: false,
      slug: PRE_ID,
      customInput,
      noConnection: noAuth,
    })
  } catch (e) {
    if (e instanceof ToolError) holdValues(holdKey, merged.values, connectionId, savedState)
    throw e
  }
  if (!authData?.id || !cfg.complete) {
    holdValues(holdKey, merged.values, connectionId, savedState)
    throw new IncompleteGetData({
      saved: false,
      app: pd.serviceName,
      action: typeof pd.actionName === 'string' ? pd.actionName.replace(/_/g, ' ') : undefined,
      needsConnection: authData?.id
        ? undefined
        : {
            serviceId: pd.serviceId,
            authIdLookup: pd.authIdLookup,
            actionVersionId: pd.actionVersionId,
            hint: 'Find one with vs_list_connections (ask which one if there are several); if there is none, vs_connect_app. Then call vs_set_get_data again with connectionId.',
          },
      needsUserInput: cfg.needs.length ? cfg.needs : undefined,
      defaultsApplied: cfg.defaultsApplied.length ? cfg.defaultsApplied : undefined,
      heldValues: Object.keys(merged.values).length ? Object.keys(merged.values) : undefined,
      warnings: cfg.warnings.length ? cfg.warnings : undefined,
      next: `Nothing is saved yet. Ask the user for each missing item, one short question at a time: offer the real choices from vs_get_field_options (slugName "${PRE_ID}"), or map a value from the incoming request with an insert text such as \${context.req.query.id}${kind === 'cron' ? ' (not on a schedule: it has no request)' : ''}. Then call vs_set_get_data again with the same actionId; values given so far are kept.`,
    })
  }
  const { inputJson, dynamicInputRequired } = getDataDynamicInput(pd, cfg)
  const code: PluginData = { ...pd, inputJson, selectedValues: { ...asRecord(pd.selectedValues), authData, inputData: cfg.cleaned } }
  if (dynamicInputRequired) code.dynamicInputRequired = dynamicInputRequired
  return {
    pre: {
      type: 'plugin',
      ...common,
      code,
      auth_id: authData.id,
      action_id: str(pd.actionVersionId),
      org_id: t.orgId,
      project_id: t.projectId,
    },
    holdKey,
    paid: paidAction(row, undefined),
  }
}

/** Later settings built on the body: does the loop key still point at a list, does run-if still read real fields. */
async function followUpChecks(ctx: ToolContext, t: FlowTarget, row: FlowRow, trigger: Trigger, output: unknown): Promise<string[]> {
  const notes: string[] = []
  const filter = asRecord(trigger.preProcessFilter)
  const key = filter.type === 'filterByKey' ? str(asRecord(filter.value).value) : undefined
  if (key && !Array.isArray(getAtPath(output, key))) {
    notes.push(`The loop key "${key}" is not a list in the new Get Data output; change it with vs_set_trigger_loop (lists found: ${listKeys(output).join(', ') || 'none'}).`)
  }
  const runIf = await runIfMismatch(ctx, t, { ...row, json_script: { ...row.json_script, trigger } }, trigger)
  if (runIf) notes.push(`Run-if no longer matches the body: ${runIf}. Update it with vs_set_run_condition.`)
  return notes
}

/** Lists for a message: "orders" (3 items), or the body itself. */
function listKeys(data: unknown): string[] {
  return loopLists(data).map((l) => `${l.arrayKey ? `"${l.arrayKey}"` : 'the body itself (omit arrayKey)'} (${l.items} items)`)
}

const setGetData = defineTool<GetDataArgs>({
  name: 'vs_set_get_data',
  description: [
    'Get Data for webhook and schedule triggers: an app action (source "app", e.g. a "get"/"list" action), an API call ("api") or JS code ("code") that runs when the flow starts. Its output REPLACES context.req.body for every step (an API call passes its whole reply: the body is under context.req.body.response).',
    'Inputs are fixed values, real dropdown choices (vs_get_field_options slugName "CRON_PRE_PROCESS") or, on webhooks, insert texts from the incoming request such as ${context.req.query.id}; never step outputs.',
    'It is tested before it is saved (the user is asked first unless an app action only reads); a failed test saves nothing. An incomplete app action returns needsConnection / needsUserInput.',
    'action "test" re-tests the saved one; "remove" deletes it (and the loop/run-if built on it). Then offer vs_set_trigger_loop and vs_set_run_condition.',
  ].join(' '),
  parameters: params({
    action: S.enum(['set', 'test', 'remove'], 'set (default), test the saved Get Data again, or remove it.'),
    source: S.enum(['app', 'api', 'code'], 'set: what fetches the data.'),
    actionId: S.str('source app: actionId from vs_list_app_actions or vs_list_builtin_tools.', { pattern: ROW_ID_RE.source }),
    connectionId: S.str('source app: connection id from vs_list_connections / vs_connect_app.', { pattern: AUTH_ID_RE.source }),
    inputData: S.map('source app: field values keyed by field key (vs_get_action). Dropdowns take the value of a real choice; webhook flows may map request data with insert texts.'),
    customInput: S.strs('source app: field keys whose value the user typed themselves (free text in a dropdown).'),
    code: S.str('source code: body of an async function that RETURNS the data (may use await, axios, fetch). Read the request as context.req.*.', { maxLength: 100000 }),
    dynamicVariables: S.map('source api/code: named constants available in the code, e.g. {"region":"eu"}; null removes one. Never secrets: keys belong in a connection, or let the user type them in the panel.'),
    url: S.str('source api: request URL; may contain ${context.req...} on webhooks.', { maxLength: 2000 }),
    method: S.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'source api: HTTP method (default GET).'),
    headers: S.pairs('source api: request headers.'),
    queryParams: S.pairs('source api: query parameters.'),
    bodyType: S.enum(['json', 'form', 'multipart', 'none'], 'source api: body encoding.'),
    body: S.str('source api, bodyType json: JavaScript expression sent as JSON.', { maxLength: 20000 }),
    formFields: S.pairs('source api, bodyType form/multipart: fields.'),
    skipTest: S.bool('Save without testing, only when the user declined the test. Later steps cannot map its output until it is tested.'),
    scriptId: SCRIPT_ID_PARAM,
  }),
  danger: 'write',
  // run() asks before a test that may change something, and before removing.
  confirmsInRun: true,
  pages,
  describe: (a) => (a.action === 'remove' ? 'Removing Get Data' : a.action === 'test' ? 'Testing Get Data' : 'Setting up Get Data'),
  async run(a, ctx) {
    precheckGetData(a)
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const { trigger, kind } = requireRequestTrigger(row, 'Get Data')
    const action = a.action ?? 'set'

    if (action === 'remove') return removeGetData(ctx, t, trigger)

    let pre: Record<string, unknown>
    let holdKey: string | undefined
    let paid = false
    if (action === 'test') {
      if (!isRecord(trigger.preProcess)) throw new ToolError('This flow has no Get Data to test. Set it up with vs_set_get_data action "set".')
      pre = trigger.preProcess
    } else {
      try {
        ;({ pre, holdKey, paid = false } = await buildGetData(ctx, t, a, trigger, kind))
      } catch (e) {
        if (e instanceof IncompleteGetData) return e.result
        throw e
      }
    }

    // Inputs read only the incoming request, and only data it really carried.
    const texts = getDataTexts(pre)
    const refProblems = getDataReferenceProblems(texts, kind)
    if (refProblems.length) fail(refProblems)
    const rawCat = await rawCatalogue(ctx, t, row)
    const testing = action === 'test' || a.skipTest !== true
    const check = checkMappings(texts, rawCat, { allowDocumented: false, forTest: testing })
    if (check.problems.length) {
      fail(check.problems.map((p) => (p.includes('context.req') ? p : `${p} (Get Data can read only the incoming request)`)))
    }

    const safe = readsOnly(pre, paid)
    const creditsLine = paid ? `\n\n${kind === 'cron' ? 'It is a paid action: every scheduled run' : 'It is a paid action: every request'} uses AI credits (1 AI credit = 4 tasks).` : ''
    if (ctx.mustConfirm || (testing && !safe) || paid) {
      const ok = await ctx.ui.confirm(
        action === 'test' ? 'Test Get Data?' : testing ? 'Save and test Get Data?' : 'Save Get Data without testing?',
        (testing ? testPreview(pre) : 'Get Data is saved without a test, so later steps cannot map its output until it is tested.') + creditsLine,
        true,
        testing ? 'Run test' : 'Save',
      )
      ctx.signal.throwIfAborted()
      if (!ok) {
        return {
          saved: false,
          declined: true,
          message: testing
            ? 'The user declined the test, so nothing was changed. If they want it saved untested, call again with skipTest: true (its output then cannot be mapped until tested).'
            : 'The user declined; nothing was changed.',
        }
      }
    }

    let test: GetDataTest | undefined
    if (testing) {
      test = await runGetDataTest(ctx, t, pre, rawContext(rawCat))
      if (!test.success) {
        return {
          saved: false,
          test: {
            success: false,
            error: maybeRedactText(test.error, ctx.stripRunData, 500) ?? 'The test failed.',
            console: maybeRedactText(test.console, ctx.stripRunData, 1500),
          },
          next:
            action === 'test'
              ? 'Get Data fails with these values, so every run would fail before any step. Fix it with vs_set_get_data action "set".'
              : 'Nothing was saved: a failing Get Data would stop every run before any step. Fix the problem (values, connection, URL or code) and call again.',
        }
      }
    }
    const output = test?.output
    const found = test ? meaningful(output) : false
    const compact = found ? compactSample(output) : undefined
    const toSave: Record<string, unknown> = { ...pre }
    if (compact !== undefined && compact !== TOO_LARGE) toSave.sampleData = compact
    else delete toSave.sampleData

    const saved = await ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const cur = (await getFlow(ctx, t)).json_script.trigger
      if (triggerKind(cur) !== kind) throw new ToolError('The trigger changed meanwhile; nothing was saved. Check it with vs_get_flow.')
      return postPreprocess(ctx, t, { preProcess: toSave }, action === 'test' ? 'Saving the Get Data sample' : 'Saving Get Data')
    })
    if (found) holdGetDataSample(ctx, t, toSave, output)
    else forgetGetDataSample(ctx, t)
    if (holdKey) clearPending(holdKey)
    pendingGetData.delete(pendingKey(ctx, t))

    const after = saved?.json_script.trigger ?? { ...trigger, preProcess: toSave }
    const afterRow: FlowRow = saved ?? { ...row, json_script: { ...row.json_script, trigger: after } }
    const final = triggerStages(ctx, t, afterRow, null, after).final
    const warnings: string[] = []
    if (paid) {
      warnings.push(CREDITS_NOTE)
      if ((await paidFlowsBlocked(ctx)) === true) warnings.push("The workspace's AI credits are used up: flows with paid actions are stopped until credits are added.")
    }
    if (str(pre.type) === 'api') warnings.push(API_WRAPPER_NOTE)
    if (found) warnings.push(...(await followUpChecks(ctx, t, afterRow, after, output)))
    if (test && !found) warnings.push('Get Data returned nothing (empty), so later steps get an empty context.req.body.')
    if (compact === TOO_LARGE) warnings.push('The output is too large to save with Get Data; it is kept for this session only.')
    const strip = ctx.stripRunData
    return bounded(
      {
        saved: true,
        source: str(pre.type) === 'plugin' ? 'app' : str(pre.type) === 'api' ? 'api' : 'code',
        tested: !!test,
        test: test ? { success: true, sampleFound: found, output: trimData(output, strip), console: maybeRedactText(test.console, strip, 1000) } : undefined,
        body: final.note,
        variables: final.origin ? variablesOf(final, strip, 60) : undefined,
        lists: found ? loopLists(output) : undefined,
        ...panelResult(await openGetDataPanel(ctx, t.scriptId, str(pre.type) ?? 'plugin')),
        warnings: warnings.length ? warnings : undefined,
        next: found
          ? 'Every step now reads this output as context.req.body: map later steps only with these insert texts (or vs_get_variables). If it holds a list and each item should run the flow once, offer vs_set_trigger_loop with the arrayKey of one of "lists" (omit arrayKey when an entry has none: the body itself is the list). Offer vs_set_run_condition if only some runs should continue.'
          : 'Saved without a real output, so nothing can be mapped from it yet: test it with vs_set_get_data action "test".',
      },
      ctx.maxResultChars,
    )
  },
})

async function removeGetData(ctx: ToolContext, t: FlowTarget, trigger: Trigger): Promise<unknown> {
  if (!isRecord(trigger.preProcess)) return { removed: false, message: 'This flow has no Get Data.' }
  const extra: string[] = []
  const body: Record<string, true> = { preProcess: true }
  // The loop key and run-if were written for Get Data's output; the editor removes them together.
  if (isRecord(trigger.loops) || isRecord(trigger.preProcessFilter)) {
    body.loops = true
    extra.push('the loop')
  }
  const pc = asRecord(trigger.preCondition)
  if (typeof pc.code === 'string' && /context\s*\??\.\s*req\s*\??\.\s*body\b/.test(pc.code)) {
    body.preCondition = true
    extra.push('the run-if condition (it reads the body)')
  }
  const ok = await ctx.ui.confirm(
    'Remove Get Data?',
    `Steps will read the incoming ${triggerKind(trigger) === 'cron' ? 'schedule data (none)' : 'request'} as context.req.body again.${extra.length ? ` This also removes ${extra.join(' and ')}.` : ''} Steps mapped to Get Data's fields must be remapped.`,
    true,
    'Remove',
  )
  ctx.signal.throwIfAborted()
  if (!ok) return { removed: false, declined: true, message: 'The user kept Get Data.' }
  await ctx.vs.mutate(t.scriptId, async () => {
    await ctx.vs.alignOrg(ctx.signal)
    await getFlow(ctx, t)
    await deletePreprocess(ctx, t, body, 'Removing Get Data')
  })
  forgetGetDataSample(ctx, t)
  pendingGetData.delete(pendingKey(ctx, t))
  // A panel still showing the removed Get Data switches to the trigger panel; otherwise the bump alone makes the
  // editor refetch (without it, a non-live removal would stay invisible until a manual refresh).
  const sync =
    editorParam(ctx, 'stepId', t.scriptId) === PRE_ID
      ? await openTriggerPanel(ctx, t.scriptId, triggerKind(trigger))
      : await refreshEditorIfOpen(ctx, t.scriptId)
  return {
    removed: true,
    alsoRemoved: extra.length ? extra : undefined,
    editorNote: sync.reason,
    note: 'Steps that mapped Get Data fields now read the original body; check them with vs_get_variables.',
  }
}

// ---- Run once per item ---------------------------------------------------------------------------------------

interface LoopArgs {
  enabled: boolean
  arrayKey?: string
  scriptId?: string
}

/** A loop key as the model may write it (context.req.body.items, body.items) in lodash form (items). */
function normalizeKey(key: string): string {
  const k = key
    .trim()
    // Copied from a listing: "orders (3 items)", "(root) (5 items)", "the body itself (omit arrayKey)".
    .replace(/\s*\(\d+ items?\)\s*$/i, '')
    .replace(/^"(.*)"$/, '$1')
  if (/^\(root[^)]*\)$/i.test(k) || /^the body itself/i.test(k)) return ''
  return k
    .replace(/^\$\{|\}$/g, '')
    .replace(/^context\s*\??\.\s*req\s*\??\.\s*body\s*\??\.?/, '')
    .replace(/^body\s*\??\./, '')
    .replace(/\?\./g, '.')
    .replace(/^\./, '')
}

/** Steps whose saved references read the trigger body (they may need remapping when its shape changes). */
function stepsReadingBody(row: FlowRow): string[] {
  const fns = asRecord(asRecord(row.used_variables).functions)
  return Object.entries(fns)
    .filter(([, paths]) => Array.isArray(paths) && paths.some((p) => typeof p === 'string' && /context\.req\.body/.test(p.replace(/\?\./g, '.'))))
    .map(([slug]) => slug)
    .slice(0, 12)
}

/** The enabled run-if code of a trigger, if any. */
function enabledRunIf(trigger: Trigger | undefined): string | undefined {
  const pc = asRecord(trigger?.preCondition)
  return pc.conditionEnabled === true && typeof pc.code === 'string' && pc.code.trim() ? pc.code : undefined
}

/** Why an enabled run-if does not fit the body it will see with `trigger` (unknown paths), or undefined. */
async function runIfMismatch(ctx: ToolContext, t: FlowTarget, row: FlowRow, trigger: Trigger): Promise<string | undefined> {
  const code = enabledRunIf(trigger)
  if (!code) return undefined
  const cat = await buildCatalogue(ctx, t, row, { at: 'insert', parent: 'root', atStart: true })
  // No sample: nothing to compare with (said elsewhere).
  if (!usable(cat.byId.get('trigger'), false)) return undefined
  const r = checkMappings([{ where: 'run-if', text: code, mode: 'code' }], cat, { allowDocumented: false })
  return r.problems.length ? r.problems.slice(0, 3).join(' | ') : undefined
}

const setTriggerLoop = defineTool<LoopArgs>({
  name: 'vs_set_trigger_loop',
  description: [
    'Run once per item (webhook and schedule triggers): when the body (or Get Data output) holds a list, each item runs the flow on its own with context.req.body = that item.',
    'arrayKey is the path of a REAL list in the current body, e.g. "data.items" (omit when the body itself is the list); it is refused unless the sample has a list there.',
    'Schedules need Get Data first. A looped webhook always answers "Flow Queued" (a custom response no longer reaches the caller); at most 1000 items per run, about 3 s apart.',
    'enabled false turns it off. Returns the per-item insert texts.',
  ].join(' '),
  parameters: params(
    {
      enabled: S.bool('true to run once per item, false to turn it off.'),
      arrayKey: S.str('Path of the list in the body, e.g. "items" or "data.records" (omit when the body is the list).', { maxLength: 200 }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['enabled'],
  ),
  danger: 'write',
  // run() asks before a looped webhook stops sending its custom response (and whenever the gate would have asked).
  confirmsInRun: true,
  pages,
  describe: (a) => (a.enabled ? 'Setting the flow to run once per item' : 'Turning off run once per item'),
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const { trigger, kind } = requireRequestTrigger(row, 'Run once per item')
    if (kind === 'cron' && !isRecord(trigger.preProcess)) {
      throw new ToolError('A schedule has no data of its own to loop over. Add Get Data first (vs_set_get_data), then loop over its list.')
    }
    const loopsOn = asRecord(trigger.loops).loopsEnabled === true
    const hasFilter = isRecord(trigger.preProcessFilter) && Object.keys(trigger.preProcessFilter).length > 0
    if (!a.enabled) {
      if (!loopsOn && !hasFilter && !isRecord(trigger.loops)) return { changed: false, message: 'The flow does not run once per item.' }
      if (ctx.mustConfirm) {
        const ok = await ctx.ui.confirm('Turn off run once per item?', 'Each trigger event then runs the flow once with the whole body.', false, 'Turn off')
        ctx.signal.throwIfAborted()
        if (!ok) return { changed: false, declined: true, message: 'The user kept the loop.' }
      }
      await ctx.vs.mutate(t.scriptId, async () => {
        await ctx.vs.alignOrg(ctx.signal)
        await getFlow(ctx, t)
        // Removes the loop key too: a leftover key would still narrow the body.
        await deletePreprocess(ctx, t, { loops: true }, 'Turning off the loop')
      })
      const warnings: string[] = []
      const reading = stepsReadingBody(row)
      if (reading.length) warnings.push(`These steps read context.req.body and were mapped per item: ${reading.join(', ')}. Check them with vs_get_variables.`)
      // A run-if written for one item now sees the whole body; checked as the next run will see it.
      const unrolled: Trigger = { ...trigger }
      delete unrolled.loops
      delete unrolled.preProcessFilter
      const runIf = await runIfMismatch(ctx, t, { ...row, json_script: { ...row.json_script, trigger: unrolled } }, unrolled)
      if (runIf) warnings.push(`Run-if was written for one item and now sees the whole body, so it may skip every run: ${runIf}. Rewrite it with vs_set_run_condition (or disable it) now.`)
      return {
        changed: true,
        loop: 'off',
        ...panelResult(await openTriggerFeaturePanel(ctx, t.scriptId, kind, 'hitFlowIndividually')),
        warnings: warnings.length ? warnings : undefined,
        next: runIf ? 'Tell the user the run condition no longer fits and fix it with vs_set_run_condition before testing.' : undefined,
      }
    }

    const stages = triggerStages(ctx, t, row, await recentRun(ctx, t))
    if (!stages.processed) {
      throw new ToolError(`Not changed: the body has no real sample yet, so its lists are unknown. ${stages.final.note ?? ''}`.trim())
    }
    const body = stages.processed.data
    const lists = arrayPaths(body, 40)
    const key = a.arrayKey !== undefined ? normalizeKey(a.arrayKey) : ''
    const shown = listKeys(body).join(', ') || 'none'
    if (key && !lists.some((l) => l.path === key)) {
      fail([`"${key}" is not a list in ${stages.processed.what}. Lists found: ${shown}.`])
    }
    if (!key && !Array.isArray(body)) fail([`The body itself is not a list, so pass arrayKey with one of the lists found: ${shown}.`])
    const picked = key ? getAtPath(body, key) : body
    const filter = key ? { type: 'filterByKey', value: { value: key, html: key } } : {}
    const customResponse = kind === 'webhook' && row.json_script.blocks.response?.responseType === 'custom'
    if (customResponse || ctx.mustConfirm) {
      const ok = await ctx.ui.confirm(
        'Run the flow once per item?',
        [
          `Each item of ${key ? `"${key}"` : 'the body'} runs the flow on its own (at most ${LOOP_CAP} items per event, about 3 seconds apart).`,
          customResponse
            ? 'Callers of the webhook will get "Flow Queued" instead of your custom response, so an app that expects that response may stop working.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        customResponse,
        'Turn on',
      )
      ctx.signal.throwIfAborted()
      if (!ok) return { changed: false, declined: true, message: 'The user kept running the flow once per event.' }
    }

    await ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const cur = (await getFlow(ctx, t)).json_script.trigger
      if (triggerKind(cur) !== kind) throw new ToolError('The trigger changed meanwhile; nothing was saved.')
      await postPreprocess(ctx, t, { loops: { loopsEnabled: true }, preProcessFilter: filter }, 'Setting run once per item')
    })
    const planned: Trigger = { ...trigger, loops: { ...asRecord(trigger.loops), loopsEnabled: true }, preProcessFilter: filter }
    const plannedRow: FlowRow = { ...row, json_script: { ...row.json_script, trigger: planned } }
    const final = triggerStages(ctx, t, plannedRow, null, planned).final
    const warnings: string[] = [
      `At most ${LOOP_CAP} items run per trigger event (extra items are skipped), about 3 seconds apart (1000 items take about 50 minutes). Per-item results appear as separate runs in the logs.`,
    ]
    if (kind === 'webhook') {
      warnings.push(
        row.json_script.blocks.response?.responseType === 'custom'
          ? 'The webhook now always answers "Flow Queued": the custom response is no longer sent to the caller.'
          : 'The webhook now always answers "Flow Queued" right away (runs are queued).',
      )
    }
    if (Array.isArray(picked) && picked.length > LOOP_CAP) warnings.push(`The sample list has ${picked.length} items; only the first ${LOOP_CAP} would run.`)
    if (Array.isArray(picked) && !picked.length) warnings.push('The list is empty in the sample, so the fields of one item are unknown until data arrives.')
    if (enabledRunIf(trigger)) {
      const runIf = await runIfMismatch(ctx, t, plannedRow, planned)
      warnings.push(
        runIf
          ? `Run-if is now checked once per item and no longer matches one item: ${runIf}. Update it with vs_set_run_condition.`
          : 'Run-if is now checked once per item.',
      )
    }
    const reading = stepsReadingBody(row)
    if (reading.length) warnings.push(`These steps read context.req.body and may need remapping to one item's fields: ${reading.join(', ')}.`)
    return bounded(
      {
        changed: true,
        loop: 'on',
        arrayKey: key || '(root)',
        sampleItems: Array.isArray(picked) ? picked.length : undefined,
        body: final.note,
        variables: final.origin ? variablesOf(final, ctx.stripRunData, 60) : undefined,
        ...panelResult(await openTriggerFeaturePanel(ctx, t.scriptId, kind, 'hitFlowIndividually')),
        warnings,
        next: 'Map steps with these per-item insert texts (context.req.body.<field>, never [0]).',
      },
      ctx.maxResultChars,
    )
  },
})

// ---- Run flow if ---------------------------------------------------------------------------------------------

interface RunIfArgs {
  condition?: string
  statement?: string
  disable?: boolean
  remove?: boolean
  scriptId?: string
}

/** Text with string and template-literal contents blanked, for structural checks. */
function blankStrings(src: string): string {
  let out = ''
  let q: string | null = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? ''
    if (q) {
      if (c === '\\') {
        out += '  '
        i++
      } else if (c === q) {
        q = null
        out += c
      } else out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') q = c
    out += c
  }
  return out
}

/** Run-if runs as `return <condition>;` with only context.req: it must be one expression over the request. */
export function runIfProblems(condition: string): string[] {
  const problems: string[] = []
  const p = checkExpression(condition)
  if (p) return [p]
  if (/^\s*(?:return|const|let|var|if|for|while|do|function|class|throw|try|switch)\b/.test(condition)) {
    problems.push('write ONE expression (no return, const, if or other statements); it is evaluated as return <condition>;')
  }
  const plain = blankStrings(condition)
  if (plain.includes(';')) problems.push('no semicolons: it must be a single expression')
  if (/(^|[^=!<>])=(?![=>])/.test(plain)) problems.push('a single "=" assigns instead of comparing; use === (or !==, >=, <=)')
  for (const c of chainsInCode(condition)) {
    const root = c.segs[0]
    if (root === undefined) problems.push(`"${c.raw}": read a field of the request, e.g. context.req.body.<field>`)
    else if (root !== 'req') problems.push(`"${c.raw}": run-if sees only the incoming request (context.req.*); steps and variables have not run yet`)
  }
  return problems
}

/**
 * A run-if is a pure comparison over context.req, evaluated on every request before any step: no awaiting, calling
 * out or loading code (it would run on the server with the request's data, unseen by the user). An address in a
 * string is fine to compare with: nothing in the expression can call it.
 */
export function runIfUnsafe(condition: string): string[] {
  const plain = blankStrings(condition)
  const found = new Set<string>()
  for (const m of plain.matchAll(/(?<![\w$.])(await|async|fetch|axios|require|import|XMLHttpRequest|WebSocket|eval|Function|globalThis|process|setTimeout|setInterval|https?|crypto|Buffer)\b/g)) {
    found.add(m[1] ?? '')
  }
  const out: string[] = []
  if (found.size) out.push(`no ${[...found].slice(0, 5).join(', ')}: a run-if only compares fields of the request (e.g. context.req.body.status === "paid")`)
  if (/\+\+|--/.test(plain)) out.push('no ++ or --: a run-if must not change anything')
  return out
}

const setRunCondition = defineTool<RunIfArgs>({
  name: 'vs_set_run_condition',
  description: [
    '"Run flow if": a condition checked before any step; when it is false (or errors) the run is skipped.',
    'condition is ONE JavaScript expression over context.req.* only (body, query, headers), e.g. context.req.body.amount > 1000, using real fields from vs_get_variables; on webhook/schedule flows it sees the Get Data output and, with the loop on, one item.',
    'statement is the plain-English wording shown to the user. The condition is checked against the real sample (unknown paths and empty conditions are refused) and evaluated on it.',
    'disable turns it off and keeps it to switch on again; remove deletes it. Schedules need Get Data first.',
  ].join(' '),
  parameters: params({
    condition: S.str('One JavaScript expression over context.req.*, e.g. context.req.body.status === "paid".', { maxLength: 2000 }),
    statement: S.str('The condition in plain English, e.g. "Status is paid".', { maxLength: 200 }),
    disable: S.bool('Turn the condition off (every run continues); the condition is kept so it can be switched on again.'),
    remove: S.bool('Delete the condition.'),
    scriptId: SCRIPT_ID_PARAM,
  }),
  danger: 'write',
  pages,
  describe: (a) => (a.remove ? 'Removing the run condition' : a.disable ? 'Turning off the run condition' : `Setting run only if ${label(a.statement, '…')}`),
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const trigger = row.json_script.trigger
    const kind = triggerKind(trigger)
    if (!trigger || !kind) throw new ToolError('The flow has no trigger yet. Set it first with vs_set_trigger.')
    if (trigger.isDrafted === true && kind !== 'cron') throw new ToolError('The app trigger is not saved yet: finish it with vs_set_trigger first.')
    if (kind === 'cron' && !isRecord(trigger.preProcess)) {
      throw new ToolError('A schedule carries no data to check. Add Get Data first (vs_set_get_data), then set the condition on its output.')
    }
    const existing = asRecord(trigger.preCondition)
    if (a.disable || a.remove) {
      if (a.condition !== undefined || a.statement !== undefined) fail(['disable and remove take no condition.'])
      if (!Object.keys(existing).length) return { changed: false, message: 'The flow has no run condition.' }
      await ctx.vs.mutate(t.scriptId, async () => {
        await ctx.vs.alignOrg(ctx.signal)
        await getFlow(ctx, t)
        if (a.remove) await deletePreprocess(ctx, t, { preCondition: true }, 'Removing the run condition')
        // The server replaces preCondition whole, so the condition itself is sent again to keep it.
        else await postPreprocess(ctx, t, { preCondition: { ...existing, conditionEnabled: false } }, 'Turning off the run condition')
      })
      return { changed: true, runIf: a.remove ? 'removed' : 'off', ...panelResult(await openTriggerFeaturePanel(ctx, t.scriptId, kind, 'runIfCondition')) }
    }

    const condition = (a.condition ?? '').trim()
    const statement = (a.statement ?? '').trim()
    const problems: string[] = []
    if (!condition) problems.push('condition is required: an enabled empty condition skips EVERY run. To stop checking, use disable.')
    if (!statement) problems.push('statement is required: the condition in plain English, shown to the user.')
    if (condition) problems.push(...runIfProblems(condition), ...runIfUnsafe(condition))
    if (condition && !problems.length && !chainsInCode(condition).length) {
      problems.push('the condition never reads the request (context.req.*), so it always gives the same answer; compare a real field from vs_get_variables')
    }
    if (problems.length) fail(problems)

    // Checked against what the condition really sees: the body after Get Data and the loop (one item).
    const cat = await buildCatalogue(ctx, t, row, { at: 'insert', parent: 'root', atStart: true })
    const check = checkMappings([{ where: 'condition', text: condition, mode: 'code' }], cat, { allowDocumented: false })
    if (check.problems.length) fail(check.problems)

    const src = cat.byId.get('trigger')
    let sampleResult: boolean | undefined
    if (usable(src, false)) {
      const req = { body: src?.data ?? {}, query: isRecord(src?.query) ? src?.query : {}, headers: asRecord(src?.headers) }
      await ctx.vs.alignOrg(ctx.signal)
      const res = await executeDryRun(ctx, t, { type: 'function', code: `return (${condition});`, name: 'test', variables: { context: { req } }, isUserOnDh: false }, 'Checking the condition')
      if (!res.success) {
        fail([`the condition fails on the real sample (${maybeRedactText(dryRunErrorText(res.message), ctx.stripRunData, 300) ?? 'error'}); a failing condition skips every run. Use optional chaining (?.) for fields that may be missing.`])
      }
      sampleResult = !!res.message
    }
    await ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const cur = (await getFlow(ctx, t)).json_script.trigger
      if (triggerKind(cur) !== kind) throw new ToolError('The trigger changed meanwhile; nothing was saved.')
      await postPreprocess(ctx, t, { preCondition: { conditionEnabled: true, code: condition, _code: condition, statement, steps: '3' } }, 'Saving the run condition')
    })
    const looped = asRecord(trigger.loops).loopsEnabled === true
    return {
      saved: true,
      condition,
      statement,
      withSample: sampleResult === undefined ? undefined : sampleResult ? 'the latest sample would RUN the flow' : 'the latest sample would SKIP the run',
      note: looped ? 'Checked once per item (the loop is on).' : undefined,
      ...panelResult(await openTriggerFeaturePanel(ctx, t.scriptId, kind, 'runIfCondition')),
      next:
        sampleResult === false
          ? 'Tell the user the current sample would be skipped and confirm that is intended.'
          : 'Skipped runs are still logged with "Flow execution skipped due to pre-condition failure".',
    }
  },
})

export const TRIGGER_FEATURE_TOOLS: Tool<any>[] = [setGetData, setTriggerLoop, setRunCondition]

/** For tests: forget session state. */
export function resetTriggerFeatureState(): void {
  pendingGetData.clear()
}
