// Read-only flow tools: projects, flows, steps, the app catalog, connections and run data.

import type { Tool, ToolContext } from '../types'
import { fieldList, getActionRow, listActions, normalizeInputJson, searchApps, summarizeAction, isPaidAction } from './catalog'
import { listConnections, summarizeConnection } from './connections'
import { call, ToolError } from './errors'
import {
  everPublished, findParent, flowStatusLabel, getFlow, getFunctionRow, hasDraftChanges, listFunctionRows, listProjectRows,
  normalizeFlow, pluginDataOf, requireOrg, resolveFlow, summarizeFlow, summarizeTrigger, verifyProject,
} from './flow-api'
import { rememberFlow } from './known'
import { getRecentRun, summarizeRun } from './runs'
import { defineTool, params, S } from './schema'
import type { Block, FunctionRow, JsonScript, PluginData } from './types'
import {
  asArray, asRecord, bounded, FLOW_PAGES, isRecord, label, maskHeaders, maskVariables, parseMaybeJson, PROJECT_ID_RE, ROW_ID_RE,
  SLUG_RE, str, trimData, truncate,
} from './util'

const pages = [...FLOW_PAGES]

export const SCRIPT_ID_PARAM = S.str('Flow id (12 characters) from vs_list_flows or vs_create_flow. Omit to use the flow open in the editor.', {
  pattern: '^[A-Za-z0-9]{12}$',
})

const listProjects = defineTool<Record<string, never>>({
  name: 'vs_list_projects',
  description:
    'List the projects (folders of flows) in the open viaSocket workspace. Use it to choose where a new flow goes or to browse flows. The default project "proj<orgId>" always exists but is not listed.',
  parameters: params({}),
  danger: 'safe',
  pages,
  describe: () => 'Looking through your projects',
  async run(_a, ctx) {
    const orgId = requireOrg(ctx)
    const rows = await listProjectRows(ctx, orgId)
    return {
      defaultProjectId: `proj${orgId}`,
      currentProjectId: ctx.page.projectId,
      projects: rows
        .filter((p) => str(p.status) !== '0')
        .slice(0, 100)
        .map((p) => ({ projectId: str(p.id) ?? str(p.identifier), title: str(p.title), paused: str(p.status) === '2' || undefined })),
    }
  },
})

interface ListFlowsArgs {
  projectId?: string
  includeTrashed?: boolean
}

const listFlows = defineTool<ListFlowsArgs>({
  name: 'vs_list_flows',
  description:
    'List flows (workflows) with their status. Defaults to the open project; on other pages lists every flow in the workspace. Returned scriptIds can be passed to other vs_* tools.',
  parameters: params({
    projectId: S.str('Project id from vs_list_projects. Omit for the open project (or the whole workspace when none is open).', {
      pattern: PROJECT_ID_RE.source,
    }),
    includeTrashed: S.bool('Also list trashed flows (default false).'),
  }),
  danger: 'safe',
  pages,
  describe: () => 'Looking through your flows',
  async run(a, ctx) {
    const orgId = requireOrg(ctx)
    const projectId = a.projectId ?? ctx.page.projectId
    let rows: unknown[]
    if (projectId) {
      await verifyProject(ctx, orgId, projectId)
      const body = await call('Listing flows', () =>
        ctx.vs.request({ method: 'GET', path: `/projects/${projectId}/scripts`, query: { type: 'flow' }, signal: ctx.signal }),
      )
      rows = asArray(asRecord(body).data)
    } else {
      const body = await call('Listing flows', () => ctx.vs.request({ method: 'GET', path: `/orgs/${orgId}/flows`, signal: ctx.signal }))
      rows = asArray(asRecord(asRecord(body).data).flows)
    }
    const flows = rows
      .filter(isRecord)
      .filter((r) => a.includeTrashed || str(r.status) !== '0')
      .map((r) => {
        const id = str(r.id) ?? ''
        const pid = str(r.project_id) ?? projectId ?? ''
        if (/^[A-Za-z0-9]{12}$/.test(id) && PROJECT_ID_RE.test(pid)) rememberFlow(orgId, id, pid)
        const row = isRecord(r.json_script) ? normalizeFlow(r) : null
        return {
          scriptId: id,
          title: str(r.title),
          projectId: pid,
          status: flowStatusLabel(r.status),
          hasUnpublishedChanges: row ? hasDraftChanges(row) : undefined,
          everPublished: row ? everPublished(row) : undefined,
          updatedAt: str(r.updatedAt),
        }
      })
    return { projectId, count: flows.length, flows: flows.slice(0, 100) }
  },
})

const getFlowTool = defineTool<{ scriptId?: string }>({
  name: 'vs_get_flow',
  description:
    'Read a flow as a compact outline: trigger, ordered steps (slug, id, type, status, app/action, nesting inside if-branches), unsaved draft steps and publish state. Call it before editing so you use the real step slugs. Step code is not included; use vs_get_step for one step.',
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  danger: 'safe',
  pages,
  describe: () => 'Reading the flow',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    let fns: FunctionRow[] = []
    // Saved app steps keep their app/action names only in the functions table.
    const needNames = Object.values(row.json_script.blocks).some((b) => b.type === 'plugin' && !b.metaData)
    if (needNames) {
      try {
        fns = await listFunctionRows(ctx, t)
      } catch {
        // The names are a nicety; the outline is still correct without them.
      }
    }
    return summarizeFlow(row, t, fns, ctx.vs.env.vmBase)
  },
})

/** Values are shown whole (the result is bounded as a whole): they are echoed back on save, so a cut value would be saved cut. */
function inputValues(inputData: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(asRecord(inputData))) {
    if (k.startsWith('_') || k.includes('["_')) continue
    out[k] = v
  }
  return out
}

function pluginDetail(pd: PluginData): Record<string, unknown> {
  const auth = pd.selectedValues?.authData
  return {
    app: pd.serviceName,
    action: pd.actionName,
    actionId: pd.selectedCreate,
    serviceId: pd.serviceId,
    actionVersionId: pd.actionVersionId,
    authType: pd.authType,
    authIdLookup: pd.authIdLookup,
    connection: auth?.id ? { id: auth.id, type: auth.type, name: auth.connection_label } : null,
    values: inputValues(pd.selectedValues?.inputData),
    fields: fieldList(normalizeInputJson(pd.inputJson)),
  }
}

function stepDetail(slug: string, block: Block, fn: FunctionRow | null, js: JsonScript, ctx: ToolContext): Record<string, unknown> {
  const codeMax = Math.max(1000, Math.min(8000, Math.floor(ctx.maxResultChars / 2)))
  const out: Record<string, unknown> = {
    slug,
    id: block.identifier,
    type: block.type,
    status: block.status,
    change: block.draftStatus,
    parent: findParent(js, slug),
    description: block.description,
  }
  switch (block.type) {
    case 'function':
      out.code = fn?.code ? truncate(fn.code, codeMax) : '(not saved yet)'
      out.dynamicVariables = maskVariables(fn?.metadata?.drafted?.dynamicVariables)
      if (block.subfunctions) out.usesSubfunctions = true
      break
    case 'api': {
      const code = asRecord(parseMaybeJson(fn?.code))
      const post = asRecord(code.postData)
      const text = str(post.text) ?? ''
      out.request = fn?.code
        ? {
            url: str(code.url),
            method: str(code.method),
            headers: maskHeaders(code.headers),
            queryParams: maskHeaders(code.queryString),
            body: {
              mimeType: str(post.mimeType),
              text: truncate(text, codeMax),
              textShortened: text.length > codeMax || undefined,
              formFields: maskHeaders(post.params),
            },
          }
        : '(not saved yet)'
      out.dynamicVariables = maskVariables(fn?.metadata?.drafted?.dynamicVariables)
      break
    }
    case 'plugin': {
      const pd = pluginDataOf(block, fn)
      Object.assign(out, pd ? pluginDetail(pd) : { problem: 'No app definition found; delete and re-add this step.' })
      break
    }
    case 'variable':
      out.expression = block.data
      break
    case 'ifBlock':
      out.condition = block.isElseBlock ? '(else: runs when no other branch matches; managed by viaSocket)' : block.condition
      out.statement = block.statement
      out.steps = js.order[slug] ?? []
      break
    case 'ifGroup':
      out.branches = js.order[slug] ?? []
      break
    case 'comment':
      out.text = block.data
      break
    case 'break':
      out.data = block.data
      break
    case 'response':
      out.responseType = block.responseType
      out.data = block.data
      break
  }
  if (block.sampleData !== undefined && block.sampleData !== null) out.sampleOutput = trimData(block.sampleData, ctx.stripRunData)
  if (block.type === 'variable') out.reference = `context.vals.${slug}`
  else if (['function', 'api', 'plugin', 'ifBlock'].includes(block.type)) out.reference = `context.res.${slug}`
  return out
}

const getStep = defineTool<{ slugName: string; scriptId?: string }>({
  name: 'vs_get_step',
  description:
    'Read one step in full: saved code (function), request (API), dynamic variables, app/action, connection, field values and field definitions (app step), expression or condition, and a sample of its last output. Secret-looking header, query, form field and dynamic variable values are masked as "•••(set)", and a long API body is shortened (ending in "…"); either is kept as saved if you send it back unchanged. Use slugName "SET_TRIGGER" to read the trigger configuration.',
  parameters: params(
    {
      slugName: S.str('Step slug exactly as shown by vs_get_flow, or "SET_TRIGGER" for the trigger.', { pattern: SLUG_RE.source }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['slugName'],
  ),
  danger: 'safe',
  pages,
  describe: (a) => `Reading step ${label(a.slugName, '')}`.trim(),
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const js = row.json_script
    if (a.slugName === 'SET_TRIGGER' && !js.blocks.SET_TRIGGER) {
      const trigger = js.trigger
      const summary = summarizeTrigger(trigger, t.scriptId, ctx.vs.env.vmBase)
      if (!trigger || !summary) return { trigger: null, note: 'The flow has no trigger yet. Set one with vs_set_trigger.' }
      const isApp = !['webhook', 'email', 'cron'].includes(String(trigger.triggerType))
      return bounded({ trigger: summary, ...(isApp ? pluginDetail(trigger) : {}) }, ctx.maxResultChars)
    }
    const block = js.blocks[a.slugName]
    if (!block) {
      throw new ToolError(`No step "${a.slugName}". Existing steps: ${Object.keys(js.blocks).slice(0, 40).join(', ') || 'none'}.`)
    }
    const fn = block.identifier && ['function', 'api', 'plugin'].includes(block.type) ? await getFunctionRow(ctx, t, block.identifier) : null
    return bounded(stepDetail(a.slugName, block, fn, js, ctx), ctx.maxResultChars)
  },
})

const searchAppsTool = defineTool<{ query: string; limit?: number }>({
  name: 'vs_search_apps',
  description:
    'Search the viaSocket app catalog by app name (fuzzy), e.g. "slack" or "google sheets". Returns serviceId values for vs_list_app_actions. Search with the app name only, not the action.',
  parameters: params(
    {
      query: S.str('App name to search for.', { minLength: 1, maxLength: 80 }),
      limit: S.int('Maximum results (default 8).', { minimum: 1, maximum: 25 }),
    },
    ['query'],
  ),
  danger: 'safe',
  pages,
  describe: (a) => `Searching for ${label(a.query, 'apps')}`,
  async run(a, ctx) {
    const apps = await searchApps(ctx, a.query.trim(), a.limit ?? 8)
    return { query: a.query, apps, note: apps.length ? undefined : 'No app found. Try a shorter or different name.' }
  },
})

const listAppActions = defineTool<{ serviceId: string; kind?: 'action' | 'trigger' }>({
  name: 'vs_list_app_actions',
  description:
    'List the actions (kind "action", used as flow steps) or triggers (kind "trigger", used with vs_set_trigger kind "app") of one app. Returns actionId values for vs_get_action, vs_add_step and vs_set_trigger. Actions marked customAction cannot be configured by the assistant.',
  parameters: params(
    {
      serviceId: S.str('App id (serviceId) from vs_search_apps.', { pattern: ROW_ID_RE.source }),
      kind: S.enum(['action', 'trigger'], 'Steps ("action", default) or triggers ("trigger").'),
    },
    ['serviceId'],
  ),
  danger: 'safe',
  pages,
  describe: (a) => (a.kind === 'trigger' ? 'Looking at app triggers' : 'Looking at app actions'),
  async run(a, ctx) {
    const rows = await listActions(ctx, a.serviceId, a.kind ?? 'action')
    return {
      serviceId: a.serviceId,
      app: rows[0]?.pluginname,
      actions: rows.slice(0, 150).map((r) => ({
        actionId: r.rowid,
        name: r.name,
        description: r.description ? truncate(String(r.description), 120) : undefined,
        authType: r.authtype,
        customAction: r.type === 'custom_action' || undefined,
        isPaidAction: isPaidAction(r) || undefined,
      })),
    }
  },
})

const getAction = defineTool<{ actionId: string }>({
  name: 'vs_get_action',
  description:
    'Read the full definition of an app action or trigger: its input fields (key, label, type, required, static options, whether options are loaded dynamically, visibility rules), the connection it needs (authType, authIdLookup, serviceId for vs_list_connections), actionVersionId, whether it is a paid action, and the fields of its sample output. Call it before vs_add_step / vs_set_trigger so inputData uses the exact field keys.',
  parameters: params({ actionId: S.str('actionId from vs_list_app_actions.', { pattern: ROW_ID_RE.source }) }, ['actionId']),
  danger: 'safe',
  pages,
  describe: () => 'Reading the action details',
  async run(a, ctx) {
    return bounded(summarizeAction(await getActionRow(ctx, a.actionId)), ctx.maxResultChars)
  },
})

const listConnectionsTool = defineTool<{ serviceId: string; authIdLookup: string; scriptId?: string }>({
  name: 'vs_list_connections',
  description:
    "List the user's existing connections (signed-in accounts) for an app that are compatible with an action. Pass serviceId and authIdLookup from vs_get_action. Use a returned id as connectionId in vs_add_step / vs_update_step / vs_set_trigger. If none is valid, use vs_connect_app.",
  parameters: params(
    {
      serviceId: S.str('App id (serviceId) from vs_get_action.', { pattern: ROW_ID_RE.source }),
      authIdLookup: S.str('authIdLookup from vs_get_action (the auth version the action needs).', { pattern: ROW_ID_RE.source }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['serviceId', 'authIdLookup'],
  ),
  danger: 'safe',
  pages,
  describe: () => 'Checking your connections',
  async run(a, ctx) {
    const flow = optionalFlow(ctx, a.scriptId)
    const rows = await listConnections(ctx, a.serviceId, a.authIdLookup, flow)
    return { connections: rows.slice(0, 30).map(summarizeConnection), note: rows.length ? undefined : 'No connection yet. Use vs_connect_app.' }
  },
})

/** The flow, when there is one to scope a lookup to; lookups still work without it. */
export function optionalFlow(ctx: ToolContext, scriptId?: string) {
  try {
    return resolveFlow(ctx, scriptId)
  } catch (e) {
    if (scriptId) throw e
    return undefined
  }
}

const getRecentRunTool = defineTool<{ scriptId?: string }>({
  name: 'vs_get_recent_run',
  description:
    'Read the latest run of the flow: the trigger payload, each step output and variables, plus a list of real reference paths (e.g. context.req.body.email, context.res.Step.id) to use when mapping fields. When run data is protected, values show only their shape (e.g. "<email>", "<string:12>", "<number>").',
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  danger: 'safe',
  pages,
  describe: () => 'Looking at the latest run',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const run = await getRecentRun(ctx, t)
    if (!run) return { found: false, note: 'The flow has not run yet. Test it with vs_test_flow, or send data to its trigger.' }
    return bounded({ found: true, ...summarizeRun(run, ctx.stripRunData) }, ctx.maxResultChars)
  },
})

export const READ_TOOLS: Tool<any>[] = [
  listProjects,
  listFlows,
  getFlowTool,
  getStep,
  searchAppsTool,
  listAppActions,
  getAction,
  listConnectionsTool,
  getRecentRunTool,
]
