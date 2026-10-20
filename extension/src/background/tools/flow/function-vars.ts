// Automatic extraction and normalization of dynamic variables ("Input Values") for function (JS) steps.
// Converts hardcoded context.res.*, context.req.*, context.vals.* in function code into named input variables
// in dynamicVariables so they render in the UI's "Input Values" section, allowing users to view and change
// mappings from outside the code editor.

import { chainsInCode } from './mapping'
import { isReservedName, isValidVariableName } from './slugs'
import { asRecord } from './util'

export interface ExtractedVariablesResult {
  code: string
  dynamicVariables: Record<string, string | null>
  extractedCount: number
}

function sanitizeIdentifier(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^_+/, '')
  if (!s || /^\d/.test(s) || isReservedName(s)) s = `val_${s || 'item'}`
  return s.slice(0, 50)
}

function pickVarName(
  dataSegs: Array<string | number>,
  usedKeys: Set<string>,
  code: string,
): string {
  const last = dataSegs[dataSegs.length - 1]
  const lastStr = typeof last === 'string' ? last : `item_${last}`
  let base = sanitizeIdentifier(lastStr)

  // Avoid collisions with local variables declared in the function code
  const isDeclaredInCode = (name: string) =>
    new RegExp(`\\b(const|let|var|function|async\\s+function)\\s+${name}\\b`).test(code)

  if (!usedKeys.has(base) && !isDeclaredInCode(base) && isValidVariableName(base)) {
    return base
  }

  // If already used or declared, prefix with parent step / container
  let prefix = ''
  if (dataSegs[0] === 'res' && typeof dataSegs[1] === 'string') {
    prefix = sanitizeIdentifier(dataSegs[1])
  } else if (dataSegs[0] === 'req') {
    prefix = dataSegs[1] === 'body' ? 'body' : 'req'
  } else if (dataSegs[0] === 'vals') {
    prefix = 'val'
  }

  let candidate = prefix ? `${prefix}_${base}` : `input_${base}`
  candidate = sanitizeIdentifier(candidate)
  if (!usedKeys.has(candidate) && !isDeclaredInCode(candidate) && isValidVariableName(candidate)) {
    return candidate
  }

  // Disambiguate with numeric suffix
  let counter = 2
  while (usedKeys.has(`${candidate}_${counter}`) || isDeclaredInCode(`${candidate}_${counter}`)) {
    counter++
  }
  return `${candidate}_${counter}`
}

/**
 * Normalizes a function step's code and dynamicVariables.
 * External data references (context.res.<slug>.<field>, context.req.body.<field>, context.vals.<slug>)
 * are extracted into dynamicVariables (template string chips) and replaced in the code with local variable identifiers.
 */
export function autoExtractDynamicVariables(
  code: string,
  existingVars?: Record<string, unknown>,
): ExtractedVariablesResult {
  const vars: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(existingVars ?? {})) {
    if (typeof v === 'string' || v === null) vars[k] = v
    else if (v !== undefined) vars[k] = String(v)
  }

  if (!code || typeof code !== 'string' || !/context\b/.test(code)) {
    return {
      code: code || '',
      dynamicVariables: vars,
      extractedCount: 0,
    }
  }
  const usedKeys = new Set(Object.keys(vars))

  const chains = chainsInCode(code)
  if (!chains.length) {
    return { code, dynamicVariables: vars, extractedCount: 0 }
  }

  interface Replacement {
    start: number
    end: number
    varName: string
  }

  const replacements: Replacement[] = []
  let extractedCount = 0

  for (const c of chains) {
    // Only context.res, context.req, context.vals
    if (c.segs.length < 2) continue
    const head = c.segs[0]
    if (head !== 'res' && head !== 'req' && head !== 'vals') continue
    if (c.segs.some((s) => s === null)) continue // skip computed paths

    let dataEnd = c.end
    let dataSegs: Array<string | number> = c.segs as Array<string | number>

    if (c.called) {
      // The last segment is a method call (e.g. .map, .filter). Find where the method starts.
      const slice = code.slice(c.start, c.end)
      const match = /(\??\.\s*[A-Za-z_$][\w$]*)$/.exec(slice)
      if (match) {
        dataEnd = c.end - match[0].length
        dataSegs = dataSegs.slice(0, -1)
      }
    }

    if (dataSegs.length < 2) continue

    const rawPath = code.slice(c.start, dataEnd).trim()
    if (!rawPath.startsWith('context')) continue

    const templatePath = rawPath.replace(/\?\./g, '.')
    const templateValue = `\${${templatePath}}`

    // Check if an existing dynamic variable already maps to this path
    let varName = Object.keys(vars).find(
      (k) => vars[k] === templateValue || vars[k] === templatePath || vars[k] === rawPath,
    )

    if (!varName) {
      varName = pickVarName(dataSegs, usedKeys, code)
      vars[varName] = templateValue
      usedKeys.add(varName)
      extractedCount++
    }

    replacements.push({ start: c.start, end: dataEnd, varName })
  }

  if (!replacements.length) {
    return { code, dynamicVariables: vars, extractedCount }
  }

  // Sort descending by start offset to replace from right to left without shifting earlier offsets
  replacements.sort((a, b) => b.start - a.start)

  let cleanCode = code
  let lastStart = Infinity

  for (const rep of replacements) {
    // Skip if overlaps with an already processed replacement
    if (rep.end > lastStart) continue
    cleanCode = cleanCode.slice(0, rep.start) + rep.varName + cleanCode.slice(rep.end)
    lastStart = rep.start
  }

  return {
    code: cleanCode,
    dynamicVariables: vars,
    extractedCount,
  }
}
