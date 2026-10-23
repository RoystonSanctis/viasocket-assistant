// App connections (auth tokens) of the open workspace, and creating one through viaSocket's own auth popup.
// The user types credentials or finishes OAuth on viaSocket's page; the extension never sees them.

import type { ToolContext, VsContext } from '../types'
import { call, ToolError } from './errors'
import {
  editorOpen,
  editorParam,
  getFlow,
  getFunctionRow,
  openPanel,
  openTriggerPanel,
  pluginDataOf,
  refreshEditorIfOpen,
  requireOrg,
  resolveFlow,
  triggerKind,
} from './flow-api'
import { pluginBody, putStep, type SaveCommon } from './step-bodies'
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

export function isExpired(c: ConnectionRow): boolean {
  return c.isExpired === true || asRecord(parseMaybeJson(c.meta_data)).isExpired === true
}

export async function listConnections(
  ctx: VsContext,
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
  ctx: VsContext,
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
async function currentUserId(ctx: VsContext): Promise<string | undefined> {
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

/** viaSocket's own connect page for one auth version of an app, on the environment's auth host. */
export async function connectUrl(ctx: VsContext, appHost: string, a: ConnectArgs, flow?: FlowTarget): Promise<URL> {
  const orgId = requireOrg(ctx)
  const userId = await currentUserId(ctx)
  const url = new URL(`${ctx.vs.env.authBase}/auth/service/${a.serviceId}/auth/${a.authIdLookup}`)
  const query: Record<string, string | undefined> = {
    userid: userId,
    orgid: orgId,
    actionid: a.actionVersionId,
    projectid: flow?.projectId,
    scriptid: flow?.scriptId,
    uniqueIdentifierForRtlayer: randomAlnum(20),
    openerURL: `https://${appHost}`,
    mode: 'flow',
    isUserOnDH: 'false',
    isUpdate: 'false',
  }
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)
  return url
}

/**
 * Opens viaSocket's auth popup and waits for a new connection to appear. The popup is a separate window without
 * an opener, so its postMessage completion signal cannot reach us; polling the list is the dependable signal.
 */
export async function connectApp(ctx: ToolContext, a: ConnectArgs, flow?: FlowTarget): Promise<Record<string, unknown>> {
  const before = new Set((await listConnections(ctx, a.serviceId, a.authIdLookup, flow)).map((c) => c.id))
  const url = await connectUrl(ctx, ctx.page.host, a, flow)

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

        const authData: AuthData = {
          id: fresh.id,
          type: fresh.type,
          connection_label: fresh.connection_label,
        }

        let targetFlow = flow
        if (!targetFlow) {
          try {
            targetFlow = resolveFlow(ctx)
          } catch {
            targetFlow = undefined
          }
        }

        let autoUpdatedStep: string | undefined
        let panelOpened = false
        let panelNote: string | undefined

        if (targetFlow && editorOpen(ctx, targetFlow.scriptId)) {
          try {
            await ctx.vs.mutate(targetFlow.scriptId, async () => {
              await ctx.vs.alignOrg(ctx.signal)
              const row = await getFlow(ctx, targetFlow)
              const js = row.json_script
              const openStepId = editorParam(ctx, 'stepId', targetFlow.scriptId)
              const openSlug = editorParam(ctx, 'slugName', targetFlow.scriptId)

              // 1. Check if trigger panel is open and matches this app connection
              if (openStepId === 'SET_TRIGGER' && js.trigger) {
                const tr = js.trigger
                const matchService = tr.serviceId === a.serviceId || tr.authIdLookup === a.authIdLookup
                const matchAction = a.actionVersionId && tr.selectedCreate === a.actionVersionId
                const needsAuth = !tr.selectedValues?.authData?.id || tr.selectedValues?.authData?.id === 'NoAuth'
                if ((matchService || matchAction) && (needsAuth || matchAction)) {
                  const body: Record<string, unknown> = {
                    ...tr,
                    selectedValues: { ...asRecord(tr.selectedValues), authData, inputData: asRecord(tr.selectedValues?.inputData) },
                    type: asRecord(tr.selectedValues?.inputData).performSubscribe !== undefined || tr.scriptId !== undefined ? 'update' : 'add',
                    triggerType: String(tr.triggerType || 'hook'),
                    name: 'trigger',
                  }
                  if (tr.sampleData !== undefined) body.sampleData = tr.sampleData
                  delete body.isDrafted
                  await ctx.vs.request({
                    method: 'POST',
                    path: `/scripts/${targetFlow.projectId}/${targetFlow.scriptId}/trigger`,
                    body,
                    live: true,
                    signal: ctx.signal,
                  })
                  await sleep(200, ctx.signal)
                  const sync = await openTriggerPanel(ctx, targetFlow.scriptId, triggerKind(tr))
                  autoUpdatedStep = 'trigger'
                  panelOpened = sync.delivered
                  if (sync.reason) panelNote = sync.reason
                  return
                }
              }

              // 2. Check if open step panel matches this app connection
              let targetSlug: string | undefined
              if (openSlug && js.blocks[openSlug]?.type === 'plugin') {
                const b = js.blocks[openSlug]
                const matchService = b.metaData?.serviceId === a.serviceId || b.metaData?.authIdLookup === a.authIdLookup
                const matchAction = a.actionVersionId && b.metaData?.actionVersionId === a.actionVersionId
                if (matchService || matchAction) {
                  targetSlug = openSlug
                }
              }

              // 3. If open step didn't match, check if any plugin step in the flow matches and needs connection
              if (!targetSlug) {
                for (const [slug, b] of Object.entries(js.blocks)) {
                  if (b.type === 'plugin') {
                    const matchService = b.metaData?.serviceId === a.serviceId || b.metaData?.authIdLookup === a.authIdLookup
                    const matchAction = a.actionVersionId && b.metaData?.actionVersionId === a.actionVersionId
                    const needsAuth = !b.metaData?.selectedValues?.authData?.id || b.metaData?.selectedValues?.authData?.id === 'NoAuth' || b.status === 'DRAFTED'
                    if ((matchService || matchAction) && needsAuth) {
                      targetSlug = slug
                      break
                    }
                  }
                }
              }

              // 4. Update the step and refresh slider
              const block = targetSlug ? js.blocks[targetSlug] : undefined
              if (targetSlug && block) {
                const stepId = block.identifier ?? openStepId ?? ''
                const fn = stepId ? await getFunctionRow(ctx, targetFlow, stepId) : null
                const pd = pluginDataOf(block, fn) ?? block.metaData
                if (pd) {
                  const c: SaveCommon = {
                    stepId,
                    title: targetSlug,
                    description: block.description,
                    sampleData: block.sampleData,
                    iconUrl: block.iconUrl,
                    hidden: block.hidden,
                  }
                  const inputData = asRecord(pd.selectedValues?.inputData)
                  const body = pluginBody(c, pd, authData, inputData)
                  await putStep(ctx, targetFlow, targetSlug, body, true)
                  await sleep(200, ctx.signal)
                  const sync = await openPanel(ctx, targetFlow.scriptId, stepId, targetSlug)
                  autoUpdatedStep = targetSlug
                  panelOpened = sync.delivered
                  if (sync.reason) panelNote = sync.reason
                  return
                }
              }

              // 5. Fallback: refresh editor so any open UI re-queries connections
              const sync = await refreshEditorIfOpen(ctx, targetFlow.scriptId)
              panelOpened = sync.delivered
              if (sync.reason) panelNote = sync.reason
            })
          } catch (err) {
            console.warn('[assistant] failed to auto-update step slider with new connection:', err)
          }
        }

        return {
          connected: true,
          connection: summarizeConnection(fresh),
          ...(autoUpdatedStep ? { updatedStep: autoUpdatedStep, panelUpdated: true } : {}),
          ...(panelOpened ? { panelOpened } : {}),
          ...(panelNote ? { panelNote } : {}),
        }
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
