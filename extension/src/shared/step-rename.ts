// Helper functions for safe step renaming:
// 1. Uniqueness generator matching viaSocket duplicate step behavior (zZ algorithm)
// 2. Cascading reference replacer across downstream step inputs, code, dynamic variables, and custom response

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * Ensures a step slug is unique among existing slugs.
 * If the candidate name matches an existing slug (other than currentSlug),
 * increments the numeric suffix at the end (_1, _2, etc.), matching the duplicate step behavior (zZ algorithm).
 */
export function getUniqueStepSlug(desiredSlug: string, existingSlugs: Iterable<string>, currentSlug?: string): string {
  const existing = new Set(existingSlugs)
  if (currentSlug) existing.delete(currentSlug)

  const normalized = desiredSlug.trim().replace(/\s+/g, '_')
  if (!existing.has(normalized)) return normalized

  const match = normalized.match(/^(.*?)(?:_(\d+))?$/)
  const base = match?.[1] || normalized
  let num = match?.[2] ? parseInt(match[2], 10) : 0
  let candidate = num ? `${base}_${num}` : base
  while (existing.has(candidate)) {
    num++
    candidate = `${base}_${num}`
  }
  return candidate
}

/**
 * Replaces all downstream references to oldSlug with newSlug in code or template string.
 * Handles:
 * - context.res.oldSlug / context?.res?.oldSlug
 * - context.vals.oldSlug / context?.vals?.oldSlug
 * - res.oldSlug / res?.oldSlug
 * - steps.oldSlug / steps?.oldSlug
 * - Bracket notation: context.res["oldSlug"], context?.res?.['oldSlug'], steps["oldSlug"], etc.
 */
export function replaceStepReferencesInString(text: string, oldSlug: string, newSlug: string): string {
  if (!text || typeof text !== 'string' || !oldSlug || !newSlug || oldSlug === newSlug) return text
  const escaped = oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // 1. Dot notation: (context?.res?. | res?. | steps?. | context?.vals?.)oldSlug
  const dotRe = new RegExp(
    String.raw`(\bcontext(?:\?\.)?(?:res|vals)(?:\?\.)|\b(?:res|steps)(?:\?\.)|\bcontext\.(?:res|vals)\.|\b(?:res|steps)\.)\b${escaped}\b`,
    'g',
  )
  let updated = text.replace(dotRe, `$1${newSlug}`)

  // 2. Bracket notation: context?.res?.[...] or res[...] or steps[...]
  const bracketRe = new RegExp(
    String.raw`(\bcontext(?:\?\.)?(?:res|vals)(?:\?\.)?\s*\[\s*["']|\b(?:res|steps)(?:\?\.)?\s*\[\s*["'])${escaped}(?=["']\s*\])`,
    'g',
  )
  updated = updated.replace(bracketRe, `$1${newSlug}`)

  return updated
}

/**
 * Recursively traverses an object, array, or scalar, replacing step references in all strings.
 * Returns the updated value and a boolean flag indicating if any replacements were made.
 */
export function replaceStepReferencesInObject(obj: unknown, oldSlug: string, newSlug: string): { value: unknown; changed: boolean } {
  if (typeof obj === 'string') {
    const updated = replaceStepReferencesInString(obj, oldSlug, newSlug)
    return { value: updated, changed: updated !== obj }
  }
  if (Array.isArray(obj)) {
    let changed = false
    const arr = obj.map((item) => {
      const res = replaceStepReferencesInObject(item, oldSlug, newSlug)
      if (res.changed) changed = true
      return res.value
    })
    return { value: arr, changed }
  }
  if (obj && typeof obj === 'object') {
    let changed = false
    const record: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const newKey = replaceStepReferencesInString(k, oldSlug, newSlug)
      if (newKey !== k) changed = true
      const res = replaceStepReferencesInObject(v, oldSlug, newSlug)
      if (res.changed) changed = true
      record[newKey] = res.value
    }
    return { value: record, changed }
  }
  return { value: obj, changed: false }
}
