// Background handler for the JS step "Subfunctions & Actions" panel (content/subfunctions-ui.ts).
//
// The panel lets the user pick an app action, a connection and input values, and inserts
// `await <name>({ inputData: {...} })` into the step code while registering <name> in the step's `subfunctions`.
// Every viaSocket call goes through the tab's ViaSocketClient and the same catalog / connection / field / step-body
// helpers the agent's tools use, so the panel gets the same env handling, token handling and per-flow write queue.
//
// The inputs form follows the step panel: the action's inputjson is sent as a form spec (never the app's own code),
// and dynamic choices and generated input-group fields are loaded here by running the field's `source` from the
// action row, with a connection that is checked to belong to this app in this workspace.

import {
  NO_AUTH_ID,
  ROW_ID_RE,
  type SubfnAction,
  type SubfnActionDetail,
  type SubfnConnection,
  type SubfnFieldSpec,
  type SubfnForm,
  type SubfnGroupResult,
  type SubfnOptionsResult,
  type SubfnRequest,
  type SubfnResponse,
  type SubfunctionRef,
} from '../shared/subfunctions'
import { fieldDeps } from '../shared/field-rules'
import { isSubfunctionName } from '../shared/subfunctions-parser'
import { getClientForSender } from './step-clipboard'
import { SCRIPT_ID_RE, STEP_ID_RE } from './tools/ids'
import type { VsContext } from './tools/types'
import { getActionRow, listActions, normalizeInputJson, searchApps, type ActionRow } from './tools/flow/catalog'
import { connectUrl, listConnections, resolveConnection, summarizeConnection } from './tools/flow/connections'
import { ToolError } from './tools/flow/errors'
import { isInputGroup, loadFieldOptions, loadGroupFields, mergeGroup, staticOptions } from './tools/flow/fields'
import { getFlow, getFunctionRow } from './tools/flow/flow-api'
import { encodeInputData } from './tools/flow/input-data'
import { dynamicVariableProblems, isValidSlug } from './tools/flow/slugs'
import { functionBody } from './tools/flow/step-bodies'
import type { AuthData, FieldDef, FlowTarget, InputJson } from './tools/flow/types'
import { asRecord, ORG_ID_RE, PROJECT_ID_RE, str, truncate } from './tools/flow/util'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_SUBFUNCTIONS = 50
const MAX_QUERY_CHARS = 80
const MAX_OPTIONS = 300
const MAX_FIELD_KEY = 300
const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX = 60

function actionOf(r: ActionRow): SubfnAction {
  return {
    actionId: r.rowid,
    name: str(r.name) ?? 'Unnamed action',
    description: str(r.description),
    category: str(r.category),
    subCategory: str(r.sub_category),
    serviceId: str(r.pluginrecordid),
    appName: str(r.pluginname),
    iconUrl: str(r.iconurl),
    authIdLookup: str(r.authidlookup),
    actionVersionId: str(r.actionversionrecordid),
    needsConnection: !!r.authtype && r.authtype !== NO_AUTH_ID,
  }
}

// ---------- the inputs form ----------

/** An action row and the fields its input groups generated, per workspace, for this worker's lifetime. */
interface CachedAction {
  row: ActionRow
  ij: InputJson
  groups: Map<string, InputJson>
  at: number
}

const actions = new Map<string, CachedAction>()

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > CACHE_MAX) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

async function actionFor(ctx: VsContext, actionId: string): Promise<CachedAction> {
  const key = `${ctx.vs.env.apiBase}|${ctx.vs.orgId}|${actionId}`
  const hit = actions.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit
  const row = await getActionRow(ctx, actionId)
  const entry: CachedAction = { row, ij: normalizeInputJson(row.inputjson), groups: new Map(), at: Date.now() }
  remember(actions, key, entry)
  return entry
}

/** The action's inputs plus the fields its groups generated so far (a dropdown inside a generated group needs them). */
function inputsOf(a: CachedAction): InputJson {
  let ij = a.ij
  for (const [group, frag] of a.groups) if (ij.blocks[group]) ij = mergeGroup(ij, group, frag)
  return ij
}

function hasSource(def: FieldDef): boolean {
  return typeof def.source === 'string' && def.source.trim().length > 0
}

/** What the panel needs to show one field; the app's `source` code stays here. */
function specOf(key: string, def: FieldDef): SubfnFieldSpec {
  const type = (typeof def.type === 'string' && def.type ? def.type : 'string').toLowerCase()
  const spec: SubfnFieldSpec = { key, type }
  const label = str(def.label)
  if (label) spec.label = truncate(label, 120)
  if (def.required === true) spec.required = true
  if (def.list === true) spec.list = true
  if (def.help) spec.help = truncate(String(def.help).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 400)
  if (def.placeholder) spec.placeholder = truncate(String(def.placeholder), 120)
  if (isInputGroup(def)) {
    if (hasSource(def)) spec.generates = true
  } else {
    if (hasSource(def)) spec.dynamic = true
    if (def.enableSearchApi === true) spec.searchable = true
    if (type === 'dropdown' || type === 'multiselect' || type === 'hidefields') {
      const options = staticOptions(def).map((o) => ({ label: o.label, value: o.value }))
      if (options.length) spec.options = options.slice(0, MAX_OPTIONS)
    }
  }
  const deps = fieldDeps(key, def)
  if (deps.length) spec.dependsOn = deps
  if (typeof def.visibilityCondition === 'string' && def.visibilityCondition.trim()) spec.visibleWhen = def.visibilityCondition.slice(0, 2000)
  if (def.defaultValue !== undefined && def.defaultValue !== null && def.defaultValue !== '') spec.defaultValue = def.defaultValue
  if (typeof def.dateFormat === 'string' && def.dateFormat) spec.dateFormat = def.dateFormat
  return spec
}

/** The form spec of `location` ('root', or a group's key) and the groups below it, in panel order. */
function formOf(ij: InputJson, location = 'root'): SubfnForm {
  const form: SubfnForm = { steps: {}, fields: {} }
  const walk = (loc: string, depth: number) => {
    const keys = (ij.steps[loc] ?? []).filter((k) => !!ij.blocks[k])
    form.steps[loc] = keys
    for (const k of keys) {
      const def = ij.blocks[k] as FieldDef
      form.fields[k] = specOf(k, def)
      if (isInputGroup(def) && ij.steps[k] && depth < 5) walk(k, depth + 1)
    }
  }
  walk(location, 0)
  return form
}

/** Plain values from the panel, encoded the way the step panel stores them (only keys the action defines). */
function inputDataOf(values: unknown, ij: InputJson): Record<string, unknown> {
  return encodeInputData(asRecord(values), ij).inputData
}

/** The connection a field's code runs with: checked against this app's connections in this workspace. */
async function authFor(ctx: VsContext, row: ActionRow, authId: string): Promise<{ authData?: AuthData; noConnection: boolean } | string> {
  if (!row.authtype || row.authtype === NO_AUTH_ID) return { noConnection: true }
  if (!authId || authId === NO_AUTH_ID) return { noConnection: false }
  const serviceId = str(row.pluginrecordid)
  const lookup = str(row.authidlookup)
  if (!ROW_ID_RE.test(authId) || !serviceId || !lookup) return 'Choose a valid connection first.'
  try {
    return { authData: await resolveConnection(ctx, authId, serviceId, lookup), noConnection: false }
  } catch (e) {
    if (e instanceof ToolError) return 'This connection cannot be used (expired, or not one of this app’s connections). Pick or connect another.'
    throw e
  }
}

// ---------- save ----------

function subfunctionsOf(v: unknown): SubfunctionRef[] | string {
  if (!Array.isArray(v)) return 'subfunctions must be a list'
  if (v.length > MAX_SUBFUNCTIONS) return `At most ${MAX_SUBFUNCTIONS} subfunctions per step`
  const out: SubfunctionRef[] = []
  const names = new Set<string>()
  for (const item of v) {
    const r = asRecord(item)
    const name = str(r.name) ?? ''
    const actionId = str(r.actionId) ?? ''
    const authId = str(r.authId) ?? ''
    if (!isSubfunctionName(name)) return `"${name.slice(0, 40)}" is not a usable function name`
    if (names.has(name.toLowerCase())) return `Two subfunctions are named "${name}"`
    if (!ROW_ID_RE.test(actionId)) return `Subfunction "${name}" has no valid action`
    if (authId !== NO_AUTH_ID && !ROW_ID_RE.test(authId)) return `Subfunction "${name}" has no connection`
    names.add(name.toLowerCase())
    out.push({ name, actionId, authId })
  }
  return out
}

// ---------- requests ----------

export async function handleSubfunctionsRequest(req: SubfnRequest, sender: chrome.runtime.MessageSender): Promise<SubfnResponse> {
  const vs = await getClientForSender(sender)
  if (!vs) return { ok: false, error: 'Could not connect to viaSocket for this page' }
  const ctx: VsContext = { vs, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  if (!vs.orgId || !ORG_ID_RE.test(vs.orgId)) return { ok: false, error: 'Open a viaSocket workspace first' }

  try {
    switch (req.type) {
      case 'subfn:search-apps': {
        const query = typeof req.query === 'string' ? req.query.trim().slice(0, MAX_QUERY_CHARS) : ''
        if (!query) return { ok: true, data: [] }
        const rows = await searchApps(ctx, query, 30)
        const apps = rows
          .filter((r) => typeof r.serviceId === 'string' && ROW_ID_RE.test(r.serviceId) && typeof r.name === 'string')
          .map((r) => ({ serviceId: r.serviceId as string, name: r.name as string, description: str(r.description), domain: str(r.domain) }))
        return { ok: true, data: apps }
      }

      case 'subfn:list-actions': {
        if (!ROW_ID_RE.test(req.serviceId)) return { ok: false, error: 'Unknown app' }
        const rows = await listActions(ctx, req.serviceId, 'action')
        // A subfunction runs the action's component + perform code. Custom actions are API-request definitions (the
        // editor turns them into API steps) with no perform code, so as a subfunction they would do nothing.
        return { ok: true, data: rows.filter((r) => r.type !== 'custom_action' && r.type !== 'custom_api').map(actionOf) }
      }

      case 'subfn:get-action': {
        if (!ROW_ID_RE.test(req.actionId)) return { ok: false, error: 'Unknown action' }
        const a = await actionFor(ctx, req.actionId).catch(() => null)
        if (!a) return { ok: false, error: 'This action is no longer available in this workspace' }
        const detail: SubfnActionDetail = { ...actionOf(a.row), form: formOf(a.ij) }
        return { ok: true, data: detail }
      }

      case 'subfn:field-options':
      case 'subfn:group-fields': {
        if (!ROW_ID_RE.test(req.actionId)) return { ok: false, error: 'Unknown action' }
        const key = req.type === 'subfn:field-options' ? req.fieldKey : req.groupKey
        if (typeof key !== 'string' || !key || key.length > MAX_FIELD_KEY) return { ok: false, error: 'Unknown field' }
        const flow = flowOf(vs.page)
        if (!flow) return { ok: false, error: 'Open the flow in this tab first' }
        const a = await actionFor(ctx, req.actionId)
        const ij = inputsOf(a)
        const def = ij.blocks[key]
        if (!def || !hasSource(def)) return { ok: false, error: 'This field has no choices to load' }
        const auth = await authFor(ctx, a.row, typeof req.authId === 'string' ? req.authId : '')
        if (typeof auth === 'string') return { ok: false, error: auth }
        const r = {
          ij,
          fieldKey: key,
          authData: auth.authData,
          noConnection: auth.noConnection,
          inputData: inputDataOf(req.values, ij),
          actionVersionId: str(a.row.actionversionrecordid) ?? a.row.rowid,
          isTrigger: false,
        }
        if (req.type === 'subfn:field-options') {
          const search = typeof req.search === 'string' ? req.search.slice(0, 200) : undefined
          const res = await loadFieldOptions(ctx, flow, { ...r, search }, MAX_OPTIONS)
          const data: SubfnOptionsResult = {
            options: res.options.map((o) => ({ label: o.label, value: o.value })),
            more: res.more,
            help: res.help,
            needsFirst: res.needsFirst,
            needsConnection: res.needsConnection,
            error: res.error,
          }
          return { ok: true, data }
        }
        const res = await loadGroupFields(ctx, flow, r)
        const data: SubfnGroupResult = { needsFirst: res.needsFirst, needsConnection: res.needsConnection, error: res.error }
        if (res.fields) {
          a.groups.set(key, res.fields)
          data.form = formOf(mergeGroup(ij, key, res.fields), key)
        }
        return { ok: true, data }
      }

      case 'subfn:list-connections': {
        if (!ROW_ID_RE.test(req.serviceId) || !ROW_ID_RE.test(req.authIdLookup)) return { ok: false, error: 'Unknown app' }
        const rows = await listConnections(ctx, req.serviceId, req.authIdLookup)
        const list: SubfnConnection[] = rows.map((c) => {
          const s = summarizeConnection(c)
          return { id: c.id, label: str(s.name), valid: s.valid === true }
        })
        return { ok: true, data: list }
      }

      case 'subfn:connect': {
        if (!ROW_ID_RE.test(req.serviceId) || !ROW_ID_RE.test(req.authIdLookup)) return { ok: false, error: 'Unknown app' }
        if (req.actionVersionId !== undefined && !ROW_ID_RE.test(req.actionVersionId)) return { ok: false, error: 'Unknown action' }
        const flow = flowOf(vs.page)
        const url = await connectUrl(ctx, vs.page.host, req, flow ?? undefined)
        await chrome.tabs.create({ url: url.href, active: true, ...(sender.tab?.id !== undefined ? { openerTabId: sender.tab.id } : {}) })
        return { ok: true, data: null }
      }

      case 'subfn:save':
        return await save(ctx, req)

      default:
        return { ok: false, error: 'Unknown request' }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function flowOf(page: { orgId?: string; projectId?: string; scriptId?: string }): FlowTarget | null {
  const { orgId, projectId, scriptId } = page
  if (!orgId || !projectId || !scriptId) return null
  if (!ORG_ID_RE.test(orgId) || !PROJECT_ID_RE.test(projectId) || !SCRIPT_ID_RE.test(scriptId)) return null
  return { orgId, projectId, scriptId }
}

async function save(ctx: VsContext, req: Extract<SubfnRequest, { type: 'subfn:save' }>): Promise<SubfnResponse> {
  const flow = flowOf(ctx.vs.page)
  // Only the flow open in the sender tab, and only its open step.
  if (!flow || req.scriptId !== flow.scriptId) return { ok: false, error: 'Open the flow in this tab first' }
  if (!STEP_ID_RE.test(req.stepId) || !isValidSlug(req.slugName)) return { ok: false, error: 'This step cannot be edited here' }
  if (typeof req.code !== 'string') return { ok: false, error: 'The step has no code' }
  const subfunctions = subfunctionsOf(req.subfunctions)
  if (typeof subfunctions === 'string') return { ok: false, error: subfunctions }
  const shownVars = req.dynamicVariables && typeof req.dynamicVariables === 'object' ? req.dynamicVariables : undefined
  const varProblems = shownVars ? dynamicVariableProblems(shownVars) : []
  if (varProblems.length) return { ok: false, error: varProblems.join('; ') }

  const vs = ctx.vs
  await vs.mutate(flow.scriptId, async () => {
    await vs.alignOrg(ctx.signal, { force: true })
    const blocks = (await getFlow(ctx, flow)).json_script.blocks
    const block = blocks[req.slugName]
    if (!block || block.type !== 'function') throw new Error(`"${req.slugName}" is not a JS code step in this flow`)
    if (typeof block.identifier === 'string' && block.identifier !== req.stepId) throw new Error('The open step changed; reopen it and try again')
    // The flow keeps one connection per subfunction NAME (metadata.drafted.allauthids[name]), so the same name in two
    // steps with different connections would make one of them load the wrong (or no) connection at run time.
    for (const [slug, other] of Object.entries(blocks)) {
      if (slug === req.slugName || other.status === 'DELETE' || !Array.isArray(other.subfunctions)) continue
      for (const theirs of other.subfunctions) {
        const r = asRecord(theirs)
        const clash = subfunctions.find((s) => s.name === r.name && s.authId !== r.authId)
        if (clash) throw new Error(`Step "${slug}" already has a subfunction named "${clash.name}" with another connection. Pick a different name.`)
      }
    }

    // A PUT without dynamicVariables wipes the step's Input Values, so they are always sent: as the panel shows
    // them, else as saved. The step's own connection and description are kept by the backend when left out.
    const dynamicVariables = shownVars ?? asRecord((await getFunctionRow(ctx, flow, req.stepId))?.metadata?.drafted?.dynamicVariables)
    const body = functionBody({ stepId: req.stepId, title: req.slugName }, req.code, { dynamicVariables })
    body.subfunctions = subfunctions
    await vs.request({
      method: 'PUT',
      path: `/scripts/${flow.scriptId}/stepv2/${encodeURIComponent(req.slugName)}`,
      body,
      live: true,
      signal: ctx.signal,
    })
  })
  return { ok: true, data: null }
}
