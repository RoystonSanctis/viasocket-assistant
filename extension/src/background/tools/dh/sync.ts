// Keeps the open Developer Hub page consistent after a write. The DH UI keeps its data in Redux and only refetches
// on navigation, but it applies RTLayer "updated" events, so we push the same event shape its own AI uses.
// Reloading is never done here: the user may have unsaved edits, so the agent decides (ui_refresh_page asks first).

import type { ToolContext } from '../types'
import { sleep } from '../flow/util'
import { dhGet, isSafeThread, pushRtlayer } from './api'
import { isRow, obj, str, type Row } from './rows'
import { openEditorVersionId, pagePluginId } from './target'

export interface PageSync {
  /** true when the change was pushed to the open page as a live update */
  live: boolean
  hint: string
}

const REFRESH_HINT =
  'The open Developer Hub page may still show the old data. If the user has no unsaved edits there, call ui_refresh_page.'
const LIVE_HINT = 'Pushed live to the open page. Only if it still shows the old data, call ui_refresh_page.'

function result(live: boolean): PageSync {
  return { live, hint: live ? LIVE_HINT : REFRESH_HINT }
}

// Editor and connection pages subscribe to RTLayer about 3s after mounting and events sent earlier are lost (ttl 1).
const EDITOR_SUBSCRIBE_MS = 4000
let seenPage: { key: string; at: number } | undefined

/**
 * Remembers when the agent first saw the current page URL. Called for every Developer Hub tool call, so it is a
 * close (and conservative) stand-in for when the editor mounted.
 */
export function notePage(ctx: ToolContext): void {
  const key = ctx.page.url.split('#')[0] ?? ''
  if (seenPage?.key !== key) seenPage = { key, at: Date.now() }
}

/** Waits until a freshly opened editor is likely subscribed, so a live update is not pushed into the void. */
async function editorReady(ctx: ToolContext): Promise<void> {
  notePage(ctx)
  const wait = EDITOR_SUBSCRIBE_MS - (Date.now() - (seenPage?.at ?? 0))
  if (wait <= 0) return
  ctx.ui.thinking('Waiting for the editor to load')
  await sleep(wait, ctx.signal)
}

/** The editor listens on `${orgId}-${metadata.chatbotthreadid || versionId}`. */
function editorThread(version: Row): string | undefined {
  const raw = obj(version.metadata)?.chatbotthreadid
  if (raw !== undefined && raw !== null && raw !== '') {
    const t = str(raw)
    return isSafeThread(t) ? t : undefined
  }
  const id = str(version.rowid)
  return isSafeThread(id) ? id : undefined
}

/**
 * Pushes the changed columns of a version into the editor, but only when that exact version is open: the editor
 * merges 'action_version' events into whatever version is in the URL, regardless of the row id in the event.
 * Only changed keys are sent so a slider the user is still typing in is not overwritten with the stored copy.
 */
export async function syncVersion(ctx: ToolContext, before: Row, changes: Row, updated: Row | undefined): Promise<PageSync | undefined> {
  const id = str(before.rowid)
  if (!id || openEditorVersionId(ctx) !== id) return undefined
  const entry: Row = { rowid: id }
  for (const k of Object.keys(changes)) {
    if (k === 'removeScheduleTimeOptions') continue
    entry[k] = updated && k in updated ? updated[k] : changes[k]
  }
  // The server rebuilds metadata (save log, polling intervals); inputjson steps/blocks come from the loop above.
  if (updated && isRow(updated.metadata)) entry.metadata = updated.metadata
  const thread = editorThread(before)
  if (!thread) return result(false)
  await editorReady(ctx)
  return result(await pushRtlayer(ctx, thread, { updated: true, data: { type: 'action_version', updatedEntry: entry } }))
}

/** Upserts an actions row into the open editor's sidebar list. */
export async function syncActionRow(ctx: ToolContext, pluginId: string, actionRow: Row): Promise<PageSync | undefined> {
  if (pagePluginId(ctx) !== pluginId) return undefined
  const openVersion = openEditorVersionId(ctx)
  if (!openVersion) return result(false)
  let thread: string | undefined
  try {
    const [row] = await dhGet(ctx, 'action_version', 'dhGetParticularFieldApi', openVersion, ['rowid', 'metadata'])
    thread = editorThread(row ?? { rowid: openVersion })
  } catch {
    thread = openVersion
  }
  if (!thread) return result(false)
  await editorReady(ctx)
  return result(await pushRtlayer(ctx, thread, { updated: true, data: { type: 'actions', updatedEntry: actionRow } }))
}

/**
 * Connection pages listen on `${orgId}-${pluginId}`. requestPayload must use the stored encoding (code fields and
 * queryparams as JSON strings) because the page JSON.parses those keys. Secrets are never included.
 */
export async function syncConnection(
  ctx: ToolContext,
  pluginId: string,
  event: { kind: 'update'; authId: string; requestPayload: Row } | { kind: 'create'; requestPayload: Row; row: Row },
): Promise<PageSync | undefined> {
  if (pagePluginId(ctx) !== pluginId) return undefined
  const requestPayload = withoutSecrets(event.requestPayload)
  const data =
    event.kind === 'update'
      ? {
          updated: true,
          data: { type: 'oauth_details', updatedEntry: { requestPayload, response: { rowid: event.authId, pluginrecordid: pluginId } } },
        }
      : { type: 'oauth_details', data: { requestPayload, response: withoutSecrets(event.row) } }
  await editorReady(ctx)
  return result(await pushRtlayer(ctx, pluginId, data))
}

function withoutSecrets(row: Row): Row {
  const { clientsecret: _secret, ...rest } = row
  return rest
}

/** Pushes a component mapping into the open editor of that exact version (created → the create event shape). */
export async function syncMapping(ctx: ToolContext, version: Row, mappingRow: Row, created: boolean): Promise<PageSync | undefined> {
  const id = str(version.rowid)
  if (!id || openEditorVersionId(ctx) !== id) return undefined
  const thread = editorThread(version)
  if (!thread) return result(false)
  await editorReady(ctx)
  const data = created
    ? { type: 'COMPONENT_MAPPING_CREATE_BY_AI', data: { createdEntry: mappingRow } }
    : { updated: true, data: { type: 'action_version_component_table', updatedEntry: mappingRow } }
  return result(await pushRtlayer(ctx, thread, data))
}
