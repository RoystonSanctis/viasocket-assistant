// Anthropic Messages API with tool use, called directly from the service worker.

import { CHAT_TIMEOUT_MS, LIST_TIMEOUT_MS, asRecord, errorInBody, llmFetch, newCallId, providerUrl } from './http'
import { repairToolPairs, stripThink } from './history'
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

const API_VERSION = '2023-06-01'
// Large tool arguments (Developer Hub code) get cut off at 4096, which leaves the loop resending a broken call.
const DEFAULT_MAX_TOKENS = 8192
/** Older or third-party Anthropic-compatible models cap output lower; used once as a fallback. */
const LEGACY_MAX_TOKENS = 4096

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface WireMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

export function anthropicHeaders(p: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {
    ...p.extraHeaders,
    'anthropic-version': API_VERSION,
    // Required for calls from a browser context; the key is the user's own and stays in the service worker.
    'anthropic-dangerous-direct-browser-access': 'true',
  }
  if (p.key) headers['x-api-key'] = p.key
  return headers
}

// Ids written by other providers (after a provider switch) may contain characters Anthropic rejects.
// Must be deterministic: the tool_use and its tool_result are mapped separately and have to stay equal.
function toolId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_') || 'call_unknown'
}

function parseInput(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args || '{}')
    return asRecord(v) ?? {}
  } catch {
    return {}
  }
}

function toWire(messages: ChatMessage[]): { system: string; messages: WireMessage[] } {
  const system: string[] = []
  const out: WireMessage[] = []
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    // The API needs strictly alternating roles, so same-role neighbours (e.g. several tool results) merge.
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const m of repairToolPairs(messages)) {
    switch (m.role) {
      case 'system':
        if (m.content.trim()) system.push(m.content)
        break
      case 'user':
        if (m.content.trim()) push('user', [{ type: 'text', text: m.content }])
        break
      case 'assistant': {
        const blocks: Block[] = []
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: toolId(c.id), name: c.name, input: parseInput(c.arguments) })
        }
        push('assistant', blocks)
        break
      }
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: toolId(m.toolCallId), content: m.content || '(empty)' }])
        break
    }
  }

  // tool_result blocks must come before any text in their user message (sort is stable).
  const rank = (b: Block) => (b.type === 'tool_result' ? 0 : 1)
  for (const w of out) if (w.role === 'user') w.content.sort((a, b) => rank(a) - rank(b))
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] })
  return { system: system.join('\n\n'), messages: out }
}

function parseChat(p: ResolvedProvider, req: ChatRequest, json: unknown): ChatResponse {
  const root = asRecord(json)
  if (!root || !Array.isArray(root.content)) {
    throw errorInBody(p, json) ?? new LlmError(`${p.name} sent an empty answer.`, 502, 'server')
  }
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const item of root.content) {
    const b = asRecord(item)
    if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    if (b?.type === 'tool_use' && typeof b.name === 'string' && b.name) {
      toolCalls.push({
        id: typeof b.id === 'string' && b.id ? b.id : newCallId(),
        name: b.name,
        arguments: JSON.stringify(asRecord(b.input) ?? {}),
      })
    }
  }
  const usage = asRecord(root.usage)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    text: stripThink(text),
    toolCalls,
    model: typeof root.model === 'string' && root.model ? root.model : req.model,
    finishReason: typeof root.stop_reason === 'string' ? root.stop_reason : undefined,
    usage: usage ? { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) } : undefined,
  }
}

async function chat(p: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  const { system, messages } = toWire(req.messages)
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens || DEFAULT_MAX_TOKENS,
    messages,
  }
  if (system) body.system = system
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  if (req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature))
  const send = () =>
    llmFetch(p, providerUrl(p, '/messages'), {
      method: 'POST',
      headers: anthropicHeaders(p),
      body,
      signal: req.signal,
      timeoutMs: CHAT_TIMEOUT_MS,
    })
  let json: unknown
  try {
    json = await send()
  } catch (e) {
    const tooMany = e instanceof LlmError && e.kind === 'bad-request' && /max_tokens/i.test(e.message)
    if (!tooMany || req.maxTokens || body.max_tokens === LEGACY_MAX_TOKENS) throw e
    body.max_tokens = LEGACY_MAX_TOKENS
    json = await send()
  }
  return parseChat(p, req, json)
}

async function listModels(p: ResolvedProvider): Promise<ModelInfo[]> {
  const url = providerUrl(p, p.modelsPath || '/models')
  if (!url.searchParams.has('limit')) url.searchParams.set('limit', '100')
  const json = await llmFetch(p, url, { method: 'GET', headers: anthropicHeaders(p), timeoutMs: LIST_TIMEOUT_MS })
  const list = asRecord(json)?.data
  if (!Array.isArray(list)) throw new LlmError(`${p.name} sent an unexpected model list.`, 502, 'server')
  const models: ModelInfo[] = []
  for (const item of list) {
    const m = asRecord(item)
    if (!m || typeof m.id !== 'string' || !m.id) continue
    const info: ModelInfo = { id: m.id }
    if (typeof m.display_name === 'string') info.name = m.display_name
    // Every Claude model supports tool use; an unknown Anthropic-compatible server may not.
    if (p.id === 'anthropic') info.supportsTools = true
    models.push(info)
  }
  return models
}

export const anthropicAdapter: LlmAdapter = { chat, listModels }
