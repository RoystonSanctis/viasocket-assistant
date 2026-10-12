// Dry runs (skill §4.2) and publishing an action/trigger version (skill §4.3 step 2).
// A dry run calls the real third-party API with the user's connection, so a run skips the confirmation card only when
// an allowlist says it can only read: the saved code plus every mapped component is positively read-only (literal
// GETs to whitelisted hosts, nothing else that reaches out), inputData carries no template code, the connection is the
// user's own, and the slider is not a webhook subscribe/unsubscribe. Anything else asks first, with a code preview.

import * as z from '../../../shared/zod'
import { VsError } from '../viasocket-client'
import type { Tool, ToolContext } from '../types'
import { maybeRedactText, redactKey, redactText, shapeOf } from '../redact'
import { cleanError, dhGet, dhGetFields, dhGetOne, dhMerge, dhUpdate, fail, orgOf } from './api'
import { codePreview, hostRules, inputDataCode, readOnlyReasons } from './code-safety'
import { findWorkingConnection } from './connect-tools'
import { P, dhTool, label, rowId } from './define'
import { maskSecrets, maskSecretsDeep } from './text-guards'
import { dryRunSummary, recordDryRun } from './dry-run-log'
import {
  CODE_SLIDERS, clip, clipJson, fitJson, flag, flattenFields, inputFieldsOf, isRow, obj, requiredForPublish, rowsOf, slidersFor,
  str, triggerTypeOf, type CodeSlider, type Row,
} from './rows'
import { cachedSourceSeen, mappingChangedHere, markCachedSource } from './session'
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

interface Mapped {
  name: string
  source: string
}

/** Components mapped to the version, with their executable code (every one is prepended at run time). */
async function mappedComponents(ctx: ToolContext, t: VersionTarget): Promise<Mapped[]> {
  const [mappings, components] = await Promise.all([
    dhGet(ctx, 'action_version_component_table', 'dhGetUsedComponentInActionVersionDetails', t.versionId),
    dhGet(ctx, 'reusable_components', 'dhGetReusableComponentDetails', t.pluginId),
  ])
  const ids = new Set(mappings.map((m) => str(m.component_id)).filter(Boolean))
  return components
    .filter((c) => ids.has(str(c.rowid)))
    .map((c) => ({ name: str(c.function_name) ?? String(c.rowid), source: componentSource(c) }))
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

function vmErrorMessage(e: VsError): string {
  const vm = obj(obj(e.body)?.data)
  const msg = str(vm?.message) ?? str(obj(vm?.data)?.errMessage) ?? e.message
  return clip(msg, 1500)
}

interface RunPlan {
  what: string
  logKey: string
  source: string
  performType: string
  pluginType: 'action' | 'trigger'
  pluginBlockLocation?: string
  slider?: CodeSlider
}

const GENERATORS = ['source', 'optionsGenerator', 'fieldsGenerator', 'suggestionGenerator'] as const

function planField(t: VersionTarget, key: string): RunPlan {
  const v = t.version
  const block = obj(obj(obj(v.inputjson)?.blocks)?.[key])
  const field = flattenFields(inputFieldsOf(v)).find((f) => str(f.key) === key)
  if (!field && !block) fail(`${str(v.versionid)} has no input field "${key}".`)
  let source = str(block?.source)
  for (const g of GENERATORS) source ??= str(field?.[g])
  if (!source?.trim()) fail(`Input field "${key}" has no dynamic source (optionsGenerator/fieldsGenerator) saved on ${str(v.versionid)}.`)
  return {
    what: `the "${key}" field's options`,
    logKey: `field:${key}`,
    source,
    performType: 'source',
    pluginType: 'action',
    pluginBlockLocation: key,
  }
}

function planSlider(t: VersionTarget, requested: CodeSlider | undefined): RunPlan {
  const v = t.version
  const triggerType = triggerTypeOf(v)
  const slider: CodeSlider = requested ?? (t.kind === 'action' || triggerType === 'polling' ? 'perform' : 'performlist')
  const visible = slidersFor(t.kind, triggerType)
  if (!visible.includes(slider)) fail(`This ${t.kind === 'trigger' ? `${triggerType} trigger` : 'action'} has no ${slider} slider. Use one of: ${visible.join(', ')}.`)
  const source = str(v[slider]) ?? ''
  if (!source.trim()) fail(`The ${slider} slider of ${str(v.versionid)} has no saved code. Save it with dh_update_action_version first.`)
  return {
    what: slider,
    logKey: slider,
    source,
    performType: t.kind === 'action' ? 'perform' : slider,
    pluginType: t.kind === 'action' ? 'action' : 'trigger',
    slider,
  }
}

interface RunAuth {
  id: string
  type: string
  label: string
  /** false only for an explicit connectionId that belongs to a teammate */
  ownedByYou: boolean
}

async function authFor(ctx: ToolContext, t: VersionTarget, authRow: Row | undefined, connectionId: string | undefined): Promise<RunAuth> {
  const authId = str(t.version.authid)
  const authType = str(t.version.authtype) ?? str(authRow?.type)
  if (!authId || authType === 'NoAuth') {
    if (!authId && triggerTypeOf(t.version) !== 'manual_webhook') fail('This version has no connection version. Set one with dh_update_action_version (authId).')
    return { id: 'NoAuth', type: 'NoAuth', label: 'No authentication', ownedByYou: true }
  }
  const found = await findWorkingConnection(ctx, t.pluginId, authId, connectionId ? { connectionId } : {})
  if (!found.connection) {
    fail(
      connectionId
        ? `Connection ${connectionId} is expired or invalid.`
        : "The user has no working connection for this version's connection yet, so nothing can be dry-run. Call dh_connect " +
            '(it reuses a working one or opens the connection window), then retry.' +
            (found.teammates ? ` (${found.teammates} teammate connection(s) exist; pass connectionId only if the user agrees to run in that account.)` : ''),
    )
  }
  return { id: found.connection.id, type: found.connection.type, label: found.connection.label ?? found.connection.id, ownedByYou: found.connection.ownedByYou }
}

function errorText(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/** The mapped component whose name the error reports as undefined (stale server-side component cache). */
function missingComponent(message: unknown, mapped: Mapped[]): string | undefined {
  const text = errorText(message)
  if (!/ReferenceError/.test(text)) return undefined
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*) is not defined/g)) {
    const hit = mapped.find((c) => c.name === m[1])
    if (hit) return hit.name
  }
  return undefined
}

async function execute(ctx: ToolContext, body: Row): Promise<{ ok: true; data: Row } | { ok: false; error: string }> {
  try {
    const res = await ctx.vs.request<unknown>({ method: 'POST', path: `/${encodeURIComponent(orgOf(ctx))}/devhubPluginPreview/execute`, body, signal: ctx.signal })
    return { ok: true, data: obj(obj(res)?.data) ?? {} }
  } catch (e) {
    if (e instanceof VsError && e.status === 400 && /VM execution service error/i.test(e.message)) return { ok: false, error: vmErrorMessage(e) }
    throw cleanError(e)
  }
}

const dryRun = dhTool({
  name: 'dh_dry_run',
  description:
    "Test saved code of a version in viaSocket's sandbox against the REAL app API (skill §4.2), using the user's own working " +
    'connection: a dynamic field\'s options (field), an action\'s perform, a polling trigger\'s perform then performlist, a ' +
    'manual or instant trigger\'s performlist. It runs directly only when a static review finds nothing but literal GET ' +
    'calls to the plug\'s whitelisted hosts (code and every mapped component); anything else (writes, unrecognised calls, ' +
    'URLs built at run time, webhook subscribe/unsubscribe, template code in inputData, a teammate\'s connection) asks the ' +
    'user first, and a refusal means "not executed". Run parents before dependents and feed real literal values from ' +
    'earlier results into inputData; never invent ids.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    field: { type: 'string', description: 'Key of a dynamic input field to load options for (instead of a slider).' },
    slider: {
      type: 'string',
      enum: [...CODE_SLIDERS],
      description: 'Slider to run. Default: perform for actions and polling triggers, performlist for other triggers.',
    },
    inputData: {
      type: 'object',
      description:
        'Input field values keyed by field key: plain literal values from earlier results. String values are evaluated as JS ' +
        'template literals, so a value containing ${…} or a backtick is code and always needs the user\'s approval.',
    },
    connectionId: {
      type: 'string',
      description: "A specific connection id. A teammate's connection always asks the user first. Usually omit it.",
    },
    triggerPayload: { type: 'object', description: 'modifytriggerdata only: the incoming webhook body (context.req.body).' },
  },
  danger: 'write',
  confirmsInRun: true,
  // Strict: an unknown argument (e.g. unsaved `code` from the model) is refused, never silently dropped while the
  // saved code runs in its place.
  schema: z.strictObject({
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    field: z.string().trim().regex(/^[A-Za-z_$][\w$.-]{0,120}$/).optional(),
    slider: z.enum(CODE_SLIDERS).optional(),
    inputData: z.record(z.string().max(80), z.unknown()).optional(),
    connectionId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    triggerPayload: z.record(z.string(), z.unknown()).optional(),
  }),
  describe: (a) => `Test-running ${a.field ? `field ${label(a.field, 20)}` : (a.slider ?? 'the code')}`,
  async run(a, ctx) {
    if (a.field && a.slider) fail('Pass either field or slider, not both.')
    if (a.triggerPayload && a.slider !== 'modifytriggerdata') fail('triggerPayload only applies to the modifytriggerdata slider.')
    if (JSON.stringify(a.inputData ?? {}).length > 200_000) fail('inputData is too large.')
    const t = await resolveVersionTarget(ctx, a)
    // Always the SAVED code of the version (this tool takes no code argument), so what is reviewed is what is sent.
    const plan = a.field ? planField(t, a.field) : planSlider(t, a.slider)
    const authId = str(t.version.authid)
    const [plugins, auths, mapped] = await Promise.all([
      dhGetFields(ctx, 'plugins', 'getPluginDetails', t.pluginId, ['rowid', 'domain', 'whitelistdomains']),
      authId ? dhGetFields(ctx, 'oauth_details', 'getAuthDetails', t.pluginId, ['rowid', 'type', 'whitelistdomains']) : Promise.resolve([] as Row[]),
      mappedComponents(ctx, t),
    ])
    const authRow = auths.find((x) => x.rowid === authId)
    const auth = await authFor(ctx, t, authRow, a.connectionId)
    const hosts = hostRules(str(plugins[0]?.domain), plugins[0]?.whitelistdomains, authRow?.whitelistdomains)

    // Skill: run only what cannot change anything. The review is an allowlist over everything that executes: the
    // slider/field code and EVERY mapped component (the server prepends them all), plus inputData, whose string values
    // the VM compiles into template literals.
    const reasons: string[] = []
    if (plan.slider === 'performsubscribe' || plan.slider === 'performunsubscribe') reasons.push(`${plan.slider} registers or removes a webhook in the app`)
    const executed = [plan.source, ...mapped.map((c) => c.source)].filter((x) => x.trim()).join('\n;\n')
    for (const r of readOnlyReasons(executed, { hosts })) reasons.push(`the code ${r}`)
    const inputCode = inputDataCode(a.inputData ?? {})
    if (inputCode.length) reasons.push(`inputData ${inputCode.slice(0, 3).join(', ')} contains template code (\${…} or a backtick), which runs in the sandbox`)
    const teammate = !!a.connectionId && !auth.ownedByYou
    const cached = cachedSourceSeen(ctx, t.versionId)

    let confirmed = false
    if (reasons.length || ctx.mustConfirm || teammate || cached) {
      const effect = reasons.length
        ? `This may change data in the app or send data elsewhere: ${reasons.slice(0, 6).join('; ')}.`
        : 'It should only read from the app.'
      const conn =
        auth.id === 'NoAuth'
          ? 'no connection'
          : teammate
            ? `a TEAMMATE's connection "${clip(auth.label, 60)}" (not yours: it reads and changes their account)`
            : `your connection "${clip(auth.label, 60)}"`
      const cachedNote = cached
        ? ' Earlier tests of this version ran a cached AI-updated copy of the code instead of the saved code; that may happen again.'
        : ''
      const inputs = inputCode.length ? `\n\nInput values with code:\n${clip(JSON.stringify(a.inputData ?? {}), 300)}` : ''
      const ok = await ctx.ui.confirm(
        `Run ${plan.what} against the real app?`,
        `${effect} It runs ${str(t.version.versionid) ?? 'the version'} of "${clip(str(t.action.name) ?? 'the action', 60)}" with ${conn}` +
          `${mapped.length ? ` and ${mapped.length} mapped component(s)` : ''}.${cachedNote}${inputs}${codePreview(plan.source)}`,
        true,
        'Run test',
      )
      ctx.signal.throwIfAborted()
      if (!ok) return { declined: true, ran: false, message: 'The user declined: report this as reviewed but not executed.' }
      confirmed = true
    }

    const body: Row = {
      type: 'plugin',
      isUserOnDh: false,
      name: str(t.action.name) ?? 'plugin',
      performType: plan.performType,
      pluginType: plan.pluginType,
      variables: plan.slider === 'modifytriggerdata' ? { context: { req: { body: a.triggerPayload ?? {}, headers: {}, query: {} } } } : {},
      code: {
        source: plan.source,
        actionVersionId: t.versionId,
        selectedValues: { authData: { id: auth.id, type: auth.type }, inputData: a.inputData ?? {} },
      },
      ...(plan.pluginBlockLocation ? { pluginBlockLocation: plan.pluginBlockLocation } : {}),
      shouldLimitResponse: true,
    }

    let out = await execute(ctx, body)
    let retried: string | undefined
    let retryDeclined = false
    // The server prepends mapped components from a cache that a new mapping does not refresh. If a mapped component
    // is reported missing, run once more with the components prepended here (the editor's own mode). Never after the
    // VM substituted a cached source (that code was not ours), and never re-run an approved run without asking again:
    // the first attempt may already have changed data.
    const substituted = out.ok && typeof out.data.updatedSource === 'string'
    const missing = substituted ? undefined : missingComponent(out.ok ? out.data.message : out.error, mapped)
    if (missing && !(out.ok && flag(out.data.success))) {
      const code = mapped.map((c) => c.source).filter((x) => x.trim()).join('\n')
      if (code) {
        let again = true
        if (confirmed) {
          again = await ctx.ui.confirm(
            'Run the test again?',
            `The first run stopped because the mapped component ${missing} was not loaded yet. That attempt may already have ` +
              'changed data in the app before it stopped. Run it once more with the mapped components included?',
            true,
            'Run again',
          )
          ctx.signal.throwIfAborted()
        }
        if (again) {
          retried = missing
          out = await execute(ctx, { ...body, isUserOnDh: true, code: { ...(body.code as Row), source: `${code}\n${plan.source}` } })
        } else {
          retryDeclined = true
        }
      }
    }

    const base = {
      ran: plan.what,
      versionId: t.versionId,
      version: str(t.version.versionid),
      connection: maybeRedactText(auth.label, ctx.stripRunData, 80),
      ...(teammate ? { teammateConnection: true } : {}),
      componentsMapped: mapped.map((c) => c.name),
      reviewed: confirmed ? 'approved by the user' : 'read-only by the static review (no card)',
      ...(retried
        ? { retriedWithComponents: true, retryReason: `The server's mapped-component cache missed ${retried}; re-ran with the mapped components included.` }
        : {}),
      ...(retryDeclined ? { retryDeclined: true, note: `The user did not re-run it after ${missing} was reported missing; run again later.` } : {}),
    }
    if (!out.ok) {
      recordDryRun(t.versionId, plan.logKey, false)
      const err = maskSecrets(out.error)
      return {
        ...base,
        success: false,
        error: maybeRedactText(err.text, ctx.stripRunData, 1500),
        ...(err.masked ? { secretsMasked: err.masked } : {}),
        ...(/invalid authentication/i.test(out.error) ? { tip: 'The connection is not usable in this org; call dh_connect for a new one.' } : {}),
      }
    }
    const d = out.data
    const success = flag(d.success)
    const updated = typeof d.updatedSource === 'string' ? d.updatedSource : undefined
    // A run of a substituted source did not test the saved code.
    recordDryRun(t.versionId, plan.logKey, success && !updated)
    let updatedInfo: Row = {}
    if (updated !== undefined) {
      markCachedSource(ctx, t.versionId)
      const risky = readOnlyReasons([updated, ...mapped.map((c) => c.source)].join('\n;\n'), { hosts })
      updatedInfo = {
        updatedSource: true,
        substitutedCode:
          'viaSocket ran a cached AI-updated version of this code instead of the saved code' +
          (confirmed
            ? ', after the user approved the saved code.'
            : '. This run had no confirmation card (the saved code reads only), so the substituted code ran without review.') +
          (risky.length ? ` The substituted code ${risky.slice(0, 4).join('; ')}: tell the user it may have changed data in the app.` : '') +
          ' The result does not verify the saved code; later runs of this version will ask first.',
      }
    }
    const masked = maskSecretsDeep(d.message)
    const consoleLines = (Array.isArray(d.console) ? d.console : []).slice(-30).map((l) => maskSecrets(clipJson(l, 2000)))
    const secretsMasked = masked.masked + consoleLines.reduce((n, l) => n + l.masked, 0)
    const strip = ctx.stripRunData
    // A failed run's message is the thrown error, whose wording is needed to fix the code.
    const message = strip ? shapeTree(masked.value, !success) : masked.value
    const empty = success && plan.pluginBlockLocation && Array.isArray(d.message) && d.message.length === 0
    return {
      ...base,
      success,
      message: fitJson(message, Math.max(1500, Math.floor(ctx.maxResultChars * 0.55))),
      console: consoleLines.map((l) => (strip ? redactText(l.text, 300) : clip(l.text, 300))),
      ...(secretsMasked ? { secretsMasked } : {}),
      ...(empty ? { warning: 'The field returned no options: treat it as failed unless the account really has none.' } : {}),
      ...(!success && !retried && mappingChangedHere(ctx, t.versionId) ? { mappingNote: 'A component was mapped recently; if a mapped function is reported missing, run again.' } : {}),
      ...updatedInfo,
      ...(flag(d.dryRunResponseTruncated) || d.truncated ? { responseTruncated: true } : {}),
      ...(strip ? { redacted: 'Privacy mode: values are replaced by their shapes and personal data in text is masked.' } : {}),
      ...(t.kind === 'trigger' && triggerTypeOf(t.version) === 'polling' && plan.slider === 'perform' && success
        ? { next: 'Now run performlist (slider:"performlist").' }
        : {}),
    }
  },
})

// ---------- publish ----------

const publish = dhTool({
  name: 'dh_publish_action_version',
  description:
    'Publish an action/trigger version (skill §4.3 step 2), only after the user said yes: the action points at the ' +
    'version, then the version is marked published and becomes read-only. New publishes are private (this org only); an ' +
    'action that is already public stays public. Needs saved code for the required sliders (action: perform; hook: ' +
    'performsubscribe, performunsubscribe, performlist; polling: perform, performlist; manual: performlist), a connection ' +
    'version and a description; set sample data first. Publish only versions whose dry run passed or that the user ' +
    'approved as not executed. publishDescription is the one-line release note.',
  properties: {
    actionId: P.actionId,
    versionId: P.versionId,
    publishDescription: { type: 'string', description: 'One-line release note, e.g. "Initial release".' },
    actionDescription: { type: 'string', description: 'Only if the action has no description yet (required to publish).' },
  },
  required: ['publishDescription'],
  danger: 'confirm',
  schema: z.object({
    actionId: rowId.optional(),
    versionId: rowId.optional(),
    publishDescription: z.string().trim().min(3).max(500),
    actionDescription: z.string().trim().min(5).max(1000).optional(),
  }),
  describe: () => 'Publishing the version',
  confirmText(a, ctx) {
    // The open editor's version only stands in for the target when the call is about the open action.
    const sameAction = !a.actionId || a.actionId === pageActionId(ctx)
    const vid = a.versionId ?? (sameAction ? openEditorVersionId(ctx) : undefined)
    const which = a.versionId ? `version ${a.versionId}` : sameAction ? 'the open (or latest) version' : `the latest version of action ${a.actionId}`
    return (
      `Publish ${which} privately for your org (an action that is already public stays public), with the note ` +
      `"${clip(a.publishDescription, 120)}". Flows can start using it and the version becomes read-only. ` +
      'If the action is marked as AI-built, viaSocket may later make it public automatically once its success rate is high. ' +
      `${vid ? dryRunSummary(vid) : 'Dry-run status of the target version is unknown.'}`
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
    // Never make anything public: an action that is public today keeps that visibility, everything else is private.
    const currentlyPublic = str(t.action.status) === 'published' && flag(t.action.isvisible)
    const alreadyLive =
      str(v.status) === 'published' && str(t.action.actionversionrecordid) === t.versionId && str(t.action.status) === 'published'
    if (alreadyLive) return { alreadyPublished: true, versionId: t.versionId, version: tag, visibility: currentlyPublic ? 'public' : 'private' }

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
    const step1: Row = {
      actionversionrecordid: t.versionId,
      status: 'published',
      type: typeKey,
      authidlookup: authId,
      ...(currentlyPublic ? {} : { isvisible: false }),
      publishdescription: a.publishDescription,
    }
    if (!hasDescription && a.actionDescription) step1.description = a.actionDescription
    const { row: actionRow } = await dhMerge(ctx, 'actions', t.actionId, step1, { note: currentlyPublic ? 'published (stays public)' : 'published privately' })

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
        await dhMerge(ctx, 'plugins', t.pluginId, { istriggeravailable: true }, { note: 'trigger published' })
      } catch {
        notes.push('Could not mark the plug as having triggers; users may not see the trigger until that is fixed in the plug details.')
      }
    }
    if (str(plugin.status) !== 'published') notes.push('The plug itself is not published; publish it with dh_publish_plugin if the user wants the app published.')
    // Deliberate deviation from the skill's "always isvisible:false": unlisting a live public action would break other
    // orgs' flows, so it stays public. The report must say so.
    if (currentlyPublic) notes.push('This action was already public, so it stayed public (the skill publishes privately; making it private would break flows of other workspaces). Tell the user.')
    if (flag(t.action.isaiaction)) notes.push('The action is marked as AI-built: viaSocket may make it public automatically later once its success rate is high. Tell the user.')
    const [after] = await dhGetFields(ctx, 'actions', 'getActionDetails', t.actionId, ['rowid', 'status', 'isvisible', 'actionversionrecordid'])
    const [versionSync, actionSync] = await Promise.all([
      syncVersion(ctx, v, step2, versionRow),
      actionRow ? syncActionRow(ctx, t.pluginId, actionRow) : Promise.resolve(undefined),
    ])
    const page = [versionSync, actionSync].find((p) => p && !p.live) ?? versionSync ?? actionSync
    return {
      published: str(after?.status) === 'published' && str(after?.actionversionrecordid) === t.versionId,
      actionId: t.actionId,
      versionId: t.versionId,
      version: tag,
      visibility: flag(after?.isvisible) ? 'public' : 'private',
      ...(notes.length ? { notes } : {}),
      ...(page ? { page } : {}),
    }
  },
})

export const RUN_TOOLS: Tool<any>[] = [dryRun, publish]
