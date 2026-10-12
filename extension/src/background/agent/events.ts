// One-line summaries of observed page events, for the system prompt and for "Explain" requests.

import type { ObservedEvent } from '../../shared/observed'
import { redactText } from '../tools/redact'

const MAX_PATH_CHARS = 120
const MAX_ERROR_CHARS = 300
// Control, zero-width and bidi characters can hide or reorder text the model reads.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

export const oneLine = (s: string, max: number): string => {
  const t = s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** `strip` (the stripRunData flag): the backend's error text can quote run data, so it is masked like test errors. */
export function summarizeEvent(e: ObservedEvent, strip = false): string {
  const time = Number.isFinite(e.at) ? new Date(e.at).toISOString().slice(11, 19) : '--:--:--'
  const method = /^[A-Za-z]{1,10}$/.test(e.method) ? e.method.toUpperCase() : '?'
  // Path, step name and error text come from the page and viaSocket responses: JSON-quoted so they stay data.
  const parts = [
    `${time} ${e.kind}`,
    e.ok ? 'ok' : `failed (HTTP ${Number.isFinite(e.status) ? e.status : '?'})`,
    `${method} ${JSON.stringify(oneLine(e.path, MAX_PATH_CHARS))}`,
    e.byAssistant ? 'by assistant' : 'by user',
  ]
  if (e.slugName) parts.push(`step ${JSON.stringify(oneLine(e.slugName, MAX_PATH_CHARS))}`)
  let s = parts.join(', ')
  if (e.errorText) {
    const text = oneLine(e.errorText, MAX_ERROR_CHARS)
    s += `; error: ${JSON.stringify(strip ? redactText(text, MAX_ERROR_CHARS) : text)}`
  }
  return s
}
