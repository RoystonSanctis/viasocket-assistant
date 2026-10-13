// Read-only tools for the editor's built-in tools: what the "Add step" panel offers (vs_list_builtin_tools) and the
// AI agents of the workspace (vs_list_ai_agents), so the assistant offers real choices instead of guessing.

import type { Tool, ToolContext } from '../types'
import { normalizeInputJson } from './catalog'
import { actionEntry, builtinCatalog, findField, kindFromStep, knownKind, resolveSpecial, type SpecialKind } from './builtins'
import { isAbortError, ToolError } from './errors'
import { loadFieldOptions, rememberOptions, depsSignature, stepKey } from './fields'
import { getFlow, getFunctionRow, listFunctionRows, pluginDataOf, resolveFlow } from './flow-api'
import { defineTool, params, S } from './schema'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, Block, FlowTarget, FunctionRow } from './types'
import { asRecord, bounded, FLOW_PAGES, ROW_ID_RE, SLUG_RE, str } from './util'

const pages = [...FLOW_PAGES]

const CORE_STEPS = [
  { name: 'JS Code', addWith: { type: 'function' }, use: 'Custom JavaScript that returns a value (context.res.<slug>).', getData: true },
  { name: 'API Call', addWith: { type: 'api' }, use: 'An HTTP request to any API.', getData: true },
  { name: 'Variable', addWith: { type: 'variable' }, use: 'A named value for later steps (context.vals.<slug>).', getData: false },
  { name: 'Multiple Paths (If Conditions)', addWith: { type: 'condition' }, use: 'Branches; each branch runs when its condition is true, the else-branch when none is.', getData: false },
  { name: 'Comment', addWith: { type: 'comment' }, use: 'A note on the canvas.', getData: false },
  { name: 'Break the flow', addWith: { type: 'break' }, use: 'Stops the whole run; only as the last step inside a branch.', getData: false },
  { name: 'Response', addWith: { tool: 'vs_set_response' }, use: 'Webhook flows: what the caller receives.', getData: false },
]

const PANEL_TOOLS: Array<{ kind: SpecialKind; name: string; addWith: Record<string, unknown>; use: string; getData: boolean; betaOnly?: boolean }> = [
  { kind: 'delay', name: 'Delay', addWith: { type: 'delay' }, use: 'Pauses the run for a while (1 minute to 30 days), or until a date.', getData: false },
  { kind: 'approval', name: 'Human Intervention', addWith: { type: 'approval', actionId: '<one of channels>' }, use: 'Asks a person to approve; the run waits for the answer.', getData: false },
  { kind: 'ai_agent', name: 'Call AI Agent (Instant)', addWith: { type: 'ai_agent' }, use: "Runs one of the workspace's AI agents and returns its answer right away.", getData: true },
  { kind: 'ai_agent_background', name: 'Call AI Agent (Background)', addWith: { type: 'ai_agent', background: true }, use: 'Runs an agent in the background; later steps wait for the answer (minutes).', getData: true },
  { kind: 'flow_in_flow', name: 'Flow in Flow', addWith: { type: 'flow_in_flow' }, use: 'Runs another flow (pick it from vs_list_flows) and returns its response.', getData: true },
  { kind: 'memory', name: 'Workspace Memory', addWith: { type: 'plugin', actionId: '<actionId>' }, use: 'Stores and reads values shared by every flow of the workspace (needs a Memory connection).', getData: false, betaOnly: true },
]

const listBuiltinTools = defineTool<{ forGetData?: boolean }>({
  name: 'vs_list_builtin_tools',
  description:
    "List the editor's built-in tools with how to add each one: core steps (JS code, API call, variable, multiple paths, comment, break, response), the panel's tools (Delay, Human Intervention channels, Call AI Agent Instant/Background, Flow in Flow, Workspace Memory) and the built-in apps (e.g. Summarize Text, Translate Text, Extract Website Data, Convert HTML to PDF, Send WhatsApp Message) with their actionIds for vs_add_step type \"plugin\". Paid actions use AI credits. forGetData lists only what Get Data (vs_set_get_data) can run. Read only.",
  parameters: params({ forGetData: S.bool('Only tools that can be used as Get Data of a webhook or schedule trigger.') }),
  danger: 'safe',
  pages,
  describe: () => 'Looking at the built-in tools',
  async run(a, ctx) {
    const forGetData = a.forGetData === true
    const warnings: string[] = []
    let apps: Awaited<ReturnType<typeof builtinCatalog>> | undefined
    try {
      apps = await builtinCatalog(ctx)
    } catch (e) {
      if (isAbortError(e)) throw e
      warnings.push(`The built-in apps could not be listed (${e instanceof Error ? e.message : String(e)}).`)
    }
    const panel: Record<string, unknown>[] = []
    for (const tool of PANEL_TOOLS) {
      if (forGetData && !tool.getData) continue
      if (tool.betaOnly && !ctx.vs.env.betaUi) continue
      let rows: Awaited<ReturnType<typeof resolveSpecial>> = []
      try {
        rows = await resolveSpecial(ctx, tool.kind)
      } catch (e) {
        if (isAbortError(e)) throw e
      }
      const entry: Record<string, unknown> = { name: tool.name, use: tool.use, available: rows.length > 0 }
      if (!rows.length) entry.note = `Not found in this workspace's catalog. If the user adds "${tool.name}" from the Add step panel, configure it with vs_update_step.`
      else if (tool.kind === 'approval') {
        entry.addWith = tool.addWith
        entry.channels = rows.map((r) => ({ actionId: r.rowid, channel: str(r.pluginname) ?? str(r.name), needsConnection: !!r.authtype && r.authtype !== 'NoAuth' ? true : undefined }))
      } else {
        const first = rows[0]
        entry.addWith = tool.kind === 'memory' && first ? { type: 'plugin', actionId: first.rowid } : tool.addWith
        entry.actionId = first?.rowid
        if (first && actionEntry(first).isPaidAction) entry.isPaidAction = true
      }
      if (forGetData && (tool.kind === 'ai_agent' || tool.kind === 'ai_agent_background' || tool.kind === 'flow_in_flow')) {
        entry.getDataNote = 'The assistant cannot set this up as Get Data; the user can pick it in the Get Data panel.'
      }
      panel.push(entry)
    }
    const special = new Set(panel.flatMap((p) => [str(p.actionId), ...((p.channels as Array<{ actionId: string }> | undefined) ?? []).map((c) => c.actionId)]).filter(Boolean))
    const firstPerApp = new Set<string>()
    const builtInApps = (apps?.actions ?? [])
      .filter((r) => !special.has(r.rowid) && !knownKind(r.rowid))
      .map((r) => {
        const app = str(r.pluginrecordid) ?? ''
        const inPanel = !firstPerApp.has(app)
        firstPerApp.add(app)
        return { ...actionEntry(r), inPanelList: inPanel || undefined, addWith: forGetData ? { tool: 'vs_set_get_data', source: 'app', actionId: r.rowid } : { type: 'plugin', actionId: r.rowid } }
      })
      .slice(0, 80)
    return bounded(
      {
        coreSteps: CORE_STEPS.filter((c) => !forGetData || c.getData).map((c) => ({
          name: c.name,
          use: c.use,
          addWith: forGetData ? { tool: 'vs_set_get_data', source: c.addWith.type === 'api' ? 'api' : 'code' } : c.addWith,
        })),
        panelTools: panel,
        builtInApps,
        warnings: warnings.length ? warnings : undefined,
        notes: [
          'Paid actions (isPaidAction) use AI credits on every run (1 AI credit = 4 tasks): tell the user before adding one.',
          'Delay, Human Intervention and the background AI agent make the flow run step by step, and pause runs.',
          forGetData ? 'Get Data cannot use Variable, Multiple Paths, Comment, Break, Delay, Human Intervention, Workspace Memory or SMS.' : undefined,
        ].filter(Boolean),
      },
      ctx.maxResultChars,
    )
  },
})

/**
 * The flow's AI agent step: the one named, else the first step that is an AI agent by its action id or by what
 * viaSocket attached (hidden built-in connection plus an agent picker; saved steps keep that only in their functions
 * row, so it is read when needed, which also works after the service worker forgot the looked-up ids).
 */
async function agentStep(ctx: ToolContext, t: FlowTarget, js: { blocks: Record<string, Block> }, slugName: string | undefined): Promise<[string, Block] | undefined> {
  if (slugName) {
    const b = js.blocks[slugName]
    if (!b) throw new ToolError(`No step "${slugName}". Call vs_get_flow for the current slugs.`)
    if (b.type !== 'plugin') throw new ToolError(`"${slugName}" is not an AI agent step.`)
    return [slugName, b]
  }
  const plugins = Object.entries(js.blocks).filter(([, b]) => b.type === 'plugin' && b.status !== 'DELETE')
  const isAgentKind = (k: string | undefined) => k === 'ai_agent' || k === 'ai_agent_background'
  const byId = plugins.find(([, b]) => isAgentKind(knownKind(str(b.metaData?.selectedCreate) ?? str(b.service?.eventId))))
  if (byId) return byId
  const drafted = plugins.find(([, b]) => isAgentKind(kindFromStep(b, b.metaData)))
  if (drafted) return drafted
  if (!plugins.some(([, b]) => !b.metaData)) return undefined
  let rows: FunctionRow[] = []
  try {
    rows = await listFunctionRows(ctx, t)
  } catch (e) {
    if (isAbortError(e)) throw e
    return undefined
  }
  const fnById = new Map(rows.map((r) => [r.id, r]))
  return plugins.find(([, b]) => {
    const fn = b.identifier ? fnById.get(b.identifier) : undefined
    return isAgentKind(kindFromStep(b, pluginDataOf(b, fn)))
  })
}

const listAiAgents = defineTool<{ slugName?: string; scriptId?: string }>({
  name: 'vs_list_ai_agents',
  description:
    "List the workspace's AI agents as real choices for a Call AI Agent step (the same list as the step's agent picker). The list loads through the step's built-in connection, so the step must exist: add it first with vs_add_step type \"ai_agent\" (without agentId), then call this, ask the user to pick, and save the choice with vs_update_step (agentId). New agents are created by the user on the AI Agents page (/agents/<workspace id>). Read only.",
  parameters: params({
    slugName: S.str('The AI agent step (default: the first one in the flow).', { pattern: SLUG_RE.source }),
    scriptId: SCRIPT_ID_PARAM,
  }),
  danger: 'safe',
  pages,
  describe: () => 'Looking up your AI agents',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const js = (await getFlow(ctx, t)).json_script
    const found = await agentStep(ctx, t, js, a.slugName)
    const createAt = `/agents/${t.orgId}`
    if (!found) {
      return {
        agents: [],
        needsStep: true,
        next: 'Add the step first with vs_add_step type "ai_agent" (no agentId yet): viaSocket gives it a built-in connection that loads the agents. Then call vs_list_ai_agents.',
        createAgentsAt: createAt,
      }
    }
    const [slug, block] = found
    if (!block.identifier) throw new ToolError(`"${slug}" has no step id.`)
    const pd = pluginDataOf(block, await getFunctionRow(ctx, t, block.identifier))
    if (!pd) throw new ToolError('This step has no app definition. Delete it and add it again.')
    const authData = asRecord(pd.selectedValues?.authData) as AuthData
    if (!authData.id) throw new ToolError(`"${slug}" has no built-in connection (viaSocket did not create it). Delete the step and add it again.`)
    const avid = str(pd.actionVersionId) ?? ''
    if (!ROW_ID_RE.test(avid)) throw new ToolError('This step has no action version; add it again.')
    const ij = normalizeInputJson(pd.inputJson)
    const field = findField(ij, 'agent')
    if (!field) throw new ToolError(`"${slug}" has no agent field. Its fields: ${Object.keys(ij.blocks).slice(0, 20).join(', ')}.`)
    const inputData = asRecord(pd.selectedValues?.inputData)
    const r = await loadFieldOptions(ctx, t, { ij, fieldKey: field, authData, inputData, actionVersionId: avid, isTrigger: false, slug }, 100)
    const def = ij.blocks[field]
    if (def && r.options.length) rememberOptions(stepKey(ctx, t, block.identifier), field, depsSignature(field, def, inputData), r.options)
    return bounded(
      {
        step: slug,
        field,
        agents: r.options.map((o) => ({ label: o.label, value: o.value })),
        error: r.error,
        help: r.help,
        createAgentsAt: createAt,
        next: r.options.length
          ? `Show the agent names to the user, ask which one, then save it with vs_update_step slugName "${slug}" and agentId set to its value.`
          : `There are no agents yet. Ask the user to create one on the AI Agents page (${createAt}), wait until they say done, then call vs_list_ai_agents again.`,
      },
      ctx.maxResultChars,
    )
  },
})

export const BUILTIN_TOOLS: Tool<any>[] = [listBuiltinTools, listAiAgents]
