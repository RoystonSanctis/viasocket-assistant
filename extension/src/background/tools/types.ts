// Tool contract for the agent. Tools are the only way the LLM can affect viaSocket or the page.
// Safety is enforced here in code (allowlisted endpoints, confirmations), never delegated to the prompt.

import type { JsonSchema } from '../llm/types'
import type { HighlightTarget, MascotMode, PlanChange, PlanUpdate, Suggestion } from '../../shared/mascot'
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
  /** Invalidate step data in the editor's Redux store so that open or subsequent slider views render fresh draft state */
  refreshStep(step: { scriptId: string; stepId?: string; slugName?: string }): void
  reloadPage(reason: string): void
  /** Resolves true only if the user clicks the confirm button */
  confirm(title: string, detail: string, danger: boolean, confirmLabel?: string): Promise<boolean>
  say(text: string): void
  /** Shows a suggestion card; Apply runs `apply` through the same checks and confirmation as the agent. Returns its id. */
  suggest(suggestion: Omit<Suggestion, 'id'>): string
  /**
   * Applies a ui_plan change to the workflow plan of the conversation this run writes to, stores it with that
   * conversation and shows it as the checklist card. Rejects, with a message meant for the model, when the change
   * does not fit (unknown item id, empty plan, ...).
   */
  plan(update: PlanUpdate): Promise<PlanChange>
}

export interface ToolContext {
  page: PageContext
  tabId?: number
  vs: ViaSocketClient
  ui: UiBridge
  signal: AbortSignal
  maxResultChars: number
  stripRunData: boolean
  /**
   * Set for confirmsInRun tools when the generic gate would have asked (alwaysConfirm, Apply on a suggestion). Such a
   * tool must then ask in run() even for work it would otherwise run directly.
   */
  mustConfirm?: boolean
}

/** The part of ToolContext that plain backend reads need, so page-initiated handlers can reuse them outside a run. */
export type VsContext = Pick<ToolContext, 'vs' | 'signal'>

/** VsContext for calls that run code (dry runs): redacts backend error text when run data is protected. */
export type VsRunContext = VsContext & Partial<Pick<ToolContext, 'stripRunData'>>

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
   * run() asks the user itself, with a preview built from saved data, so the generic confirmation gate skips it
   * rather than showing a second card. When that gate would have asked (alwaysConfirm, Apply on a suggestion), ctx
   * carries mustConfirm and run() asks even for work it treats as read-only.
   */
  confirmsInRun?: boolean
  run(args: A, ctx: ToolContext): Promise<unknown>
}
