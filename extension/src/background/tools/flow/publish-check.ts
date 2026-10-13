// What must be fixed before a flow is published: the editor's own publish check (unsaved steps, missing
// dependencies, inactive steps used elsewhere, an empty custom response, a drafted trigger) plus the server's
// preconditions (trigger and Get Data connections present and not expired) and the structural rules that keep later
// edits working (saved branch conditions, a break last in its group, expressions that parse, a usable run-if).
// The server itself runs only some of these; publishing through the API with drafts "succeeds" and silently drops
// those steps, so the assistant checks first and fixes what is listed.

import type { ToolContext } from '../types'
import { VsError } from '../viasocket-client'
import { triggerKind } from './flow-api'
import { checkExpression } from './js-check'
import { runIfProblems } from './trigger-features'
import { checkMappings } from './mapping'
import { buildCatalogue, flowOrder, usable } from './samples'
import type { FlowRow, FlowTarget } from './types'
import { asArray, asRecord, AUTH_ID_RE, isRecord, str, truncate } from './util'

/** false when viaSocket reports the connection expired or unknown; undefined when the check itself failed. */
export async function connectionValid(ctx: ToolContext, authId: string): Promise<boolean | undefined> {
  try {
    const body = await ctx.vs.request({ method: 'GET', path: `/authtoken/authvalid/${encodeURIComponent(authId)}`, signal: ctx.signal })
    return asRecord(asRecord(body).data).valid === true
  } catch (e) {
    if (e instanceof VsError && e.kind === 'aborted') throw e
    return undefined
  }
}

export interface Readiness {
  /** Must be fixed before publishing */
  blocking: string[]
  /** Worth telling the user; publishing is still possible */
  warnings: string[]
}

/** Path parts of a used-variables entry: context.res.Step["a"][0] -> [context, res, Step, a, 0] */
function pathParts(path: string): string[] {
  return path
    .replace(/\?\./g, '.')
    .split(/[.[\]]+/)
    .map((p) => p.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

export async function publishReadiness(ctx: ToolContext, row: FlowRow, t?: FlowTarget): Promise<Readiness> {
  const blocking: string[] = []
  const warnings: string[] = []
  const js = row.json_script
  const trigger = js.trigger
  const kind = triggerKind(trigger)
  const order = flowOrder(js)
  const position = new Map(order.map((s, i) => [s, i]))

  // Trigger.
  if (!trigger || !kind) blocking.push('The flow has no trigger: set one with vs_set_trigger.')
  else if (trigger.isDrafted === true) {
    blocking.push(
      kind === 'cron'
        ? 'The schedule is not saved yet (it was created from Get Data): set it with vs_set_trigger kind "cron".'
        : 'The app trigger was picked but never saved: finish it with vs_set_trigger.',
    )
  }
  const isApp = !!kind && !['webhook', 'email', 'cron'].includes(kind)
  const triggerAuth = str(trigger?.selectedValues?.authData?.id)
  if (isApp && trigger?.isDrafted !== true && kind !== 'manual_webhook' && trigger?.authType !== 'NoAuth') {
    if (!triggerAuth) blocking.push("The app trigger has no connection: pick one and save it with vs_set_trigger (connectionId).")
    else if (triggerAuth !== 'NoAuth' && AUTH_ID_RE.test(triggerAuth) && (await connectionValid(ctx, triggerAuth)) === false) {
      blocking.push("The app trigger's connection has expired or was removed. Reconnect with vs_connect_app, then pass the new connectionId to vs_set_trigger.")
    }
  }

  // Get Data: its connection is checked like the trigger's.
  const pre = isRecord(trigger?.preProcess) ? (trigger?.preProcess as Record<string, unknown>) : undefined
  if (pre) {
    if (kind !== 'webhook' && kind !== 'cron') warnings.push('Get Data is set but only runs for webhook and schedule triggers; it is ignored for this trigger.')
    if (str(pre.type) === 'plugin') {
      const code = asRecord(pre.code)
      const auth = str(pre.auth_id) ?? str(asRecord(asRecord(code.selectedValues).authData).id)
      if (!auth && str(code.authType) !== 'NoAuth') blocking.push('Get Data has no connection: set it again with vs_set_get_data (connectionId).')
      else if (auth && auth !== 'NoAuth' && AUTH_ID_RE.test(auth) && (await connectionValid(ctx, auth)) === false) {
        blocking.push("Get Data's connection has expired or was removed. Reconnect with vs_connect_app, then pass the new connectionId to vs_set_get_data.")
      }
    }
  }

  // Run-if: an enabled empty or broken condition skips every run.
  const pc = asRecord(trigger?.preCondition)
  if (pc.conditionEnabled === true) {
    const code = str(pc.code) ?? ''
    if (!code.trim()) blocking.push('Run-if is on but empty, which skips EVERY run: set a condition with vs_set_run_condition or turn it off (disable).')
    else {
      const p = runIfProblems(code)
      if (p.length) blocking.push(`Run-if "${truncate(code, 80)}" would skip every run: ${p.join('; ')}. Fix it with vs_set_run_condition.`)
      else if (t && kind && (kind === 'webhook' || kind === 'cron')) {
        // Written for an earlier body shape (Get Data or the loop changed since)? Checked against the body it sees now.
        try {
          const cat = await buildCatalogue(ctx, t, row, { at: 'insert', parent: 'root', atStart: true })
          if (usable(cat.byId.get('trigger'), false)) {
            const r = checkMappings([{ where: 'run-if', text: code, mode: 'code' }], cat, { allowDocumented: false })
            if (r.problems.length) warnings.push(`Run-if reads fields the current body does not have, so it may skip every run: ${r.problems.slice(0, 2).join(' | ')}. Check it with vs_set_run_condition.`)
          }
        } catch (e) {
          if (e instanceof VsError && e.kind === 'aborted') throw e
        }
      }
    }
  }
  const loopsOn = asRecord(trigger?.loops).loopsEnabled === true
  if (loopsOn && kind === 'cron' && !pre) warnings.push('Run once per item is on for a schedule without Get Data, so there is no list to loop over.')

  // Steps (editor check): unsaved, branch conditions, structure.
  const drafts = order.filter((s) => {
    const b = js.blocks[s]
    return !!b && s !== 'response' && b.status === 'DRAFTED' && b.type !== 'ifGroup'
  })
  if (drafts.length) blocking.push(`These steps are unsaved drafts and would be dropped on publish: ${drafts.join(', ')}. Save them with vs_update_step or delete them.`)
  const inactive = new Set(order.filter((s) => js.blocks[s]?.status === 'INACTIVE'))
  for (const s of order) {
    const b = js.blocks[s]
    if (!b) continue
    if (b.type === 'ifBlock' && !b.isElseBlock) {
      if (b.status === 'INACTIVE') blocking.push(`Branch "${s}" is paused, so the steps inside it run without the condition. Delete it or save it again with vs_update_step.`)
      else if (b.status !== 'DRAFTED' && !str(b.condition)?.trim()) blocking.push(`Branch "${s}" has no condition: set one with vs_update_step.`)
    }
    if (b.type === 'ifGroup') {
      const bad = (js.order[s] ?? []).filter((c) => js.blocks[c]?.type !== 'ifBlock')
      if (bad.length) blocking.push(`Condition "${s}" holds non-branch items (${bad.join(', ')}); move them into a branch or to the top level.`)
    }
    const expr = b.type === 'variable' ? str(b.data) : b.type === 'ifBlock' && !b.isElseBlock ? str(b.condition) : b.type === 'break' ? str(b.data) : undefined
    if (expr?.trim() && b.status !== 'DRAFTED') {
      const p = checkExpression(expr)
      if (p) blocking.push(`"${s}": ${p}. A broken expression breaks the whole flow.`)
    }
  }
  for (const [group, list] of Object.entries(js.order)) {
    const breakAt = list.findIndex((s) => js.blocks[s]?.type === 'break')
    if (breakAt >= 0 && breakAt !== list.length - 1) blocking.push(`A break must be the last step of "${group}"; move it with vs_move_step.`)
  }
  const response = js.blocks.response
  if (response?.responseType === 'custom') {
    const data = str(response.data) ?? ''
    if (!data.trim()) blocking.push('The custom webhook response is empty: set it with vs_set_response (or use responseType "default").')
    else {
      const p = checkExpression(data)
      if (p) blocking.push(`The custom webhook response does not parse: ${p}.`)
    }
    if (loopsOn) warnings.push('Run once per item is on, so callers get "Flow Queued" instead of the custom response.')
  }

  // Missing dependencies and paused steps used elsewhere (from viaSocket's own used_variables).
  const used = asRecord(row.used_variables)
  const missing = new Set<string>()
  for (const [slug, paths] of Object.entries(asRecord(used.functions))) {
    const at = position.get(slug)
    if (at === undefined) continue
    for (const raw of asArray(paths)) {
      if (typeof raw !== 'string') continue
      const parts = pathParts(raw)
      const ref = parts[2]
      if (!ref || ['req', 'inputData', 'authData'].includes(parts[1] ?? '')) continue
      const refAt = position.get(ref)
      if (refAt === undefined || refAt >= at) missing.add(`"${slug}" uses ${ref}, which ${refAt === undefined ? 'does not exist' : 'runs after it'}`)
    }
  }
  if (missing.size) blocking.push(`Missing dependencies: ${[...missing].slice(0, 8).join('; ')}. Remap those fields or move the steps.`)
  const inactiveUsed = new Set<string>()
  for (const key of Object.keys(asRecord(used.variables))) {
    const parts = pathParts(key)
    if ((parts[1] === 'res' || parts[1] === 'vals') && parts[2] && inactive.has(parts[2])) inactiveUsed.add(parts[2])
  }
  if (inactiveUsed.size) blocking.push(`Paused steps whose output other steps use: ${[...inactiveUsed].join(', ')}. Resume them in the editor or remap the fields that use them.`)
  return { blocking, warnings }
}
