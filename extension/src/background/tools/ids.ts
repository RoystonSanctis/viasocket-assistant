// viaSocket identifiers have load-bearing lengths: flow ids are 'scri' + 8 and step ids are 'func' + 8,
// exactly 12 alphanumerics. Shorter ids are accepted on create but can never be read back.

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomChars(n: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/** New flow id. Email-trigger flows need an all-lowercase id (the address is <scriptId>@sokt.io). */
export function newScriptId(lowercase = false): string {
  return 'scri' + randomChars(8, lowercase ? LOWER_ALNUM : ALNUM)
}

export function newStepId(): string {
  return 'func' + randomChars(8, ALNUM)
}

export const SCRIPT_ID_RE = /^[A-Za-z0-9]{12}$/
export const STEP_ID_RE = /^[A-Za-z0-9]{12}$/

/** The editor's ReservedKeywords (socket-flow-UI enums.ts, compared lower-cased) plus names the runtime defines. */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'async',
  'boolean', 'byte', 'char', 'double', 'final', 'float', 'goto', 'int', 'long', 'native', 'short', 'synchronized',
  'throws', 'transient', 'volatile', 'context', 'response', 'date', 'console', 'undefined', 'nan', 'infinity',
  'arguments', 'eval',
])

export function isReservedName(name: string): boolean {
  return RESERVED.has(name.toLowerCase())
}

/**
 * Step titles become JS function names in the generated flow code, so they must be valid identifiers.
 * Mirrors the UI rules: letters/digits/underscore, no leading underscore, 4–50 chars, not reserved.
 */
export function toStepSlug(input: string): string {
  let s = input.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!s || /^[0-9]/.test(s)) s = `Step_${s}`
  if (s.length < 4) s = `${s}_step`
  s = s.slice(0, 50)
  if (isReservedName(s)) s = `${s}_step`
  return s
}

export function isValidStepSlug(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{3,49}$/.test(s) && !isReservedName(s)
}
