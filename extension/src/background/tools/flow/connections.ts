// App connections (auth tokens) of the open workspace, and creating one through viaSocket's own auth popup.
// The user types credentials or finishes OAuth on viaSocket's page; the extension never sees them.

import type { ToolContext } from '../types'
import { call, ToolError } from './errors'
import { requireOrg } from './flow-api'
import type { AuthData, FlowTarget } from './types'
import { asArray, asRecord, isRecord, parseMaybeJson, randomAlnum, sleep, str, truncate } from './util'

export interface ConnectionRow {
  id: string
  connection_label?: string
  type?: string
  auth_version_id?: string
  isExpired?: boolean
  meta_data?: unknown
  manually_updated_at?: string
  updatedAt?: string
}

const POLL_MS = 3000
const POLL_TIMEOUT_MS = 180_000
const CLOSED_GRACE_MS = 4000

function isExpired(c: ConnectionRow): boolean {
  return c.isExpired === true || asRecord(parseMaybeJson(c.meta_data)).isExpired === true
}

export async function listConnections(
  ctx: ToolContext,
  serviceId: string,
  authIdLookup: string,
  flow?: FlowTarget,
): Promise<ConnectionRow[]> {
  const orgId = requireOrg(ctx)
  // The list is filtered by the URL org and the token org's access levels; keep them the same.
  await ctx.vs.alignOrg(ctx.signal)
  const body = await call('Listing connections', () =>
    ctx.vs.request({
      method: 'GET',
      path: `/authtoken/orgid/${orgId}/serviceid/${serviceId}/version/${authIdLookup}`,
      query: flow ? { projectId: flow.projectId, scriptId: flow.scriptId } : undefined,
      signal: ctx.signal,
    }),
  )
  // The version path segment is ignored by the query, so connections of other auth versions come back too.
  return asArray(asRecord(body).data)
    .filter((r): r is ConnectionRow => isRecord(r) && typeof r.id === 'string')
    .filter((r) => r.auth_version_id === authIdLookup)
    .sort((a, b) => String(b.manually_updated_at ?? b.updatedAt ?? '').localeCompare(String(a.manually_updated_at ?? a.updatedAt ?? '')))
}

export function summarizeConnection(c: ConnectionRow): Record<string, unknown> {
  return {
    id: c.id,
    name: c.connection_label ? truncate(String(c.connection_label), 80) : undefined,
    type: c.type,
    valid: !isExpired(c),
    updatedAt: c.manually_updated_at ?? c.updatedAt,
  }
}

/**
 * Confirms a connection id is a valid connection of this app's auth version in the open workspace, and returns
 * the authData to store. authData.type must equal the connection's own type: the generated step code picks the
 * token loader from it, and a mismatch only fails at run time.
 */
export async function resolveConnection(
  ctx: ToolContext,
  connectionId: string,
  serviceId: string,
  authIdLookup: string,
  flow?: FlowTarget,
): Promise<AuthData> {
  const rows = await listConnections(ctx, serviceId, authIdLookup, flow)
  const c = rows.find((r) => r.id === connectionId)
  if (!c) {
    throw new ToolError(
      `Connection ${connectionId} is not a compatible connection for this app in this workspace. Use an id from vs_list_connections, or create one with vs_connect_app.`,
    )
  }
  if (isExpired(c)) throw new ToolError(`Connection ${connectionId} has expired. Ask the user to reconnect with vs_connect_app.`)
  return { id: c.id, type: c.type, connection_label: c.connection_label }
}

/** Only the numeric user id is read; the rest of this response is sensitive and is dropped immediately. */
async function currentUserId(ctx: ToolContext): Promise<string | undefined> {
  try {
    const body = await ctx.vs.request({ method: 'GET', path: '/orgs/user-org/details', signal: ctx.signal })
    const id = str(asRecord(asArray(asRecord(asRecord(body).data).data)[0]).id)
    return id && /^[0-9]{1,20}$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export interface ConnectArgs {
  serviceId: string
  authIdLookup: string
  actionVersionId?: string
}

/**
 * Opens viaSocket's auth popup and waits for a new connection to appear. The popup is a separate window without
 * an opener, so its postMessage completion signal cannot reach us; polling the list is the dependable signal.
 */
export async function connectApp(ctx: ToolContext, a: ConnectArgs, flow?: FlowTarget): Promise<Record<string, unknown>> {
  const orgId = requireOrg(ctx)
  const before = new Set((await listConnections(ctx, a.serviceId, a.authIdLookup, flow)).map((c) => c.id))
  const userId = await currentUserId(ctx)

  const url = new URL(`${ctx.vs.env.authBase}/auth/service/${a.serviceId}/auth/${a.authIdLookup}`)
  const query: Record<string, string | undefined> = {
    userid: userId,
    orgid: orgId,
    actionid: a.actionVersionId,
    projectid: flow?.projectId,
    scriptid: flow?.scriptId,
    uniqueIdentifierForRtlayer: randomAlnum(20),
    openerURL: `https://${ctx.page.host}`,
    mode: 'flow',
    isUserOnDH: 'false',
    isUpdate: 'false',
  }
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)

  let tabId: number | undefined
  try {
    const tab = await chrome.tabs.create({
      url: url.href,
      active: true,
      ...(ctx.tabId !== undefined ? { openerTabId: ctx.tabId } : {}),
    })
    tabId = tab?.id
  } catch {
    throw new ToolError('Could not open the connection tab. Ask the user to allow opening tabs and try again.')
  }

  let closedAt = 0
  const onTabRemoved = (id: number) => {
    if (id === tabId) closedAt = Date.now()
  }
  chrome.tabs.onRemoved.addListener(onTabRemoved)
  ctx.ui.say('Finish connecting in the new tab…')
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS, ctx.signal)
      const rows = await listConnections(ctx, a.serviceId, a.authIdLookup, flow)
      const fresh = rows.find((c) => !before.has(c.id))
      if (fresh) {
        if (tabId !== undefined) {
          chrome.tabs.remove(tabId).catch(() => undefined)
        }
        return { connected: true, connection: summarizeConnection(fresh) }
      }
      if (closedAt && Date.now() - closedAt > CLOSED_GRACE_MS) {
        return { connected: false, message: 'The connection tab was closed before a new connection was created.' }
      }
    }
    return { connected: false, message: 'No new connection after 3 minutes. Ask the user whether they finished connecting.' }
  } finally {
    chrome.tabs.onRemoved.removeListener(onTabRemoved)
  }
}
