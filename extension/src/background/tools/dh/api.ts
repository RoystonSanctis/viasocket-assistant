// The Developer Hub's table-generic REST surface (/developers/:orgId/{get,create,update}/:table), wrapped so that
// tools can only send filters from a fixed list. The backend maps an unknown filter to an EMPTY where clause,
// which on update would hit every row, so filters are a closed enum here and checked again at runtime.
//
// The filter list is the skill's "Filters" list. getAllPlugins is deliberately absent: the skill forbids it and
// plugs are found with the plug search (getPluginByQuery) instead.

import { VsError, type VsRequest } from '../viasocket-client'
import type { ToolContext } from '../types'
import { findSecret, scrubModelNames, scrubModelNamesDeep } from './text-guards'
import { CREATED_BY, SKILL_NAMES, UPDATED_BY, type SkillKind } from './constants'
import { clip, deepMerge, isRow, jsonObj, obj, rowsOf, str, type Row } from './rows'

/** The ownership middleware's identifier rule: 'row' + alphanumerics, at most 16 characters. */
export const ROW_ID_RE = /^row[A-Za-z0-9]{1,13}$/

const GET_FILTERS = {
  plugins: ['getPluginDetails'],
  oauth_details: ['getAuthDetails'],
  actions: ['getAllActions', 'getActionDetails'],
  action_version: ['getActionVersions', 'dhGetParticularFieldApi'],
  reusable_components: ['dhGetReusableComponentDetails'],
  action_version_component_table: ['dhGetUsedComponentInActionVersionDetails', 'dhGetUsedActionVersionForComponent'],
} as const

const UPDATE_FILTERS = {
  plugins: ['updatePluginDetails'],
  oauth_details: ['updateAuthDetails'],
  actions: ['updateActionDetails'],
  action_version: ['updateActionVersionDetails'],
  action_version_component_table: ['dhUpdateReusableComponentDetails'],
} as const

type GetTable = keyof typeof GET_FILTERS
type GetFilter<T extends GetTable> = (typeof GET_FILTERS)[T][number]
type UpdateTable = keyof typeof UPDATE_FILTERS
type UpdateFilter<T extends UpdateTable> = (typeof UPDATE_FILTERS)[T][number]
type CreateTable = 'plugins' | 'oauth_details' | 'actions' | 'action_version' | 'reusable_components' | 'action_version_component_table'

/** A tool failure the model should read and act on. Never carries the raw response body. */
export function fail(message: string): never {
  throw new VsError(message, 'validation')
}

export class DuplicateError extends VsError {}

export function orgOf(ctx: ToolContext): string {
  const org = ctx.vs.orgId
  if (!org || !/^[A-Za-z0-9_-]{1,32}$/.test(org)) {
    fail('Open the viaSocket Developer Hub (or any page of your workspace) first, so I know which org to work in.')
  }
  return org
}

export function assertRowId(id: string, what: string): string {
  if (!ROW_ID_RE.test(id)) {
    fail(`${what} '${clip(id, 40)}' is not a Developer Hub id (expected 'row' followed by letters/digits, max 16 chars).`)
  }
  return id
}

const SECRETISH = /https?:|token|authori[sz]ation|password|secret|api[-_ ]?key|cookie|header/i

function mentionsDuplicate(body: unknown): boolean {
  try {
    return /duplicate key|unique constraint/i.test(JSON.stringify(body) ?? '')
  } catch {
    return false
  }
}

/**
 * Strips the backend error to its message. Create failures carry a serialized AxiosError (with internal request
 * config) in `data`; only short, harmless string details are kept.
 */
export function cleanError(e: unknown): Error {
  if (e instanceof VsError) {
    if (e.body === undefined) return e
    const data = obj(e.body)?.data
    const detail = typeof data === 'string' && data.length <= 240 && !SECRETISH.test(data) ? data : ''
    const message = detail ? `${e.message.trim()}: ${detail}` : e.message.trim()
    return mentionsDuplicate(e.body) ? new DuplicateError(message, e.kind, e.status) : new VsError(message, e.kind, e.status)
  }
  if (e instanceof Error) return new VsError(e.message, 'server')
  return new VsError('Unexpected error', 'server')
}

export async function send(ctx: ToolContext, req: Omit<VsRequest, 'signal'>): Promise<unknown> {
  try {
    return await ctx.vs.request<unknown>({ ...req, signal: ctx.signal })
  } catch (e) {
    throw cleanError(e)
  }
}

/** Every write starts here: the token's active org must be the org in the page URL (several routes trust it). */
export async function alignOrg(ctx: ToolContext, force = false): Promise<void> {
  try {
    await ctx.vs.alignOrg(ctx.signal, { force })
  } catch (e) {
    throw cleanError(e)
  }
}

function devPath(ctx: ToolContext, op: 'get' | 'create' | 'update', table: string): string {
  return `/developers/${encodeURIComponent(orgOf(ctx))}/${op}/${table}`
}

export async function dhGet<T extends GetTable>(
  ctx: ToolContext,
  table: T,
  filter: GetFilter<T>,
  identifier: string,
  fields?: readonly string[],
): Promise<Row[]> {
  const allowed: readonly string[] = GET_FILTERS[table]
  if (!allowed.includes(filter)) fail(`Filter ${filter} is not allowed on ${table}`)
  assertRowId(identifier, 'Id')
  const body = await send(ctx, {
    method: 'GET',
    path: devPath(ctx, 'get', table),
    query: { identifier, filter, fields: fields?.length ? fields.join(',') : undefined },
  })
  return rowsOf(obj(body)?.data)
}

/**
 * GET with `&fields=` (the skill's column lists). If the server rejects the column list, the full rows are read
 * instead and projected to the same columns, so columns outside the list (secrets included) never leave this module.
 */
export async function dhGetFields<T extends GetTable>(
  ctx: ToolContext,
  table: T,
  filter: GetFilter<T>,
  identifier: string,
  fields: readonly string[],
): Promise<Row[]> {
  let rows: Row[]
  try {
    rows = await dhGet(ctx, table, filter, identifier, fields)
  } catch (e) {
    if (!(e instanceof VsError) || e.kind !== 'validation') throw e
    rows = await dhGet(ctx, table, filter, identifier)
  }
  return rows.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])))
}

export async function dhGetOne<T extends GetTable>(
  ctx: ToolContext,
  table: T,
  filter: GetFilter<T>,
  identifier: string,
  what: string,
): Promise<Row> {
  const row = (await dhGet(ctx, table, filter, identifier))[0]
  if (!row) fail(`${what} ${identifier} was not found in this org.`)
  return row
}

// ---------- provenance (dh.mjs entry / MERGE) ----------

/** Keys the skill forbids on writes: rtllayer auto-publishes, the others leak into rows or bypass checks. */
const FORBIDDEN_WRITE_KEYS = ['rtllayer', 'isAIActionTrigger', 'functionId', 'isUserOnDh'] as const

/** The skill whose kind of work a table write belongs to (dh.mjs records cfg.skill). */
function skillFor(table: CreateTable | 'plugins' | 'actions'): SkillKind {
  if (table === 'plugins') return 'plug'
  if (table === 'oauth_details') return 'connection'
  return 'action'
}

/**
 * dh.mjs aiLogs entry. Notes never carry a model, vendor or tool name (skill rule): any is replaced with the label.
 * `keep` lists the plug's own name/domain, so an OpenAI or Gemini plug can still be named.
 */
export function aiLogEntry(by: typeof CREATED_BY | typeof UPDATED_BY, note?: string, skill: SkillKind = 'plug', keep: readonly string[] = []): Row {
  const clean = note ? clip(scrubModelNames(note, by, keep), 200) : undefined
  return { by, time: new Date().toISOString(), skill: SKILL_NAMES[skill], ...(clean ? { note: clean } : {}) }
}

function appendLog(metadata: unknown, entry: Row): Row {
  const meta = jsonObj(metadata)
  const logs = Array.isArray(meta.aiLogs) ? meta.aiLogs : []
  return { ...meta, aiLogs: [...logs, entry] }
}

/**
 * Returns the created rows (data.actionData) and the whole `data` object (create/actions nests the V1 row in it).
 * Like dh.mjs, every create except a component mapping gets a CREATED aiLogs entry in metadata.
 */
export async function dhCreate(ctx: ToolContext, table: CreateTable, body: Row): Promise<{ rows: Row[]; data: Row }> {
  for (const k of FORBIDDEN_WRITE_KEYS) if (k in body) fail(`Refusing to send ${k} on a Developer Hub write.`)
  const payload: Row =
    table === 'action_version_component_table' ? body : { ...body, metadata: appendLog(body.metadata, aiLogEntry(CREATED_BY, undefined, skillFor(table))) }
  await alignOrg(ctx)
  const res = await send(ctx, { method: 'POST', path: devPath(ctx, 'create', table), body: payload })
  const data = obj(obj(res)?.data) ?? {}
  return { rows: rowsOf(data.actionData), data }
}

export async function dhUpdate<T extends UpdateTable>(
  ctx: ToolContext,
  table: T,
  filter: UpdateFilter<T>,
  identifier: string,
  body: Row,
): Promise<Row | undefined> {
  const allowed: readonly string[] = UPDATE_FILTERS[table]
  if (!allowed.includes(filter)) fail(`Filter ${filter} is not allowed on ${table}`)
  for (const k of FORBIDDEN_WRITE_KEYS) if (k in body) fail(`Refusing to send ${k} on a Developer Hub write.`)
  assertRowId(identifier, 'Id')
  await alignOrg(ctx)
  const res = await send(ctx, {
    method: 'PUT',
    path: devPath(ctx, 'update', table),
    query: { identifier, filter },
    body,
  })
  return rowsOf(obj(res)?.data)[0]
}

export interface MergeOptions {
  by?: typeof CREATED_BY | typeof UPDATED_BY
  note?: string
  /** Deep-merged into metadata.aiContext (nested objects merged, arrays replaced) with updatedAt. */
  aiContext?: Row
  /** The kind of work, for the aiLogs `skill` (default: plug for plugins, action for actions). */
  skill?: SkillKind
}

/**
 * dh.mjs MERGE for plugins/actions, whose updates REPLACE metadata: reads the row, keeps every metadata key,
 * deep-merges metadata.aiContext and appends an aiLogs entry. Refuses deleted rows. Returns the updated row and the
 * row as it was before.
 */
export async function dhMerge(
  ctx: ToolContext,
  table: 'plugins' | 'actions',
  identifier: string,
  changes: Row,
  opts: MergeOptions = {},
): Promise<{ row: Row | undefined; before: Row }> {
  const before =
    table === 'plugins'
      ? await dhGetOne(ctx, 'plugins', 'getPluginDetails', identifier, 'Plug')
      : await dhGetOne(ctx, 'actions', 'getActionDetails', identifier, 'Action')
  if (str(before.status) === 'deleted') fail(`${table === 'plugins' ? 'Plug' : 'Action'} ${identifier} is deleted.`)
  const meta = jsonObj(before.metadata)
  const by = opts.by ?? UPDATED_BY
  // The plug's own name/domain may legitimately be a model vendor (an OpenAI plug); everything else is scrubbed.
  const keep = [str(before.name), str(before.domain), str(before.pluginname)].filter((x): x is string => !!x)
  let aiContext: Row = {}
  if (opts.aiContext) {
    const secret = findSecret(opts.aiContext)
    if (secret) fail(`${secret} looks like a credential. aiContext must never contain secrets.`)
    const clean = scrubModelNamesDeep(opts.aiContext, by, keep) as Row
    aiContext = { aiContext: { ...(deepMerge(jsonObj(meta.aiContext), clean) as Row), updatedAt: new Date().toISOString() } }
  }
  const { metadata: _ignored, ...rest } = changes
  const skill = opts.skill ?? skillFor(table)
  const body: Row = { ...rest, metadata: appendLog({ ...meta, ...aiContext }, aiLogEntry(by, opts.note, skill, keep)) }
  const row =
    table === 'plugins'
      ? await dhUpdate(ctx, 'plugins', 'updatePluginDetails', identifier, body)
      : await dhUpdate(ctx, 'actions', 'updateActionDetails', identifier, body)
  return { row, before }
}

// ---------- plug search (skill "Search plug") ----------

/** Hits may come back flat, as {row}, or as ES {_source}; unwrap to the plugin row. */
function hitRow(v: unknown): Row | undefined {
  if (!isRow(v)) return undefined
  if (typeof v.rowid === 'string') return v
  const src = obj(v._source)
  if (src) return obj(src.row) ?? src
  return obj(v.row)
}

/**
 * The hit list of a search response, as dh.mjs reads it: the body itself as an array, `.rows`, `.data` (the
 * backend's envelope) as an array, `.data.rows`, ES `.hits.hits`, or the same nested under `.data`. Undefined when
 * the body has none of these shapes: callers must not read that as "no hits".
 */
export function searchHits(body: unknown): unknown[] | undefined {
  let v: unknown = body
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(v)) return v
    const o = obj(v)
    if (!o) return undefined
    if (Array.isArray(o.rows)) return o.rows
    const hits = obj(o.hits)
    if (hits && Array.isArray(hits.hits)) return hits.hits
    if (!('data' in o)) return undefined
    v = o.data
  }
  return Array.isArray(v) ? v : undefined
}

export interface PlugSearch {
  rows: Row[]
  /** The response had no recognisable hit list (not the same as an empty one). */
  unparsed: boolean
}

/**
 * GET /dbdash/getPluginByQuery?query=&orgId=&mode=dh (the skill's "Search plug"; never the all-plugs filter). The
 * server searches the token's org and never realigns it, so the org is force-aligned right before the search (no
 * TTL cache: the user may have switched org in another tab). See searchHits for the accepted response shapes.
 */
export async function searchPlugins(ctx: ToolContext, query: string, fields: readonly string[]): Promise<PlugSearch> {
  const org = orgOf(ctx)
  await alignOrg(ctx, true)
  const res = await send(ctx, { method: 'GET', path: '/dbdash/getPluginByQuery', query: { query, orgId: org, mode: 'dh', fields: fields.join(',') } })
  const hits = searchHits(res)
  if (!hits) return { rows: [], unparsed: true }
  const rows = hits.map(hitRow).filter((r): r is Row => !!r && typeof r.rowid === 'string')
  // Hits that are not plug rows at all mean the shape changed; fail closed rather than report "none".
  return { rows, unparsed: hits.length > 0 && rows.length === 0 }
}

// ---------- connections of users (authtoken) ----------

/**
 * The org's connections (auth_data records, teammates' included; each has user_id) for one connection version of a
 * plug. The backend ignores the version segment in SQL, so the result is filtered here.
 */
export async function listUserConnections(ctx: ToolContext, pluginId: string, authRowId: string): Promise<Row[]> {
  // The route validates each segment to at most 12 characters.
  if (!/^[A-Za-z0-9]{1,12}$/.test(pluginId) || !/^[A-Za-z0-9]{1,12}$/.test(authRowId)) {
    fail('This plug or connection id is too long for the connections lookup.')
  }
  // The list is filtered by the URL org and the token org's access levels; keep them the same.
  await alignOrg(ctx)
  const res = await send(ctx, {
    method: 'GET',
    path: `/authtoken/orgid/${encodeURIComponent(orgOf(ctx))}/serviceid/${pluginId}/version/${authRowId}`,
  })
  return rowsOf(obj(res)?.data).filter((c) => str(c.auth_version_id) === authRowId)
}

const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A connection row's id: the authtoken list returns `identifier` (the skill's column); `id` only as a fallback. */
export function connectionIdOf(c: Row): string | undefined {
  const id = str(c.identifier) ?? str(c.id)
  return id && CONNECTION_ID_RE.test(id) ? id : undefined
}

/** GET /authtoken/authvalid/:id → data.valid (true/false; null for an unknown id). */
export async function connectionValid(ctx: ToolContext, connectionId: string): Promise<boolean> {
  if (!CONNECTION_ID_RE.test(connectionId)) return false
  try {
    const res = await send(ctx, { method: 'GET', path: `/authtoken/authvalid/${encodeURIComponent(connectionId)}` })
    return obj(obj(res)?.data)?.valid === true
  } catch {
    return false
  }
}

/**
 * The signed-in user's id: GET /users/me → id (skill), else the org details route. Only the id is read; the rest of
 * these responses is personal data and is dropped immediately.
 */
export async function currentUserId(ctx: ToolContext): Promise<string | undefined> {
  const valid = (id: string | undefined) => (id && /^[0-9]{1,20}$/.test(id) ? id : undefined)
  try {
    const res = obj(await ctx.vs.request<unknown>({ method: 'GET', path: '/users/me', signal: ctx.signal }))
    const data = res?.data
    const id = valid(str(obj(data)?.id) ?? str(rowsOf(data)[0]?.id))
    if (id) return id
  } catch {
    // fall through
  }
  try {
    const res = await ctx.vs.request<unknown>({ method: 'GET', path: '/orgs/user-org/details', signal: ctx.signal })
    return valid(str(rowsOf(obj(obj(res)?.data)?.data)[0]?.id))
  } catch {
    return undefined
  }
}

/** How many action versions use each connection version of a plug (informational, best-effort). */
export async function authUsageCounts(ctx: ToolContext, pluginId: string): Promise<Map<string, number> | undefined> {
  const counts = new Map<string, number>()
  try {
    const res = await send(ctx, {
      method: 'GET',
      path: `/developers/${encodeURIComponent(orgOf(ctx))}/GetUsedInCountForAuth`,
      query: { pluginId: assertRowId(pluginId, 'Plug id') },
    })
    for (const r of rowsOf(obj(res)?.data)) {
      const id = str(r.authid)
      const n = Number(r.count)
      if (id && Number.isFinite(n)) counts.set(id, (counts.get(id) ?? 0) + n)
    }
  } catch {
    // Unknown usage is treated as "in use" by the callers that decide anything from it.
    return undefined
  }
  return counts
}

const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Pushes a live-update event to an open Developer Hub page (no DB write). Best-effort: a failure only means the
 * page shows stale data until refreshed.
 */
export async function pushRtlayer(ctx: ToolContext, thread: string, data: unknown): Promise<boolean> {
  const org = ctx.vs.orgId
  if (!org || !THREAD_RE.test(thread)) return false
  try {
    await ctx.vs.request({ method: 'POST', path: '/utility/rtlayer', body: { channelId: `${org}-${thread}`, data }, signal: ctx.signal })
    return true
  } catch {
    return false
  }
}

export function isSafeThread(t: string | undefined): t is string {
  return !!t && THREAD_RE.test(t)
}
