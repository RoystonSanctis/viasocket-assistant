// Typed structures and message protocol for Copy / Paste support across flows and accounts.

export const COPIED_STEP_STORAGE_KEY = 'vs_copied_step_v1'

export interface CopiedStepSource {
  host: string
  orgId?: string
  projectId?: string
  scriptId: string
  slugName: string
  stepTitle: string
  type: string
}

export interface CopiedStepBlock {
  type: string
  title?: string
  description?: string
  iconUrl?: string
  sampleData?: unknown
  isPaidAction?: boolean
  breakPoint?: unknown
  service?: {
    eventId?: string
    serviceId?: string
    authVersionId?: string
    actionVersionId?: string
  }
  metaData?: Record<string, unknown>
  data?: unknown
  html?: unknown
  condition?: string
  statement?: string
  mode?: string
  dynamicVariables?: Record<string, unknown>
  [key: string]: unknown
}

export interface CopiedStepFunctionData {
  code?: string
  dynamicVariables?: Record<string, unknown>
  subfunctions?: unknown
  auth_id?: string
  action_id?: string
}

export interface CopiedStepData {
  version: 1
  copiedAt: number
  source: CopiedStepSource
  block: CopiedStepBlock
  functionData?: CopiedStepFunctionData
}

// Runtime messages between content script and background service worker
export type StepClipboardRequest =
  | {
      target: 'background'
      type: 'step:copy'
      slugName: string
      scriptId?: string
      projectId?: string
      orgId?: string
      host?: string
    }
  | {
      target: 'background'
      type: 'step:paste'
      targetSlugName: string
      /** Insert a new blank step of this type instead of the copied one ("Add JS step"). */
      template?: 'function'
      scriptId?: string
      projectId?: string
      orgId?: string
      host?: string
    }
  | {
      target: 'background'
      type: 'step:get-copied'
    }
  | {
      target: 'background'
      type: 'step:delete'
      slugName: string
      scriptId?: string
      projectId?: string
      orgId?: string
      host?: string
    }

export type StepClipboardResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }
