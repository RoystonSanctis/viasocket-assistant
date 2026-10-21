// Reading flows and resolving which flow a tool may act on, and keeping the open editor in sync with writes.

import type { PageContext } from '../../../shared/page'
import { SCRIPT_ID_RE, STEP_ID_RE } from '../ids'
import type { ToolContext, UiBridge, VsContext } from '../types'
import { VsError } from '../viasocket-client'
import { call, ToolError } from './errors'
import { isKnownProject, knownFlowProject, rememberProject } from './known'
import type { Block, FlowRow, FlowTarget, FunctionRow, JsonScript, PluginData, Trigger } from './types'
import { pagePathWithParams } from './urls'
import { asArray, asRecord, isRecord, ORG_ID_RE, parseMaybeJson, PROJECT_ID_RE, str, truncate } from './util'

export function requireOrg(ctx: Pick<VsContext, 'vs'>): string {
  const org = ctx.vs.orgId
  if (!org || !ORG_ID_RE.test(org)) throw new ToolError('Open a viaSocket workspace page first.')
  return org
}

/**
 * The flow a tool acts on: the open flow, or one whose id came from vs_list_flows / vs_create_flow in this
 * session. Never an id the model made up.
 */
export function resolveFlow(ctx: ToolContext, scriptId?: string): FlowTarget {
  const orgId = requireOrg(ctx)
  const page = ctx.page
  if (scriptId && scriptId !== page.scriptId) {
    if (!SCRIPT_ID_RE.test(scriptId)) throw new ToolError('scriptId must be a 12-character flow id.')
    const projectId = knownFlowProject(orgId, scriptId)
    if (!projectId) {
      throw new ToolError(`Unknown flow ${scriptId}. Use a flow id returned by vs_list_flows or vs_create_flow, or open the flow first.`)
    }
    return { orgId, projectId, scriptId }
  }
  if (page.kind !== 'flow-editor' || !page.scriptId || !page.projectId) {
    throw new ToolError('No flow is open. Open a flow, or pass scriptId from vs_list_flows / vs_create_flow.')
  }
  if (!SCRIPT_ID_RE.test(page.scriptId) || !PROJECT_ID_RE.test(page.projectId)) {
    throw new ToolError('The open page does not look like a viaSocket flow.')
  }
  return { orgId, projectId: page.projectId, scriptId: page.scriptId }
}

/** Project-scoped routes switch the user's active org when the project is elsewhere, so check membership first. */
export async function verifyProject(ctx: ToolContext, orgId: string, projectId: string): Promise<void> {
  if (!PROJECT_ID_RE.test(projectId)) throw new ToolError('projectId must be an alphanumeric project id.')
  if (projectId === ctx.page.projectId || projectId === `proj${orgId}` || isKnownProject(orgId, projectId)) return
  const projects = await listProjectRows(ctx, orgId)
  if (!projects.some((p) => str(p.id) === projectId || str(p.identifier) === projectId)) {
    throw new ToolError(`Project ${projectId} is not in this workspace. Use an id from vs_list_projects.`)
  }
}

export async function listProjectRows(ctx: ToolContext, orgId: string): Promise<Record<string, unknown>[]> {
  // Never send bringflows=false: the backend tests the raw string, so it would bring every flow anyway.
  const body = await call('Listing projects', () =>
    ctx.vs.request({ method: 'GET', path: `/orgs/${orgId}/projects`, query: { type: 'flow' }, signal: ctx.signal }),
  )
  const rows = asArray(asRecord(asRecord(body).data).projects).filter(isRecord)
  for (const p of rows) {
    const id = str(p.id) ?? str(p.identifier)
    if (id) rememberProject(orgId, id)
  }
  return rows
}

function normalizeScript(v: unknown): JsonScript {
  const js = asRecord(v)
  const order: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(asRecord(js.order))) {
    order[k] = asArray(list).filter((s): s is string => typeof s === 'string')
  }
  if (!order.root) order.root = []
  const blocks: Record<string, Block> = {}
  for (const [k, b] of Object.entries(asRecord(js.blocks))) {
    if (isRecord(b) && typeof b.type === 'string') blocks[k] = b as Block
  }
  return { ...(js as Partial<JsonScript>), order, blocks, trigger: isRecord(js.trigger) ? (js.trigger as Trigger) : undefined }
}

export function normalizeFlow(v: unknown): FlowRow | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null
  return {
    ...(v as FlowRow),
    json_script: normalizeScript(v.json_script),
    published_json_script: isRecord(v.published_json_script) ? normalizeScript(v.published_json_script) : undefined,
  }
}

/** GET the flow. Also how existence is verified before routes that would silently create an unknown flow. */
export async function getFlow(ctx: VsContext, t: FlowTarget): Promise<FlowRow> {
  let body: unknown
  try {
    body = await call('Reading the flow', () =>
      ctx.vs.request({ method: 'GET', path: `/projects/${t.projectId}/scripts/${t.scriptId}`, query: { type: 'flow' }, signal: ctx.signal }),
    )
  } catch (e) {
    if (e instanceof VsError && e.kind === 'not-found') throw new ToolError(`Flow ${t.scriptId} was not found.`)
    throw e
  }
  const row = normalizeFlow(asRecord(body).data)
  if (!row) throw new ToolError(`Flow ${t.scriptId} was not found.`)
  if (row.org_id !== undefined && row.org_id !== null && String(row.org_id) !== t.orgId) {
    throw new ToolError('That flow belongs to another workspace; the assistant only works in the open workspace.')
  }
  return row
}

export async function getFunctionRow(ctx: VsContext, t: FlowTarget, stepId: string): Promise<FunctionRow | null> {
  if (!STEP_ID_RE.test(stepId)) return null
  try {
    const body = await call('Reading the step code', () =>
      ctx.vs.request({ method: 'GET', path: `/scripts/${t.scriptId}/functions/${stepId}`, signal: ctx.signal }),
    )
    const data = asRecord(body).data
    return isRecord(data) && typeof data.id === 'string' ? (data as unknown as FunctionRow) : null
  } catch (e) {
    if (e instanceof VsError && (e.kind === 'not-found' || e.kind === 'validation')) return null
    throw e
  }
}

export async function listFunctionRows(ctx: ToolContext, t: FlowTarget): Promise<FunctionRow[]> {
  const body = await call('Reading step code', () =>
    ctx.vs.request({ method: 'GET', path: `/scripts/${t.scriptId}/functions`, signal: ctx.signal }),
  )
  return asArray(asRecord(body).data).filter((r): r is FunctionRow => isRecord(r) && typeof r.id === 'string')
}

/** Plugin config of a step: the saved functions row when present, else the draft block's metaData. */
export function pluginDataOf(block: Block, fn: FunctionRow | null | undefined): PluginData | null {
  const parsed = fn?.code ? parseMaybeJson(fn.code) : undefined
  if (isRecord(parsed)) return parsed as PluginData
  return isRecord(block.metaData) ? block.metaData : null
}

export function findParent(js: JsonScript, slug: string): string | undefined {
  for (const [k, list] of Object.entries(js.order)) if (list.includes(slug)) return k
  return undefined
}

/** Every block key nested under `slug` (branches of an ifGroup, steps of an ifBlock, recursively). */
export function descendants(js: JsonScript, slug: string): Set<string> {
  const out = new Set<string>()
  const walk = (k: string) => {
    for (const child of js.order[k] ?? []) {
      if (out.has(child)) continue
      out.add(child)
      walk(child)
    }
  }
  walk(slug)
  return out
}

/** Blocks the reorder route would delete because nothing in `order` reaches them. */
export function orphanBlocks(js: JsonScript): string[] {
  const reached = new Set(['response', 'root'])
  const walk = (k: string) => {
    for (const child of js.order[k] ?? []) {
      if (reached.has(child)) continue
      reached.add(child)
      walk(child)
    }
  }
  walk('root')
  return Object.keys(js.blocks).filter((k) => !reached.has(k))
}

/** The final slug of a step just created: the server de-duplicates titles silently. */
export function slugForStepId(js: JsonScript, stepId: string): string | undefined {
  return Object.entries(js.blocks).find(([, b]) => b.identifier === stepId)?.[0]
}

export function hasDraftChanges(row: FlowRow): boolean {
  const v = row.json_script.version
  return typeof v === 'string' && Number(v.split('.').pop()) > 0
}

export function everPublished(row: FlowRow): boolean {
  return row.status === '1' || row.status === '2' || (row.published_json_script?.version ?? '0') !== '0'
}

export function flowStatusLabel(status: unknown): string {
  switch (str(status)) {
    case '1':
      return 'live'
    case '2':
      return 'paused'
    case '3':
      return 'draft (never published)'
    case '0':
      return 'trashed'
    default:
      return 'unknown'
  }
}

/** Steps the publish would strip because they were never saved (comments and breaks are saved on create). */
export function draftedSteps(js: JsonScript): string[] {
  return Object.entries(js.blocks)
    .filter(([k, b]) => k !== 'response' && b.status === 'DRAFTED' && b.type !== 'ifGroup')
    .map(([k]) => k)
}

export function triggerKind(trigger: Trigger | undefined): string | undefined {
  return trigger && typeof trigger.triggerType === 'string' && trigger.triggerType ? trigger.triggerType : undefined
}

/** Panel query for the trigger: the editor keys trigger panels by trigger type. */
export function triggerPanelSlug(kind: string | undefined): string {
  if (kind === 'webhook' || kind === 'email' || kind === 'cron') return kind
  return kind ? 'trigger' : 'selecttrigger'
}

/**
 * Get Data (pre-process), loop and run-if settings stored on the trigger. Every trigger save must carry them over
 * (POST /trigger replaces the whole trigger), so tools and the model both need to see them.
 */
export function triggerFeatures(trigger: Trigger | undefined): Record<string, unknown> | undefined {
  if (!trigger) return undefined
  const out: Record<string, unknown> = {}
  const pre = isRecord(trigger.preProcess) ? trigger.preProcess : undefined
  if (pre) {
    const type = str(pre.type)
    const code = asRecord(pre.code)
    out.getData =
      type === 'plugin'
        ? { source: 'app', app: str(code.serviceName), action: str(code.actionName), actionId: str(code.selectedCreate), connected: !!str(pre.auth_id) }
        : type === 'api'
          ? { source: 'api', method: str(code.method), url: truncate(str(code.url) ?? '', 160) }
          : { source: 'code' }
  }
  const loops = asRecord(trigger.loops)
  const filter = asRecord(trigger.preProcessFilter)
  const key = filter.type === 'filterByKey' ? str(asRecord(filter.value).value) : undefined
  if (loops.loopsEnabled === true) out.loop = { enabled: true, arrayKey: key || '(root)' }
  else if (key) out.loop = { enabled: false, arrayKey: key, note: 'The key still narrows the body although the loop is off.' }
  const pc = asRecord(trigger.preCondition)
  if (Object.keys(pc).length) {
    out.runIf = {
      enabled: pc.conditionEnabled === true,
      condition: truncate(str(pc.code) ?? '', 200) || undefined,
      statement: str(pc.statement) ? truncate(String(pc.statement), 160) : undefined,
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function inputValues(inputData: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(asRecord(inputData))) {
    if (k.startsWith('_') || k.includes('["_')) continue
    out[k] = v
  }
  return out
}

export function summarizeTrigger(trigger: Trigger | undefined, scriptId: string, vmBase: string): Record<string, unknown> | null {
  const kind = triggerKind(trigger)
  if (!trigger || !kind) return null
  const hasSample = trigger.sampleData !== undefined && trigger.sampleData !== null && trigger.sampleData !== ''
  const base: Record<string, unknown> = {
    type: kind,
    state: trigger.type,
    tested: hasSample,
    ...(hasSample ? { hasSampleData: true } : {}),
    ...(triggerFeatures(trigger) ?? {}),
  }
  switch (kind) {
    case 'webhook':
      return { ...base, url: `${vmBase}/func/${scriptId}`, note: 'The URL runs the live flow after publishing.' }
    case 'email':
      return { ...base, address: `${scriptId}@sokt.io` }
    case 'cron':
      return { ...base, cronExpression: trigger.cronExpression, meaning: trigger.meaning, timezone: trigger.timezone }
    default: {
      const auth = asRecord(trigger.selectedValues?.authData)
      const authId = str(auth.id)
      const authLabel = str(auth.connection_label) ?? str(auth.name)
      const isConnected = !!authId && authId !== 'NoAuth'
      const values = inputValues(trigger.selectedValues?.inputData)
      const inputData = asRecord(trigger.selectedValues?.inputData)
      return {
        ...base,
        app: trigger.serviceName,
        action: trigger.actionName,
        actionId: trigger.selectedCreate,
        drafted: trigger.isDrafted === true || undefined,
        connected: isConnected || authId === 'NoAuth',
        connection: authId ? { id: authId, name: authLabel, type: str(auth.type) } : null,
        connectionName: authLabel,
        configuredValues: Object.keys(values).length > 0 ? values : undefined,
        scheduledTimeMinutes: kind === 'polling' ? inputData.scheduledTime : undefined,
      }
    }
  }
}

interface StepNode {
  slug: string
  id?: string
  type: string
  status?: string
  change?: string
  description?: string
  app?: string
  action?: string
  connected?: boolean
  connection?: { id: string; name?: string; type?: string } | null
  connectionName?: string
  configuredValues?: Record<string, unknown>
  tested?: boolean
  hasSampleData?: boolean
  expression?: string
  condition?: string
  statement?: string
  isElse?: boolean
  steps?: StepNode[]
  branches?: StepNode[]
}

function stepNode(slug: string, js: JsonScript, fnById: Map<string, FunctionRow>, depth: number): StepNode {
  const b = js.blocks[slug]
  if (!b) return { slug, type: 'missing' }
  const node: StepNode = { slug, id: b.identifier, type: b.type, status: b.status, change: b.draftStatus }
  if (b.description) node.description = truncate(String(b.description), 120)
  if (b.type === 'plugin') {
    const pd = pluginDataOf(b, b.identifier ? fnById.get(b.identifier) : undefined)
    node.app = pd?.serviceName
    node.action = pd?.actionName
    const auth = asRecord(pd?.selectedValues?.authData)
    const authId = str(auth.id)
    const authLabel = str(auth.connection_label) ?? str(auth.name)
    node.connected = (!!authId && authId !== 'NoAuth') || authId === 'NoAuth'
    if (authId) {
      node.connection = { id: authId, name: authLabel, type: str(auth.type) }
      node.connectionName = authLabel
    }
    const vals = inputValues(pd?.selectedValues?.inputData)
    if (Object.keys(vals).length > 0) {
      node.configuredValues = vals
    }
  }
  const hasSample = b.sampleData !== undefined && b.sampleData !== null && b.sampleData !== ''
  node.tested = hasSample
  if (hasSample) node.hasSampleData = true
  if (b.type === 'variable' && b.data) node.expression = truncate(String(b.data), 160)
  if (b.type === 'ifBlock') {
    node.condition = b.isElseBlock ? undefined : truncate(String(b.condition ?? ''), 160)
    node.statement = b.statement ? truncate(String(b.statement), 120) : undefined
    if (b.isElseBlock) node.isElse = true
  }
  if (depth > 6) return node
  const children = (js.order[slug] ?? []).map((c) => stepNode(c, js, fnById, depth + 1))
  if (b.type === 'ifGroup') node.branches = children
  else if (b.type === 'ifBlock') node.steps = children
  return node
}

/** Compact, LLM-friendly view of a flow. Never includes execution_script, step code or run data. */
export function summarizeFlow(row: FlowRow, t: FlowTarget, fns: FunctionRow[], vmBase: string): Record<string, unknown> {
  const js = row.json_script
  const fnById = new Map(fns.map((f) => [f.id, f]))
  const response = js.blocks.response
  return {
    scriptId: t.scriptId,
    projectId: row.project_id ?? t.projectId,
    title: row.title,
    description: row.metadata?.description ? truncate(String(row.metadata.description), 300) : undefined,
    status: flowStatusLabel(row.status),
    everPublished: everPublished(row),
    hasUnpublishedChanges: hasDraftChanges(row),
    trigger: summarizeTrigger(js.trigger, t.scriptId, vmBase) ?? 'none (set one with vs_set_trigger)',
    steps: (js.order.root ?? []).map((s) => stepNode(s, js, fnById, 0)),
    unsavedDraftSteps: draftedSteps(js),
    response: response ? { responseType: response.responseType, custom: response.responseType === 'custom' } : undefined,
    references:
      'Trigger payload: context.req.body. Step output: context.res.<slug>. Variable: context.vals.<slug>. In app/API fields wrap them as ${...}.',
  }
}

// ---- Keeping the open editor in sync with writes --------------------------------------------------------------
//
// The editor picks up a mutation in two ways. With live-apply (the request's live flag) the page swaps in the new
// flow JSON itself, but an open step panel keeps its own cached copy of the step, so panel-visible changes (mapped
// fields, input values) stay stale there. Bumping ?timestamp makes the editor refetch the flow and, when the
// fetched draft version differs from the one it holds, drop those cached step copies too, so an open panel reloads
// its step. The two mechanisms defeat each other: a live-applied save syncs the editor's version first, and a later
// bump then sees no version difference and keeps the stale panel copy. So while this tab shows the flow, tools save
// WITHOUT live-apply and bump afterwards; only when the flow is not open here is live-apply the mechanism left.
//
// The bump itself travels background -> content script -> page hook -> history, and each hop used to fail silently
// (page hook not paired after an extension reload, the tab meanwhile elsewhere, the page context momentarily gone).
// Every sync below therefore waits until the tab reports a URL carrying the new stamp and returns what really
// happened, so tools can tell the model when the user has to refresh instead of silently claiming success.

export interface EditorProbe {
  /** The tab's latest page, which can be newer than the run's pinned ctx.page (a panel the user just opened). */
  livePage(): PageContext | null
  /** Resolves true once the tab reports a page that passes `test`; false on timeout, abort or a closed tab. */
  waitForPage(test: (page: PageContext) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean>
}

const PROBES = new WeakMap<UiBridge, EditorProbe>()

/** Called where the UiBridge is created: gives editor syncs eyes on the tab's live URL. */
export function registerEditorProbe(ui: UiBridge, probe: EditorProbe): void {
  PROBES.set(ui, probe)
}

export interface EditorSync {
  /** The editor was told to refetch/open the panel and the tab confirmed the new URL. */
  delivered: boolean
  /** The flow is not open in this tab (or the step has no panel), so there was nothing to sync. */
  skipped?: boolean
  /** Set when the editor could not be updated; tools put it in their result for the model to relay. */
  reason?: string
}

const CONFIRM_NAVIGATE_MS = 4000
const REFRESH_REASON =
  'The change is saved, but the open editor page did not pick it up (the page and the extension may be out of sync). If the editor does not show the change, tell the user to refresh the page.'

function urlParam(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The freshest view of the editor page showing this flow: the tab's live page when a probe is registered (the
 * pinned ctx.page can lag panels opened moments ago), else the pinned page. Null when the tab shows something
 * else, so a sync never navigates a user who moved away mid-run.
 */
function editorPageOf(ctx: ToolContext, scriptId: string): PageContext | null {
  const probe = PROBES.get(ctx.ui)
  if (probe) {
    const live = probe.livePage()
    return live && live.kind === 'flow-editor' && live.scriptId === scriptId && live.host === ctx.page.host ? live : null
  }
  return ctx.page.kind === 'flow-editor' && ctx.page.scriptId === scriptId ? ctx.page : null
}

/** This tab shows the flow's editor, so a ?timestamp bump (not live-apply) is what keeps it fresh. */
export function editorOpen(ctx: ToolContext, scriptId: string): boolean {
  return editorPageOf(ctx, scriptId) !== null
}

/**
 * All flow mutations must send live-apply (sent-by-fbai: true) so the open editor receives RTlayer
 * updates over WebSocket. This keeps Redux flowJson and draftFlowJson synchronized with ACTIVE step
 * statuses and the latest versiondraft, preventing step sliders from rendering empty or black.
 */
export function liveUnlessEditorOpen(_ctx: ToolContext, _scriptId: string): boolean {
  return true
}

/** Result fields for a tool that opened or refreshed a panel: panelOpened, plus the note to relay on failure. */
export function panelResult(sync: EditorSync): { panelOpened: boolean; panelNote?: string } {
  return sync.reason ? { panelOpened: sync.delivered, panelNote: sync.reason } : { panelOpened: sync.delivered }
}

let lastStamp = 0

/** Strictly increasing ?timestamp values, so each sync is recognizable in the URL the tab confirms. */
function nextStamp(): string {
  lastStamp = Math.max(lastStamp + 1, Date.now())
  return String(lastStamp)
}

/** Replace-navigates the open editor with the changes plus a fresh ?timestamp, and waits for the tab to confirm. */
async function syncEditor(ctx: ToolContext, scriptId: string, changes: Record<string, string | null>): Promise<EditorSync> {
  const page = editorPageOf(ctx, scriptId)
  if (!page) return { delivered: false, skipped: true }
  const stamp = nextStamp()
  try {
    ctx.ui.refreshStep({ scriptId, stepId: changes.stepId ?? undefined, slugName: changes.slugName ?? undefined })
    ctx.ui.navigate(pagePathWithParams(page.url, { ...changes, timestamp: stamp }), { replace: true })
  } catch {
    return { delivered: false, reason: REFRESH_REASON }
  }
  const probe = PROBES.get(ctx.ui)
  // Nothing to confirm with (tests build a bare context): report the attempt, as before.
  if (!probe) return { delivered: true }
  const confirmed = await probe.waitForPage(
    (p) => p.kind === 'flow-editor' && p.scriptId === scriptId && urlParam(p.url, 'timestamp') === stamp,
    CONFIRM_NAVIGATE_MS,
    ctx.signal,
  )
  return confirmed ? { delivered: true } : { delivered: false, reason: REFRESH_REASON }
}

/**
 * Query param of the open editor page, read from the tab's live URL when possible, so a panel opened or closed
 * after the run pinned its page still counts (the editor opens panels purely through these query params).
 */
export function editorParam(ctx: ToolContext, name: 'stepId' | 'slugName', scriptId?: string): string | undefined {
  if (ctx.page.kind !== 'flow-editor' || (scriptId && ctx.page.scriptId !== scriptId)) return undefined
  const page = ctx.page.scriptId ? editorPageOf(ctx, ctx.page.scriptId) : ctx.page
  return page ? urlParam(page.url, name) : undefined
}

/**
 * Bumps ?timestamp so the open editor refetches the flow (and, when the draft version moved, reloads an open
 * panel's cached step too). Only for the flow open in this tab; reports whether the tab confirmed the refresh.
 */
export function refreshEditorIfOpen(ctx: ToolContext, scriptId: string, extra: Record<string, string | null> = {}): Promise<EditorSync> {
  return syncEditor(ctx, scriptId, extra)
}

/**
 * Opens a step's (or the trigger's) panel in the open editor so the user sees what was just configured. The
 * ?timestamp bump makes the editor refetch first, so the panel shows the saved state rather than a stale copy.
 * Only for the flow open in this tab; reports whether the tab confirmed it.
 */
export function openPanel(
  ctx: ToolContext,
  scriptId: string,
  stepId: string,
  slugName: string,
  extra: { stepType?: string; flowCondition?: string } = {},
): Promise<EditorSync> {
  return syncEditor(ctx, scriptId, {
    stepId,
    slugName,
    position: null,
    parent: null,
    stepType: extra.stepType ?? null,
    flowCondition: extra.flowCondition ?? null,
  })
}

/** The trigger's loop ('hitFlowIndividually') or run-if ('runIfCondition') panel. */
export function openTriggerFeaturePanel(
  ctx: ToolContext,
  scriptId: string,
  kind: string | undefined,
  flowCondition: 'hitFlowIndividually' | 'runIfCondition',
): Promise<EditorSync> {
  const type = kind === 'webhook' || kind === 'cron' || kind === 'email' ? kind : 'trigger'
  return openPanel(ctx, scriptId, `${type}-advance-config`, `${type}-advance-config`, { flowCondition })
}

/** The Get Data panel (the trigger's pre-process), of its kind: plugin, api or function. */
export function openGetDataPanel(ctx: ToolContext, scriptId: string, stepType: string): Promise<EditorSync> {
  return openPanel(ctx, scriptId, 'CRON_PRE_PROCESS', 'CRON_PRE_PROCESS', { stepType })
}

export function openTriggerPanel(ctx: ToolContext, scriptId: string, kind: string | undefined): Promise<EditorSync> {
  return openPanel(ctx, scriptId, 'SET_TRIGGER', triggerPanelSlug(kind))
}
