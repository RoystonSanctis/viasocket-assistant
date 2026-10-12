// Plug-level tools: list, inspect and create plugs (custom apps).

import * as z from '../../../shared/zod'
import type { Tool } from '../types'
import { DuplicateError, dhCreate, dhGet, dhGetOne, fail, orgOf } from './api'
import { DH_PAGES, P, dhTool, label, rowId } from './define'
import { authVersionNumber, clip, flag, num, str, type Row } from './rows'
import { dhOpen, requirePluginId } from './target'

const MAX_LIST = 100

function pluginSummary(p: Row) {
  return {
    id: str(p.rowid),
    name: str(p.name),
    domain: str(p.domain),
    status: str(p.status),
    audience: str(p.audience),
    publicActionCount: num(p.actioncount),
    publicTriggerCount: num(p.triggercount),
  }
}

export function actionSummary(a: Row) {
  return {
    id: str(a.rowid),
    name: str(a.name),
    type: str(a.type),
    status: str(a.status),
    visibility: flag(a.isvisible) ? 'public' : 'private',
    publishedVersionId: str(a.actionversionrecordid),
    authId: str(a.authidlookup),
    category: str(a.category),
    description: clip(str(a.description) ?? '', 160) || undefined,
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Accepts "teable.io", "https://teable.io/x" or "api.teable.io" and returns a bare lowercase hostname. */
function toHostname(input: string): string | undefined {
  try {
    const host = new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase()
    return HOSTNAME_RE.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

const hostname = z
  .string()
  .trim()
  .max(260)
  .transform((s, c) => {
    const h = toHostname(s)
    if (!h) c.addIssue({ code: 'custom', message: 'must be a domain like "teable.io"' })
    return h ?? s
  })

const listPlugins = dhTool({
  name: 'dh_list_plugins',
  description:
    "List the plugs (custom apps) in the current viaSocket org's Developer Hub: id, name, domain, status " +
    '(unpublished / published / integration_only), audience and public action/trigger counts. Use the id as pluginId in the other dh_* tools.',
  properties: {},
  danger: 'safe',
  pages: [...DH_PAGES, 'home', 'project', 'flow-editor'],
  schema: z.object({}),
  describe: () => 'Looking at your plugs',
  async run(_a, ctx) {
    const org = orgOf(ctx)
    const rows = await dhGet(ctx, 'plugins', 'getAllPlugins', org)
    return {
      count: rows.length,
      plugs: rows.slice(0, MAX_LIST).map(pluginSummary),
      ...(rows.length > MAX_LIST ? { note: `Showing the ${MAX_LIST} most recently updated plugs.` } : {}),
    }
  },
})

const getPlugin = dhTool({
  name: 'dh_get_plugin',
  description:
    "Get one plug's details (domain, description, audience, whitelisted API domains, default connection version) plus a " +
    'compact list of its connection (auth) versions and its actions/triggers. Defaults to the plug open in the Developer Hub. ' +
    'Start here to orient yourself before editing a plug.',
  properties: { pluginId: P.pluginId },
  danger: 'safe',
  schema: z.object({ pluginId: rowId.optional() }),
  describe: () => 'Reading the plug',
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    const [plugin, auths, actions] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId).catch(() => undefined),
      dhGet(ctx, 'actions', 'getAllActions', pluginId).catch(() => undefined),
    ])
    const preferred = str(plugin.preferedauthversion)
    return {
      plug: {
        ...pluginSummary(plugin),
        description: clip(str(plugin.description) ?? '', 500) || undefined,
        category: plugin.category,
        whitelistDomains: plugin.whitelistdomains,
        defaultAuthId: preferred,
        triggersAvailable: flag(plugin.istriggeravailable),
        appSlug: str(plugin.appslugname),
      },
      connections: auths
        ?.slice()
        .sort((x, y) => authVersionNumber(x) - authVersionNumber(y))
        .map((x) => ({ id: str(x.rowid), version: str(x.authversion), type: str(x.type), isDefault: x.rowid === preferred })),
      actions: actions?.map((x) => ({ id: str(x.rowid), name: str(x.name), type: str(x.type), status: str(x.status) })),
      open: dhOpen(pluginId, 'pluginDetails'),
      ...(auths && !auths.length
        ? { tip: 'This plug has no connection yet: create one with dh_update_auth_version (createNewVersion:true, type).' }
        : {}),
    }
  },
})

const createPlugin = dhTool({
  name: 'dh_create_plugin',
  description:
    'Create a new plug (custom app) in the current org, unpublished. Plug names are unique across all of viaSocket. ' +
    'Next: create its first connection version with dh_update_auth_version (createNewVersion:true, type), then actions/triggers ' +
    'with dh_create_action.',
  properties: {
    name: { type: 'string', description: 'App name as users should see it, e.g. "Teable".' },
    domain: { type: 'string', description: 'The app\'s website domain, e.g. "teable.io".' },
    description: { type: 'string', description: 'One or two sentences about the app.' },
    whitelistDomains: {
      type: 'array',
      items: { type: 'string' },
      description: 'API hosts the plug may call, e.g. ["api.teable.io"]. Defaults to the domain.',
    },
  },
  required: ['name', 'domain'],
  danger: 'write',
  schema: z.object({
    name: z.string().trim().min(2).max(60),
    domain: hostname,
    description: z.string().trim().max(1000).optional(),
    whitelistDomains: z.array(hostname).max(20).optional(),
  }),
  describe: (a) => `Creating plug ${label(a.name)}`,
  async run(a, ctx) {
    const org = orgOf(ctx)
    const existing = (await dhGet(ctx, 'plugins', 'getAllPlugins', org)).find(
      (p) => str(p.name)?.trim().toLowerCase() === a.name.toLowerCase(),
    )
    if (existing) {
      const id = String(existing.rowid)
      return { alreadyExists: true, pluginId: id, name: str(existing.name), open: dhOpen(id, 'pluginDetails') }
    }
    const body: Row = {
      name: a.name,
      orgid: org,
      domain: a.domain,
      whitelistdomains: [...new Set(a.whitelistDomains?.length ? a.whitelistDomains : [a.domain])],
      ...(a.description ? { description: a.description } : {}),
    }
    let rows: Row[]
    try {
      rows = (await dhCreate(ctx, 'plugins', body)).rows
    } catch (e) {
      if (e instanceof DuplicateError) {
        fail(`A plug named "${a.name}" already exists in viaSocket (names are unique across all orgs). Pick a different name.`)
      }
      throw e
    }
    const id = str(rows[0]?.rowid)
    if (!id) fail('viaSocket did not return the new plug id. Check the plug list with dh_list_plugins before retrying.')
    return {
      pluginId: id,
      name: a.name,
      open: dhOpen(id, 'auth'),
      next: 'Create the first connection version with dh_update_auth_version (pluginId, createNewVersion:true, type). Call ui_navigate with the `open` arguments to show it.',
    }
  },
})

export const PLUGIN_TOOLS: Tool<any>[] = [listPlugins, getPlugin, createPlugin]
