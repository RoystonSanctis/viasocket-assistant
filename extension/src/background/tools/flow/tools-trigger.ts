// vs_set_trigger: webhook, schedule (cron), email and app triggers. vs_test_trigger: the trigger panel's TEST.
//
// An app trigger is set up like the editor's trigger panel: picking the event drafts it (drafttrigger); a connection
// (unless the panel shows none: NoAuth, manual webhook) and every required, visible field are needed before it can be
// saved, and every dropdown value must be one of its real choices. Saving first runs the same test as the panel's
// Save button (performlist, then modifytriggerdata when the app has it) with exactly the values that are saved, and
// stores the raw result as the trigger's sample, so later steps are mapped from real fields. Values given in an
// incomplete call are held for the next one, because viaSocket cannot store a half-configured trigger.
//
// While this tab shows the flow, saves go out without live-apply and the trigger panel is (re)opened with a
// ?timestamp refetch: the editor keeps its own copy of whatever a panel has shown, which live-apply would leave
// stale — and a live-applied save would stop the refetch from reloading it (see flow-api's editor-sync note).

import { maybeRedactText } from '../redact'
import type { Tool, ToolContext } from '../types'
import { getActionRow, getActionVersionRow, normalizeInputJson, scheduleTimeOptions, type ActionRow } from './catalog'
import { configure, type Configured } from './configure'
import { resolveConnection } from './connections'
import { describeRun, nextRuns, parseCron, validTimezone } from './cron'
import { call, isAbortError, ToolError } from './errors'
import { choiceKeys, clearPending, holdValues, mergePending, reachableFields, stepKey, withDynamicInput, type SavedState } from './fields'
import { everPublished, getFlow, liveUnlessEditorOpen, normalizeFlow, openTriggerPanel, panelResult, resolveFlow, triggerFeatures, triggerKind } from './flow-api'
import { encodeInputData } from './input-data'
import { checkTriggerValues, inputDataTexts } from './mapping'
import { consoleOf, dryRunErrorText, executeDryRun, getRecentRun } from './runs'
import {
  helpText, holdTriggerSample, loopLists, meaningful, runBodyIsRaw, runMatchesTrigger, triggerBody, triggerIdentity, triggerStages, variablesOf,
  type SampleSource,
} from './samples'
import { defineTool, params, S } from './schema'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, FlowRow, FlowTarget, Trigger } from './types'
import { asArray, asRecord, AUTH_ID_RE, bounded, FLOW_PAGES, isRecord, parseMaybeJson, ROW_ID_RE, str, trimData } from './util'

const pages = [...FLOW_PAGES]
const APP_KINDS = new Set(['hook', 'polling', 'manual_webhook'])
const POLL_MINUTES = [5, 15, 60, 720, 1440] as const
const NO_AUTH: AuthData = { id: 'NoAuth', type: 'NoAuth' }
/** Room under the backend's 2 MB body limit for the rest of the trigger. */
const MAX_SAMPLE_CHARS = 1_500_000
const EDITOR_NOTE =
  "The editor's own field list (the + picker in later steps) fills in after Test is pressed in the open trigger panel; viaSocket keeps that list in the page only. Tell the user in one sentence and point at it with ui_highlight 'stepTest'. Insert texts saved in fields work and show as chips either way."

interface SetTriggerArgs {
  kind: 'webhook' | 'cron' | 'email' | 'app'
  cronExpression?: string
  meaning?: string
  timezone?: string
  actionId?: string
  connectionId?: string
  inputData?: Record<string, unknown>
  customInput?: string[]
  scheduledTime?: (typeof POLL_MINUTES)[number]
  scriptId?: string
}

function describeTrigger(t: Trigger | undefined): string {
  const kind = triggerKind(t)
  if (!t || !kind) return 'nothing'
  if (kind === 'webhook') return 'a webhook'
  if (kind === 'email') return 'incoming email'
  if (kind === 'cron') return `a schedule${t.meaning ? ` (${t.meaning})` : ''}`
  return `the ${t.serviceName ?? 'app'} trigger${t.actionName ? ` "${t.actionName}"` : ''}`
}

function fail(problems: string[]): never {
  throw new ToolError(`Nothing was changed. Fix these first: ${problems.join(' | ')}`)
}

function precheck(a: SetTriggerArgs): void {
  const problems: string[] = []
  if (a.kind === 'cron') {
    const parsed = parseCron(a.cronExpression ?? '')
    if (!a.cronExpression?.trim()) problems.push('cronExpression is required: a standard 5-field cron expression, e.g. "0 9 * * 1-5".')
    else if (!parsed.ok) problems.push(`cronExpression: ${parsed.error}.`)
    else if (!nextRuns(parsed.fields, 'UTC', 1).length) problems.push('cronExpression never matches a real date (e.g. 31 February); check the day and month.')
    if (!a.meaning?.trim()) problems.push('meaning is required: the schedule in words, e.g. "Every weekday at 9:00 AM".')
    if (a.timezone && !validTimezone(a.timezone)) problems.push('timezone must be an IANA name such as "Asia/Kolkata" or "Europe/London".')
  } else if (a.cronExpression || a.meaning || a.timezone) {
    problems.push('cronExpression, meaning and timezone are only for kind "cron".')
  }
  if (a.kind === 'app' && !a.actionId) problems.push('actionId is required for app triggers (vs_list_app_actions with kind "trigger").')
  if (a.kind !== 'app' && (a.actionId || a.connectionId || a.inputData || a.scheduledTime || a.customInput)) {
    problems.push('actionId, connectionId, inputData, customInput and scheduledTime are only for kind "app".')
  }
  if (problems.length) fail(problems)
}

/** POST /trigger body: the drafted or saved trigger with its values. The server stores it verbatim. */
function triggerSaveBody(base: Trigger, authData: AuthData, inputData: Record<string, unknown>, sampleData: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...base,
    selectedValues: { ...asRecord(base.selectedValues), authData, inputData },
    // The editor sends 'update' only for a published hook (performSubscribe) or a polling trigger with its child flow.
    type: asRecord(base.selectedValues?.inputData).performSubscribe !== undefined || base.scriptId !== undefined ? 'update' : 'add',
    triggerType: String(base.triggerType || 'hook'),
    name: 'trigger',
  }
  if (sampleData !== undefined) body.sampleData = sampleData
  delete body.isDrafted
  return body
}

/** The raw test result, as the editor saves it; too large to save is held for the session only. */
function sampleToSave(message: unknown): unknown {
  return (JSON.stringify(message) ?? '').length <= MAX_SAMPLE_CHARS ? message : undefined
}

interface TriggerTest {
  success: boolean
  message: unknown
  error?: string
  console?: string
  /** Succeeded and returned event data (not just empty or guidance) */
  found: boolean
  help?: string
}

/** The trigger panel's TEST: performlist (the app's "latest data" code), then modifytriggerdata when present. */
async function runTriggerTest(ctx: ToolContext, t: FlowTarget, trigger: Trigger, authData: AuthData, inputData: Record<string, unknown>): Promise<TriggerTest> {
  const avid = str(trigger.actionVersionId) ?? ''
  if (!ROW_ID_RE.test(avid)) throw new ToolError('This trigger has no action version; set it again with vs_set_trigger.')
  const ij = normalizeInputJson(trigger.inputJson)
  const code = {
    selectedValues: { authData, inputData },
    inputFieldsBlocks: reachableFields(ij),
    inputFieldsSteps: ij.steps,
    actionVersionId: avid,
  }
  const variables = (body: unknown) => ({ context: { req: { body, query: {} }, res: {}, vals: {} } })
  await ctx.vs.alignOrg(ctx.signal)
  let r = await executeDryRun(
    ctx,
    t,
    {
      type: 'trigger',
      code,
      name: 'plugin',
      startDryRunApiStartThunk: true,
      stepId: 'SET_TRIGGER',
      variables: variables({}),
      performType: 'performlist',
      pluginType: 'trigger',
      isUserOnDh: false,
    },
    'Testing the trigger',
  )
  const modify = trigger.modifyTriggerData
  if (r.success && modify && (typeof modify !== 'string' || modify.trim())) {
    r = await executeDryRun(
      ctx,
      t,
      { type: 'trigger', code, name: 'plugin', variables: variables(r.message), performType: 'modifytriggerdata', pluginType: 'trigger', isUserOnDh: false },
      'Preparing the trigger sample',
    )
  }
  return {
    success: r.success,
    message: r.message,
    error: r.success ? undefined : dryRunErrorText(r.message),
    console: consoleOf(r.console),
    found: r.success && meaningful(r.message),
    help: helpText(r.message),
  }
}

function triggerSampleSource(trigger: Trigger, data: unknown, origin: SampleSource['origin']): SampleSource {
  return { id: 'trigger', ref: 'req', base: 'context.req.body', type: triggerKind(trigger) ?? 'app', origin, data: triggerBody(data) }
}

/** What the model sees of a trigger test: real fields as insert texts, or what the user has to do first. */
function testReport(ctx: ToolContext, test: TriggerTest, trigger: Trigger): Record<string, unknown> {
  const strip = ctx.stripRunData
  const appHint = maybeRedactText(test.help, strip, 300)
  if (!test.success) {
    return {
      success: false,
      error: maybeRedactText(test.error, strip, 400) ?? 'The test failed.',
      console: maybeRedactText(test.console, strip, 1000),
      hint: 'An expired or wrong connection is the usual cause: check it with vs_list_connections and reconnect with vs_connect_app if needed.',
    }
  }
  if (!test.found) {
    const app = trigger.serviceName ?? 'the app'
    const event = (trigger.actionName ?? 'trigger').replace(/_/g, ' ')
    return {
      success: true,
      sampleFound: false,
      appHint,
      nextStep: `${app} has no event to sample yet. Ask the user to make one real "${event}" event happen in ${app}, then say done, and run vs_test_trigger again. Never invent sample data.`,
    }
  }
  const src = triggerSampleSource(trigger, test.message, 'tested')
  return { success: true, sampleFound: true, sample: trimData(src.data, strip), variables: variablesOf(src, strip, 60), appHint }
}

/** POST /trigger, without live-apply while this tab shows the flow (see the header). Returns the saved flow. */
async function postTrigger(ctx: ToolContext, t: FlowTarget, body: Record<string, unknown>, what: string): Promise<FlowRow | null> {
  const live = liveUnlessEditorOpen(ctx, t.scriptId)
  const res = await call(what, () => ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/trigger`, body, live, signal: ctx.signal }))
  return normalizeFlow(asRecord(res).data)
}

/**
 * Body of POST /trigger for a webhook, schedule or email trigger. The route REPLACES the whole trigger with the body,
 * so a re-save of the same kind must carry the current trigger over: Get Data (preProcess), the loop (loops,
 * preProcessFilter), run-if (preCondition) and the schedule's own fields. `statement` is never sent: it makes the
 * server ask an external AI for the schedule.
 */
export function spreadTrigger(current: Trigger | undefined, kind: string, changes: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = triggerKind(current) === kind && current ? { ...current } : {}
  delete body.isDrafted
  Object.assign(body, changes)
  delete body.statement
  return body
}

/** Get Data, loop and run-if that a switch to another trigger kind removes (named in the confirmation). */
function featuresLost(current: Trigger | undefined): string[] {
  const f = triggerFeatures(current)
  if (!f) return []
  const out: string[] = []
  if (f.getData) out.push('Get Data')
  if (f.loop) out.push('run once per item')
  if (f.runIf) out.push('the run-if condition')
  return out
}

const tzCache = new Map<string, { at: number; tz?: string }>()

/** The workspace's timezone (what viaSocket uses when a schedule has none). Only that field is read. Best-effort. */
async function workspaceTimezone(ctx: ToolContext, orgId: string): Promise<string | undefined> {
  const key = `${ctx.vs.env.apiBase}|${orgId}`
  const c = tzCache.get(key)
  if (c && Date.now() - c.at < 10 * 60_000) return c.tz
  let tz: string | undefined
  try {
    const body = await ctx.vs.request({ method: 'GET', path: '/orgs/user-org/details', query: { userandorg: true }, signal: ctx.signal })
    const user = asRecord(asArray(asRecord(asRecord(body).data).data)[0])
    const org = asArray(user.c_companies).map(asRecord).find((o) => String(o.id) === orgId)
    const found = str(asRecord(org?.meta).timezoneIdentifier)
    tz = found && validTimezone(found) ? found : undefined
  } catch (e) {
    if (isAbortError(e)) throw e
  }
  tzCache.set(key, { at: Date.now(), tz })
  return tz
}

/** Saves a tested sample on a saved trigger (where the editor's Save keeps it), raw. Best-effort. */
async function persistTriggerSample(ctx: ToolContext, t: FlowTarget, tested: Trigger, message: unknown): Promise<boolean> {
  const sample = sampleToSave(message)
  if (sample === undefined) return false
  try {
    return await ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const cur = (await getFlow(ctx, t)).json_script.trigger
      if (!cur || cur.isDrafted === true || triggerIdentity(cur) !== triggerIdentity(tested)) return false
      if (JSON.stringify(parseMaybeJson(cur.sampleData)) === JSON.stringify(sample)) return true
      const body = triggerSaveBody(cur, asRecord(cur.selectedValues?.authData) as AuthData, asRecord(cur.selectedValues?.inputData), sample)
      await postTrigger(ctx, t, body, 'Saving the trigger sample')
      return true
    })
  } catch (e) {
    if (isAbortError(e)) throw e
    return false
  }
}

/** The trigger panel shows no connection for NoAuth apps and manual webhook triggers. */
function needsNoConnection(authType: unknown, triggerType: unknown): boolean {
  return authType === 'NoAuth' || triggerType === 'manual_webhook'
}

/** Polling intervals the action version allows (the panel resets anything else to the first one). */
async function allowedIntervals(ctx: ToolContext, actionVersionId: string | undefined): Promise<number[]> {
  if (!actionVersionId || !ROW_ID_RE.test(actionVersionId)) return scheduleTimeOptions(undefined)
  try {
    return scheduleTimeOptions(await getActionVersionRow(ctx, actionVersionId))
  } catch (e) {
    if (isAbortError(e)) throw e
    return scheduleTimeOptions(undefined)
  }
}

function incompleteTrigger(
  base: Trigger,
  action: ActionRow,
  cfg: Configured | undefined,
  hasAuth: boolean,
  values: Record<string, unknown>,
  dropped: string[],
  isDraft: boolean,
  panel: { panelOpened: boolean; panelNote?: string },
): Record<string, unknown> {
  return {
    saved: false,
    drafted: isDraft || undefined,
    app: base.serviceName,
    event: typeof base.actionName === 'string' ? base.actionName.replace(/_/g, ' ') : undefined,
    needsConnection: hasAuth
      ? undefined
      : {
          serviceId: base.serviceId ?? action.pluginrecordid,
          authIdLookup: base.authIdLookup ?? action.authidlookup,
          actionVersionId: base.actionVersionId,
          hint: 'Find one with vs_list_connections (ask which one if there are several); if there is none, vs_connect_app. Then call vs_set_trigger again with connectionId.',
        },
    needsUserInput: cfg?.needs.length ? cfg.needs : undefined,
    defaultsApplied: cfg?.defaultsApplied.length ? cfg.defaultsApplied : undefined,
    heldValues: Object.keys(values).length ? Object.keys(values) : undefined,
    droppedHeld: dropped.length ? { keys: dropped, why: 'changed in the panel since they were given, so the panel values are kept' } : undefined,
    ...panel,
    warnings: cfg?.warnings.length ? cfg.warnings : undefined,
    next: `${isDraft ? 'The trigger is drafted, not saved.' : 'Nothing was changed: the saved trigger keeps its values.'} Ask the user for each missing item, one short question at a time (offer the real choices from vs_get_field_options, passing connectionId), then call vs_set_trigger again with the same actionId. Values given so far are kept.`,
  }
}

async function setAppTrigger(a: SetTriggerArgs, ctx: ToolContext, t: FlowTarget): Promise<unknown> {
  // Lookups happen before anything is written, so a bad id or value changes nothing.
  const action = await getActionRow(ctx, a.actionId ?? '')
  if (action.type && action.type !== 'trigger') throw new ToolError('That action is not a trigger. Use vs_list_app_actions with kind "trigger".')
  const customInput = new Set(a.customInput ?? [])
  const actionIj = normalizeInputJson(action.inputjson)
  const pre = encodeInputData(a.inputData ?? {}, actionIj)
  const literal = new Set([...customInput, ...choiceKeys(actionIj)])
  const valueProblems = [...pre.problems, ...checkTriggerValues(inputDataTexts(a.inputData, 'inputData', literal), str(action.name)?.trim().replaceAll(' ', '_'))]
  if (valueProblems.length) fail(valueProblems)
  const holdKey = stepKey(ctx, t, `SET_TRIGGER:${action.rowid}`)

  const currentRow = await getFlow(ctx, t)
  const current = currentRow.json_script
  const curKind = triggerKind(current.trigger)
  const sameKind = !!curKind && APP_KINDS.has(curKind) && current.trigger?.selectedCreate === a.actionId
  // Changing the trigger deletes the old one (and leaving webhook deletes the response block).
  if (curKind && !sameKind) {
    const loseResponse = curKind === 'webhook' && current.blocks.response?.responseType === 'custom'
    const lost = featuresLost(current.trigger)
    const live = everPublished(currentRow) ? ' The live flow keeps its current trigger until you publish.' : ''
    const ok = await ctx.ui.confirm(
      'Replace the trigger?',
      `This flow is started by ${describeTrigger(current.trigger)}. Switching to an app trigger removes it${loseResponse ? ', together with the custom webhook response' : ''}${lost.length ? `, and its ${lost.join(', ')}` : ''}.${live}`,
      true,
      'Replace trigger',
    )
    if (!ok) return { changed: false, message: 'The user kept the current trigger.' }
  }

  const vmBase = ctx.vs.env.vmBase
  return ctx.vs.mutate(t.scriptId, async () => {
    await ctx.vs.alignOrg(ctx.signal)
    const js = (await getFlow(ctx, t)).json_script
    const cur = js.trigger
    const same = !!cur && APP_KINDS.has(String(cur.triggerType)) && cur.selectedCreate === a.actionId
    let base: Trigger
    let justDrafted = false
    if (same && cur) base = cur
    else {
      const res = await call('Drafting the app trigger', () =>
        ctx.vs.request({
          method: 'POST',
          path: `/scripts/${t.projectId}/${t.scriptId}/drafttrigger/${a.actionId}`,
          body: {},
          live: liveUnlessEditorOpen(ctx, t.scriptId),
          signal: ctx.signal,
        }),
      )
      const trig = normalizeFlow(asRecord(res).data)?.json_script.trigger
      if (!trig?.actionVersionId) throw new ToolError('viaSocket did not return the drafted trigger. Call vs_get_flow to check.')
      base = trig
      justDrafted = true
    }
    const triggerType = String(base.triggerType || 'hook')
    if (!APP_KINDS.has(triggerType)) throw new ToolError(`Unsupported app trigger type "${triggerType}".`)
    const noConnection = needsNoConnection(base.authType ?? action.authtype, triggerType)
    const isDraft = justDrafted || base.isDrafted === true
    const saved: SavedState = {
      inputData: isDraft ? {} : asRecord(base.selectedValues?.inputData),
      authId: isDraft ? undefined : str(base.selectedValues?.authData?.id),
    }
    const merged = mergePending(holdKey, a.inputData, saved)
    const connectionId = a.connectionId ?? merged.connectionId

    let authData: AuthData | undefined
    if ((base.authType ?? action.authtype) === 'NoAuth') authData = NO_AUTH
    else if (triggerType === 'manual_webhook') authData = asRecord(base.selectedValues?.authData) as AuthData
    else if (connectionId) {
      const serviceId = str(base.serviceId) ?? action.pluginrecordid ?? ''
      const lookup = str(base.authIdLookup) ?? action.authidlookup ?? ''
      if (!ROW_ID_RE.test(serviceId) || !ROW_ID_RE.test(lookup)) throw new ToolError('This trigger has no connection settings.')
      authData = await resolveConnection(ctx, connectionId, serviceId, lookup, t)
    } else if (!isDraft && base.selectedValues?.authData?.id) authData = base.selectedValues.authData

    // The editor sets hookUrl on every app trigger it saves.
    const extra: Record<string, unknown> = { hookUrl: `${vmBase}/func/${t.scriptId}` }
    if (triggerType === 'polling') {
      const allowed = await allowedIntervals(ctx, str(base.actionVersionId))
      if (a.scheduledTime !== undefined && !allowed.includes(a.scheduledTime)) {
        fail([`scheduledTime ${a.scheduledTime} is not offered for this trigger; choose one of ${allowed.join(', ')} minutes.`])
      }
      const prev = Number(saved.inputData.scheduledTime)
      extra.scheduledTime = a.scheduledTime ?? (allowed.includes(prev) ? prev : allowed[0])
    }

    let cfg: Configured
    try {
      cfg = await configure(ctx, t, {
        holdKey,
        pd: base,
        values: merged.values,
        changed: new Set(Object.keys(a.inputData ?? {})),
        base: saved.inputData,
        authData,
        isTrigger: true,
        customInput,
        noConnection,
        extra,
      })
    } catch (e) {
      if (e instanceof ToolError) holdValues(holdKey, merged.values, connectionId, saved)
      throw e
    }

    if (!cfg.complete) {
      holdValues(holdKey, merged.values, connectionId, saved)
      if (authData?.id) {
        try {
          const partialToSave: Trigger = { ...base, inputJson: cfg.inputJson }
          const dynamicInputRequired = withDynamicInput(base.dynamicInputRequired, cfg.dynamicInput)
          if (dynamicInputRequired) partialToSave.dynamicInputRequired = dynamicInputRequired
          const body = triggerSaveBody(partialToSave, authData, cfg.cleaned, base.sampleData)
          await ctx.vs.request({
            method: 'POST',
            path: `/scripts/${t.projectId}/${t.scriptId}/trigger`,
            body,
            live: liveUnlessEditorOpen(ctx, t.scriptId),
            signal: ctx.signal,
          })
        } catch (err) {
          console.warn('[assistant] failed to save partial trigger with authData:', err)
        }
      }
      return incompleteTrigger(base, action, cfg, !!authData?.id || noConnection, merged.values, merged.dropped, isDraft, panelResult(await openTriggerPanel(ctx, t.scriptId, triggerType)))
    }

    // Save = test + store, like the panel's Save button, with exactly the values that are saved. A failed test does
    // not block the save.
    const toSave: Trigger = { ...base, inputJson: cfg.inputJson }
    const dynamicInputRequired = withDynamicInput(base.dynamicInputRequired, cfg.dynamicInput)
    if (dynamicInputRequired) toSave.dynamicInputRequired = dynamicInputRequired
    const auth = authData ?? ({} as AuthData)
    let test: TriggerTest | undefined
    let testError: string | undefined
    try {
      test = await runTriggerTest(ctx, t, toSave, auth, cfg.cleaned)
    } catch (e) {
      if (isAbortError(e)) throw e
      testError = e instanceof Error ? e.message : String(e)
    }
    const sample = test?.found ? sampleToSave(test.message) : undefined
    const warnings = [...cfg.warnings]
    if (test?.found && sample === undefined) warnings.push('The sample is too large to save with the trigger; it is kept for this session only.')
    try {
      await postTrigger(ctx, t, triggerSaveBody(toSave, auth, cfg.cleaned, sample), 'Saving the app trigger')
    } catch (e) {
      if (!isDraft) throw e
      holdValues(holdKey, merged.values, connectionId, saved)
      throw new ToolError(
        `The app trigger is drafted but saving it failed (${e instanceof Error ? e.message : String(e)}). The flow cannot be published until the trigger is saved; fix the values and call vs_set_trigger again.`,
      )
    }
    clearPending(holdKey)
    if (test?.found) holdTriggerSample(ctx, t, base, test.message)
    if (cfg.missing.maybe.length) warnings.push(`Check whether these apply: ${cfg.missing.maybe.map((m) => m.label ?? m.key).join(', ')}`)
    const panel = panelResult(await openTriggerPanel(ctx, t.scriptId, triggerType))
    return bounded(
      {
        saved: true,
        trigger: triggerType,
        app: base.serviceName,
        event: typeof base.actionName === 'string' ? base.actionName.replace(/_/g, ' ') : undefined,
        checkEveryMinutes: triggerType === 'polling' ? extra.scheduledTime : undefined,
        url: triggerType === 'manual_webhook' ? `${vmBase}/func/${t.scriptId}` : undefined,
        defaultsApplied: cfg.defaultsApplied.length ? cfg.defaultsApplied : undefined,
        droppedHeld: merged.dropped.length ? merged.dropped : undefined,
        test: test ? testReport(ctx, test, base) : { success: false, error: testError },
        ...panel,
        editorNote: test?.found ? EDITOR_NOTE : undefined,
        warnings: warnings.length ? warnings : undefined,
        next: test?.found
          ? "Map later steps only with the insert texts in test.variables (or vs_get_variables), e.g. for the next step's fields. The trigger goes live after publishing."
          : 'Saved, but there is no real sample yet: follow test.nextStep (or fix test.error), then run vs_test_trigger. Do not map trigger fields until it returns a sample.',
      },
      ctx.maxResultChars,
    )
  })
}

const setTrigger = defineTool<SetTriggerArgs>({
  name: 'vs_set_trigger',
  description: [
    'Set what starts the flow, and open the trigger panel.',
    '"webhook": runs when its URL receives a request. "cron": a schedule; cronExpression (5 fields) AND meaning in words, optional IANA timezone (default: the workspace\'s); returns nextRuns to confirm with the user.',
    '"email": email to <flowId>@sokt.io; needs a flow created with vs_create_flow {lowercaseId: true}.',
    '"app": an app event (actionId from vs_list_app_actions kind "trigger"). Call it first with just actionId: it drafts the trigger and returns needsConnection / needsUserInput.',
    'Then call again with connectionId and inputData (fixed values, or the value of a choice from vs_get_field_options; no variables) once the user answered. Values given earlier are kept.',
    "When complete it tests the trigger like the panel's Save button and saves it with the real sample (test.variables are the insert texts for later steps).",
    'Re-saving keeps Get Data, loop and run-if; replacing a trigger of another type asks the user first.',
  ].join(' '),
  parameters: params(
    {
      kind: S.enum(['webhook', 'cron', 'email', 'app'], 'Trigger type.'),
      cronExpression: S.str('kind cron: 5-field cron expression (minute hour day month weekday), e.g. "0 9 * * 1-5"; no L, W or #.', { maxLength: 100 }),
      meaning: S.str('kind cron: the schedule in words, e.g. "Every weekday at 9:00 AM".', { maxLength: 120 }),
      timezone: S.str('kind cron: IANA timezone, e.g. "Asia/Kolkata". Defaults to the workspace timezone.', { maxLength: 64 }),
      actionId: S.str('kind app: trigger actionId from vs_list_app_actions (kind "trigger").', { pattern: ROW_ID_RE.source }),
      connectionId: S.str('kind app: connection id from vs_list_connections / vs_connect_app.', { pattern: AUTH_ID_RE.source }),
      inputData: S.map('kind app: field values keyed by field key (vs_get_action); dropdowns take the value of a choice from vs_get_field_options.'),
      customInput: S.strs('kind app: field keys whose value the user typed themselves (free text in a dropdown). Never for guesses.'),
      scheduledTime: S.enum(POLL_MINUTES, 'kind app, polling triggers only: check interval in minutes (default: the first the trigger offers).'),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['kind'],
  ),
  danger: 'write',
  pages,
  describe: (a) => {
    const names: Record<string, string> = { webhook: 'a webhook', cron: 'a schedule', email: 'an email', app: 'an app' }
    return `Setting ${names[a.kind] ?? 'the'} trigger`
  },
  async run(a, ctx) {
    precheck(a)
    const t = resolveFlow(ctx, a.scriptId)
    if (a.kind === 'email' && t.scriptId !== t.scriptId.toLowerCase()) {
      throw new ToolError(
        `Email triggers need an all-lowercase flow id (the address is <id>@sokt.io) and ${t.scriptId} has capitals. Create a new flow with vs_create_flow {lowercaseId: true} and build it there.`,
      )
    }
    if (a.kind === 'app') return setAppTrigger(a, ctx, t)

    const currentRow = await getFlow(ctx, t)
    const current = currentRow.json_script
    const curKind = triggerKind(current.trigger)
    if (curKind && curKind !== a.kind) {
      const loseResponse = curKind === 'webhook' && current.blocks.response?.responseType === 'custom'
      const lost = featuresLost(current.trigger)
      const live = everPublished(currentRow) ? ' The live flow keeps its current trigger until you publish.' : ''
      const ok = await ctx.ui.confirm(
        'Replace the trigger?',
        `This flow is started by ${describeTrigger(current.trigger)}. Switching to a ${a.kind} trigger removes it${loseResponse ? ', together with the custom webhook response' : ''}${lost.length ? `, and its ${lost.join(', ')}` : ''}.${live}`,
        true,
        'Replace trigger',
      )
      if (!ok) return { changed: false, message: 'The user kept the current trigger.' }
    }

    const vmBase = ctx.vs.env.vmBase
    // The schedule's timezone defaults to the workspace's, as in the editor; read before the write queue.
    const orgTz = a.kind === 'cron' && !a.timezone ? await workspaceTimezone(ctx, t.orgId) : undefined
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const liveRow = await getFlow(ctx, t)
      const live = liveRow.json_script.trigger
      const same = triggerKind(live) === a.kind
      const kept = same ? featuresLost(live) : []
      switch (a.kind) {
        case 'webhook': {
          // Already a webhook: nothing to change (a re-save would rebuild the response block), unless the response
          // block is missing, which only a webhook save (type "add") restores.
          const restore = same && !liveRow.json_script.blocks.response
          if (!same || restore) {
            await postTrigger(ctx, t, spreadTrigger(live, 'webhook', { triggerType: 'webhook', type: 'add' }), restore ? 'Restoring the webhook response' : 'Setting the webhook trigger')
          }
          return {
            trigger: 'webhook',
            changed: !same || restore,
            url: `${vmBase}/func/${t.scriptId}`,
            kept: kept.length ? kept : undefined,
            ...panelResult(await openTriggerPanel(ctx, t.scriptId, 'webhook')),
            note: restore
              ? 'The webhook was already set; its response block was missing and is restored (default response). Set a custom one with vs_set_response if needed.'
              : same
                ? 'The flow already starts with this webhook; nothing was changed.'
                : 'Ask the user to send one real request to the URL, then run vs_test_trigger to read its fields. The URL runs the live flow after publishing.',
          }
        }
        case 'email':
          if (!same) await postTrigger(ctx, t, spreadTrigger(live, 'email', { triggerType: 'email', type: 'add' }), 'Setting the email trigger')
          return {
            trigger: 'email',
            changed: !same,
            address: `${t.scriptId}@sokt.io`,
            kept: kept.length ? kept : undefined,
            ...panelResult(await openTriggerPanel(ctx, t.scriptId, 'email')),
            note: same ? 'The flow already starts with this email address; nothing was changed.' : 'Ask the user to send one real email to the address, then run vs_test_trigger to read its fields.',
          }
        case 'cron': {
          const expr = (a.cronExpression ?? '').trim().split(/\s+/).join(' ')
          const timezone = a.timezone ?? (same ? str(live?.timezone) : undefined) ?? orgTz
          // Never `statement` (spreadTrigger drops it): it routes through an external AI and overrides the expression.
          const body = spreadTrigger(live, 'cron', {
            triggerType: 'cron',
            type: 'add',
            cronExpression: expr,
            meaning: a.meaning?.trim(),
            ...(timezone ? { timezone } : {}),
          })
          const saved = await postTrigger(ctx, t, body, 'Setting the schedule')
          const tz = str(saved?.json_script.trigger?.timezone) ?? timezone
          const usedTz = tz && validTimezone(tz) ? tz : 'UTC'
          const parsed = parseCron(expr)
          const runs = parsed.ok ? nextRuns(parsed.fields, usedTz, 5).map((ms) => describeRun(ms, usedTz)) : []
          return {
            trigger: 'cron',
            cronExpression: expr,
            meaning: body.meaning,
            timezone: usedTz,
            timezoneFrom: a.timezone ? 'given' : same && str(live?.timezone) ? 'kept from the schedule' : orgTz ? 'workspace' : tz ? 'viaSocket default' : 'unknown (shown in UTC)',
            nextRuns: runs,
            kept: kept.length ? kept : undefined,
            ...panelResult(await openTriggerPanel(ctx, t.scriptId, 'cron')),
            next: `Read the next run times to the user (${usedTz}) and confirm they match "${String(body.meaning ?? '')}"; if not, call vs_set_trigger again with a corrected expression or timezone. The schedule starts after publishing. A schedule carries no data of its own: to fetch data on each run, add Get Data (vs_set_get_data).`,
          }
        }
      }
    })
  },
})

const testTrigger = defineTool<{ scriptId?: string }>({
  name: 'vs_test_trigger',
  description:
    "Test the flow's trigger like the TEST button in the trigger panel and return its real sample with the insert texts later steps can use (e.g. ${context.req.body.comment_id}). App triggers fetch the latest real event from the app right away (read only: nothing is subscribed, sent or changed); the sample is saved with the trigger. Webhook and email triggers read the latest request received; with Get Data or a loop it also returns what steps see. If there is no event yet, it says what the user should do: tell them, wait until they say done, then call it again. Never invent sample data.",
  parameters: params({ scriptId: SCRIPT_ID_PARAM }),
  // Reads only; the one write is saving the sample on the saved trigger.
  danger: 'write',
  pages,
  describe: () => 'Testing the trigger',
  async run(a, ctx) {
    const t = resolveFlow(ctx, a.scriptId)
    const row = await getFlow(ctx, t)
    const trigger = row.json_script.trigger
    const kind = triggerKind(trigger)
    if (!trigger || !kind) throw new ToolError('The flow has no trigger yet. Set one with vs_set_trigger first.')
    const strip = ctx.stripRunData
    const shaped = isRecord(trigger.preProcess) || isRecord(trigger.preProcessFilter) || asRecord(trigger.loops).loopsEnabled === true
    if (kind === 'cron') {
      if (!isRecord(trigger.preProcess)) {
        return {
          tested: false,
          trigger: 'cron',
          note: 'Schedule triggers carry no event data, so there is nothing to sample and no trigger fields to map. To fetch data on every run, add Get Data (vs_set_get_data); its output becomes context.req.body.',
        }
      }
      const final = triggerStages(ctx, t, row, null).final
      return bounded(
        {
          tested: false,
          trigger: 'cron',
          getData: true,
          sampleFound: !!final.origin,
          body: final.note,
          variables: final.origin ? variablesOf(final, strip, 60) : undefined,
          next: final.origin ? 'Map steps with these insert texts.' : 'Test Get Data with vs_set_get_data action "test"; its output is what steps read.',
        },
        ctx.maxResultChars,
      )
    }
    if (kind === 'webhook' || kind === 'email') {
      const run = await getRecentRun(ctx, t)
      const fromThisTrigger = run && meaningful(run.body) && runMatchesTrigger(row)
      if (run && fromThisTrigger && kind === 'webhook' && !runBodyIsRaw(run)) {
        return {
          tested: true,
          sampleFound: false,
          nextStep: `The latest run already went through Get Data or a loop, so it does not show the original request. Ask the user to send one new request (POST with a JSON body) to ${ctx.vs.env.vmBase}/func/${t.scriptId} only if Get Data needs request fields; otherwise test Get Data with vs_set_get_data action "test".`,
        }
      }
      if (run && fromThisTrigger && kind === 'webhook') {
        holdTriggerSample(ctx, t, trigger, run.body, { query: run.query, headers: run.headers })
        // The request as it arrives (a list stays a list, as at run time), and what steps see after Get Data / loop.
        const stages = triggerStages(ctx, t, row, null)
        const raw = stages.raw
        const final = stages.final
        const lists = !stages.loops && stages.processed ? loopLists(stages.processed.data) : []
        const bodyIsList = !stages.loops && Array.isArray(stages.processed?.data)
        return bounded(
          {
            tested: true,
            sampleFound: true,
            from: `latest run${run.at ? ` (${run.at})` : ''}`,
            sample: trimData(raw.data, strip),
            variables: final.origin ? variablesOf(final, strip, 60) : undefined,
            body: shaped ? final.note : undefined,
            requestVariables: shaped ? variablesOf(raw, strip, 40) : undefined,
            queryKeys: Object.keys(asRecord(run.query)).slice(0, 30),
            lists: lists.length ? lists : undefined,
            next: [
              shaped
                ? final.origin
                  ? 'Steps read context.req.body as described in "body": map them with "variables". "requestVariables" are the raw request fields, for Get Data inputs only.'
                  : `${final.note ?? ''} "requestVariables" are the raw request fields Get Data can use.`.trim()
                : 'Map later steps only with the insert texts in "variables".',
              bodyIsList
                ? 'The body is a list: steps read one item by index (context.req.body[0].<field>), or offer run once per item (vs_set_trigger_loop, omit arrayKey) so each item runs the flow on its own.'
                : lists.length
                  ? 'If each item of one of "lists" should run the flow on its own, offer vs_set_trigger_loop with that arrayKey.'
                  : '',
            ]
              .filter(Boolean)
              .join(' '),
            ...panelResult(await openTriggerPanel(ctx, t.scriptId, kind)),
          },
          ctx.maxResultChars,
        )
      }
      if (run && fromThisTrigger) {
        // Email: one message per run.
        holdTriggerSample(ctx, t, trigger, run.body, { query: run.query, headers: run.headers })
        const src = triggerSampleSource(trigger, run.body, 'run')
        return bounded(
          {
            tested: true,
            sampleFound: true,
            from: `latest run${run.at ? ` (${run.at})` : ''}`,
            sample: trimData(src.data, strip),
            variables: variablesOf(src, strip, 60),
            ...panelResult(await openTriggerPanel(ctx, t.scriptId, kind)),
          },
          ctx.maxResultChars,
        )
      }
      const where = kind === 'webhook' ? `one request (POST with a JSON body) to ${ctx.vs.env.vmBase}/func/${t.scriptId}` : `one email to ${t.scriptId}@sokt.io`
      const otherTrigger = run && meaningful(run.body) && !fromThisTrigger
      return {
        tested: true,
        sampleFound: false,
        nextStep: `${otherTrigger ? 'The latest run came from the live trigger, which is not this draft trigger, so its data is not used. ' : 'No data received yet. '}Ask the user to send ${where}, then say done, and run vs_test_trigger again. Requests run the live version of the flow, so if nothing arrives the draft trigger may need to be published first. Never invent sample data.`,
      }
    }

    // App triggers: the same performlist test as the panel, with the saved (or held) connection and values.
    const holdKey = stepKey(ctx, t, `SET_TRIGGER:${str(trigger.selectedCreate) ?? ''}`)
    const noConnection = needsNoConnection(trigger.authType, kind)
    let authData: AuthData | undefined
    if (trigger.authType === 'NoAuth') authData = NO_AUTH
    else if (kind === 'manual_webhook') authData = asRecord(trigger.selectedValues?.authData) as AuthData
    else if (!trigger.isDrafted && trigger.selectedValues?.authData?.id) authData = trigger.selectedValues.authData
    let toTest = trigger
    let inputData = asRecord(trigger.selectedValues?.inputData)
    if (trigger.isDrafted) {
      // A drafted trigger has no saved values yet: test with the ones held from vs_set_trigger, as the panel would.
      const saved: SavedState = { inputData: {} }
      const merged = mergePending(holdKey, undefined, saved)
      const serviceId = str(trigger.serviceId) ?? ''
      const lookup = str(trigger.authIdLookup) ?? ''
      if (!authData && merged.connectionId && ROW_ID_RE.test(serviceId) && ROW_ID_RE.test(lookup)) {
        authData = await resolveConnection(ctx, merged.connectionId, serviceId, lookup, t)
      }
      if (!authData?.id && !noConnection) {
        return {
          tested: false,
          needsConnection: { serviceId, authIdLookup: lookup, actionVersionId: trigger.actionVersionId },
          next: 'Pick a connection (vs_list_connections, or vs_connect_app if there is none), then finish the trigger with vs_set_trigger.',
        }
      }
      const cfg = await configure(ctx, t, {
        holdKey,
        pd: trigger,
        values: merged.values,
        changed: new Set(Object.keys(merged.values)),
        base: {},
        authData,
        isTrigger: true,
        customInput: new Set(),
        noConnection,
        extra: { hookUrl: `${ctx.vs.env.vmBase}/func/${t.scriptId}` },
      })
      if (!cfg.complete) {
        return {
          tested: false,
          needsUserInput: cfg.needs,
          next: 'Ask the user for these (offer the real choices from vs_get_field_options), then save them with vs_set_trigger, which also tests the trigger.',
        }
      }
      toTest = { ...trigger, inputJson: cfg.inputJson }
      inputData = cfg.cleaned
    } else if (!authData?.id && !noConnection) {
      return {
        tested: false,
        needsConnection: { serviceId: trigger.serviceId, authIdLookup: trigger.authIdLookup, actionVersionId: trigger.actionVersionId },
        next: 'The saved trigger has no connection: pick one (vs_list_connections, or vs_connect_app) and save it with vs_set_trigger.',
      }
    }
    const test = await runTriggerTest(ctx, t, toTest, authData ?? ({} as AuthData), inputData)
    let savedWithTrigger = false
    if (test.found) {
      holdTriggerSample(ctx, t, trigger, test.message)
      if (trigger.isDrafted !== true) savedWithTrigger = await persistTriggerSample(ctx, t, trigger, test.message)
    }
    return bounded(
      {
        tested: true,
        app: trigger.serviceName,
        event: typeof trigger.actionName === 'string' ? trigger.actionName.replace(/_/g, ' ') : undefined,
        ...testReport(ctx, test, trigger),
        savedWithTrigger: savedWithTrigger || undefined,
        ...panelResult(await openTriggerPanel(ctx, t.scriptId, kind)),
        editorNote: test.found ? EDITOR_NOTE : undefined,
        note: test.found && trigger.isDrafted ? 'The trigger is still a draft: save it with vs_set_trigger.' : undefined,
      },
      ctx.maxResultChars,
    )
  },
})

export const TRIGGER_TOOLS: Tool<any>[] = [setTrigger, testTrigger]
