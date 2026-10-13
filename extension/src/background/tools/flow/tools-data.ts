// Read-only tools for configuring steps from real data: vs_get_variables (what a step can map, as insert texts,
// with where each sample came from) and vs_get_field_options (the real choices of a dropdown field).

import type { Tool } from '../types'
import { fieldList, normalizeInputJson } from './catalog'
import { resolveConnection } from './connections'
import { ToolError } from './errors'
import {
  depsSignature, expandSourceGroups, generatesFields, loadFieldOptions, loadGroupFields, mergePending, rememberGroupFields, rememberOptions, stepKey,
  type SavedState,
} from './fields'
import { findParent, getFlow, getFunctionRow, pluginDataOf, resolveFlow, triggerKind } from './flow-api'
import { encodeInputData } from './input-data'
import { buildCatalogue, variablesOf, type Position } from './samples'
import { defineTool, params, S } from './schema'
import { SCRIPT_ID_PARAM } from './tools-read'
import { getDataPluginForOptions } from './trigger-features'
import type { AuthData, PluginData } from './types'
import { asRecord, AUTH_ID_RE, bounded, FLOW_PAGES, label, ROW_ID_RE, SLUG_RE, str } from './util'

const pages = [...FLOW_PAGES]
const MAX_VARIABLES = 150

interface GetVariablesArgs {
  beforeSlug?: string
  afterSlug?: string
  scriptId?: string
}

const getVariables = defineTool<GetVariablesArgs>({
  name: 'vs_get_variables',
  description:
    'List the data a step can use, as insert texts to paste into its fields (e.g. ${context.req.body.comment_id}), built like the editor\'s variable picker: the trigger\'s sample and the output of every step that runs before the position. Each source says where its data comes from: "tested" (a real test), "run" (the latest run), "documented" (only the app\'s example output, not real) or "none" (test it first with vs_test_trigger / vs_test_step). Position: the end of the flow by default; beforeSlug for an existing step; afterSlug for a step about to be added after that one. Map fields only with these insert texts.',
  parameters: params({
    beforeSlug: S.str('Data available to this existing step (steps before it).', { pattern: SLUG_RE.source }),
    afterSlug: S.str('Data available to a new step placed right after this step (included).', { pattern: SLUG_RE.source }),
    scriptId: SCRIPT_ID_PARAM,
  }),
  danger: 'safe',
  pages,
  describe: () => 'Looking at the data steps can use',
  async run(a, ctx) {
    if (a.beforeSlug && a.afterSlug) throw new ToolError('Give beforeSlug or afterSlug, not both.')
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const js = row.json_script
    let pos: Position = { at: 'end' }
    const slug = a.beforeSlug ?? a.afterSlug
    if (slug && !js.blocks[slug]) throw new ToolError(`No step "${slug}". Call vs_get_flow for the current slugs.`)
    if (a.beforeSlug) pos = { at: 'before', slug: a.beforeSlug }
    else if (a.afterSlug) pos = { at: 'insert', parent: findParent(js, a.afterSlug) ?? 'root', afterSlug: a.afterSlug }
    const cat = await buildCatalogue(ctx, t, row, pos)
    const strip = ctx.stripRunData
    let budget = MAX_VARIABLES
    const sources = cat.sources.map((s) => {
      const variables = s.origin && budget > 0 ? variablesOf(s, strip, Math.min(60, budget)) : []
      budget -= variables.length
      return {
        source: s.id,
        kind: s.id === 'trigger' ? `trigger (${s.type})` : `${s.type} step`,
        app: s.app,
        action: s.action,
        origin: s.origin ?? 'none',
        note: s.note,
        variables: variables.length ? variables : undefined,
      }
    })
    const notTested = cat.sources.filter((s) => !s.origin || s.origin === 'documented').map((s) => s.id)
    return bounded(
      {
        position: cat.position,
        sources,
        notTested: notTested.length ? notTested : undefined,
        rules:
          'Paste insert texts exactly as listed; mixed text is fine, e.g. "Thanks ${context.req.body.from_username}!". Never type or guess a path. Variables of a "documented" source are only the app\'s example: use them only if the user declined testing, with allowDocumentedSample: true.',
      },
      ctx.maxResultChars,
    )
  },
})

interface FieldOptionsArgs {
  slugName: string
  fieldKey: string
  connectionId?: string
  values?: Record<string, unknown>
  search?: string
  limit?: number
  scriptId?: string
}

const NO_AUTH: AuthData = { id: 'NoAuth', type: 'NoAuth' }

const getFieldOptions = defineTool<FieldOptionsArgs>({
  name: 'vs_get_field_options',
  description:
    'Get the real choices of a dropdown field of an app step, of the app trigger (slugName "SET_TRIGGER") or of the Get Data app action ("CRON_PRE_PROCESS"): the same list the panel shows, either fixed options or options the app loads with the connection (e.g. the user\'s posts, channels or sheets). Pass values for the fields it depends on (parent choices already made) and connectionId when the step has no saved connection yet. Returns [{label, value}]: show the labels to the user, ask them to pick, then save the chosen value with vs_set_trigger / vs_add_step / vs_update_step. For an input group whose fields the app generates (e.g. one field per sheet column) it returns those fields instead. Read only.',
  parameters: params(
    {
      slugName: S.str('App step slug from vs_get_flow, "SET_TRIGGER" for the app trigger, or "CRON_PRE_PROCESS" for the Get Data app action.', { pattern: SLUG_RE.source }),
      fieldKey: S.str('Field key (vs_get_action / needsUserInput).', { minLength: 1, maxLength: 200 }),
      connectionId: S.str('Connection to load choices with, when the step or trigger has none saved yet.', { pattern: AUTH_ID_RE.source }),
      values: S.map('Values of fields this one depends on (parent fields), keyed by field key.'),
      search: S.str('Search text, for fields that search the app (large lists).', { maxLength: 100 }),
      limit: S.int('Maximum choices to return (default 50).', { minimum: 1, maximum: 100 }),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['slugName', 'fieldKey'],
  ),
  danger: 'safe',
  pages,
  describe: (a) => `Loading the choices for ${label(a.fieldKey, 'a field')}`,
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const js = (await getFlow(ctx, t)).json_script
    const isTrigger = a.slugName === 'SET_TRIGGER'
    let pd: PluginData | null
    let holdKey: string
    let drafted: boolean
    let noConnection = false
    let getData: ReturnType<typeof getDataPluginForOptions>
    if (a.slugName === 'CRON_PRE_PROCESS') {
      getData = getDataPluginForOptions(ctx, t, js.trigger)
      if (!getData) throw new ToolError('No Get Data app action is set up or being set up. Start with vs_set_get_data source "app" and an actionId.')
      pd = getData.pd
      holdKey = getData.holdKey
      drafted = false
    } else if (isTrigger) {
      const trig = js.trigger
      const kind = triggerKind(trig)
      if (!trig || !kind || ['webhook', 'email', 'cron'].includes(kind)) {
        throw new ToolError('The trigger is not an app trigger. Choose the app event with vs_set_trigger first.')
      }
      pd = trig
      holdKey = stepKey(ctx, t, `SET_TRIGGER:${str(trig.selectedCreate) ?? ''}`)
      drafted = trig.isDrafted === true
      // The trigger panel shows no connection for manual webhook triggers.
      noConnection = kind === 'manual_webhook' || trig.authType === 'NoAuth'
    } else {
      const block = js.blocks[a.slugName]
      if (!block) throw new ToolError(`No step "${a.slugName}". Call vs_get_flow for the current slugs.`)
      if (block.type !== 'plugin' || !block.identifier) throw new ToolError(`"${a.slugName}" is not an app step; only app steps have dropdown fields.`)
      pd = pluginDataOf(block, await getFunctionRow(ctx, t, block.identifier))
      holdKey = stepKey(ctx, t, block.identifier)
      drafted = block.status === 'DRAFTED'
    }
    if (!pd) throw new ToolError('This step has no app definition. Delete it and add it again.')
    const saved: SavedState = getData?.saved ?? {
      inputData: isTrigger && drafted ? {} : asRecord(pd.selectedValues?.inputData),
      authId: isTrigger && drafted ? undefined : str(pd.selectedValues?.authData?.id),
    }
    const merged = mergePending(holdKey, a.values, saved)

    const serviceId = str(pd.serviceId) ?? ''
    const lookup = str(pd.authIdLookup) ?? ''
    const connectionId = a.connectionId ?? merged.connectionId
    let authData: AuthData | undefined
    if (pd.authType === 'NoAuth' || pd.selectedValues?.authData?.id === 'NoAuth') authData = NO_AUTH
    else if (noConnection) authData = asRecord(pd.selectedValues?.authData) as AuthData
    else if (connectionId) {
      if (!ROW_ID_RE.test(serviceId) || !ROW_ID_RE.test(lookup)) throw new ToolError('This app has no connection settings.')
      authData = await resolveConnection(ctx, connectionId, serviceId, lookup, t)
    } else if (getData) authData = getData.savedAuth
    else if (pd.selectedValues?.authData?.id && !(isTrigger && drafted)) authData = pd.selectedValues.authData
    const avid = str(pd.actionVersionId) ?? ''
    if (!ROW_ID_RE.test(avid)) throw new ToolError('This step has no action version; add it again.')

    let ij = normalizeInputJson(pd.inputJson)
    let encoded = encodeInputData(merged.values, ij, saved.inputData)
    if (encoded.problems.length) throw new ToolError(`Fix these values first: ${encoded.problems.join(' | ')}`)
    const slug = isTrigger ? undefined : a.slugName
    if (!ij.blocks[a.fieldKey] && (authData?.id || noConnection)) {
      // A field inside an input group the app generates exists only once those fields are loaded.
      const grown = await expandSourceGroups(ctx, t, {
        ij,
        authData,
        inputData: encoded.inputData,
        actionVersionId: avid,
        isTrigger,
        slug,
        noConnection,
        holdKey,
        changed: new Set(Object.keys(a.values ?? {})),
      })
      ij = grown.ij
      encoded = encodeInputData(merged.values, ij, saved.inputData)
    }
    const def = ij.blocks[a.fieldKey]
    if (!def) {
      throw new ToolError(`No field "${a.fieldKey}". Fields: ${fieldList(ij).map((f) => f.key).slice(0, 40).join(', ') || 'none'}.`)
    }
    const field = { key: a.fieldKey, label: str(def.label), type: str(def.type), required: def.required === true || undefined }
    const request = { ij, fieldKey: a.fieldKey, authData, inputData: encoded.inputData, actionVersionId: avid, isTrigger, slug, search: a.search, noConnection }
    const needsConnection = {
      field,
      needsConnection: { serviceId, authIdLookup: lookup },
      next: "These come from the user's account: pick a connection first (vs_list_connections, or vs_connect_app), then call again with connectionId.",
    }

    if (generatesFields(def)) {
      const g = await loadGroupFields(ctx, t, request)
      if (g.needsFirst) return { field, fields: [], needsFirst: g.needsFirst, next: `Its fields depend on ${g.needsFirst.join(', ')}: ask for that first, then call again with it in values.` }
      if (g.needsConnection) return needsConnection
      if (!g.fields) return { field, fields: [], error: g.error }
      rememberGroupFields(holdKey, a.fieldKey, depsSignature(a.fieldKey, def, encoded.inputData), g.fields)
      const generated = fieldList({ steps: { ...g.fields.steps, root: g.fields.steps[a.fieldKey] ?? [] }, blocks: g.fields.blocks })
      return bounded(
        {
          field,
          generatedFields: generated,
          help: g.help,
          next: generated.length
            ? 'These fields come from the app. Ask the user for the required ones (one short question at a time; map earlier data with insert texts), then save them under these exact keys.'
            : 'The app generated no fields for these choices.',
        },
        ctx.maxResultChars,
      )
    }

    const r = await loadFieldOptions(ctx, t, request, a.limit ?? 50)
    if (r.options.length) rememberOptions(holdKey, a.fieldKey, depsSignature(a.fieldKey, def, encoded.inputData), r.options)
    if (r.needsFirst) {
      return { field, options: [], needsFirst: r.needsFirst, next: `Its choices depend on ${r.needsFirst.join(', ')}: ask for that first, then call again with it in values.` }
    }
    if (r.needsConnection) return { ...needsConnection, options: [] }
    return bounded(
      {
        field,
        options: r.options.map((o) => ({ label: o.label, value: o.value })),
        total: r.total,
        more: r.more,
        loadedFromApp: r.dynamic || undefined,
        help: r.help,
        error: r.error,
        next: r.options.length
          ? 'Show the labels to the user (a few at a time if there are many), ask which one, then save its value. If the user types a value of their own instead, save it with customInput: [this field key].'
          : undefined,
      },
      ctx.maxResultChars,
    )
  },
})

export const DATA_TOOLS: Tool<any>[] = [getVariables, getFieldOptions]
