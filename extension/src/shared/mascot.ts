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
  /** Visible text on a button, link, tab or clickable control (e.g. "Create new plug", "AI Agents") */
  text?: string
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
  /** A settings shortcut under a system note, e.g. "Change model" after the AI provider failed */
  link?: { label: string; section: string }
}

// ---------- workflow plan (the checklist card pinned at the top of the chat) ----------

export const PLAN_STATUSES = ['todo', 'doing', 'done', 'skipped', 'blocked'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const PLAN_KINDS = [
  'trigger', 'step', 'condition', 'branch', 'delay', 'ai', 'loop', 'run-if', 'get-data', 'response', 'test', 'publish',
] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

export const PLAN_LIMITS = {
  items: 30,
  planTitle: 80,
  title: 80,
  detail: 200,
  note: 140,
  /** Nesting for steps inside a branch or loop; 0 is the top level */
  depth: 3,
} as const

/** Item ids are short slugs the model chooses ("trigger", "s2", "if-paid"). */
export const PLAN_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

/** Text the plan card's "Looks good, start" button sends; the worker treats it as approving the plan. */
export const PLAN_APPROVE_TEXT = 'Looks good, start building.'

export interface PlanItem {
  id: string
  title: string
  detail?: string
  kind?: PlanKind
  status: PlanStatus
  note?: string
  depth?: number
}

export interface WorkflowPlan {
  /** Changes whenever the whole plan is replaced; patches keep it */
  id: string
  title?: string
  items: PlanItem[]
  /** The user has not approved this plan yet: the card shows "Looks good, start" and "Change something" */
  awaitingConfirmation: boolean
  /** Bumped on every change */
  rev: number
  updatedAt: number
  /** When the plan last started waiting for approval; only a run started after this (a user reply) can approve it */
  proposedAt?: number
}

// Control, zero-width and bidi characters can hide or reorder text.
const PLAN_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/** One line of plain text: invisible characters removed, whitespace collapsed, cut to `max` characters. */
export function planText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(PLAN_INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const STATUS_SET: ReadonlySet<string> = new Set(PLAN_STATUSES)
const KIND_SET: ReadonlySet<string> = new Set(PLAN_KINDS)

export function isPlanStatus(v: unknown): v is PlanStatus {
  return typeof v === 'string' && STATUS_SET.has(v)
}

export function isPlanKind(v: unknown): v is PlanKind {
  return typeof v === 'string' && KIND_SET.has(v)
}

/**
 * Coerces anything (stored data from an older version, a message) into a well-formed plan, or null when nothing
 * usable is left. Never throws. Items without a valid id or title are dropped, duplicates keep the first.
 */
export function normalizePlan(raw: unknown): WorkflowPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.items)) return null
  const seen = new Set<string>()
  const items: PlanItem[] = []
  for (const it of r.items) {
    if (items.length >= PLAN_LIMITS.items) break
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (typeof o.id !== 'string' || !PLAN_ITEM_ID.test(o.id) || seen.has(o.id)) continue
    const title = planText(o.title, PLAN_LIMITS.title)
    if (!title) continue
    seen.add(o.id)
    const item: PlanItem = { id: o.id, title, status: isPlanStatus(o.status) ? o.status : 'todo' }
    const detail = planText(o.detail, PLAN_LIMITS.detail)
    if (detail) item.detail = detail
    if (isPlanKind(o.kind)) item.kind = o.kind
    const note = planText(o.note, PLAN_LIMITS.note)
    if (note) item.note = note
    if (typeof o.depth === 'number' && Number.isFinite(o.depth) && o.depth >= 1) item.depth = Math.min(PLAN_LIMITS.depth, Math.floor(o.depth))
    items.push(item)
  }
  if (!items.length) return null
  const plan: WorkflowPlan = {
    id: typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : 'plan',
    items,
    awaitingConfirmation: r.awaitingConfirmation === true,
    rev: typeof r.rev === 'number' && Number.isFinite(r.rev) && r.rev >= 0 ? Math.floor(r.rev) : 0,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
  }
  const title = planText(r.title, PLAN_LIMITS.planTitle)
  if (title) plan.title = title
  if (plan.awaitingConfirmation && typeof r.proposedAt === 'number' && Number.isFinite(r.proposedAt)) plan.proposedAt = r.proposedAt
  return plan
}

/** One item of a ui_plan call: on "replace" a full item (title required), on "patch" only the fields to change. */
export interface PlanItemInput {
  id: string
  title?: string
  detail?: string
  kind?: PlanKind
  status?: PlanStatus
  note?: string
  depth?: number
}

/** A ui_plan call: replace the whole plan, patch items by id, or clear it. */
export interface PlanUpdate {
  op: 'replace' | 'patch' | 'clear'
  title?: string
  items?: PlanItemInput[]
  awaitingConfirmation?: boolean
}

export interface PlanChange {
  plan: WorkflowPlan | null
  /** Items that became 'doing' with this change, in plan order */
  started: PlanItem[]
  /** awaitingConfirmation went from true to false because work started without an explicit approval flag */
  autoApproved: boolean
  /** A replace in the same answer that proposed the plan: it keeps waiting for the user's approval */
  stillAwaiting?: boolean
}

/** The item being worked on: the first 'doing' one. */
export function currentPlanItem(plan: WorkflowPlan | null | undefined): PlanItem | undefined {
  return plan?.items.find((i) => i.status === 'doing')
}
