// Background handler for whole-flow export / import: an n8n-style JSON file the user can download from one
// flow and import into another workspace or account.
//
// Export is two reads (the flow row and its per-step code rows) assembled into a FlowExportFile. Import replays
// that file into a brand-new flow: create the flow, set the trigger (with its Get Data / loop / run-if), then
// walk the exported step order parents-first, creating every step with a fresh stepId but its original slug
// (mappings reference steps by slug, so renaming would break them). Connections never travel with the file -
// steps whose connection does not exist in the target stay drafts, reported as warnings, mirroring what the
// server itself does when duplicating a flow across workspaces.
//
// Every import write goes out without live-apply: the new flow has no open editor, so the header would only
// cost a broadcast. All writes are serialized through the client's per-flow queue, because the server rewrites
// the whole flow JSON on each one.

import * as z from '../shared/zod'
import {
  FLOW_EXPORT_NOTE,
  FLOW_EXPORT_VERSION,
  MAX_IMPORT_BLOCKS,
  MAX_IMPORT_BYTES,
  type ExportedFunction,
  type FlowExportFile,
  type FlowExportResult,
  type FlowImportResult,
  type FlowTransferRequest,
  type FlowTransferResponse,
} from '../shared/flow-transfer'
import { getClientForSender } from './step-clipboard'
import { newScriptId, SCRIPT_ID_RE } from './tools/ids'
import type { ViaSocketClient } from './tools/viasocket-client'
import { VsError } from './tools/viasocket-client'
import { normalizeFlow, orphanBlocks, slugForStepId } from './tools/flow/flow-api'
import { isValidSlug, stepSlug } from './tools/flow/slugs'
import {
  apiBody, breakBody, functionBody, ifBlockBody, MAX_CODE_CHARS, pluginBody, responseBody, variableBody, type SaveCommon,
} from './tools/flow/step-bodies'
import type { AuthData, Block, JsonScript, PluginData, Trigger } from './tools/flow/types'
import { asArray, asRecord, isRecord, ORG_ID_RE, parseMaybeJson, prefixedStepId, PROJECT_ID_RE, str } from './tools/flow/util'

/**
 * A slug usable as a step name: the editor's own rules (4-50 chars, letter then letters/digits/underscores, no
 * reserved word) - slugs become identifiers in the generated flow code, so anything looser breaks it at run time.
 */
function postableSlug(slug: string): string {
  return isValidSlug(slug) ? slug : stepSlug(slug)
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/** Why a step stayed a draft, in the user's terms. Missing connections are the expected cross-account case. */
function draftReason(e: unknown): string {
  if (e instanceof VsError && /authentication verification failed/i.test(e.message)) {
    return 'pick a connection for it and save (connections never travel with an export).'
  }
  return `${messageOf(e)} - finish it by hand.`
}

export async function handleFlowTransferRequest(
  req: FlowTransferRequest,
  sender: chrome.runtime.MessageSender,
): Promise<FlowTransferResponse> {
  try {
    switch (req.type) {
      case 'flow:export':
        return { ok: true, data: await exportFlow(req, sender) }
      case 'flow:import':
        return { ok: true, data: await importFlow(req, sender) }
    }
    return { ok: false, error: 'Unknown flow transfer request' }
  } catch (e) {
    return { ok: false, error: messageOf(e) || 'Flow transfer failed' }
  }
}

// ---------------------------------------------------------------- export ----------------------------------------------------------------

async function exportFlow(
  req: Extract<FlowTransferRequest, { type: 'flow:export' }>,
  sender: chrome.runtime.MessageSender,
): Promise<FlowExportResult> {
  const { scriptId, projectId } = req
  if (!SCRIPT_ID_RE.test(scriptId)) throw new Error('scriptId must be a 12-character flow id')
  if (!PROJECT_ID_RE.test(projectId)) throw new Error('That does not look like a viaSocket project id')
  const client = await getClientForSender(sender, { scriptId, projectId, orgId: req.orgId, host: req.host })
  if (!client) throw new Error('Could not connect to viaSocket for this page')

  const flowRes = await client.request({ method: 'GET', path: `/projects/${projectId}/scripts/${scriptId}`, query: { type: 'flow' } })
  const row = normalizeFlow(asRecord(flowRes).data)
  if (!row) throw new Error(`Flow ${scriptId} was not found`)

  // Dead weight never leaves: deleted blocks and blocks nothing in `order` reaches any more.
  const js = row.json_script
  const orphans = new Set(orphanBlocks(js))
  const blocks: Record<string, Block> = {}
  for (const [k, b] of Object.entries(js.blocks)) if (b.status !== 'DELETE' && !orphans.has(k)) blocks[k] = b
  const order: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(js.order)) {
    if (k !== 'root' && !blocks[k]) continue
    order[k] = list.filter((s) => !!blocks[s])
  }

  // Per-step code rows, keyed by slug. Drafted steps have no meaningful row: their config travels in the block.
  const functions: Record<string, ExportedFunction> = {}
  let rows: Record<string, unknown>[] = []
  try {
    const fnRes = await client.request({ method: 'GET', path: `/scripts/${scriptId}/functions` })
    rows = asArray(asRecord(fnRes).data).filter(isRecord)
  } catch {
    // The structure still exports; the steps will land as drafts on import.
  }
  const warnings: string[] = []
  const byId = new Map(rows.map((r) => [str(r.id) ?? '', r]))
  for (const [slug, b] of Object.entries(blocks)) {
    if (b.type !== 'plugin' && b.type !== 'function' && b.type !== 'api') continue
    if (b.status === 'DRAFTED') continue
    const fnRow = b.identifier ? byId.get(b.identifier) : undefined
    if (!fnRow) continue
    const entry: ExportedFunction = { type: str(fnRow.type) ?? b.type }
    if (typeof fnRow.code === 'string') entry.code = fnRow.code
    else if (fnRow.code != null) entry.code = JSON.stringify(fnRow.code)
    // The save route caps step code; a larger blob could never be replayed, and leaving it in would make the
    // import refuse the whole file. The file stays honest: the code is left out and the export says so.
    if (entry.code !== undefined && entry.code.length > MAX_CODE_CHARS) {
      delete entry.code
      warnings.push(`"${slug}": its code is larger than a step save accepts, so it was left out; after an import, paste its code by hand.`)
    }
    // Dynamic variables live under the row's metadata.drafted, not at its top level.
    const drafted = asRecord(asRecord(fnRow.metadata).drafted)
    if (isRecord(drafted.dynamicVariables) && Object.keys(drafted.dynamicVariables).length) {
      entry.dynamicVariables = drafted.dynamicVariables
    }
    if (b.subfunctions !== undefined) entry.subfunctions = b.subfunctions
    const authId = str(fnRow.auth_id)
    if (authId) entry.auth_id = authId
    const actionId = str(fnRow.action_id)
    if (actionId) entry.action_id = actionId
    functions[slug] = entry
  }

  const title = str(row.title)?.trim() || scriptId
  const description = str(asRecord(row.metadata).description)
  const file: FlowExportFile = {
    viasocketFlowExport: FLOW_EXPORT_VERSION,
    source: {
      host: client.page.host,
      orgId: req.orgId || client.page.orgId,
      projectId,
      scriptId,
      title,
      exportedAt: new Date().toISOString(),
    },
    flow: {
      title,
      ...(description ? { description } : {}),
      json_script: { ...js, order, blocks } as unknown as Record<string, unknown>,
      functions,
    },
    note: FLOW_EXPORT_NOTE,
  }
  const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'flow'
  return { fileName: `viasocket-flow-${safeTitle}-${scriptId}.json`, json: JSON.stringify(file, null, 2), title, warnings }
}

// ---------------------------------------------------------------- import ----------------------------------------------------------------

const exportedFunctionSchema = z.looseObject({
  type: z.string().min(1).max(40),
  code: z.string().max(MAX_CODE_CHARS).optional(),
  dynamicVariables: z.record(z.string(), z.unknown()).optional(),
  subfunctions: z.unknown().optional(),
  auth_id: z.string().max(100).optional(),
  action_id: z.string().max(100).optional(),
})

const exportFileSchema = z.looseObject({
  viasocketFlowExport: z.literal(FLOW_EXPORT_VERSION),
  source: z.looseObject({
    host: z.string().max(200),
    orgId: z.string().max(40).optional(),
    projectId: z.string().max(60).optional(),
    scriptId: z.string().max(40),
    title: z.string().max(300),
    exportedAt: z.string().max(60),
  }),
  flow: z.looseObject({
    title: z.string().min(1).max(300),
    description: z.string().max(2000).optional(),
    json_script: z.looseObject({
      trigger: z.record(z.string(), z.unknown()).optional(),
      order: z.record(z.string(), z.array(z.string().min(1).max(80))),
      blocks: z.record(z.string(), z.looseObject({ type: z.string().min(1).max(40) })),
    }),
    functions: z.record(z.string(), exportedFunctionSchema),
  }),
  note: z.string().max(4000).optional(),
})

interface ImportCtx {
  client: ViaSocketClient
  orgId: string
  projectId: string
  /** The NEW flow's id; every path below uses it. */
  scriptId: string
  blocks: Record<string, Block>
  order: Record<string, string[]>
  functions: Record<string, ExportedFunction>
  warnings: string[]
  /** Steps that landed as unsaved drafts, listed once at the end. */
  drafted: string[]
  /** Exported keys already recreated (or started): a key repeated across order lists is created once. */
  visited: Set<string>
  /** Steps created so far; a file whose order lists expand past MAX_IMPORT_BLOCKS aborts the import. */
  created: number
}

/** Thrown when a malformed file would drive more creates than MAX_IMPORT_BLOCKS; never turned into a warning. */
class ImportLimitError extends Error {}

async function importFlow(
  req: Extract<FlowTransferRequest, { type: 'flow:import' }>,
  sender: chrome.runtime.MessageSender,
): Promise<FlowImportResult> {
  if (req.json.length > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a viaSocket flow export')
  let parsed: unknown
  try {
    parsed = JSON.parse(req.json)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  const check = exportFileSchema.safeParse(parsed)
  if (!check.success) {
    throw new Error('That file is not a viaSocket flow export (or was made by a newer version of this extension)')
  }
  const file = check.data
  const blocks = file.flow.json_script.blocks as unknown as Record<string, Block>
  const order: Record<string, string[]> = { root: [], ...file.flow.json_script.order }
  if (Object.keys(blocks).length > MAX_IMPORT_BLOCKS) {
    throw new Error(`The export has more than ${MAX_IMPORT_BLOCKS} steps; this importer refuses it`)
  }

  const client = await getClientForSender(sender, { projectId: req.projectId, orgId: req.orgId, host: req.host })
  if (!client) throw new Error('Could not connect to viaSocket for this page')
  const orgId = client.orgId && ORG_ID_RE.test(client.orgId) ? client.orgId : (req.orgId ?? '')
  if (!ORG_ID_RE.test(orgId)) throw new Error('Open a viaSocket workspace page first')
  const projectId = PROJECT_ID_RE.test(req.projectId) ? req.projectId : `proj${orgId}`

  const trigger = isRecord(file.flow.json_script.trigger) ? (file.flow.json_script.trigger as Trigger) : undefined
  const triggerType = str(trigger?.triggerType)

  // The flow-create route runs in the token's cached org, so align it to the page's org right before creating.
  await client.alignOrg(undefined, { force: true })

  // Email triggers address the flow as <id>@..., and that address is lowercased - so the id must be too.
  const identifier = newScriptId(triggerType === 'email')

  return client.mutate(identifier, async () => {
    const createBody: Record<string, unknown> = { identifier, title: file.flow.title }
    if (file.flow.description?.trim()) createBody.description = file.flow.description.trim()
    const createRes = await client.request({
      method: 'POST',
      path: `/projects/${projectId}/scripts`,
      body: createBody,
      live: false,
    })
    const returnedId = str(asRecord(asRecord(createRes).data).id)
    const scriptId = returnedId && SCRIPT_ID_RE.test(returnedId) ? returnedId : identifier

    const ictx: ImportCtx = {
      client, orgId, projectId, scriptId, blocks, order,
      functions: file.flow.functions as Record<string, ExportedFunction>,
      warnings: [], drafted: [], visited: new Set(), created: 0,
    }
    if (trigger && triggerType) await importTrigger(ictx, trigger, triggerType)
    await importChildren(ictx, 'root', 'root', 0)
    if (ictx.drafted.length) ictx.warnings.push(`Left as unsaved drafts to finish by hand: ${ictx.drafted.join(', ')}.`)

    return {
      scriptId,
      title: file.flow.title,
      path: `/projects/${orgId}/${projectId}/workflow/${scriptId}/draft`,
      warnings: ictx.warnings,
    }
  })
}

// ---------- trigger ----------

async function importTrigger(ictx: ImportCtx, trigger: Trigger, kind: string): Promise<void> {
  const { client, projectId, scriptId, warnings } = ictx
  let body: Record<string, unknown>
  if (kind === 'webhook' || kind === 'email') {
    body = { triggerType: kind, type: 'add' }
  } else if (kind === 'cron') {
    // Never `statement` on a schedule: the route would treat it as a natural-language schedule and override
    // the expression.
    body = { triggerType: 'cron', type: 'add' }
    if (str(trigger.cronExpression)) body.cronExpression = trigger.cronExpression
    if (str(trigger.meaning)) body.meaning = trigger.meaning
    if (str(trigger.timezone)) body.timezone = trigger.timezone
  } else {
    // App trigger (hook / polling / manual webhook): the exported trigger minus everything bound to the source
    // flow or account. The route stores the body verbatim and does not check the connection, so a foreign
    // connection reference saves fine but cannot subscribe or poll until the user reconnects it.
    const t: Record<string, unknown> = { ...trigger }
    for (const k of ['preProcess', 'loops', 'preProcessFilter', 'preCondition', 'isDrafted', 'componentCode', 'scriptId', 'url', 'cron_job_id', 'statement']) {
      delete t[k]
    }
    const selected = asRecord(trigger.selectedValues)
    const authData = asRecord(selected.authData)
    const inputData = { ...asRecord(selected.inputData) }
    delete inputData.performsubscribe
    delete inputData.performSubscribe
    if (str(inputData.hookUrl)) inputData.hookUrl = `${client.env.vmBase}/func/${scriptId}`
    t.selectedValues = { ...selected, authData, inputData }
    t.type = 'add' // nothing is subscribed or polling for the new flow yet
    t.triggerType = kind
    t.name = 'trigger'
    body = t
    if (str(authData.id)) warnings.push("Trigger: reconnect its connection in this workspace before publishing (connections never travel with an export).")
  }
  if (trigger.sampleData !== undefined && body.sampleData === undefined) body.sampleData = trigger.sampleData

  try {
    await client.request({ method: 'POST', path: `/scripts/${projectId}/${scriptId}/trigger`, body, live: false })
  } catch (e) {
    warnings.push(`The trigger could not be recreated (${messageOf(e)}); set it up by hand.`)
    return
  }
  // Every trigger kind can carry a run-if (and app triggers keep their loop/filter settings too); only webhook
  // and schedule triggers have Get Data. The preprocess route merges whatever the body carries.
  await importTriggerFeatures(ictx, trigger, kind === 'webhook' || kind === 'cron')
  if (kind === 'webhook') await importResponseBlock(ictx)
}

/** Get Data, run-once-per-item and run-if, restored in one call (the server merges whatever the body carries). */
async function importTriggerFeatures(ictx: ImportCtx, trigger: Trigger, includeGetData: boolean): Promise<void> {
  const body: Record<string, unknown> = {}
  const pre = asRecord(trigger.preProcess)
  if (includeGetData && Object.keys(pre).length) {
    const p: Record<string, unknown> = {
      ...pre,
      stepId: 'CRON_PRE_PROCESS',
      title: 'CRON_PRE_PROCESS',
      steps: '2',
      org_id: ictx.orgId,
      project_id: ictx.projectId,
    }
    // Sent alongside a non-schedule trigger this flag would convert the trigger itself; never forward it.
    delete p.isPollingActionForTrigger
    const code = parseMaybeJson(p.code)
    if (p.type === 'plugin' && isRecord(code)) {
      // The route re-fetches the action's own perform code; the exported copy would only go stale.
      const cleaned = { ...code }
      delete cleaned.source
      p.code = cleaned
    }
    body.preProcess = p
    if (str(pre.auth_id)) ictx.warnings.push('Get Data: reconnect its connection in this workspace before publishing.')
  }
  if (!includeGetData && Object.keys(pre).length) {
    ictx.warnings.push('Get Data only exists on webhook and schedule triggers, so the exported Get Data step was not recreated.')
  }
  const loops = asRecord(trigger.loops)
  if (Object.keys(loops).length) body.loops = loops
  const filter = asRecord(trigger.preProcessFilter)
  if (Object.keys(filter).length) body.preProcessFilter = filter
  const pc = asRecord(trigger.preCondition)
  if (Object.keys(pc).length) body.preCondition = { ...pc, steps: '3' }
  if (!Object.keys(body).length) return
  try {
    await ictx.client.request({ method: 'POST', path: `/scripts/${ictx.projectId}/${ictx.scriptId}/trigger/preprocess`, body, live: false })
  } catch (e) {
    ictx.warnings.push(`Get Data / loop / run-if settings could not be recreated (${messageOf(e)}).`)
  }
}

/** The webhook reply. Adding a webhook trigger creates the default one; only a custom reply needs a save. */
async function importResponseBlock(ictx: ImportCtx): Promise<void> {
  const resp = ictx.blocks.response
  if (!resp || resp.responseType !== 'custom') return
  try {
    const body = responseBody('custom', String(resp.data ?? ''), isRecord(resp.customHeaders) ? resp.customHeaders : undefined)
    await putStepReq(ictx, 'response', body)
  } catch (e) {
    ictx.warnings.push(`The custom webhook response could not be recreated (${messageOf(e)}).`)
  }
}

// ---------- steps ----------

async function putStepReq(ictx: ImportCtx, slug: string, body: Record<string, unknown>): Promise<unknown> {
  return ictx.client.request({
    method: 'PUT',
    path: `/scripts/${ictx.scriptId}/stepv2/${encodeURIComponent(slug)}`,
    body,
    live: false,
  })
}

/**
 * POST one step and read back the slug the server actually stored it under (names are de-duplicated silently,
 * so the sent title is never trusted).
 */
async function createStep(ictx: ImportCtx, body: Record<string, unknown>): Promise<{ js: JsonScript; slug: string }> {
  // The block count was validated up front, but order lists can repeat keys (or fan out through nested
  // branches), so the real guard against a runaway write loop is this per-create counter.
  if (ictx.created >= MAX_IMPORT_BLOCKS) {
    throw new ImportLimitError(
      `The file's step order expands past ${MAX_IMPORT_BLOCKS} steps (repeated entries make it malformed), so the import was stopped; the partly imported flow was left in place.`,
    )
  }
  ictx.created += 1
  const res = await ictx.client.request({
    method: 'POST',
    path: `/scripts/${ictx.projectId}/${ictx.scriptId}/stepv2`,
    body,
    live: false,
  })
  const js = normalizeFlow(asRecord(res).script)?.json_script
  const slug = js ? slugForStepId(js, String(body.stepId)) : undefined
  if (!js || !slug) throw new Error('the created step is missing from the server response')
  return { js, slug }
}

async function importChildren(ictx: ImportCtx, exportedParent: string, newParent: string, depth: number): Promise<void> {
  if (depth > 8) {
    ictx.warnings.push(`Steps nested deeper than 8 levels under "${exportedParent}" were skipped.`)
    return
  }
  for (const slug of ictx.order[exportedParent] ?? []) {
    if (slug === 'response') continue
    // A key listed more than once (in this or any other order list) is created exactly once.
    if (ictx.visited.has(slug)) continue
    ictx.visited.add(slug)
    const block = ictx.blocks[slug]
    if (!block) continue
    try {
      await importStep(ictx, slug, block, newParent, depth)
    } catch (e) {
      if (e instanceof ImportLimitError) throw e
      ictx.warnings.push(`"${slug}" was skipped (${messageOf(e)}); add it by hand.`)
    }
  }
}

async function importStep(ictx: ImportCtx, exportedSlug: string, block: Block, newParent: string, depth: number): Promise<void> {
  switch (block.type) {
    case 'ifGroup':
      return importGroup(ictx, exportedSlug, newParent, depth)
    case 'ifBlock':
      // Branches only exist inside a condition group; one loose in a step list is export damage.
      ictx.warnings.push(`"${exportedSlug}" is a condition branch outside any condition; skipped.`)
      return
    case 'comment': {
      // Comment keys equal their stepId, and comments live under root only.
      const stepId = prefixedStepId('cmnt')
      const body: Record<string, unknown> = { type: 'comment', title: stepId, stepId, orderGroup: 'root', data: String(block.data ?? '') }
      if (isRecord(block.metadata)) body.metadata = block.metadata
      await createStep(ictx, body)
      return
    }
    case 'plugin':
    case 'function':
    case 'api':
    case 'variable':
    case 'break':
      return importBasicStep(ictx, exportedSlug, block, newParent)
    default:
      ictx.warnings.push(`"${exportedSlug}" has a step type this importer cannot recreate (${block.type}); skipped.`)
  }
}

async function importBasicStep(ictx: ImportCtx, exportedSlug: string, block: Block, newParent: string): Promise<void> {
  const type = block.type as 'plugin' | 'function' | 'api' | 'variable' | 'break'
  const stepId = prefixedStepId(type === 'variable' ? 'vari' : type === 'break' ? 'btkc' : 'func')
  const title = postableSlug(exportedSlug)
  if (title !== exportedSlug) {
    ictx.warnings.push(`"${exportedSlug}" had to be renamed to "${title}"; later steps referencing it need their mappings fixed.`)
  }
  const fn = ictx.functions[exportedSlug]
  const parsedCode = fn?.code !== undefined ? parseMaybeJson(fn.code) : undefined

  const post: Record<string, unknown> = { type, title, stepId, orderGroup: newParent }
  if (str(block.description)) post.description = block.description
  let pd: PluginData | undefined
  if (type === 'plugin') {
    pd = isRecord(parsedCode) ? (parsedCode as PluginData) : isRecord(block.metaData) ? block.metaData : undefined
    // The create route wants the catalog action id, which the saved config carries as selectedCreate.
    const actionId = str(pd?.selectedCreate) ?? str(fn?.action_id)
    if (!actionId) {
      ictx.warnings.push(`"${exportedSlug}" was skipped: the export carries no action id for it.`)
      return
    }
    post.actionId = actionId
    if (str(block.iconUrl)) post.iconUrl = block.iconUrl
  }
  if (type === 'break') Object.assign(post, { data: '', _data: '' })

  const { js, slug } = await createStep(ictx, post)
  if (slug !== title) {
    ictx.warnings.push(`"${exportedSlug}" was stored as "${slug}" (name already taken); later steps referencing it need their mappings fixed.`)
  }

  const c: SaveCommon = {
    stepId,
    title: slug,
    description: block.description,
    sampleData: block.sampleData,
    iconUrl: block.iconUrl,
    hidden: block.hidden,
  }
  const drafted = block.status === 'DRAFTED'
  try {
    let body: Record<string, unknown> | undefined
    if (type === 'plugin') {
      if (drafted || !pd || !isRecord(parsedCode)) {
        // A drafted app step was never saved in the source either; the create alone reproduces it.
        ictx.drafted.push(slug)
        return
      }
      let authData = asRecord(asRecord(pd.selectedValues).authData) as AuthData
      if (authData.hidden === true) {
        // Built-in tools (agents, run-a-flow) use a per-workspace hidden connection the create attaches; the
        // exported one belongs to the source workspace.
        const fresh = asRecord(asRecord(asRecord(js.blocks[slug]?.metaData).selectedValues).authData)
        if (str(fresh.id)) authData = fresh as AuthData
        ictx.warnings.push(`"${slug}": re-pick what this built-in tool points at (agents and flows are account-specific ids).`)
      }
      const inputData = asRecord(asRecord(pd.selectedValues).inputData)
      body = pluginBody(c, pd, authData, inputData)
    } else if (type === 'function') {
      if (!fn || typeof fn.code !== 'string') {
        // No code in the file (drafted at the source, or left out of the export): a draft either way.
        ictx.drafted.push(slug)
        return
      }
      body = functionBody(c, fn.code, {
        dynamicVariables: fn.dynamicVariables,
        authId: fn.auth_id,
        subfunctions: block.subfunctions ?? fn.subfunctions,
      })
    } else if (type === 'api') {
      if (!isRecord(parsedCode)) {
        // No saved configuration in the file: a draft either way.
        ictx.drafted.push(slug)
        return
      }
      body = apiBody(c, parsedCode, { dynamicVariables: fn?.dynamicVariables, authId: fn?.auth_id })
    } else if (type === 'variable') {
      body = variableBody(c, String(block.data ?? ''))
      // Keep the editor's rich markup for the expression when the export has it; the plain expression is in data.
      if (str(block.html)) body.html = block.html
    } else {
      // break: created inert above; only a filled expression or mode needs the extra save.
      if (!str(block.data) && !str(block.mode)) return
      body = breakBody(c, String(block.data ?? ''), block.mode)
    }
    if (body) await putStepReq(ictx, slug, body)
  } catch (e) {
    ictx.warnings.push(`"${slug}" stays a draft: ${draftReason(e)}`)
  }
}

/**
 * A condition group: the group and its first branch in one create, further branches as extra creates, then each
 * branch's condition saved. Saving any branch makes the server create the group's own "otherwise" branch (its
 * key is server-made, always last), so the exported otherwise-branch is never created - only its children are,
 * under the fresh key read back from the flow.
 */
async function importGroup(ictx: ImportCtx, exportedGroup: string, newParent: string, depth: number): Promise<void> {
  // Branch keys are consumed here (not through importChildren), so they are deduplicated and marked visited
  // here too - a branch repeated in this or another order list must not be created twice.
  const branchKeys = [...new Set(ictx.order[exportedGroup] ?? [])].filter((b) => !ictx.visited.has(b))
  for (const b of branchKeys) ictx.visited.add(b)
  const nonElse = branchKeys.filter((b) => ictx.blocks[b]?.type === 'ifBlock' && ictx.blocks[b]?.isElseBlock !== true)
  const elseKeys = branchKeys.filter((b) => ictx.blocks[b]?.isElseBlock === true)

  // Group keys equal their stepId (the create requires it); groups are only ever referenced by order, never in code.
  const groupId = prefixedStepId('swtc')
  const firstExported = nonElse[0]
  const firstId = prefixedStepId('ifcb')
  const { js: createdJs } = await createStep(ictx, {
    type: 'ifGroup',
    title: groupId,
    stepId: groupId,
    orderGroup: newParent,
    stepChildDetails: {
      type: 'ifBlock',
      title: firstExported ? postableSlug(firstExported) : firstId,
      orderGroup: groupId,
      stepId: firstId,
    },
  })
  const newGroupKey = slugForStepId(createdJs, groupId) ?? groupId

  const made = new Map<string, { slug: string; stepId: string }>()
  if (firstExported) {
    const firstSlug = slugForStepId(createdJs, firstId)
    if (firstSlug) made.set(firstExported, { slug: firstSlug, stepId: firstId })
  }
  for (const b of nonElse.slice(1)) {
    const stepId = prefixedStepId('ifcb')
    try {
      const { slug } = await createStep(ictx, { type: 'ifBlock', title: postableSlug(b), stepId, orderGroup: newGroupKey })
      made.set(b, { slug, stepId })
    } catch (e) {
      if (e instanceof ImportLimitError) throw e
      ictx.warnings.push(`Branch "${b}" was skipped (${messageOf(e)}).`)
    }
  }

  for (const b of nonElse) {
    const m = made.get(b)
    const block = ictx.blocks[b]
    if (!m || !block) continue
    try {
      const condition = String(block.condition ?? '')
      const statement = str(block.statement) ?? condition.slice(0, 80)
      const body = ifBlockBody({ stepId: m.stepId, title: m.slug, description: block.description }, condition, statement, block.dynamicVariables)
      // Keep the editor's rich markup for the condition when the export has it.
      if (str(block.html)) body.html = block.html
      await putStepReq(ictx, m.slug, body)
    } catch (e) {
      ictx.warnings.push(`Branch "${b}" could not be saved: ${draftReason(e)}`)
    }
  }

  for (const b of nonElse) {
    const m = made.get(b)
    if (m) await importChildren(ictx, b, m.slug, depth + 1)
  }

  if (!elseKeys.length) return
  const elseChildren = elseKeys.flatMap((b) => ictx.order[b] ?? [])
  if (!elseChildren.length) return
  let elseSlug: string | undefined
  try {
    const flowRes = await ictx.client.request({
      method: 'GET',
      path: `/projects/${ictx.projectId}/scripts/${ictx.scriptId}`,
      query: { type: 'flow' },
    })
    const row = normalizeFlow(asRecord(flowRes).data)
    const groupOrder = row?.json_script.order[newGroupKey] ?? []
    elseSlug = groupOrder.find((k) => row?.json_script.blocks[k]?.isElseBlock === true)
  } catch {
    // warned below
  }
  if (!elseSlug) {
    ictx.warnings.push(`The "otherwise" steps of condition "${exportedGroup}" could not be recreated; add them by hand.`)
    return
  }
  for (const b of elseKeys) await importChildren(ictx, b, elseSlug, depth + 1)
}
