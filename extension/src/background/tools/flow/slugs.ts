// Names that become JavaScript identifiers in the generated flow code: step slugs and dynamic-variable names.
// The editor's rules are stricter than the server's, so the editor's are used: 4-50 characters, letters, digits and
// underscores, starting with a letter, and not a reserved word compared case-insensitively (JavaScript keywords
// plus names the runtime itself defines: break, context, response, date, console, null, true, false).

import { isValidStepSlug, toStepSlug } from '../ids'

const RESERVED = new Set(
  [
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
    'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
    'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'async', 'context', 'response', 'date',
    'console', 'undefined', 'nan', 'infinity', 'arguments', 'eval',
  ].map((w) => w.toLowerCase()),
)

export function isReservedName(name: string): boolean {
  return RESERVED.has(name.toLowerCase())
}

/** A valid step slug made from a free title (spaces become underscores; reserved words get a suffix). */
export function stepSlug(title: string): string {
  let s = toStepSlug(title)
  if (isReservedName(s)) s = `${s}_step`.slice(0, 50)
  return s
}

export function isValidSlug(s: string): boolean {
  return isValidStepSlug(s) && !isReservedName(s)
}

/** Dynamic variables become `let <name>` inside the step code. */
export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_$][\w$]{0,63}$/.test(name) && !isReservedName(name)
}

/** Problems with dynamic variables (named constants of code and API steps); null removes a name on update. */
export function dynamicVariableProblems(vars: Record<string, unknown> | undefined): string[] {
  const problems: string[] = []
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (!isValidVariableName(k)) problems.push(`dynamicVariables: "${k}" is not a usable name (letters, digits, _ or $, not starting with a digit, not a reserved word).`)
    if (v === null) continue
    if (typeof v !== 'string') problems.push(`dynamicVariables.${k} must be a string (or null to remove it).`)
    else if (v.length > 2000) problems.push(`dynamicVariables.${k} is longer than 2000 characters.`)
    else if (v.includes('`')) problems.push(`dynamicVariables.${k}: backticks are not allowed.`)
  }
  return problems
}
