// Mascot vocabulary shared by every context. Animation names follow the Bible Strong Avatar Lab set,
// so a richer renderer can be swapped in later without changing callers.

export type MascotMode =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'working'
  | 'suggest'
  | 'confused'
  | 'celebrate'
  | 'sleeping'
  | 'waking'
  | 'happy'
  | 'curious'

export interface HighlightTarget {
  /** Flow step on the canvas */
  slugName?: string
  /** Field inside the open step / DH panel, matched by its visible label */
  fieldLabel?: string
  /** Named selector key from selectors.json (e.g. "publishButton") */
  selectorKey?: string
  /** Raw CSS selector (only from trusted extension code, never from the LLM) */
  css?: string
}

export interface Suggestion {
  id: string
  message: string
  mood?: MascotMode
  target?: HighlightTarget
  /** When present the panel shows Apply; applying runs this tool call through the normal confirmation path */
  apply?: { tool: string; args: Record<string, unknown>; label?: string }
}

export interface ConfirmRequest {
  id: string
  title: string
  detail: string
  /** destructive actions get a red confirm button */
  danger: boolean
  confirmLabel?: string
}

export type ChatRole = 'user' | 'assistant' | 'system-note'

export interface ChatLine {
  id: string
  role: ChatRole
  text: string
  at: number
}
