// Events the extension infers by watching the viaSocket page (network calls + URL), with no viaSocket code changes.

export type ObservedKind =
  | 'flow-loaded'
  | 'step-saved'
  | 'step-created'
  | 'step-deleted'
  | 'step-tested'
  | 'trigger-saved'
  | 'flow-published'
  | 'flow-discarded'
  | 'dh-saved'
  | 'dh-dry-run'
  | 'api-error'
  | 'unknown-mutation'

export interface ObservedEvent {
  kind: ObservedKind
  at: number
  method: string
  /** Path without host or query, ids kept so the classifier can match */
  path: string
  status: number
  ok: boolean
  /** True when the request carried sent-by-fbai (i.e. it was made by this extension) */
  byAssistant: boolean
  scriptId?: string
  slugName?: string
  /** Short, size-capped error text pulled from the response, if any */
  errorText?: string
  durationMs?: number
}
