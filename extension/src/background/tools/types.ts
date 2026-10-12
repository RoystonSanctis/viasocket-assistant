// Tool contract for the agent. Tools are the only way the LLM can affect viaSocket or the page.
// Safety is enforced here in code (allowlisted endpoints, confirmations), never delegated to the prompt.

import type { JsonSchema } from '../llm/types'
import type { HighlightTarget, MascotMode, Suggestion } from '../../shared/mascot'
import type { PageContext, PageKind } from '../../shared/page'
import type { ViaSocketClient } from './viasocket-client'

export type ToolDanger =
  /** read-only or UI-only (navigate, highlight) */
  | 'safe'
  /** creates or edits drafts the user can review/discard */
  | 'write'
  /** deletes, publishes, overwrites, or replaces many steps: always asks the user first */
  | 'confirm'

export interface UiBridge {
  mascot(mode: MascotMode, text?: string): void
  thinking(text: string): void
  highlight(target: HighlightTarget, note?: string): void
  clearHighlight(): void
  /** App-internal path or same-host URL. replace: change the current history entry (panels, refetch stamps). */
  navigate(url: string, opts?: { replace?: boolean }): void
  reloadPage(reason: string): void
  /** Resolves true only if the user clicks the confirm button */
  confirm(title: string, detail: string, danger: boolean, confirmLabel?: string): Promise<boolean>
  say(text: string): void
  /** Shows a suggestion card; Apply runs `apply` through the same checks and confirmation as the agent. Returns its id. */
  suggest(suggestion: Omit<Suggestion, 'id'>): string
}

export interface ToolContext {
  page: PageContext
  vs: ViaSocketClient
  ui: UiBridge
  signal: AbortSignal
  maxResultChars: number
  stripRunData: boolean
}

export interface Tool<A = Record<string, unknown>> {
  name: string
  /** Default description; tools.json in the config repo may override wording */
  description: string
  parameters: JsonSchema
  danger: ToolDanger
  /** Pages where the tool is offered. Omit = everywhere. */
  pages?: PageKind[]
  /** Short present-tense label for the mascot's thinking text, e.g. "Adding a Gmail step" */
  describe(args: A): string
  /** Human-readable summary shown in the confirmation card for 'confirm' tools */
  confirmText?(args: A, ctx: ToolContext): string
  /**
   * run() always asks the user itself, with a preview built from saved data, so the generic confirmation gate
   * (alwaysConfirm, Apply on a suggestion) skips it rather than showing a second card.
   */
  confirmsInRun?: boolean
  run(args: A, ctx: ToolContext): Promise<unknown>
}
