// OpenAI-compatible chat completions with tool calling (OpenRouter, Groq, Gemini, Mistral, OpenAI, DeepSeek,
// Ollama, LM Studio, ...). Only the documented common subset is used so one adapter fits all of them.
// The built-in OpenAI provider uses the Responses API instead (openai-responses.ts), falling back to chat
// completions for models that endpoint refuses.

import { CHAT_TIMEOUT_MS, LIST_TIMEOUT_MS, asRecord, errorInBody, llmFetch, newCallId, providerUrl } from './http'
import { repairToolPairs, stripThink } from './history'
import { fitToolDescription, fnv1a, isOpenAiPlatform, loadRemembered, noTemperature, openaiHeaders, rememberedSet } from './openai-common'
import { responsesChat } from './openai-responses'
import {
  LlmError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LlmAdapter,
  type ModelInfo,
  type ResolvedProvider,
  type ToolCall,
} from './types'

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  extra_content?: unknown
}

interface WireAssistant {
  role: 'assistant'
  content: string | null
  tool_calls?: WireToolCall[]
  [field: string]: unknown
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | WireAssistant
  | { role: 'tool'; tool_call_id: string; content: string }

/** Message-level reasoning state echoed back within a tool loop (DeepSeek, OpenRouter, Gemini). */
const REPLAY_FIELDS = ['reasoning_content', 'reasoning_details', 'extra_content'] as const
/** Keywords of the OpenAPI-style schema subset Gemini accepts; others (additionalProperties, $schema, oneOf...) are dropped. */
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'anyOf',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
])
/**
 * provider:model pairs that accept function tools on chat completions only with reasoning_effort 'none' (newer
 * OpenAI reasoning models; their default effort is refused next to tools). Remembered like noTemperature.
 */
const noReasoningWithTools = rememberedSet('noReasoningWithTools')
/** provider:model pairs the Responses API does not serve; they use chat completions instead. */
const noResponses = rememberedSet('noResponses')

export { openaiHeaders }

function isGemini(p: ResolvedProvider): boolean {
  try {
    return p.id === 'gemini' || new URL(p.baseUrl).hostname === 'generativelanguage.googleapis.com'
  } catch {
    return p.id === 'gemini'
  }
}

// Ids written by another provider (after a switch) fail Mistral's check (exactly 9 alphanumerics). Others get ids
// unchanged, since some models are trained on their own id format. Deterministic, because a tool call and its
// result are mapped separately and must stay equal.
function wireId(id: string, p: ResolvedProvider): string {
  if (p.id !== 'mistral') return id
  if (/^[A-Za-z0-9]{9}$/.test(id)) return id
  return (fnv1a(id, 0x811c9dc5).toString(36).padStart(7, '0') + fnv1a(id, 0x9e3779b9).toString(36).padStart(7, '0')).slice(0, 9)
}

/** `replay`: this message belongs to the current tool loop, where providers expect their reasoning state back. */
function toWire(m: ChatMessage, p: ResolvedProvider, model: string, replay: boolean): WireMessage {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content }
    case 'assistant': {
      const extras = replay && m.providerExtras?.providerId === p.id && m.providerExtras.model === model ? m.providerExtras : undefined
      const out: WireAssistant = { role: 'assistant', content: m.content }
      if (m.toolCalls?.length) {
        // Several providers reject an empty string next to tool_calls but accept null.
        out.content = m.content || null
        out.tool_calls = m.toolCalls.map((c) => {
          const call: WireToolCall = {
            id: wireId(c.id, p),
            type: 'function',
            function: { name: c.name, arguments: c.arguments.trim() || '{}' },
          }
          if (extras && c.providerExtras?.extra_content !== undefined) call.extra_content = c.providerExtras.extra_content
          return call
        })
      }
      if (extras) for (const k of REPLAY_FIELDS) if (extras.fields[k] !== undefined) out[k] = extras.fields[k]
      return out
    }
    case 'tool':
      return { role: 'tool', tool_call_id: wireId(m.toolCallId, p), content: m.content }
  }
}

function sanitizeForGemini(schema: unknown): unknown {
  const s = asRecord(schema)
  if (!s) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue
    if (k === 'properties') {
      const props = asRecord(v)
      if (props) out.properties = Object.fromEntries(Object.entries(props).map(([name, child]) => [name, sanitizeForGemini(child)]))
    } else if (k === 'items') out.items = sanitizeForGemini(v)
    else if (k === 'anyOf') out.anyOf = Array.isArray(v) ? v.map(sanitizeForGemini) : v
    else out[k] = v
  }
  // Gemini only takes string enums; the agent still checks the allowed values in code.
  if (Array.isArray(out.enum) && out.enum.some((e) => typeof e !== 'string')) {
    const prefix = typeof out.description === 'string' && out.description ? `${out.description} ` : ''
    out.description = `${prefix}Allowed values: ${out.enum.map(String).join(', ')}.`
    delete out.enum
  }
  // Free-form maps (objects without declared properties) are rejected when sent with extra keywords.
  if (out.type === 'object' && !Object.keys(asRecord(out.properties) ?? {}).length) {
    return typeof out.description === 'string' ? { type: 'object', description: out.description } : { type: 'object' }
  }
  return out
}

function wireTool(p: ResolvedProvider, t: NonNullable<ChatRequest['tools']>[number]): Record<string, unknown> {
  if (isGemini(p)) {
    const hasParams = Object.keys(t.parameters.properties ?? {}).length > 0
    return {
      type: 'function',
      function: { name: t.name, description: t.description, ...(hasParams ? { parameters: sanitizeForGemini(t.parameters) } : {}) },
    }
  }
  // OpenAI's limit, applied to every provider here: routers such as OpenRouter pass descriptions on to OpenAI models.
  const description = fitToolDescription(t.description)
  return { type: 'function', function: { name: t.name, description, parameters: t.parameters } }
}

function buildBody(p: ResolvedProvider, req: ChatRequest): Record<string, unknown> {
  const messages = repairToolPairs(req.messages)
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  const body: Record<string, unknown> = {
    model: req.model,
    messages: messages.map((m, i) => toWire(m, p, req.model, i > lastUser)),
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => wireTool(p, t))
    body.tool_choice = 'auto'
    if (noReasoningWithTools.has(`${p.id}:${req.model}`)) body.reasoning_effort = 'none'
  }
  if (req.temperature !== undefined && !noTemperature.has(`${p.id}:${req.model}`)) body.temperature = req.temperature
  // OpenAI's newer models only accept max_completion_tokens; everyone else still uses max_tokens.
  if (req.maxTokens) body[p.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
  const fallbacks = (req.fallbackModels ?? []).filter((m) => m && m !== req.model)
  if (p.id === 'openrouter' && fallbacks.length) body.models = [...new Set([req.model, ...fallbacks])]
  return body
}

async function post(p: ResolvedProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return llmFetch(p, providerUrl(p, '/chat/completions'), {
    method: 'POST',
    headers: openaiHeaders(p),
    body,
    signal,
    timeoutMs: CHAT_TIMEOUT_MS,
  })
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const r = asRecord(part)
      return r && (r.type === 'text' || r.type === undefined) && typeof r.text === 'string' ? r.text : ''
    })
    .join('')
}

function parseToolCalls(raw: unknown): ToolCall[] {
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const c = asRecord(item)
    const fn = asRecord(c?.function)
    const name = typeof fn?.name === 'string' ? fn.name : ''
    if (!name) continue
    let id = typeof c?.id === 'string' && c.id ? c.id : newCallId()
    // Some providers repeat or omit ids for parallel calls; results are matched by id, so they must be unique.
    if (seen.has(id)) id = newCallId()
    seen.add(id)
    const args = fn?.arguments
    const call: ToolCall = {
      id,
      name,
      arguments: typeof args === 'string' ? args.trim() || '{}' : JSON.stringify(args ?? {}),
    }
    // Gemini puts the call's thought signature here and rejects the next request of the loop without it.
    if (c?.extra_content !== undefined && c.extra_content !== null) call.providerExtras = { extra_content: c.extra_content }
    calls.push(call)
  }
  return calls
}

function parseChat(p: ResolvedProvider, req: ChatRequest, json: unknown): ChatResponse {
  const root = asRecord(json)
  const choices = root?.choices
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  if (!choice) {
    throw errorInBody(p, json) ?? new LlmError(`${p.name} sent an empty answer.`, 502, 'server')
  }
  const message = asRecord(choice.message)
  const usage = asRecord(root?.usage)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const toolCalls = parseToolCalls(message?.tool_calls)
  const fields: Record<string, unknown> = {}
  for (const k of REPLAY_FIELDS) if (message?.[k] !== undefined && message[k] !== null) fields[k] = message[k]
  const res: ChatResponse = {
    text: stripThink(contentText(message?.content)),
    toolCalls,
    model: typeof root?.model === 'string' && root.model ? root.model : req.model,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage: usage ? { inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) } : undefined,
  }
  // Keyed to the requested model: that is what the next request of the loop sends, whoever answered.
  if (Object.keys(fields).length || toolCalls.some((c) => c.providerExtras)) res.providerExtras = { providerId: p.id, model: req.model, fields }
  return res
}

async function chatCompletions(p: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  const body = buildBody(p, req)
  const key = `${p.id}:${req.model}`
  // Reasoning models refuse some request shapes with a 400 that names the parameter. Each known case is adjusted
  // once and remembered for the model, so a single answer costs at most two extra requests, and later ones none.
  for (let attempt = 0; ; attempt++) {
    try {
      return parseChat(p, req, await post(p, body, req.signal))
    } catch (e) {
      if (attempt >= 2 || !(e instanceof LlmError) || e.kind !== 'bad-request') throw e
      if ('temperature' in body && /temperature/i.test(e.message)) {
        noTemperature.add(key)
        delete body.temperature
        continue
      }
      if (body.tools && body.reasoning_effort === undefined && /reasoning[_ ]effort/i.test(e.message)) {
        noReasoningWithTools.add(key)
        body.reasoning_effort = 'none'
        continue
      }
      throw e
    }
  }
}

const UNSUPPORTED = /not supported|unsupported|only (supported|available)|not available|does not support|cannot be used/i
/** Wording of request-shape problems, which the Responses adapter adjusts itself and which do not mean "use another endpoint". */
const REQUEST_SHAPE = /parameter|temperature|include|encrypted|reasoning|tool|input|item|max_output_tokens/i

/** The Responses API does not serve this model (or this account): 404, or a 400 saying so. */
function responsesRefused(e: unknown): boolean {
  if (!(e instanceof LlmError)) return false
  if (e.status === 404 || e.status === 405) return true
  if (e.status !== 400 || !UNSUPPORTED.test(e.message)) return false
  return /responses/i.test(e.message) || (/\bmodel\b/i.test(e.message) && !REQUEST_SHAPE.test(e.message))
}

/**
 * Whether a refusal says the model is not served there, rather than e.g. a bare 404 page from a hiccup, which falls
 * back for this answer only.
 */
function refusesModel(e: LlmError): boolean {
  return /responses|\bmodel\b|support/i.test(e.message)
}

async function chat(p: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  await loadRemembered()
  const key = `${p.id}:${req.model}`
  if (!isOpenAiPlatform(p) || noResponses.has(key)) return chatCompletions(p, req)
  try {
    return await responsesChat(p, req)
  } catch (e) {
    if (req.signal?.aborted || !responsesRefused(e)) throw e
    // Older and non-chat models are not served there; chat completions keeps its own reasoning_effort fallback.
    // Remembered only once chat completions answered: a model that exists nowhere fails there too, and a model
    // moved over by a passing error would lose reasoning next to tools for the rest of the browser session.
    const res = await chatCompletions(p, req)
    if (refusesModel(e as LlmError)) noResponses.add(key)
    return res
  }
}

function toModelInfo(item: unknown): ModelInfo | null {
  const m = asRecord(item)
  if (!m || typeof m.id !== 'string' || !m.id) return null
  // Gemini lists ids as "models/<id>"; chat accepts the bare id, which is also what config recommends.
  const id = m.id.replace(/^models\//, '')
  const name = typeof m.name === 'string' ? m.name : typeof m.display_name === 'string' ? m.display_name : undefined
  const ctx = [m.context_length, m.context_window, m.max_context_length].find((v) => typeof v === 'number')
  const info: ModelInfo = { id }
  if (name && name !== m.id) info.name = name
  if (typeof ctx === 'number') info.contextLength = ctx

  if (Array.isArray(m.supported_parameters)) info.supportsTools = m.supported_parameters.includes('tools')
  else if (typeof asRecord(m.capabilities)?.function_calling === 'boolean') {
    info.supportsTools = asRecord(m.capabilities)?.function_calling === true
  }

  const pricing = asRecord(m.pricing)
  if (pricing) info.free = pricing.prompt === '0' && pricing.completion === '0'
  else if (id.endsWith(':free')) info.free = true
  return info
}

async function listModels(p: ResolvedProvider): Promise<ModelInfo[]> {
  const json = await llmFetch(p, providerUrl(p, p.modelsPath || '/models'), {
    method: 'GET',
    headers: openaiHeaders(p),
    timeoutMs: LIST_TIMEOUT_MS,
  })
  // Most providers answer {data:[...]}; Together answers with a bare array.
  const list = Array.isArray(json) ? json : asRecord(json)?.data
  if (!Array.isArray(list)) throw new LlmError(`${p.name} sent an unexpected model list.`, 502, 'server')
  return list.map(toModelInfo).filter((m): m is ModelInfo => m !== null)
}

export const openaiAdapter: LlmAdapter = { chat, listModels }
