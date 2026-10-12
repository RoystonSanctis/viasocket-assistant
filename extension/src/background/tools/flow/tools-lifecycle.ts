// Flow lifecycle tools: create and rename flows, connect apps, test steps and flows, publish and discard.

import { newScriptId } from '../ids'
import { maybeRedactText } from '../redact'
import type { Tool, ToolContext } from '../types'
import { VsError } from '../viasocket-client'
import { normalizeInputJson } from './catalog'
import { connectApp } from './connections'
import { call, ToolError } from './errors'
import {
  draftedSteps, everPublished, getFlow, getFunctionRow, hasDraftChanges, pluginDataOf, refreshEditorIfOpen, requireOrg, resolveFlow,
  summarizeTrigger, triggerKind, verifyProject,
} from './flow-api'
import { rememberFlow } from './known'
import { buildTestContext, contextTooLarge, getRecentRun, type ParsedRun } from './runs'
import { defineTool, params, S } from './schema'
import { optionalFlow, SCRIPT_ID_PARAM } from './tools-read'
import type { Block, FunctionRow, InputJson, PluginData } from './types'
import { appPath } from './urls'
import {
  asRecord, AUTH_ID_RE, bounded, FLOW_PAGES, isRecord, label, leafPaths, parseMaybeJson, PROJECT_ID_RE, ROW_ID_RE, SLUG_RE, str, trimData,
  truncate,
} from './util'

const pages = [...FLOW_PAGES]

interface CreateFlowArgs {
  title: string
  description?: string
  projectId?: string
  lowercaseId?: boolean
}

const createFlow = defineTool<CreateFlowArgs>({
  name: 'vs_create_flow',
  description:
    'Create a new, empty flow and open it in the editor. Set lowercaseId to true when the flow will use an email trigger. The editor switches to the new flow; pass the returned scriptId to the next tools (vs_set_trigger, vs_add_step) until the page has caught up.',
  parameters: params(
    {
      title: S.str('Flow name, e.g. "New lead to Slack".', { minLength: 1, maxLength: 75 }),
      description: S.str('What the flow does, in one sentence.', { maxLength: 500 }),
      projectId: S.str('Project from vs_list_projects. Default: the open project, else the default project.', { pattern: PROJECT_ID_RE.source }),
      lowercaseId: S.bool('Use an all-lowercase flow id (required for email triggers).'),
    },
    ['title'],
  ),
  danger: 'write',
  pages,
  describe: (a) => `Creating flow ${label(a.title, '')}`.trim(),
  async run(a, ctx) {
    const orgId = requireOrg(ctx)
    const title = a.title.trim()
    if (!title) throw new ToolError('title cannot be empty.')
    const projectId = a.projectId ?? ctx.page.projectId ?? `proj${orgId}`
    await verifyProject(ctx, orgId, projectId)
    // The create route uses the token's org without checking it, so realign even if it was aligned recently.
    await ctx.vs.alignOrg(ctx.signal, { force: true })
    const scriptId = newScriptId(a.lowercaseId === true)
    const body: Record<string, unknown> = { identifier: scriptId, title }
    if (a.description?.trim()) body.description = a.description.trim()
    // No triggerDetails: the cron variant always goes through an AI path, and triggers are set separately.
    const res = await ctx.vs.mutate(scriptId, () =>
      call('Creating the flow', () =>
        ctx.vs.request({ method: 'POST', path: `/projects/${projectId}/scripts`, body, live: true, signal: ctx.signal }),
      ),
    )
    const id = str(asRecord(asRecord(res).data).id)
    const finalId = id && /^[A-Za-z0-9]{12}$/.test(id) ? id : scriptId
    rememberFlow(orgId, finalId, projectId)
    ctx.ui.navigate(appPath({ to: 'flow', orgId, projectId, scriptId: finalId }))
    return {
      created: true,
      scriptId: finalId,
      projectId,
      title,
      emailTriggerReady: a.lowercaseId === true,
      next: `The flow is empty and now open. Set its trigger with vs_set_trigger and add steps with vs_add_step, passing scriptId "${finalId}".`,
    }
  },
})

const renameFlow = defineTool<{ title: string; description?: string; scriptId?: string }>({
  name: 'vs_rename_flow',
  description: 'Rename a flow and optionally change its description. A description cannot be cleared, only replaced.',
  parameters: params(
    {
      title: S.str('New flow name.', { minLength: 1, maxLength: 75 }),
      description: S.str('New description (non-empty).', { minLength: 1, maxLength: 500 }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['title'],
  ),
  danger: 'write',
  pages,
  describe: (a) => `Renaming the flow to ${label(a.title, 'something new')}`,
  async run(a, ctx) {
    const title = a.title.trim()
    if (!title) throw new ToolError('title cannot be empty.')
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      // This route creates an empty flow for an unknown id, so make sure it exists first.
      await getFlow(ctx, t)
      const body: Record<string, unknown> = { title }
      if (a.description?.trim()) body.description = a.description.trim()
      await call('Renaming the flow', () =>
        ctx.vs.request({ method: 'PUT', path: `/projects/${t.projectId}/scripts/${t.scriptId}`, body, live: true, signal: ctx.signal }),
      )
      refreshEditorIfOpen(ctx, t.scriptId)
      return { renamed: true, title }
    })
  },
})

interface ConnectAppArgs {
  serviceId: string
  authIdLookup: string
  actionVersionId?: string
  scriptId?: string
}

const connectAppTool = defineTool<ConnectAppArgs>({
  name: 'vs_connect_app',
  description:
    "Create a new connection (sign in to an app) for the user. Opens viaSocket's own sign-in popup where the user enters credentials or approves access, then waits up to 3 minutes for the new connection and returns its id for connectionId. Use only when vs_list_connections has no valid connection. Tell the user to finish in the popup.",
  parameters: params(
    {
      serviceId: S.str('App id (serviceId) from vs_get_action.', { pattern: ROW_ID_RE.source }),
      authIdLookup: S.str('authIdLookup from vs_get_action.', { pattern: ROW_ID_RE.source }),
      actionVersionId: S.str('actionVersionId from vs_get_action, so the right permissions are requested.', { pattern: ROW_ID_RE.source }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['serviceId', 'authIdLookup'],
  ),
  danger: 'write',
  pages,
  describe: () => 'Opening the sign-in popup',
  async run(a, ctx) {
    return connectApp(ctx, a, optionalFlow(ctx, a.scriptId))
  },
})

/** Field definitions reachable from the root, which is what the dry run expects as inputFieldsBlocks. */
function reachableFields(ij: InputJson): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const walk = (loc: string, depth: number) => {
    for (const k of ij.steps[loc] ?? []) {
      if (k in out) continue
      const b = ij.blocks[k]
      if (b) out[k] = b
      if (ij.steps[k] && depth < 5) walk(k, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

/** Console output arrives as a string or as captured log arguments. */
function consoleOf(raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  return text && text !== '""' ? text : undefined
}

function hostsIn(text: string): string[] {
  const hosts = new Set<string>()
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s'"`<>()[\]{}]+/gi)) {
    try {
      hosts.add(new URL(m[0]).host)
    } catch {
      // Not a parseable URL (e.g. a ${...} template); skip it.
    }
    if (hosts.size >= 8) break
  }
  return [...hosts]
}

/** What the confirmation card says will run, built from the saved step (never from model-written text alone). */
function testPreview(slug: string, block: Block, fn: FunctionRow | null, pd: PluginData | null): string {
  const name = `"${label(slug, '?', 60)}"`
  switch (block.type) {
    case 'function': {
      const code = fn?.code ?? ''
      const hosts = hostsIn(code)
      return [
        `The code of ${name} runs now. It can call external services${fn?.auth_id ? " using the step's connection" : ''} and act on real data${hosts.length ? `. Addresses in the code: ${hosts.join(', ')}` : ''}.`,
        truncate(code, 400),
      ].join('\n\n')
    }
    case 'api': {
      const code = asRecord(parseMaybeJson(fn?.code))
      return `${name} sends its real request now: ${str(code.method) ?? 'GET'} ${truncate(str(code.url) ?? '', 200)}. Whatever that request does (send, create, change or delete something) really happens.`
    }
    case 'plugin':
      return `${name} runs the ${pd?.serviceName ?? 'app'} action${pd?.actionName ? ` "${pd.actionName}"` : ''} for real: messages get sent and records get created or changed in the connected app.`
    default: {
      const expr = str(block.type === 'variable' ? block.data : block.condition) ?? ''
      const hosts = hostsIn(expr)
      return [
        `Evaluates the ${block.type === 'variable' ? 'expression' : 'condition'} of ${name} with sample data${hosts.length ? `. Addresses in it: ${hosts.join(', ')}` : ''}.`,
        truncate(expr, 400),
      ].join('\n\n')
    }
  }
}

function errorText(message: unknown): string | undefined {
  if (typeof message === 'string') return truncate(message, 500)
  const m = asRecord(message)
  const nested = asRecord(m.error)
  const text = str(m.errorMessage) ?? str(nested.message) ?? (Number(m.status) >= 400 ? str(m.message) : undefined) ?? str(m.message)
  return text ? truncate(text, 500) : undefined
}

interface TestStepArgs {
  slugName: string
  payload?: Record<string, unknown>
  useRecentRun?: boolean
  scriptId?: string
}

const testStep = defineTool<TestStepArgs>({
  name: 'vs_test_step',
  description:
    'Test-run one saved step with sample data and return success, the error message, the output (with its reference paths) and console output. Input data: payload (as the trigger body, context.req.body) or, by default, the latest run, which also supplies earlier step outputs. App and API steps perform REAL actions (send the message, create the record, charge the card). Function steps run their code, which can call external APIs (axios, fetch) with the step\'s connection. Variable and condition steps only evaluate their expression. The user is always asked first, with a preview of what will run. Save the step first: unsaved drafts cannot be tested.',
  parameters: params(
    {
      slugName: S.str('Slug of the step to test.', { pattern: SLUG_RE.source }),
      payload: S.map('Sample trigger payload used as context.req.body. Omit to use the latest run.'),
      useRecentRun: S.bool('Use the latest run for the trigger payload and earlier step outputs (default true).'),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['slugName'],
  ),
  // Not 'confirm': run() asks the user itself, after loading the step, so the card can say what really runs.
  danger: 'write',
  confirmsInRun: true,
  pages,
  describe: (a) => `Testing ${label(a.slugName, 'the step')}`,
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const js = (await getFlow(ctx, t)).json_script
    const slug = a.slugName
    const block = js.blocks[slug]
    if (!block) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
    if (block.status === 'DRAFTED') throw new ToolError(`"${slug}" is an unsaved draft; save it with vs_update_step first.`)

    let run: ParsedRun | null = null
    if (a.useRecentRun !== false) {
      try {
        run = await getRecentRun(ctx, t)
      } catch {
        // No sample data is fine; the step runs with an empty context.
      }
    }
    const context = buildTestContext(run, a.payload)
    if (contextTooLarge(context)) throw new ToolError('The sample data is too large to test with; pass a smaller payload.')

    const fn = block.identifier && ['function', 'api', 'plugin'].includes(block.type) ? await getFunctionRow(ctx, t, block.identifier) : null
    const dynamicVariables = fn?.metadata?.drafted?.dynamicVariables ?? {}
    let pd: PluginData | null = null
    let body: Record<string, unknown>
    switch (block.type) {
      case 'function':
        if (!fn?.code) throw new ToolError('This function step has no saved code.')
        body = { type: 'function', code: fn.code, name: 'test', variables: { context, authId: fn.auth_id ?? undefined }, dynamicVariables, isUserOnDh: false }
        if (Array.isArray(block.subfunctions) && block.subfunctions.length) body.subfunctions = block.subfunctions
        break
      case 'api': {
        const code = parseMaybeJson(fn?.code)
        if (!isRecord(code)) throw new ToolError('This API step has no saved request.')
        body = { type: 'api', code, name: 'test', variables: { context, authId: fn?.auth_id ?? undefined }, dynamicVariables }
        break
      }
      case 'plugin': {
        pd = pluginDataOf(block, fn)
        const avid = str(pd?.actionVersionId) ?? ''
        if (!pd || !/^row[A-Za-z0-9]{1,13}$/.test(avid)) throw new ToolError('This app step has no valid action version; re-add it.')
        if (!pd.selectedValues?.authData?.id) throw new ToolError('This app step has no connection yet.')
        const ij = normalizeInputJson(pd.inputJson)
        body = {
          type: 'plugin',
          // No code.source: the backend loads the action's perform code only when source is absent.
          code: { selectedValues: pd.selectedValues, inputFieldsBlocks: reachableFields(ij), inputFieldsSteps: ij.steps, actionVersionId: avid },
          name: 'plugin',
          stepId: block.identifier,
          variables: { context },
          performType: 'perform',
          pluginType: 'action',
          isUserOnDh: false,
        }
        break
      }
      case 'variable':
      case 'ifBlock': {
        if (block.isElseBlock) throw new ToolError('The else-branch has no condition of its own to test.')
        const expr = str(block.type === 'variable' ? block.data : block.condition)
        if (!expr?.trim()) throw new ToolError('This step has no expression to test.')
        body = { type: 'function', code: block.type === 'variable' ? `return (${expr});` : `return Boolean(${expr});`, name: 'test', variables: { context }, isUserOnDh: false }
        break
      }
      default:
        throw new ToolError(`${block.type} steps cannot be tested on their own.`)
    }

    const ok = await ctx.ui.confirm(`Test-run ${label(slug, 'the step', 40)}?`, testPreview(slug, block, fn, pd), true, 'Run test')
    ctx.signal.throwIfAborted()
    if (!ok) return { tested: false, declined: true, message: 'The user declined the test run.' }

    const orgId = t.orgId
    await ctx.vs.alignOrg(ctx.signal)
    const res = await call(
      `Testing step "${slug}"`,
      () => ctx.vs.request({ method: 'POST', path: `/${orgId}/${t.scriptId}/execute`, body, signal: ctx.signal }),
      { redact: ctx.stripRunData },
    )
    const data = asRecord(asRecord(res).data)
    const message = data.message
    let success = data.success === true
    let output: unknown = message
    if (block.type === 'api') {
      const m = asRecord(message)
      const status = Number(m.status)
      success = data.success !== false && status > 0 && status < 400 && !asRecord(m.response).errorMessage
      output = m.response ?? message
    }
    const ref = block.type === 'variable' ? `context.vals.${slug}` : `context.res.${slug}`
    const strip = ctx.stripRunData
    return bounded(
      {
        success,
        step: slug,
        error: success ? undefined : maybeRedactText(errorText(message), strip, 500),
        output: trimData(output, strip),
        outputPaths: isRecord(output) || Array.isArray(output) ? leafPaths(output, ref, 60, strip) : undefined,
        console: maybeRedactText(consoleOf(data.console), strip, 2000),
        truncatedByViaSocket: data.dryRunResponseTruncated === true || undefined,
        sampleDataFrom: a.payload ? 'payload' : run ? 'latest run' : 'empty context',
      },
      ctx.maxResultChars,
    )
  },
})

const testFlow = defineTool<{ payload?: Record<string, unknown>; scriptId?: string }>({
  name: 'vs_test_flow',
  description:
    "Run the whole draft flow once with a sample trigger payload (context.req.body) and return each step's result and the final output. Only saved steps run; unsaved drafts are skipped. Every app and API step performs REAL actions, so the user is asked first.",
  parameters: params({ payload: S.map('Sample trigger payload (becomes context.req.body).'), scriptId: SCRIPT_ID_PARAM }),
  danger: 'confirm',
  pages,
  describe: () => 'Test-running the flow',
  confirmText: () => 'Run the whole draft flow once with sample data? Every app and API step really runs: messages get sent and records get created or changed.',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    // The test endpoint answers 200 "Flow Queued" for unknown ids, so confirm the flow exists first.
    const js = (await getFlow(ctx, t)).json_script
    const variables = JSON.stringify(a.payload ?? {})
    if (variables.length > 1_500_000) throw new ToolError('The payload is too large.')
    const res = await call(
      'Test-running the flow',
      () =>
        ctx.vs.request({
          method: 'POST',
          base: 'vm',
          path: `/func/${t.scriptId}/test`,
          // The VM reads the dry-run payload only from body.variables.
          body: { code: '', variables, mimeType: 'application/json', methodType: 'POST', type: 'flow' },
          signal: ctx.signal,
        }),
      { redact: ctx.stripRunData },
    )
    const r = asRecord(asRecord(asRecord(res).data).response)
    const skipped = draftedSteps(js)
    if (!Object.keys(r).length) {
      return { ran: false, message: maybeRedactText(str(asRecord(res).message), ctx.stripRunData, 500) ?? 'viaSocket returned no result.' }
    }
    return bounded(
      {
        ran: true,
        success: r.success !== false,
        output: trimData(r.output, ctx.stripRunData),
        steps: trimData(asRecord(r.stepResponseSnapshot), ctx.stripRunData),
        variables: trimData(asRecord(r.valsResponseSnapshot), ctx.stripRunData),
        console: maybeRedactText(consoleOf(r.console), ctx.stripRunData, 2000),
        skippedUnsavedSteps: skipped.length ? skipped : undefined,
      },
      ctx.maxResultChars,
    )
  },
})

/** false when viaSocket reports the connection expired or unknown; undefined when the check itself failed. */
async function connectionValid(ctx: ToolContext, authId: string): Promise<boolean | undefined> {
  try {
    const body = await ctx.vs.request({ method: 'GET', path: `/authtoken/authvalid/${encodeURIComponent(authId)}`, signal: ctx.signal })
    return asRecord(asRecord(body).data).valid === true
  } catch (e) {
    if (e instanceof VsError && e.kind === 'aborted') throw e
    return undefined
  }
}

const publishFlow = defineTool<{ scriptId?: string }>({
  name: 'vs_publish_flow',
  description:
    'Publish the draft so it goes live: the trigger starts listening (webhooks subscribe, schedules start) and real runs begin. Refuses (and lists why) while steps are unsaved drafts or an app trigger is not saved. Only publish when the user has asked for it.',
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  danger: 'confirm',
  pages,
  describe: () => 'Publishing the flow',
  confirmText: () => 'Publish this flow? It goes live right away: its trigger starts running the flow on real events, and app steps act on real data.',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      const js = row.json_script
      if (row.status === '2') throw new ToolError('The flow is paused. The user must resume it in viaSocket before publishing.')
      if (row.status === '0') throw new ToolError('The flow is in the trash and cannot be published.')
      // viaSocket refuses these with an error (and raises an internal alert), so check them up front.
      if (row.projects_status !== undefined && row.projects_status !== null && String(row.projects_status) !== '1') {
        throw new ToolError("This flow's project is paused or deleted. The user must resume the project in viaSocket before publishing.")
      }
      const reasons: string[] = []
      if (js.trigger?.isDrafted) reasons.push('The app trigger was picked but never saved; finish it with vs_set_trigger.')
      const kind = triggerKind(js.trigger)
      const triggerAuth = str(js.trigger?.selectedValues?.authData?.id)
      if (kind && !['webhook', 'email', 'cron'].includes(kind) && triggerAuth && triggerAuth !== 'NoAuth' && AUTH_ID_RE.test(triggerAuth)) {
        if ((await connectionValid(ctx, triggerAuth)) === false) {
          reasons.push("The app trigger's connection has expired. Reconnect with vs_connect_app, then pass the new connectionId to vs_set_trigger.")
        }
      }
      const drafts = draftedSteps(js)
      if (drafts.length) reasons.push(`These steps are unsaved drafts and would be dropped: ${drafts.join(', ')}. Save them with vs_update_step or delete them.`)
      if (reasons.length) return { published: false, reasons }
      if (!hasDraftChanges(row) && everPublished(row)) return { published: false, message: 'There are no unpublished changes.' }

      const res = await call('Publishing the flow', () =>
        ctx.vs.request({ method: 'PUT', path: `/projects/${t.projectId}/scripts/${t.scriptId}/publish`, body: {}, live: true, signal: ctx.signal }),
      )
      refreshEditorIfOpen(ctx, t.scriptId)
      const data = asRecord(asRecord(res).data)
      return {
        published: true,
        liveVersion: str(asRecord(data.published_json_script).version),
        trigger: summarizeTrigger(js.trigger, t.scriptId, ctx.vs.env.vmBase) ?? undefined,
        warning: triggerKind(js.trigger) ? undefined : 'The flow has no trigger, so nothing starts it automatically.',
      }
    })
  },
})

const discardChanges = defineTool<{ scriptId?: string }>({
  name: 'vs_discard_changes',
  description:
    'Throw away every unpublished change so the draft matches the live flow again. On a flow that was never published this empties it (all steps and the trigger are removed).',
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  danger: 'confirm',
  pages,
  describe: () => 'Discarding unpublished changes',
  confirmText: () =>
    'Discard all unpublished changes to this flow? The draft goes back to the live version. If the flow was never published, all of its steps and its trigger are removed.',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const row = await getFlow(ctx, t)
      if (!hasDraftChanges(row)) return { discarded: false, message: 'There are no unpublished changes to discard.' }
      await call('Discarding changes', () =>
        ctx.vs.request({ method: 'PUT', path: `/projects/${t.projectId}/scripts/${t.scriptId}/revert`, body: {}, live: true, signal: ctx.signal }),
      )
      refreshEditorIfOpen(ctx, t.scriptId, { stepId: null, slugName: null })
      return {
        discarded: true,
        note: everPublished(row) ? 'The draft now matches the live flow.' : 'The flow was never published, so it is empty again.',
      }
    })
  },
})

export const LIFECYCLE_TOOLS: Tool<any>[] = [createFlow, renameFlow, connectAppTool, testStep, testFlow, publishFlow, discardChanges]
