// The Developer Hub's table-generic REST surface (/developers/:orgId/{get,create,update}/:table), wrapped so that
// tools can only send filters from a fixed list. The backend maps an unknown filter to an EMPTY where clause,
// which on update would hit every row, so filters are a closed enum here and checked again at runtime.

import { VsError, type VsRequest } from '../viasocket-client'
import type { ToolContext } from '../types'
import { clip, obj, rowsOf, str, type Row } from './rows'

/** The ownership middleware's identifier rule: 'row' + alphanumerics, at most 16 characters. */
export const ROW_ID_RE = /^row[A-Za-z0-9]{1,13}$/

const GET_FILTERS = {
  plugins: ['getAllPlugins', 'getPluginDetails'],
  oauth_details: ['getAuthDetails'],
  actions: ['getAllActions', 'getActionDetails'],
  action_version: ['getActionVersions', 'dhGetParticularFieldApi'],
  reusable_components: ['dhGetReusableComponentDetails'],
  action_version_component_table: ['dhGetUsedComponentInActionVersionDetails'],
} as const

const UPDATE_FILTERS = {
  plugins: ['updatePluginDetails'],
  oauth_details: ['updateAuthDetails'],
  actions: ['updateActionDetails'],
  action_version: ['updateActionVersionDetails'],
} as const

type GetTable = keyof typeof GET_FILTERS
type GetFilter<T extends GetTable> = (typeof GET_FILTERS)[T][number]
type UpdateTable = keyof typeof UPDATE_FILTERS
type UpdateFilter<T extends UpdateTable> = (typeof UPDATE_FILTERS)[T][number]
type CreateTable = 'plugins' | 'oauth_details' | 'actions' | 'action_version' | 'action_version_component_table'

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

async function alignOrg(ctx: ToolContext): Promise<void> {
  try {
    await ctx.vs.alignOrg(ctx.signal)
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
  fields?: string[],
): Promise<Row[]> {
  const allowed: readonly string[] = GET_FILTERS[table]
  if (!allowed.includes(filter)) fail(`Filter ${filter} is not allowed on ${table}`)
  // getAllPlugins is the one GET keyed by the org id instead of a row id.
  if (filter === 'getAllPlugins') {
    if (identifier !== orgOf(ctx)) fail('Plugs can only be listed for the current org')
  } else {
    assertRowId(identifier, 'Id')
  }
  const body = await send(ctx, {
    method: 'GET',
    path: devPath(ctx, 'get', table),
    query: { identifier, filter, fields: fields?.join(',') },
  })
  return rowsOf(obj(body)?.data)
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

/** Returns the created rows (data.actionData) and the whole `data` object (create/actions nests the V1 row in it). */
export async function dhCreate(ctx: ToolContext, table: CreateTable, body: Row): Promise<{ rows: Row[]; data: Row }> {
  await alignOrg(ctx)
  const res = await send(ctx, { method: 'POST', path: devPath(ctx, 'create', table), body })
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

/**
 * The org's connections (auth_data records, teammates' included; each has user_id) for one connection version of a
 * plug. The backend ignores the version segment in SQL, so the result is filtered here.
 */
export async function listUserConnections(ctx: ToolContext, pluginId: string, authRowId: string): Promise<Row[]> {
  // The route validates each segment to at most 12 characters.
  if (!/^[A-Za-z0-9]{1,12}$/.test(pluginId) || !/^[A-Za-z0-9]{1,12}$/.test(authRowId)) {
    fail('This plug or connection id is too long for the connections lookup.')
  }
  const res = await send(ctx, {
    method: 'GET',
    path: `/authtoken/orgid/${encodeURIComponent(orgOf(ctx))}/serviceid/${pluginId}/version/${authRowId}`,
  })
  return rowsOf(obj(res)?.data).filter((c) => str(c.auth_version_id) === authRowId)
}

/** The signed-in user's numeric id. Only that id is read; the rest of this response is sensitive and dropped. */
export async function currentUserId(ctx: ToolContext): Promise<string | undefined> {
  try {
    const res = await ctx.vs.request<unknown>({ method: 'GET', path: '/orgs/user-org/details', signal: ctx.signal })
    const id = str(rowsOf(obj(obj(res)?.data)?.data)[0]?.id)
    return id && /^[0-9]{1,20}$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** How many action versions use each connection version of a plug (informational, best-effort). */
export async function authUsageCounts(ctx: ToolContext, pluginId: string): Promise<Map<string, number>> {
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
    // informational only
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
