// Write tools for actions/triggers and their versions, with the skill's payloads. Only drafted, unverified versions
// are ever edited; a published or verified version must be copied with dh_new_action_version first. Nothing here
// publishes.

import * as z from '../../../shared/zod'
import type { Tool, ToolContext } from '../types'
import { dhCreate, dhGet, dhGetOne, dhMerge, dhUpdate, fail, orgOf } from './api'
import { CREATED_BY, UPDATED_BY } from './constants'
import { P, dhTool, label, rowId } from './define'
import {
  CODE_SLIDERS, SCHEDULE_MINUTES, TRIGGER_TYPES, authVersionNumber, clip, flag, flattenFields, inputFieldsOf, jsonObj, liveVersions,
  lockReason, normalizeSampleValue, obj, rowsOf, sameJson, scheduleOf, slidersFor, str, triggerTypeOf, type CodeSlider, type Row,
  type TriggerType,
} from './rows'
import { checkFunctionCode } from '../flow/js-check'
import { forgetDryRuns } from './dry-run-log'
import { actionCreatedHere, markActionCreated, markVersionMerged, versionMerged } from './session'
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
const GENERATOR_KEYS = ['optionsGenerator', 'fieldsGenerator', 'source', 'suggestionGenerator'] as const
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

/** Skill: no authored steps/blocks/dependsOn and no functionId; the server derives them from inputFields. */
const AUTHORED_FIELD_KEYS = ['dependsOn', 'steps', 'blocks', 'functionId'] as const

/** Copies incoming fields without the authored keys (children/fields included) and reports what was dropped. */
function stripAuthoredKeys(fields: InputFieldArg[], dropped: Set<string>, depth = 0): InputFieldArg[] {
  return fields.map((f) => {
    const out: InputFieldArg = { ...f }
    for (const k of AUTHORED_FIELD_KEYS) {
      if (k in out) {
        delete out[k]
        dropped.add(`${f.key}.${k}`)
      }
    }
    if (depth < 6) {
      if (Array.isArray(f.children)) out.children = stripAuthoredKeys(f.children, dropped, depth + 1)
      if (Array.isArray(f.fields)) out.fields = stripAuthoredKeys(f.fields, dropped, depth + 1)
    }
    return out
  })
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

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

function keyFromName(name: string): string {
  const k = name.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Za-z]/.test(k) ? k.slice(0, 80) : `A_${k}`.slice(0, 80)
}

interface AiMergeResult {
  /** The MERGE went through (or the user chose to leave isaiaction off); false means retry later. */
  done: boolean
  warning?: string
  note?: string
}

/**
 * The skill's action MERGE (isaiaction, aiorgid, a note, + name/description when they change). The backend's AI-action
 * job later makes published, still-private actions with isaiaction:true public once their success rate is high, so
 * isaiaction is only set without asking on an action created in this session, one already marked, or one that is not
 * published. On a published action the user decides; declining keeps isaiaction off and logs the note only.
 */
async function aiActionMerge(
  ctx: ToolContext,
  actionId: string,
  action: Row | undefined,
  by: typeof CREATED_BY | typeof UPDATED_BY,
  note: string,
  extra: Row = {},
): Promise<AiMergeResult> {
  let mark = true
  let declinedNote: string | undefined
  const createdHere = actionCreatedHere(ctx, actionId)
  if (!createdHere && action && !flag(action.isaiaction) && str(action.status) === 'published') {
    const isPublic = flag(action.isvisible)
    const ok = await ctx.ui.confirm(
      `Mark "${clip(str(action.name) ?? actionId, 40)}" as AI-built?`,
      `The skill marks actions it works on as AI-built (isaiaction). This action is already published ` +
        `(${isPublic ? 'public' : 'private to your org'}). viaSocket periodically makes published AI-built actions that are ` +
        'still private PUBLIC automatically once their success rate is high, and shows them with a beta badge. ' +
        'Leave it unmarked to keep its visibility under your control; the draft change is saved either way.',
      true,
      'Mark as AI-built',
    )
    ctx.signal.throwIfAborted()
    if (!ok) {
      mark = false
      declinedNote = 'Left unmarked as AI-built (isaiaction) at the user\'s choice; only the change note was logged.'
    }
  }
  const changes: Row = { ...(mark ? { isaiaction: true, aiorgid: orgOf(ctx) } : {}), ...extra }
  try {
    await dhMerge(ctx, 'actions', actionId, changes, { by, note })
    return { done: true, ...(declinedNote ? { note: declinedNote } : {}) }
  } catch (e) {
    return {
      done: false,
      warning: `The action update (${mark ? 'isaiaction, ' : ''}${Object.keys(extra).length ? `${Object.keys(extra).join(', ')}, ` : ''}change note) failed (${(e as Error).message}). Any later dh_update_action_version on this version retries it.`,
    }
  }
}

const createAction = dhTool({
  name: 'dh_create_action',
  description:
    "Create a new action or trigger on a plug with the skill's payload; viaSocket creates its first version V1 as an " +
    'editable draft (nothing is published; it stays private until dh_publish_action_version). Returns actionId and ' +
    'versionId. Reuse field keys exactly as other actions of the plug write them. If one with the same name or key ' +
    'exists, it is returned instead. Next: dh_update_action_version (code, input fields, sample data), dh_map_component, ' +
    'dh_dry_run.',
  properties: {
    pluginId: P.pluginId,
    type: { type: 'string', enum: ['action', 'trigger'] },
    name: { type: 'string', description: 'Short verb phrase users will see, e.g. "Create Record" or "New Row".' },
    description: { type: 'string', description: 'One sentence describing what it does (required to publish).' },
    key: { type: 'string', description: 'Identifier per the KB, e.g. "Create_Record". Default: the name with "_" for spaces. Never renamed later.' },
    triggerType: {
      type: 'string',
      enum: [...TRIGGER_TYPES],
      description: 'Triggers only: hook (instant webhook), polling (scheduled), manual_webhook (user pastes a URL). Default hook.',
    },
    authId: { ...P.authId, description: "Connection version. Default: the plug's default, else its first one. Manual triggers use none (or NoAuth)." },
    category: { type: 'string', description: 'Category per the KB, e.g. "CREATE".' },
    subCategory: { type: 'string', description: 'Entity per the KB, e.g. "RECORD".' },
    preferredStepName: { type: 'string', description: 'Default step name in flows.' },
  },
  required: ['type', 'name', 'description'],
  danger: 'write',
  schema: z.object({
    pluginId: rowId.optional(),
    type: z.enum(['action', 'trigger']),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(5).max(1000),
    key: z.string().trim().regex(KEY_RE, 'must be an identifier like Create_Record').optional(),
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
    if (str(plugin.status) === 'deleted') fail(`Plug ${pluginId} is deleted.`)
    const key = a.key ?? keyFromName(a.name)
    const live = actions.filter((x) => str(x.status) !== 'deleted')
    const existing = live.find(
      (x) => str(x.type) === a.type && (str(x.name)?.trim().toLowerCase() === a.name.toLowerCase() || str(x.key)?.toLowerCase() === key.toLowerCase()),
    )
    if (existing) {
      return { alreadyExists: true, actionId: str(existing.rowid), name: str(existing.name), key: str(existing.key), type: a.type, tip: 'Read it with dh_get_action_version and update a draft version.' }
    }

    const triggerType: TriggerType | undefined = a.type === 'trigger' ? (a.triggerType ?? 'hook') : undefined
    let authId = a.authId
    const notes: string[] = []
    if (triggerType === 'manual_webhook') {
      // Skill: manual triggers have no authid. The editor and publishing still expect the plug's NoAuth version when
      // there is one, so that one is used; otherwise none is sent.
      const noAuth = auths.find((x) => str(x.type) === 'NoAuth')
      if (authId && str(auths.find((x) => x.rowid === authId)?.type) !== 'NoAuth') fail('Manual webhook triggers use no connection (or a NoAuth one).')
      authId ??= str(noAuth?.rowid)
      if (!authId) notes.push('No connection set (manual trigger). Publishing needs a NoAuth connection version: create one with dh_create_connection type NoAuth and set it with dh_update_action_version authId.')
    } else {
      authId ??= str(plugin.preferedauthversion) ?? str(sortedByVersion(auths)[0]?.rowid)
      if (!authId) fail('This plug has no connection version yet. Create one with dh_create_connection first.')
      const auth = auths.find((x) => x.rowid === authId)
      if (!auth) fail(`Connection version ${authId} does not belong to plug ${pluginId}.`)
    }

    const body: Row = {
      name: a.name,
      description: a.description,
      key,
      pluginrecordid: pluginId,
      type: a.type,
      ...(authId ? { authid: authId } : {}),
      isvisible: true,
      ...(a.category ? { category: a.category.toUpperCase().replace(/\s+/g, '_') } : {}),
      ...(a.subCategory ? { sub_category: a.subCategory.toUpperCase().replace(/\s+/g, '_') } : {}),
      preferred_step_name: a.preferredStepName ?? '',
      ignoreuniversalsampledata: false,
      ...(triggerType ? { triggertype: triggerType } : {}),
    }
    const { rows, data } = await dhCreate(ctx, 'actions', body)
    const actionRow = rows[0]
    const actionId = str(actionRow?.rowid)
    if (!actionRow || !actionId) fail('viaSocket did not return the new action id. Check dh_list_actions before retrying (it may exist already).')
    markActionCreated(ctx, actionId)
    let versionId = str(rowsOf(obj(data.actionVersionData)?.data)[0]?.rowid)
    if (!versionId) versionId = str(liveVersions(await dhGet(ctx, 'action_version', 'getActionVersions', actionId)).at(-1)?.rowid)
    // dh.mjs: create/actions, then MERGE isaiaction. A failed MERGE is retried by the next draft update of the version.
    const merge = await aiActionMerge(ctx, actionId, actionRow, CREATED_BY, 'isaiaction set')
    const warning = merge.warning
    if (versionId && merge.done) markVersionMerged(ctx, versionId)
    const page = await syncActionRow(ctx, pluginId, actionRow)
    return {
      actionId,
      versionId,
      version: 'V1',
      type: a.type,
      key,
      ...(triggerType ? { triggerType, sliders: slidersFor('trigger', triggerType) } : { sliders: ['perform'] }),
      ...(notes.length ? { notes } : {}),
      ...(warning ? { warning } : {}),
      ...(versionId ? { open: editorOpen(pluginId, a.type, actionId, versionId) } : {}),
      ...(page ? { page } : {}),
      next: 'Fill the version with dh_update_action_version (versionId): code, inputFields, sampleDataJson. errorComponent is mapped automatically.',
    }
  },
})

function sortedByVersion(auths: Row[]): Row[] {
  return auths.slice().sort((x, y) => authVersionNumber(x) - authVersionNumber(y))
}

// ---------- dh_new_action_version ----------

// dh.mjs COPY: the source row minus DB-managed keys, as a drafted version under the same action with
// metadata.duplicatedfrom. Only real action_version columns are copied (the skill's column list plus scopes and
// response settings): GET rows also carry joined columns (name, pluginrecordid, authtype, …) that create rejects or
// stores. 'type' and verificationstatus are left to the server, as the editor does.
const VERSION_COPY_KEYS = [
  'authid', 'triggertype', ...CODE_SLIDERS, 'inputjson', 'sampledata', 'description', 'category', 'sub_category',
  'canpaginate', 'preferred_step_name', 'scopes', 'service_response_type', 'universalsampledata', 'ignoreuniversalsampledata',
] as const

const newActionVersion = dhTool({
  name: 'dh_new_action_version',
  description:
    "Create a new editable draft of an action/trigger by COPYING a version (skill: default the latest non-deleted one): " +
    'code, input fields, sample data, trigger type, polling intervals and connection version. Required before changing a ' +
    'published or verified version. Component mappings are NOT copied: the result lists them; map each again with ' +
    'dh_map_component. Returns the new versionId.',
  properties: {
    actionId: P.actionId,
    sourceVersionId: { type: 'string', description: 'Version row id to copy. Default: the latest non-deleted version.' },
  },
  danger: 'write',
  schema: z.object({ actionId: rowId.optional(), sourceVersionId: rowId.optional() }),
  describe: () => 'Creating a new draft version',
  async run(a, ctx) {
    const t0 = await resolveVersionTarget(ctx, { actionId: a.actionId, versionId: a.sourceVersionId })
    const src = a.sourceVersionId ? t0.version : t0.latest
    const srcId = String(src.rowid)
    const body: Row = { actionid: t0.actionId, status: 'drafted' }
    for (const k of VERSION_COPY_KEYS) {
      const v = src[k]
      if (v !== undefined && v !== null) body[k] = v
    }
    if (body.sampledata !== undefined) body.sampledata = normalizeSampleValue(body.sampledata)
    const inputjson = obj(src.inputjson)
    if (inputjson) body.inputjson = { steps: obj(inputjson.steps) ?? {}, blocks: obj(inputjson.blocks) ?? {}, inputFields: rowsOf(inputjson.inputFields) }
    const schedule = scheduleOf(src)
    body.metadata = {
      duplicatedfrom: { rowid: srcId, versionid: str(src.versionid) },
      ...(schedule ? { scheduleTimeOptions: schedule } : {}),
    }

    const { rows } = await dhCreate(ctx, 'action_version', body)
    const created = rows[0]
    const newId = str(created?.rowid)
    if (!created || !newId) fail('viaSocket did not return the new version id. Check dh_get_action_version before retrying.')

    const notes: string[] = []
    // Skill: "a copy has no blocks" → PUT its full version fields once, which makes the server rebuild steps/blocks.
    const fields = inputFieldsOf(src)
    const refill: Row = {}
    if (fields.length) refill.inputjson = { inputFields: fields }
    if (schedule) refill.scheduleTimeOptions = schedule
    if (Object.keys(refill).length) {
      try {
        await dhUpdate(ctx, 'action_version', 'updateActionVersionDetails', newId, refill)
      } catch (e) {
        notes.push(`The input fields could not be re-saved on the copy (${(e as Error).message}); save them with dh_update_action_version.`)
      }
    }
    const merge = await aiActionMerge(ctx, t0.actionId, t0.action, UPDATED_BY, 'new draft version')
    const warning = merge.warning
    if (merge.done) markVersionMerged(ctx, newId)
    if (merge.note) notes.push(merge.note)

    let mappingsToRecreate: Row[] = []
    try {
      const [mappings, components] = await Promise.all([
        dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', srcId),
        dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', t0.pluginId),
      ])
      const names = new Map(components.map((c) => [str(c.rowid), str(c.function_name)]))
      mappingsToRecreate = mappings
        .filter((m) => str(m.component_id))
        .map((m) => ({
          component: names.get(str(m.component_id)) ?? str(m.component_id),
          dependsOn: Object.keys(obj(jsonObj(m.metadata).componentdependson) ?? {}),
        }))
    } catch {
      notes.push('Could not read the source mappings; check them with dh_list_components.')
    }
    const drafts = t0.versions.filter((v) => v !== src && !lockReason(v, t0.action))
    if (drafts.length) notes.push(`Other editable drafts already exist: ${drafts.map((d) => str(d.versionid)).join(', ')}.`)

    return {
      versionId: newId,
      version: str(created.versionid),
      copiedFrom: { versionId: srcId, version: str(src.versionid) },
      mappingsCopied: false,
      ...(mappingsToRecreate.length ? { mappingsToRecreate } : {}),
      ...(notes.length ? { notes } : {}),
      ...(warning ? { warning } : {}),
      open: editorOpen(t0.pluginId, t0.kind, t0.actionId, newId),
      next: mappingsToRecreate.length
        ? 'Map each listed component on the new version with dh_map_component (versionId), then edit it with dh_update_action_version.'
        : 'Edit it with dh_update_action_version (versionId).',
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
  description: z.string().trim().min(1).max(1000).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  subCategory: z.string().trim().min(1).max(60).optional(),
  actionName: z.string().trim().min(2).max(80).optional(),
  actionDescription: z.string().trim().min(5).max(1000).optional(),
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
  sub_category: 'sub category',
}

const updateActionVersion = dhTool({
  name: 'dh_update_action_version',
  description:
    "Fill or edit a DRAFT action/trigger version with the skill's Version payload (saved immediately; nothing is " +
    'published): slider code, input fields, sample data, description, category, connection; for triggers the trigger ' +
    'type, and every slider of that type is kept present ("" when unused). Refuses published, verified or live versions: ' +
    'call dh_new_action_version first. Only send what changes; everything omitted is kept. Follow perform-code.md and ' +
    'dh-Input-fields-json-builder.md (dh_kb); never author steps/blocks/dependsOn/functionId in input fields. ' +
    'actionName/actionDescription change the action itself (not on a published action). Set sample data before publishing.',
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
    description: { type: 'string', description: 'Version description (what it does).' },
    category: { type: 'string', description: 'Category per the KB, e.g. "CREATE".' },
    subCategory: { type: 'string', description: 'Entity per the KB, e.g. "RECORD".' },
    actionName: {
      type: 'string',
      description: 'Rename the action/trigger users see (the key never changes). Not on a published action.',
    },
    actionDescription: { type: 'string', description: 'New action/trigger description users see. Not on a published action.' },
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
      ...(a.description || a.category || a.subCategory || a.actionName || a.actionDescription ? ['details'] : []),
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
        fail('Manual webhook triggers need a NoAuth connection version. Create one with dh_create_connection {type:"NoAuth"} and pass its authId.')
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
  const strippedKeys = new Set<string>()
  const incoming = a.inputFields ? stripAuthoredKeys(a.inputFields, strippedKeys) : undefined
  if (incoming) fields = a.mergeInputFields ? mergeFields(currentFields, incoming) : incoming.map((f) => ({ ...f }))
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
  if (a.description !== undefined && a.description !== str(v.description)) payload.description = a.description
  const category = a.category?.toUpperCase().replace(/\s+/g, '_')
  if (category !== undefined && category !== str(v.category)) payload.category = category
  const subCategory = a.subCategory?.toUpperCase().replace(/\s+/g, '_')
  if (subCategory !== undefined && subCategory !== str(v.sub_category)) payload.sub_category = subCategory

  // Skill: the action MERGE carries name/description when they change (never the key). The action row is live on a
  // published action, so those are changed only while it is unpublished.
  const actionChanges: Row = {}
  if (a.actionName !== undefined && a.actionName !== str(t.action.name)) actionChanges.name = a.actionName
  if (a.actionDescription !== undefined && a.actionDescription !== str(t.action.description)) actionChanges.description = a.actionDescription
  if (Object.keys(actionChanges).length && str(t.action.status) === 'published') {
    fail('This action is published: its name and description are live. Ask the user to change them in the Developer Hub (the key never changes).')
  }

  const changed = Object.keys(payload).filter((k) => k !== 'removeScheduleTimeOptions' && k !== 'authtype')
  if (!changed.length && !Object.keys(actionChanges).length) {
    return { versionId: t.versionId, version: str(v.versionid), changed: [], message: 'Nothing to change: the values already match.' }
  }
  if (JSON.stringify(payload).length > 1_800_000) fail('The update is too large (the API accepts at most 2 MB). Split it or shorten the code.')

  // dh.mjs syntax-checks every write; MV3 cannot compile JS, so this is a structural check of code and generators.
  for (const s of CODE_SLIDERS) {
    const src = payload[s]
    if (typeof src !== 'string' || !src.trim()) continue
    const r = checkFunctionCode(src)
    if (r.error) fail(`${s}: ${r.error}`)
  }
  if (payload.inputjson) {
    for (const f of flattenFields(fields)) {
      for (const g of GENERATOR_KEYS) {
        const src = f[g]
        if (typeof src !== 'string' || !src.trim()) continue
        const r = checkFunctionCode(src)
        if (r.error) fail(`${str(f.key) ?? 'field'}.${g}: ${r.error}`)
      }
    }
  }
  // Skill: triggers carry every block key of their type ("" if unused).
  if (t.kind === 'trigger' && (payload.triggertype !== undefined || CODE_SLIDERS.some((s) => s in payload))) {
    for (const s of slidersFor('trigger', next)) if (!(s in payload) && (v[s] === null || v[s] === undefined)) payload[s] = ''
  }

  const fieldKeys = new Set(fields.map((f) => str(f.key)).filter((k): k is string => !!k))
  const written: Partial<Record<CodeSlider, string>> = {}
  for (const s of CODE_SLIDERS) if (typeof payload[s] === 'string') written[s] = payload[s] as string
  const warnings = codeWarnings(written, fieldKeys)
  if (strippedKeys.size) {
    warnings.push(`Removed authored ${[...strippedKeys].slice(0, 8).join(', ')}: viaSocket derives steps, blocks and dependencies from the input fields (skill).`)
  }

  const row = changed.length ? await dhUpdate(ctx, 'action_version', 'updateActionVersionDetails', t.versionId, payload) : undefined
  forgetDryRuns(t.versionId, Object.keys(written))
  // Skill: after a draft update, MERGE the action (isaiaction, aiorgid, note, + name/description); the isaiaction part
  // once per version per session, retried after a failure.
  const notes: string[] = []
  if (!versionMerged(ctx, t.versionId) || Object.keys(actionChanges).length) {
    const merge = await aiActionMerge(ctx, t.actionId, t.action, UPDATED_BY, 'draft updated', actionChanges)
    if (merge.warning) warnings.push(merge.warning)
    if (merge.note) notes.push(merge.note)
    if (merge.done) markVersionMerged(ctx, t.versionId)
  }
  const page = changed.length ? await syncVersion(ctx, v, payload, row) : undefined
  const actionRowSync = Object.keys(actionChanges).length ? await syncActionRow(ctx, t.pluginId, { ...t.action, ...actionChanges }) : undefined
  return {
    versionId: t.versionId,
    version: str(v.versionid),
    changed: [...changed.map((k) => FRIENDLY[k] ?? k), ...Object.keys(actionChanges).map((k) => `action ${k}`)],
    ...(warnings.length ? { warnings } : {}),
    ...(notes.length ? { notes } : {}),
    ...(page ?? actionRowSync ? { page: page ?? actionRowSync } : {}),
    next: Object.keys(written).length ? `Test with dh_dry_run (slider: ${Object.keys(written)[0]}).` : undefined,
  }
}

export const ACTION_TOOLS: Tool<any>[] = [createAction, newActionVersion, updateActionVersion]
