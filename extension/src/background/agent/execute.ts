// Runs one tool call on behalf of the model (or a suggestion the user applied): argument checks, mascot state,
// the confirmation gate and result shaping. The gate lives here in code, never in the prompt.

import type { FullConfig } from '../../shared/config'
import { LlmError } from '../llm/types'
import type { Tool, ToolContext } from '../tools/types'
import { VsError } from '../tools/viasocket-client'
import type { RunTarget } from './run-target'
import type { Session } from './session'

const READ_PREFIXES = ['vs_get', 'vs_list', 'vs_search', 'dh_get', 'dh_list', 'dh_search', 'dh_check', 'dh_kb']
const CONFIRM_DETAIL_CHARS = 800

export interface ToolOutcome {
  /** What goes back to the model as the tool message */
  content: string
  ok: boolean
  declined?: boolean
  /** viaSocket said the user is signed out; further calls would fail too */
  authFailed?: boolean
}

export function errorContent(error: string, kind: string): string {
  return JSON.stringify({ error, kind })
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s
}

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (e instanceof LlmError || e instanceof VsError) return e.kind === 'aborted'
  return e instanceof Error && e.name === 'AbortError'
}

export function describeSafely(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.describe(args) || tool.name
  } catch {
    return tool.name
  }
}

type Prepared = { args: Record<string, unknown> } | { error: string }

/** Parses the model's raw JSON arguments and checks them against the tool's top-level schema. */
export function prepareArgs(tool: Tool, raw: string): Prepared {
  let parsed: unknown
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {}
    // Some models double-encode the arguments object as a JSON string.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
  } catch {
    return { error: `Arguments for ${tool.name} were not valid JSON. Resend the call with a single valid JSON object.` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `Arguments for ${tool.name} must be a JSON object.` }
  }
  return validateArgs(tool, parsed as Record<string, unknown>)
}

export function validateArgs(tool: Tool, input: Record<string, unknown>): Prepared {
  const schema = tool.parameters
  const required = new Set(schema.required ?? [])
  const props = schema.properties ?? {}
  const args: Record<string, unknown> = {}
  // Models often send null for optional parameters they mean to leave out.
  for (const [k, v] of Object.entries(input)) if (v !== null || required.has(k)) args[k] = v

  const missing = [...required].filter((k) => args[k] === undefined || args[k] === null)
  if (missing.length) return { error: `Missing required argument(s) for ${tool.name}: ${missing.join(', ')}.` }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(args).filter((k) => !Object.hasOwn(props, k))
    if (extra.length) return { error: `Unknown argument(s) for ${tool.name}: ${extra.join(', ')}. Allowed: ${Object.keys(props).join(', ')}.` }
  }
  for (const [k, v] of Object.entries(args)) {
    const prop = props[k]
    if (!prop || typeof prop !== 'object') continue
    const problem = checkValue(k, v, prop as Record<string, unknown>)
    if (problem) return { error: `${problem} (tool ${tool.name}).` }
  }
  return { args }
}

function checkValue(name: string, value: unknown, prop: Record<string, unknown>): string | null {
  const types = Array.isArray(prop.type) ? prop.type.filter((t): t is string => typeof t === 'string') : typeof prop.type === 'string' ? [prop.type] : null
  if (types && !types.some((t) => matchesType(t, value))) return `Argument "${name}" must be ${types.join(' or ')}`
  if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
    return `Argument "${name}" must be one of: ${prop.enum.map((v) => JSON.stringify(v)).join(', ')}`
  }
  return null
}

function matchesType(type: string, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v)
    case 'null':
      return v === null
    default:
      return true
  }
}

function isDeclined(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { declined?: unknown }).declined === true
}

function stringify(value: unknown): string {
  if (value === undefined) return '{"ok":true}'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? '{"ok":true}'
  } catch {
    return String(value)
  }
}

function confirmDetail(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): string {
  try {
    const text = tool.confirmText?.(args, ctx)
    if (text) return text
  } catch {
    // fall through to the raw arguments
  }
  return truncate(JSON.stringify(args, null, 2), CONFIRM_DETAIL_CHARS)
}

export function needsConfirm(tool: Tool, config: FullConfig): boolean {
  return tool.danger === 'confirm' || config.flags.alwaysConfirm.includes(tool.name)
}

/**
 * Executes a tool whose arguments were already validated, against the run's pinned page and client. Tool failures
 * become error results so the model can recover; only cancellation is thrown. `forceConfirm` asks the user even
 * for tools that normally run without asking.
 */
export async function executeTool(
  session: Session,
  tool: Tool,
  args: Record<string, unknown>,
  config: FullConfig,
  signal: AbortSignal,
  target: RunTarget,
  forceConfirm = false,
): Promise<ToolOutcome> {
  const { flags } = config
  const ui = session.ui
  const label = describeSafely(tool, args)
  ui.thinking(label)
  ui.mascot(tool.danger === 'safe' && READ_PREFIXES.some((p) => tool.name.startsWith(p)) ? 'searching' : 'working')

  const ctx: ToolContext = {
    page: target.page,
    vs: target.vs,
    ui,
    signal,
    maxResultChars: flags.maxToolResultChars,
    stripRunData: flags.stripRunData,
  }
  const gateWouldAsk = forceConfirm || needsConfirm(tool, config)
  if (tool.confirmsInRun && gateWouldAsk) ctx.mustConfirm = true

  if (!tool.confirmsInRun && gateWouldAsk) {
    const approved = await ui.confirm(label, confirmDetail(tool, args, ctx), true)
    signal.throwIfAborted()
    if (!approved) {
      ui.mascot('idle')
      return { ok: false, declined: true, content: JSON.stringify({ declined: true, message: 'User declined' }) }
    }
    ui.mascot('working')
  }

  try {
    // Stop can land while an earlier await was not tied to the signal; never start a tool after it.
    signal.throwIfAborted()
    const value = await tool.run(args, ctx)
    const content = truncate(stringify(value), flags.maxToolResultChars)
    // Tools that ask inside run() report a refusal as {declined:true}; surface it like a declined confirm card.
    if (tool.confirmsInRun && isDeclined(value)) {
      ui.mascot('idle')
      return { ok: false, declined: true, content }
    }
    return { ok: true, content }
  } catch (e) {
    if (isAbort(e, signal)) throw e
    const kind = e instanceof VsError ? e.kind : 'error'
    const message = e instanceof Error ? e.message : String(e)
    ui.mascot('confused')
    return {
      ok: false,
      content: truncate(errorContent(message, kind), flags.maxToolResultChars),
      authFailed: kind === 'logged-out' || kind === 'auth',
    }
  }
}
