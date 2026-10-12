// OpenAI Responses API (POST /responses), used for the built-in OpenAI provider. Newer OpenAI reasoning models only
// accept function tools on chat completions with reasoning switched off; here they keep reasoning while calling
// tools. With store:false nothing is kept server-side, so each response's encrypted reasoning items are handed back
// on the next request of the same tool loop, followed by the calls they led to.

import { asRecord, httpError, llmFetch, newCallId, providerUrl } from './http'
import { repairToolPairs, stripThink } from './history'
import { fitToolDescription, fnv1a, loadRemembered, noTemperature, openaiHeaders, rememberedSet } from './openai-common'
import {
  LlmError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ResolvedProvider,
  type ToolCall,
  type ToolSpec,
} from './types'

/** ProviderExtras.fields key holding a response's raw output items, replayed verbatim within the same tool loop. */
export const RESPONSES_OUTPUT_FIELD = 'responsesOutput'
/** Output item types that are stored and replayed. Anything else in a response makes it not replayable. */
const REPLAY_TYPES = new Set(['reasoning', 'message', 'function_call'])
/** Smallest max_output_tokens the API accepts. */
const MIN_OUTPUT_TOKENS = 16
/**
 * Reasoning runs at the model's default effort and the answer is not streamed, so a long step can take minutes
 * before the first byte; chat completions (120 s) ran these models with reasoning off.
 */
const RESPONSES_TIMEOUT_MS = 300_000
/** Each refused request shape is adjusted at most this many times per answer. */
const MAX_RETRIES = 3
/** Call ids written by another provider (after a switch) are mapped to this shape when they do not already fit. */
const SAFE_CALL_ID = /^[A-Za-z0-9_.:-]{1,64}$/
/** Arguments of a call that cannot be parsed are sent as a JSON stub carrying at most this much of the raw text. */
const MAX_RAW_ARGUMENT_CHARS = 2000
/**
 * provider:model pairs that refuse `include: ['reasoning.encrypted_content']` (models without reasoning). Remembered
 * only once a request without it has succeeded; nothing is replayed for them.
 */
const noEncryptedReasoning = rememberedSet('noEncryptedReasoning')
/**
 * Ids of stored output items the API refused when they were handed back (named in its error). The assistant message
 * holding one is rebuilt without its reasoning from then on, while the rest of the loop keeps being replayed.
 */
const refusedItems = new Set<string>()
const MAX_REFUSED_ITEMS = 500
/** 400s about our own request (tool schema, call/result pairing), never about replayed items or `include`. */
const NOT_REPLAY = /invalid schema|no tool output found/i
/** Wording of refused replayed items when the error does not name one. */
const REPLAY_REFUSED = /required following item|reasoning item|items are not persisted|item with id|could not be (verified|decrypted)|invalid encrypted content/i
/** Wording of a refused `include` of encrypted reasoning. */
const INCLUDE_REFUSED = /encrypted|\binclude\b/i
/** Failed-response error codes that describe the request, mapped to 400 so the agent can act on them (e.g. shrink). */
const REQUEST_CODES =
  /^invalid|content_filter|policy|bad_request|context_length|string_above_max_length|too_large|too_small|unsupported|^empty|not_found|failed_to_download|parse_error/i

type Item = Record<string, unknown>

export interface ResponsesBuildOptions {
  /** Request encrypted reasoning items (`include`); without it nothing can be replayed either */
  include: boolean
  /** Replay stored items of the current tool loop */
  replay: boolean
  /** Send req.temperature (models that refused it get none) */
  temperature: boolean
}

function wireCallId(id: string): string {
  if (SAFE_CALL_ID.test(id)) return id
  return `call_${fnv1a(id, 0x811c9dc5).toString(36)}${fnv1a(id, 0x9e3779b9).toString(36)}`
}

/** Arguments of an earlier call. Invalid JSON (an answer cut off at the output limit) is wrapped so it stays valid. */
function wireArguments(args: string): string {
  const s = args.trim() || '{}'
  try {
    JSON.parse(s)
    return s
  } catch {
    return JSON.stringify({ invalid_json: s.length > MAX_RAW_ARGUMENT_CHARS ? `${s.slice(0, MAX_RAW_ARGUMENT_CHARS)}…` : s })
  }
}

function wireTool(t: ToolSpec): Item {
  return { type: 'function', name: t.name, description: fitToolDescription(t.description), parameters: t.parameters, strict: false }
}

/**
 * The raw output items stored on an assistant message, when they were produced by this provider and model and still
 * describe exactly the message's tool calls. Budget trimming may have shortened arguments, and the loop may have
 * renamed ids; the stored items are then not used, since their reasoning cannot be sent without them.
 */
function storedItems(m: Extract<ChatMessage, { role: 'assistant' }>, p: ResolvedProvider, model: string): Item[] | undefined {
  const extras = m.providerExtras
  if (!extras || extras.providerId !== p.id || extras.model !== model) return undefined
  const raw = extras.fields[RESPONSES_OUTPUT_FIELD]
  if (!Array.isArray(raw) || !raw.length) return undefined
  const items: Item[] = []
  for (const entry of raw) {
    const item = asRecord(entry)
    if (!item || !REPLAY_TYPES.has(String(item.type))) return undefined
    if (typeof item.id === 'string' && refusedItems.has(item.id)) return undefined
    items.push(item)
  }
  const calls = items.filter((i) => i.type === 'function_call')
  const toolCalls = m.toolCalls ?? []
  if (calls.length !== toolCalls.length) return undefined
  for (const c of toolCalls) {
    const item = calls.find((i) => i.call_id === c.id)
    if (!item || item.name !== c.name || item.arguments !== c.arguments || c.id !== wireCallId(c.id)) return undefined
  }
  // Shallow copies: the request body must not share objects with the conversation.
  return items.map((i) => ({ ...i }))
}

export function buildResponsesBody(p: ResolvedProvider, req: ChatRequest, opts: ResponsesBuildOptions): Record<string, unknown> {
  const messages = repairToolPairs(req.messages)
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  const instructions: string[] = []
  const input: Item[] = []
  messages.forEach((m, i) => {
    switch (m.role) {
      case 'system':
        if (m.content.trim()) instructions.push(m.content)
        break
      case 'user':
        if (m.content.trim()) input.push({ role: 'user', content: m.content })
        break
      case 'assistant': {
        // Reasoning is only handed back within the current tool loop (after the last user message), as OpenAI does.
        const stored = opts.include && opts.replay && i > lastUser ? storedItems(m, p, req.model) : undefined
        if (stored) {
          input.push(...stored)
          break
        }
        if (m.content.trim()) input.push({ role: 'assistant', content: m.content })
        // No item id here: an id ties a call to a reasoning item, which is not sent for reconstructed calls.
        for (const c of m.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: wireCallId(c.id), name: c.name, arguments: wireArguments(c.arguments) })
        }
        break
      }
      case 'tool':
        input.push({ type: 'function_call_output', call_id: wireCallId(m.toolCallId), output: m.content || '(empty)' })
        break
    }
  })
  if (!input.length) input.push({ role: 'user', content: '(conversation continues)' })

  const body: Record<string, unknown> = { model: req.model, input, store: false }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  if (req.tools?.length) {
    body.tools = req.tools.map(wireTool)
    body.tool_choice = 'auto'
  }
  if (opts.include) body.include = ['reasoning.encrypted_content']
  if (req.maxTokens) body.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, Math.floor(req.maxTokens))
  if (opts.temperature && req.temperature !== undefined) body.temperature = req.temperature
  return body
}

function messageText(item: Item): string {
  const content = item.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const r = asRecord(part)
      if (r?.type === 'output_text' && typeof r.text === 'string') return r.text
      if (r?.type === 'refusal' && typeof r.refusal === 'string' && r.refusal) return `Refused: ${r.refusal}`
      return ''
    })
    .join('')
}

/** A response that came back with status 'failed' or an error object, mapped like an HTTP error. */
function failedError(p: ResolvedProvider, root: Record<string, unknown>): LlmError {
  const err = asRecord(root.error)
  const code = typeof err?.code === 'string' ? err.code : ''
  let message =
    typeof err?.message === 'string' && err.message ? err.message : `The answer ended with status "${String(root.status ?? 'failed')}".`
  // The code is what the agent recognises (context_length_exceeded makes it retry with a shorter history).
  if (code && !message.includes(code)) message = `${message} (${code})`
  const status = /rate_limit|insufficient_quota/i.test(code) ? 429 : REQUEST_CODES.test(code) ? 400 : 500
  return httpError(p, status, { error: { message, code } })
}

function finishReasonOf(root: Record<string, unknown>, status: string | undefined, hasCalls: boolean): string {
  if (status === 'incomplete') {
    const reason = asRecord(root.incomplete_details)?.reason
    if (reason === 'max_output_tokens' || typeof reason !== 'string' || !reason) return 'length'
    return reason
  }
  return hasCalls ? 'tool_calls' : 'stop'
}

export function parseResponses(p: ResolvedProvider, req: ChatRequest, json: unknown): ChatResponse {
  const root = asRecord(json)
  if (!root) throw new LlmError(`${p.name} sent an empty answer.`, 502, 'server')
  const status = typeof root.status === 'string' ? root.status : undefined
  if (status === 'failed' || asRecord(root.error)) throw failedError(p, root)
  if (status === 'cancelled') throw new LlmError(`${p.name} cancelled the answer.`, 502, 'server')
  if (!Array.isArray(root.output)) throw new LlmError(`${p.name} sent an empty answer.`, 502, 'server')

  const texts: string[] = []
  const toolCalls: ToolCall[] = []
  const seen = new Set<string>()
  const stored: Item[] = []
  let replayable = status !== 'incomplete'
  for (const entry of root.output) {
    const item = asRecord(entry)
    if (!item) continue
    if (item.type === 'message') {
      const text = messageText(item)
      if (text) texts.push(text)
      stored.push(item)
    } else if (item.type === 'function_call') {
      const name = typeof item.name === 'string' ? item.name : ''
      if (!name) {
        replayable = false
        continue
      }
      let id = typeof item.call_id === 'string' && item.call_id ? item.call_id : typeof item.id === 'string' && item.id ? item.id : newCallId()
      // Results are matched by id, so ids must be unique; the stored copy carries the same id as the call.
      if (seen.has(id)) id = newCallId()
      seen.add(id)
      const args = item.arguments
      const call: ToolCall = { id, name, arguments: typeof args === 'string' ? args.trim() || '{}' : JSON.stringify(args ?? {}) }
      toolCalls.push(call)
      stored.push({ ...item, call_id: call.id, arguments: call.arguments })
    } else if (item.type === 'reasoning') {
      stored.push(item)
    } else {
      replayable = false
    }
  }
  // A reasoning item is handed back together with the item that followed it; one that ends the output led to
  // nothing that is sent back, and the API refuses it without its following item.
  while (stored.at(-1)?.type === 'reasoning') stored.pop()
  const reasoning = stored.filter((i) => i.type === 'reasoning')
  // With store:false a reasoning item can only be passed back with its encrypted content. Without any reasoning
  // there is nothing to keep: the rebuilt items say the same.
  if (!reasoning.length || reasoning.some((i) => typeof i.encrypted_content !== 'string' || !i.encrypted_content)) replayable = false
  let text = texts.join('\n\n')
  if (!text && typeof root.output_text === 'string') text = root.output_text

  const usage = asRecord(root.usage)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const res: ChatResponse = {
    text: stripThink(text),
    toolCalls,
    model: typeof root.model === 'string' && root.model ? root.model : req.model,
    finishReason: finishReasonOf(root, status, toolCalls.length > 0),
    usage: usage ? { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) } : undefined,
  }
  // Only answers with tool calls continue a tool loop. Keyed to the requested model, which the next request sends.
  if (replayable && toolCalls.length) {
    res.providerExtras = { providerId: p.id, model: req.model, fields: { [RESPONSES_OUTPUT_FIELD]: stored } }
  }
  return res
}

async function post(p: ResolvedProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return llmFetch(p, providerUrl(p, '/responses'), {
    method: 'POST',
    headers: openaiHeaders(p),
    body,
    signal,
    timeoutMs: RESPONSES_TIMEOUT_MS,
  })
}

function refuseItem(id: string): void {
  if (refusedItems.size >= MAX_REFUSED_ITEMS) refusedItems.clear()
  refusedItems.add(id)
}

function mentions(message: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(message)
}

/**
 * Ids of replayed items an error points at, by id or by an input[N] path. Only verbatim stored items carry an id
 * (rebuilt items never do), so this never blames an item the adapter built itself.
 */
function namedReplayedItems(message: string, input: Item[]): string[] {
  const named = new Set<string>()
  for (const item of input) if (typeof item.id === 'string' && item.id && mentions(message, item.id)) named.add(item.id)
  for (const match of message.matchAll(/input\[(\d+)\]/g)) {
    const id = input[Number(match[1])]?.id
    if (typeof id === 'string' && id) named.add(id)
  }
  return [...named]
}

type Adjustment = 'temperature' | 'items' | 'replay' | 'include'

/** Changes `opts` for a refused request shape and says what changed, or returns undefined when nothing applies. */
function adjustFor(e: LlmError, body: Record<string, unknown>, opts: ResponsesBuildOptions, key: string): Adjustment | undefined {
  const input = Array.isArray(body.input) ? (body.input as Item[]) : []
  const replayed = input.some((i) => typeof i.id === 'string' && i.id)
  // A replayed item the API cannot resolve may come back as a 404, which must not read as "endpoint missing".
  const itemNotFound = e.status === 404 && replayed && /\bitems?\b/i.test(e.message)
  if (e.status !== 400 && e.status !== 422 && !itemNotFound) return undefined
  if (opts.temperature && 'temperature' in body && /temperature/i.test(e.message)) {
    noTemperature.add(key)
    opts.temperature = false
    return 'temperature'
  }
  if (NOT_REPLAY.test(e.message)) return undefined
  if (replayed && opts.replay) {
    // A refused stored item is about that answer, not the model: only the message holding it is rebuilt.
    const named = namedReplayedItems(e.message, input)
    if (named.length) {
      named.forEach(refuseItem)
      return 'items'
    }
    // Unnamed: this request goes without replay, later ones try again.
    if (itemNotFound || REPLAY_REFUSED.test(e.message)) {
      opts.replay = false
      return 'replay'
    }
  }
  if (opts.include && 'include' in body && INCLUDE_REFUSED.test(e.message)) {
    opts.include = false
    return 'include'
  }
  return undefined
}

/**
 * One answer through the Responses API. Throws LlmError like the other adapters; a 404 or a "not supported" 400 is
 * left to the caller, which falls back to chat completions.
 */
export async function responsesChat(p: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  await loadRemembered()
  const key = `${p.id}:${req.model}`
  const opts: ResponsesBuildOptions = { include: !noEncryptedReasoning.has(key), replay: true, temperature: !noTemperature.has(key) }
  let droppedInclude = false
  for (let attempt = 0; ; attempt++) {
    const body = buildResponsesBody(p, req, opts)
    try {
      const res = parseResponses(p, req, await post(p, body, req.signal))
      // Remembered only once a request without it worked, so an unrelated 400 never turns reasoning replay off.
      if (droppedInclude) noEncryptedReasoning.add(key)
      return res
    } catch (e) {
      if (attempt >= MAX_RETRIES || !(e instanceof LlmError) || req.signal?.aborted) throw e
      const change = adjustFor(e, body, opts, key)
      if (!change) throw e
      if (change === 'include') droppedInclude = true
    }
  }
}
