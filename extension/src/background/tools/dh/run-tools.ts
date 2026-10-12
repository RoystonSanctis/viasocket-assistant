// Dry runs and publishing. Both reach beyond the draft: a dry run calls the real third-party API with the user's
// connection, and publishing makes a version usable in flows and locks it. Both are 'confirm' tools.

import * as z from '../../../shared/zod'
import { VsError } from '../viasocket-client'
import type { Tool, ToolContext } from '../types'
import { maybeRedactText, redactKey, redactText, shapeOf } from '../redact'
import { cleanError, currentUserId, dhGet, dhGetOne, dhUpdate, fail, listUserConnections, orgOf } from './api'
import { P, dhTool, rowId } from './define'
import { dryRunSummary, recordDryRun } from './dry-run-log'
import {
  CODE_SLIDERS, clip, clipJson, fitJson, flag, isRow, obj, requiredForPublish, rowsOf, slidersFor, str, triggerTypeOf,
  type CodeSlider, type Row,
} from './rows'
import { syncActionRow, syncVersion } from './sync'
import { openEditorVersionId, pageActionId, resolveVersionTarget, type VersionTarget } from './target'

// ---------- dry run ----------

const IDENT_RE = /^[A-Za-z_$][\w$]*$/

/** function_code is what executes; rebuild it from code+params only when a legacy row lacks it. */
function componentSource(c: Row): string {
  const fn = str(c.function_code)
  if (fn?.trim()) return fn
  const name = str(c.function_name)
  const body = str(c.code)
  if (!name || !body || !IDENT_RE.test(name)) return ''
  const params = rowsOf(c.params)
    .map((p) => str(p.name))
    .filter((p): p is string => !!p && IDENT_RE.test(p))
  return `async function ${name}(${params.join(', ')}) {\n${body}\n}`
}

/** The DH editor prepends the code of EVERY component mapped to the version, whatever slider it is mapped to. */
async function mappedComponents(ctx: ToolContext, t: VersionTarget): Promise<{ code: string; names: string[] }> {
  const [mappings, components] = await Promise.all([
    dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', t.versionId),
    dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', t.pluginId),
  ])
  const ids = new Set(mappings.map((m) => str(m.component_id)).filter(Boolean))
  const used = components.filter((c) => ids.has(str(c.rowid)))
  const sources = used.map(componentSource).filter((s) => s.trim())
  return { code: sources.join('\n'), names: used.map((c) => str(c.function_name) ?? String(c.rowid)) }
}

interface AuthChoice {
  authData: { id: string; type: string }
  label: string
}

async function chooseConnection(ctx: ToolContext, t: VersionTarget, connectionId: string | undefined): Promise<AuthChoice> {
  const authId = str(t.version.authid)
  if (!authId) fail('This version has no connection version. Set one with dh_update_action_version (authId) first.')
  let authType = str(t.version.authtype)
  if (!authType) {
    const auths = await dhGet(ctx, 'oauth_details', 'getAuthDetails', t.pluginId)
    authType = str(auths.find((x) => x.rowid === authId)?.type)
  }
  if (authType === 'NoAuth') return { authData: { id: 'NoAuth', type: 'NoAuth' }, label: 'No authentication' }

  const list = await listUserConnections(ctx, t.pluginId, authId)
  if (connectionId) {
    const c = list.find((x) => x.id === connectionId)
    if (!c) fail(`Connection ${connectionId} is not a connection of this plug's connection version in this org.`)
    return { authData: { id: connectionId, type: str(c.type) ?? authType ?? 'Basic' }, label: str(c.connection_label) ?? connectionId }
  }
  const usable = list
    .filter((c) => str(c.id) && !flag(c.isExpired) && !flag(obj(c.meta_data)?.isExpired))
    .sort((x, y) => (Date.parse(str(y.manually_updated_at) ?? '') || 0) - (Date.parse(str(x.manually_updated_at) ?? '') || 0))
  if (!usable.length) {
    fail(
      "The user has no working connection for this plug's connection version yet, so nothing can be dry-run. Ask them to " +
        'open the connection page of this plug and click Authorize (or connect the app in a flow), then retry.',
    )
  }
  // The list holds every org-shared connection, teammates' included; only the user's own is picked implicitly.
  const userId = await currentUserId(ctx)
  const c = userId ? usable.find((x) => str(x.user_id) === userId) : undefined
  if (!c) {
    const others = usable
      .slice(0, 5)
      .map((x) => `${String(x.id)} (${maybeRedactText(str(x.connection_label) ?? 'unlabelled', ctx.stripRunData, 60)})`)
    fail(
      `${userId ? "Only teammates' working connections exist" : "Could not tell which connections are the user's own"} for ` +
        `this connection version: ${others.join(', ')}. Pass connectionId only if the user agrees to run in that account, ` +
        "or ask them to authorize their own connection on the plug's connection page.",
    )
  }
  return { authData: { id: String(c.id), type: str(c.type) ?? authType ?? 'Basic' }, label: str(c.connection_label) ?? String(c.id) }
}

/** stripRunData view of a dry-run value: structure and value shapes only; keepText keeps (masked) wording of strings. */
function shapeTree(v: unknown, keepText: boolean, depth = 0): unknown {
  if (v === undefined) return undefined
  if (typeof v === 'string' && keepText) return redactText(v, 500)
  if (Array.isArray(v)) {
    if (depth >= 6) return `[array(${v.length})]`
    const out = v.slice(0, 3).map((x) => shapeTree(x, keepText, depth + 1))
    if (v.length > 3) out.push(`…${v.length - 3} more`)
    return out
  }
  if (isRow(v)) {
    if (depth >= 6) return '[object]'
    const out: Row = {}
    const keys = Object.keys(v)
    for (const k of keys.slice(0, 40)) out[redactKey(k)] = shapeTree(v[k], keepText, depth + 1)
    if (keys.length > 40) out['…'] = `${keys.length - 40} more keys`
    return out
  }
  return shapeOf(v)
}

/** Shows the user what model-written code will run and which hosts it talks to, before they approve the dry run. */
function codePreview(code: string): string {
  const hosts = [...new Set([...code.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]))].slice(0, 5)
  const head = code.length > 400 ? `${code.slice(0, 400)}…` : code
  return `\n\nCode to run${hosts.length ? ` (calls ${hosts.join(', ')})` : ''}:\n${head}`
}

function vmErrorMessage(e: VsError): string {
  const vm = obj(obj(e.body)?.data)
  const msg = str(vm?.message) ?? str(obj(vm?.data)?.errMessage) ?? e.message
  return clip(msg, 1500)
}

const dryRun = dhTool({
  name: 'dh_dry_run',
  description:
    "Run one code slider of an action/trigger version in viaSocket's sandbox against the REAL app API, using the user's own " +
    'latest connection for this plug (unless connectionId is given). Returns success, message (the returned value, or the ' +
    'thrown error) and console logs. Write actions really create/change/delete data and performsubscribe/' +
    'performunsubscribe really register/remove webhooks, so prefer read-only sliders and test data. inputData holds input field ' +
    'values by key; string values are evaluated as JS template literals, so ${...} inside them is interpolated. Pass `code` to ' +
    'test code before saving it (the saved slider is used otherwise). For modifytriggerdata, pass triggerPayload as the ' +
    'incoming webhook body. The mapped reusable components are included automatically.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    slider: {
      type: 'string',
      enum: [...CODE_SLIDERS],
      description: 'Slider to run. Default: perform for actions, performlist for triggers.',
    },
    inputData: { type: 'object', description: 'Input field values keyed by input field key.' },
    connectionId: {
      type: 'string',
      description: "A connection id of this plug in the org (may be a teammate's). Usually omit it to use the user's own.",
    },
    code: { type: 'string', description: 'Unsaved slider code to run instead of the saved code.' },
    triggerPayload: { type: 'object', description: 'modifytriggerdata only: the incoming webhook body (context.req.body).' },
  },
  danger: 'confirm',
  schema: z.object({
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    slider: z.enum(CODE_SLIDERS).optional(),
    inputData: z.record(z.string().max(80), z.unknown()).optional(),
    connectionId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    code: z.string().max(200_000).optional(),
    triggerPayload: z.record(z.string(), z.unknown()).optional(),
  }),
  describe: (a) => `Test-running ${a.slider ?? 'the code'}`,
  confirmText(a) {
    const slider = a.slider ?? 'the main slider'
    const webhook = a.slider === 'performsubscribe' || a.slider === 'performunsubscribe'
    return (
      `Run ${slider}${a.code ? ' (unsaved code written by the assistant)' : ''} against the real app ` +
      `${a.connectionId ? `using connection ${a.connectionId} (possibly a teammate's)` : 'using your own connection for this plug'}. ` +
      (webhook
        ? 'This really registers or removes a webhook in the app.'
        : 'If it is a write action it really creates, changes or deletes data in the app.') +
      (a.code ? codePreview(a.code) : '')
    )
  },
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, a)
    const v = t.version
    const triggerType = triggerTypeOf(v)
    const slider: CodeSlider = a.slider ?? (t.kind === 'trigger' ? 'performlist' : 'perform')
    const visible = slidersFor(t.kind, triggerType)
    if (!visible.includes(slider)) fail(`This ${t.kind === 'trigger' ? `${triggerType} trigger` : 'action'} has no ${slider} slider. Use one of: ${visible.join(', ')}.`)
    const sliderCode = a.code ?? str(v[slider]) ?? ''
    if (!sliderCode.trim()) fail(`The ${slider} slider of ${str(v.versionid)} has no saved code. Save it with dh_update_action_version or pass code.`)
    if (JSON.stringify(a.inputData ?? {}).length > 200_000) fail('inputData is too large.')

    const [auth, components] = await Promise.all([chooseConnection(ctx, t, a.connectionId), mappedComponents(ctx, t)])
    const inputjson = obj(v.inputjson) ?? {}
    const body = {
      type: 'plugin',
      code: {
        source: components.code ? `${components.code}\n${sliderCode}` : sliderCode,
        selectedValues: { authData: auth.authData, inputData: a.inputData ?? {} },
        actionVersionId: t.versionId,
        inputFieldsBlocks: obj(inputjson.blocks) ?? {},
        inputFieldsSteps: obj(inputjson.steps) ?? {},
      },
      name: 'plugin',
      stepId: t.versionId,
      variables: { context: { req: { body: a.triggerPayload ?? {}, headers: {}, query: {} }, res: {}, vals: {} } },
      // The DH editor always sends perform/action, even for trigger sliders: the source decides what runs.
      performType: 'perform',
      pluginType: 'action',
      // Tells the server not to prepend component code again (we already did, from fresh data).
      isUserOnDh: true,
      shouldLimitResponse: true,
    }

    const base = {
      slider,
      versionId: t.versionId,
      version: str(v.versionid),
      connection: maybeRedactText(auth.label, ctx.stripRunData, 80),
      componentsIncluded: components.names,
      ...(a.code ? { ranUnsavedCode: true } : {}),
    }
    let res: unknown
    try {
      res = await ctx.vs.request<unknown>({ method: 'POST', path: `/${encodeURIComponent(orgOf(ctx))}/devhubPluginPreview/execute`, body, signal: ctx.signal })
    } catch (e) {
      if (e instanceof VsError && e.status === 400 && /VM execution service error/i.test(e.message)) {
        if (!a.code) recordDryRun(t.versionId, slider, false)
        const error = vmErrorMessage(e)
        return {
          ...base,
          success: false,
          error: maybeRedactText(error, ctx.stripRunData, 1500),
          ...(/invalid authentication/i.test(error) ? { tip: 'The selected connection is not usable in this org; pass another connectionId.' } : {}),
        }
      }
      throw cleanError(e)
    }

    const d = obj(obj(res)?.data) ?? {}
    const success = flag(d.success)
    if (!a.code) recordDryRun(t.versionId, slider, success)
    const consoleLines = Array.isArray(d.console) ? d.console : []
    const strip = ctx.stripRunData
    // A failed run's message is the thrown error, whose wording is needed to fix the code.
    const message = strip ? shapeTree(d.message, !success) : d.message
    return {
      ...base,
      success,
      message: fitJson(message, Math.max(1500, Math.floor(ctx.maxResultChars * 0.55))),
      console: consoleLines.slice(-30).map((l) => (strip ? redactText(clipJson(l, 2000), 300) : clipJson(l, 300))),
      ...(typeof d.updatedSource === 'string'
        ? { updatedSource: true, note: 'viaSocket ran a cached AI-updated version of this slider instead of the code sent.' }
        : {}),
      ...(flag(d.dryRunResponseTruncated) || d.truncated ? { responseTruncated: true } : {}),
      ...(strip ? { redacted: 'Privacy mode: values are replaced by their shapes and personal data in text is masked.' } : {}),
    }
  },
})

// ---------- publish ----------

const publish = dhTool({
  name: 'dh_publish_action_version',
  description:
    'Publish (share) an action/trigger version so it can be used in flows: privately (only this org) or publicly (every ' +
    "viaSocket user; needs the plug's audience to be Public). Omitting visibility keeps the action's current one (private for a " +
    'first publish). The version becomes read-only, so set sample data and everything else first, and dry-run the required ' +
    'sliders (action: perform; hook trigger: performsubscribe, performunsubscribe, performlist; polling: perform, performlist; ' +
    'manual_webhook: performlist). publishDescription is the release note.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    publishDescription: { type: 'string', description: 'Release note, e.g. "Initial release" or "Adds pagination".' },
    visibility: {
      type: 'string',
      enum: ['private', 'public'],
      description: 'Default: keep the current visibility (private for a first publish).',
    },
    actionDescription: { type: 'string', description: 'Only if the action has no description yet (required to publish).' },
  },
  required: ['publishDescription'],
  danger: 'confirm',
  schema: z.object({
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    publishDescription: z.string().trim().min(3).max(500),
    visibility: z.enum(['private', 'public']).optional(),
    actionDescription: z.string().trim().min(5).max(1000).optional(),
  }),
  describe: () => 'Publishing the version',
  confirmText(a, ctx) {
    // The open editor's version only stands in for the target when the call is about the open action.
    const sameAction = !a.actionId || a.actionId === pageActionId(ctx)
    const vid = a.versionId ?? (sameAction ? openEditorVersionId(ctx) : undefined)
    const which = a.versionId
      ? `version ${a.versionId}`
      : sameAction
        ? 'the open (or latest) version'
        : `the latest version of action ${a.actionId}`
    const audience =
      a.visibility === 'public'
        ? 'publicly, for every viaSocket user'
        : a.visibility === 'private'
          ? 'privately, for your org only (removing it from the public listing if it is public today)'
          : 'with its current visibility (private if it was never published)'
    return (
      `Publish ${which} ${audience}, with the note "${clip(a.publishDescription, 120)}". Flows can start using it and the ` +
      `version becomes read-only. ${vid ? dryRunSummary(vid) : 'Dry-run status of the target version is unknown.'}`
    )
  },
  async run(a, ctx) {
    const t = await resolveVersionTarget(ctx, a)
    const v = t.version
    const tag = str(v.versionid) ?? t.versionId
    const typeKey = str(t.action.type)
    if (typeKey !== 'action' && typeKey !== 'trigger') fail(`Publishing ${typeKey ?? 'this'} entities is not supported here.`)
    const triggerType = triggerTypeOf(v)
    const authId = str(v.authid)
    if (!authId) fail(`${tag} has no connection version. Set one with dh_update_action_version (authId) first.`)
    const missing = requiredForPublish(t.kind, triggerType).filter((s) => !str(v[s])?.trim())
    if (missing.length) fail(`${tag} has no saved code for ${missing.join(', ')}. Save and dry-run it before publishing.`)
    const hasDescription = !!str(t.action.description)?.trim()
    if (!hasDescription && !a.actionDescription) fail('The action has no description, which publishing requires. Pass actionDescription.')

    const plugin = await dhGetOne(ctx, 'plugins', 'getPluginDetails', t.pluginId, 'Plug')
    const currentlyPublic = str(t.action.status) === 'published' && flag(t.action.isvisible)
    const isPublic = a.visibility ? a.visibility === 'public' : currentlyPublic
    if (isPublic && str(plugin.audience) !== 'Public') {
      const audience = str(plugin.audience) ?? 'not set'
      fail(
        a.visibility
          ? `Public publishing needs the plug audience "Public" (it is "${audience}"). Publish privately, or ask the user to change the audience in the plug details.`
          : `The action is public today but the plug audience is "${audience}". Ask the user, then pass visibility explicitly ("private" removes it from the public listing).`,
      )
    }
    const alreadyLive =
      str(v.status) === 'published' &&
      str(t.action.actionversionrecordid) === t.versionId &&
      str(t.action.status) === 'published' &&
      flag(t.action.isvisible) === isPublic
    if (alreadyLive) return { alreadyPublished: true, versionId: t.versionId, version: tag, visibility: isPublic ? 'public' : 'private' }

    // Order matters: the action pointer first, then the version status (after which the version is locked).
    ctx.ui.thinking('Pointing the action at this version')
    const previous: Row = {
      actionversionrecordid: str(t.action.actionversionrecordid) ?? '',
      status: str(t.action.status) ?? 'unpublished',
      type: typeKey,
      isvisible: flag(t.action.isvisible),
    }
    const previousAuth = str(t.action.authidlookup)
    if (previousAuth) previous.authidlookup = previousAuth
    const step1: Row = { actionversionrecordid: t.versionId, status: 'published', type: typeKey, authidlookup: authId, isvisible: isPublic }
    if (!hasDescription && a.actionDescription) step1.description = a.actionDescription
    const actionRow = await dhUpdate(ctx, 'actions', 'updateActionDetails', t.actionId, step1)

    ctx.ui.thinking('Marking the version published')
    const verification = str(v.verificationstatus)
    const step2: Row = { versionid: tag, status: 'published', publishdescription: a.publishDescription }
    if (!verification || verification === 'NOT_VERIFIED' || verification === 'L2_REJECTED') step2.verificationstatus = 'L1_VERIFIED'
    let versionRow: Row | undefined
    try {
      versionRow = await dhUpdate(ctx, 'action_version', 'updateActionVersionDetails', t.versionId, step2)
    } catch (e) {
      const reason = (e as Error).message
      // Otherwise flows would run a version that is still an editable draft.
      let restored = false
      try {
        await dhUpdate(ctx, 'actions', 'updateActionDetails', t.actionId, previous)
        restored = true
      } catch {
        // reported below
      }
      fail(
        restored
          ? `Marking ${tag} published failed (${reason}), so the action was restored to its previous state. Retry dh_publish_action_version.`
          : `The action now points at ${tag}, but marking the version published failed (${reason}) and restoring the previous pointer failed too. Retry dh_publish_action_version to finish.`,
      )
    }

    const notes: string[] = []
    if (t.kind === 'trigger' && !flag(plugin.istriggeravailable)) {
      try {
        await dhUpdate(ctx, 'plugins', 'updatePluginDetails', t.pluginId, { istriggeravailable: true })
      } catch {
        notes.push('Could not mark the plug as having triggers; users may not see the trigger until that is fixed in the plug details.')
      }
    }
    const [versionSync, actionSync] = await Promise.all([
      syncVersion(ctx, v, step2, versionRow),
      actionRow ? syncActionRow(ctx, t.pluginId, actionRow) : Promise.resolve(undefined),
    ])
    const page = [versionSync, actionSync].find((p) => p && !p.live) ?? versionSync ?? actionSync
    return {
      published: true,
      actionId: t.actionId,
      versionId: t.versionId,
      version: tag,
      visibility: isPublic ? 'public' : 'private',
      ...(currentlyPublic && !isPublic ? { demotedFromPublic: true } : {}),
      ...(notes.length ? { notes } : {}),
      ...(page ? { page } : {}),
    }
  },
})

export const RUN_TOOLS: Tool<any>[] = [dryRun, publish]
