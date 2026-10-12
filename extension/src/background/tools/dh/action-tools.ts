// Write tools for actions/triggers and their versions. Only drafted, unverified versions are ever edited; a
// published or verified version must be copied with dh_new_action_version first. Nothing here publishes.

import * as z from '../../../shared/zod'
import type { Tool, ToolContext } from '../types'
import { dhCreate, dhGet, dhGetOne, dhUpdate, fail, orgOf } from './api'
import { P, dhTool, label, rowId } from './define'
import {
  CODE_SLIDERS, SCHEDULE_MINUTES, TRIGGER_TYPES, inputFieldsOf, lockReason, normalizeSampleValue, obj, rowsOf,
  sameJson, scheduleOf, slidersFor, str, triggerTypeOf, type CodeSlider, type Row, type TriggerType,
} from './rows'
import { forgetDryRuns } from './dry-run-log'
import { syncActionRow, syncVersion } from './sync'
import { editorOpen, requirePluginId, resolveVersionTarget, type VersionTarget } from './target'

// ---------- input field schema (the input builder's inputjson.inputFields) ----------

const FIELD_TYPES = [
  'string', 'number', 'boolean', 'dropdown', 'multiselect', 'radio', 'date', 'dictionary', 'input groups', 'aifield', 'html',
  'markdown', 'help',
] as const

interface InputFieldArg {
  key: string
  label: string
  type: (typeof FIELD_TYPES)[number]
  children?: InputFieldArg[] | undefined
  fields?: InputFieldArg[] | undefined
  [k: string]: unknown
}

const FIELD_KEY_RE = /^[A-Za-z_$][\w$-]{0,79}$/
const jsSource = z.string().max(50_000)

// Loose so that properties the builder knows but this schema does not (e.g. authInfo) survive a read/modify/write.
const inputField: z.ZodType<InputFieldArg> = z.lazy(() =>
  z.looseObject({
    key: z.string().trim().regex(FIELD_KEY_RE, 'must be an identifier like table_id'),
    label: z.string().trim().min(1).max(200),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    help: z.string().max(4000).optional(),
    placeholder: z.string().max(1000).optional(),
    options: z
      .array(z.looseObject({ label: z.string().max(500), value: z.union([z.string().max(2000), z.number(), z.boolean()]) }))
      .max(500)
      .optional(),
    optionsGenerator: jsSource.optional(),
    fieldsGenerator: jsSource.optional(),
    suggestionGenerator: jsSource.optional(),
    visibilityCondition: z.string().max(4000).optional(),
    enableSearchApi: z.boolean().optional(),
    canPaginate: z.boolean().optional(),
    children: z.array(inputField).max(100).optional(),
    fields: z.array(inputField).max(100).optional(),
  }),
)

const INPUT_FIELD_JSON = {
  type: 'object',
  description:
    'One input field. Dynamic dropdowns use optionsGenerator: JS that returns [{label, value}] and may call mapped components ' +
    'and read context.inputData / context.authData. "input groups" fields nest children (or use fieldsGenerator returning fields).',
  properties: {
    key: { type: 'string', description: 'Identifier; slider code reads it as context.inputData.<key>' },
    label: { type: 'string' },
    type: { type: 'string', enum: [...FIELD_TYPES] },
    required: { type: 'boolean' },
    help: { type: 'string' },
    placeholder: { type: 'string' },
    options: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] },
      description: 'Static choices for dropdown/multiselect/radio.',
    },
    optionsGenerator: { type: 'string' },
    fieldsGenerator: { type: 'string' },
    visibilityCondition: { type: 'string' },
    enableSearchApi: { type: 'boolean' },
    children: { type: 'array', items: { type: 'object' }, description: 'Nested fields (same shape) for "input groups".' },
  },
  required: ['key', 'label', 'type'],
}

function duplicateKeys(fields: Row[]): string[] {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const f of fields) {
    const k = str(f.key)
    if (!k) continue
    if (seen.has(k)) dups.add(k)
    seen.add(k)
  }
  return [...dups]
}

/** Upserts by key, keeping existing order and existing properties the model did not mention. */
function mergeFields(current: Row[], incoming: InputFieldArg[]): Row[] {
  const out = current.map((f) => ({ ...f }))
  for (const f of incoming) {
    const i = out.findIndex((x) => x.key === f.key)
    if (i >= 0) out[i] = { ...out[i], ...f }
    else out.push({ ...f })
  }
  return out
}

// ---------- shared helpers ----------

const CODE_PROPS = Object.fromEntries(CODE_SLIDERS.map((s) => [s, { type: 'string' }]))

const SLIDER_HELP =
  'Sliders per entity: action → perform. Trigger "hook" (instant webhook) → performsubscribe (register the webhook, return its ' +
  'id), performunsubscribe, performlist (return recent sample items), modifytriggerdata (reshape the incoming payload in ' +
  'context.req.body), transferoption. Trigger "polling" → perform (return new items), performlist, transferoption. Trigger ' +
  '"manual_webhook" → perform, performlist, modifytriggerdata.'

function codeWarnings(code: Partial<Record<CodeSlider, string>>, fieldKeys: Set<string>): string[] {
  const out: string[] = []
  for (const [slider, src] of Object.entries(code)) {
    if (!src?.trim()) continue
    if (!/\breturn\b/.test(src)) out.push(`${slider} has no return statement, so its output will be empty.`)
    const refs = new Set([...src.matchAll(/context\??\.inputData\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? ''))
    const missing = [...refs].filter((k) => k && !fieldKeys.has(k))
    if (missing.length) out.push(`${slider} reads context.inputData.${missing.join(', context.inputData.')} but no input field has that key.`)
  }
  return out
}

async function pluginAuths(ctx: ToolContext, pluginId: string): Promise<Row[]> {
  return dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId)
}

function editableDraftHint(t: VersionTarget): string {
  const draft = [...t.versions].reverse().find((v) => !lockReason(v, t.action))
  return draft
    ? ` ${str(draft.versionid)} (versionId ${str(draft.rowid)}) is an editable draft; update that one, or call dh_new_action_version.`
    : ' Call dh_new_action_version to create an editable copy, then update the new version.'
}

// ---------- dh_create_action ----------

const createAction = dhTool({
  name: 'dh_create_action',
  description:
    'Create a new action or trigger in a plug. viaSocket creates its first version V1 as an editable draft (this tool never ' +
    'publishes). Returns actionId and versionId. Next: set code, input fields and sample data with dh_update_action_version, test ' +
    'with dh_dry_run, then publish with dh_publish_action_version. If an action/trigger with the same name exists, it is returned instead.',
  properties: {
    pluginId: P.pluginId,
    type: { type: 'string', enum: ['action', 'trigger'] },
    name: { type: 'string', description: 'Short verb phrase users will see, e.g. "Create Record" or "New Row".' },
    description: { type: 'string', description: 'One sentence describing what it does (required to publish).' },
    triggerType: {
      type: 'string',
      enum: [...TRIGGER_TYPES],
      description: 'Triggers only: hook (app sends webhooks, instant), polling (viaSocket polls), manual_webhook (user pastes a URL). Default hook.',
    },
    authId: { ...P.authId, description: 'Connection version to use. Defaults to the plug\'s default one (NoAuth for manual_webhook).' },
    category: { type: 'string', description: 'Optional category, e.g. "CREATE".' },
    subCategory: { type: 'string', description: 'Optional entity name, e.g. "RECORD".' },
    preferredStepName: { type: 'string', description: 'Optional default step name in flows.' },
  },
  required: ['type', 'name', 'description'],
  danger: 'write',
  schema: z.object({
    pluginId: rowId.optional(),
    type: z.enum(['action', 'trigger']),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(5).max(1000),
    triggerType: z.enum(TRIGGER_TYPES).optional(),
    authId: rowId.optional(),
    category: z.string().trim().max(40).optional(),
    subCategory: z.string().trim().max(60).optional(),
    preferredStepName: z.string().trim().max(60).optional(),
  }),
  describe: (a) => `Creating ${a.type} ${label(a.name)}`,
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    if (a.type === 'action' && a.triggerType) fail('triggerType only applies to triggers.')
    const [plugin, actions, auths] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'actions', 'getAllActions', pluginId),
      pluginAuths(ctx, pluginId),
    ])
    const existing = actions.find((x) => str(x.type) === a.type && str(x.name)?.trim().toLowerCase() === a.name.toLowerCase())
    if (existing) {
      return { alreadyExists: true, actionId: str(existing.rowid), name: str(existing.name), type: a.type, tip: 'Use dh_get_action_version to read it.' }
    }

    const triggerType: TriggerType | undefined = a.type === 'trigger' ? (a.triggerType ?? 'hook') : undefined
    let authId = a.authId
    if (triggerType === 'manual_webhook') {
      authId ??= str(auths.find((x) => str(x.type) === 'NoAuth')?.rowid)
      if (!authId) {
        fail('Manual webhook triggers need a NoAuth connection version. Create one with dh_update_auth_version {createNewVersion:true, type:"NoAuth"}, then retry with its authId.')
      }
    }
    authId ??= str(plugin.preferedauthversion) ?? (auths.length === 1 ? str(auths[0]?.rowid) : undefined)
    if (!authId) fail('This plug has no default connection version. Create one with dh_update_auth_version (createNewVersion:true, type) or pass authId.')
    const auth = auths.find((x) => x.rowid === authId)
    if (!auth) fail(`Connection version ${authId} does not belong to plug ${pluginId}.`)
    if (triggerType === 'manual_webhook' && str(auth.type) !== 'NoAuth') fail('Manual webhook triggers must use a NoAuth connection version.')

    const body: Row = {
      name: a.name,
      description: a.description,
      key: a.name.replace(/ /g, '_'),
      pluginrecordid: pluginId,
      // Private until explicitly published; rtllayer is never sent because it auto-publishes V1.
      isvisible: false,
      type: a.type,
      authid: authId,
      ignoreuniversalsampledata: false,
      preferred_step_name: a.preferredStepName ?? '',
      ...(a.category ? { category: a.category.toUpperCase().replace(/\s+/g, '_') } : {}),
      ...(a.subCategory ? { sub_category: a.subCategory.toUpperCase().replace(/\s+/g, '_') } : {}),
      ...(triggerType ? { triggertype: triggerType } : {}),
    }
    const { rows, data } = await dhCreate(ctx, 'actions', body)
    const actionRow = rows[0]
    const actionId = str(actionRow?.rowid)
    if (!actionRow || !actionId) fail('viaSocket did not return the new action id. Check dh_list_actions before retrying.')
    let versionId = str(rowsOf(obj(data.actionVersionData)?.data)[0]?.rowid)
    if (!versionId) {
      const versions = await dhGet(ctx, 'action_version', 'getActionVersions', actionId)
      versionId = str(versions[versions.length - 1]?.rowid)
    }
    const page = await syncActionRow(ctx, pluginId, actionRow)
    return {
      actionId,
      versionId,
      version: 'V1',
      type: a.type,
      ...(triggerType ? { triggerType, sliders: slidersFor('trigger', triggerType) } : { sliders: ['perform'] }),
      ...(versionId ? { open: editorOpen(pluginId, a.type, actionId, versionId) } : {}),
      ...(page ? { page } : {}),
      next: 'Write the code, input fields and sample data with dh_update_action_version (versionId), then dh_dry_run. Call ui_navigate with the `open` arguments to show it.',
    }
  },
})

// ---------- dh_new_action_version ----------

// Copied from the source version. Everything else (rowid, status, versionid, audit and UI-only keys, 'type') is
// dropped; the server assigns versionid V(n+1), status 'drafted' and NOT_VERIFIED.
const VERSION_COPY_KEYS = [
  'authid', 'triggertype', ...CODE_SLIDERS, 'category', 'sub_category', 'description', 'canpaginate', 'scopes',
  'service_response_type', 'universalsampledata',
] as const

const newActionVersion = dhTool({
  name: 'dh_new_action_version',
  description:
    'Create a new editable draft version of an action/trigger by copying an existing version (default: the one open in the ' +
    'editor, else the latest): code, input fields, sample data, trigger type, polling intervals, connection version and mapped ' +
    'reusable components. Required before changing a published or verified version. Returns the new versionId.',
  properties: {
    actionId: P.actionId,
    sourceVersionId: { type: 'string', description: 'Version row id to copy. Defaults to the open version, else the latest.' },
  },
  danger: 'write',
  schema: z.object({ actionId: rowId.optional(), sourceVersionId: rowId.optional() }),
  describe: () => 'Creating a new draft version',
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, { actionId: a.actionId, versionId: a.sourceVersionId })
    const src = t.version
    const body: Row = { actionid: t.actionId }
    for (const k of VERSION_COPY_KEYS) {
      const v = src[k]
      if (v !== undefined && v !== null) body[k] = v
    }
    const inputjson = obj(src.inputjson)
    if (inputjson) body.inputjson = { steps: obj(inputjson.steps) ?? {}, blocks: obj(inputjson.blocks) ?? {}, inputFields: rowsOf(inputjson.inputFields) }
    if (src.sampledata !== undefined) body.sampledata = normalizeSampleValue(src.sampledata)
    const schedule = scheduleOf(src)
    body.metadata = {
      duplicatedfrom: { rowid: t.versionId, versionid: str(src.versionid) },
      ...(schedule ? { scheduleTimeOptions: schedule } : {}),
    }
    if (schedule) body.scheduleTimeOptions = schedule

    const { rows } = await dhCreate(ctx, 'action_version', body)
    const created = rows[0]
    const newId = str(created?.rowid)
    if (!created || !newId) fail('viaSocket did not return the new version id. Check dh_get_action_version before retrying.')

    // Component mappings are not copied by the server; without them the new version cannot call its helpers.
    const notes: string[] = []
    let componentsCopied = 0
    try {
      const mappings = await dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', t.versionId)
      const org = orgOf(ctx)
      const dataToSend = mappings
        .filter((m) => str(m.component_id))
        .map((m) => ({
          component_id: str(m.component_id),
          pluginrecordid: t.pluginId,
          action_id: t.actionId,
          action_version_id: newId,
          // Bulk rows are inserted raw, so orgid must be supplied or later ownership checks on them fail.
          orgid: org,
          metadata: { componentdependson: obj(obj(m.metadata)?.componentdependson) ?? {} },
        }))
      if (dataToSend.length) {
        await dhCreate(ctx, 'action_version_component_table', { bulkEntry: true, pluginrecordid: t.pluginId, dataToSend })
        componentsCopied = dataToSend.length
      }
    } catch (e) {
      notes.push(`Reusable component mappings could not be copied (${(e as Error).message}); map them in the editor before testing.`)
    }
    const drafts = t.versions.filter((v) => v !== src && !lockReason(v, t.action))
    if (drafts.length) notes.push(`Other editable drafts already exist: ${drafts.map((d) => str(d.versionid)).join(', ')}.`)

    return {
      versionId: newId,
      version: str(created.versionid),
      copiedFrom: { versionId: t.versionId, version: str(src.versionid) },
      componentsCopied,
      ...(notes.length ? { notes } : {}),
      open: editorOpen(t.pluginId, t.kind, t.actionId, newId),
      next: 'Edit it with dh_update_action_version (versionId). Call ui_navigate with the `open` arguments to show it in the editor.',
    }
  },
})

// ---------- dh_update_action_version ----------

const codeSource = z.string().max(200_000)

const updateSchema = z.object({
  versionId: rowId.optional(),
  actionId: rowId.optional(),
  code: z
    .object(Object.fromEntries(CODE_SLIDERS.map((s) => [s, codeSource.optional()])) as Record<CodeSlider, z.ZodOptional<typeof codeSource>>)
    .optional(),
  inputFields: z.array(inputField).max(100).optional(),
  mergeInputFields: z.boolean().optional(),
  removeInputFields: z.array(z.string().trim().max(80)).max(100).optional(),
  sampleDataJson: z.string().max(500_000).optional(),
  triggerType: z.enum(TRIGGER_TYPES).optional(),
  scheduleTimeOptions: z
    .array(z.number().int().refine((n) => (SCHEDULE_MINUTES as readonly number[]).includes(n), 'allowed: 5, 15, 60, 720, 1440'))
    .max(5)
    .optional(),
  authId: rowId.optional(),
})
type UpdateArgs = z.infer<typeof updateSchema>

function parseSampleData(text: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('sampleDataJson must be valid JSON text, e.g. "{\\"id\\":\\"rec1\\"}".')
  }
  return normalizeSampleValue(parsed)
}

const FRIENDLY: Record<string, string> = {
  inputjson: 'input fields',
  sampledata: 'sample data',
  triggertype: 'trigger type',
  scheduleTimeOptions: 'polling intervals',
  authid: 'connection version',
}

const updateActionVersion = dhTool({
  name: 'dh_update_action_version',
  description:
    'Edit a DRAFT action/trigger version (saved immediately; nothing is published). Refuses published, verified or live ' +
    'versions: call dh_new_action_version first. Only send what changes; everything omitted is kept. The code, inputFields and ' +
    'sampleDataJson parameters describe their formats. Set sample data before publishing.',
  properties: {
    versionId: P.versionId,
    actionId: P.actionId,
    code: {
      type: 'object',
      description:
        'Slider sources to save, keyed by slider name. Each is a plain JavaScript async function body with context.inputData ' +
        '(input field values by key), context.authData (connection credentials/tokens), axios and the mapped reusable component ' +
        'functions (see dh_list_components); it must `return` the result, and errors should go through ' +
        '`await errorComponent(error)` in a catch when that component is mapped. ' + SLIDER_HELP,
      properties: CODE_PROPS,
      additionalProperties: false,
    },
    inputFields: {
      type: 'array',
      items: INPUT_FIELD_JSON,
      description: 'Input builder fields, in display order. Replaces the whole list unless mergeInputFields:true (upsert by key).',
    },
    mergeInputFields: { type: 'boolean', description: 'Upsert inputFields by key instead of replacing the whole list.' },
    removeInputFields: { type: 'array', items: { type: 'string' }, description: 'Keys of input fields to delete.' },
    sampleDataJson: { type: 'string', description: 'JSON text of a typical successful output ("null" clears it).' },
    triggerType: { type: 'string', enum: [...TRIGGER_TYPES], description: 'Triggers only.' },
    scheduleTimeOptions: {
      type: 'array',
      items: { type: 'integer', enum: [...SCHEDULE_MINUTES] },
      description: 'Polling triggers only: intervals in minutes users may pick; [] = viaSocket default.',
    },
    authId: { ...P.authId, description: 'Switch this version to another connection version of the plug.' },
  },
  danger: 'write',
  schema: updateSchema,
  describe(a) {
    const parts = [
      ...Object.keys(a.code ?? {}),
      ...(a.inputFields || a.removeInputFields ? ['input fields'] : []),
      ...(a.sampleDataJson !== undefined ? ['sample data'] : []),
      ...(a.triggerType ? ['trigger type'] : []),
      ...(a.scheduleTimeOptions ? ['intervals'] : []),
      ...(a.authId ? ['connection'] : []),
    ]
    return parts.length ? `Saving ${label(parts.join(', '), 40)}` : 'Updating the version'
  },
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, a)
    const v = t.version
    const lock = lockReason(v, t.action)
    if (lock) fail(`${str(v.versionid) ?? 'This version'} cannot be edited because ${lock}.${editableDraftHint(t)}`)
    return applyUpdate(a, ctx, t)
  },
})

async function applyUpdate(a: UpdateArgs, ctx: ToolContext, t: VersionTarget) {
  const v = t.version
  const payload: Row = {}
  const current = triggerTypeOf(v)
  let auths: Row[] | undefined
  const loadAuths = async () => (auths ??= await pluginAuths(ctx, t.pluginId))

  if (t.kind === 'action' && (a.triggerType || a.scheduleTimeOptions)) fail('triggerType and scheduleTimeOptions only apply to triggers.')
  const next: TriggerType = a.triggerType ?? current

  // Trigger type transitions mirror the editor's own payloads.
  if (t.kind === 'trigger' && next !== current) {
    payload.triggertype = next
    if (current === 'polling' && next === 'hook') {
      payload.modifytriggerdata = ''
      payload.removeScheduleTimeOptions = true
    }
    if (next === 'manual_webhook') {
      const list = await loadAuths()
      const noAuth = a.authId ? list.find((x) => x.rowid === a.authId) : list.find((x) => str(x.type) === 'NoAuth')
      if (!noAuth || str(noAuth.type) !== 'NoAuth') {
        fail('Manual webhook triggers need a NoAuth connection version. Create one with dh_update_auth_version {createNewVersion:true, type:"NoAuth"} and pass its authId.')
      }
      payload.removeScheduleTimeOptions = true
      payload.authid = str(noAuth.rowid)
      payload.authtype = 'NoAuth'
    }
    if (current === 'manual_webhook') {
      const plugin = a.authId ? undefined : await dhGetOne(ctx, 'plugins', 'getPluginDetails', t.pluginId, 'Plug')
      const authId = a.authId ?? str(plugin?.preferedauthversion)
      const auth = authId ? (await loadAuths()).find((x) => x.rowid === authId) : undefined
      if (!auth) fail('Pass authId: the connection version this trigger should use after leaving manual_webhook.')
      payload.authid = authId
      payload.authtype = str(auth.type)
    }
  }

  if (a.authId && payload.authid === undefined && a.authId !== str(v.authid)) {
    const auth = (await loadAuths()).find((x) => x.rowid === a.authId)
    if (!auth) fail(`Connection version ${a.authId} does not belong to plug ${t.pluginId}.`)
    if (next === 'manual_webhook' && str(auth.type) !== 'NoAuth') fail('Manual webhook triggers must use a NoAuth connection version.')
    payload.authid = a.authId
  }

  const visible = slidersFor(t.kind, next)
  for (const [slider, src] of Object.entries(a.code ?? {}) as [CodeSlider, string | undefined][]) {
    if (src === undefined) continue
    if (!visible.includes(slider)) {
      fail(`The ${slider} slider is not used by this ${t.kind === 'trigger' ? `${next} trigger` : 'action'}. Its sliders: ${visible.join(', ')}.`)
    }
    if (src !== (str(v[slider]) ?? '') || slider in payload) payload[slider] = src
  }

  const currentFields = inputFieldsOf(v)
  let fields: Row[] = currentFields
  if (a.inputFields) fields = a.mergeInputFields ? mergeFields(currentFields, a.inputFields) : a.inputFields.map((f) => ({ ...f }))
  else if (a.mergeInputFields) fail('mergeInputFields needs inputFields.')
  if (a.removeInputFields?.length) {
    const drop = new Set(a.removeInputFields)
    const unknown = a.removeInputFields.filter((k) => !fields.some((f) => f.key === k))
    if (unknown.length) fail(`No input field with key ${unknown.join(', ')}.`)
    fields = fields.filter((f) => !drop.has(String(f.key)))
  }
  const dups = duplicateKeys(fields)
  if (dups.length) fail(`Duplicate input field keys: ${dups.join(', ')}.`)
  // The server rebuilds inputjson.steps/blocks from inputFields.
  if (!sameJson(fields, currentFields)) payload.inputjson = { inputFields: fields }

  if (a.sampleDataJson !== undefined) {
    const sample = parseSampleData(a.sampleDataJson)
    if (!sameJson(sample, v.sampledata ?? null)) payload.sampledata = sample
  }

  if (a.scheduleTimeOptions) {
    if (next !== 'polling') fail('scheduleTimeOptions only applies to polling triggers.')
    const minutes = [...new Set(a.scheduleTimeOptions)].sort((x, y) => x - y)
    if (!sameJson(minutes, scheduleOf(v) ?? null)) payload.scheduleTimeOptions = minutes
  }

  const changed = Object.keys(payload).filter((k) => k !== 'removeScheduleTimeOptions' && k !== 'authtype')
  if (!changed.length) return { versionId: t.versionId, version: str(v.versionid), changed: [], message: 'Nothing to change: the values already match.' }
  if (JSON.stringify(payload).length > 1_800_000) fail('The update is too large (the API accepts at most 2 MB). Split it or shorten the code.')

  const fieldKeys = new Set(fields.map((f) => str(f.key)).filter((k): k is string => !!k))
  const written: Partial<Record<CodeSlider, string>> = {}
  for (const s of CODE_SLIDERS) if (typeof payload[s] === 'string') written[s] = payload[s] as string
  const warnings = codeWarnings(written, fieldKeys)

  const row = await dhUpdate(ctx, 'action_version', 'updateActionVersionDetails', t.versionId, payload)
  forgetDryRuns(t.versionId, Object.keys(written))
  const page = await syncVersion(ctx, v, payload, row)
  return {
    versionId: t.versionId,
    version: str(v.versionid),
    changed: changed.map((k) => FRIENDLY[k] ?? k),
    ...(warnings.length ? { warnings } : {}),
    ...(page ? { page } : {}),
    next: Object.keys(written).length ? `Test with dh_dry_run (slider: ${Object.keys(written)[0]}).` : undefined,
  }
}

export const ACTION_TOOLS: Tool<any>[] = [createAction, newActionVersion, updateActionVersion]
