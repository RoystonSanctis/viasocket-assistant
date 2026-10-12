// Skill §4.1: find a working connection for a connection version (reuse it without asking), or open viaSocket's
// auth window so the user connects there. The extension never sees credentials: the user types them (or finishes
// OAuth) on viaSocket's own page. Like the skill, nothing polls: when the user says it is done, the model checks once
// with dh_check_connection.

import * as z from '../../../shared/zod'
import { maybeRedactText } from '../redact'
import type { Tool, ToolContext } from '../types'
import { connectionIdOf, connectionValid, currentUserId, dhGetFields, dhGetOne, fail, listUserConnections, orgOf } from './api'
import { P, dhTool, rowId } from './define'
import { flag, jsonObj, str, type Row } from './rows'
import { authOpen, pageActionId, pageAuthId, requirePluginId, resolveVersionTarget } from './target'

export interface WorkingConnection {
  id: string
  type: string
  label?: string
  ownedByYou: boolean
}

export interface ConnectionLookup {
  connection?: WorkingConnection
  /** Non-expired connections of teammates (never picked implicitly) */
  teammates: number
  ids: Set<string>
}

const MAX_VALIDITY_CHECKS = 4

function listedExpired(c: Row): boolean {
  return flag(c.isExpired) || flag(jsonObj(c.meta_data).isExpired)
}

function recency(c: Row): number {
  return Date.parse(str(c.manually_updated_at) ?? str(c.updatedAt) ?? '') || 0
}

/**
 * The user's own working connection for one connection version (skill §4.1 step 1): rows with auth_version_id =
 * authId (each carries `identifier`, the connection id), then /authtoken/authvalid on the newest candidates.
 * Teammates' connections are counted, never chosen implicitly. With `connectionId`, exactly that connection is checked
 * (it may be a teammate's, when the user agreed; ownedByYou says which).
 */
export async function findWorkingConnection(
  ctx: ToolContext,
  pluginId: string,
  authId: string,
  opts: { connectionId?: string; exclude?: Set<string>; userId?: string } = {},
): Promise<ConnectionLookup> {
  const list = await listUserConnections(ctx, pluginId, authId)
  const ids = new Set(list.map(connectionIdOf).filter((s): s is string => !!s))
  const userId = opts.userId ?? (await currentUserId(ctx))
  const toConnection = (c: Row, id: string): WorkingConnection => ({
    id,
    type: str(c.type) ?? 'Basic',
    label: maybeRedactText(str(c.connection_label), ctx.stripRunData, 80),
    ownedByYou: !!userId && str(c.user_id) === userId,
  })
  if (opts.connectionId) {
    const c = list.find((x) => connectionIdOf(x) === opts.connectionId)
    if (!c) fail(`Connection ${opts.connectionId} is not a connection of this connection version in this org.`)
    return (await connectionValid(ctx, opts.connectionId))
      ? { connection: toConnection(c, opts.connectionId), teammates: 0, ids }
      : { teammates: 0, ids }
  }
  const candidates = list
    .map((c) => ({ c, id: connectionIdOf(c) }))
    .filter((x): x is { c: Row; id: string } => !!x.id && !listedExpired(x.c) && !opts.exclude?.has(x.id))
    .sort((x, y) => recency(y.c) - recency(x.c))
  const own = userId ? candidates.filter((x) => str(x.c.user_id) === userId) : []
  for (const x of own.slice(0, MAX_VALIDITY_CHECKS)) {
    if (await connectionValid(ctx, x.id)) return { connection: toConnection(x.c, x.id), teammates: candidates.length - own.length, ids }
  }
  return { teammates: candidates.length - own.length, ids }
}

interface AuthTarget {
  pluginId: string
  plugin: Row
  authId: string
  authType: string | undefined
  version: string | undefined
  actionId?: string
}

/** Connection version to check: explicit, else the action's version, else the open connection page, else the default. */
async function resolveAuthTarget(
  ctx: ToolContext,
  a: { pluginId?: string | undefined; authId?: string | undefined; actionId?: string | undefined },
): Promise<AuthTarget> {
  let pluginId = a.pluginId
  let authId = a.authId
  let actionId = a.actionId ?? pageActionId(ctx)
  let actionGaveAuth = false
  if (!authId && actionId) {
    const t = await resolveVersionTarget(ctx, { actionId })
    authId = str(t.version.authid)
    pluginId ??= t.pluginId
    actionId = t.actionId
    actionGaveAuth = true
  }
  pluginId = requirePluginId(ctx, pluginId)
  const [plugin, auths] = await Promise.all([
    dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
    dhGetFields(ctx, 'oauth_details', 'getAuthDetails', pluginId, ['rowid', 'type', 'authversion']),
  ])
  authId ??= pageAuthId(ctx) ?? str(plugin.preferedauthversion)
  if (!authId) {
    fail(auths.length ? 'Which connection version? Pass authId (see dh_get_plugin).' : 'This plug has no connection yet. Create one with dh_create_connection.')
  }
  const auth = auths.find((x) => x.rowid === authId)
  if (!auth) fail(`Connection version ${authId} does not belong to plug ${pluginId}.`)
  // The open page's action may sit on another connection version; the connect link must name an action of this one,
  // so drop it and let the caller pick one that uses authId.
  if (actionId && !actionGaveAuth) {
    const usesAuth = await resolveVersionTarget(ctx, { actionId })
      .then((t) => str(t.version.authid) === authId)
      .catch(() => false)
    if (!usesAuth) actionId = undefined
  }
  return { pluginId, plugin, authId, authType: str(auth.type), version: str(auth.authversion), ...(actionId ? { actionId } : {}) }
}

const TARGET_PROPS = {
  pluginId: P.pluginId,
  authId: { ...P.authId, description: 'Connection version. Defaults to the version used by actionId, the open connection page, else the plug default.' },
  actionId: { ...P.actionId, description: 'Use the connection version of this action/trigger (its latest version).' },
}
const targetSchema = { pluginId: rowId.optional(), authId: rowId.optional(), actionId: rowId.optional() }

// ---------- dh_check_connection ----------

const checkConnection = dhTool({
  name: 'dh_check_connection',
  description:
    "Check whether the user already has a working connection for a plug's connection version (skill §4.1 steps 1-2): looks " +
    'up the org\'s connections for that version and verifies the user\'s newest ones are valid. If one works, use it for ' +
    'dry runs and do NOT ask the user to connect again. If none, call dh_connect. After the user says they finished in ' +
    'the connection window, call this once (step 4). NoAuth versions need no connection.',
  properties: TARGET_PROPS,
  danger: 'safe',
  schema: z.object(targetSchema),
  describe: () => 'Checking for a working connection',
  async run(a, ctx) {
    const t = await resolveAuthTarget(ctx, a)
    if (t.authType === 'NoAuth') {
      return { pluginId: t.pluginId, authId: t.authId, connected: true, connection: { id: 'NoAuth', type: 'NoAuth' }, note: 'No connection needed.' }
    }
    const found = await findWorkingConnection(ctx, t.pluginId, t.authId)
    if (found.connection) {
      return { pluginId: t.pluginId, authId: t.authId, version: t.version, connected: true, connection: found.connection }
    }
    return {
      pluginId: t.pluginId,
      authId: t.authId,
      version: t.version,
      connected: false,
      ...(found.teammates ? { teammateConnections: found.teammates } : {}),
      tip: 'No working connection of yours for this version. Call dh_connect to open the connection window (the developer must have saved the client ID/secret first for OAuth).',
      open: authOpen(t.pluginId, t.authId),
    }
  },
})

// ---------- dh_connect ----------

/** The Developer Hub origin the auth window reports back to (skill: the environment's origin, local included). */
function openerOrigin(ctx: ToolContext): string | undefined {
  try {
    const u = new URL(ctx.page.url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined
  } catch {
    return undefined
  }
}

const connect = dhTool({
  name: 'dh_connect',
  description:
    'Get a working connection for a connection version (skill §4.1). If the user already has one it is returned without ' +
    "asking. Otherwise opens viaSocket's own connection window, where the user signs in or pastes their key (never in chat), " +
    'and returns right away: tell the user to finish there and say when it is done, then call dh_check_connection once ' +
    '(no polling). Still none after that: report the dry run as skipped, do not loop. For OAuth, the developer must first ' +
    'save the client ID and secret on the connection in the Developer Hub.',
  properties: {
    ...TARGET_PROPS,
    force: { type: 'boolean', description: 'Open the window even if a working connection exists (e.g. another account).' },
  },
  danger: 'safe',
  schema: z.object({ ...targetSchema, force: z.boolean().optional() }),
  describe: () => 'Connecting the app',
  async run(a, ctx) {
    const t = await resolveAuthTarget(ctx, a)
    if (t.authType === 'NoAuth') return { connected: true, connection: { id: 'NoAuth', type: 'NoAuth' }, note: 'No connection needed.' }
    const before = await findWorkingConnection(ctx, t.pluginId, t.authId)
    if (before.connection && !a.force) return { connected: true, alreadyConnected: true, authId: t.authId, connection: before.connection }

    const userId = await currentUserId(ctx)
    if (!userId) fail('Could not read your viaSocket user id, so the connection window cannot be opened. Ask the user to connect from the connection page.')
    // Skill: actionid is the first action of the group that uses this connection version; none → no actionid.
    let actionId = t.actionId
    if (!actionId) {
      const actions = await dhGetFields(ctx, 'actions', 'getAllActions', t.pluginId, ['rowid', 'authid', 'authidlookup', 'status'])
      const live = actions.filter((x) => str(x.status) !== 'deleted')
      actionId = str(live.find((x) => str(x.authid) === t.authId || str(x.authidlookup) === t.authId)?.rowid)
    }
    const url = new URL(`${ctx.vs.env.authBase}/auth/service/${t.pluginId}/auth/${t.authId}`)
    const query: Record<string, string | undefined> = {
      userid: userId,
      orgid: orgOf(ctx),
      actionid: actionId,
      level: 'org',
      isUserOnDH: 'true',
      isUpdate: 'false',
      serviceName: str(t.plugin.name),
      openerURL: openerOrigin(ctx),
    }
    for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)

    try {
      // From an incognito tab the window must open in incognito too, so it uses that profile's viaSocket session.
      await chrome.windows.create({
        url: url.href,
        type: 'popup',
        width: 560,
        height: 720,
        focused: true,
        ...(ctx.vs.opts.incognito ? { incognito: true } : {}),
      })
    } catch {
      fail('Could not open the connection window. Ask the user to allow popups and try again.')
    }
    ctx.ui.say('Finish connecting in the window that just opened, then tell me when it is done.')
    return {
      connected: false,
      windowOpened: true,
      authId: t.authId,
      next:
        'Ask the user to finish in the connection window and say when it is done; then call dh_check_connection once ' +
        '(same authId). If it still finds none, say the dry run was skipped (untested) and do not loop.',
      tip: 'For OAuth the client ID/secret must be saved on the connection in the Developer Hub, and the redirect URL whitelisted at the provider.',
      open: authOpen(t.pluginId, t.authId),
    }
  },
})

export const CONNECT_TOOLS: Tool<any>[] = [checkConnection, connect]
