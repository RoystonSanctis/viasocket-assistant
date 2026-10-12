// Redaction for anything derived from run data (payloads, step outputs, console logs, error text) before it is
// handed to the LLM provider. With stripRunData on, only structure and value *shapes* survive: enough to map
// fields by path and to diagnose errors, without shipping customer data.

// Quantifiers are bounded so a pathological console dump cannot make the service worker backtrack for seconds.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g
const PHONE = /\+?\d[\d\s().-]{7,24}\d/g
const LONG_DIGITS = /\d{8,}/g
const BEARERISH = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const TOKENISH = /\b[A-Za-z0-9_-]{32,}\b/g
const QUOTED = /"(?:[^"\\]|\\.){1,2000}"/g

/** Placeholder describing a scalar without revealing it. */
export function shapeOf(v: unknown): unknown {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return '<number>'
  if (typeof v === 'string') {
    if (!v) return ''
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return '<email>'
    // Before the phone pattern, which would also match plain digit runs and ISO dates.
    if (/^\d+$/.test(v)) return `<digits:${v.length}>`
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return '<date>'
    if (/^\+?\d[\d\s().-]{7,}\d$/.test(v)) return '<phone>'
    if (/^https?:\/\//i.test(v)) return '<url>'
    return `<string:${v.length}>`
  }
  return `<${typeof v}>`
}

/** Object keys can carry data too (e.g. maps keyed by email or phone); those are replaced, others kept. */
export function redactKey(k: string): string {
  if (/@/.test(k) || /\d{6,}/.test(k)) return '<key>'
  return k
}

/** Masks emails, phone numbers, long digit runs, bearer-style tokens and quoted strings inside free text. */
export function redactText(text: string, maxChars = 600): string {
  // Cut first (with headroom for placeholders) so the regexes only ever scan a bounded input.
  const input = text.length > maxChars * 2 ? text.slice(0, maxChars * 2) : text
  // Tokens go before the digit rules: masking digits inside a token first would split it and leave the rest visible.
  const out = input
    .replace(BEARERISH, '<token>')
    .replace(TOKENISH, '<token>')
    .replace(EMAIL, '<email>')
    .replace(QUOTED, (m) => (m.length <= 24 && !/[@\d]/.test(m) ? m : '"<string>"'))
    .replace(PHONE, '<phone>')
    .replace(LONG_DIGITS, (m) => `<digits:${m.length}>`)
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out
}

/** Applies redactText only when stripping is on; otherwise just bounds the length. */
export function maybeRedactText(text: string | undefined, strip: boolean, maxChars = 600): string | undefined {
  if (text === undefined) return undefined
  if (strip) return redactText(text, maxChars)
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
