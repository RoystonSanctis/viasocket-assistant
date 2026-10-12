// Step tools: add, update, delete and move steps of a flow's draft.
//
// Every write goes through ctx.vs.mutate(scriptId) (the backend rewrites the whole flow per request), re-reads the
// flow inside the queue, aligns the token org first and sends live:true so the open editor applies the change.

import { isValidStepSlug, toStepSlug } from '../ids'
import type { Tool, ToolContext } from '../types'
import { VsError } from '../viasocket-client'
import { getActionRow, normalizeInputJson, type ActionRow } from './catalog'
import { resolveConnection } from './connections'
import { call, ToolError } from './errors'
import {
  descendants, editorParam, findParent, getFlow, getFunctionRow, normalizeFlow, orphanBlocks, pluginDataOf, refreshEditorIfOpen,
  resolveFlow, slugForStepId,
} from './flow-api'
import { encodeInputData } from './input-data'
import { checkCommentText, checkExpression, checkFunctionCode, checkTemplateText } from './js-check'
import { defineTool, params, S } from './schema'
import {
  apiBody, breakBody, buildApiCode, commentBody, functionBody, ifBlockBody, pluginBody, putStep, responseBody, variableBody,
  type ApiSpec, type Pair, type SaveCommon,
} from './step-bodies'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, Block, FlowTarget, JsonScript } from './types'
import { pagePathWithParams } from './urls'
import { asRecord, AUTH_ID_RE, FLOW_PAGES, label, MASK, parseMaybeJson, prefixedStepId, ROW_ID_RE, SLUG_RE, str, truncate } from './util'

const pages = [...FLOW_PAGES]

type AddType = 'plugin' | 'function' | 'api' | 'variable' | 'condition' | 'branch' | 'comment' | 'break'

interface StepFields {
  description?: string
  connectionId?: string
  inputData?: Record<string, unknown>
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
}

const REFS = 'References: trigger payload context.req.body.<field>, earlier step output context.res.<StepSlug>.<field>, variable context.vals.<slug>.'

const STEP_FIELDS = {
  description: S.str('Short description shown on the step.', { maxLength: 300 }),
  connectionId: S.str('App steps: connection id from vs_list_connections or vs_connect_app.', { pattern: AUTH_ID_RE.source }),
  inputData: S.map(
    'App steps: field values keyed by the exact field keys from vs_get_action. Text values are template strings: insert data as ${context.req.body.email}, ${context.res.<StepSlug>.id} or ${context.vals.<slug>} (never bare paths, never backticks). Lists are arrays, booleans true/false, dropdowns the option value. null clears a field.',
  ),
  code: S.str(
    `Function steps: JavaScript body of an async function. Read data with bare paths (no \${}), may use await, axios and fetch, and MUST return the step output. ${REFS}`,
    { maxLength: 100000 },
  ),
  // No value schema, so null can remove a name; values are checked in checkFields.
  dynamicVariables: S.map(
    `Function/API steps: named constants available inside the code, e.g. {"apiKey":"abc"}; values are strings. On update they are merged into the saved ones: null removes a name, and a masked "${MASK}" value keeps the saved one.`,
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
}

function isAbort(e: unknown): boolean {
  return (e instanceof VsError && e.kind === 'aborted') || (e instanceof DOMException && e.name === 'AbortError')
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
  for (const [k, v] of Object.entries(f.dynamicVariables ?? {})) {
    if (v === null) continue
    if (typeof v !== 'string') problems.push(`dynamicVariables.${k} must be a string (or null to remove it).`)
    else if (v.length > 2000) problems.push(`dynamicVariables.${k} is longer than 2000 characters.`)
    else if (v.includes('`')) problems.push(`dynamicVariables.${k}: backticks are not allowed.`)
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
  parent?: string
  afterSlug?: string
  atStart?: boolean
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
      need(!!a.actionId, 'actionId is required for app steps (from vs_list_app_actions).')
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
  if (a.title && !['plugin', 'function', 'api', 'variable'].includes(a.type)) warnings.push(`title is ignored for ${a.type} steps.`)
  if (problems.length) fail(problems)
  return warnings
}

const addStep = defineTool<AddStepArgs>({
  name: 'vs_add_step',
  description: [
    'Add a step to the flow and save it, so it is ready to run (unsaved steps are skipped at run time and dropped on publish).',
    'Types: "plugin" = app action (needs actionId from vs_list_app_actions; call vs_get_action first for field keys; pass connectionId unless the action is NoAuth, otherwise the step stays an unsaved draft until you add one with vs_update_step);',
    '"function" = JavaScript code; "api" = HTTP request; "variable" = named value (context.vals.<slug>);',
    '"condition" = if/else block with its first branch (viaSocket adds the else-branch itself; then add steps with parent = the returned branch slug);',
    '"branch" = another branch in an existing condition (parent = the condition slug); "comment" = canvas note; "break" = stop the flow.',
    'Placement: parent ("root" or a branch slug) plus afterSlug, or atStart. Default: end of the parent.',
    'The returned slug is the real step name (titles are de-duplicated); later steps reference the output as context.res.<slug>.',
  ].join(' '),
  parameters: params(
    {
      type: S.enum(['plugin', 'function', 'api', 'variable', 'condition', 'branch', 'comment', 'break'], 'Kind of step.'),
      title: S.str('Step name (plugin, function, api, variable). Becomes a code identifier such as Send_Slack_Message; spaces become underscores.', {
        maxLength: 60,
      }),
      actionId: S.str('App steps: actionId from vs_list_app_actions.', { pattern: ROW_ID_RE.source }),
      parent: S.str('"root" (default) or a branch slug; for type "branch" the condition slug.', { pattern: SLUG_RE.source }),
      afterSlug: S.str('Insert right after this step (must be directly inside parent).', { pattern: SLUG_RE.source }),
      atStart: S.bool('Insert as the first item of parent.'),
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
      function: 'a code step',
      api: 'an API call',
      variable: 'a variable',
      condition: 'a condition',
      branch: 'a branch',
      comment: 'a note',
      break: 'a stop step',
    }
    return a.title && ['plugin', 'function', 'api', 'variable'].includes(a.type) ? `Adding ${label(a.title, 'a step')}` : `Adding ${kind[a.type] ?? 'a step'}`
  },
  async run(a, ctx) {
    const warnings = precheckAdd(a)
    const t = resolveFlow(ctx, a.scriptId)
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const js = (await getFlow(ctx, t)).json_script
      const parent = a.parent ?? 'root'
      checkParent(js, a.type, parent)
      const plan = insertPlan(js, a.type, parent, a.afterSlug, a.atStart)

      let action: ActionRow | undefined
      let authData: AuthData | undefined
      if (a.type === 'plugin') {
        action = await getActionRow(ctx, a.actionId ?? '')
        if (action.type === 'trigger') throw new ToolError('That is a trigger, not an action. Use vs_set_trigger with kind "app".')
        if (action.type === 'custom_action' || action.type === 'custom_api') {
          throw new ToolError('Custom actions cannot be configured by the assistant. Add it from the "Add step" panel instead.')
        }
        const encoded = encodeInputData(a.inputData ?? {}, normalizeInputJson(action.inputjson))
        if (encoded.problems.length) fail(encoded.problems)
        if (action.authtype === 'NoAuth') authData = { id: 'NoAuth', type: 'NoAuth' }
        else if (a.connectionId) {
          if (!action.pluginrecordid || !action.authidlookup) throw new ToolError('This action has no connection settings; it cannot be added.')
          authData = await resolveConnection(ctx, a.connectionId, action.pluginrecordid, action.authidlookup, t)
        }
      }

      const stepId = prefixedStepId(ID_PREFIX[a.type])
      const childId = a.type === 'condition' ? prefixedStepId('ifcb') : undefined
      const wanted =
        a.type === 'plugin'
          ? toStepSlug(a.title || action?.name || 'App_step')
          : ['function', 'api', 'variable'].includes(a.type)
            ? toStepSlug(a.title ?? '')
            : a.type === 'break'
              ? 'Break'
              : stepId // ifGroup / ifBlock / comment keys must equal their id
      const createBody: Record<string, unknown> = {
        type: a.type === 'condition' ? 'ifGroup' : a.type === 'branch' ? 'ifBlock' : a.type,
        title: wanted,
        stepId,
        orderGroup: parent,
      }
      if (plan.position !== undefined) createBody.position = plan.position
      if (a.description && ['plugin', 'function', 'api', 'variable'].includes(a.type)) createBody.description = a.description
      if (action) {
        createBody.actionId = action.rowid
        if (action.iconurl) createBody.iconUrl = action.iconurl
      }
      if (a.type === 'comment') createBody.data = a.text
      if (a.type === 'break') Object.assign(createBody, { data: '', _data: '' })
      if (childId) createBody.stepChildDetails = { type: 'ifBlock', title: childId, orderGroup: stepId, stepId: childId }

      const created = await call('Adding the step', () =>
        ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/stepv2`, body: createBody, live: true, signal: ctx.signal }),
      )
      const after = normalizeFlow(asRecord(created).script)?.json_script
      const slug = after ? slugForStepId(after, stepId) : undefined
      const block = slug && after ? after.blocks[slug] : undefined
      if (!after || !slug || !block) throw new ToolError('The step was created but is missing from the response. Call vs_get_flow to check the flow.')

      const result: Record<string, unknown> = { created: true, slug, stepId, type: a.type, parent }
      if (slug !== wanted && ['plugin', 'function', 'api', 'variable'].includes(a.type)) result.note = `The name ${wanted} was taken, so the step is ${slug}.`
      if (plan.reorderTo !== undefined) {
        try {
          await reorder(ctx, t, slug, parent, plan.reorderTo)
        } catch (e) {
          if (isAbort(e)) throw e
          warnings.push(`Could not move it to the start: ${messageOf(e)}`)
        }
      }

      try {
        const saved = await saveNewStep(ctx, t, a, slug, block, after, authData, childId)
        Object.assign(result, saved.result)
        warnings.push(...saved.warnings)
      } catch (e) {
        if (isAbort(e)) throw e
        return {
          ...result,
          saved: false,
          error: messageOf(e),
          hint: `"${slug}" exists as an unsaved draft. Fix the problem and call vs_update_step with slugName "${slug}", or remove it with vs_delete_step.`,
          warnings: warnings.length ? warnings : undefined,
        }
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
  switch (a.type) {
    case 'plugin': {
      const meta = block.metaData
      if (!meta?.serviceId || !meta.actionVersionId) throw new ToolError('viaSocket did not attach the app definition to the step.')
      const encoded = encodeInputData(a.inputData ?? {}, normalizeInputJson(meta.inputJson), asRecord(meta.selectedValues?.inputData))
      if (encoded.unknownKeys.length) warnings.push(`Ignored unknown fields: ${encoded.unknownKeys.join(', ')}`)
      // The server presets NoAuth on actions that need no connection.
      if (!authData && (meta.authType === 'NoAuth' || meta.selectedValues?.authData?.id === 'NoAuth')) authData = { id: 'NoAuth', type: 'NoAuth' }
      if (!authData) {
        return {
          result: {
            saved: false,
            status: 'DRAFTED',
            needsConnection: { serviceId: meta.serviceId, authIdLookup: meta.authIdLookup, actionVersionId: meta.actionVersionId },
            hint: `Pick a connection (vs_list_connections, or vs_connect_app), then call vs_update_step with slugName "${slug}", connectionId and inputData.`,
          },
          warnings,
        }
      }
      await putStep(ctx, t, slug, pluginBody(c, meta, authData, encoded.inputData))
      if (encoded.missingRequired.length) warnings.push(`Required fields still empty: ${encoded.missingRequired.join(', ')}`)
      return { result: { saved: true, status: 'ACTIVE', reference: `context.res.${slug}` }, warnings }
    }
    case 'function':
      await putStep(ctx, t, slug, functionBody(c, a.code ?? '', { dynamicVariables: mergeDynamicVariables({}, a.dynamicVariables) }))
      return { result: { saved: true, status: 'ACTIVE', reference: `context.res.${slug}` }, warnings }
    case 'api': {
      const { code } = buildApiCode(apiSpec(a), {})
      await putStep(ctx, t, slug, apiBody(c, code, { dynamicVariables: mergeDynamicVariables({}, a.dynamicVariables) }))
      return { result: { saved: true, status: 'ACTIVE', reference: `context.res.${slug}` }, warnings }
    }
    case 'variable':
      await putStep(ctx, t, slug, variableBody(c, a.expression ?? ''))
      return { result: { saved: true, status: 'ACTIVE', reference: `context.vals.${slug}` }, warnings }
    case 'condition': {
      const branch = childId ? slugForStepId(js, childId) : undefined
      if (!childId || !branch) throw new ToolError('The first branch of the condition was not created.')
      const condition = a.condition ?? ''
      await putStep(ctx, t, branch, ifBlockBody({ stepId: childId, title: branch }, condition, a.statement ?? truncate(condition, 80), {}))
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
      await putStep(ctx, t, slug, ifBlockBody(c, condition, a.statement ?? truncate(condition, 80), {}))
      return { result: { saved: true, hint: `Add steps to this branch with parent "${slug}".` }, warnings }
    }
    case 'break':
      if (a.text) await putStep(ctx, t, slug, breakBody(c, a.text, block.mode))
      return { result: { saved: true }, warnings }
    case 'comment':
      return { result: { saved: true }, warnings }
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
    'Change and save an existing step. Only the fields you pass change; the rest of the saved configuration is kept.',
    'Also use it to save a step that is still an unsaved draft (e.g. an app step that needed a connection).',
    'App steps: inputData is merged into the saved values (set replaceInputData to start from empty); connectionId switches the connection.',
    'Rename only with newTitle (other steps that reference the old name are not updated, so viaSocket may refuse).',
    'The webhook response is the step "response": set responseType ("default", or "custom" with responseBody, a JavaScript expression returned to the caller).',
    'Use the type-specific fields of the step being edited (see vs_get_step).',
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
      const js = (await getFlow(ctx, t)).json_script
      const slug = a.slugName
      const block = js.blocks[slug]
      if (!block) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
      if (block.type === 'ifGroup') throw new ToolError('A condition (ifGroup) has nothing to save itself; update its branches (ifBlock slugs) instead.')
      if (block.isElseBlock) throw new ToolError('The else-branch is managed by viaSocket and cannot be edited.')
      if (block.status === 'DELETE') throw new ToolError(`"${slug}" is deleted.`)
      if (block.type !== 'response' && !block.identifier) throw new ToolError(`"${slug}" has no step id; it cannot be saved.`)

      let title = slug
      if (a.newTitle && a.newTitle !== slug) {
        if (!RENAMABLE.has(block.type)) throw new ToolError(`${block.type} steps cannot be renamed.`)
        if (!isValidStepSlug(a.newTitle)) {
          throw new ToolError('newTitle must be 4-50 letters, digits or underscores, start with a letter, and not be a reserved word.')
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
      const body = await buildUpdateBody(ctx, t, a, slug, block, c, warnings)
      // An open panel keeps its own copy of the step, which live-apply does not touch; saving it later would undo
      // this change. A plain save plus the refetch below makes the editor reload the step instead.
      const panelOpen = editorParam(ctx, 'slugName', t.scriptId) === slug
      await putStep(ctx, t, slug, body, !panelOpen)

      if (panelOpen) refreshEditorIfOpen(ctx, t.scriptId, title !== slug ? { slugName: title } : {})
      const reference = block.type === 'variable' ? `context.vals.${title}` : block.type === 'response' ? undefined : `context.res.${title}`
      return {
        saved: true,
        slug: title,
        renamedFrom: title !== slug ? slug : undefined,
        reference,
        warnings: warnings.length ? warnings : undefined,
      }
    })
  },
})

async function buildUpdateBody(
  ctx: ToolContext,
  t: FlowTarget,
  a: UpdateStepArgs,
  slug: string,
  block: Block,
  c: SaveCommon,
  warnings: string[],
): Promise<Record<string, unknown>> {
  switch (block.type) {
    case 'function': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const code = a.code ?? fn?.code
      if (!code) throw new ToolError('code is required: this function step has never been saved.')
      return functionBody(c, code, {
        dynamicVariables: mergeDynamicVariables(fn?.metadata?.drafted?.dynamicVariables, a.dynamicVariables),
        authId: fn?.auth_id,
        subfunctions: block.subfunctions,
      })
    }
    case 'api': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const { code, problems } = buildApiCode(apiSpec(a), asRecord(parseMaybeJson(fn?.code)))
      if (problems.length) fail(problems)
      return apiBody(c, code, {
        dynamicVariables: mergeDynamicVariables(fn?.metadata?.drafted?.dynamicVariables, a.dynamicVariables),
        authId: fn?.auth_id,
      })
    }
    case 'plugin': {
      const fn = await getFunctionRow(ctx, t, c.stepId)
      const pd = pluginDataOf(block, fn)
      if (!pd) throw new ToolError('This app step has no app definition. Delete it and add it again.')
      const ij = normalizeInputJson(pd.inputJson)
      const base = a.replaceInputData ? {} : asRecord(pd.selectedValues?.inputData)
      const encoded = encodeInputData(a.inputData ?? {}, ij, base)
      if (encoded.problems.length) fail(encoded.problems)
      if (encoded.unknownKeys.length) warnings.push(`Ignored unknown fields: ${encoded.unknownKeys.join(', ')}`)
      if (encoded.missingRequired.length) warnings.push(`Required fields still empty: ${encoded.missingRequired.join(', ')}`)
      let authData: AuthData | undefined
      if (a.connectionId) {
        const serviceId = str(pd.serviceId) ?? ''
        const lookup = str(pd.authIdLookup) ?? ''
        if (!ROW_ID_RE.test(serviceId) || !ROW_ID_RE.test(lookup)) throw new ToolError('This app step has no connection settings.')
        authData = await resolveConnection(ctx, a.connectionId, serviceId, lookup, t)
      } else if (pd.authType === 'NoAuth') authData = { id: 'NoAuth', type: 'NoAuth' }
      else if (pd.selectedValues?.authData?.id) authData = pd.selectedValues.authData
      if (!authData?.id) {
        throw new ToolError(
          `This app step needs a connection. Get one with vs_list_connections (serviceId ${pd.serviceId}, authIdLookup ${pd.authIdLookup}) or vs_connect_app, then pass connectionId.`,
        )
      }
      return pluginBody(c, pd, authData, encoded.inputData)
    }
    case 'variable': {
      const expression = a.expression ?? str(block.data) ?? ''
      const p = checkExpression(expression)
      if (p) fail([`expression: ${p}`])
      return variableBody(c, expression)
    }
    case 'ifBlock': {
      const condition = a.condition ?? str(block.condition) ?? ''
      const p = checkExpression(condition)
      if (p) fail([`condition: ${p}`])
      return ifBlockBody(c, condition, a.statement ?? str(block.statement) ?? truncate(condition, 80), block.dynamicVariables)
    }
    case 'comment':
      return commentBody(c, a.text ?? str(block.data) ?? '', block.metadata)
    case 'break': {
      const data = a.text ?? str(block.data) ?? ''
      const p = data.trim() ? checkExpression(data) : undefined
      if (p) fail([`text: ${p}`])
      return breakBody(c, data, block.mode)
    }
    case 'response': {
      if (slug !== 'response') throw new ToolError('Unexpected response block.')
      const responseType = a.responseType ?? (block.responseType === 'custom' ? 'custom' : 'default')
      const data = a.responseBody ?? str(block.data) ?? ''
      if (responseType === 'custom') {
        const p = checkExpression(data)
        if (p) fail([`responseBody: ${p}`])
      }
      return responseBody(responseType, data, block.customHeaders)
    }
    default:
      throw new ToolError(`${block.type} steps cannot be edited by the assistant.`)
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
      if (editorParam(ctx, 'slugName', t.scriptId) === slug) {
        try {
          ctx.ui.navigate(pagePathWithParams(ctx.page.url, { stepId: null, slugName: null }), { replace: true })
        } catch {
          // Closing the panel is cosmetic.
        }
      }
      return {
        deleted: true,
        slug,
        alsoDeleted: nested.length ? nested : undefined,
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
      return { moved: true, slug, parent: target, index: newIndex, notes: notes.length ? notes : undefined }
    })
  },
})

export const STEP_TOOLS: Tool<any>[] = [addStep, updateStep, deleteStep, moveStep]
