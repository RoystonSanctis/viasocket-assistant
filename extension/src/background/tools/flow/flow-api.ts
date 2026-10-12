// Reading flows and resolving which flow a tool may act on.

import { SCRIPT_ID_RE, STEP_ID_RE } from '../ids'
import type { ToolContext } from '../types'
import { VsError } from '../viasocket-client'
import { call, ToolError } from './errors'
import { isKnownProject, knownFlowProject, rememberProject } from './known'
import type { Block, FlowRow, FlowTarget, FunctionRow, JsonScript, PluginData, Trigger } from './types'
import { pagePathWithParams } from './urls'
import { asArray, asRecord, isRecord, ORG_ID_RE, parseMaybeJson, PROJECT_ID_RE, str, truncate } from './util'

export function requireOrg(ctx: ToolContext): string {
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
export async function getFlow(ctx: ToolContext, t: FlowTarget): Promise<FlowRow> {
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

export async function getFunctionRow(ctx: ToolContext, t: FlowTarget, stepId: string): Promise<FunctionRow | null> {
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

export function summarizeTrigger(trigger: Trigger | undefined, scriptId: string, vmBase: string): Record<string, unknown> | null {
  const kind = triggerKind(trigger)
  if (!trigger || !kind) return null
  const base: Record<string, unknown> = { type: kind, state: trigger.type }
  switch (kind) {
    case 'webhook':
      return { ...base, url: `${vmBase}/func/${scriptId}`, note: 'The URL runs the live flow after publishing.' }
    case 'email':
      return { ...base, address: `${scriptId}@sokt.io` }
    case 'cron':
      return { ...base, cronExpression: trigger.cronExpression, meaning: trigger.meaning, timezone: trigger.timezone }
    default: {
      const inputData = asRecord(trigger.selectedValues?.inputData)
      return {
        ...base,
        app: trigger.serviceName,
        action: trigger.actionName,
        actionId: trigger.selectedCreate,
        drafted: trigger.isDrafted === true || undefined,
        connected: !!trigger.selectedValues?.authData?.id,
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
    node.connected = !!pd?.selectedValues?.authData?.id
  }
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

/** Query param of the open editor page. parsePage reads stepId/slugName only on the /slider route. */
export function editorParam(ctx: ToolContext, name: 'stepId' | 'slugName', scriptId?: string): string | undefined {
  if (ctx.page.kind !== 'flow-editor' || (scriptId && ctx.page.scriptId !== scriptId)) return undefined
  try {
    return new URL(ctx.page.url).searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Live-apply (sent-by-fbai) swaps only the editor's draft json_script; status, title and an open step panel stay
 * stale. Bumping ?timestamp makes the editor refetch.
 */
export function refreshEditorIfOpen(ctx: ToolContext, scriptId: string, extra: Record<string, string | null> = {}): void {
  if (ctx.page.kind !== 'flow-editor' || ctx.page.scriptId !== scriptId) return
  try {
    ctx.ui.navigate(pagePathWithParams(ctx.page.url, { ...extra, timestamp: String(Date.now()) }), { replace: true })
  } catch {
    // Refreshing is best-effort; the write itself already succeeded.
  }
}
