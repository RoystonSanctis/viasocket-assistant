// Contract between the content-script controller (content/index.ts) and the mascot UI (content/mascot/*).
// The mascot is pure UI: it never talks to the service worker directly.

import type { ClientConfig } from '../../shared/config'
import type { ChatLine, ConfirmRequest, HighlightTarget, MascotMode, Suggestion, WorkflowPlan } from '../../shared/mascot'
import type { SttEngine, VoiceState } from '../../shared/messages'
import type { PageContext } from '../../shared/page'

export interface MascotCallbacks {
  /** User typed a message in the panel */
  onUserText(text: string): void
  /** Mic button pressed / released in the panel (push-to-talk with the mouse) */
  onMicDown(): void
  onMicUp(): void
  onConfirm(id: string, approved: boolean): void
  onSuggestion(id: string, action: 'apply' | 'dismiss'): void
  /** Stop the current agent run */
  onCancel(): void
  onOpenSettings(section?: string): void
  onClearThread(): void
  /** A highlight() target never showed up, or stayed out of sight, so the user did not see it */
  onHighlightMissed(): void
  onPanelOpenChange?(open: boolean): void
}

export interface MascotController {
  setConfig(config: ClientConfig): void
  setPage(page: PageContext): void
  /** Hide entirely (setting off, unsupported page) or show */
  setEnabled(enabled: boolean): void
  setMode(mode: MascotMode, text?: string): void
  /** One short line next to the bubble; truncated to mascot.thinkingTextMaxChars */
  setThinking(text: string): void
  addChat(line: ChatLine): void
  setHistory(lines: ChatLine[]): void
  /** The workflow plan checklist pinned at the top of the chat; null hides it */
  setPlan(plan: WorkflowPlan | null): void
  showConfirm(request: ConfirmRequest): void
  /** Removes a confirmation card that can no longer be answered (timed out or its run was cancelled) */
  dismissConfirm(id: string): void
  showSuggestion(suggestion: Suggestion): void
  /** Removes suggestion cards that no longer apply (they were made for another flow or plug) */
  dismissSuggestions(ids: string[]): void
  /**
   * Fly to the target, spotlight it, and show the note. A target that is not on the page yet is looked for for a few
   * seconds; if it never becomes visible, onHighlightMissed fires. Returns false only when highlighting is off.
   */
  highlight(target: HighlightTarget, note?: string): boolean
  clearHighlight(): void
  /** Which engine hears the user; decides how a microphone permission problem is fixed */
  setSttEngine(engine: SttEngine): void
  setVoiceState(state: VoiceState, detail?: string, progress?: number): void
  /** 0..1 microphone level, drives the listening pulse */
  setVoiceLevel(level: number): void
  setTranscript(text: string, final: boolean): void
  setBusy(busy: boolean): void
  /** Open the chat panel directly (e.g. from wake word) */
  openPanel(takeFocus?: boolean): void
  isPanelOpen(): boolean
  /** Controls visibility of the voice mic button in the composer */
  setVoiceEnabled(enabled: boolean): void
  setStatus(llmReady: boolean, reason?: string): void
  destroy(): void
}

export type CreateMascot = (callbacks: MascotCallbacks) => MascotController
