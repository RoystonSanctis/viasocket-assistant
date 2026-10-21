// Typed message protocol between the extension's contexts.
//
//   content script  <— port "assistant" —>  service worker  <— runtime messages —>  offscreen document
//   page (MAIN world) <— window.postMessage (nonce-checked) —> content script
//
// The LLM key and the viaSocket token never travel to the content script or the page.

import type { ChatLine, ConfirmRequest, HighlightTarget, MascotMode, Suggestion, WorkflowPlan } from './mascot'
import type { PageContext } from './page'
import type { ObservedEvent } from './observed'
import type { ClientConfig } from './config'
import type { SubfunctionRef } from './subfunctions'

export const PORT_NAME = 'assistant'

// ---------- content -> service worker (over the port) ----------
export type ContentToBackground =
  | { type: 'hello'; page: PageContext }
  | { type: 'page-changed'; page: PageContext }
  | { type: 'user-input'; text: string; source: 'voice' | 'text' }
  | { type: 'observed'; event: ObservedEvent }
  | { type: 'confirm-response'; id: string; approved: boolean }
  | { type: 'suggestion-response'; id: string; action: 'apply' | 'dismiss' }
  | { type: 'cancel' }
  | { type: 'heartbeat' }
  /** cancel throws the recording away instead of transcribing it (e.g. the hotkey turned out to be a shortcut) */
  | { type: 'voice'; action: 'start' | 'stop' | 'toggle' | 'cancel' }
  | { type: 'clear-thread' }
  | { type: 'open-options'; section?: string }
  | { type: 'dom-status'; status: DomPageStatus }
  | { type: 'dom-status-response'; requestId: string; status: DomPageStatus }

export interface DomPageStatus {
  panelOpen: boolean
  stepTitle?: string
  connection?: string
  selectedFields: Record<string, string>
  hasUnsavedChanges: boolean
  testedInUi: boolean
  hasSampleResponse: boolean
  canSave: boolean
}

// ---------- service worker -> content (over the port) ----------
export type BackgroundToContent =
  | { type: 'config'; config: ClientConfig }
  | { type: 'mascot'; mode: MascotMode; text?: string }
  | { type: 'thinking-text'; text: string }
  | { type: 'chat'; line: ChatLine }
  | { type: 'get-dom-status'; requestId: string }
  | { type: 'history'; lines: ChatLine[] }
  /** The conversation's workflow plan (checklist card); null hides it. Sent after every 'history' and on each change */
  | { type: 'plan'; plan: WorkflowPlan | null }
  | { type: 'suggestion'; suggestion: Suggestion }
  /** Suggestions made for a flow or plug the tab no longer shows; Apply would be refused, so the cards go */
  | { type: 'suggestions-clear'; ids: string[] }
  | { type: 'highlight'; target: HighlightTarget; note?: string }
  | { type: 'clear-highlight' }
  /** replace: update the current history entry (opening/closing panels, refetch stamps) instead of adding one */
  | { type: 'navigate'; url: string; replace?: boolean }
  /** Invalidate/refresh step configuration in the editor's Redux store so open or subsequent slider views reflect live draft changes */
  | { type: 'refresh-step'; scriptId?: string; stepId?: string; slugName?: string }
  | { type: 'reload-page'; reason: string }
  | { type: 'confirm-request'; request: ConfirmRequest }
  /** The request timed out or its run ended: remove the card (a late click would be ignored anyway) */
  | { type: 'confirm-cancel'; id: string }
  /** Keyboard command (chrome.commands) forwarded to the tab, which owns push-to-talk for both speech engines */
  | { type: 'voice-command'; action: 'start' | 'stop' | 'toggle' }
  | { type: 'voice-state'; state: VoiceState; detail?: string; progress?: number }
  | { type: 'voice-level'; level: number }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'status'; llmReady: boolean; reason?: string }
  | { type: 'tts-state'; speaking: boolean }

export type VoiceState = 'off' | 'loading-model' | 'ready' | 'listening' | 'transcribing' | 'error' | 'needs-permission'

// ---------- service worker <-> offscreen (chrome.runtime.sendMessage, target-tagged) ----------
export type SttEngine = 'whisper-local' | 'browser'

export type ToOffscreen =
  | { target: 'offscreen'; type: 'stt-start'; model: string; language?: string; device?: 'webgpu' | 'wasm' | 'auto' }
  | { target: 'offscreen'; type: 'stt-stop' }
  | { target: 'offscreen'; type: 'stt-cancel' }
  | { target: 'offscreen'; type: 'stt-warmup'; model: string; device?: 'webgpu' | 'wasm' | 'auto' }

export type FromOffscreen =
  | { target: 'background'; type: 'stt-state'; state: VoiceState; detail?: string; progress?: number }
  | { target: 'background'; type: 'stt-level'; level: number }
  | { target: 'background'; type: 'stt-result'; text: string }
  | { target: 'background'; type: 'stt-error'; message: string }

// ---------- options page -> service worker (chrome.runtime.sendMessage, reply via sendResponse) ----------
export type OptionsRequest =
  | { target: 'background'; type: 'options:get-state' }
  /** baseUrl only for providers that are not built in; the options page must already hold host permission */
  | { target: 'background'; type: 'options:save-key'; providerId: string; key: string; baseUrl?: string }
  | { target: 'background'; type: 'options:remove-key'; providerId: string }
  | { target: 'background'; type: 'options:test-key'; providerId: string }
  | { target: 'background'; type: 'options:list-models'; providerId: string }
  | { target: 'background'; type: 'options:refresh-config' }
  | { target: 'background'; type: 'options:stt-warmup' }

export type OptionsResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export interface ProviderView {
  id: string
  name: string
  adapter: 'openai' | 'anthropic'
  /** Address the key will be bound to (null for an unknown custom provider without baseUrl) */
  baseUrl: string | null
  builtIn: boolean
  noKey: boolean
  badges: string[]
  setupTip?: string
  keyPageUrl?: string
  keyPattern?: string
  recommendedModels: string[]
  hasKey: boolean
  keyLast4?: string
  /** Whether the extension currently holds host permission for baseUrl */
  hasPermission: boolean
}

export interface OptionsState {
  configVersion: string
  configSource: 'remote' | 'cache' | 'bundled'
  providers: ProviderView[]
  sttModels: Array<{ id: string; label: string; approxSizeMb: number; multilingual: boolean; note?: string }>
  defaultSttModel: string
}

export interface KeyTestResult {
  ok: boolean
  message: string
  /** e.g. OpenRouter free-tier daily requests remaining */
  details?: Record<string, string | number | boolean>
}

/** The open JS step as the editor shows it, for the subfunctions panel. Read from the page; never fetched there. */
export interface StepContextData {
  scriptId: string
  stepId: string
  slugName: string
  stepType?: string
  /** The code the editor currently shows, unsaved edits included */
  code: string
  subfunctions: SubfunctionRef[]
  /** Input Values as the panel shows them (unsaved edits included); absent when the step data is not loaded */
  dynamicVariables?: Record<string, string>
  /** Subfunction names other steps of this flow use (the flow keys connections by subfunction name) */
  otherNames: string[]
  /** Apps the workspace has connections for, for the app picker; no connection details */
  connectedApps: Array<{ serviceId: string; name: string; iconUrl?: string }>
  /** Mappable references, e.g. context.req.body.email */
  variables: string[]
}

// ---------- page (MAIN world) <-> content script ----------
// viaSocket's own window 'message' listeners react to top-level keys such as type, id, error, message and to
// string payloads, without checking origin. So every message is wrapped in ONE namespaced key and is never a string.
export const PAGE_KEY = '__vsAssistant'

export type PageToContentMsg =
  | { type: 'hook-ready' }
  | { type: 'observed'; event: ObservedEvent }
  | { type: 'navigated'; url: string }
  /** A navigation went ahead after waiting the maximum time for the page's own save, test or publish to finish */
  | { type: 'navigate-busy' }
  | { type: 'step-context-response'; requestId: string; data: StepContextData | null }
  | { type: 'editor-action-response'; requestId: string; result: EditorActionResult }

export type ContentToPageMsg =
  /** First message; the hook adopts this nonce and ignores any other init until that nonce is released */
  | { type: 'init'; apiHosts: string[] }
  /** Router-friendly navigation (pushState/replaceState + popstate) inside the single-page app */
  | { type: 'navigate'; url: string; replace?: boolean }
  /** Invalidate step data in Redux so that MasterSliderComponent refetches and renders fresh values */
  | { type: 'refresh-step'; scriptId?: string; stepId?: string; slugName?: string }
  /** Read the open JS step for the subfunctions panel; answered with step-context-response */
  | { type: 'get-step-context'; requestId: string; scriptId?: string; stepId?: string; slugName?: string }
  /** The Beautify button: check or format the Monaco editor marked with EDITOR_ID_ATTR; answered with editor-action-response */
  | { type: 'editor-action'; requestId: string; editorId: string; action: EditorAction }
  /** The content script was orphaned (extension updated or reloaded): the hook pairs with the next init instead */
  | { type: 'release' }

export type PageEnvelope<T> = { [PAGE_KEY]: T & { nonce: string } }

/** Set by the content script on each `.monaco-editor` element so the hook can find the editor a button belongs to */
export const EDITOR_ID_ATTR = 'data-vs-editor-id'

/** 'check' only reports whether the editor can be beautified; 'beautify' formats it (whitespace only, undoable) */
export type EditorAction = 'check' | 'beautify'

export const EDITOR_ACTION_RESULTS = [
  /** check: an editable JavaScript or JSON editor */
  'ready',
  'formatted',
  /** Already formatted; nothing changed */
  'unchanged',
  /** Formatting would have changed more than whitespace (or broken code), so nothing changed */
  'unsafe',
  'too-large',
  'read-only',
  /** Not JavaScript or JSON */
  'unsupported',
  /** The hook cannot reach that editor */
  'missing',
  'failed',
] as const
export type EditorActionResult = (typeof EDITOR_ACTION_RESULTS)[number]
