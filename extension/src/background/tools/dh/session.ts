// In-memory facts about this service-worker session, keyed by API host + org so environments never mix.
// Lost when the worker restarts, which only makes the dependent rules stricter (e.g. a plug no longer counts as
// "created in this run").

import type { ToolContext } from '../types'

const MAX = 200

function key(ctx: ToolContext, id: string): string {
  return `${ctx.vs.env.apiBase}|${ctx.vs.orgId ?? ''}|${id}`
}

function bounded(set: Set<string>, k: string): void {
  set.delete(k)
  set.add(k)
  if (set.size > MAX) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

const createdPlugs = new Set<string>()
const createdActions = new Set<string>()
const mergedVersions = new Set<string>()
const freshMappings = new Set<string>()
const cachedSources = new Set<string>()

/** Plugs created by dh_create_plugin in this session: the only ones the new-plug rules (brand details, audience) treat as new. */
export function markPlugCreated(ctx: ToolContext, pluginId: string): void {
  bounded(createdPlugs, key(ctx, pluginId))
}

export function plugCreatedHere(ctx: ToolContext, pluginId: string): boolean {
  return createdPlugs.has(key(ctx, pluginId))
}

/** Actions created by dh_create_action in this session: the skill's isaiaction rule applies to them without asking. */
export function markActionCreated(ctx: ToolContext, actionId: string): void {
  bounded(createdActions, key(ctx, actionId))
}

export function actionCreatedHere(ctx: ToolContext, actionId: string): boolean {
  return createdActions.has(key(ctx, actionId))
}

/**
 * Versions whose dry run came back with updatedSource: viaSocket ran a cached AI-updated copy of the code instead of
 * the saved code. Later runs of such a version always ask first, because the code that runs may not be the code shown.
 */
export function markCachedSource(ctx: ToolContext, versionId: string): void {
  bounded(cachedSources, key(ctx, versionId))
}

export function cachedSourceSeen(ctx: ToolContext, versionId: string): boolean {
  return cachedSources.has(key(ctx, versionId))
}

/** The action MERGE after a draft update (isaiaction, aiorgid, note) is done once per version per session. */
export function versionMerged(ctx: ToolContext, versionId: string): boolean {
  return mergedVersions.has(key(ctx, versionId))
}

export function markVersionMerged(ctx: ToolContext, versionId: string): void {
  bounded(mergedVersions, key(ctx, versionId))
}

/** Versions that got a new component mapping: the server's mapped-component cache may not include it yet. */
export function markMappingChanged(ctx: ToolContext, versionId: string): void {
  bounded(freshMappings, key(ctx, versionId))
}

export function mappingChangedHere(ctx: ToolContext, versionId: string): boolean {
  return freshMappings.has(key(ctx, versionId))
}
