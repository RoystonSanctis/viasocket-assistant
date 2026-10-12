// Reusable components and their mappings, per the skill: components exist only for dynamic dropdowns/multiselects
// (optionsGenerator) and dynamic input groups (fieldsGenerator); they are not versioned, so a mapped one is never
// edited (a new name is added instead). Mappings are never changed on a published version.

import * as z from '../../../shared/zod'
import type { Tool } from '../types'
import { checkFunctionCode } from '../flow/js-check'
import { dhCreate, dhGet, dhUpdate, fail, orgOf } from './api'
import { readOnlyReasons } from './code-safety'
import { P, dhTool, label, rowId } from './define'
import { CODE_SLIDERS, flattenFields, inputFieldsOf, jsonObj, lockReason, obj, str, type Row } from './rows'
import { markMappingChanged } from './session'
import { syncMapping } from './sync'
import { requirePluginId, resolveVersionTarget } from './target'

const IDENT = /^[A-Za-z_$][\w$]{0,63}$/
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
  'async', 'context', 'axios', 'fetch', 'undefined', 'arguments', 'eval', 'errorComponent',
])
const identifier = z
  .string()
  .trim()
  .regex(IDENT, 'must be a JavaScript identifier')
  .refine((s) => !RESERVED.has(s), 'is a reserved or built-in name')

/** function_code = `async function <name>(<params>) {\n<code indented 2>\n}` (skill Component payload). */
function functionCode(name: string, params: string[], code: string): string {
  const body = code
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join('\n')
  return `async function ${name}(${params.join(', ')}) {\n${body}\n}`
}

// ---------- dh_create_component ----------

const createComponent = dhTool({
  name: 'dh_create_component',
  description:
    'Create a reusable component (a helper function prepended to the code of every version it is mapped to) ONLY to back ' +
    'a dynamic dropdown/multiselect (optionsGenerator) or a dynamic input group (fieldsGenerator). Never for API requests ' +
    'of actions/triggers (they call axios directly). The code must only read (GET). Refuses a name that already exists: ' +
    'components are not versioned, so never change a mapped one; add a new name. Then map it with dh_map_component.',
  properties: {
    pluginId: P.pluginId,
    name: { type: 'string', description: 'Function name, e.g. "getTables". Must be new on this plug.' },
    params: {
      type: 'array',
      description: 'Function parameters with a sample value each.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, sample: { type: 'string', description: 'Example value as JS, e.g. "\'bse123\'".' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    code: {
      type: 'string',
      description: 'Function body (async; may use axios, context.authData, context.inputData and the params) that returns the data.',
    },
    description: { type: 'string', description: 'What it returns and which field uses it.' },
    usedFor: { type: 'string', enum: ['optionsGenerator', 'fieldsGenerator'], description: 'The kind of dynamic field it backs.' },
  },
  required: ['name', 'code', 'description', 'usedFor'],
  danger: 'write',
  schema: z.object({
    pluginId: rowId.optional(),
    name: identifier,
    params: z.array(z.object({ name: identifier, sample: z.string().max(500).optional() })).max(10).optional(),
    code: z.string().min(1).max(50_000),
    description: z.string().trim().min(5).max(500),
    usedFor: z.enum(['optionsGenerator', 'fieldsGenerator']),
  }),
  describe: (a) => `Creating component ${label(a.name)}`,
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    const check = checkFunctionCode(a.code)
    if (check.error) fail(`code: ${check.error}`)
    if (check.warning) fail('code must return the data the field needs.')
    // Allowlist: every call must be a recognised literal GET (axios.get, fetch with method 'GET', axios({method:'get'})).
    const writes = readOnlyReasons(a.code)
    if (writes.length) fail(`Components back dynamic fields and must only read (GET); this code ${writes.slice(0, 4).join('; ')}.`)
    const params = a.params ?? []
    if (new Set(params.map((p) => p.name)).size !== params.length) fail('Parameter names must be unique.')

    const existing = await dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', pluginId)
    const clash = existing.find((c) => str(c.function_name)?.toLowerCase() === a.name.toLowerCase())
    if (clash) {
      fail(`A component named ${str(clash.function_name)} already exists on this plug (components are not versioned; never change a mapped one). Pick a new name.`)
    }
    const body: Row = {
      pluginrecordid: pluginId,
      orgid: orgOf(ctx),
      function_name: a.name,
      params: params.map((p) => ({ name: p.name, sample: p.sample ?? '' })),
      code: a.code,
      function_code: functionCode(a.name, params.map((p) => p.name), a.code),
      description: a.description,
      componentgenerationsource: 'userGenerated',
    }
    const { rows } = await dhCreate(ctx, 'reusable_components', body)
    const id = str(rows[0]?.rowid)
    if (!id) fail('viaSocket did not return the new component id. Check dh_list_components before retrying.')
    return {
      componentId: id,
      name: a.name,
      usedFor: a.usedFor,
      next: `Map it with dh_map_component on each draft version whose ${a.usedFor} calls it (dependsOn: that field's key).`,
    }
  },
})

// ---------- dh_map_component ----------

const mapComponent = dhTool({
  name: 'dh_map_component',
  description:
    'Map a reusable component to a DRAFT action/trigger version (skill Mapping rules) so its code is available there: every ' +
    'component the version\'s code or dynamic fields call, plus errorComponent. dependsOn lists where it is used: slider ' +
    'names (e.g. "perform") and/or dynamic field keys (never a group path). An existing mapping is updated with the full ' +
    'list (keys are added, none removed). Refuses published or verified versions. Copied versions have no mappings: map ' +
    'them again.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    component: { type: 'string', description: 'Component function name (e.g. "getTables") or its row id.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Slider names and/or input field keys that use it, e.g. ["perform","table"].' },
  },
  required: ['component', 'dependsOn'],
  danger: 'write',
  schema: z.object({
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    component: z.string().trim().min(1).max(80),
    dependsOn: z
      .array(z.string().trim().regex(/^[A-Za-z_$][\w$-]{0,79}$/, 'must be a slider name or a field key (no group paths)'))
      .min(1)
      .max(20)
      // A repeated key would be toggled on and then off again by the server's path fallback.
      .transform((keys) => [...new Set(keys)]),
  }),
  describe: (a) => `Mapping ${label(a.component)}`,
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, a)
    const lock = lockReason(t.version, t.action)
    if (lock) fail(`${str(t.version.versionid) ?? 'This version'} cannot change mappings because ${lock}. Create a draft with dh_new_action_version.`)

    const fieldKeys = new Set(flattenFields(inputFieldsOf(t.version)).map((f) => str(f.key)).filter((k): k is string => !!k))
    const unknown = a.dependsOn.filter((k) => !(CODE_SLIDERS as readonly string[]).includes(k) && !fieldKeys.has(k))
    if (unknown.length) {
      fail(`dependsOn ${unknown.join(', ')} is neither a slider nor an input field key of this version. Fields: ${[...fieldKeys].slice(0, 30).join(', ') || 'none'}.`)
    }

    const [components, mappings] = await Promise.all([
      dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', t.pluginId),
      dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', t.versionId),
    ])
    const c = components.find((x) => str(x.function_name) === a.component || x.rowid === a.component)
    if (!c) fail(`No component "${a.component}" on this plug. Available: ${components.map((x) => str(x.function_name)).filter(Boolean).join(', ') || 'none'}.`)
    const componentId = String(c.rowid)
    const name = str(c.function_name) ?? componentId
    const existing = mappings.find((m) => str(m.component_id) === componentId)
    const current = obj(jsonObj(existing?.metadata).componentdependson) ?? {}
    const desired: Row = { ...current }
    for (const k of a.dependsOn) desired[k] = true

    if (!existing) {
      const body: Row = {
        action_version_id: t.versionId,
        component_id: componentId,
        action_id: t.actionId,
        pluginrecordid: t.pluginId,
        orgid: orgOf(ctx),
        metadata: { componentdependson: desired },
      }
      const { rows } = await dhCreate(ctx, 'action_version_component_table', body)
      markMappingChanged(ctx, t.versionId)
      const row = rows[0]
      const page = row ? await syncMapping(ctx, t.version, row, true) : undefined
      return { mapped: true, created: true, versionId: t.versionId, component: name, dependsOn: Object.keys(desired), ...(page ? { page } : {}) }
    }

    // Any truthy stored value counts as present ("true" strings included): the server's path toggle would REMOVE it.
    const missing = a.dependsOn.filter((k) => !current[k])
    if (!missing.length) return { mapped: true, versionId: t.versionId, component: name, dependsOn: Object.keys(current), message: 'Already mapped there.' }
    const mappingId = str(existing.rowid)
    if (!mappingId) fail('The existing mapping has no id; map it in the editor.')

    // Skill: PUT the full metadata. The server may keep its stored metadata instead; then each missing key is added
    // with the path toggle (it adds a key that is absent), after re-reading so nothing is toggled off.
    await dhUpdate(ctx, 'action_version_component_table', 'dhUpdateReusableComponentDetails', mappingId, { metadata: { componentdependson: desired } })
    const readBack = async () =>
      (await dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', t.versionId)).find(
        (m) => str(m.component_id) === componentId,
      )
    let row = await readBack()
    let deps = obj(jsonObj(row?.metadata).componentdependson) ?? {}
    let fallback = false
    for (const k of a.dependsOn.filter((x) => !deps[x])) {
      fallback = true
      await dhUpdate(ctx, 'action_version_component_table', 'dhUpdateReusableComponentDetails', mappingId, { path: k })
    }
    if (fallback) {
      row = await readBack()
      deps = obj(jsonObj(row?.metadata).componentdependson) ?? {}
    }
    markMappingChanged(ctx, t.versionId)
    const stillMissing = a.dependsOn.filter((k) => !deps[k])
    const page = row ? await syncMapping(ctx, t.version, row, false) : undefined
    return {
      mapped: true,
      updated: true,
      versionId: t.versionId,
      component: name,
      dependsOn: Object.keys(deps).filter((k) => !!deps[k]),
      ...(fallback ? { note: 'The server kept its stored mapping metadata, so each missing key was added one by one.' } : {}),
      ...(stillMissing.length ? { warning: `Could not add ${stillMissing.join(', ')}; map them in the editor.` } : {}),
      ...(page ? { page } : {}),
    }
  },
})

export const COMPONENT_TOOLS: Tool<any>[] = [createComponent, mapComponent]
