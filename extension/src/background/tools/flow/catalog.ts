// App catalog lookups through the backend's /dbdash routes. Response nesting differs per route:
// getpluginbyplugid answers {data:{data:{rows}}}, getPluginByQuery answers {data:[rows]}.

import type { VsContext } from '../types'
import { call, ToolError } from './errors'
import { requireOrg } from './flow-api'
import type { FieldDef, InputJson } from './types'
import { asArray, asRecord, isRecord, leafPaths, parseMaybeJson, str, truncate } from './util'

export interface ActionRow {
  rowid: string
  type?: string
  name?: string
  pluginrecordid?: string
  pluginname?: string
  iconurl?: string
  actionversionrecordid?: string
  description?: string
  authidlookup?: string
  authtype?: string
  triggertype?: string
  meta_data?: unknown
  inputjson?: unknown
  sampledata?: unknown
  [k: string]: unknown
}

// `fields` must reach the controller as an array, i.e. at least two comma-separated names (one name fails Joi).
const ACTION_LIST_FIELDS = [
  'type', 'rowid', 'name', 'pluginrecordid', 'pluginname', 'iconurl', 'actionversionrecordid', 'description',
  'category', 'authidlookup', 'authtype', 'sub_category', 'used_count', 'verificationstatus', 'meta_data',
].join(',')

function rowsOf(body: unknown): Record<string, unknown>[] {
  return asArray(asRecord(asRecord(asRecord(body).data).data).rows).filter(isRecord)
}

export function isPaidAction(row: ActionRow): boolean {
  return asRecord(parseMaybeJson(row.meta_data)).isPaidAction === true
}

export async function searchApps(ctx: VsContext, query: string, limit: number): Promise<Record<string, unknown>[]> {
  // Private apps are matched against the token's org, so make sure it is the open workspace.
  await ctx.vs.alignOrg(ctx.signal, { force: true })
  const body = await call('Searching apps', () =>
    ctx.vs.request({ method: 'GET', path: '/dbdash/getPluginByQuery', query: { query, mode: 'flow' }, signal: ctx.signal }),
  )
  return asArray(asRecord(body).data)
    .map((item) => (isRecord(item) && isRecord(item._source) ? item._source : item))
    .filter(isRecord)
    .slice(0, limit)
    .map((r) => ({
      serviceId: str(r.rowid),
      name: str(r.name),
      description: r.description ? truncate(String(r.description), 140) : undefined,
      domain: str(r.domain),
      hasTriggers: r.istriggeravailable === true,
    }))
}

export async function listActions(ctx: VsContext, serviceId: string, kind: 'action' | 'trigger'): Promise<ActionRow[]> {
  const orgId = requireOrg(ctx)
  const body = await call('Listing app actions', () =>
    ctx.vs.request({
      method: 'GET',
      path: '/dbdash/getpluginbyplugid/action',
      // orgId adds the published/visible filter; without it hidden and unpublished actions come back too.
      query: { orgId, fields: ACTION_LIST_FIELDS, type: kind === 'trigger' ? 'trigger' : 'action,custom_action', pluginrecordid: serviceId },
      signal: ctx.signal,
    }),
  )
  return rowsOf(body).filter((r): r is ActionRow => typeof r.rowid === 'string')
}

/** Full action row (all columns: inputjson, sampledata, ...). Fails when the action is unknown or not visible. */
export async function getActionRow(ctx: VsContext, actionId: string): Promise<ActionRow> {
  const orgId = requireOrg(ctx)
  const body = await call('Reading the app action', () =>
    ctx.vs.request({ method: 'GET', path: '/dbdash/getpluginbyplugid/action', query: { rowid: actionId, orgId }, signal: ctx.signal }),
  )
  const row = rowsOf(body)[0]
  if (!row || typeof row.rowid !== 'string') {
    throw new ToolError(`Action ${actionId} was not found or is not available. Use an actionId from vs_list_app_actions.`)
  }
  return row as ActionRow
}

export interface ActionVersionRow {
  rowid: string
  sampledata?: unknown
  metadata?: unknown
  [k: string]: unknown
}

/**
 * One version of an action (the row a trigger or step is pinned to through actionVersionId): its own documented
 * sample and metadata such as scheduleTimeOptions. Fails when the version is unknown.
 */
export async function getActionVersionRow(ctx: VsContext, actionVersionId: string): Promise<ActionVersionRow> {
  const body = await call('Reading the app action version', () =>
    ctx.vs.request({
      method: 'GET',
      path: '/dbdash/getpluginbyplugid/actionversion',
      // At least two names, so `fields` reaches the controller as an array.
      query: { rowid: actionVersionId, fields: 'rowid,sampledata,metadata' },
      signal: ctx.signal,
    }),
  )
  const row = rowsOf(body)[0]
  if (!row || typeof row.rowid !== 'string') throw new ToolError(`Action version ${actionVersionId} was not found.`)
  return row as ActionVersionRow
}

/** Polling intervals (minutes) an action version allows, as the trigger panel offers them. */
export const DEFAULT_POLL_MINUTES = [5, 15, 60, 720, 1440] as const

export function scheduleTimeOptions(row: ActionVersionRow | undefined): number[] {
  const list = asArray(asRecord(parseMaybeJson(row?.metadata)).scheduleTimeOptions)
    .map((v) => Number(v))
    .filter((v) => (DEFAULT_POLL_MINUTES as readonly number[]).includes(v))
  return list.length ? list : [...DEFAULT_POLL_MINUTES]
}

export function normalizeInputJson(v: unknown): InputJson {
  const ij = asRecord(parseMaybeJson(v))
  const steps: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(asRecord(ij.steps))) steps[k] = asArray(list).filter((s): s is string => typeof s === 'string')
  const blocks: Record<string, FieldDef> = {}
  for (const [k, b] of Object.entries(asRecord(ij.blocks))) if (isRecord(b)) blocks[k] = b as FieldDef
  if (!steps.root) steps.root = []
  return { steps, blocks }
}

export interface FieldSummary {
  key: string
  label?: string
  type: string
  required?: boolean
  list?: boolean
  help?: string
  placeholder?: string
  options?: Array<{ label: string; value: unknown }>
  dynamicOptions?: boolean
  dependsOn?: string[]
  visibleWhen?: string
  default?: unknown
  group?: string
}

/** Input fields in display order, groups flattened with their parent key. */
export function fieldList(ij: InputJson): FieldSummary[] {
  const out: FieldSummary[] = []
  const seen = new Set<string>()
  const walk = (loc: string, group: string | undefined, depth: number) => {
    for (const key of ij.steps[loc] ?? []) {
      if (seen.has(key) || out.length >= 120) continue
      seen.add(key)
      const b = ij.blocks[key]
      if (!b) continue
      const options = asArray(b.children)
        .filter(isRecord)
        .slice(0, 25)
        .map((c) => ({ label: String(c.label ?? c.value ?? ''), value: c.value }))
      out.push({
        key,
        label: str(b.label),
        type: str(b.type) ?? 'string',
        required: b.required === true || undefined,
        list: b.list === true || undefined,
        help: b.help ? truncate(String(b.help).replace(/<[^>]*>/g, ''), 160) : undefined,
        placeholder: b.placeholder ? truncate(String(b.placeholder), 80) : undefined,
        options: options.length ? options : undefined,
        dynamicOptions: typeof b.source === 'string' && b.source.trim() ? true : undefined,
        dependsOn: Array.isArray(b.dependsOn) && b.dependsOn.length ? b.dependsOn.filter((d) => typeof d === 'string') : undefined,
        visibleWhen: b.visibilityCondition ? truncate(String(b.visibilityCondition), 120) : undefined,
        default: b.defaultValue,
        group,
      })
      // Only input groups hold child fields; a dropdown's steps entry is the picked option the editor merged in.
      if (ij.steps[key] && depth < 4 && String(b.type ?? '').toLowerCase() === 'input groups') walk(key, key, depth + 1)
    }
  }
  walk('root', undefined, 0)
  return out
}

export function summarizeAction(row: ActionRow): Record<string, unknown> {
  // App-defined example output (not customer data). It shows roughly what the app returns, but it is not a real
  // output: mappings must come from a test (vs_get_variables), so the paths are labelled as documented only.
  const sample = parseMaybeJson(row.sampledata)
  const base = row.type === 'trigger' ? 'context.req.body' : 'context.res.<StepSlug>'
  return {
    actionId: row.rowid,
    name: row.name,
    kind: row.type,
    app: row.pluginname,
    serviceId: row.pluginrecordid,
    actionVersionId: row.actionversionrecordid,
    authType: row.authtype,
    authIdLookup: row.authidlookup,
    needsConnection: !!row.authtype && row.authtype !== 'NoAuth',
    isPaidAction: isPaidAction(row) || undefined,
    triggerType: row.type === 'trigger' ? row.triggertype : undefined,
    description: row.description ? truncate(String(row.description), 300) : undefined,
    fields: fieldList(normalizeInputJson(row.inputjson)),
    documentedSampleFields:
      isRecord(sample) || Array.isArray(sample)
        ? leafPaths(Array.isArray(sample) ? sample[0] : sample, base, 60).filter((p) => !p.includes('viasocket_help'))
        : undefined,
    sampleNote:
      isRecord(sample) || Array.isArray(sample)
        ? `Documented example only, not real data. After the ${row.type === 'trigger' ? 'trigger' : 'step'} is saved and tested, map fields with the insert texts from vs_get_variables.`
        : undefined,
  }
}
