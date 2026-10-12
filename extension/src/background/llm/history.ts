// Providers reject histories where a tool result has no matching tool call (or a call has no result).
// Trimming a long conversation can create both, so adapters repair the pairing before sending.

import type { ChatMessage } from './types'

const MISSING_RESULT = 'No result: this step was interrupted before it finished.'

export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let open = new Map<string, string>() // tool call id -> tool name, for the latest assistant turn
  let orphans: ChatMessage[] = []

  const closeOpen = () => {
    for (const [id, name] of open) out.push({ role: 'tool', toolCallId: id, name, content: MISSING_RESULT })
    open = new Map()
    // Emitted after the run of results so nothing splits a tool-call turn from its results.
    out.push(...orphans)
    orphans = []
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      if (open.has(m.toolCallId)) {
        open.delete(m.toolCallId)
        out.push(m)
      } else {
        // Orphan result: keep the information, but as plain context instead of a dangling tool message.
        orphans.push({ role: 'user', content: `(Earlier result of ${m.name}) ${m.content}` })
      }
      continue
    }
    closeOpen()
    out.push(m)
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) open.set(c.id, c.name)
    }
  }
  closeOpen()
  return out
}

/** Removes reasoning that some models (DeepSeek R1, Qwen) inline as <think>...</think>. */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // Templates that pre-open the tag leave only the closing one; a truncated answer leaves only the opening one.
  const close = out.search(/<\/think>/i)
  if (close !== -1) out = out.slice(close + '</think>'.length)
  const open = out.search(/<think>/i)
  if (open !== -1) out = out.slice(0, open)
  return out.trim()
}
