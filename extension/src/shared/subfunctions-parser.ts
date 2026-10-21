// Finds and edits subfunction calls, `<name>({ inputData: { ... } })`, in the code of a JS step.
//
// Edits are surgical: only the inputData object literal (and, on a rename, the function name) is rewritten, so
// whatever surrounds a call (const/let, await, .then, comments, other keys next to inputData) stays as written.
// Strings, template literals and comments are skipped while scanning; regex literals are not recognised.

import { isReservedName } from '../background/tools/flow/slugs'
import { SUBFUNCTION_NAME_RE } from './subfunctions'

/** Globals of the step sandbox; a subfunction declared with one of these names would shadow it */
const SANDBOX_GLOBALS = new Set([
  '_', 'moment', 'axios', 'fetch', 'FormData', 'https', 'crypto', 'Buffer', 'jwt', 'cheerio', 'URLSearchParams',
  'atob', 'XMLParser', 'XMLBuilder', 'XMLValidator', 'setTimeout', 'usaProxy', 'createCustomConsole',
  '__createCustomAxios', '__stepId', '__interventionConfig',
])

export function isSubfunctionName(name: string): boolean {
  return SUBFUNCTION_NAME_RE.test(name) && !isReservedName(name) && !SANDBOX_GLOBALS.has(name)
}

export interface SubfunctionCall {
  name: string
  /** Index of the function name */
  nameStart: number
  /** The inputData object literal, braces included: code.slice(inputStart, inputEnd) */
  inputStart: number
  inputEnd: number
  /** Top-level keys of inputData and their raw JS expressions; null when the object uses spreads or computed keys */
  fields: Record<string, string> | null
}

// ---------- scanning ----------

/** Index just past the string, template literal or comment starting at i; i itself when none starts there. */
function skipNonCode(code: string, i: number): number {
  const c = code[i]
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < code.length; j++) {
      if (code[j] === '\\') j++
      else if (code[j] === c || code[j] === '\n') return j + 1
    }
    return code.length
  }
  if (c === '`') {
    let j = i + 1
    while (j < code.length) {
      const d = code[j]
      if (d === '\\') j += 2
      else if (d === '`') return j + 1
      else if (d === '$' && code[j + 1] === '{') {
        const end = matchBracket(code, j + 1)
        j = end === -1 ? code.length : end
      } else j++
    }
    return code.length
  }
  if (c === '/' && code[i + 1] === '/') {
    const n = code.indexOf('\n', i)
    return n === -1 ? code.length : n
  }
  if (c === '/' && code[i + 1] === '*') {
    const n = code.indexOf('*/', i + 2)
    return n === -1 ? code.length : n + 2
  }
  return i
}

/** `open` is the index of '{', '[' or '('; returns the index just past its matching bracket, or -1. */
function matchBracket(code: string, open: number): number {
  let depth = 0
  let i = open
  while (i < code.length) {
    const skip = skipNonCode(code, i)
    if (skip !== i) {
      i = skip
      continue
    }
    const ch = code[i]
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
    i++
  }
  return -1
}

/** Calls fn(index, depth) for every character of real code (outside strings, templates and comments). */
function walkCode(code: string, fn: (i: number, depth: number) => void): void {
  let depth = 0
  let i = 0
  while (i < code.length) {
    const skip = skipNonCode(code, i)
    if (skip !== i) {
      i = skip
      continue
    }
    const ch = code[i]
    if (ch === '}' || ch === ']' || ch === ')') depth--
    fn(i, depth)
    if (ch === '{' || ch === '[' || ch === '(') depth++
    i++
  }
}

function isCodeAt(code: string, index: number): boolean {
  let inCode = false
  walkCode(code, (i) => {
    if (i === index) inCode = true
  })
  return inCode
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Occurrences of an identifier in real code (not part of a longer name, not a property access). */
function identifierAt(code: string, name: string, followedBy = ''): number[] {
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])${followedBy}`, 'g')
  const hits: number[] = []
  for (let m = re.exec(code); m; m = re.exec(code)) hits.push(m.index)
  return hits.filter((i) => isCodeAt(code, i))
}

// ---------- reading calls ----------

/** Top-level `key: value` pairs of the object literal code.slice(start, end), values as raw expressions. */
function objectFields(code: string, start: number, end: number): Record<string, string> | null {
  const fields: Record<string, string> = {}
  let i = start + 1
  const stop = end - 1
  const skipSpace = () => {
    for (;;) {
      while (i < stop && /\s/.test(code[i] ?? '')) i++
      const skip = i < stop && code[i] === '/' ? skipNonCode(code, i) : i
      if (skip === i) return
      i = skip
    }
  }
  while (i < stop) {
    skipSpace()
    if (i >= stop) break
    const keyStart = i
    let key: string
    const c = code[i]
    if (c === '"' || c === "'") {
      const close = skipNonCode(code, i)
      try {
        key = c === '"' ? JSON.parse(code.slice(i, close)) : code.slice(i + 1, close - 1).replace(/\\(.)/g, '$1')
      } catch {
        return null
      }
      i = close
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, stop))
      if (!m) return null // spread, computed key, or something this form cannot show
      key = m[0]
      i += key.length
    }
    skipSpace()
    if (code[i] === ',' || i >= stop) {
      fields[key] = key // shorthand { email }
      i++
      continue
    }
    if (code[i] !== ':') return null // method or getter
    i++
    skipSpace()
    const valueStart = i
    while (i < stop) {
      const skip = skipNonCode(code, i)
      if (skip !== i) {
        i = skip
        continue
      }
      const ch = code[i]
      if (ch === '{' || ch === '[' || ch === '(') {
        const close = matchBracket(code, i)
        if (close === -1) return null
        i = close
        continue
      }
      if (ch === ',') break
      i++
    }
    // A value spanning lines is kept relative to its key's indentation, so writing it back is stable.
    let value = code.slice(valueStart, i).trim()
    if (value.includes('\n')) {
      const indent = lineIndent(code, keyStart)
      if (indent) value = value.split('\n').map((line, n) => (n > 0 && line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n')
    }
    fields[key] = value
    i++
  }
  return fields
}

/** Top-level entries of an object literal value (`{ a: 1, "b c": x }`), or null when it is not one plain literal. */
export function parseObjectEntries(raw: string): Record<string, string> | null {
  const v = raw.trim()
  if (!v.startsWith('{') || matchBracket(v, 0) !== v.length) return null
  return objectFields(v, 0, v.length)
}

/** Items of an array literal value (`[1, "a", x]`) as raw expressions, or null when it is not one plain literal. */
export function parseArrayItems(raw: string): string[] | null {
  const v = raw.trim()
  if (!v.startsWith('[') || matchBracket(v, 0) !== v.length) return null
  const items: string[] = []
  let i = 1
  let start = 1
  const stop = v.length - 1
  while (i < stop) {
    const skip = skipNonCode(v, i)
    if (skip !== i) {
      i = skip
      continue
    }
    const ch = v[i]
    if (ch === '{' || ch === '[' || ch === '(') {
      const close = matchBracket(v, i)
      if (close === -1) return null
      i = close
      continue
    }
    if (ch === ',') {
      items.push(v.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  const last = v.slice(start, stop).trim()
  if (last) items.push(last)
  return items.filter((x) => x !== '')
}

/** Calls of the given subfunctions whose first argument is an object literal with an inputData object. */
export function findSubfunctionCalls(code: string, names: string[]): SubfunctionCall[] {
  if (names.length === 0) return []
  const alternation = names.filter(isSubfunctionName).map(escapeRegExp).join('|')
  if (!alternation) return []
  const re = new RegExp(`(?<![\\w$.])(${alternation})\\s*\\(\\s*\\{\\s*inputData\\s*:\\s*\\{`, 'g')
  const calls: SubfunctionCall[] = []
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const name = m[1] ?? ''
    if (!isCodeAt(code, m.index)) continue
    const inputStart = m.index + m[0].length - 1
    const inputEnd = matchBracket(code, inputStart)
    if (inputEnd === -1) continue
    calls.push({ name, nameStart: m.index, inputStart, inputEnd, fields: objectFields(code, inputStart, inputEnd) })
  }
  return calls
}

/**
 * True when the code declares `name` itself (const/let/var/function/class). Subfunctions are declared outside the
 * block the code runs in, so such a declaration would shadow the subfunction and the calls would reach it instead.
 */
export function declaresName(code: string, name: string): boolean {
  const re = new RegExp(`(?<![\\w$.])(?:const|let|var|function\\*?|class)\\s+${escapeRegExp(name)}(?![\\w$])`, 'g')
  for (let m = re.exec(code); m; m = re.exec(code)) if (isCodeAt(code, m.index)) return true
  return false
}

/** How many times the code calls `name(` at all, with or without an inputData literal. */
export function countCalls(code: string, name: string): number {
  return identifierAt(code, name, '\\s*\\(').length
}

// ---------- writing calls ----------

function lineIndent(code: string, index: number): string {
  const lineStart = code.lastIndexOf('\n', index - 1) + 1
  return /^[ \t]*/.exec(code.slice(lineStart))?.[0] ?? ''
}

/** An object literal of inputData fields; keys that are not identifiers are quoted. */
export function formatInputData(fields: Record<string, string>, indent: string): string {
  const entries = Object.entries(fields).filter(([, v]) => v.trim() !== '')
  if (entries.length === 0) return '{}'
  const lines = entries.map(([k, v]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)
    return `${indent}  ${key}: ${v.replace(/\n/g, `\n${indent}  `)}`
  })
  return `{\n${lines.join(',\n')}\n${indent}}`
}

/** New inputData for one call. Renaming is separate (renameSubfunction) because every call must follow. */
export function replaceCallInput(code: string, call: SubfunctionCall, fields: Record<string, string>): string {
  const indent = lineIndent(code, call.inputStart)
  return code.slice(0, call.inputStart) + formatInputData(fields, indent) + code.slice(call.inputEnd)
}

/** Renames every call of a subfunction (`old(` to `next(`) in real code. */
export function renameSubfunction(code: string, oldName: string, next: string): string {
  let out = code
  for (const i of identifierAt(code, oldName, '\\s*\\(').reverse()) {
    out = out.slice(0, i) + next + out.slice(i + oldName.length)
  }
  return out
}

/**
 * Removes the calls of a subfunction that are whole statements of their own lines (`await name({...});` or
 * `const x = await name({...});` whose x is used nowhere else), as the panel writes them. Calls used inside other
 * code stay, and `remaining` counts them: the step would break if the subfunction went while they are there.
 */
export function removeCallStatements(code: string, name: string): { code: string; removed: number; remaining: number } {
  let out = code
  let removed = 0
  for (const at of identifierAt(code, name, '\\s*\\(').reverse()) {
    const lineStart = out.lastIndexOf('\n', at - 1) + 1
    const lead = /^\s*(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?(?:await\s+)?$/.exec(out.slice(lineStart, at))
    if (!lead) continue
    const open = out.indexOf('(', at)
    const close = matchBracket(out, open)
    if (close === -1) continue
    const rest = /^[ \t]*;?[ \t]*(?:\r?\n|$)/.exec(out.slice(close))
    if (!rest) continue
    const next = out.slice(0, lineStart) + out.slice(close + rest[0].length)
    if (lead[1] && identifierAt(next, lead[1]).length > 0) continue
    out = next
    removed++
  }
  if (removed) out = out.replace(/\n{3,}/g, '\n\n')
  return { code: out, removed, remaining: countCalls(out, name) }
}

/** A `<base>Result` variable name the code does not use yet. */
export function freeVarName(code: string, base: string): string {
  let name = `${base}Result`
  for (let n = 2; identifierAt(code, name).length > 0; n++) name = `${base}Result${n}`
  return name
}

/**
 * Index of the first `return` that is a top-level statement of the step code (not inside a block, and not the body
 * of a brace-less `if (...)`, `else` or `do`), or -1. Code after it never runs.
 */
function firstTopLevelReturn(code: string): number {
  let found = -1
  let prev = ''
  let prevWord = ''
  let word = ''
  walkCode(code, (i, depth) => {
    if (found !== -1) return
    const ch = code[i] ?? ''
    if (depth === 0 && ch === 'r' && !word && /^return(?![\w$])/.test(code.slice(i, i + 7))) {
      const afterWord = /[\w$]/.test(prev)
      if (prev !== ')' && prev !== '.' && !(afterWord && (prevWord === 'else' || prevWord === 'do'))) found = i
    }
    if (/[\w$]/.test(ch)) word += ch
    else {
      if (word) prevWord = word
      word = ''
    }
    if (!/\s/.test(ch)) prev = ch
  })
  return found
}

/** True when the code has a `return` statement anywhere (outside strings and comments). */
function hasReturn(code: string): boolean {
  return identifierAt(code, 'return').length > 0
}

/**
 * Adds `const <var> = await <name>({ inputData });` to the code: right before the first top-level `return` (code
 * after it never runs), otherwise at the end, plus `return <var>` when the code returns nothing at all (a step's
 * output is what it returns).
 */
export function insertSubfunctionCall(code: string, name: string, fields: Record<string, string>): string {
  const trimmed = code.replace(/\s+$/, '')
  const varName = freeVarName(trimmed, name)
  const statement = (indent: string) =>
    `${indent}const ${varName} = await ${name}({\n${indent}  inputData: ${formatInputData(fields, `${indent}  `)}\n${indent}});`
  const at = firstTopLevelReturn(trimmed)
  if (at !== -1) {
    const lineStart = trimmed.lastIndexOf('\n', at - 1) + 1
    const indent = lineIndent(trimmed, at)
    if (trimmed.slice(lineStart, at).trim() === '') {
      return `${trimmed.slice(0, lineStart)}${statement(indent)}\n\n${trimmed.slice(lineStart)}\n`
    }
    return `${trimmed.slice(0, at).trimEnd()}\n${statement(indent)}\n${indent}${trimmed.slice(at)}\n`
  }
  const prefix = trimmed ? `${trimmed}\n\n` : ''
  return `${prefix}${statement('')}\n${hasReturn(trimmed) ? '' : `return ${varName};\n`}`
}

// ---------- values ----------

/** The value of a string literal that spans all of `v`, or null when `v` is not exactly one plain literal. */
function decodeLiteral(v: string): string | null {
  const q = v[0]
  if (v.length < 2 || (q !== '"' && q !== "'" && q !== '`') || v[v.length - 1] !== q || skipNonCode(v, 0) !== v.length) return null
  const inner = v.slice(1, -1)
  try {
    if (q === '"') return JSON.parse(v) as string
    if (q === "'") return JSON.parse(`"${inner.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string
  } catch {
    return null
  }
  // Template literal: only \` and \\ escapes can be shown faithfully; anything else stays code.
  if (/\\(?![`\\])/.test(inner)) return null
  return inner.replace(/\\([`\\])/g, '$1')
}

/** The text a form shows for a raw value; `expression` when it is code rather than a plain literal. */
export function displayValue(raw: string): { text: string; expression: boolean } {
  const v = raw.trim()
  const literal = decodeLiteral(v)
  if (literal !== null) return { text: literal, expression: false }
  if (/^(true|false|-?\d+(\.\d+)?)$/.test(v)) return { text: v, expression: false }
  return { text: v, expression: true }
}

/** Spans of `${...}` placeholders in form text, matched by brackets so `${fn({a: 1})}` stays whole. */
function placeholderSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (let i = text.indexOf('${'); i !== -1; ) {
    const end = matchBracket(text, i + 1)
    if (end === -1) break
    spans.push([i, end])
    i = text.indexOf('${', end)
  }
  return spans
}

function escapeTemplateText(t: string): string {
  return t.replace(/[\\`]/g, '\\$&').replace(/\$(?=\{)/g, '\\$')
}

/** A JS template literal for text holding ${...} placeholders, with the literal parts escaped. */
function templateLiteral(text: string, spans: Array<[number, number]>): string {
  let out = ''
  let last = 0
  for (const [start, end] of spans) {
    out += escapeTemplateText(text.slice(last, start)) + text.slice(start, end)
    last = end
  }
  return `\`${out}${escapeTemplateText(text.slice(last))}\``
}

/** A string expression for form text: a template literal when it maps data, else a JSON string. */
function textValue(t: string): string {
  const spans = placeholderSpans(t)
  return spans.length ? templateLiteral(t, spans) : JSON.stringify(t)
}

/** Splits at commas outside ${...} placeholders. */
function splitList(t: string): string[] {
  const spans = placeholderSpans(t)
  const parts: string[] = []
  let last = 0
  for (let i = 0; i < t.length; i++) {
    const span = spans.find(([s, e]) => i >= s && i < e)
    if (span) {
      i = span[1] - 1
      continue
    }
    if (t[i] === ',') {
      parts.push(t.slice(last, i))
      last = i + 1
    }
  }
  parts.push(t.slice(last))
  return parts.map((p) => p.trim()).filter(Boolean)
}

export type ValueKind = 'string' | 'number' | 'boolean' | 'list' | 'json'

/** The expression of text that is exactly one `${expr}` placeholder, else null. */
export function singleMapping(text: string): string | null {
  const t = text.trim()
  const spans = placeholderSpans(t)
  return spans.length === 1 && spans[0]?.[0] === 0 && spans[0][1] === t.length ? t.slice(2, -1).trim() : null
}

/**
 * The JS expression for a form value, or '' to leave the field out. A value that is exactly one `${expr}` keeps
 * expr's own type for non-text fields (a mapped number stays a number); text with placeholders becomes a template.
 */
export function jsValue(text: string, kind: ValueKind): string {
  const t = text.trim()
  if (!t) return ''
  const mapped = singleMapping(t)
  if (mapped !== null && kind !== 'string') return mapped
  switch (kind) {
    case 'boolean':
      return t === 'true' || t === 'false' ? t : textValue(t)
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(t) ? t : textValue(t)
    case 'list':
      return `[${splitList(t).map(textValue).join(', ')}]`
    case 'json':
      try {
        return JSON.stringify(JSON.parse(t))
      } catch {
        return textValue(t)
      }
    default:
      return textValue(t)
  }
}

// ---------- names ----------

/** A camelCase function name for an action ("Send Message (Beta)" -> sendMessage), unique among `taken`. */
export function subfunctionNameFor(actionName: string, taken: string[]): string {
  const words = actionName.replace(/\(beta\)/gi, '').match(/[A-Za-z0-9]+/g) ?? []
  let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
  if (!base || /^[0-9]/.test(base)) base = `action${base.charAt(0).toUpperCase()}${base.slice(1)}`
  base = base.slice(0, 50)
  if (!isSubfunctionName(base)) base = `${base}Action`
  const used = new Set(taken.map((n) => n.toLowerCase()))
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}${n}`
  return name
}
