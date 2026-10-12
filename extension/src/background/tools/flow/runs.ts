// Flow run data: the latest run (sample data for mapping and tests) and the context passed to dry runs.

import type { ToolContext } from '../types'
import { call } from './errors'
import type { FlowTarget } from './types'
import { asRecord, isRecord, leafPaths, parseMaybeJson, str, trimData } from './util'

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

/**
 * Context for a single-step dry run: the given payload (or the latest run's) as context.req.body, plus earlier
 * step outputs so references resolve.
 */
export function buildTestContext(run: ParsedRun | null, payload: unknown): RunContext {
  const context: RunContext = {
    req: { body: payload ?? run?.body ?? {}, headers: {}, query: run?.query ?? {} },
    res: run?.res ?? {},
    vals: run?.vals ?? {},
  }
  if ((JSON.stringify(context) ?? '').length > MAX_CONTEXT_CHARS) {
    context.res = {}
    context.vals = {}
  }
  return context
}

export function contextTooLarge(context: RunContext): boolean {
  return (JSON.stringify(context) ?? '').length > MAX_CONTEXT_CHARS
}
