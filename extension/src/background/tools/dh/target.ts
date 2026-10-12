// Works out which plug / action / version a tool call is about, defaulting to what the user has open.

import type { ToolContext } from '../types'
import { ROW_ID_RE, assertRowId, dhGet, dhGetOne, fail } from './api'
import { kindOf, liveVersions, str, type EntityKind, type Row } from './rows'

const ACTION_SECTIONS = new Set(['action', 'trigger', 'customAction'])

function pageQuery(ctx: ToolContext, key: string): string | undefined {
  try {
    return new URL(ctx.page.url).searchParams.get(key) ?? undefined
  } catch {
    return undefined
  }
}

export function pagePluginId(ctx: ToolContext): string | undefined {
  const id = ctx.page.kind === 'developer-hub-plugin' ? ctx.page.pluginId : undefined
  return id && ROW_ID_RE.test(id) ? id : undefined
}

export function pageActionId(ctx: ToolContext): string | undefined {
  const p = ctx.page
  if (p.kind !== 'developer-hub-plugin' || !ACTION_SECTIONS.has(p.sectionKey ?? '')) return undefined
  return p.sectionId && ROW_ID_RE.test(p.sectionId) ? p.sectionId : undefined
}

export function pageAuthId(ctx: ToolContext): string | undefined {
  const p = ctx.page
  if (p.kind !== 'developer-hub-plugin' || p.sectionKey !== 'auth') return undefined
  return p.sectionId && ROW_ID_RE.test(p.sectionId) ? p.sectionId : undefined
}

/** The action version shown in the open action/trigger editor (?versionId=), if any. */
export function openEditorVersionId(ctx: ToolContext): string | undefined {
  if (!pageActionId(ctx)) return undefined
  const v = pageQuery(ctx, 'versionId')
  return v && ROW_ID_RE.test(v) ? v : undefined
}

export function requirePluginId(ctx: ToolContext, arg: string | undefined): string {
  const id = arg ?? pagePluginId(ctx)
  if (!id) fail('Which plug? Pass pluginId (see dh_list_plugins) or open the plug in the Developer Hub.')
  return assertRowId(id, 'Plug id')
}

/**
 * ui_navigate arguments that open a Developer Hub page. Results carry these instead of URLs because the model
 * may never hand the extension a URL to open; ui_navigate rebuilds the path from validated ids.
 */
export interface DhOpen {
  to: 'dh-section'
  pluginId: string
  sectionKey: 'pluginDetails' | 'auth' | EntityKind
  sectionId?: string
  versionId?: string
}

export function dhOpen(pluginId: string, sectionKey: DhOpen['sectionKey'], sectionId?: string, versionId?: string): DhOpen {
  return { to: 'dh-section', pluginId, sectionKey, ...(sectionId ? { sectionId } : {}), ...(versionId ? { versionId } : {}) }
}

export function editorOpen(pluginId: string, kind: EntityKind, actionId: string, versionId: string): DhOpen {
  return dhOpen(pluginId, kind, actionId, versionId)
}

export interface VersionTarget {
  action: Row
  actionId: string
  pluginId: string
  kind: EntityKind
  /** Non-deleted versions, oldest first */
  versions: Row[]
  version: Row
  versionId: string
  latest: Row
}

/**
 * Resolves the action and one of its versions. Explicit ids win; otherwise the version open in the editor, then
 * the latest version of the open (or given) action.
 */
export async function resolveVersionTarget(
  ctx: ToolContext,
  args: { actionId?: string | undefined; versionId?: string | undefined },
): Promise<VersionTarget> {
  let actionId = args.actionId
  if (!actionId && args.versionId) {
    const row = await dhGetOne(ctx, 'action_version', 'dhGetParticularFieldApi', args.versionId, 'Version')
    actionId = str(row.actionid)
  }
  actionId ??= pageActionId(ctx)
  if (!actionId) fail('Which action or trigger? Pass actionId (see dh_list_actions) or open it in the Developer Hub.')
  assertRowId(actionId, 'Action id')

  const [action, allVersions] = await Promise.all([
    dhGetOne(ctx, 'actions', 'getActionDetails', actionId, 'Action'),
    dhGet(ctx, 'action_version', 'getActionVersions', actionId),
  ])
  // getActionDetails also returns soft-deleted actions, and writing to one would revive it.
  if (str(action.status) === 'deleted') fail(`Action ${actionId} was deleted. Use dh_list_actions to find a current one.`)
  const versions = liveVersions(allVersions)
  const latest = versions[versions.length - 1]
  if (!latest) fail(`Action ${actionId} has no versions left (all deleted).`)

  const wanted = args.versionId ?? openEditorVersionId(ctx)
  const fromWanted = wanted ? versions.find((v) => v.rowid === wanted) : undefined
  if (args.versionId && !fromWanted) fail(`Version ${args.versionId} is deleted or does not belong to action ${actionId}.`)
  const version = fromWanted ?? latest

  const pluginId = str(action.pluginrecordid) ?? pagePluginId(ctx)
  if (!pluginId) fail(`Could not tell which plug action ${actionId} belongs to.`)
  return {
    action,
    actionId,
    pluginId: assertRowId(pluginId, 'Plug id'),
    kind: kindOf(action),
    versions,
    version,
    versionId: String(version.rowid),
    latest,
  }
}
