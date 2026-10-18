// The agent loop: ask the model, run the tools it calls one at a time, feed results back, repeat until it answers.

import type { FullConfig } from '../../shared/config'
import { PLAN_APPROVE_TEXT } from '../../shared/mascot'
import type { ObservedEvent } from '../../shared/observed'
import { loadSettings, type UserSettings } from '../../shared/settings'
import { getConfig } from '../config-loader'
import { MAX_RETRY_WAIT_MS } from '../llm/http'
import { knownContextLength } from '../llm/models'
import { adapterFor, resolveProvider } from '../llm/registry'
import { LlmError, type ChatMessage, type ChatRequest, type ChatResponse, type LlmAdapter, type ResolvedProvider, type ToolCall } from '../llm/types'
import { buildToolset } from '../tools'
import type { Tool } from '../tools/types'
import { VsError } from '../tools/viasocket-client'
import { speakReply, stopSpeaking } from '../voice'
import { carryOver, fitBudget, loadPlan, loadThread, postLine, saveMessages, savePlan, showThread, trimMessages, type Thread } from './conversation'
import { errorContent, executeTool, isAbort, prepareArgs } from './execute'
import { approvePlan, awaitingReply, reconcilePlanWithFlow } from './plan'
import { buildSystemPrompt } from './prompt'
import { PageMovedError, followPage, pinTarget, releaseTarget, type RunTarget } from './run-target'
import type { Session } from './session'
import { NO_MODEL_MESSAGE, computeStatus, pickModel } from './status'
import { normalizeFlow, summarizeFlow } from '../tools/flow/flow-api'
import type { FlowTarget } from '../tools/flow/types'
import { asRecord } from '../tools/flow/util'
import type { PageContext } from '../../shared/page'
import type { ViaSocketClient } from '../tools/viasocket-client'

export async function fetchLiveFlowSummary(target: { page: PageContext; vs: ViaSocketClient }, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (target.page.kind !== 'flow-editor' || !target.page.scriptId || !target.page.projectId || !target.page.orgId) {
    return null
  }
  try {
    const t: FlowTarget = {
      orgId: target.page.orgId,
      projectId: target.page.projectId,
      scriptId: target.page.scriptId,
    }
    const body = await target.vs.request({
      method: 'GET',
      path: `/scripts/${t.scriptId}`,
      signal,
    })
    const row = normalizeFlow(asRecord(body).data)
    if (!row) return null
    return summarizeFlow(row, t, [], target.vs.env.vmBase)
  } catch {
    return null
  }
}

const STOP_WORDS = /^(stop|cancel|stop it|never ?mind)[.!]*$/i
const BUSY_MESSAGE = "Still working on the last request — say 'stop' or press cancel."
const THREAD_BUSY_MESSAGE = "I'm already working on this flow or plug in another tab. Try again when that finishes."
const MAX_INPUT_CHARS = 4000
const RATE_LIMIT_BACKOFF_MS = [2000, 5000, 10000]
const TRANSIENT_RETRY_MS = 1500
const PUBLISH_TOOLS = new Set(['vs_publish_flow', 'dh_publish_action_version', 'dh_publish_plugin'])
/** Write tools run without asking, so a model that emits a burst of calls in one answer is capped. */
const MAX_CALLS_PER_TURN = 8
// History budget per request, in characters (about 4 per token). Tool definitions plus prompts are already
// 12-14k tokens, so small-context and low-TPM models need the history kept in check.
const CHARS_PER_TOKEN = 4
const DEFAULT_HISTORY_CHARS = 60_000
const MIN_HISTORY_CHARS = 8_000
const OUTPUT_RESERVE_TOKENS = 4096
const TOO_LARGE = /context.{0,20}(length|window|limit)|too (large|long)|maximum.{0,40}tokens|token limit|reduce the length/i
const CUT_OFF = new Set(['length', 'max_tokens'])
const NORMAL_FINISH = new Set(['stop', 'end_turn', 'tool_calls', 'tool_use'])

/** Threads with a run in progress in any tab: two runs on one thread would overwrite each other's saved history. */
const activeThreads = new Set<string>()
/** Sessions a failed run marked "needs setup"; the next successful model call clears the banner. */
const staleStatus = new WeakSet<Session>()

interface RunContext {
  session: Session
  config: FullConfig
  settings: UserSettings
  provider: ResolvedProvider
  adapter: LlmAdapter
  model: string
  messages: ChatMessage[]
  thread: string
  signal: AbortSignal
  target: RunTarget
  contextLength?: number
  explainEvent?: ObservedEvent
}

export interface RunOptions {
  /** "Explain" on a reaction: the event reaches the model as marked data in the system prompt, not as user text */
  explainEvent?: ObservedEvent
  /** Proactive run triggered by an observed UI event; does not post a synthetic user chat line */
  proactive?: boolean
}

export async function runAgent(session: Session, userText: string, _source: 'voice' | 'text', opts: RunOptions = {}): Promise<void> {
  const text = userText.trim().slice(0, MAX_INPUT_CHARS)
  if (!text) return
  const isStop = STOP_WORDS.test(text)
  if (session.busy) {
    if (isStop) session.cancelRun()
    else postLine(session, 'system-note', BUSY_MESSAGE)
    return
  }
  if (isStop) {
    stopSpeaking()
    session.ui.mascot('idle')
    return
  }

  // Claim the session before the first await so a second message cannot start a parallel run, and pin what the
  // run acts on: the page the user asked from, whatever the tab shows later.
  const signal = session.beginRun()
  const target = pinTarget(session)
  stopSpeaking()
  let thread: string | null = null
  let claimedThread = false
  let messages: ChatMessage[] | null = null
  let maxMessages = 0
  let movedAway = false
  let completed = false
  try {
    if (!opts.proactive) {
      postLine(session, 'user', text)
    }
    const [config, settings] = await Promise.all([getConfig(), loadSettings()])
    if (config.flags.disabled) {
      postLine(session, 'system-note', config.flags.disabledMessage ?? 'The assistant is switched off for now.')
      return
    }
    thread = session.threadKey
    if (!target || !thread) {
      postLine(session, 'system-note', 'I can only help inside the viaSocket app. Open a flow, a project or the Developer Hub.')
      return
    }
    if (activeThreads.has(thread)) {
      postLine(session, 'system-note', THREAD_BUSY_MESSAGE)
      return
    }
    activeThreads.add(thread)
    claimedThread = true
    const model = pickModel(settings, config)
    if (!model) {
      staleStatus.add(session)
      session.send({ type: 'status', llmReady: false, reason: NO_MODEL_MESSAGE })
      postLine(session, 'system-note', NO_MODEL_MESSAGE)
      session.ui.mascot('confused')
      session.settleMascot(4000)
      return
    }
    const provider = await resolveProvider(settings.providerId, config)
    const adapter = adapterFor(provider.adapter)
    const contextLength = await knownContextLength(provider, model)

    maxMessages = config.flags.conversationMaxMessages
    const history = await loadThread(thread)
    const promptContent = opts.proactive ? `[Observed UI Event]: ${text}` : text
    messages = [...history.messages, { role: 'user', content: promptContent }]
    await saveMessages(thread, messages, maxMessages)

    // The plan card's "Looks good, start" button: the plan stops waiting for approval before the model even answers.
    if (!opts.proactive && text === PLAN_APPROVE_TEXT) await approvePlan(session, thread).catch(() => false)

    session.ui.mascot('thinking')
    await agentLoop({
      session, config, settings, provider, adapter, model, messages, thread, signal, target, contextLength,
      explainEvent: opts.explainEvent,
    })
    completed = true
  } catch (e) {
    movedAway = e instanceof PageMovedError
    if (thread && messages) await closeOpenRequest(thread, messages, maxMessages, e, signal)
    await reportRunError(session, e, signal)
  } finally {
    if (claimedThread && thread) activeThreads.delete(thread)
    releaseTarget(session, target)
    await finishRun(session, target, movedAway, completed)
  }
}

/**
 * A failed or stopped run must not leave the request looking open in saved history, or the next turn may carry
 * it out (for example finish a chain the user stopped).
 */
async function closeOpenRequest(thread: string, messages: ChatMessage[], maxMessages: number, e: unknown, signal: AbortSignal): Promise<void> {
  const last = messages[messages.length - 1]
  if (last?.role !== 'user' && last?.role !== 'tool') return
  const why =
    e instanceof PageMovedError
      ? 'Stopped because the user moved to a different flow or plug'
      : isAbort(e, signal)
        ? 'Stopped by the user before finishing'
        : 'Could not finish because of an error'
  messages.push({ role: 'assistant', content: `(${why}. Do not resume this request unless the user asks again.)` })
  try {
    await saveMessages(thread, messages, maxMessages)
  } catch (err) {
    console.warn('[assistant] could not save the stopped run:', err instanceof Error ? err.message : err)
  }
}

/**
 * Ends the run and, when the tab is now on another flow or plug the run did not open itself, shows that page's own
 * conversation. A reload the user confirmed during the run is sent last, and only after a run that finished: on a
 * stop or an error the page keeps the note saying so, and a page the user moved to is never reloaded.
 */
async function finishRun(session: Session, target: RunTarget | null, movedAway: boolean, completed: boolean): Promise<void> {
  const reload = session.pendingReload
  const runThread = session.threadKey
  const now = session.page ? session.threadOf(session.page) : null
  // followPage again: the page change for a navigation the run made last may only have arrived during its answer.
  const followed = !!target && !movedAway && !!now && followPage(session, target) && session.threadOf(target.page) === now
  const leftBehind = !!runThread && !!now && now !== runThread && !followed
  let shown: Thread | null = null
  if (leftBehind) {
    // Loaded before endRun so a new run cannot post a line that this history then hides.
    shown = await loadThread(now).catch(() => null)
  }
  session.endRun()
  if (runThread && now && now !== runThread && followed) {
    // The run navigated (e.g. into a flow it just created): let the conversation follow the user there.
    carryOver(runThread, now).catch(() => undefined)
  }
  if (shown) showThread(session, shown)
  if (movedAway) postLine(session, 'system-note', new PageMovedError().message)
  if (reload !== null && completed && !movedAway && !leftBehind) session.send({ type: 'reload-page', reason: reload })
}

function historyBudget(contextLength: number | undefined, fixedChars: number, shrink: boolean): number {
  let budget = DEFAULT_HISTORY_CHARS
  if (contextLength) budget = Math.min(budget, (contextLength - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN - fixedChars)
  if (shrink) budget = Math.floor(budget / 4)
  return Math.max(MIN_HISTORY_CHARS, budget)
}

async function agentLoop(run: RunContext): Promise<void> {
  const { session, config, settings, messages, thread, signal, target } = run
  const { flags, mascot } = config
  const ui = session.ui
  let published = false

  for (let step = 0; step < flags.maxAgentSteps; step++) {
    signal.throwIfAborted()
    if (!followPage(session, target)) throw new PageMovedError()
    const tools = buildToolset({ page: target.page, flags, toolsConfig: config.tools })
    const toolSpecs = tools.length ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) : undefined
    // Re-read every step: ui_plan may have changed it, and trimmed history may no longer hold the call that set it.
    let plan = await loadPlan(thread).catch(() => null)
    const liveFlow = await fetchLiveFlowSummary(target, signal)
    if (plan && liveFlow) {
      const reconciled = reconcilePlanWithFlow(plan, liveFlow)
      if (reconciled.changed) {
        plan = reconciled.plan
        await savePlan(thread, plan)
        session.send({ type: 'plan', plan })
      }
    }
    const system = buildSystemPrompt(config, settings, session, target.page, tools.map((t) => t.name), run.explainEvent, plan, liveFlow)
    const fixedChars = system.length + (toolSpecs ? JSON.stringify(toolSpecs).length : 0)
    const build = (shrink: boolean): ChatRequest => ({
      model: run.model,
      fallbackModels: settings.fallbackModels,
      messages: [
        { role: 'system', content: system },
        ...fitBudget(trimMessages(messages, flags.conversationMaxMessages), historyBudget(run.contextLength, fixedChars, shrink)),
      ],
      tools: toolSpecs,
      temperature: 0.2,
      signal,
    })
    ui.mascot('thinking')
    const res = await chatWithRetry(run, build)
    if (staleStatus.has(session)) {
      staleStatus.delete(session)
      computeStatus(config).then((s) => session.send(s), () => undefined)
    }
    const calls = normalizeCalls(res.toolCalls)
    const cutOff = CUT_OFF.has(res.finishReason ?? '')

    if (!calls.length) {
      let reply = res.text.trim()
      // An empty answer after tool work is a normal "nothing more to say"; an empty first answer, or one that was
      // filtered or cut off, is not, and must not be dressed up as "Done!".
      if (!reply && step > 0 && NORMAL_FINISH.has(res.finishReason ?? 'stop')) reply = mascot.lines.done || 'Done!'
      if (!reply) {
        messages.push({ role: 'assistant', content: '(No answer was given. Do not resume this request unless the user asks again.)' })
        await saveMessages(thread, messages, flags.conversationMaxMessages)
        postLine(session, 'system-note', `The model returned no answer (finish reason: ${res.finishReason ?? 'unknown'}). Try again or pick another model.`)
        ui.mascot('confused')
        session.settleMascot(4000)
        return
      }
      messages.push({ role: 'assistant', content: reply })
      await saveMessages(thread, messages, flags.conversationMaxMessages)
      postLine(session, 'assistant', reply)
      if (cutOff) postLine(session, 'system-note', "That answer was cut off at the model's output limit.")
      speakReply(reply, session).catch(() => undefined)
      ui.mascot(published ? 'celebrate' : 'happy')
      session.settleMascot(published ? 4000 : 2500)
      return
    }

    // Text sent alongside tool calls is usually narration ("Let me check…"): show it as thinking, not as chat.
    if (res.text.trim()) ui.thinking(res.text.trim().split(/(?<=[.!?])\s/)[0] ?? res.text.trim())
    const assistant: ChatMessage = { role: 'assistant', content: res.text, toolCalls: calls }
    if (res.providerExtras) assistant.providerExtras = res.providerExtras
    if (cutOff) {
      // Arguments cut off at the output limit are broken or incomplete; running or rejecting them one by one makes
      // the model resend the same oversized call until the step limit.
      const note = errorContent(
        'Your output was cut off at the token limit, so this call was not run. Send a smaller change, for example split a large code edit into several calls.',
        'output-truncated',
      )
      messages.push(assistant, ...calls.map((c): ChatMessage => ({ role: 'tool', toolCallId: c.id, name: c.name, content: note })))
      await saveMessages(thread, messages, flags.conversationMaxMessages)
      continue
    }
    const results = await runToolCalls(run, calls, tools)
    messages.push(assistant, ...results.messages)
    await saveMessages(thread, messages, flags.conversationMaxMessages)
    published ||= results.published
    signal.throwIfAborted()
    if (results.moved) throw new PageMovedError()
    if (results.authFailed) {
      const line = mascot.lines.authFailed ?? 'Your viaSocket session expired. Refresh the page and sign in again.'
      postLine(session, 'system-note', line)
      ui.mascot('confused', line)
      session.settleMascot(5000)
      return
    }
  }

  postLine(session, 'system-note', `I stopped after ${flags.maxAgentSteps} steps to stay safe. Say "continue" if you want me to keep going.`)
  ui.mascot('confused')
  session.settleMascot(4000)
}

function normalizeCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>()
  return calls.map((c, i) => {
    let id = typeof c.id === 'string' && c.id ? c.id : `call_${i}_${crypto.randomUUID().slice(0, 8)}`
    if (seen.has(id)) id = `${id}_${i}`
    seen.add(id)
    const call: ToolCall = { id, name: String(c.name ?? ''), arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) }
    if (c.providerExtras) call.providerExtras = c.providerExtras
    return call
  })
}

interface ToolRunResult {
  messages: ChatMessage[]
  published: boolean
  authFailed: boolean
  /** The user left the run's flow or plug; the remaining calls were not run */
  moved: boolean
}

/** Runs the calls strictly in order and returns exactly one tool message per call, in the same order. */
async function runToolCalls(run: RunContext, calls: ToolCall[], tools: Tool[]): Promise<ToolRunResult> {
  const { session, config, signal, target } = run
  const out: ChatMessage[] = []
  const reply = (call: ToolCall, content: string) => out.push({ role: 'tool', toolCallId: call.id, name: call.name, content })
  const ran = new Set<string>()
  let aborted = false
  let authFailed = false
  let published = false
  let moved = false

  for (const [index, call] of calls.entries()) {
    if (signal.aborted) aborted = true
    if (aborted) {
      reply(call, errorContent('Cancelled by the user.', 'aborted'))
      continue
    }
    if (moved || !followPage(session, target)) {
      moved = true
      reply(call, errorContent('Not run: the user moved to a different flow or plug.', 'page-changed'))
      continue
    }
    if (authFailed) {
      reply(call, errorContent('Skipped: the viaSocket session has expired.', 'logged-out'))
      continue
    }
    if (index >= MAX_CALLS_PER_TURN) {
      reply(call, errorContent(`Not run: at most ${MAX_CALLS_PER_TURN} tool calls run per answer. Send the rest in your next answer.`, 'too-many-calls'))
      continue
    }
    const fingerprint = `${call.name}\n${call.arguments.trim()}`
    if (ran.has(fingerprint)) {
      reply(call, errorContent('Duplicate call skipped: the same call with the same arguments already ran in this answer.', 'duplicate'))
      continue
    }
    ran.add(fingerprint)
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) {
      reply(call, errorContent(`Unknown tool "${call.name.slice(0, 80)}". Available tools: ${tools.map((t) => t.name).join(', ')}.`, 'unknown-tool'))
      continue
    }
    const prepared = prepareArgs(tool, call.arguments)
    if ('error' in prepared) {
      reply(call, errorContent(prepared.error, 'invalid-arguments'))
      continue
    }
    // A plan proposed in this answer waits for the user's reply: nothing is built until they agree.
    if (tool.danger !== 'safe' && !tool.name.startsWith('ui_') && awaitingReply(await loadPlan(run.thread).catch(() => null), session.runStartedAt)) {
      reply(
        call,
        errorContent(
          'Not run: the plan you proposed is waiting for the user\'s approval. Ask them in one short line and end your turn; build only after they agree or ask for changes.',
          'plan-awaiting-approval',
        ),
      )
      continue
    }
    try {
      const outcome = await executeTool(session, tool, prepared.args, config, signal, target)
      reply(call, outcome.content)
      if (outcome.ok && PUBLISH_TOOLS.has(tool.name)) published = true
      if (outcome.authFailed) authFailed = true
    } catch (e) {
      if (!isAbort(e, signal)) throw e
      aborted = true
      reply(call, errorContent('Cancelled by the user.', 'aborted'))
    }
  }
  return { messages: out, published, authFailed, moved }
}

function isTooLarge(e: LlmError): boolean {
  return e.status === 413 || TOO_LARGE.test(e.message)
}

/** `build(true)` rebuilds the request with a much smaller history, used once when the provider says it is too large. */
async function chatWithRetry(run: RunContext, build: (shrink: boolean) => ChatRequest): Promise<ChatResponse> {
  const { session, config, adapter, provider, signal } = run
  let request = build(false)
  let rateRetries = 0
  let transientRetries = 0
  let shrunk = false
  for (;;) {
    try {
      return await adapter.chat(provider, request)
    } catch (e) {
      if (!(e instanceof LlmError) || signal.aborted) throw e
      if (e.kind === 'rate-limit' && rateRetries < RATE_LIMIT_BACKOFF_MS.length) {
        const wait = e.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS[rateRetries] ?? 10_000
        // A longer wait usually means a daily cap; waiting inside the run would look like a hang.
        if (wait > MAX_RETRY_WAIT_MS) throw e
        rateRetries++
        const line = config.mascot.lines.rateLimited ?? 'Catching my breath… retrying in a moment.'
        session.ui.mascot('thinking', line)
        session.ui.thinking(line)
        await sleep(wait, signal)
        continue
      }
      if ((e.kind === 'network' || e.kind === 'server') && transientRetries < 1) {
        transientRetries++
        await sleep(TRANSIENT_RETRY_MS, signal)
        continue
      }
      if (e.kind === 'bad-request' && !shrunk && isTooLarge(e)) {
        shrunk = true
        request = build(true)
        continue
      }
      throw e
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function reportRunError(session: Session, e: unknown, signal: AbortSignal): Promise<void> {
  const config = await getConfig()
  const lines = config.mascot.lines
  const ui = session.ui
  const note = (text: string) => postLine(session, 'system-note', text)

  if (e instanceof PageMovedError) {
    // finishRun says why, once the panel shows the page the user moved to.
    ui.mascot('idle')
    return
  }
  if (isAbort(e, signal)) {
    note(lines.cancelled ?? 'Okay, stopped.')
    ui.mascot('idle')
    return
  }
  ui.mascot('confused')
  session.settleMascot(5000)

  if (e instanceof LlmError) {
    switch (e.kind) {
      case 'auth':
        staleStatus.add(session)
        session.send({ type: 'status', llmReady: false, reason: e.message })
        note(e.message || lines.noKey || 'I need a working AI key. Open settings to add one.')
        return
      case 'quota':
        note(
          e.status === 402
            ? `${e.message} Add credit with your provider, or pick a free model in settings.`
            : `${e.message} This limit does not reset within a minute. Try again later, or switch models in settings.`,
        )
        return
      case 'rate-limit':
        note(`${e.message} Wait a moment and try again.`)
        return
      case 'network':
        note(`I couldn't reach your AI provider. Check your connection and try again. (${e.message})`)
        return
      case 'server':
        note(`Your AI provider had a problem answering. Try again in a moment. (${e.message})`)
        return
      case 'bad-request':
        note(`Your AI provider rejected the request: ${e.message}${isTooLarge(e) ? ' If this keeps happening, clear the conversation.' : ''}`)
        return
      case 'aborted':
        note(lines.cancelled ?? 'Okay, stopped.')
        return
    }
  }
  if (e instanceof VsError && (e.kind === 'logged-out' || e.kind === 'auth')) {
    note(lines.authFailed ?? 'Your viaSocket session expired. Refresh the page and sign in again.')
    return
  }
  const message = e instanceof Error ? e.message : String(e)
  console.warn('[assistant] run failed:', message)
  note(`Something went wrong: ${message}`)
}
