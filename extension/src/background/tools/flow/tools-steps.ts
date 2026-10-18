// Step tools: add, update, delete and move steps of a flow's draft.
//
// Every write goes through ctx.vs.mutate(scriptId) (the backend rewrites the whole flow per request), re-reads the
// flow inside the queue, aligns the token org first and sends live:true so the open editor applies the change.
//
// App steps follow the panel's rules (configure.ts): a step is saved only with its connection and every required
// field, dropdowns take real choices, and mappings must be backed by real samples (mapping.ts). A new step is added
// only after the trigger and the steps before it are finished.

import type { Tool, ToolContext } from '../types'
import {
  CREDITS_NOTE, delayField, delayValue, documentedSample, findField, getActionRowAny, HIDDEN_AUTH_KINDS, identifySpecial, kindFromStep, knownKind, paidAction,
  paidFlowsBlocked, rememberBuiltin, resolveSpecial, verifyCreated, type SpecialKind,
} from './builtins'
import { normalizeInputJson, type ActionRow } from './catalog'
import { configure, type Configured } from './configure'
import { resolveConnection } from './connections'
import { call, isAbortError, ToolError } from './errors'
import {
  choiceKeys, clearPending, holdValues, loadFieldOptions, mergePending, stepKey, withDynamicInput, type AppliedDefault, type NeedInput, type SavedState,
} from './fields'
import {
  descendants, editorParam, findParent, getFlow, getFunctionRow, listFunctionRows, liveUnlessEditorOpen, normalizeFlow, openPanel, orphanBlocks,
  panelResult, pluginDataOf, refreshEditorIfOpen, resolveFlow, slugForStepId, triggerKind, type EditorSync,
} from './flow-api'
import { knownFlowProject } from './known'
import { encodeInputData } from './input-data'
import { checkCommentText, checkExpression, checkFunctionCode, checkTemplateText } from './js-check'
import { checkMappings, closestInserts, dynamicVariableTexts, inputDataTexts, mightReference, type MapText } from './mapping'
import { buildCatalogue, compactSample, deepEqual, usable, type Catalogue, type Position } from './samples'
import { defineTool, params, S } from './schema'
import { dynamicVariableProblems, isValidSlug, stepSlug } from './slugs'
import {
  apiBody, breakBody, buildApiCode, commentBody, functionBody, ifBlockBody, pluginBody, putStep, responseBody, variableBody,
  type ApiSpec, type Pair, type SaveCommon,
} from './step-bodies'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, Block, FlowRow, FlowTarget, JsonScript, PluginData } from './types'
import { asRecord, AUTH_ID_RE, FLOW_PAGES, isRecord, label, MASK, parseMaybeJson, prefixedStepId, ROW_ID_RE, SLUG_RE, str, truncate } from './util'

/** App-action steps, including the editor's built-in tools that are app actions underneath. */
const PLUGIN_LIKE = new Set(['plugin', 'delay', 'approval', 'ai_agent', 'flow_in_flow'])
/** Steps that take a title (the slug later steps reference). */
const NAMED = new Set([...PLUGIN_LIKE, 'function', 'api', 'variable'])
const SPECIAL_NAMES: Record<SpecialKind, string> = {
  delay: 'Delay',
  approval: 'Human Intervention',
  ai_agent: 'Call AI Agent (Instant)',
  ai_agent_background: 'Call AI Agent (Background)',
  flow_in_flow: 'Flow in Flow',
  memory: 'Workspace Memory',
}
const SPECIAL_TITLES: Partial<Record<SpecialKind, string>> = { delay: 'Delay', approval: 'Human_Intervention', flow_in_flow: 'Flow_in_Flow' }

const pages = [...FLOW_PAGES]
const NO_AUTH: AuthData = { id: 'NoAuth', type: 'NoAuth' }
const DATA_STEPS = new Set(['plugin', 'function', 'api', 'variable'])

type AddType = 'plugin' | 'delay' | 'approval' | 'ai_agent' | 'flow_in_flow' | 'function' | 'api' | 'variable' | 'condition' | 'branch' | 'comment' | 'break'

interface StepFields {
  description?: string
  connectionId?: string
  inputData?: Record<string, unknown>
  customInput?: string[]
  code?: string
  /** null removes a saved name on update */
  dynamicVariables?: Record<string, string | null>
  url?: string
  method?: string
  headers?: Pair[]
  queryParams?: Pair[]
  bodyType?: ApiSpec['bodyType']
  body?: string
  formFields?: Pair[]
  expression?: string
  condition?: string
  statement?: string
  text?: string
  allowDocumentedSample?: boolean
  duration?: number
  unit?: 'minutes' | 'hours' | 'days'
  until?: string
  delayFrom?: string
  agentId?: string
  message?: string
  conversationId?: string
  targetScriptId?: string
}

const REFS =
  'References must be real paths from vs_get_variables (trigger context.req.body.<field>, earlier step context.res.<StepSlug>.<field>, variable context.vals.<slug>); unknown paths are refused.'

const STEP_FIELDS = {
  description: S.str('Short description shown on the step.', { maxLength: 300 }),
  connectionId: S.str('App steps: connection id from vs_list_connections or vs_connect_app.', { pattern: AUTH_ID_RE.source }),
  inputData: S.map(
    'App steps: field values keyed by the exact field keys from vs_get_action. Text values are template strings: insert data only with insert texts copied from vs_get_variables, e.g. ${context.req.body.comment_id} (never typed paths, never backticks). Lists are arrays, booleans true/false, dropdowns the value of a choice from vs_get_field_options. null clears a field.',
  ),
  customInput: S.strs(
    'App steps: field keys whose value the user typed themselves and wants kept as typed (free text in a dropdown, or text such as {{name}} meant for the receiving app). Never for guesses.',
  ),
  code: S.str(
    `Function steps: JavaScript body of an async function. Read data with bare paths (no \${}), may use await, axios and fetch, and MUST return the step output. ${REFS}`,
    { maxLength: 100000 },
  ),
  // No value schema, so null can remove a name; values are checked in checkFields.
  dynamicVariables: S.map(
    `Function/API steps: named constants available inside the code, e.g. {"region":"eu"}; values are strings. Never secrets: keys belong in a connection, or let the user type them in the panel. On update they are merged into the saved ones: null removes a name, and a masked "${MASK}" value keeps the saved one.`,
  ),
  url: S.str('API steps: request URL; may contain ${context...} references.', { maxLength: 2000 }),
  method: S.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'API steps: HTTP method.'),
  headers: S.pairs(
    `API steps: request headers (replaces the whole list; a masked "${MASK}" value keeps the saved one). Content-Type: application/json is added automatically.`,
  ),
  queryParams: S.pairs(`API steps: query string parameters (replaces the whole list; a masked "${MASK}" value keeps the saved one).`),
  bodyType: S.enum(
    ['json', 'form', 'multipart', 'none'],
    'API steps: body encoding (json when body is given). To switch between json and form/multipart, also pass body or formFields; "none" removes the body.',
  ),
  body: S.str(
    'API steps with bodyType json: a JavaScript expression that is evaluated and JSON-encoded at run time (not a JSON string), e.g. { name: context.req.body.name, total: context.vals.total }.',
    { maxLength: 20000 },
  ),
  formFields: S.pairs(
    `API steps with bodyType form or multipart: fields (replaces the whole list; a masked "${MASK}" value keeps the saved one); values may contain \${context...}.`,
  ),
  expression: S.str(`Variable steps: JavaScript expression stored as context.vals.<slug>, e.g. context.req.body.email.toLowerCase(). ${REFS}`, {
    maxLength: 5000,
  }),
  condition: S.str('Condition and branch steps: JavaScript boolean expression, e.g. context.req.body.amount > 1000.', { maxLength: 5000 }),
  statement: S.str('Condition and branch steps: short human wording of the condition shown on the canvas.', { maxLength: 200 }),
  text: S.str('Comment steps: the note text. Break steps: optional JavaScript expression returned when the flow stops there.', {
    maxLength: 5000,
  }),
  allowDocumentedSample: S.bool(
    "Only after the user declined vs_test_step for an earlier step: map from that step's documented example output. Never for the trigger. Say so to the user.",
  ),
  duration: { type: 'number', minimum: 0, description: 'Delay steps: how long to wait, with unit (1 minute to 30 days).' },
  unit: S.enum(['minutes', 'hours', 'days'], 'Delay steps: unit of duration (default minutes).'),
  until: S.str('Delay steps: wait until this ISO date-time with offset, e.g. 2026-12-01T09:00:00+05:30 (at most 30 days ahead).', { maxLength: 40 }),
  delayFrom: S.str('Delay steps: an insert text from vs_get_variables holding a number of minutes, e.g. ${context.res.Compute_Wait.minutes}.', { maxLength: 300 }),
  agentId: S.str('AI agent steps: the value of an agent from vs_list_ai_agents.', { maxLength: 200 }),
  message: S.str('AI agent steps: the user message sent to the agent; may contain insert texts, e.g. "Reply to ${context.req.body.text}".', { maxLength: 20000 }),
  conversationId: S.str('AI agent steps: optional conversation id that keeps history across runs; may be an insert text.', { maxLength: 500 }),
  targetScriptId: S.str('Flow in Flow steps: the flow to run (scriptId from vs_list_flows; not this flow).', { pattern: '^[A-Za-z0-9]{12}$' }),
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Client-side checks that need no network, so a bad request never creates a half-configured step. */
function checkFields(f: StepFields): { problems: string[]; warnings: string[] } {
  const problems: string[] = []
  const warnings: string[] = []
  if (f.code !== undefined) {
    const r = checkFunctionCode(f.code)
    if (r.error) problems.push(`code: ${r.error}`)
    if (r.warning) warnings.push(r.warning)
  }
  problems.push(...dynamicVariableProblems(f.dynamicVariables))
  if (f.duration !== undefined || f.until !== undefined || f.delayFrom !== undefined) {
    const dv = delayValue(f)
    if ('error' in dv) problems.push(`delay: ${dv.error}.`)
  }
  for (const [k, v] of [
    ['message', f.message],
    ['conversationId', f.conversationId],
    ['delayFrom', f.delayFrom],
  ] as const) {
    const p = v !== undefined ? checkTemplateText(v) : undefined
    if (p) problems.push(`${k}: ${p}`)
  }
  if (f.expression !== undefined) {
    const p = checkExpression(f.expression)
    if (p) problems.push(`expression: ${p}`)
  }
  if (f.condition !== undefined) {
    const p = checkExpression(f.condition)
    if (p) problems.push(`condition: ${p}`)
  }
  return { problems, warnings }
}

function fail(problems: string[]): never {
  throw new ToolError(`Nothing was changed. Fix these first: ${problems.join(' | ')}`)
}

/** Every value that may reference data, with how it is evaluated (template text or JavaScript). */
function mappingTexts(f: StepFields & { responseBody?: string }, blockType: string | undefined, literal: ReadonlySet<string> = new Set()): MapText[] {
  const out: MapText[] = [...inputDataTexts(f.inputData, 'inputData', new Set([...(f.customInput ?? []), ...literal]))]
  if (f.url !== undefined) out.push({ where: 'url', text: f.url, mode: 'template' })
  const lists: Array<[Pair[] | undefined, string]> = [
    [f.headers, 'headers'],
    [f.queryParams, 'queryParams'],
    [f.formFields, 'formFields'],
  ]
  for (const [list, name] of lists) for (const p of list ?? []) out.push({ where: `${name}.${p.name}`, text: p.value, mode: 'template' })
  if (f.body !== undefined) out.push({ where: 'body', text: f.body, mode: 'code' })
  out.push(...dynamicVariableTexts(f.dynamicVariables))
  for (const [k, v] of [
    ['message', f.message],
    ['conversationId', f.conversationId],
    ['delayFrom', f.delayFrom],
  ] as const) {
    if (v !== undefined) out.push({ where: k, text: v, mode: 'template' })
  }
  if (f.code !== undefined) out.push({ where: 'code', text: f.code, mode: 'code' })
  if (f.expression !== undefined) out.push({ where: 'expression', text: f.expression, mode: 'code' })
  if (f.condition !== undefined) out.push({ where: 'condition', text: f.condition, mode: 'code' })
  if (f.text !== undefined && blockType === 'break') out.push({ where: 'text', text: f.text, mode: 'code' })
  if (f.responseBody) out.push({ where: 'responseBody', text: f.responseBody, mode: 'code' })
  return out
}

/** Stored field values without the editor's companion keys (_x, x-Type, x_extraValue, hookUrl). */
function fieldValues(inputData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputData)) {
    if (k.startsWith('_') || k.endsWith('-Type') || k.includes('["_') || k.endsWith('_extraValue') || k === 'hookUrl') continue
    out[k] = v
  }
  return out
}

/** The values a save body makes the step evaluate (all of them, saved ones included), for the mapping check. */
function bodyTexts(type: string, body: Record<string, unknown>, literal: ReadonlySet<string>): MapText[] {
  const out: MapText[] = []
  const vars = (v: unknown) => {
    out.push(...dynamicVariableTexts(asRecord(v)))
  }
  switch (type) {
    case 'plugin': {
      const code = asRecord(body.code)
      const values = fieldValues(asRecord(asRecord(code.selectedValues).inputData))
      // Dropdown values are checked against their choices instead (and free text the user typed is kept as typed).
      const custom = new Set([...literal, ...choiceKeys(normalizeInputJson(code.inputJson))])
      return inputDataTexts(values, 'inputData', custom)
    }
    case 'api': {
      const code = asRecord(body.code)
      const post = asRecord(code.postData)
      if (typeof code.url === 'string') out.push({ where: 'url', text: code.url, mode: 'template' })
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
      vars(body.dynamicVariables)
      return out
    }
    case 'function':
      if (typeof body.code === 'string') out.push({ where: 'code', text: body.code, mode: 'code' })
      vars(body.dynamicVariables)
      return out
    case 'variable':
    case 'break':
    case 'response':
      if (typeof body.data === 'string' && body.data.trim()) out.push({ where: type === 'variable' ? 'expression' : type === 'break' ? 'text' : 'responseBody', text: body.data, mode: 'code' })
      return out
    case 'ifBlock':
      if (typeof body.condition === 'string' && body.condition.trim()) out.push({ where: 'condition', text: body.condition, mode: 'code' })
      return out
    default:
      return out
  }
}

type LazyCatalogue = () => Promise<Catalogue>

function lazyCatalogue(ctx: ToolContext, t: FlowTarget, row: FlowRow, pos: Position): LazyCatalogue {
  let p: Promise<Catalogue> | undefined
  return () => (p ??= buildCatalogue(ctx, t, row, pos))
}

const LITERAL_HINT = 'If a flagged text is meant literally because the user typed it (for example a merge tag the receiving app fills in), list that field in customInput.'

/**
 * Refuses mappings that are not backed by real sample data at this position (see mapping.ts). Returns the sources
 * mapped from documented examples (after a declined test), which the caller reports.
 */
async function guardMappings(js: JsonScript, getCat: LazyCatalogue, texts: MapText[], allowDocumented: boolean, saved = false): Promise<string[]> {
  if (!texts.length || !mightReference(texts, js)) return []
  const r = checkMappings(texts, await getCat(), { allowDocumented })
  if (r.problems.length) {
    const what = saved
      ? "Nothing was changed. The step's saved values (kept by this update) include mappings that are not backed by real sample data; fix them in this same call"
      : 'Nothing was changed. These mappings are not backed by real sample data (never guess a path; copy insert texts from vs_get_variables)'
    throw new ToolError(`${what}: ${r.problems.join(' | ')}. ${LITERAL_HINT}`)
  }
  return r.documentedUsed
}

function documentedNote(used: string[]): string | undefined {
  return used.length
    ? `Mapped from the documented example (not a real test) of: ${used.join(', ')}, because the user declined testing it. Tell the user these fields may not match real data.`
    : undefined
}

/** Panel to open for a step: its own, the first branch of a new condition, none for notes and stops. */
function openStepPanel(ctx: ToolContext, t: FlowTarget, block: Block | undefined, slug: string): Promise<EditorSync> {
  if (!block?.identifier || block.type === 'comment' || block.type === 'break' || block.type === 'ifGroup') {
    return Promise.resolve({ delivered: false, skipped: true })
  }
  return openPanel(ctx, t.scriptId, block.identifier, slug)
}

/** A plugin step that cannot be saved yet: the result tells the model what to ask or connect. */
class IncompleteStep extends Error {
  constructor(readonly result: Record<string, unknown>) {
    super('incomplete')
  }
}

/**
 * For free-text fields still empty: insert texts of tested data whose names match, so a field such as Comment ID is
 * mapped from the trigger rather than asked of the user, and a hint when the trigger is not tested yet.
 */
async function withCandidates(needs: NeedInput[], getCat: LazyCatalogue): Promise<NeedInput[]> {
  const free = needs.filter((n) => !n.hasOptions && !n.generatesFields)
  if (!free.length) return needs
  let cat: Catalogue
  try {
    cat = await getCat()
  } catch (e) {
    if (isAbortError(e)) throw e
    return needs
  }
  const triggerReady = usable(cat.byId.get('trigger'), false)
  return needs.map((n) => {
    if (n.hasOptions || n.generatesFields) return n
    const names = [n.key, ...(n.label ? [n.label.trim().replace(/\s+/g, '_')] : [])]
    const found = new Set<string>()
    for (const name of names) for (const ins of closestInserts(cat, ['', '', name], false, 3, 4.5)) found.add(ins)
    const candidateInserts = [...found].slice(0, 3)
    if (candidateInserts.length) {
      return { ...n, candidateInserts, hint: `It likely comes from earlier data: map it with one of candidateInserts if that matches what the user wants; otherwise ${n.hint.charAt(0).toLowerCase()}${n.hint.slice(1)}` }
    }
    if (!triggerReady && cat.triggerKind && cat.triggerKind !== 'cron') {
      return { ...n, hint: `If this comes from the trigger (an ID, a name, a message), test the trigger first (vs_test_trigger) and map it with an insert text; otherwise ${n.hint.charAt(0).toLowerCase()}${n.hint.slice(1)}` }
    }
    return n
  })
}

async function incompleteResult(
  slug: string,
  status: string | undefined,
  pd: PluginData,
  hasAuth: boolean,
  cfg: Configured | undefined,
  values: Record<string, unknown>,
  dropped: string[],
  getCat: LazyCatalogue,
): Promise<Record<string, unknown>> {
  const drafted = status === 'DRAFTED'
  const needs = cfg?.needs.length ? await withCandidates(cfg.needs, getCat) : undefined
  return {
    saved: false,
    slug,
    status: drafted ? 'DRAFTED' : status,
    needsConnection: hasAuth
      ? undefined
      : {
          serviceId: pd.serviceId,
          authIdLookup: pd.authIdLookup,
          actionVersionId: pd.actionVersionId,
          hint: 'Find one with vs_list_connections (ask which one if there are several); if there is none, vs_connect_app. Then call vs_update_step with connectionId.',
        },
    needsUserInput: needs,
    defaultsApplied: cfg?.defaultsApplied.length ? cfg.defaultsApplied : undefined,
    heldValues: Object.keys(values).length ? Object.keys(values) : undefined,
    droppedHeld: dropped.length ? { keys: dropped, why: 'changed in the panel since they were given, so the panel values are kept' } : undefined,
    warnings: cfg?.warnings.length ? cfg.warnings : undefined,
    next: `${drafted ? `"${slug}" stays an unsaved draft.` : `Nothing was changed: "${slug}" keeps its saved values.`} Ask the user for each missing item, one short question at a time (offer the real choices from vs_get_field_options; map data only with insert texts from vs_get_variables), then call vs_update_step with slugName "${slug}". Values given so far are kept.`,
  }
}

/**
 * Saved dynamic variables with the given ones merged in: null removes a name and a masked value (from vs_get_step)
 * keeps the saved one. The save replaces the whole map, so names the model did not mention must be carried over.
 */
function mergeDynamicVariables(saved: unknown, changes: StepFields['dynamicVariables']): Record<string, unknown> {
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

function apiSpec(f: StepFields): ApiSpec {
  return {
    url: f.url,
    method: f.method,
    headers: f.headers,
    queryParams: f.queryParams,
    bodyType: f.bodyType,
    body: f.body,
    formFields: f.formFields,
  }
}

function terminalItem(js: JsonScript, list: string[]): boolean {
  const last = list[list.length - 1]
  const b = last ? js.blocks[last] : undefined
  return !!b && (b.type === 'break' || b.isElseBlock === true)
}

/** Where a new step goes. The server inserts AFTER `position`; index 0 is only reachable by a reorder. */
function insertPlan(js: JsonScript, type: AddType, parent: string, afterSlug?: string, atStart?: boolean): { position?: number; reorderTo?: number } {
  const list = js.order[parent] ?? []
  if (type === 'break') {
    // Reorders later fail with 'Invalid order!' unless a break is the last item of its group.
    if (terminalItem(js, list)) throw new ToolError(`"${parent}" already ends with a break.`)
    if (atStart && list.length) throw new ToolError('A break must be the last step of its group.')
    if (afterSlug && afterSlug !== list[list.length - 1]) throw new ToolError('A break must be the last step of its group.')
    return {}
  }
  if (atStart) return list.length ? { reorderTo: 0 } : {}
  if (afterSlug) {
    const idx = list.indexOf(afterSlug)
    if (idx < 0) throw new ToolError(`"${afterSlug}" is not directly inside "${parent}". Items there: ${list.join(', ') || 'none'}.`)
    const b = js.blocks[afterSlug]
    if (b?.type === 'break') throw new ToolError('Nothing can come after a break step.')
    if (b?.isElseBlock) throw new ToolError('The else-branch must stay last.')
    return { position: idx }
  }
  // A break (or the server-managed else-branch) must stay last, so append in front of it.
  if (terminalItem(js, list)) return list.length === 1 ? { reorderTo: 0 } : { position: list.length - 2 }
  return {}
}

function checkParent(js: JsonScript, type: AddType, parent: string): void {
  if (!(parent in js.order)) {
    const branches = Object.keys(js.order).filter((k) => js.blocks[k]?.type === 'ifBlock')
    throw new ToolError(`Unknown parent "${parent}". Use "root"${branches.length ? ` or a branch: ${branches.join(', ')}` : ''}.`)
  }
  const pb = js.blocks[parent]
  if (pb?.status === 'DELETE') throw new ToolError(`"${parent}" is deleted.`)
  if (type === 'branch') {
    if (pb?.type !== 'ifGroup') throw new ToolError('For type "branch", parent must be the slug of the condition (ifGroup) to add a branch to.')
    return
  }
  if (type === 'comment' && parent !== 'root') throw new ToolError('Comments can only be added at the top level (parent "root").')
  if (parent !== 'root' && pb?.type !== 'ifBlock') throw new ToolError('parent must be "root" or the slug of a branch (ifBlock).')
}

/**
 * What must be finished before another step is added, as the build loop requires: the trigger saved and tested
 * (it delivered real data; schedules carry none), and no earlier step left as an unsaved draft.
 */
async function unfinishedBefore(js: JsonScript, getCat: LazyCatalogue): Promise<{ problems: string[]; untested: string[] }> {
  const problems: string[] = []
  const cat = await getCat()
  const kind = triggerKind(js.trigger)
  const trig = cat.byId.get('trigger')
  const getData = isRecord(js.trigger?.preProcess)
  const loopKey = asRecord(js.trigger?.preProcessFilter).type === 'filterByKey'
  if (!kind) problems.push('The flow has no trigger yet: set it up first with vs_set_trigger.')
  else if (js.trigger?.isDrafted === true && kind !== 'cron') problems.push('The app trigger is picked but not saved: finish it with vs_set_trigger (connection and required fields).')
  else if ((kind !== 'cron' || getData) && !usable(trig, false)) {
    problems.push(
      (kind === 'webhook' || kind === 'cron') && (getData || loopKey)
        ? `The data steps read is not known yet: ${trig?.note ?? 'test Get Data with vs_set_get_data action "test".'}`
        : kind === 'webhook' || kind === 'email'
          ? 'The trigger has not received a real request yet: ask the user to send one, then run vs_test_trigger.'
          : 'The trigger has not been tested yet: run vs_test_trigger (it only reads; if there is no event, ask the user to make one).',
    )
  }
  for (const s of cat.earlier) {
    const b = js.blocks[s]
    if (!b || b.status !== 'DRAFTED' || b.type === 'ifGroup' || b.type === 'comment' || b.type === 'break') continue
    problems.push(`"${s}" is an unsaved draft: finish it with vs_update_step (or delete it).`)
  }
  const untested = cat.sources.filter((src) => src.id !== 'trigger' && !usable(src, false) && !src.declined).map((src) => src.id)
  return { problems, untested }
}

async function reorder(ctx: ToolContext, t: FlowTarget, slug: string, parent: string, newIndex: number): Promise<void> {
  await call(`Moving step "${slug}"`, () =>
    ctx.vs.request({
      method: 'POST',
      path: `/scripts/${t.scriptId}/reorder/${encodeURIComponent(slug)}`,
      body: { parent, newIndex },
      live: true,
      signal: ctx.signal,
    }),
  )
}

const ID_PREFIX: Record<AddType, 'func' | 'vari' | 'ifcb' | 'swtc' | 'cmnt' | 'btkc'> = {
  plugin: 'func',
  delay: 'func',
  approval: 'func',
  ai_agent: 'func',
  flow_in_flow: 'func',
  function: 'func',
  api: 'func',
  variable: 'vari',
  condition: 'swtc',
  branch: 'ifcb',
  comment: 'cmnt',
  break: 'btkc',
}

interface AddStepArgs extends StepFields {
  type: AddType
  title?: string
  actionId?: string
  background?: boolean
  parent?: string
  afterSlug?: string
  atStart?: boolean
  skipPreviousCheck?: boolean
  scriptId?: string
}

function precheckAdd(a: AddStepArgs): string[] {
  const { problems, warnings } = checkFields(a)
  for (const [k, v] of Object.entries(a.dynamicVariables ?? {})) {
    if (v === MASK) problems.push(`dynamicVariables.${k}: a new step has no saved value to keep; ask the user for it.`)
  }
  const need = (cond: boolean, msg: string) => {
    if (!cond) problems.push(msg)
  }
  switch (a.type) {
    case 'plugin':
      need(!!a.actionId, 'actionId is required for app steps (from vs_list_app_actions or vs_list_builtin_tools).')
      break
    case 'delay':
      need(a.duration !== undefined || a.until !== undefined || a.delayFrom !== undefined, 'say how long to wait: duration (with unit), until, or delayFrom.')
      break
    case 'approval':
    case 'ai_agent':
    case 'flow_in_flow':
      break
    case 'function':
      need(!!a.title, 'title is required.')
      need(a.code !== undefined, 'code is required for function steps.')
      break
    case 'api': {
      need(!!a.title, 'title is required.')
      const { problems: p } = buildApiCode(apiSpec(a), {})
      problems.push(...p)
      break
    }
    case 'variable':
      need(!!a.title, 'title is required (it becomes the variable name).')
      need(a.expression !== undefined, 'expression is required for variable steps.')
      break
    case 'condition':
    case 'branch':
      need(a.condition !== undefined, 'condition is required.')
      break
    case 'comment': {
      need(!!a.text, 'text is required for comments.')
      const p = a.text ? checkCommentText(a.text) : undefined
      if (p) problems.push(p)
      break
    }
    case 'break': {
      const p = a.text ? checkExpression(a.text) : undefined
      if (p) problems.push(`text: ${p}`)
      break
    }
  }
  if (a.title && !NAMED.has(a.type)) warnings.push(`title is ignored for ${a.type} steps.`)
  if (a.customInput?.length && !PLUGIN_LIKE.has(a.type)) warnings.push('customInput is only for app steps.')
  if (a.type !== 'delay' && (a.duration !== undefined || a.until !== undefined || a.delayFrom !== undefined)) problems.push('duration, until and delayFrom are only for type "delay".')
  if (a.type !== 'ai_agent' && (a.agentId !== undefined || a.message !== undefined || a.conversationId !== undefined || a.background !== undefined)) {
    problems.push('agentId, message, conversationId and background are only for type "ai_agent".')
  }
  if (a.type !== 'flow_in_flow' && a.targetScriptId !== undefined) problems.push('targetScriptId is only for type "flow_in_flow".')
  if (a.unit !== undefined && a.duration === undefined) warnings.push('unit is used only with duration.')
  if (problems.length) fail(problems)
  return warnings
}

/** The panel tool a new step is, from its type (or from an app action the lookups identified). */
function specialKindOf(a: AddStepArgs): SpecialKind | undefined {
  switch (a.type) {
    case 'delay':
      return 'delay'
    case 'approval':
      return 'approval'
    case 'ai_agent':
      return a.background ? 'ai_agent_background' : 'ai_agent'
    case 'flow_in_flow':
      return 'flow_in_flow'
    case 'plugin': {
      const k = knownKind(a.actionId)
      return k && k !== 'memory' ? k : undefined
    }
    default:
      return undefined
  }
}

function addFromPanelHint(kind: SpecialKind): string {
  return `Ask the user to add "${SPECIAL_NAMES[kind]}" from the Add step panel (Built-in tools); then configure it with vs_update_step.`
}

/**
 * Catalog actions that may be the panel tool (see builtins.ts), best match first; actionId picks one when there are
 * several (approval channels). The created step tells which one really is it (verifyCreated), so the next is tried
 * when one turns out wrong.
 */
async function specialCandidates(ctx: ToolContext, kind: SpecialKind, actionId: string | undefined): Promise<string[]> {
  const rows = await resolveSpecial(ctx, kind)
  if (actionId) {
    if (!rows.some((r) => r.rowid === actionId)) {
      throw new ToolError(`${actionId} is not a ${SPECIAL_NAMES[kind]} action here. Use one from vs_list_builtin_tools${rows.length ? ` (${rows.map((r) => r.rowid).join(', ')})` : ''}.`)
    }
    return [actionId]
  }
  if (!rows.length) {
    const instead = kind === 'ai_agent_background' && (await resolveSpecial(ctx, 'ai_agent')).length ? ' The Instant agent is available: use type "ai_agent" without background.' : ''
    throw new ToolError(`${SPECIAL_NAMES[kind]} was not found in this workspace's catalog.${instead} ${addFromPanelHint(kind)}`)
  }
  if (kind === 'approval' && rows.length > 1) {
    const list = rows.map((r) => `${r.rowid} (${str(r.pluginname) ?? str(r.name) ?? 'channel'})`).join(', ')
    throw new ToolError(`Human Intervention has several channels; ask the user which one and pass its actionId: ${list}.`)
  }
  // Rows already seen to be the Background agent are never tried for an Instant one.
  return rows.map((r) => r.rowid).filter((id) => !(kind === 'ai_agent' && knownKind(id) === 'ai_agent_background')).slice(0, 3)
}

/** The flow a Flow in Flow step runs, if it is this flow or a flow that runs this flow back (an endless loop). */
async function flowLoopProblem(ctx: ToolContext, t: FlowTarget, target: string | undefined): Promise<string | undefined> {
  if (!target) return undefined
  if (target === t.scriptId) return 'A flow cannot run itself with Flow in Flow (it would loop forever). Pick another flow.'
  const projectId = knownFlowProject(t.orgId, target)
  if (!projectId) return undefined
  try {
    const other = { orgId: t.orgId, projectId, scriptId: target }
    const row = await getFlow(ctx, other)
    const hasFlowStep = Object.values(row.json_script.blocks).some((b) => b.type === 'plugin' && b.status !== 'DELETE')
    if (!hasFlowStep) return undefined
    for (const fn of await listFunctionRows(ctx, other)) {
      const pd = asRecord(parseMaybeJson(fn.code))
      const values = Object.values(asRecord(asRecord(pd.selectedValues).inputData))
      if (asRecord(asRecord(pd.selectedValues).authData).hidden === true && values.includes(t.scriptId)) {
        return `That flow (${target}) already runs this flow with Flow in Flow, so the two would start each other forever. Pick another flow, or remove that step there first.`
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e
  }
  return undefined
}

/**
 * Values the convenience fields stand for, keyed by the tool's real field keys (read from the step): the Delay
 * value, the AI agent, its message and conversation id, the flow to run. display is the Delay's canvas text.
 */
function specialValues(kind: SpecialKind | undefined, ij: ReturnType<typeof normalizeInputJson>, meta: PluginData, f: StepFields): { values: Record<string, unknown>; display?: { key: string; text: string }; warnings: string[] } {
  const values: Record<string, unknown> = {}
  const warnings: string[] = []
  let display: { key: string; text: string } | undefined
  if (f.duration !== undefined || f.until !== undefined || f.delayFrom !== undefined) {
    if (kind !== 'delay') fail(['duration, until and delayFrom are only for Delay steps.'])
    const key = delayField(meta)
    if (!key || !ij.blocks[key]) throw new ToolError('This Delay step has no delay field; delete it and add it again.')
    const dv = delayValue(f)
    if ('error' in dv) fail([`delay: ${dv.error}.`])
    values[key] = dv.value
    display = { key, text: dv.display }
  }
  const put = (role: 'agent' | 'message' | 'thread' | 'flow', value: string | undefined, what: string) => {
    if (value === undefined) return
    const key = findField(ij, role)
    if (key) values[key] = value
    else warnings.push(`Could not tell which field takes the ${what}; set it with inputData using one of: ${Object.keys(ij.blocks).filter((k) => !k.includes('[')).slice(0, 15).join(', ')}.`)
  }
  put('agent', f.agentId, 'agent')
  put('message', f.message, 'message')
  put('thread', f.conversationId, 'conversation id')
  put('flow', f.targetScriptId, 'flow to run')
  return { values, display, warnings }
}

/**
 * The flow a Flow in Flow step would run, from the values being saved (targetScriptId or inputData alike): refused
 * when it is this flow or one that runs this flow back. `isFlowInFlow` false still catches this flow's own id.
 */
async function flowTargetProblem(ctx: ToolContext, t: FlowTarget, cfg: Configured, isFlowInFlow: boolean): Promise<string | undefined> {
  const key = findField(cfg.ij, 'flow')
  const value = key ? cfg.cleaned[key] : undefined
  if (typeof value !== 'string') return undefined
  if (!isFlowInFlow) return value === t.scriptId ? 'A flow cannot run itself with Flow in Flow (it would loop forever). Pick another flow.' : undefined
  return flowLoopProblem(ctx, t, value)
}

/** A draft just created as the wrong thing is removed again (drafts need no delete title). */
async function deleteDraft(ctx: ToolContext, t: FlowTarget, slug: string): Promise<void> {
  try {
    await call(`Removing draft "${slug}"`, () =>
      ctx.vs.request({ method: 'DELETE', path: `/scripts/${t.scriptId}/stepv2/${encodeURIComponent(slug)}`, live: true, signal: ctx.signal }),
    )
  } catch (e) {
    if (isAbortError(e)) throw e
  }
}

const addStep = defineTool<AddStepArgs>({
  name: 'vs_add_step',
  description: [
    'Add a step and save it. Types: "plugin" (app action or built-in app from vs_list_app_actions / vs_list_builtin_tools; field keys from vs_get_action; connectionId unless NoAuth),',
    '"delay" (duration+unit, until, or delayFrom), "approval" (Human Intervention; actionId = a channel), "ai_agent" (agentId from vs_list_ai_agents, message, conversationId; background: true waits for the answer),',
    '"flow_in_flow" (targetScriptId), "function" (JS code), "api", "variable", "condition" (if/else; then add steps with parent = the returned branch), "branch" (parent = condition), "comment", "break" (last in a branch).',
    'Placement: parent ("root" or a branch) plus afterSlug, or atStart. Refused (needsPrevious) while the trigger or an earlier step is unfinished.',
    'Incomplete app steps stay drafts and return needsConnection / needsUserInput. The returned slug is the real name (context.res.<slug>).',
  ].join(' '),
  parameters: params(
    {
      type: S.enum(['plugin', 'delay', 'approval', 'ai_agent', 'flow_in_flow', 'function', 'api', 'variable', 'condition', 'branch', 'comment', 'break'], 'Kind of step.'),
      title: S.str('Step name (app, built-in, function, api, variable). Becomes a code identifier such as Send_Slack_Message; spaces become underscores.', {
        maxLength: 60,
      }),
      actionId: S.str('plugin: actionId from vs_list_app_actions / vs_list_builtin_tools; approval: the channel actionId.', { pattern: ROW_ID_RE.source }),
      background: S.bool('ai_agent: run the agent in the background (later steps wait for its answer; not available right away).'),
      parent: S.str('"root" (default) or a branch slug; for type "branch" the condition slug.', { pattern: SLUG_RE.source }),
      afterSlug: S.str('Insert right after this step (must be directly inside parent).', { pattern: SLUG_RE.source }),
      atStart: S.bool('Insert as the first item of parent.'),
      skipPreviousCheck: S.bool('Only when the user explicitly asked to add this step before finishing the trigger or the earlier steps.'),
      ...STEP_FIELDS,
      scriptId: SCRIPT_ID_PARAM,
    },
    ['type'],
  ),
  danger: 'write',
  pages,
  describe: (a) => {
    const kind: Record<string, string> = {
      plugin: 'an app step',
      delay: 'a delay',
      approval: 'an approval step',
      ai_agent: 'an AI agent step',
      flow_in_flow: 'a Flow in Flow step',
      function: 'a code step',
      api: 'an API call',
      variable: 'a variable',
      condition: 'a condition',
      branch: 'a branch',
      comment: 'a note',
      break: 'a stop step',
    }
    return a.title && NAMED.has(a.type) ? `Adding ${label(a.title, 'a step')}` : `Adding ${kind[a.type] ?? 'a step'}`
  },
  async run(a, ctx) {
    const warnings = precheckAdd(a)
    const t = resolveFlow(ctx, a.scriptId)
    const loop = await flowLoopProblem(ctx, t, a.targetScriptId)
    if (loop) throw new ToolError(loop)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      const js = row.json_script
      const parent = a.parent ?? 'root'
      checkParent(js, a.type, parent)
      const plan = insertPlan(js, a.type, parent, a.afterSlug, a.atStart)
      const getCat = lazyCatalogue(ctx, t, row, { at: 'insert', parent, afterSlug: a.afterSlug, atStart: a.atStart })

      // One step at a time: the trigger and the steps before this one must be finished first.
      if (a.type !== 'comment' && a.type !== 'break') {
        const before = await unfinishedBefore(js, getCat)
        if (before.problems.length && a.skipPreviousCheck !== true) {
          return {
            created: false,
            needsPrevious: before.problems,
            next: 'Nothing was added. Finish these first (one at a time, asking the user where needed), then add this step. Only if the user explicitly asks to add it anyway, pass skipPreviousCheck: true.',
          }
        }
        if (before.untested.length) warnings.push(`Not tested yet: ${before.untested.join(', ')}. Test them before mapping their output.`)
      }
      let action: ActionRow | undefined
      let authData: AuthData | undefined
      let kind = specialKindOf(a)
      let hiddenAuth = !!kind && HIDDEN_AUTH_KINDS.has(kind)
      let candidates: string[] = []
      if (PLUGIN_LIKE.has(a.type)) {
        if (kind && a.type !== 'plugin') candidates = await specialCandidates(ctx, kind, a.actionId)
        action = await getActionRowAny(ctx, candidates[0] ?? a.actionId ?? '')
        if (action.type === 'trigger') throw new ToolError('That is a trigger, not an action. Use vs_set_trigger with kind "app".')
        if (action.type === 'custom_action' || action.type === 'custom_api') {
          throw new ToolError('Custom actions cannot be configured by the assistant. Add it from the "Add step" panel instead.')
        }
        const encoded = encodeInputData(a.inputData ?? {}, normalizeInputJson(action.inputjson))
        if (encoded.problems.length) fail(encoded.problems)
      }
      // Mappings are checked before anything is created, against the trigger and the steps that run before this one.
      const documentedUsed = await guardMappings(
        js,
        getCat,
        mappingTexts(a, a.type === 'condition' || a.type === 'branch' ? 'ifBlock' : a.type, action ? choiceKeys(normalizeInputJson(action.inputjson)) : undefined),
        a.allowDocumentedSample === true,
      )
      if (action) {
        if (hiddenAuth) {
          // viaSocket gives these tools their own hidden connection; never ask the user for one.
          if (a.connectionId) warnings.push('connectionId is ignored: this built-in tool uses its own connection.')
        } else if (action.authtype === 'NoAuth') authData = NO_AUTH
        else if (a.connectionId) {
          if (!action.pluginrecordid || !action.authidlookup) throw new ToolError('This action has no connection settings; it cannot be added.')
          authData = await resolveConnection(ctx, a.connectionId, action.pluginrecordid, action.authidlookup, t)
        }
      }

      const childId = a.type === 'condition' ? prefixedStepId('ifcb') : undefined
      const defaultTitle = kind ? SPECIAL_TITLES[kind] : undefined
      const wanted = PLUGIN_LIKE.has(a.type)
        ? stepSlug(a.title || defaultTitle || action?.name || 'App_step')
        : ['function', 'api', 'variable'].includes(a.type)
          ? stepSlug(a.title ?? '')
          : a.type === 'break'
            ? 'Break'
            : '' // ifGroup / ifBlock / comment keys must equal their id
      let stepId = ''
      let slug = ''
      let block: Block | undefined
      let after: JsonScript | undefined
      // Built-in tools are confirmed by what viaSocket attaches: a hidden connection that failed is retried once, and
      // a catalog match that turns out to be another tool (e.g. the Background agent for an Instant one) makes way
      // for the next candidate.
      let candidate = 0
      let authRetried = false
      for (let attempt = 0; ; attempt++) {
        stepId = prefixedStepId(ID_PREFIX[a.type])
        const createBody: Record<string, unknown> = {
          type: a.type === 'condition' ? 'ifGroup' : a.type === 'branch' ? 'ifBlock' : PLUGIN_LIKE.has(a.type) ? 'plugin' : a.type,
          title: wanted || stepId,
          stepId,
          orderGroup: parent,
        }
        if (plan.position !== undefined) createBody.position = plan.position
        if (a.description && NAMED.has(a.type)) createBody.description = a.description
        if (action) {
          createBody.actionId = action.rowid
          if (action.iconurl) createBody.iconUrl = action.iconurl
          // As the panel: the agent tools start with their documented sample. No breakPoint: viaSocket derives it.
          if (kind === 'ai_agent' || kind === 'ai_agent_background') {
            const sample = documentedSample(action)
            if (sample !== undefined) createBody.sampleData = sample
          }
        }
        if (a.type === 'comment') createBody.data = a.text
        if (a.type === 'break') Object.assign(createBody, { data: '', _data: '' })
        if (childId) createBody.stepChildDetails = { type: 'ifBlock', title: childId, orderGroup: stepId, stepId: childId }

        const created = await call('Adding the step', () =>
          ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/stepv2`, body: createBody, live: true, signal: ctx.signal }),
        )
        after = normalizeFlow(asRecord(created).script)?.json_script
        slug = (after ? slugForStepId(after, stepId) : undefined) ?? ''
        block = slug && after ? after.blocks[slug] : undefined
        if (!after || !slug || !block) throw new ToolError('The step was created but is missing from the response. Call vs_get_flow to check the flow.')
        const problem = kind ? verifyCreated(kind, block) : undefined
        if (!problem) break
        await deleteDraft(ctx, t, slug)
        const noAuth = hiddenAuth && !str(asRecord(asRecord(block.metaData?.selectedValues).authData).id)
        if (attempt >= 4) throw new ToolError(`${problem}, so the new step was removed again. ${addFromPanelHint(kind as SpecialKind)}`)
        if (noAuth && !authRetried) {
          authRetried = true
          continue
        }
        if (kind === 'ai_agent' && asRecord(block.breakPoint).asyncPlugin === true && action) rememberBuiltin(action.rowid, 'ai_agent_background')
        const next = candidates[candidate + 1]
        if (!next) throw new ToolError(`${problem}, so the new step was removed again. ${addFromPanelHint(kind as SpecialKind)}`)
        candidate++
        authRetried = false
        action = await getActionRowAny(ctx, next)
      }
      // An app action that is one of the panel's tools underneath (known by what viaSocket attached): its hidden
      // connection is used and its convenience fields apply, also after a service-worker restart forgot the ids.
      if (!kind && a.type === 'plugin') {
        const detected = kindFromStep(block, block.metaData)
        if (detected) {
          kind = detected
          hiddenAuth = HIDDEN_AUTH_KINDS.has(detected)
          if (action) rememberBuiltin(action.rowid, detected)
          if (hiddenAuth && authData && authData.id !== str(asRecord(block.metaData?.selectedValues?.authData).id)) {
            warnings.push('connectionId is ignored: this built-in tool uses its own connection.')
          }
        }
      }

      const result: Record<string, unknown> = { created: true, slug, stepId, type: a.type, parent }
      if (wanted && slug !== wanted && NAMED.has(a.type)) result.note = `The name ${wanted} was taken, so the step is ${slug}.`
      const docNote = documentedNote(documentedUsed)
      if (docNote) warnings.push(docNote)
      if (plan.reorderTo !== undefined) {
        try {
          await reorder(ctx, t, slug, parent, plan.reorderTo)
        } catch (e) {
          if (isAbortError(e)) throw e
          warnings.push(`Could not move it to the start: ${messageOf(e)}`)
        }
      }
      if (action && paidAction(action, block)) {
        warnings.push(CREDITS_NOTE)
        if ((await paidFlowsBlocked(ctx)) === true) warnings.push("The workspace's AI credits are used up: flows with paid actions are stopped until credits are added.")
      }
      if (kind === 'ai_agent_background' || (kind === 'ai_agent' && asRecord(block?.breakPoint).asyncPlugin === true)) {
        warnings.push("The agent runs in the background: its answer is not available right away, and later steps wait for it (minutes). Prefer the Instant agent when later steps need the answer quickly.")
      }

      try {
        const saved = await saveNewStep(ctx, t, a, slug, block as Block, after as JsonScript, authData, childId, getCat, kind)
        Object.assign(result, saved.result)
        warnings.push(...saved.warnings)
      } catch (e) {
        if (isAbortError(e)) throw e
        return {
          ...result,
          saved: false,
          error: messageOf(e),
          hint: `"${slug}" exists as an unsaved draft. Fix the problem and call vs_update_step with slugName "${slug}", or remove it with vs_delete_step.`,
          ...panelResult(await openStepPanel(ctx, t, block, slug)),
          warnings: warnings.length ? warnings : undefined,
        }
      }
      // Show the user the step just configured (a new condition shows its first branch). Notes and stops have no
      // panel: their create was live-applied, and the refetch covers a missed live push.
      if (a.type === 'comment' || a.type === 'break') {
        const sync = await refreshEditorIfOpen(ctx, t.scriptId)
        result.panelOpened = false
        if (sync.reason) result.panelNote = sync.reason
      } else {
        const branch = typeof result.branch === 'string' ? result.branch : undefined
        Object.assign(result, panelResult(branch && childId ? await openPanel(ctx, t.scriptId, childId, branch) : await openStepPanel(ctx, t, block, slug)))
      }
      if (result.saved === true && NAMED.has(a.type)) {
        result.next =
          kind === 'delay'
            ? `Test it with vs_test_step "${slug}" to see the minutes it waits. Whole-flow tests skip the pause (vs_test_flow). Steps after it run once the pause ends.`
            : `Test it with vs_test_step "${slug}" (it really runs), then use vs_get_variables to map its output in later steps.`
        if (kind === 'approval') result.next += ` The run waits for the approver; context.res.${slug} is their answer, so branch on it with a condition.`
      }
      return { ...result, warnings: warnings.length ? warnings : undefined }
    })
  },
})

async function saveNewStep(
  ctx: ToolContext,
  t: FlowTarget,
  a: AddStepArgs,
  slug: string,
  block: Block,
  js: JsonScript,
  authData: AuthData | undefined,
  childId: string | undefined,
  getCat: LazyCatalogue,
  kind?: SpecialKind,
): Promise<{ result: Record<string, unknown>; warnings: string[] }> {
  const stepId = block.identifier ?? ''
  const c: SaveCommon = {
    stepId,
    title: slug,
    description: a.description ?? block.description,
    sampleData: block.sampleData,
    iconUrl: block.iconUrl,
    hidden: block.hidden,
  }
  const warnings: string[] = []
  // vs_add_step opens the saved step's panel (or refreshes the editor) with a ?timestamp bump after this returns,
  // so while this tab shows the flow the saves skip live-apply: the bump's refetch then reloads everything,
  // including the just-opened panel (see flow-api's editor-sync note). A break keeps live-apply (no panel follows).
  const live = liveUnlessEditorOpen(ctx, t.scriptId)
  if (PLUGIN_LIKE.has(a.type)) {
    const meta = block.metaData
    if (!meta?.serviceId || !meta.actionVersionId) throw new ToolError('viaSocket did not attach the app definition to the step.')
    const extra = specialValues(kind, normalizeInputJson(meta.inputJson), meta, a)
    warnings.push(...extra.warnings)
    const values = { ...extra.values, ...(a.inputData ?? {}) }
    const holdKey = stepKey(ctx, t, stepId)
    const saved: SavedState = { inputData: asRecord(meta.selectedValues?.inputData), authId: str(meta.selectedValues?.authData?.id) }
    // Built-in tools with their own connection carry it in metaData; the server presets NoAuth on actions without one.
    const own = asRecord(meta.selectedValues?.authData)
    if (kind && HIDDEN_AUTH_KINDS.has(kind) && str(own.id)) authData = own as AuthData
    if (!authData && (meta.authType === 'NoAuth' || meta.selectedValues?.authData?.id === 'NoAuth')) authData = NO_AUTH
    let cfg: Configured
    try {
      cfg = await configure(ctx, t, {
        holdKey,
        pd: meta,
        values,
        changed: new Set(Object.keys(values)),
        base: saved.inputData,
        authData,
        isTrigger: false,
        slug,
        customInput: new Set(a.customInput ?? []),
        noConnection: false,
      })
    } catch (e) {
      if (e instanceof ToolError) holdValues(holdKey, values, a.connectionId, saved)
      throw e
    }
    warnings.push(...cfg.warnings)
    // Never save an app step with a missing connection or required field: it stays a draft (as in the editor).
    if (!authData || !cfg.complete) {
      holdValues(holdKey, values, a.connectionId, saved)
      const result = await incompleteResult(slug, 'DRAFTED', meta, !!authData, { ...cfg, warnings: [] }, values, [], getCat)
      if ((kind === 'ai_agent' || kind === 'ai_agent_background') && authData) await attachAgentChoices(ctx, t, result, meta, authData, cfg, slug)
      return { result, warnings }
    }
    if (cfg.missing.maybe.length) warnings.push(`Check whether these apply: ${cfg.missing.maybe.map((m) => m.label ?? m.key).join(', ')}`)
    const loop = await flowTargetProblem(ctx, t, cfg, kind === 'flow_in_flow')
    if (loop) throw new ToolError(loop)
    if (extra.display && Object.hasOwn(cfg.cleaned, extra.display.key)) cfg.cleaned[`_${extra.display.key}`] = extra.display.text
    const base: PluginData = { ...meta, inputJson: cfg.inputJson }
    const dynamicInputRequired = withDynamicInput(meta.dynamicInputRequired, cfg.dynamicInput)
    if (dynamicInputRequired) base.dynamicInputRequired = dynamicInputRequired
    await putStep(ctx, t, slug, pluginBody(c, base, authData, cfg.cleaned), live)
    return {
      result: {
        saved: true,
        status: 'ACTIVE',
        reference: `context.res.${slug}`,
        waits: extra.display?.text,
        defaultsApplied: cfg.defaultsApplied.length ? cfg.defaultsApplied : undefined,
      },
      warnings,
    }
  }
  switch (a.type) {
    case 'function':
      await putStep(ctx, t, slug, functionBody(c, a.code ?? '', { dynamicVariables: mergeDynamicVariables({}, a.dynamicVariables) }), live)
      return { result: { saved: true, status: 'ACTIVE', reference: `context.res.${slug}` }, warnings }
    case 'api': {
      const { code } = buildApiCode(apiSpec(a), {})
      await putStep(ctx, t, slug, apiBody(c, code, { dynamicVariables: mergeDynamicVariables({}, a.dynamicVariables) }), live)
      return { result: { saved: true, status: 'ACTIVE', reference: `context.res.${slug}` }, warnings }
    }
    case 'variable':
      await putStep(ctx, t, slug, variableBody(c, a.expression ?? ''), live)
      return { result: { saved: true, status: 'ACTIVE', reference: `context.vals.${slug}` }, warnings }
    case 'condition': {
      const branch = childId ? slugForStepId(js, childId) : undefined
      if (!childId || !branch) throw new ToolError('The first branch of the condition was not created.')
      const condition = a.condition ?? ''
      await putStep(ctx, t, branch, ifBlockBody({ stepId: childId, title: branch }, condition, a.statement ?? truncate(condition, 80), {}), live)
      return {
        result: {
          saved: true,
          branch,
          hint: `Add the steps that run when the condition is true with parent "${branch}". viaSocket maintains the else-branch automatically.`,
        },
        warnings,
      }
    }
    case 'branch': {
      const condition = a.condition ?? ''
      await putStep(ctx, t, slug, ifBlockBody(c, condition, a.statement ?? truncate(condition, 80), {}), live)
      return { result: { saved: true, hint: `Add steps to this branch with parent "${slug}".` }, warnings }
    }
    case 'break':
      if (a.text) await putStep(ctx, t, slug, breakBody(c, a.text, block.mode))
      return { result: { saved: true }, warnings }
    case 'comment':
    default:
      return { result: { saved: true }, warnings }
  }
}

/** An AI agent step still missing its agent: the real agents, loaded through the step's own connection. */
async function attachAgentChoices(
  ctx: ToolContext,
  t: FlowTarget,
  result: Record<string, unknown>,
  meta: PluginData,
  authData: AuthData,
  cfg: Configured,
  slug: string,
): Promise<void> {
  const key = findField(cfg.ij, 'agent')
  if (!key || !cfg.needs.some((n) => n.key === key)) return
  try {
    const r = await loadFieldOptions(
      ctx,
      t,
      { ij: cfg.ij, fieldKey: key, authData, inputData: cfg.cleaned, actionVersionId: str(meta.actionVersionId) ?? '', isTrigger: false, slug },
      20,
    )
    result.agentChoices = r.options.length
      ? { field: key, agents: r.options.map((o) => ({ label: o.label, value: o.value })) }
      : { field: key, agents: [], hint: `There are no AI agents yet: the user creates them on the AI Agents page (/agents/${t.orgId}).` }
  } catch (e) {
    if (isAbortError(e)) throw e
  }
}

interface UpdateStepArgs extends StepFields {
  slugName: string
  newTitle?: string
  replaceInputData?: boolean
  responseType?: 'default' | 'custom'
  responseBody?: string
  scriptId?: string
}

function precheckUpdate(a: UpdateStepArgs): string[] {
  const { problems, warnings } = checkFields(a)
  if (a.text !== undefined) {
    const p = checkCommentText(a.text)
    if (p) problems.push(p)
  }
  if (a.responseBody !== undefined && a.responseBody.trim()) {
    const p = checkExpression(a.responseBody)
    if (p) problems.push(`responseBody: ${p}`)
  }
  if (a.url !== undefined) {
    const p = checkTemplateText(a.url)
    if (p) problems.push(`url: ${p}`)
  }
  if (problems.length) fail(problems)
  return warnings
}

const RENAMABLE = new Set(['function', 'api', 'plugin', 'variable'])

const updateStep = defineTool<UpdateStepArgs>({
  name: 'vs_update_step',
  description: [
    'Change and save an existing step. Only the fields you pass change; the rest of the saved configuration is kept (and checked like new values).',
    'Also use it to finish a step that is still an unsaved draft (e.g. an app step that needed a connection or answers from the user); values given in earlier incomplete calls are kept.',
    'App steps: inputData is merged into the saved values (set replaceInputData to start from empty); connectionId switches the connection. A step with a missing connection or required field is not saved: the result lists needsConnection / needsUserInput.',
    'Rename only with newTitle (other steps that reference the old name are not updated, so viaSocket may refuse).',
    'The webhook response is slugName "response" (responseType, responseBody), or use vs_set_response.',
    'Use the type-specific fields of the step being edited (see vs_get_step); built-in tools also take duration/until/delayFrom (Delay), agentId/message/conversationId (AI agent) and targetScriptId (Flow in Flow).',
  ].join(' '),
  parameters: params(
    {
      slugName: S.str('Slug of the step to change, exactly as in vs_get_flow (or "response").', { pattern: SLUG_RE.source }),
      newTitle: S.str('New step name, to rename the step (4-50 letters, digits or underscores, starting with a letter).', { maxLength: 50 }),
      replaceInputData: S.bool('App steps: replace all field values instead of merging.'),
      responseType: S.enum(['default', 'custom'], 'Response step only: "default" (standard reply) or "custom".'),
      responseBody: S.str('Response step with responseType custom: JavaScript expression sent back to the webhook caller, e.g. { ok: true, id: context.res.Create_Row.id }.', {
        maxLength: 5000,
      }),
      ...STEP_FIELDS,
      scriptId: SCRIPT_ID_PARAM,
    },
    ['slugName'],
  ),
  danger: 'write',
  pages,
  describe: (a) => (a.newTitle ? `Renaming ${label(a.slugName, 'a step')}` : `Updating ${label(a.slugName, 'a step')}`),
  async run(a, ctx) {
    const warnings = precheckUpdate(a)
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      const js = row.json_script
      const slug = a.slugName
      const block = js.blocks[slug]
      if (!block) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
      if (block.type === 'ifGroup') throw new ToolError('A condition (ifGroup) has nothing to save itself; update its branches (ifBlock slugs) instead.')
      if (block.isElseBlock) throw new ToolError('The else-branch is managed by viaSocket and cannot be edited.')
      if (block.status === 'DELETE') throw new ToolError(`"${slug}" is deleted.`)
      if (block.type !== 'response' && !block.identifier) throw new ToolError(`"${slug}" has no step id; it cannot be saved.`)
      if (a.customInput?.length && block.type !== 'plugin') warnings.push('customInput is only for app steps.')
      const builtinFields = ['duration', 'until', 'delayFrom', 'agentId', 'message', 'conversationId', 'targetScriptId'].filter((k) => (a as unknown as Record<string, unknown>)[k] !== undefined)
      if (builtinFields.length && block.type !== 'plugin') warnings.push(`${builtinFields.join(', ')} ignored: they are only for built-in tool steps.`)

      let title = slug
      if (a.newTitle && a.newTitle !== slug) {
        if (!RENAMABLE.has(block.type)) throw new ToolError(`${block.type} steps cannot be renamed.`)
        if (!isValidSlug(a.newTitle)) {
          throw new ToolError('newTitle must be 4-50 letters, digits or underscores, start with a letter, and not be a reserved word (such as date, console, context or response).')
        }
        if (js.blocks[a.newTitle]) throw new ToolError(`A step named ${a.newTitle} already exists.`)
        title = a.newTitle
      }
      const c: SaveCommon = {
        stepId: block.identifier ?? '',
        title,
        description: a.description ?? block.description,
        sampleData: block.sampleData,
        iconUrl: block.iconUrl,
        hidden: block.hidden,
      }
      const pos: Position = slug === 'response' ? { at: 'end' } : { at: 'before', slug }
      const getCat = lazyCatalogue(ctx, t, row, pos)
      const allowDoc = a.allowDocumentedSample === true
      // The new values first (so a wrong mapping is refused before anything is held), then everything the save keeps.
      let literal: Set<string> | undefined
      if (block.type === 'plugin' && a.inputData && block.identifier) {
        const pd = pluginDataOf(block, await getFunctionRow(ctx, t, block.identifier))
        literal = pd ? choiceKeys(normalizeInputJson(pd.inputJson)) : undefined
      }
      const documentedUsed = new Set(await guardMappings(js, getCat, mappingTexts(a, block.type, literal), allowDoc))
      let body: Record<string, unknown>
      let defaultsApplied: AppliedDefault[] | undefined
      try {
        ;({ body, defaultsApplied } = await buildUpdateBody(ctx, t, a, slug, block, c, warnings, getCat))
      } catch (e) {
        if (!(e instanceof IncompleteStep)) throw e
        return { ...e.result, ...panelResult(await openStepPanel(ctx, t, block, slug)), warnings: warnings.length ? warnings : undefined }
      }
      for (const s of await guardMappings(js, getCat, bodyTexts(block.type, body, new Set(a.customInput ?? [])), allowDoc, true)) documentedUsed.add(s)
      const docNote = documentedNote([...documentedUsed])
      if (docNote) warnings.push(docNote)
      // The editor keeps a cached copy of every step a panel has shown, which live-apply never touches, so a
      // live-applied save can leave an open (or later reopened) panel stale. While this tab shows the flow, save
      // plainly and let the reopen below bump ?timestamp: the refetch sees the version move and reloads the step.
      await putStep(ctx, t, slug, body, liveUnlessEditorOpen(ctx, t.scriptId))
      if (block.type === 'plugin' && block.identifier) clearPending(stepKey(ctx, t, block.identifier))

      let panel: { panelOpened: boolean; panelNote?: string }
      if (block.type === 'comment' || block.type === 'break') {
        const sync = await refreshEditorIfOpen(ctx, t.scriptId)
        panel = sync.reason ? { panelOpened: false, panelNote: sync.reason } : { panelOpened: false }
      } else {
        panel = panelResult(block.type === 'response' ? await openPanel(ctx, t.scriptId, 'response', 'response') : await openStepPanel(ctx, t, block, title))
      }
      const reference = block.type === 'variable' ? `context.vals.${title}` : block.type === 'response' ? undefined : `context.res.${title}`
      return {
        saved: true,
        slug: title,
        renamedFrom: title !== slug ? slug : undefined,
        reference,
        defaultsApplied,
        ...panel,
        next:
          DATA_STEPS.has(block.type)
            ? `Test it with vs_test_step "${title}" (it really runs), then use vs_get_variables to map its output in later steps.`
            : undefined,
        warnings: warnings.length ? warnings : undefined,
      }
    })
  },
})

interface SetResponseArgs {
  responseType: 'default' | 'custom'
  body?: string
  headers?: string
  scriptId?: string
}

const setResponse = defineTool<SetResponseArgs>({
  name: 'vs_set_response',
  description:
    'Set what a webhook flow answers the caller: "default" (viaSocket\'s standard reply) or "custom" with body, a JavaScript expression built from real insert paths, e.g. { ok: true, id: context.res.Create_Row.id }, plus optional headers (an object expression). A custom body that reads step outputs makes the caller wait for those steps. With run once per item on, callers always get "Flow Queued" instead. Only for webhook triggers.',
  parameters: params(
    {
      responseType: S.enum(['default', 'custom'], '"default" or "custom".'),
      body: S.str('custom: JavaScript expression returned to the caller (paths without ${}).', { maxLength: 5000 }),
      headers: S.str('custom: optional JavaScript object expression of response headers, e.g. { "x-request-id": context.req.headers["x-id"] }.', { maxLength: 2000 }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['responseType'],
  ),
  danger: 'write',
  pages,
  describe: (a) => (a.responseType === 'custom' ? 'Setting a custom webhook response' : 'Setting the default webhook response'),
  async run(a, ctx) {
    const problems: string[] = []
    const body = (a.body ?? '').trim()
    const headers = (a.headers ?? '').trim()
    if (a.responseType === 'custom') {
      if (!body) problems.push('body is required for a custom response (an empty custom response blocks publishing).')
      else {
        const p = checkExpression(body)
        if (p) problems.push(`body: ${p}`)
      }
      if (headers) {
        const p = checkExpression(headers)
        if (p) problems.push(`headers: ${p}`)
      }
    } else if (body || headers) problems.push('body and headers are only for responseType "custom".')
    if (problems.length) fail(problems)
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      const js = row.json_script
      const kind = triggerKind(js.trigger)
      if (kind !== 'webhook') throw new ToolError(`Only webhook flows answer a caller; this flow starts with ${kind ?? 'no trigger'}.`)
      const block = js.blocks.response
      if (!block) {
        throw new ToolError(
          asRecord(js.trigger?.loops).loopsEnabled === true
            ? 'The flow has no response block: run once per item is on, so callers always get "Flow Queued" and a response is never sent. To answer callers, turn the loop off (vs_set_trigger_loop enabled false), then call vs_set_trigger kind "webhook" (it restores the response block) and vs_set_response again.'
            : 'The flow has no response block. Call vs_set_trigger kind "webhook" (it restores the response block), then vs_set_response again.',
        )
      }
      const warnings: string[] = []
      if (a.responseType === 'custom') {
        const texts: MapText[] = [{ where: 'body', text: body, mode: 'code' }]
        if (headers) texts.push({ where: 'headers', text: headers, mode: 'code' })
        const documentedUsed = await guardMappings(js, lazyCatalogue(ctx, t, row, { at: 'end' }), texts, false)
        const docNote = documentedNote(documentedUsed)
        if (docNote) warnings.push(docNote)
        if (/context\s*\??\.\s*(?:res|vals)\b/.test(body)) warnings.push('The caller waits until the steps this response reads have run (a run may take at most about 30 seconds).')
        if (Object.values(js.blocks).some((b) => b.type === 'break')) warnings.push('The flow has a break step: with a custom response, a run that hits it answers with the break data.')
      }
      if (asRecord(js.trigger?.loops).loopsEnabled === true) warnings.push('Run once per item is on, so callers always get "Flow Queued"; this response is not sent until the loop is turned off.')
      const customHeaders = a.responseType === 'custom' ? (headers ? { data: headers, _data: headers } : block.customHeaders) : undefined
      // Plain save while this tab shows the flow: the reopen below bumps ?timestamp, so an open response panel
      // reloads the saved state instead of keeping its live-apply-proof cached copy.
      await putStep(ctx, t, 'response', responseBody(a.responseType, body, customHeaders), liveUnlessEditorOpen(ctx, t.scriptId))
      return {
        saved: true,
        responseType: a.responseType,
        ...panelResult(await openPanel(ctx, t.scriptId, 'response', 'response')),
        warnings: warnings.length ? warnings : undefined,
      }
    })
  },
})

/** Save body for an existing step with the given changes merged over its saved configuration. */
async function buildUpdateBody(
  ctx: ToolContext,
  t: FlowTarget,
  a: UpdateStepArgs,
  slug: string,
  block: Block,
  c: SaveCommon,
  warnings: string[],
  getCat: LazyCatalogue,
): Promise<{ body: Record<string, unknown>; defaultsApplied?: AppliedDefault[] }> {
  switch (block.type) {
    case 'function': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const code = a.code ?? fn?.code
      if (!code) throw new ToolError('code is required: this function step has never been saved.')
      return {
        body: functionBody(c, code, {
          dynamicVariables: mergeDynamicVariables(fn?.metadata?.drafted?.dynamicVariables, a.dynamicVariables),
          authId: fn?.auth_id,
          subfunctions: block.subfunctions,
        }),
      }
    }
    case 'api': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const { code, problems } = buildApiCode(apiSpec(a), asRecord(parseMaybeJson(fn?.code)))
      if (problems.length) fail(problems)
      return {
        body: apiBody(c, code, {
          dynamicVariables: mergeDynamicVariables(fn?.metadata?.drafted?.dynamicVariables, a.dynamicVariables),
          authId: fn?.auth_id,
        }),
      }
    }
    case 'plugin': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const pd = pluginDataOf(block, fn)
      if (!pd) throw new ToolError('This app step has no app definition. Delete it and add it again.')
      const holdKey = stepKey(ctx, t, c.stepId)
      const saved: SavedState = { inputData: asRecord(pd.selectedValues?.inputData), authId: str(pd.selectedValues?.authData?.id) }
      // Convenience fields (delay, agent, message, flow to run) under the tool's real field keys; inputData wins.
      const stepKind = kindFromStep(block, pd)
      const extra = specialValues(stepKind === 'delay' ? 'delay' : undefined, normalizeInputJson(pd.inputJson), pd, a)
      warnings.push(...extra.warnings)
      const given = Object.keys(extra.values).length ? { ...extra.values, ...(a.inputData ?? {}) } : a.inputData
      const merged = a.replaceInputData
        ? { values: { ...(given ?? {}) }, connectionId: undefined, dropped: [] as string[] }
        : mergePending(holdKey, given, saved)
      if (merged.dropped.length) warnings.push(`Kept the panel's values for ${merged.dropped.join(', ')} (changed there after they were given here).`)
      const connectionId = a.connectionId ?? merged.connectionId
      let authData: AuthData | undefined
      if (connectionId) {
        const serviceId = str(pd.serviceId) ?? ''
        const lookup = str(pd.authIdLookup) ?? ''
        if (!ROW_ID_RE.test(serviceId) || !ROW_ID_RE.test(lookup)) throw new ToolError('This app step has no connection settings.')
        authData = await resolveConnection(ctx, connectionId, serviceId, lookup, t)
      } else if (pd.authType === 'NoAuth') authData = NO_AUTH
      else if (pd.selectedValues?.authData?.id) authData = pd.selectedValues.authData
      let cfg: Configured
      try {
        cfg = await configure(ctx, t, {
          holdKey,
          pd,
          values: merged.values,
          changed: new Set(Object.keys(given ?? {})),
          base: a.replaceInputData ? {} : saved.inputData,
          authData,
          isTrigger: false,
          slug,
          customInput: new Set(a.customInput ?? []),
          noConnection: false,
        })
      } catch (e) {
        if (e instanceof ToolError) holdValues(holdKey, merged.values, connectionId, saved)
        throw e
      }
      warnings.push(...cfg.warnings)
      if (!authData?.id || !cfg.complete) {
        holdValues(holdKey, merged.values, connectionId, saved)
        throw new IncompleteStep(await incompleteResult(slug, str(block.status), pd, !!authData?.id, { ...cfg, warnings: [] }, merged.values, merged.dropped, getCat))
      }
      if (cfg.missing.maybe.length) warnings.push(`Check whether these apply: ${cfg.missing.maybe.map((m) => m.label ?? m.key).join(', ')}`)
      const loop = await flowTargetProblem(ctx, t, cfg, stepKind === 'flow_in_flow' || a.targetScriptId !== undefined)
      if (loop) fail([loop])
      if (extra.display && Object.hasOwn(cfg.cleaned, extra.display.key)) cfg.cleaned[`_${extra.display.key}`] = extra.display.text
      const next: PluginData = { ...pd, inputJson: cfg.inputJson }
      const dynamicInputRequired = withDynamicInput(pd.dynamicInputRequired, cfg.dynamicInput)
      if (dynamicInputRequired) next.dynamicInputRequired = dynamicInputRequired
      return { body: pluginBody(c, next, authData, cfg.cleaned), defaultsApplied: cfg.defaultsApplied.length ? cfg.defaultsApplied : undefined }
    }
    case 'variable': {
      const expression = a.expression ?? str(block.data) ?? ''
      const p = checkExpression(expression)
      if (p) fail([`expression: ${p}`])
      return { body: variableBody(c, expression) }
    }
    case 'ifBlock': {
      const condition = a.condition ?? str(block.condition) ?? ''
      const p = checkExpression(condition)
      if (p) fail([`condition: ${p}`])
      return { body: ifBlockBody(c, condition, a.statement ?? str(block.statement) ?? truncate(condition, 80), block.dynamicVariables) }
    }
    case 'comment':
      return { body: commentBody(c, a.text ?? str(block.data) ?? '', block.metadata) }
    case 'break': {
      const data = a.text ?? str(block.data) ?? ''
      const p = data.trim() ? checkExpression(data) : undefined
      if (p) fail([`text: ${p}`])
      return { body: breakBody(c, data, block.mode) }
    }
    case 'response': {
      if (slug !== 'response') throw new ToolError('Unexpected response block.')
      const responseType = a.responseType ?? (block.responseType === 'custom' ? 'custom' : 'default')
      const data = a.responseBody ?? str(block.data) ?? ''
      if (responseType === 'custom') {
        const p = checkExpression(data)
        if (p) fail([`responseBody: ${p}`])
      }
      return { body: responseBody(responseType, data, block.customHeaders) }
    }
    default:
      throw new ToolError(`${block.type} steps cannot be edited by the assistant.`)
  }
}

/**
 * Stores a successful test output as an app step's sample (blocks[slug].sampleData), where the editor keeps it after
 * a test and a save, so later mappings and the editor's field picker can use it. Only app steps: the backend keeps
 * sampleData for plugin blocks only. Re-saves the saved configuration unchanged. Best-effort: false when skipped.
 */
export async function saveStepSample(ctx: ToolContext, t: FlowTarget, stepId: string, sample: unknown): Promise<boolean> {
  try {
    return await ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const js = (await getFlow(ctx, t)).json_script
      const slug = slugForStepId(js, stepId)
      const block = slug ? js.blocks[slug] : undefined
      if (!slug || !block || block.type !== 'plugin' || block.status === 'DRAFTED' || block.status === 'DELETE') return false
      const compacted = compactSample(sample)
      if (typeof compacted === 'string' && compacted === 'data too large') return false
      if (deepEqual(parseMaybeJson(block.sampleData), compacted)) return true
      const pd = pluginDataOf(block, await getFunctionRow(ctx, t, stepId))
      const authData = pd?.selectedValues?.authData
      if (!pd || !authData?.id) return false
      const c: SaveCommon = { stepId, title: slug, description: block.description, sampleData: compacted, iconUrl: block.iconUrl, hidden: block.hidden }
      const body = pluginBody(c, pd, authData, asRecord(pd.selectedValues?.inputData))
      // Plain save plus a refetch while this tab shows the flow, so the sample also reaches the editor's cached
      // copy of the step (live-apply would skip it there); best-effort either way.
      const live = liveUnlessEditorOpen(ctx, t.scriptId)
      await putStep(ctx, t, slug, body, live)
      if (!live) await refreshEditorIfOpen(ctx, t.scriptId)
      return true
    })
  } catch (e) {
    if (isAbortError(e)) throw e
    return false
  }
}

/** Saved steps are soft-deleted under a new, unique name; reusing a taken name fails. */
function deletedTitle(js: JsonScript, slug: string): string {
  const base = `${slug}_DELETED`
  if (!js.blocks[base]) return base
  for (let i = 1; i < 1000; i++) if (!js.blocks[`${base}_${i}`]) return `${base}_${i}`
  return `${base}_${Date.now()}`
}

const SOFT_DELETE_TYPES = new Set(['api', 'function', 'plugin', 'variable', 'ifBlock'])

const deleteStep = defineTool<{ slugName: string; scriptId?: string }>({
  name: 'vs_delete_step',
  description:
    'Delete a step from the flow draft. Deleting a branch also deletes the steps inside it. Steps that are live stay live until the next publish. A condition (ifGroup) is removed by deleting its branches; the else-branch cannot be deleted.',
  parameters: params({ slugName: S.str('Slug of the step to delete, exactly as in vs_get_flow.', { pattern: SLUG_RE.source }), scriptId: SCRIPT_ID_PARAM }, [
    'slugName',
  ]),
  danger: 'confirm',
  pages,
  describe: (a) => `Deleting ${label(a.slugName, 'a step')}`,
  confirmText: (a) =>
    `Delete the step "${label(a.slugName, '?', 60)}" from this flow's draft? If it is a branch, the steps inside it are deleted too. A live flow keeps running the old version until you publish.`,
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      const js = row.json_script
      const slug = a.slugName
      const block = js.blocks[slug]
      if (!block) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
      if (slug === 'response') throw new ToolError('The webhook response cannot be deleted; set it to responseType "default" with vs_update_step.')
      if (block.type === 'ifGroup') throw new ToolError('A condition cannot be deleted directly; delete its branches (deleting the last one removes it).')
      if (block.isElseBlock) throw new ToolError('The else-branch is managed by viaSocket and cannot be deleted.')
      if (block.status === 'DELETE') return { deleted: true, slug, note: 'It was already deleted.' }

      const needsTitle = block.status !== 'DRAFTED' && SOFT_DELETE_TYPES.has(block.type)
      const nested = block.type === 'ifBlock' ? [...descendants(js, slug)] : []
      const live = new Set(Object.values(row.published_json_script?.blocks ?? {}).map((b) => b.identifier))
      await call(`Deleting step "${slug}"`, () =>
        ctx.vs.request({
          method: 'DELETE',
          path: `/scripts/${t.scriptId}/stepv2/${encodeURIComponent(slug)}`,
          body: needsTitle ? { title: deletedTitle(js, slug) } : undefined,
          live: true,
          signal: ctx.signal,
        }),
      )
      // The delete was live-applied; the bump also closes a panel still showing the deleted step and makes the
      // editor refetch, which covers a missed live push.
      const panelOnIt = editorParam(ctx, 'slugName', t.scriptId) === slug
      const sync = await refreshEditorIfOpen(ctx, t.scriptId, panelOnIt ? { stepId: null, slugName: null } : {})
      return {
        deleted: true,
        slug,
        alsoDeleted: nested.length ? nested : undefined,
        editorNote: sync.reason,
        note: block.identifier && live.has(block.identifier) ? 'It is removed from the live flow when the flow is published.' : undefined,
      }
    })
  },
})

interface MoveArgs {
  slugName: string
  parent?: string
  afterSlug?: string
  toStart?: boolean
  scriptId?: string
}

const moveStep = defineTool<MoveArgs>({
  name: 'vs_move_step',
  description:
    'Move a step to another position, optionally into another group. Give afterSlug (place right after that step) or toStart, and parent ("root" or a branch slug) when changing groups. A branch can only be reordered inside its own condition. A break must stay last in its group; the else-branch cannot be moved.',
  parameters: params(
    {
      slugName: S.str('Slug of the step to move.', { pattern: SLUG_RE.source }),
      parent: S.str('Target group: "root" or a branch slug. Default: its current group (for a branch, always its own condition).', {
        pattern: SLUG_RE.source,
      }),
      afterSlug: S.str('Place right after this step in the target group.', { pattern: SLUG_RE.source }),
      toStart: S.bool('Place first in the target group.'),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['slugName'],
  ),
  danger: 'write',
  pages,
  describe: (a) => `Moving ${label(a.slugName, 'a step')}`,
  async run(a, ctx) {
    if (!a.afterSlug && !a.toStart) throw new ToolError('Say where to move it: afterSlug or toStart.')
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const js = (await getFlow(ctx, t)).json_script
      const slug = a.slugName
      const block = js.blocks[slug]
      const current = findParent(js, slug)
      if (!block || !current) throw new ToolError(`No movable step "${slug}". Call vs_get_flow for the current slugs.`)
      if (block.isElseBlock) throw new ToolError('The else-branch always stays last and cannot be moved.')
      if (block.status === 'DELETE') throw new ToolError(`"${slug}" is deleted.`)
      const target = a.parent ?? current
      if (!(target in js.order)) throw new ToolError(`Unknown group "${target}".`)
      const tb = js.blocks[target]
      if (tb?.status === 'DELETE') throw new ToolError(`"${target}" is deleted.`)
      if (block.type === 'ifBlock') {
        // The reorder route moves only the order entry: block.parent and both conditions' else-branches stay stale.
        if (target !== current) {
          throw new ToolError(
            'A branch can only be reordered inside its own condition. To move it to another condition, delete it and add it there with vs_add_step type "branch".',
          )
        }
      } else if (target !== 'root' && tb?.type !== 'ifBlock') {
        throw new ToolError('Steps can only be placed in "root" or a branch (ifBlock).')
      }
      if (target === slug || descendants(js, slug).has(target)) throw new ToolError('A step cannot be moved inside itself.')

      const list = (js.order[target] ?? []).filter((s) => s !== slug)
      let newIndex = 0
      if (!a.toStart) {
        const idx = list.indexOf(a.afterSlug ?? '')
        if (idx < 0) throw new ToolError(`"${a.afterSlug}" is not in "${target}". Items there: ${list.join(', ') || 'none'}.`)
        newIndex = idx + 1
      }
      const notes: string[] = []
      if (block.type === 'break' && newIndex !== list.length) throw new ToolError('A break must stay the last step of its group.')
      if (block.type !== 'break' && terminalItem(js, list) && newIndex >= list.length) {
        newIndex = list.length - 1
        notes.push('Placed before the final break/else item, which must stay last.')
      }
      const orphans = orphanBlocks(js)
      await reorder(ctx, t, slug, target, newIndex)
      if (orphans.length) notes.push(`viaSocket also removed unreachable leftovers: ${orphans.join(', ')}`)
      // The reorder was live-applied; the bump refetches the canvas order too, covering a missed live push.
      const sync = await refreshEditorIfOpen(ctx, t.scriptId)
      if (sync.reason) notes.push(sync.reason)
      return { moved: true, slug, parent: target, index: newIndex, notes: notes.length ? notes : undefined }
    })
  },
})

export const STEP_TOOLS: Tool<any>[] = [addStep, updateStep, deleteStep, moveStep, setResponse]
