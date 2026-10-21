// Flow run data: the latest run (sample data for mapping and tests), the context passed to dry runs, and the
// execute route every dry run goes through (step tests, trigger tests, dropdown option loaders).

import type { ToolContext, VsRunContext } from '../types'
import { call } from './errors'
import type { FlowTarget } from './types'
import { asRecord, isRecord, leafPaths, parseMaybeJson, str, trimData, truncate } from './util'

export interface RunContext {
  req: { body: unknown; headers: Record<string, unknown>; query: unknown }
  res: Record<string, unknown>
  vals: Record<string, unknown>
}

export interface ParsedRun {
  flowHitId?: string
  status?: string
  at?: string
  body: unknown
  query: unknown
  headers: Record<string, unknown>
  res: Record<string, unknown>
  vals: Record<string, unknown>
  large: boolean
}

// The backend's JSON body limit is 2 MB; leave room for the rest of the request.
const MAX_CONTEXT_CHARS = 1_500_000

export async function getRecentRun(ctx: ToolContext, t: FlowTarget): Promise<ParsedRun | null> {
  const body = await call('Reading the latest run', () =>
    ctx.vs.request({ method: 'GET', path: `/logs/scriptid/${t.scriptId}/recent`, signal: ctx.signal }),
  )
  return parseRun(asRecord(body).data)
}

/** Snapshots may be JSON strings or objects; no run at all comes back as []. */
export function parseRun(raw: unknown): ParsedRun | null {
  if (!isRecord(raw)) return null
  const req = asRecord(parseMaybeJson(raw.requestSnapshot))
  const meta = asRecord(raw.flowMetadata)
  return {
    flowHitId: str(raw.flowHitId),
    status: str(raw.status),
    at: str(raw.requestTimestamp) ?? str(raw.createdAt),
    body: req.body ?? {},
    query: req.query ?? {},
    headers: asRecord(req.headers),
    res: asRecord(parseMaybeJson(raw.responseSnapshot)),
    vals: asRecord(parseMaybeJson(raw.vals)),
    large: meta.storedInBucket === true || meta.isDataTooLarge === true,
  }
}

/** What the model sees of a run: the structure and real paths; with stripping on, values are only shapes. */
export function summarizeRun(run: ParsedRun, strip: boolean): Record<string, unknown> {
  return {
    flowHitId: run.flowHitId,
    status: run.status,
    at: run.at,
    partial: run.large || undefined,
    trigger: { body: trimData(run.body, strip), query: trimData(run.query, strip) },
    steps: trimData(run.res, strip),
    variables: trimData(run.vals, strip),
    paths: [
      ...leafPaths(run.body, 'context.req.body', 80, strip),
      ...leafPaths(run.res, 'context.res', 80, strip),
      ...leafPaths(run.vals, 'context.vals', 30, strip),
    ],
  }
}

export function contextTooLarge(context: RunContext): boolean {
  return (JSON.stringify(context) ?? '').length > MAX_CONTEXT_CHARS
}

export interface DryRunResult {
  success: boolean
  message: unknown
  console: unknown
  data: Record<string, unknown>
}

/**
 * POST /:orgId/:scriptId/execute, the route behind every Test button and dropdown loader. A failed run still
 * answers 200 with data.success false and the error as data.message. `redact` masks personal data in error text.
 */
export async function executeDryRun(ctx: VsRunContext, t: FlowTarget, body: Record<string, unknown>, what: string): Promise<DryRunResult> {
  const res = await call(what, () => ctx.vs.request({ method: 'POST', path: `/${t.orgId}/${t.scriptId}/execute`, body, signal: ctx.signal }), {
    redact: ctx.stripRunData,
  })
  const data = asRecord(asRecord(res).data)
  return { success: data.success === true, message: data.message, console: data.console, data }
}

/** Console output arrives as a string or as captured log arguments. */
export function consoleOf(raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  return text && text !== '""' && text !== '[]' ? text : undefined
}

/** The error text inside a failed dry run's message. */
export function dryRunErrorText(message: unknown): string | undefined {
  if (typeof message === 'string') return truncate(message, 500)
  const m = asRecord(message)
  const nested = asRecord(m.error)
  const text = str(m.errorMessage) ?? str(nested.message) ?? (Number(m.status) >= 400 ? str(m.message) : undefined) ?? str(m.message)
  return text ? truncate(text, 500) : undefined
}
