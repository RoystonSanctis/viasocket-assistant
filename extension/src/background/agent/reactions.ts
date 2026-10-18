// Reacting to what the user does on the page, driven by mascot.reactions in the config. Reactions are free
// (no LLM call); only the "Explain" button they may offer costs a request, and only when the user presses it.

import type { FullConfig, ReactionConfig } from '../../shared/config'
import type { HighlightTarget, Suggestion } from '../../shared/mascot'
import type { ObservedEvent } from '../../shared/observed'
import { loadSettings, type Proactivity } from '../../shared/settings'
import { getConfig } from '../config-loader'
import { buildToolset } from '../tools'
import { loadPlan, postLine, savePlan } from './conversation'
import { summarizeEvent } from './events'
import { describeSafely, executeTool, isAbort, validateArgs } from './execute'
import { fetchLiveFlowSummary, runAgent } from './loop'
import { reconcilePlanWithFlow, type ReconcileResult } from './plan'
import { pinTarget, releaseTarget, rememberSuggestionPage, suggestionStillApplies } from './run-target'
import type { PendingSuggestion, Session } from './session'

export const EXPLAIN_TOOL = '__explain'
const EXPLAIN_REQUEST = 'Explain the page event shown under "Event to explain", and how to fix it.'
const BUSY_NOTE = "I'm still working on something. Try that again when I'm done."
const MOVED_NOTE = 'That suggestion was for a different flow or plug. Ask me again here.'
const LEVELS: Record<Proactivity, number> = { quiet: 0, helpful: 1, proactive: 2 }
const REACTION_SETTLE_MS = 6000
const PROACTIVE_COOLDOWN_MS = 3500

function ruleMatches(rule: ReactionConfig, event: ObservedEvent, level: Proactivity): boolean {
  if (rule.on !== event.kind) return false
  if (rule.when?.ok !== undefined && rule.when.ok !== event.ok) return false
  if (rule.when?.byAssistant !== undefined && rule.when.byAssistant !== event.byAssistant) return false
  return LEVELS[level] >= LEVELS[rule.minLevel]
}

function reactionTarget(rule: ReactionConfig, event: ObservedEvent, config: FullConfig): HighlightTarget | undefined {
  if (!rule.highlight) return undefined
  if (rule.highlight === 'step') return event.slugName ? { slugName: event.slugName } : undefined
  const known = rule.highlight in config.selectors.flow || rule.highlight in config.selectors.devHub
  return known ? { selectorKey: rule.highlight } : undefined
}

export async function handleObserved(session: Session, event: ObservedEvent): Promise<void> {
  session.pushEvent(event)
  // During a run the agent narrates its own work; the event is still recorded for the next prompt.
  if (session.busy) return
  const [settings, config] = await Promise.all([loadSettings(), getConfig()])
  if (config.flags.disabled || session.busy) return

  // 1. Reconcile plan checklist automatically with live flow and observed event
  let reconcileResult: ReconcileResult | null = null
  const thread = session.threadKey
  if (thread && session.page && session.vs) {
    const plan = await loadPlan(thread).catch(() => null)
    if (plan) {
      const liveFlow = await fetchLiveFlowSummary({ page: session.page, vs: session.vs }).catch(() => null)
      reconcileResult = reconcilePlanWithFlow(plan, liveFlow, event)
      if (reconcileResult.changed) {
        await savePlan(thread, reconcileResult.plan)
        session.send({ type: 'plan', plan: reconcileResult.plan })
      }
    }
  }

  // 2. Proactive AI Awareness in proactive mode (or when active plan unblocks)
  const isProactiveEvent =
    event.kind === 'step-tested' ||
    event.kind === 'step-created' ||
    event.kind === 'step-saved' ||
    event.kind === 'trigger-saved'

  const shouldBeProactive =
    !session.busy &&
    !session.voiceTurn &&
    !session.closed &&
    !event.byAssistant &&
    (
      (settings.proactivity === 'proactive' && isProactiveEvent) ||
      (reconcileResult !== null && reconcileResult.unblocked.length > 0) ||
      (reconcileResult !== null && reconcileResult.newlyDone.length > 0 && reconcileResult.nextItem !== undefined)
    )

  if (shouldBeProactive) {
    const proactiveKey = `proactive:${event.kind}:${event.slugName || ''}`
    const now = Date.now()
    if (now - (session.reactionCooldowns.get(proactiveKey) ?? 0) >= PROACTIVE_COOLDOWN_MS) {
      session.reactionCooldowns.set(proactiveKey, now)
      await triggerProactiveAgent(session, event, reconcileResult)
      return
    }
  }

  if (!settings.mascotEnabled) return

  const rules = config.mascot.reactions
  const index = rules.findIndex((r) => ruleMatches(r, event, settings.proactivity))
  const rule = rules[index]
  if (!rule) return

  const cooldownKey = `${index}:${rule.on}`
  const now = Date.now()
  if (now - (session.reactionCooldowns.get(cooldownKey) ?? 0) < rule.cooldownSeconds * 1000) return
  session.reactionCooldowns.set(cooldownKey, now)

  const ui = session.ui
  ui.mascot(rule.mood, rule.say)
  const target = reactionTarget(rule, event, config)
  if (target) ui.highlight(target)

  if (rule.offerExplain) {
    const suggestion: Suggestion = {
      id: crypto.randomUUID(),
      message: rule.say ?? 'Want me to explain what happened?',
      mood: rule.mood,
      target,
      apply: { tool: EXPLAIN_TOOL, args: { event: summarizeEvent(event) }, label: 'Explain' },
    }
    const entry: PendingSuggestion = { suggestion, event }
    rememberSuggestionPage(entry, session.page)
    session.addSuggestion(entry)
    session.send({ type: 'suggestion', suggestion })
  }
  session.settleMascot(REACTION_SETTLE_MS)
}

export async function handleSuggestionResponse(session: Session, id: string, action: 'apply' | 'dismiss'): Promise<void> {
  const entry = session.pendingSuggestions.get(id)
  if (!entry) return
  const { suggestion, event } = entry
  const note = (text: string) => postLine(session, 'system-note', text, true)
  if (action === 'dismiss') {
    session.pendingSuggestions.delete(id)
    if (suggestion.target) session.ui.clearHighlight()
    return
  }
  const apply = suggestion.apply
  if (!apply) {
    session.pendingSuggestions.delete(id)
    return
  }
  if (session.busy) {
    keepForLater(session, entry)
    return
  }
  if (!suggestionStillApplies(entry, session.page)) {
    session.pendingSuggestions.delete(id)
    note(MOVED_NOTE)
    return
  }
  if (apply.tool === EXPLAIN_TOOL) {
    session.pendingSuggestions.delete(id)
    // Only reaction suggestions carry an event, stored here so the content script cannot alter it. Its text is
    // passed as marked data in the system prompt, never as part of the user's message.
    if (event) await runAgent(session, EXPLAIN_REQUEST, 'text', { explainEvent: event })
    return
  }
  await applySuggestedTool(session, id, entry, apply.tool, apply.args)
}

/** Apply while a run is going: keep the suggestion and show its card again (the panel drops it on click). */
function keepForLater(session: Session, entry: PendingSuggestion): void {
  postLine(session, 'system-note', BUSY_NOTE)
  session.send({ type: 'suggestion', suggestion: entry.suggestion })
}

/** Runs a tool the model proposed through a suggestion card. Same checks and confirmation gate as the agent loop. */
async function applySuggestedTool(
  session: Session,
  id: string,
  entry: PendingSuggestion,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<void> {
  const note = (text: string) => postLine(session, 'system-note', text, true)
  const config = await getConfig()
  // Checked again after the await: a run may have started, or the tab moved on, in the meantime.
  if (session.busy) {
    keepForLater(session, entry)
    return
  }
  session.pendingSuggestions.delete(id)
  const page = session.page
  if (!page || !session.vs || !suggestionStillApplies(entry, page)) {
    note(MOVED_NOTE)
    return
  }
  const tool = buildToolset({ page, flags: config.flags, toolsConfig: config.tools }).find((t) => t.name === name)
  if (!tool) {
    note("That action isn't available on this page.")
    return
  }
  const prepared = validateArgs(tool, rawArgs && typeof rawArgs === 'object' ? rawArgs : {})
  if ('error' in prepared) {
    note(`I couldn't apply that: ${prepared.error}`)
    return
  }

  const signal = session.beginRun()
  const target = pinTarget(session)
  const label = describeSafely(tool, prepared.args)
  try {
    if (!target) throw new Error('The page went away.')
    // Clicking Apply on a card the model wrote is not consent to its exact arguments, so anything that changes
    // viaSocket asks with them shown.
    const outcome = await executeTool(session, tool, prepared.args, config, signal, target, tool.danger !== 'safe')
    if (outcome.declined) note(`Skipped: ${label}`)
    else if (outcome.ok) {
      note(`Done: ${label}`)
      session.ui.mascot('happy')
    } else {
      note(`${label} failed: ${errorFromContent(outcome.content)}`)
      if (outcome.authFailed) note(config.mascot.lines.authFailed ?? 'Your viaSocket session expired. Refresh the page and sign in again.')
    }
  } catch (e) {
    if (isAbort(e, signal)) note(config.mascot.lines.cancelled ?? 'Okay, stopped.')
    else note(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    releaseTarget(session, target)
    session.endRun()
    session.settleMascot(3000)
  }
}

function errorFromContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error
    }
  } catch {
    // not JSON
  }
  return content.slice(0, 200)
}

async function triggerProactiveAgent(
  session: Session,
  event: ObservedEvent,
  reconcile: ReconcileResult | null,
): Promise<void> {
  const slug = event.slugName ? event.slugName.replace(/[_-]+/g, ' ') : ''
  let instruction = ''

  if (event.kind === 'step-tested') {
    if (event.ok) {
      instruction = slug
        ? `Step "${slug}" was just tested successfully in the viaSocket UI (test passed).`
        : 'The step was just tested successfully in the viaSocket UI (test passed).'
    } else {
      const err = event.errorText ? ` with error: "${event.errorText}"` : ''
      instruction = slug
        ? `Step "${slug}" test failed in the viaSocket UI${err}.`
        : `The step test failed in the viaSocket UI${err}.`
    }
  } else if (event.kind === 'step-created') {
    instruction = slug
      ? `A new step "${slug}" was just added in the viaSocket flow UI.`
      : 'A new step was just added in the viaSocket flow UI.'
  } else if (event.kind === 'step-saved') {
    instruction = slug
      ? `Step "${slug}" was configured and saved in the viaSocket UI.`
      : 'The step was configured and saved in the viaSocket UI.'
  } else if (event.kind === 'trigger-saved') {
    instruction = 'The trigger was configured and saved in the viaSocket UI.'
  } else {
    instruction = `Observed UI action: ${event.kind}.`
  }

  if (reconcile?.newlyDone.length) {
    const titles = reconcile.newlyDone.map((i) => `"${i.title}"`).join(', ')
    instruction += ` Plan item(s) completed: ${titles}.`
  }
  if (reconcile?.nextItem && reconcile.nextItem.status !== 'done') {
    instruction += ` Next plan item: "${reconcile.nextItem.title}".`
  }

  if (event.kind === 'step-tested' && !event.ok) {
    instruction += ' Briefly acknowledge the test failure (1-2 friendly sentences) and offer concise guidance to fix it.'
  } else {
    instruction += ' Briefly acknowledge what happened in 1-2 friendly sentences and guide the user on the next step or continue the build.'
  }

  await runAgent(session, instruction, 'text', { proactive: true })
}

