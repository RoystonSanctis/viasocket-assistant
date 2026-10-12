// Provider-neutral chat types. Adapters translate these to each API's wire format.

export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [k: string]: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as returned by the model; parsed and validated by the agent loop */
  arguments: string
  /** Opaque per-call provider fields (e.g. Gemini's thought signature) that must be echoed back unchanged */
  providerExtras?: Record<string, unknown>
}

/**
 * Opaque reasoning state some providers require back on later requests of the same tool loop (DeepSeek
 * reasoning_content, OpenRouter reasoning_details, Gemini thought signatures). Only replayed to the provider and
 * model that produced it.
 */
export interface ProviderExtras {
  providerId: string
  model: string
  fields: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; providerExtras?: ProviderExtras }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ChatRequest {
  model: string
  fallbackModels?: string[]
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  /** Model that actually answered (fallbacks may differ from the requested one) */
  model: string
  finishReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  /** Store on the assistant message so the adapter can replay it within the same tool loop */
  providerExtras?: ProviderExtras
}

export interface ModelInfo {
  id: string
  name?: string
  contextLength?: number
  supportsTools?: boolean
  free?: boolean
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 'auth' | 'rate-limit' | 'quota' | 'bad-request' | 'server' | 'network' | 'aborted' */
    readonly kind: 'auth' | 'rate-limit' | 'quota' | 'bad-request' | 'server' | 'network' | 'aborted',
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export interface ResolvedProvider {
  id: string
  name: string
  adapter: 'openai' | 'anthropic'
  /** Origin+path the key is bound to; requests to anywhere else are refused */
  baseUrl: string
  key: string
  extraHeaders: Record<string, string>
  modelsPath?: string
  validatePath?: string
}

export interface LlmAdapter {
  chat(p: ResolvedProvider, req: ChatRequest): Promise<ChatResponse>
  listModels(p: ResolvedProvider): Promise<ModelInfo[]>
}
