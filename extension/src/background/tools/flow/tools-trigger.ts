// vs_set_trigger: webhook, schedule (cron), email and app triggers.

import type { Tool } from '../types'
import { getActionRow, normalizeInputJson } from './catalog'
import { resolveConnection } from './connections'
import { call, ToolError } from './errors'
import { everPublished, getFlow, normalizeFlow, resolveFlow, triggerKind } from './flow-api'
import { encodeInputData } from './input-data'
import { defineTool, params, S } from './schema'
import { SCRIPT_ID_PARAM } from './tools-read'
import type { AuthData, Trigger } from './types'
import { asRecord, AUTH_ID_RE, FLOW_PAGES, ROW_ID_RE } from './util'

const APP_KINDS = new Set(['hook', 'polling', 'manual_webhook'])
// The scheduler only runs child flows of these intervals.
const POLL_MINUTES = [5, 15, 60, 720, 1440] as const
const CRON_FIELD = /^[0-9A-Za-z*/,\-?LW#]+$/
const TIMEZONE = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)*$/

interface SetTriggerArgs {
  kind: 'webhook' | 'cron' | 'email' | 'app'
  cronExpression?: string
  meaning?: string
  timezone?: string
  actionId?: string
  connectionId?: string
  inputData?: Record<string, unknown>
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

function precheck(a: SetTriggerArgs): void {
  const problems: string[] = []
  if (a.kind === 'cron') {
    const fields = (a.cronExpression ?? '').trim().split(/\s+/)
    if (!a.cronExpression || fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
      problems.push('cronExpression must be a standard 5-field cron expression, e.g. "0 9 * * 1-5".')
    }
    if (!a.meaning?.trim()) problems.push('meaning is required: the schedule in words, e.g. "Every weekday at 9:00 AM".')
    if (a.timezone && !TIMEZONE.test(a.timezone)) problems.push('timezone must be an IANA name such as "Asia/Kolkata".')
  }
  if (a.kind === 'app' && !a.actionId) problems.push('actionId is required for app triggers (vs_list_app_actions with kind "trigger").')
  if (a.kind !== 'app' && (a.actionId || a.connectionId || a.inputData || a.scheduledTime)) {
    problems.push('actionId, connectionId, inputData and scheduledTime are only for kind "app".')
  }
  if (problems.length) throw new ToolError(`Nothing was changed. ${problems.join(' ')}`)
}

const setTrigger = defineTool<SetTriggerArgs>({
  name: 'vs_set_trigger',
  description: [
    'Set what starts the flow.',
    '"webhook": runs when its URL receives a request (URL returned; it runs the live flow after publishing).',
    '"cron": on a schedule; give cronExpression (5 fields) AND meaning in words, optional IANA timezone.',
    '"email": runs on email to <flowId>@sokt.io; needs a flow whose id is all lowercase, so create the flow with vs_create_flow {lowercaseId: true} when email is planned.',
    '"app": an app event (actionId from vs_list_app_actions kind "trigger"; call vs_get_action for its fields); pass connectionId unless it is NoAuth, inputData for its fields, and scheduledTime (minutes) for polling triggers.',
    'Replacing an existing trigger of another type removes it (and a custom webhook response); the user is asked first.',
  ].join(' '),
  parameters: params(
    {
      kind: S.enum(['webhook', 'cron', 'email', 'app'], 'Trigger type.'),
      cronExpression: S.str('kind cron: 5-field cron expression, e.g. "0 9 * * 1-5".', { maxLength: 100 }),
      meaning: S.str('kind cron: the schedule in words, e.g. "Every weekday at 9:00 AM".', { maxLength: 120 }),
      timezone: S.str('kind cron: IANA timezone, e.g. "Asia/Kolkata". Defaults to the workspace timezone.', { maxLength: 64 }),
      actionId: S.str('kind app: trigger actionId from vs_list_app_actions (kind "trigger").', { pattern: ROW_ID_RE.source }),
      connectionId: S.str('kind app: connection id from vs_list_connections / vs_connect_app.', { pattern: AUTH_ID_RE.source }),
      inputData: S.map('kind app: field values keyed by field key from vs_get_action (same encoding as app steps).'),
      scheduledTime: S.enum(POLL_MINUTES, 'kind app, polling triggers only: check interval in minutes (default 15).'),
      scriptId: SCRIPT_ID_PARAM,
    },
    ['kind'],
  ),
  danger: 'write',
  pages: [...FLOW_PAGES],
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

    // App trigger lookups happen before anything is written, so a bad id or missing field changes nothing.
    let authData: AuthData | undefined
    if (a.kind === 'app') {
      const action = await getActionRow(ctx, a.actionId ?? '')
      if (action.type && action.type !== 'trigger') throw new ToolError('That action is not a trigger. Use vs_list_app_actions with kind "trigger".')
      const pre = encodeInputData(a.inputData ?? {}, normalizeInputJson(action.inputjson))
      if (pre.problems.length) throw new ToolError(`Nothing was changed. Fix these first: ${pre.problems.join(' | ')}`)
      if (action.authtype === 'NoAuth') authData = { id: 'NoAuth', type: 'NoAuth' }
      else {
        if (!a.connectionId) throw new ToolError('This app trigger needs a connection: pass connectionId (vs_list_connections or vs_connect_app).')
        if (!action.pluginrecordid || !action.authidlookup) throw new ToolError('This trigger has no connection settings.')
        authData = await resolveConnection(ctx, a.connectionId, action.pluginrecordid, action.authidlookup, t)
      }
    }

    const currentRow = await getFlow(ctx, t)
    const current = currentRow.json_script
    const curKind = triggerKind(current.trigger)
    const sameKind = a.kind === 'app' ? !!curKind && APP_KINDS.has(curKind) && current.trigger?.selectedCreate === a.actionId : curKind === a.kind
    // Changing the trigger type deletes the old trigger (and leaving webhook deletes the response block).
    if (curKind && !sameKind) {
      const loseResponse = curKind === 'webhook' && current.blocks.response?.responseType === 'custom'
      const live = everPublished(currentRow) ? ' The live flow keeps its current trigger until you publish.' : ''
      const ok = await ctx.ui.confirm(
        'Replace the trigger?',
        `This flow is started by ${describeTrigger(current.trigger)}. Switching to ${a.kind === 'app' ? 'an app trigger' : `a ${a.kind} trigger`} removes it${loseResponse ? ', together with the custom webhook response' : ''}.${live}`,
        true,
        'Replace trigger',
      )
      if (!ok) return { changed: false, message: 'The user kept the current trigger.' }
    }

    const vmBase = ctx.vs.env.vmBase
    return ctx.vs.mutate(t.scriptId, async () => {
      await ctx.vs.alignOrg(ctx.signal)
      const js = (await getFlow(ctx, t)).json_script
      const post = (body: Record<string, unknown>, what: string) =>
        call(what, () => ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/trigger`, body, live: true, signal: ctx.signal }))

      switch (a.kind) {
        case 'webhook':
          await post({ triggerType: 'webhook', type: 'add' }, 'Setting the webhook trigger')
          return { trigger: 'webhook', url: `${vmBase}/func/${t.scriptId}`, note: 'The URL runs the flow after it is published. Use vs_test_flow to try the draft.' }
        case 'email':
          await post({ triggerType: 'email', type: 'add' }, 'Setting the email trigger')
          return { trigger: 'email', address: `${t.scriptId}@sokt.io` }
        case 'cron': {
          // Never send `statement`: it routes through an external AI service and overrides the expression.
          const body: Record<string, unknown> = { triggerType: 'cron', type: 'add', cronExpression: a.cronExpression?.trim(), meaning: a.meaning?.trim() }
          if (a.timezone) body.timezone = a.timezone
          await post(body, 'Setting the schedule')
          return { trigger: 'cron', cronExpression: body.cronExpression, meaning: body.meaning, timezone: a.timezone, note: 'The schedule starts after publishing.' }
        }
        case 'app': {
          const cur = js.trigger
          const update = !!cur && APP_KINDS.has(String(cur.triggerType)) && cur.selectedCreate === a.actionId && cur.isDrafted !== true
          let base: Trigger
          let drafted = false
          if (update && cur) base = cur
          else {
            const res = await call('Drafting the app trigger', () =>
              ctx.vs.request({ method: 'POST', path: `/scripts/${t.projectId}/${t.scriptId}/drafttrigger/${a.actionId}`, body: {}, live: true, signal: ctx.signal }),
            )
            const trig = normalizeFlow(asRecord(res).data)?.json_script.trigger
            if (!trig?.actionVersionId) throw new ToolError('viaSocket did not return the drafted trigger. Call vs_get_flow to check.')
            base = trig
            drafted = true
          }
          const triggerType = String(base.triggerType || 'hook')
          if (!APP_KINDS.has(triggerType)) throw new ToolError(`Unsupported app trigger type "${triggerType}".`)
          const encoded = encodeInputData(a.inputData ?? {}, normalizeInputJson(base.inputJson), asRecord(base.selectedValues?.inputData))
          const inputData = encoded.inputData
          if (triggerType === 'hook') inputData.hookUrl = `${vmBase}/func/${t.scriptId}`
          if (triggerType === 'polling') {
            const prev = Number(inputData.scheduledTime)
            inputData.scheduledTime = a.scheduledTime ?? ((POLL_MINUTES as readonly number[]).includes(prev) ? prev : 15)
          }
          const body: Record<string, unknown> = {
            ...base,
            selectedValues: { ...asRecord(base.selectedValues), authData, inputData },
            type: update ? 'update' : 'add',
            triggerType,
            name: 'trigger',
          }
          delete body.isDrafted
          try {
            await post(body, 'Saving the app trigger')
          } catch (e) {
            if (!drafted) throw e
            throw new ToolError(
              `The app trigger was drafted but saving it failed (${e instanceof Error ? e.message : String(e)}). The flow cannot be published until the trigger is saved; fix the values and call vs_set_trigger again.`,
            )
          }
          return {
            trigger: triggerType,
            app: base.serviceName,
            action: base.actionName,
            checkEveryMinutes: triggerType === 'polling' ? inputData.scheduledTime : undefined,
            url: triggerType === 'manual_webhook' ? `${vmBase}/func/${t.scriptId}` : undefined,
            warnings: [
              ...(encoded.unknownKeys.length ? [`Ignored unknown fields: ${encoded.unknownKeys.join(', ')}`] : []),
              ...(encoded.missingRequired.length ? [`Required fields still empty: ${encoded.missingRequired.join(', ')}`] : []),
            ],
            note: 'The trigger is active after publishing. Its event data is available to steps as context.req.body.',
          }
        }
      }
    })
  },
})

export const TRIGGER_TOOLS: Tool<any>[] = [setTrigger]
