// Errors the tools raise. Messages are written for the LLM: what failed and what to do next.

import { redactText } from '../redact'
import { VsError } from '../viasocket-client'
import { asArray, isRecord, str, truncate } from './util'

export class ToolError extends Error {}

/** Cancellation from the user (Stop) must never be swallowed by best-effort catches. */
export function isAbortError(e: unknown): boolean {
  return (e instanceof VsError && e.kind === 'aborted') || (e instanceof DOMException && e.name === 'AbortError')
}

/** Short detail from a backend error body: test-run failures nest the real reason, validation failures list details. */
function detailOf(body: unknown): string {
  if (!isRecord(body)) return ''
  const data = body.data
  if (isRecord(data)) {
    const inner = str(data.message) ?? (isRecord(data.data) ? str(data.data.errMessage) : undefined)
    if (inner) return truncate(inner, 400)
  }
  const details = asArray(data)
    .map((d) => (isRecord(d) ? str(d.message) : undefined))
    .filter((m): m is string => !!m)
  return details.length ? truncate(details.join('; '), 400) : ''
}

/**
 * Runs one backend call and prefixes any failure with what the tool was doing. The VsError kind is kept so the
 * agent can still react to it (e.g. signed out). `redact` masks personal data in the backend's text: test-run
 * failures can quote run data.
 */
export async function call<T>(what: string, fn: () => Promise<T>, opts: { redact?: boolean } = {}): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof VsError) {
      const detail = detailOf(e.body)
      const msg = detail && !e.message.includes(detail) ? `${e.message} (${detail})` : e.message
      throw new VsError(`${what} failed: ${opts.redact ? redactText(msg, 600) : msg}`, e.kind, e.status, e.body)
    }
    throw e
  }
}
