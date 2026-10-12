// Guards for text the model writes into rows or reads back from them: secret-looking values are found or masked, and
// model/vendor/tool names (the skill forbids them in metadata, notes and aiContext) are replaced with the skill label.
// No imports from the API layer, so both api.ts and the tools can use it.

import { MODEL_NAME_RE } from './constants'

export const SECRET_KEY_RE = /^(?:client_?secret|secret|password|passwd|api_?key|access_?token|refresh_?token|bearer|authorization|cookie|private_?key)$/i
export const SECRET_VALUE_RES = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abposr]|AKIA|AIza|ya29)[-_.]?[A-Za-z0-9_-]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
]

/** Path of the first value that looks like a credential, for notes the model writes into rows (aiContext). */
export function findSecret(v: unknown, path = 'aiContext', depth = 0): string | undefined {
  if (depth > 8) return undefined
  if (typeof v === 'string') return SECRET_VALUE_RES.some((re) => re.test(v)) ? path : undefined
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findSecret(v[i], `${path}[${i}]`, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k) && typeof x === 'string' && x.trim()) return `${path}.${k}`
      const hit = findSecret(x, `${path}.${k}`, depth + 1)
      if (hit) return hit
    }
  }
  return undefined
}

/** Placeholder written instead of a secret-looking value; never accepted back on a write. */
export const SECRET_MASK = '[secret masked]'

/** Masks secret-looking values (bearer/basic tokens, vendor keys, private keys, JWTs) inside free text. */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0
  let out = text
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(new RegExp(re.source, 'g'), () => {
      masked++
      return SECRET_MASK
    })
  }
  return { text: out, masked }
}

/** maskSecrets over every string (and object key) of a JSON-ish value; shape is kept. */
export function maskSecretsDeep(v: unknown, depth = 0): { value: unknown; masked: number } {
  if (typeof v === 'string') {
    const r = maskSecrets(v)
    return { value: r.text, masked: r.masked }
  }
  if (depth > 12 || v === null || typeof v !== 'object') return { value: v, masked: 0 }
  let masked = 0
  if (Array.isArray(v)) {
    const value = v.map((x) => {
      const r = maskSecretsDeep(x, depth + 1)
      masked += r.masked
      return r.value
    })
    return { value, masked }
  }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const key = maskSecrets(k)
    const r = maskSecretsDeep(x, depth + 1)
    masked += key.masked + r.masked
    out[key.text] = SECRET_KEY_RE.test(k) && typeof x === 'string' && x.trim() && !x.includes('${') ? SECRET_MASK : r.value
    if (out[key.text] === SECRET_MASK && r.value !== SECRET_MASK) masked++
  }
  return { value: out, masked }
}

/**
 * Replaces model, vendor and tool names (skill: never in metadata, notes or aiContext) with the skill label. Names that
 * are part of the plug's own name or domain (an OpenAI or Gemini plug) are kept, and so are URLs and hosts.
 */
export function scrubModelNames(text: string, labelText: string, keep: readonly string[] = []): string {
  const kept = keep.map((k) => k.toLowerCase().replace(/[^a-z0-9]+/g, ''))
  return text.replace(MODEL_NAME_RE, (m) => {
    const norm = m.toLowerCase().replace(/[^a-z0-9]+/g, '')
    return norm && kept.some((k) => k.includes(norm)) ? m : labelText
  })
}

/** scrubModelNames over every string and key of a JSON-ish value. */
export function scrubModelNamesDeep(v: unknown, labelText: string, keep: readonly string[] = [], depth = 0): unknown {
  if (typeof v === 'string') return scrubModelNames(v, labelText, keep)
  if (depth > 12 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => scrubModelNamesDeep(x, labelText, keep, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[scrubModelNames(k, labelText, keep)] = scrubModelNamesDeep(x, labelText, keep, depth + 1)
  return out
}
