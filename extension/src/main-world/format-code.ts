// Formatting for the Beautify button on viaSocket's code editors. It runs in the page hook, next to the editor whose
// text it formats, so the code itself never travels over postMessage.
//
// Only whitespace may change. JSON that parses strictly is re-indented by a printer that copies every token verbatim
// (JSON.parse + stringify would round big numbers and drop duplicate keys). Everything else - JS steps, Developer Hub
// code, JSON bodies that hold variable references - goes through js-beautify, whose output is only accepted when it
// has the same tokens and keeps every line break JavaScript gives a meaning to (after return, throw, break, continue,
// yield and async; before postfix ++/-- and =>). The result is returned as whitespace edits so the editor can apply
// it like any other edit: one undo step, with the cursor staying next to the same code.

/*! js-beautify 1.15.4 (JavaScript beautifier only) | Copyright (c) 2007-2018 Einar Lielmanis, Liam Newman, and contributors | MIT License | https://github.com/beautifier/js-beautify */

import jsBeautify from 'js-beautify/js/src/javascript/index.js'
import { Options } from 'js-beautify/js/src/javascript/options.js'
import { Tokenizer } from 'js-beautify/js/src/javascript/tokenizer.js'

export type CodeLanguage = 'javascript' | 'json'

/** Replace [start, end) of the original text, which is all whitespace, with `text` (also all whitespace) */
export interface WhitespaceEdit {
  start: number
  end: number
  text: string
}

export type FormatResult =
  /** Empty when the code is already formatted */
  | { kind: 'edits'; edits: WhitespaceEdit[] }
  /** Formatting would have changed more than whitespace, or how the code runs */
  | { kind: 'unsafe' }
  | { kind: 'too-large' }

const MAX_CHARS = 500_000
const JSON_WS = new Set([' ', '\t', '\n', '\r'])
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`)
/** A line break after these ends the statement (or, after async, keeps it a plain identifier) */
const BREAK_AFTER_MATTERS = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async'])
/** A line break before these changes what they apply to, or is not allowed */
const BREAK_BEFORE_MATTERS = new Set(['++', '--', '=>'])

/** The Monaco language ids the button formats */
export function codeLanguage(languageId: string): CodeLanguage | null {
  if (languageId === 'javascript') return 'javascript'
  if (languageId === 'json') return 'json'
  return null
}

export function formatCode(text: string, language: CodeLanguage): FormatResult {
  if (text.length > MAX_CHARS) return { kind: 'too-large' }
  if (!text.trim()) return { kind: 'edits', edits: [] }
  const indent = guessIndent(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let formatted = language === 'json' && isStrictJson(text) ? prettyJson(text, indent, eol) : beautifyJs(text, indent, eol)
  if (formatted === null) return { kind: 'unsafe' }
  if (/[\r\n]$/.test(text)) formatted += eol
  const edits = whitespaceEdits(text, formatted)
  return edits ? { kind: 'edits', edits } : { kind: 'unsafe' }
}

/**
 * Keeps the indentation the code already uses (tabs, or steps of 4 spaces) and otherwise uses 2 spaces, viaSocket's
 * own style. Monaco's detected tab size is no guide: the app loads code into an existing model, so it stays at 4.
 */
export function guessIndent(text: string): string {
  let tabLines = 0
  let spaceLines = 0
  let twos = 0
  let fours = 0
  let prev = 0
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue
    const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
    if (lead.startsWith('\t')) {
      tabLines++
      continue
    }
    if (lead.length) spaceLines++
    const step = lead.length - prev
    if (step === 2) twos++
    else if (step === 4) fours++
    prev = lead.length
  }
  if (tabLines > spaceLines) return '\t'
  return fours > twos ? '    ' : '  '
}

function isStrictJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** JSON.stringify(value, null, indent) layout for text that is already valid JSON, every token copied as written */
function prettyJson(src: string, indent: string, eol: string): string {
  let out = ''
  let depth = 0
  const newline = (): string => eol + indent.repeat(depth)
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j
    } else if (ch === '{' || ch === '[') {
      let j = i + 1
      while (j < src.length && JSON_WS.has(src[j]!)) j++
      if (src[j] === (ch === '{' ? '}' : ']')) {
        out += ch + src[j]
        i = j
      } else {
        depth++
        out += ch + newline()
      }
    } else if (ch === '}' || ch === ']') {
      depth--
      out += newline() + ch
    } else if (ch === ',') {
      out += ',' + newline()
    } else if (ch === ':') {
      out += ': '
    } else if (!JSON_WS.has(ch)) {
      out += ch
    }
  }
  return out
}

function beautifyJs(src: string, indent: string, eol: string): string | null {
  const options = {
    indent_size: indent === '\t' ? 1 : indent.length,
    indent_char: indent === '\t' ? '\t' : ' ',
    indent_with_tabs: indent === '\t',
    eol,
    end_with_newline: false,
    preserve_newlines: true,
    max_preserve_newlines: 2,
    brace_style: 'collapse',
    wrap_line_length: 0,
    unescape_strings: false,
    e4x: false,
    templating: ['none'],
  }
  try {
    const out = jsBeautify(src, options)
    return sameProgram(src, out, new Options(options)) ? out : null
  } catch {
    // js-beautify can throw on badly broken code (e.g. an unmatched closing bracket)
    return null
  }
}

interface CodeToken {
  type: string
  text: string
  /** The comments in front of this token, whitespace removed (a block comment's lines get re-indented) */
  comments: string
  breakBefore: boolean
}

function codeTokens(src: string, options: Options): CodeToken[] {
  const stream = new Tokenizer(src, options).tokenize()
  const out: CodeToken[] = []
  while (stream.hasNext()) {
    const t = stream.next()
    let breakBefore = t.newlines > 0
    let comments = ''
    const before = t.comments_before
    if (before) {
      before.restart()
      while (before.hasNext()) {
        const c = before.next()
        // A line comment always ends in a line break; a block comment counts as one when it spans lines.
        if (c.newlines > 0 || c.type === 'TK_COMMENT' || LINE_BREAK.test(c.text)) breakBefore = true
        comments += c.text.replace(/\s+/g, '') + ' '
      }
    }
    out.push({ type: t.type, text: t.text, comments, breakBefore })
  }
  return out
}

/** Same tokens and comments, and the same line breaks wherever JavaScript's automatic semicolons depend on them */
function sameProgram(before: string, after: string, options: Options): boolean {
  const a = codeTokens(before, options)
  const b = codeTokens(after, options)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.type !== y.type || x.text !== y.text || x.comments !== y.comments) return false
    const matters = BREAK_BEFORE_MATTERS.has(x.text) || (i > 0 && BREAK_AFTER_MATTERS.has(a[i - 1]!.text))
    if (matters && x.breakBefore !== y.breakBefore) return false
  }
  return true
}

/**
 * The whitespace runs that differ between two texts with the same non-whitespace characters, as edits on the first.
 * Null when anything but whitespace differs.
 */
export function whitespaceEdits(before: string, after: string): WhitespaceEdit[] | null {
  const edits: WhitespaceEdit[] = []
  let i = 0
  let j = 0
  for (;;) {
    const i0 = i
    const j0 = j
    while (i < before.length && /\s/.test(before[i]!)) i++
    while (j < after.length && /\s/.test(after[j]!)) j++
    const was = before.slice(i0, i)
    const now = after.slice(j0, j)
    if (was !== now) edits.push({ start: i0, end: i, text: now })
    if (i >= before.length || j >= after.length) return i >= before.length && j >= after.length ? edits : null
    if (before[i] !== after[j]) return null
    i++
    j++
  }
}
