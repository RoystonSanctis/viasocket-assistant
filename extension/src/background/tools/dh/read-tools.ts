// Read-only tools for actions/triggers, their versions and reusable components. Results are compacted for the
// model: code is truncated in overviews, with a parameter to fetch one part in full.

import * as z from '../../../shared/zod'
import type { Tool, ToolContext } from '../types'
import { dhGet } from './api'
import { P, dhTool, rowId } from './define'
import { actionSummary } from './plugin-tools'
import {
  CODE_SLIDERS, clip, clipJson, fitJson, flag, inputFieldsOf, lockReason, obj, rowsOf, scheduleOf, slidersFor, str,
  triggerTypeOf, type CodeSlider, type Row,
} from './rows'
import { editorOpen, openEditorVersionId, requirePluginId, resolveVersionTarget, type VersionTarget } from './target'

const FULL_PARTS = [...CODE_SLIDERS, 'inputFields', 'sampleData'] as const

function fullBudget(ctx: ToolContext): number {
  return Math.max(2000, ctx.maxResultChars - 800)
}

function fieldOutline(f: Row): Row {
  const nested = rowsOf(f.children).length || rowsOf(f.fields).length
  return {
    key: str(f.key),
    label: str(f.label),
    type: str(f.type),
    required: f.required === true || undefined,
    dynamic: ['optionsGenerator', 'fieldsGenerator', 'suggestionGenerator', 'source'].some((k) => !!str(f[k])) || undefined,
    nestedFields: nested || undefined,
  }
}

function versionLine(t: VersionTarget, v: Row, openId: string | undefined) {
  return {
    id: str(v.rowid),
    version: str(v.versionid),
    status: str(v.status),
    verification: str(v.verificationstatus),
    createdAt: str(v.createdat),
    isPublished: v.rowid === str(t.action.actionversionrecordid) || undefined,
    isOpenInEditor: v.rowid === openId || undefined,
    isLatest: v === t.latest || undefined,
  }
}

const listActions = dhTool({
  name: 'dh_list_actions',
  description:
    "List a plug's actions and triggers (defaults to the open plug): id, type, status, public/private, the published version id " +
    'and the connection version it uses. Use dh_get_action_version to read one.',
  properties: {
    pluginId: P.pluginId,
    type: { type: 'string', enum: ['action', 'trigger'], description: 'Only actions or only triggers. Omit for both.' },
  },
  danger: 'safe',
  schema: z.object({ pluginId: rowId.optional(), type: z.enum(['action', 'trigger']).optional() }),
  describe: (a) => (a.type === 'trigger' ? 'Listing triggers' : a.type === 'action' ? 'Listing actions' : 'Listing actions and triggers'),
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    const rows = (await dhGet(ctx, 'actions', 'getAllActions', pluginId)).filter((r) => !a.type || str(r.type) === a.type)
    return {
      pluginId,
      count: rows.length,
      items: rows.map((r) => actionSummary(r)),
      open: 'To show one, call ui_navigate {to:"dh-section", pluginId, sectionKey: its type, sectionId: its id}.',
    }
  },
})

const getActionVersion = dhTool({
  name: 'dh_get_action_version',
  description:
    'Read one version of an action/trigger: status and whether it is editable, trigger type, connection version, polling ' +
    'intervals, input fields, sample data and the code of each slider (truncated), plus the list of all versions. Defaults to ' +
    'the version open in the editor, else the latest. Pass `full` to get one slider\'s code, the input fields or the sample data in full.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    full: {
      type: 'string',
      enum: [...FULL_PARTS],
      description: 'Return only this part, untruncated: a slider name, "inputFields" or "sampleData".',
    },
  },
  danger: 'safe',
  schema: z.object({ actionId: rowId.optional(), versionId: rowId.optional(), full: z.enum(FULL_PARTS).optional() }),
  describe: (a) => (a.full ? `Reading ${a.full}` : 'Reading the action version'),
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, a)
    const v = t.version
    const versionTag = str(v.versionid)

    if (a.full) {
      const budget = fullBudget(ctx)
      if (a.full === 'inputFields') return { versionId: t.versionId, version: versionTag, inputFields: fitJson(inputFieldsOf(v), budget) }
      if (a.full === 'sampleData') return { versionId: t.versionId, version: versionTag, sampleData: fitJson(v.sampledata, budget) }
      const code = str(v[a.full]) ?? ''
      return { versionId: t.versionId, version: versionTag, slider: a.full, chars: code.length, code: clip(code, budget) }
    }

    const triggerType = triggerTypeOf(v)
    const visible = slidersFor(t.kind, triggerType)
    const shown = CODE_SLIDERS.filter((s) => visible.includes(s) || !!str(v[s])?.trim())
    const perSlider = Math.min(2000, Math.max(300, Math.floor((ctx.maxResultChars * 0.45) / Math.max(1, shown.length))))
    const code: Partial<Record<CodeSlider, Row>> = {}
    for (const s of shown) {
      const src = str(v[s]) ?? ''
      code[s] = {
        code: clip(src, perSlider),
        chars: src.length,
        ...(src.length > perSlider ? { truncated: true } : {}),
        ...(visible.includes(s) ? {} : { hiddenForThisType: true }),
      }
    }
    const fields = inputFieldsOf(v)
    const fieldsBudget = Math.floor(ctx.maxResultChars * 0.2)
    const fieldsJson = JSON.stringify(fields)
    const lock = lockReason(v, t.action)
    const openId = openEditorVersionId(ctx)

    return {
      action: {
        id: t.actionId,
        name: str(t.action.name),
        type: t.kind,
        status: str(t.action.status),
        visibility: flag(t.action.isvisible) ? 'public' : 'private',
        pluginId: t.pluginId,
        publishedVersionId: str(t.action.actionversionrecordid),
        description: clip(str(t.action.description) ?? '', 300) || undefined,
      },
      version: {
        id: t.versionId,
        version: versionTag,
        status: str(v.status),
        verification: str(v.verificationstatus),
        editable: !lock,
        ...(lock ? { lockedBecause: lock, toEdit: 'Call dh_new_action_version to create an editable copy.' } : {}),
        ...(t.kind === 'trigger' ? { triggerType, scheduleMinutes: scheduleOf(v) } : {}),
        authId: str(v.authid),
        authType: str(v.authtype),
        sliders: visible,
        code,
        inputFields:
          fieldsJson.length <= fieldsBudget
            ? fields
            : { outline: fields.map(fieldOutline), note: 'Truncated. Use full:"inputFields" for the complete definitions.' },
        sampleData: v.sampledata == null ? null : clipJson(v.sampledata, 600),
        isLatest: v === t.latest,
      },
      versions: t.versions.slice(-15).map((x) => versionLine(t, x, openId)),
      open: editorOpen(t.pluginId, t.kind, t.actionId, t.versionId),
    }
  },
})

const listComponents = dhTool({
  name: 'dh_list_components',
  description:
    "List a plug's reusable components (helper functions such as errorComponent or getTables) and which ones are mapped to an " +
    'action version. Every mapped component\'s code is prepended to every slider of that version, so slider code can call them ' +
    'by name. Pass componentName to get one component\'s full code.',
  properties: {
    pluginId: P.pluginId,
    actionId: P.actionId,
    versionId: { type: 'string', description: 'Version whose mappings to show. Defaults to the version open in the editor.' },
    componentName: { type: 'string', description: 'function_name (or row id) of one component to return in full.' },
  },
  danger: 'safe',
  schema: z.object({
    pluginId: rowId.optional(),
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    componentName: z.string().trim().min(1).max(80).optional(),
  }),
  describe: (a) => (a.componentName ? `Reading component ${a.componentName.slice(0, 30)}` : 'Checking reusable components'),
  async run(a, ctx) {
    const t = a.actionId || a.versionId ? await resolveVersionTarget(ctx, a) : undefined
    const pluginId = t?.pluginId ?? requirePluginId(ctx, a.pluginId)
    const versionId = t?.versionId ?? openEditorVersionId(ctx)
    const [components, mappings] = await Promise.all([
      dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', pluginId),
      versionId ? dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', versionId) : Promise.resolve([]),
    ])
    const usage = new Map<string, string[]>()
    for (const m of mappings) {
      const id = str(m.component_id)
      if (id) usage.set(id, Object.keys(obj(obj(m.metadata)?.componentdependson) ?? {}))
    }

    if (a.componentName) {
      const c = components.find((x) => str(x.function_name) === a.componentName || x.rowid === a.componentName)
      if (!c) return { found: false, available: components.map((x) => str(x.function_name)).filter(Boolean) }
      const code = str(c.function_code) ?? str(c.code) ?? ''
      return {
        id: str(c.rowid),
        name: str(c.function_name),
        params: rowsOf(c.params).map((p) => ({ name: str(p.name), sample: str(p.sample) })),
        description: clip(str(c.description) ?? '', 500) || undefined,
        mappedToVersion: versionId ? usage.has(String(c.rowid)) : undefined,
        chars: code.length,
        functionCode: clip(code, fullBudget(ctx)),
      }
    }

    return {
      pluginId,
      versionId,
      components: components.map((c) => ({
        id: str(c.rowid),
        name: str(c.function_name),
        params: rowsOf(c.params).map((p) => str(p.name)).filter(Boolean),
        builtIn: str(obj(c.metadata)?.built_in),
        description: clip(str(c.description) ?? '', 160) || undefined,
        ...(versionId ? { mapped: usage.has(String(c.rowid)), usedIn: usage.get(String(c.rowid)) } : {}),
      })),
      ...(versionId ? {} : { note: 'Pass versionId (or open a version) to see which components are mapped to it.' }),
    }
  },
})

export const READ_TOOLS: Tool<any>[] = [listActions, getActionVersion, listComponents]
