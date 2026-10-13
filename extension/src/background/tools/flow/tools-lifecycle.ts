// Flow lifecycle tools: create and rename flows, connect apps, test steps and flows, publish and discard.

import { newScriptId } from '../ids'
import { maybeRedactText } from '../redact'
import type { Tool } from '../types'
import { normalizeInputJson } from './catalog'
import { findField, kindFromStep, MAX_DELAY_MINUTES } from './builtins'
import { connectApp } from './connections'
import { call, ToolError } from './errors'
import {
  draftedSteps, everPublished, getFlow, getFunctionRow, hasDraftChanges, pluginDataOf, refreshEditorIfOpen, requireOrg, resolveFlow,
  summarizeTrigger, triggerFeatures, triggerKind, verifyProject,
} from './flow-api'
import { choiceKeys, cleanInputData, reachableFields } from './fields'
import { rememberFlow } from './known'
import { checkMappings, inputDataTexts, referencedTexts, type MapText } from './mapping'
import { consoleOf, contextTooLarge, dryRunErrorText, executeDryRun, type ParsedRun } from './runs'
import { buildCatalogue, cleanSample, getAtPath, holdStepSample, markDeclined, testContext, triggerStages, usable, variablesOf, type VarEntry } from './samples'
import { defineTool, params, S } from './schema'
import { saveStepSample } from './tools-steps'
import { optionalFlow, SCRIPT_ID_PARAM } from './tools-read'
import { publishReadiness } from './publish-check'
import type { Block, FunctionRow, PluginData, Trigger } from './types'
import { appPath } from './urls'
import { asRecord, bounded, FLOW_PAGES, isRecord, label, parseMaybeJson, PROJECT_ID_RE, ROW_ID_RE, SLUG_RE, str, trimData, truncate } from './util'

const pages = [...FLOW_PAGES]
const DATA_TYPES = new Set(['plugin', 'function', 'api', 'variable'])

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
    case 'plugin': {
      const kind = kindFromStep(block, pd)
      if (kind === 'flow_in_flow') {
        const key = findField(normalizeInputJson(pd?.inputJson), 'flow')
        const target = key ? str(asRecord(pd?.selectedValues?.inputData)[key]) : undefined
        return `${name} runs another flow${target ? ` (${target})` : ''} for real: every step of that flow runs and acts on real data (messages, records, ...).`
      }
      if (kind === 'delay') return `${name} computes how many minutes the Delay waits (the test does not pause).`
      if (kind === 'approval') return `${name} sends the real approval request to the approver now.`
      return `${name} runs the ${pd?.serviceName ?? 'app'} action${pd?.actionName ? ` "${pd.actionName}"` : ''} for real: messages get sent and records get created or changed in the connected app.`
    }
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

/** Values the saved step evaluates (field values, request parts, code), for checking them against the test data. */
function savedReferences(block: Block, fn: FunctionRow | null, pd: PluginData | null, inputData: Record<string, unknown>): MapText[] {
  switch (block.type) {
    case 'plugin': {
      const values: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(inputData)) {
        if (k.startsWith('_') || k.endsWith('-Type') || k.includes('["_') || k.endsWith('_extraValue') || k === 'hookUrl') continue
        values[k] = v
      }
      // Dropdown values were checked against their choices when saved; read them as text (${...} is still checked).
      return inputDataTexts(values, 'field', choiceKeys(normalizeInputJson(pd?.inputJson)))
    }
    case 'api': {
      const code = asRecord(parseMaybeJson(fn?.code))
      const post = asRecord(code.postData)
      const out: MapText[] = referencedTexts('url', str(code.url), 'template')
      for (const [list, name] of [
        [code.headers, 'header'],
        [code.queryString, 'query'],
        [post.params, 'form field'],
      ] as const) {
        for (const p of Array.isArray(list) ? list : []) out.push(...referencedTexts(`${name} ${str(asRecord(p).name) ?? ''}`.trim(), str(asRecord(p).value), 'template'))
      }
      if (str(post.mimeType) !== 'multipart/form-data' && str(post.mimeType) !== 'application/x-www-form-urlencoded') {
        out.push(...referencedTexts('body', str(post.text), 'code'))
      }
      return out
    }
    case 'function':
      return referencedTexts('code', fn?.code, 'code')
    case 'variable':
      return referencedTexts('expression', str(block.data), 'code')
    case 'ifBlock':
      return referencedTexts('condition', str(block.condition), 'code')
    default:
      return []
  }
}

interface TestStepArgs {
  slugName: string
  payload?: Record<string, unknown>
  useRecentRun?: boolean
  allowDocumentedSample?: boolean
  scriptId?: string
}

const testStep = defineTool<TestStepArgs>({
  name: 'vs_test_step',
  description:
    "Test-run one saved step and return success, the error, the output with its insert texts for later steps (variables), and console output. Test data is built like the editor's Test button: the trigger's real sample as context.req.body and earlier steps' real outputs under context.res / context.vals (from vs_test_trigger, earlier vs_test_step runs or a run of the same steps). If the step uses data that has no real value to send, the test is refused: test the trigger or that step first. App and API steps perform REAL actions (send, create, change); function steps run their code; variable and condition steps only evaluate. The user is always asked first. A successful app-step output is saved as the step's sample.",
  parameters: params(
    {
      slugName: S.str('Slug of the step to test.', { pattern: SLUG_RE.source }),
      payload: S.map(
        'Only when the trigger has no real sample and the user gave you a real example of its data: used as context.req.body. Never made up; refused when the trigger has a real sample.',
      ),
      useRecentRun: S.bool('Also use a run of the same trigger and steps as sample data when there is no tested sample (default true).'),
      allowDocumentedSample: S.bool("Only when the user declined testing an earlier step: use that step's documented example output as test data. Say so to the user."),
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
    const row = await getFlow(ctx, t)
    const js = row.json_script
    const slug = a.slugName
    const block = js.blocks[slug]
    if (!block) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
    if (block.status === 'DRAFTED') throw new ToolError(`"${slug}" is an unsaved draft; finish it with vs_update_step first.`)
    if (block.type === 'ifBlock' && block.isElseBlock) throw new ToolError('The else-branch has no condition of its own to test.')

    const fn = block.identifier && ['function', 'api', 'plugin'].includes(block.type) ? await getFunctionRow(ctx, t, block.identifier) : null
    const pd = block.type === 'plugin' ? pluginDataOf(block, fn) : null
    const allowDoc = a.allowDocumentedSample === true
    const useRun = a.useRecentRun !== false
    if (a.payload !== undefined) {
      // A payload stands in only for a trigger that has no real sample; it never replaces one.
      const real = (await buildCatalogue(ctx, t, row, { at: 'before', slug }, { useRun })).byId.get('trigger')
      if (usable(real, false)) {
        throw new ToolError('Not tested: the trigger has a real sample, so test without payload (the test uses that sample as context.req.body).')
      }
    }
    const cat = await buildCatalogue(ctx, t, row, { at: 'before', slug }, { useRun, payload: a.payload })
    // What the editor sends: values of hidden fields stripped.
    const inputData = pd ? cleanInputData(asRecord(pd.selectedValues?.inputData), normalizeInputJson(pd.inputJson)) : {}
    // Every reference the step uses must resolve in the data the test sends; otherwise a real app would get empty values.
    const check = checkMappings(savedReferences(block, fn, pd, inputData), cat, { allowDocumented: allowDoc, forTest: true })
    if (check.problems.length) {
      throw new ToolError(`Not tested: the step uses data that has no real value to test with. ${check.problems.join(' | ')}`)
    }
    const context = testContext(cat, allowDoc)
    if (contextTooLarge(context)) throw new ToolError('The sample data is too large to test with.')

    const dynamicVariables = fn?.metadata?.drafted?.dynamicVariables ?? {}
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
        const avid = str(pd?.actionVersionId) ?? ''
        if (!pd || !ROW_ID_RE.test(avid)) throw new ToolError('This app step has no valid action version; re-add it.')
        if (!pd.selectedValues?.authData?.id) throw new ToolError('This app step has no connection yet.')
        const ij = normalizeInputJson(pd.inputJson)
        body = {
          type: 'plugin',
          // No code.source: the backend loads the action's perform code only when source is absent.
          code: {
            selectedValues: { ...pd.selectedValues, inputData },
            inputFieldsBlocks: reachableFields(ij),
            inputFieldsSteps: ij.steps,
            actionVersionId: avid,
          },
          name: 'plugin',
          startDryRunApiStartThunk: true,
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
        const expr = str(block.type === 'variable' ? block.data : block.condition)
        if (!expr?.trim()) throw new ToolError('This step has no expression to test.')
        body = { type: 'function', code: block.type === 'variable' ? `return (${expr});` : `return Boolean(${expr});`, name: 'test', variables: { context }, isUserOnDh: false }
        break
      }
      default:
        throw new ToolError(`${block.type} steps cannot be tested on their own.`)
    }

    const from: Record<string, string> = {}
    for (const s of cat.sources) if (usable(s, allowDoc)) from[s.id] = s.viaPayload ? 'payload' : (s.origin ?? '')
    const dataLine = Object.keys(from).length
      ? `Test data: ${Object.entries(from)
          .slice(0, 6)
          .map(([k, v]) => `${k === 'trigger' ? 'trigger' : k} (${v === 'tested' ? 'tested sample' : v === 'run' ? 'latest run' : v === 'documented' ? 'documented example' : v === 'payload' ? 'example given by the user' : v})`)
          .join(', ')}.`
      : 'Test data: none (the step uses no earlier data).'
    const ok = await ctx.ui.confirm(`Test-run ${label(slug, 'the step', 40)}?`, `${testPreview(slug, block, fn, pd)}\n\n${dataLine}`, true, 'Run test')
    ctx.signal.throwIfAborted()
    if (!ok) {
      if (block.identifier && DATA_TYPES.has(block.type)) markDeclined(ctx, t, block.identifier)
      return {
        tested: false,
        declined: true,
        message: `The user declined the test run. Later steps can use "${slug}"'s documented example output only with allowDocumentedSample: true, and you must tell the user the mapping is not based on real data.`,
      }
    }

    await ctx.vs.alignOrg(ctx.signal)
    const res = await executeDryRun(ctx, t, body, `Testing step "${slug}"`)
    const message = res.message
    let success = res.success
    let output: unknown = message
    if (block.type === 'api') {
      const m = asRecord(message)
      const status = Number(m.status)
      success = res.data.success !== false && status > 0 && status < 400 && !asRecord(m.response).errorMessage
      output = m.response ?? message
    }
    const strip = ctx.stripRunData
    const viaPayload = a.payload !== undefined
    // The scheduler resumes a Delay only for a NUMBER of minutes from 0 to 43200; anything else never resumes.
    let delayCheck: string | undefined
    if (success && block.type === 'plugin' && kindFromStep(block, pd) === 'delay') {
      const ok = typeof output === 'number' && Number.isFinite(output) && output >= 0 && output <= MAX_DELAY_MINUTES
      delayCheck = ok
        ? `The Delay waits ${output} minute${output === 1 ? '' : 's'}.`
        : `The Delay returned ${typeof output === 'string' ? `the text "${truncate(output, 40)}"` : typeof output === 'number' ? `${output}, outside 0-${MAX_DELAY_MINUTES}` : `a ${output === null ? 'null' : typeof output}`}, not a number of minutes from 0 to ${MAX_DELAY_MINUTES}: a real run would pause and never resume. Change the wait (vs_update_step duration/unit) and test again, or ask the user to set it in the Delay panel.`
    }
    let savedAsSample = false
    let variables: VarEntry[] | undefined
    let sampleNote: string | undefined
    if (success && block.identifier && DATA_TYPES.has(block.type)) {
      const ref = block.type === 'variable' ? 'vals' : 'res'
      variables = variablesOf({ id: slug, ref, base: `context.${ref}.${slug}`, type: block.type, origin: 'tested', data: cleanSample(output) }, strip, 40)
      if (viaPayload) {
        sampleNote = 'Tested with an example payload, so this output is not kept as the step\'s sample. Test the trigger for real, then test this step again before mapping its output.'
      } else {
        holdStepSample(ctx, t, block.identifier, output)
        if (block.type === 'plugin') savedAsSample = await saveStepSample(ctx, t, block.identifier, output)
        else sampleNote = 'viaSocket stores samples only for app steps, so this output is kept for this session: later steps can map it now.'
      }
    }
    return bounded(
      {
        success,
        step: slug,
        error: success ? undefined : maybeRedactText(dryRunErrorText(message), strip, 500),
        output: trimData(output, strip),
        variables: variables?.length ? variables : undefined,
        console: maybeRedactText(consoleOf(res.console), strip, 2000),
        truncatedByViaSocket: res.data.dryRunResponseTruncated === true || undefined,
        testData: Object.keys(from).length ? from : undefined,
        savedAsSample,
        sampleNote,
        documentedSampleUsed: check.documentedUsed.length ? check.documentedUsed : undefined,
        delayCheck,
        next: success && variables?.length && !viaPayload ? 'Map later steps only with these insert texts (or vs_get_variables).' : undefined,
      },
      ctx.maxResultChars,
    )
  },
})

interface TestFlowArgs {
  payload?: Record<string, unknown>
  payloadFromUser?: boolean
  skipPauses?: boolean
  confirmItems?: number
  scriptId?: string
}

/** Steps that pause a run: Delay, Human Intervention and background (async) actions. */
function pausingSteps(blocks: Record<string, Block>): string[] {
  return Object.entries(blocks)
    .filter(([, b]) => {
      const bp = asRecord(b.breakPoint)
      return b.status !== 'DELETE' && (bp.isDelay === true || bp.isIntervention === true || bp.asyncPlugin === true)
    })
    .map(([k]) => k)
}

/** A looped test above this many items needs confirmItems: each item is a full run whose steps really act. */
const LOOP_TEST_LIMIT = 5
const LOOP_CAP = 1000
/** Query keys the VM reads itself (delay, continue routes) or that the test sets; never forwarded. */
const RESERVED_QUERY = new Set(['delay', 'viasocket_skip_delay', 'flowHitId', 'pausedStepId', 'action', 'operation', 'undefined'])

/** The sample request's query as test query parameters (simple values only; the VM rebuilds context.req.query from them). */
function forwardedQuery(q: unknown): { query: Record<string, string | number | boolean>; dropped: string[] } {
  const query: Record<string, string | number | boolean> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(asRecord(q))) {
    if (RESERVED_QUERY.has(k)) continue
    if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && Object.keys(query).length < 30) query[k] = v
    else dropped.push(k)
  }
  return { query, dropped }
}

const testFlow = defineTool<TestFlowArgs>({
  name: 'vs_test_flow',
  description:
    "Run the whole draft flow once and return each step's result and the final output. Without payload it uses the trigger's real sample (from vs_test_trigger), with its query, as the incoming request; Get Data, the loop and run-if then apply as in a real run. A payload is only for data the user gave you (payloadFromUser: true); one whose fields are not in the trigger's real sample is refused otherwise. Only saved steps run; unsaved drafts are skipped. Delay, approval and background pauses are skipped unless skipPauses is false. With run once per item on, the flow runs once per item: above 5 items it is refused until the user agrees and you pass confirmItems. Every app and API step performs REAL actions, so the user is asked first.",
  parameters: params({
    payload: S.map('Trigger data (becomes context.req.body), only as the user gave it. Leave it out to use the real trigger sample.'),
    payloadFromUser: S.bool('The payload is exactly what the user gave you (never set for data you wrote).'),
    skipPauses: S.bool('Skip Delay, Human Intervention and background-agent pauses (default true when the flow has them).'),
    confirmItems: S.int('Run once per item: the number of runs the user agreed to, exactly as the refusal stated it.', { minimum: 1, maximum: LOOP_CAP }),
    scriptId: SCRIPT_ID_PARAM,
  }),
  // Not 'confirm': run() asks after it knows which data the run uses.
  danger: 'write',
  confirmsInRun: true,
  pages,
  describe: () => 'Test-running the flow',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    // The test endpoint answers 200 "Flow Queued" for unknown ids, so confirm the flow exists first.
    const row = await getFlow(ctx, t)
    const js = row.json_script
    const kind = triggerKind(js.trigger)
    const trig = js.trigger
    const requestKinds = kind === 'webhook' || kind === 'cron'
    // With Get Data or a loop key the VM reshapes the request itself, so the test sends the request as it arrives.
    const shaped = requestKinds && (isRecord(trig?.preProcess) || isRecord(trig?.preProcessFilter) || asRecord(trig?.loops).loopsEnabled === true)
    let payload: unknown = a.payload
    let dataLine: string
    let sampleQuery: unknown
    let run: ParsedRun | null = null
    if (payload === undefined || a.payloadFromUser !== true) {
      const cat = await buildCatalogue(ctx, t, row, { at: 'end' }, { rawTrigger: shaped })
      run = cat.run
      const trigger = cat.byId.get('trigger')
      const real = usable(trigger, false) ? trigger?.data : undefined
      if (payload === undefined) {
        if (real !== undefined) {
          payload = real
          sampleQuery = trigger?.query
          dataLine = shaped ? "Test data: the trigger's real request (Get Data / the loop run on it as in a real run)." : "Test data: the trigger's real sample."
        } else if (!kind || kind === 'cron') {
          payload = {}
          dataLine = shaped ? 'Test data: none of its own; Get Data fetches it.' : 'Test data: none (the trigger carries no event data).'
        } else if (shaped && isRecord(trig?.preProcess) && !JSON.stringify(trig?.preProcess).includes('context.req')) {
          payload = {}
          dataLine = 'Test data: an empty request; Get Data fetches the data.'
        } else {
          throw new ToolError(
            "Not run: the trigger has no real sample yet. Test it first with vs_test_trigger (for webhooks and email, after the user sends one real request), or pass a payload the user gave you with payloadFromUser: true.",
          )
        }
      } else {
        const known = new Set(Object.keys(asRecord(real)))
        const unknown = Object.keys(asRecord(payload)).filter((k) => !known.has(k))
        if (real === undefined || unknown.length) {
          throw new ToolError(
            `Not run: ${real === undefined ? 'the trigger has no real sample to compare the payload with' : `the payload has fields that are not in the trigger's real sample (${unknown.slice(0, 8).join(', ')})`}. Leave payload out to use the real sample, or pass the user's own data with payloadFromUser: true.`,
          )
        }
        sampleQuery = trigger?.query
        dataLine = "Test data: a payload with the trigger sample's fields."
      }
    } else dataLine = 'Test data: the example the user gave.'
    const variables = JSON.stringify(payload ?? {})
    if (variables.length > 1_500_000) throw new ToolError('The payload is too large.')
    const warnings: string[] = []

    // The VM builds context.req.query from the test call itself: send the sample's query along.
    const fwd = kind === 'webhook' ? forwardedQuery(sampleQuery) : { query: {}, dropped: [] }
    if (Object.keys(fwd.query).length) dataLine += ` Request query: ${Object.keys(fwd.query).slice(0, 8).join(', ')}.`
    if (fwd.dropped.length) warnings.push(`Query values that are not plain text were not sent with the test: ${fwd.dropped.slice(0, 8).join(', ')}.`)
    const reads = JSON.stringify([trig?.preProcess ?? null, asRecord(trig?.preCondition).code ?? null, row.used_variables ?? null]).replace(/\?\./g, '.')
    if (kind === 'webhook' && /context\.req\.headers/.test(reads)) {
      warnings.push("The test cannot send the original request's headers, so anything reading context.req.headers sees the test call's headers instead.")
    }
    if (kind === 'webhook' && !Object.keys(fwd.query).length && /context\.req\.query/.test(reads)) {
      warnings.push('This test sends no request query, so Get Data, run-if or steps reading context.req.query see it empty.')
    }

    // Run once per item: every item is a full run whose steps really act.
    const loopsOn = requestKinds && asRecord(trig?.loops).loopsEnabled === true
    let loopRuns: number | undefined
    if (loopsOn) {
      const stages = triggerStages(ctx, t, row, run)
      const loopKey = stages.loopKey
      let body: unknown = stages.processed?.data
      if (!isRecord(trig?.preProcess) && a.payloadFromUser === true && a.payload !== undefined) body = a.payload
      const list = body === undefined ? undefined : loopKey ? getAtPath(body, loopKey) : body
      if (Array.isArray(list)) loopRuns = Math.min(list.length, LOOP_CAP)
      if (loopRuns !== undefined && loopRuns > LOOP_TEST_LIMIT && a.confirmItems !== loopRuns) {
        throw new ToolError(
          `Not run: run once per item is on, so this test would run the flow ${loopRuns} times (once per item${loopKey ? ` of "${loopKey}"` : ''}), about 3 seconds apart, and every app and API step acts each time (${loopRuns} messages, records, ...). Tell the user; only if they agree, call again with confirmItems: ${loopRuns}. Otherwise test single steps with vs_test_step.`,
        )
      }
      dataLine +=
        loopRuns === undefined
          ? ' Run once per item is on: the flow runs once for every item in the list (count unknown until it runs, at most 1000), and every step acts each time.'
          : ` Run once per item is on: this runs the flow ${loopRuns} time${loopRuns === 1 ? '' : 's'} (once per item, about 3 seconds apart), and every step acts each time.`
    }
    const pausing = pausingSteps(js.blocks)
    const skipPauses = a.skipPauses ?? pausing.length > 0
    if (pausing.length) dataLine += skipPauses ? ` Pauses are skipped (${pausing.join(', ')}).` : ` The run really pauses at ${pausing.join(', ')}.`
    const ok = await ctx.ui.confirm(
      loopRuns && loopRuns > 1 ? `Test-run the flow ${loopRuns} times?` : 'Test-run the whole flow?',
      `Every app and API step really runs: messages get sent and records get created or changed.\n\n${dataLine}`,
      true,
      'Run test',
    )
    ctx.signal.throwIfAborted()
    if (!ok) return { ran: false, declined: true, message: 'The user declined the test run.' }
    const query: Record<string, string | number | boolean> = { ...fwd.query }
    // The editor's "skip delay" switch; it also skips approval and background-action pauses.
    if (skipPauses) query.viasocket_skip_delay = true
    const res = await call(
      'Test-running the flow',
      () =>
        ctx.vs.request({
          method: 'POST',
          base: 'vm',
          path: `/func/${t.scriptId}/test`,
          query: Object.keys(query).length ? query : undefined,
          // The VM reads the dry-run payload only from body.variables.
          body: { code: '', variables, mimeType: 'application/json', methodType: 'POST', type: 'flow' },
          signal: ctx.signal,
        }),
      { redact: ctx.stripRunData },
    )
    const r = asRecord(asRecord(asRecord(res).data).response)
    const skipped = draftedSteps(js)
    if (!Object.keys(r).length) {
      const queued = loopsOn || kind === 'cron'
      return {
        ran: false,
        message: maybeRedactText(str(asRecord(res).message), ctx.stripRunData, 500) ?? 'viaSocket returned no result.',
        note: queued ? 'This flow\'s runs are queued (a schedule, or run once per item), so results are not returned here: read them with vs_get_recent_run in a moment.' : undefined,
        warnings: warnings.length ? warnings : undefined,
      }
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
        warnings: warnings.length ? warnings : undefined,
      },
      ctx.maxResultChars,
    )
  },
})

/** The trigger in plain words for the publish card: what starts the flow, and Get Data, loop and run-if. */
function triggerLine(trigger: Trigger | undefined, scriptId: string): string {
  const kind = triggerKind(trigger)
  if (!trigger || !kind) return 'It has no trigger.'
  const parts: string[] = []
  if (kind === 'webhook') parts.push('It starts whenever its webhook URL receives a request.')
  else if (kind === 'email') parts.push(`It starts on every email to ${scriptId}@sokt.io.`)
  else if (kind === 'cron') {
    parts.push(`It runs on a schedule: ${label(str(trigger.meaning), str(trigger.cronExpression) ?? 'unknown', 80)} (${str(trigger.cronExpression) ?? '?'}, ${str(trigger.timezone) ?? 'workspace timezone'}).`)
  } else parts.push(`It starts on every "${label(str(trigger.actionName)?.replace(/_/g, ' '), 'event', 60)}" event in ${label(str(trigger.serviceName), 'the app', 40)}.`)
  const f = triggerFeatures(trigger) ?? {}
  const gd = asRecord(f.getData)
  if (Object.keys(gd).length) parts.push(`Get Data first runs ${gd.source === 'app' ? `the ${label(str(gd.app), 'app', 40)} action "${label(str(gd.action)?.replace(/_/g, ' '), '?', 60)}"` : gd.source === 'api' ? `an API call (${label(str(gd.url), '?', 80)})` : 'JS code'} on every run.`)
  const loop = asRecord(f.loop)
  if (loop.enabled === true) parts.push(`It runs once per item${str(loop.arrayKey) && loop.arrayKey !== '(root)' ? ` of "${label(str(loop.arrayKey), '', 60)}"` : ''} (up to 1000 per event).`)
  const runIf = asRecord(f.runIf)
  if (runIf.enabled === true) parts.push(`It only continues if: ${label(str(runIf.statement) ?? str(runIf.condition), 'the run condition', 100)}.`)
  return parts.join(' ')
}

const publishFlow = defineTool<{ scriptId?: string }>({
  name: 'vs_publish_flow',
  description:
    "Publish the draft so it goes live: the trigger starts listening (webhooks subscribe, schedules start) and real runs begin. First runs the editor's publish check and refuses with the reasons to fix: unsaved steps or trigger, missing or expired trigger / Get Data connection, an empty or broken run-if, empty custom response, missing dependencies, paused steps used elsewhere, broken branch conditions or a misplaced break. Then asks the user, showing what starts the flow and any warnings. Only publish when the user has asked for it.",
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  danger: 'confirm',
  // run() asks itself, after the publish check, so the card names the trigger and the check's warnings.
  confirmsInRun: true,
  pages,
  describe: () => 'Publishing the flow',
  confirmText: () => 'Publish this flow? It goes live right away: its trigger starts running the flow on real events, and app steps act on real data.',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    await ctx.vs.alignOrg(ctx.signal)
    const row = await getFlow(ctx, t)
    if (row.status === '2') throw new ToolError('The flow is paused. The user must resume it in viaSocket before publishing.')
    if (row.status === '0') throw new ToolError('The flow is in the trash and cannot be published.')
    // viaSocket refuses these with an error (and raises an internal alert), so check them up front.
    if (row.projects_status !== undefined && row.projects_status !== null && String(row.projects_status) !== '1') {
      throw new ToolError("This flow's project is paused or deleted. The user must resume the project in viaSocket before publishing.")
    }
    const readiness = await publishReadiness(ctx, row, t)
    if (readiness.blocking.length) {
      return {
        published: false,
        reasons: readiness.blocking,
        warnings: readiness.warnings.length ? readiness.warnings : undefined,
        next: 'Fix these one at a time (asking the user where needed), then publish again.',
      }
    }
    if (!hasDraftChanges(row) && everPublished(row)) return { published: false, message: 'There are no unpublished changes.' }
    const ok = await ctx.ui.confirm(
      'Publish this flow?',
      [
        'It goes live right away: its trigger starts running the flow on real events, and app steps act on real data.',
        triggerLine(row.json_script.trigger, t.scriptId),
        readiness.warnings.length ? `Before you publish: ${readiness.warnings.join(' ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      true,
      'Publish',
    )
    ctx.signal.throwIfAborted()
    if (!ok) return { published: false, declined: true, message: 'The user did not publish.' }

    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const now = await getFlow(ctx, t)
      // Changed while the user was deciding: check again what is being published.
      if (JSON.stringify(now.json_script) !== JSON.stringify(row.json_script)) {
        const again = await publishReadiness(ctx, now, t)
        if (again.blocking.length) {
          return { published: false, reasons: again.blocking, next: 'The flow changed meanwhile. Fix these, then publish again.' }
        }
      }
      const res = await call('Publishing the flow', () =>
        ctx.vs.request({ method: 'PUT', path: `/projects/${t.projectId}/scripts/${t.scriptId}/publish`, body: {}, live: true, signal: ctx.signal }),
      )
      refreshEditorIfOpen(ctx, t.scriptId)
      const data = asRecord(asRecord(res).data)
      return {
        published: true,
        liveVersion: str(asRecord(data.published_json_script).version),
        trigger: summarizeTrigger(now.json_script.trigger, t.scriptId, ctx.vs.env.vmBase) ?? undefined,
        warnings: readiness.warnings.length ? readiness.warnings : undefined,
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
