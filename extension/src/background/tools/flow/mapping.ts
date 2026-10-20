// "Never guess" for data mappings, enforced in code before anything is saved.
//
// - Template fields (app step fields, API url/headers/query/form values, dynamic variables) are JS template
//   literals: only `${...}` parts are filled in at run time. Anything else that looks like data is sent literally,
//   so it is refused with the right form: a typed path ("body.output.id", "Step.id", the trigger's chip label
//   "New_Comment.comment_id") or another tool's placeholder ({{body.id}}, {id}, <<id>>, $json.id, $.id).
// - Every reference to context.req.body, context.res.<slug> or context.vals.<slug>, in templates and in code
//   (function code, expressions, JSON bodies), must exist in the sample catalogue for that position: the trigger and
//   the steps that run before it. Paths are read as JavaScript reads them: object keys must exist, lists take an
//   index (or length / their own methods), text and numbers only their own members. A source without a real sample
//   has to be tested first. A step's documented example is accepted only after the user declined its test and the
//   caller says so (allowDocumentedSample); the trigger's never (its test only reads).
// - In code, data is read from context: a bare `body.x`, `trigger.x` or `Step_Slug.x` that the code does not declare
//   itself fails at run time and is refused.
// - Trigger fields take fixed values or dropdown picks only (the editor offers no variables there).

import type { Catalogue, SampleSource, Seg } from './samples'
import { allPaths, documentedAllowed, hasCutValue, insertText, pathText, walkSample } from './samples'
import type { JsonScript } from './types'
import { isRecord, truncate } from './util'

export type MapMode = 'template' | 'code'

export interface MapText {
  where: string
  text: string
  mode: MapMode
  /** The user typed this text literally (customInput): placeholders and dotted words in it are meant as text */
  literalOk?: boolean
  /**
   * Code that falls back to plain text when it does not evaluate (a dynamic variable's value): only real
   * context.* references are checked, a bare word such as "trigger.fired" stays text.
   */
  contextOnly?: boolean
}

export interface Chain {
  /** Segments after the head; null = computed (cannot be checked) */
  segs: Array<Seg | null>
  raw: string
  /** The last segment is called as a method */
  called: boolean
  start: number
  end: number
}

const MAX_PROBLEMS = 10
const ID_START = /[A-Za-z_$]/
const ID_PART = /[\w$]/
const IDENT_RE = /^[A-Za-z_$][\w$]*$/
const CONTEXT_HEAD = /(?<![\w$.])context\b/g
const COMPUTED =
  'a computed path cannot be checked in a field; paste a plain insert text from vs_get_variables (wrap it in a function step if it needs logic)'

/** Collects the string values of app-step fields (lists and dictionary values included). */
export function inputDataTexts(values: Record<string, unknown> | undefined, prefix = 'inputData', literal: ReadonlySet<string> = new Set()): MapText[] {
  const out: MapText[] = []
  const add = (where: string, v: unknown, depth: number, literalOk: boolean) => {
    if (typeof v === 'string') out.push({ where, text: v, mode: 'template', literalOk: literalOk || undefined })
    else if (Array.isArray(v)) v.forEach((x, i) => add(`${where}[${i}]`, x, depth + 1, literalOk))
    else if (v && typeof v === 'object' && depth < 3) for (const [k, x] of Object.entries(v)) add(`${where}.${k}`, x, depth + 1, literalOk)
  }
  for (const [k, v] of Object.entries(values ?? {})) add(`${prefix}.${k}`, v, 0, literal.has(k))
  return out
}

/**
 * Dynamic variables of code and API steps. Each value runs as `name = <value>` and falls back to the text itself
 * (as a template literal) when that fails: a ${...} in it is filled in, a bare context path is read, other words stay
 * text. So only context references are checked, and template parts like any field template.
 */
export function dynamicVariableTexts(vars: Record<string, unknown> | undefined, prefix = 'dynamicVariables'): MapText[] {
  const out: MapText[] = []
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (typeof v !== 'string' || !v.trim()) continue
    out.push(v.includes('${') ? { where: `${prefix}.${k}`, text: v, mode: 'template', literalOk: true } : { where: `${prefix}.${k}`, text: v, mode: 'code', contextOnly: true })
  }
  return out
}

// ---- Reading JavaScript ----------------------------------------------------------------------------------------

/** Comments replaced with spaces of the exact same length (newlines kept), so character offsets align 1:1 with source. */
export function stripComments(src: string): string {
  let out = ''
  let q: string | null = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? ''
    if (q) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i++
      } else if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      q = c
      out += c
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      if (i < src.length) out += src[i]
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      while (i < stop) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      i--
      continue
    }
    out += c
  }
  return out
}

/** 1 for every character inside a string literal (template-literal text included, its ${...} parts not). */
export function stringMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length)
  const exprDepths: number[] = []
  let depth = 0
  let i = 0
  // Scans template text from i; returns true when a ${ opens (i is then just past it).
  const template = (): boolean => {
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') {
        mask[i] = 1
        if (i + 1 < src.length) mask[i + 1] = 1
        i += 2
        continue
      }
      if (c === '`') {
        i++
        return false
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        return true
      }
      mask[i] = 1
      i++
    }
    return false
  }
  const enterTemplate = () => {
    if (template()) {
      exprDepths.push(depth)
      depth++
    }
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'") {
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) mask[i++] = 1
        mask[i++] = 1
      }
      i++
      continue
    }
    if (c === '`') {
      i++
      enterTemplate()
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (exprDepths.length && depth === exprDepths[exprDepths.length - 1]) {
        exprDepths.pop()
        i++
        enterTemplate()
        continue
      }
    }
    i++
  }
  return mask
}

/** Member chains after each match of `head` (context.res.Step?.["a b"][0].x), outside string literals. */
export function chainsFrom(src: string, head: RegExp, mask: Uint8Array): Chain[] {
  const out: Chain[] = []
  for (const m of src.matchAll(head)) {
    const start = m.index ?? 0
    if (mask[start]) continue
    let i = start + m[0].length
    let end = i
    const segs: Array<Seg | null> = []
    const ws = () => {
      while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++
    }
    for (;;) {
      ws()
      if (src.startsWith('?.[', i) || src[i] === '[') {
        i += src[i] === '[' ? 1 : 3
        ws()
        const q = src[i]
        if (q === '"' || q === "'" || q === '`') {
          const close = src.indexOf(q, i + 1)
          if (close < 0) break
          const key = src.slice(i + 1, close)
          i = close + 1
          ws()
          if (src[i] !== ']' || (q === '`' && key.includes('${'))) {
            segs.push(null)
            break
          }
          i++
          end = i
          segs.push(key)
          continue
        }
        const num = /^\d+/.exec(src.slice(i))
        if (num) {
          i += num[0].length
          ws()
          if (src[i] === ']') {
            i++
            end = i
            segs.push(Number(num[0]))
            continue
          }
        }
        segs.push(null)
        break
      }
      if (src.startsWith('?.', i) || src[i] === '.') {
        if (src.startsWith('?.(', i)) break
        const save = i
        i += src[i] === '.' ? 1 : 2
        ws()
        if (!ID_START.test(src[i] ?? '')) {
          i = save
          break
        }
        let j = i
        while (ID_PART.test(src[j] ?? '')) j++
        segs.push(src.slice(i, j))
        i = j
        end = i
        continue
      }
      break
    }
    ws()
    const called = (src[i] === '(' || src.startsWith('?.(', i)) && typeof segs[segs.length - 1] === 'string'
    out.push({ segs, raw: truncate(src.slice(start, end).replace(/\s+/g, ''), 100), called, start, end })
  }
  return out
}

/** Member chains starting at `context`, with comments and string contents ignored. */
export function chainsInCode(code: string): Chain[] {
  const src = stripComments(code)
  return chainsFrom(src, CONTEXT_HEAD, stringMask(src))
}

/** `(context.req.body).x` or `[context.req.body][0].x`: member access on a wrapped path, which cannot be checked. */
function wrappedAccess(src: string, chains: Chain[], mask: Uint8Array): boolean {
  const MARK = '\u0001'
  let s = src
  for (const c of chains) s = s.slice(0, c.start) + MARK.repeat(c.end - c.start) + s.slice(c.end)
  const stack: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (mask[i]) continue
    const ch = s[i]
    if (ch === '(' || ch === '[') stack.push(i)
    else if ((ch === ')' || ch === ']') && stack.length) {
      const open = stack.pop() ?? 0
      if (!s.slice(open + 1, i).includes(MARK)) continue
      let j = i + 1
      while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n') j++
      if (s[j] === '[' || s.startsWith('?.', j) || (s[j] === '.' && ID_START.test(s[j + 1] ?? ''))) return true
    }
  }
  return false
}

/** Names the code binds itself (const/let/var, destructuring, parameters, catch, classes); lenient by design. */
function declaredNames(src: string): Set<string> {
  const out = new Set<string>()
  const addAll = (list: string | undefined) => {
    for (const m of (list ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0])
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1] ?? '')
  for (const m of src.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*?[}\]])\s*=/g)) addAll(m[1])
  for (const m of src.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) addAll(m[1])
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) addAll(m[1])
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1] ?? '')
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1] ?? '')
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1] ?? '')
  return out
}

/** How often code binds `name` (declarations, destructuring, parameters); an alias is followed only when bound once. */
function bindCount(plain: string, name: string): number {
  const word = new RegExp(String.raw`(?<![\w$])${name.replace(/\$/g, '\\$')}(?![\w$])`)
  let n = 0
  const inList = (list: string | undefined) => (list && word.test(list) ? 1 : 0)
  for (const m of plain.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) if (m[1] === name) n++
  for (const m of plain.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*?[}\]])\s*=/g)) n += inList(m[1])
  for (const m of plain.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) n += inList(m[1])
  for (const m of plain.matchAll(/\(([^()]*)\)\s*=>/g)) n += inList(m[1])
  for (const m of plain.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) if (m[1] === name) n++
  for (const m of plain.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) if (m[1] === name) n++
  return n
}

interface AliasUse {
  segs: Array<Seg | null>
  raw: string
  called: boolean
  /** What the alias stands for, for the message */
  via: string
}

/**
 * Reads through names bound once to a plain context path: `const o = context.req.body` (then o.total is
 * context.req.body.total) and `const { total, id: orderId } = context.req.body` (total and id are read).
 * Anything less simple (computed paths, reassigned or shadowed names) is left alone.
 */
function aliasUses(src: string, chains: Chain[], mask: Uint8Array): AliasUse[] {
  const plain = src.replace(/./gs, (c, i: number) => (mask[i] ? ' ' : c))
  const out: AliasUse[] = []
  for (const c of chains) {
    if (c.called || !c.segs.length || c.segs.some((x) => x === null)) continue
    const after = plain.slice(c.end, c.end + 40)
    if (!/^\s*(?:(?:\|\||\?\?)\s*(?:\{\s*\}|\[\s*\]))?\s*(?:;|,|\n|$)/.test(after)) continue
    const before = plain.slice(Math.max(0, c.start - 300), c.start)
    const segs = c.segs as Seg[]
    const destructure = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*$/.exec(before)
    if (destructure) {
      for (const part of (destructure[1] ?? '').split(',')) {
        const entry = part.trim()
        if (!entry || entry.startsWith('...')) continue
        const key = /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*(?:[:=]|$)/.exec(entry)
        const name = key?.[1] ?? key?.[2]
        if (name) out.push({ segs: [...segs, name], raw: name, called: false, via: `destructured from ${c.raw}` })
      }
      continue
    }
    const simple = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)
    const name = simple?.[1]
    if (!name || name === 'context' || bindCount(plain, name) !== 1) continue
    // Reassigned later: its value is no longer that path.
    if (new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\s*=(?!=)`).test(plain.slice(c.end))) continue
    const head = new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}(?![\w$])`, 'g')
    for (const u of chainsFrom(src, head, mask)) {
      if (!u.segs.length || u.start < c.end) continue
      // An assignment target (o.total = 5) creates the field; it is not read.
      if (/^\s*=(?!=)/.test(plain.slice(u.end, u.end + 4)) && !u.called) continue
      out.push({ segs: [...segs, ...u.segs], raw: u.raw, called: u.called, via: `${name} is ${c.raw}` })
    }
  }
  return out
}

/** Literal text of a template (with `${...}` parts blanked out) and the expressions inside them. */
function templateParts(text: string): { literal: string; exprs: string[] } {
  let literal = ''
  const exprs: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (c === '\\') {
      literal += text.slice(i, i + 2)
      i++
      continue
    }
    if (c === '$' && text[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      let q: string | null = null
      for (; j < text.length && depth > 0; j++) {
        const d = text[j]
        if (q) {
          if (d === '\\') j++
          else if (d === q) q = null
        } else if (d === '"' || d === "'" || d === '`') q = d
        else if (d === '{') depth++
        else if (d === '}') depth--
      }
      exprs.push(text.slice(i + 2, j - 1))
      literal += ' '
      i = j - 1
      continue
    }
    literal += c
  }
  return { literal, exprs }
}

// ---- Names that look like data -------------------------------------------------------------------------------

interface PathNames {
  /** Data step slugs and where their output lives */
  slugs: Map<string, 'res' | 'vals'>
  /** The trigger's action name, which the editor's picker shows as the trigger chip's label */
  actionName?: string
}

const GLOBALS = new Set(['JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'console', 'axios', 'fetch', 'Buffer', 'Intl', 'RegExp', 'Error', 'Symbol', 'Reflect'])
const PROSE_HEADS = ['body', 'query', 'headers', 'output', 'trigger', 'req', 'res', 'vals']
const CODE_HEADS = ['body', 'trigger', 'output', 'req', 'res', 'vals']

function namesOf(js: JsonScript | undefined): PathNames {
  const slugs = new Map<string, 'res' | 'vals'>()
  for (const [k, b] of Object.entries(js?.blocks ?? {})) {
    if (b.status === 'DELETE' || !IDENT_RE.test(k) || GLOBALS.has(k)) continue
    if (b.type === 'variable') slugs.set(k, 'vals')
    else if (b.type === 'plugin' || b.type === 'function' || b.type === 'api') slugs.set(k, 'res')
  }
  const action = typeof js?.trigger?.actionName === 'string' ? js.trigger.actionName : undefined
  return { slugs, actionName: action && IDENT_RE.test(action) && !GLOBALS.has(action) ? action : undefined }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headList(base: string[], names: PathNames): string[] {
  const out = new Set(base)
  for (const s of names.slugs.keys()) out.add(s)
  if (names.actionName) out.add(names.actionName)
  // Longest first, so a slug such as "res_total" is not read as "res".
  return [...out].sort((a, b) => b.length - a.length).map(escapeRe)
}

const SEG_TAIL = String.raw`(?:\??\.[A-Za-z_$][\w$]*|\[\d+\]|\[["'][^"'\]]{1,80}["']\])`
/** Host names (res.example.com) and file names (output.json) look like paths; they are text. */
const TEXT_END = /\.(?:com|net|org|io|co|in|ai|dev|app|uk|us|de|fr|me|info|biz|txt|html?|json|csv|pdf|png|jpe?g|gif|svg|js|ts|md|xml|zip|docx?|xlsx?|pptx?|mp[34]|wav|log)$/i

/** Case-insensitive: "Trigger.comment_id" and "Body.id" are the same mistake. */
function typedPathRe(names: PathNames): RegExp {
  return new RegExp(String.raw`(?<![\w$./@-])(?:context\s*\??\.\s*)?(?:${headList(PROSE_HEADS, names).join('|')})${SEG_TAIL}+`, 'gi')
}

const PLACEHOLDERS: RegExp[] = [
  /\{\{\s*([^{}]{1,120}?)\s*\}\}/g,
  /<<\s*([^<>]{1,120}?)\s*>>/g,
  new RegExp(String.raw`(?<![{$\w])\{\s*([A-Za-z_$][\w$]*${SEG_TAIL}*)\s*\}(?!\})`, 'g'),
  /(?<![\w$])(\$(?:json|node|input|items|binding)\b[^\s'"<>,;)]*)/g,
  /(?<![\w$])(\$\.[^\s'"<>,;)]+)/g,
  new RegExp(String.raw`(?<![\w$])(\$[A-Za-z_][\w]*${SEG_TAIL}+)`, 'g'),
]

interface Finding {
  token: string
  placeholder: boolean
  /** Inner path text (placeholder content, or the typed path itself) */
  path: string
}

/** Data paths typed as text and other tools' placeholders in a template's literal part. */
function plainFindings(literal: string, names: PathNames): Finding[] {
  const found: Finding[] = []
  let rest = literal
  for (const re of PLACEHOLDERS) {
    for (const m of rest.matchAll(re)) found.push({ token: m[0], placeholder: true, path: m[1] ?? '' })
    rest = rest.replace(re, (s) => ' '.repeat(s.length))
  }
  for (const m of rest.matchAll(typedPathRe(names))) {
    const token = m[0]
    if (!/^context\b/.test(token) && TEXT_END.test(token)) continue
    found.push({ token, placeholder: false, path: token })
  }
  return found
}

function segsOf(path: string): Seg[] {
  const head = /^[A-Za-z_$][\w$]*/.exec(path)
  if (!head) return []
  const segs: Seg[] = [head[0]]
  for (const m of path.slice(head[0].length).matchAll(/\??\.\s*([A-Za-z_$][\w$]*)|\[(\d+)\]|\[["']([^"'\]]+)["']\]/g)) {
    if (m[1]) segs.push(m[1])
    else if (m[2]) segs.push(Number(m[2]))
    else if (m[3]) segs.push(m[3])
  }
  return segs
}

/** What a head (body, trigger, a step slug, the trigger chip label ...) plus segments means, after `context`. */
function headToContext(rawHead: string, segs: Seg[], names: PathNames): Seg[] | undefined {
  const lower = rawHead.toLowerCase()
  const head = [...PROSE_HEADS, 'context'].includes(lower) ? lower : rawHead
  if (head === 'context') return segs
  if (head === 'body' || head === 'query' || head === 'headers') return ['req', head, ...segs]
  if (head === 'req' || head === 'res' || head === 'vals') return [head, ...segs]
  if (head === 'output' || head === 'trigger' || head === names.actionName) return ['req', 'body', ...(segs[0] === 'body' ? segs.slice(1) : segs)]
  const ref = names.slugs.get(head)
  if (ref) return [ref, head, ...segs]
  return undefined
}

/** A typed path or placeholder content as segments after `context` (a bare key is read as a trigger field). */
function findingSegs(path: string, names: PathNames): Seg[] | undefined {
  let p = path.replace(/\s+/g, '')
  if (p.startsWith('$')) p = p.slice(1).replace(/^(?:json|node|input|items|binding)\b/, '')
  p = p.replace(/^\??\./, '').replace(/^context\??\./, 'context.')
  const segs = segsOf(p)
  const head = segs[0]
  if (typeof head !== 'string') return undefined
  return headToContext(head, segs.slice(1), names) ?? ['req', 'body', ...segs]
}

// ---- Judging one reference -----------------------------------------------------------------------------------

type Verdict = { ok: true; documented?: string } | { ok: false; why: string; suggest?: string[] }

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length] ?? 9
}

function lastName(segs: ReadonlyArray<Seg | null>): string {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]
    if (typeof s === 'string') return s.toLowerCase()
  }
  return ''
}

export interface CheckOptions {
  allowDocumented: boolean
  /** A single-step test: everything read must have a real value to send, a variable's own value included */
  forTest?: boolean
}

function sourceUsable(src: SampleSource, allowDocumented: boolean): boolean {
  return !!src.origin && (src.origin !== 'documented' || documentedAllowed(src, allowDocumented))
}

/** Up to `max` valid insert texts closest to what was asked for (only those scoring at least minScore). */
export function closestInserts(cat: Catalogue, wanted: ReadonlyArray<Seg | null>, allowDocumented: boolean, max = 8, minScore = -Infinity): string[] {
  const want = lastName(wanted)
  const flat = (s: string) => s.replace(/[_\-\s]/g, '')
  const scored: Array<{ insert: string; score: number }> = []
  for (const src of cat.sources) {
    if (!sourceUsable(src, allowDocumented)) continue
    const head: Seg[] = src.ref === 'req' ? ['req', 'body'] : [src.ref, src.id]
    for (const p of allPaths(src)) {
      if (!p.segs.length) continue
      const full = [...head, ...p.segs]
      const name = lastName(full)
      let score = 0
      if (full[0] === wanted[0]) score += 1
      if (full[1] === wanted[1]) score += 2
      if (name && want) {
        if (name === want) score += 6
        else if (flat(name) === flat(want)) score += 5
        else if (name.includes(want) || want.includes(name)) score += 3
        else if (lev(name, want) <= 2) score += 2
      }
      for (const s of wanted.slice(2)) if (typeof s === 'string' && p.segs.includes(s)) score += 0.5
      score -= Math.abs(full.length - wanted.length) * 0.3
      if (score >= minScore) scored.push({ insert: p.insert, score })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.insert)
}

function triggerNoData(cat: Catalogue): string {
  const k = cat.triggerKind
  const trig = cat.js.trigger
  const shaped = isRecord(trig?.preProcess) || isRecord(trig?.preProcessFilter) || isRecord(trig?.loops)
  const note = cat.byId.get('trigger')?.note
  // Get Data or a loop decides the body of webhook and schedule flows; the trigger source says what is missing.
  if ((k === 'webhook' || k === 'cron') && shaped && note) return note.charAt(0).toLowerCase() + note.slice(1).replace(/\.$/, '')
  if (!k) return 'the flow has no trigger yet; set it first with vs_set_trigger'
  if (k === 'cron') return 'schedule triggers carry no event data, so context.req.body is empty'
  if (k === 'webhook' || k === 'email') {
    return 'the trigger has not received any data yet, so its real fields are unknown. Ask the user to send one real event, then run vs_test_trigger'
  }
  return 'the trigger has not been tested yet, so its real fields are unknown. Test it first with vs_test_trigger, then copy insert texts from vs_get_variables'
}

interface JudgeCtx {
  cat: Catalogue
  o: CheckOptions
  mode: MapMode
  called: boolean
}

function judge(segs: ReadonlyArray<Seg | null>, j: JudgeCtx): Verdict {
  const { cat, mode } = j
  const [root, part, ...rest] = segs
  if (root !== 'req' && root !== 'res' && root !== 'vals') return { ok: true }
  if (part === undefined) return { ok: true }
  if (mode === 'template' && segs.includes(null)) return { ok: false, why: COMPUTED }
  if (part === null) return { ok: true }
  if (root === 'req') {
    if (part === 'body') return judgeSource('trigger', rest, segs, j)
    if ((part === 'query' || part === 'headers') && cat.triggerKind === 'webhook') return judgeRequestPart(part, rest, segs, j)
    if (mode === 'code') return { ok: true }
    return { ok: false, why: 'this trigger delivers its data in context.req.body only', suggest: closestInserts(cat, segs, j.o.allowDocumented) }
  }
  const slug = String(part)
  const src = cat.byId.get(slug)
  if (!src || src.ref !== root) {
    const b = cat.js.blocks[slug]
    const before = cat.sources.filter((s) => s.id !== 'trigger').map((s) => s.id)
    if (!b) return { ok: false, why: `there is no step "${slug}"${before.length ? `. Steps before this one: ${before.join(', ')}` : ''}` }
    if (cat.later.includes(slug)) return { ok: false, why: `"${slug}" runs after this step (or is this step), so its output does not exist yet here` }
    if (b.type === 'variable' && root === 'res') return { ok: false, why: `"${slug}" is a variable: use context.vals.${slug}` }
    if (root === 'vals' && b.type !== 'variable') return { ok: false, why: `"${slug}" is not a variable: use context.res.${slug}` }
    return { ok: false, why: `"${slug}" is a ${b.type} step and has no output to map` }
  }
  // A variable's own value is defined by the flow itself; only paths inside it need a sample (and a test needs its value).
  if (root === 'vals' && !rest.length && !j.o.forTest) return { ok: true }
  return judgeSource(slug, rest, segs, j)
}

function judgeSource(id: string, inner: ReadonlyArray<Seg | null>, segs: ReadonlyArray<Seg | null>, j: JudgeCtx): Verdict {
  const { cat, o } = j
  const src = cat.byId.get(id)
  const name = id === 'trigger' ? 'the trigger' : `"${id}"`
  if (!src?.origin) {
    if (id === 'trigger') return { ok: false, why: triggerNoData(cat) }
    return { ok: false, why: `${name} has not been tested yet, so its real output is unknown. Test it first with vs_test_step, then copy insert texts from vs_get_variables` }
  }
  if (src.origin === 'documented' && !documentedAllowed(src, o.allowDocumented)) {
    if (id === 'trigger') {
      return { ok: false, why: "the trigger has only the app's documented example, not real data. Test it with vs_test_trigger (it only reads, nothing is sent)" }
    }
    if (o.allowDocumented && !src.declined) {
      return { ok: false, why: `${name} has only the app's documented example. allowDocumentedSample applies only after the user declined its test: offer vs_test_step "${id}" first` }
    }
    return { ok: false, why: `${name} has only the app's documented example output, not a real test. Test it first (vs_test_step "${id}"); only if the user declines that test, pass allowDocumentedSample: true` }
  }
  const verdict = judgeData(name, src.base, src.data, inner, segs, j, src.origin === 'documented' ? 'documented example' : 'real sample')
  if (!verdict.ok) return verdict
  if (o.forTest && src.compacted) {
    const w = walkSample(src.data, inner, j.called)
    if (w.ok && w.resolved && hasCutValue(w.value)) {
      return {
        ok: false,
        why: `the saved sample of ${name} was shortened when it was saved, so ${pathText(src.base, inner.filter((s): s is Seg => s !== null))} would be sent cut off. Test ${name} again (vs_test_step "${id}") so the test uses its full output`,
      }
    }
  }
  return { ok: true, documented: src.origin === 'documented' ? id : undefined }
}

function judgeRequestPart(part: 'query' | 'headers', inner: ReadonlyArray<Seg | null>, segs: ReadonlyArray<Seg | null>, j: JudgeCtx): Verdict {
  const src = j.cat.byId.get('trigger')
  if (!src?.origin) return { ok: false, why: triggerNoData(j.cat) }
  const raw = part === 'query' ? src.query : src.headers
  if (!isRecord(raw)) {
    return {
      ok: false,
      why: `the trigger's sample has no request ${part} (it ${src.viaPayload ? 'is a test payload' : 'did not come from a real request'}). Ask the user to send one real request, then run vs_test_trigger`,
    }
  }
  // Node lowercases incoming header names.
  const data = part === 'headers' ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v])) : raw
  const look = part === 'headers' && typeof inner[0] === 'string' ? [inner[0].toLowerCase(), ...inner.slice(1)] : inner
  return judgeData('the latest request', `context.req.${part}`, data, look, segs, j, 'real request')
}

function judgeData(
  name: string,
  base: string,
  data: unknown,
  inner: ReadonlyArray<Seg | null>,
  segs: ReadonlyArray<Seg | null>,
  j: JudgeCtx,
  what: string,
): Verdict {
  const w = walkSample(data, inner, j.called)
  const known = (n: number) => inner.slice(0, n).filter((s): s is Seg => s !== null)
  if (!w.ok) {
    const bad = known(w.at + 1)
    const parent = pathText(base, known(w.at))
    const seg = String(inner[w.at])
    let why: string
    if (w.reason === 'missing') why = `${pathText(base, bad)} does not exist in the ${what} of ${name}`
    else if (w.reason === 'empty') why = `${parent} is empty (null) in the ${what} of ${name}, so the fields inside it are unknown`
    else if (w.kind === 'list') why = `${parent} is a list in the ${what} of ${name}, so it has no "${seg}"${j.called ? ' method' : ''}: read one item by index (for example [0]) first`
    else why = `${parent} is ${w.kind === 'object' ? 'an object' : `a ${w.kind}`} in the ${what} of ${name}, so it has no "${seg}"${j.called ? ' method' : ''}`
    return { ok: false, why, suggest: closestInserts(j.cat, segs, j.o.allowDocumented) }
  }
  if (j.o.forTest && j.mode === 'template' && w.resolved && (w.value === null || w.value === undefined || w.value === '')) {
    return {
      ok: false,
      why: `${pathText(base, known(inner.length))} is empty in the ${what} of ${name}, so the test would send nothing there. Test ${name} again with data in that field, or map another field`,
    }
  }
  return { ok: true }
}

function withSuggestions(v: Extract<Verdict, { ok: false }>, mode: MapMode): string {
  if (!v.suggest?.length) return v.why
  const list = mode === 'code' ? v.suggest.map(asCodePath) : v.suggest
  return `${v.why}. Closest valid: ${list.join(', ')}`
}

/** An insert text as code reads it: ${context.req.body.id} -> context.req.body.id */
function asCodePath(insert: string): string {
  return insert.startsWith('${') && insert.endsWith('}') ? insert.slice(2, -1) : insert
}

/** A guessed path that is right except for a wrapper segment the editor's chip labels show (output, body). */
function repaired(segs: Seg[], j: JudgeCtx): Seg[] | undefined {
  // Segments 0-1 are the source (req.body, res.<slug>, vals.<slug>).
  const base = 2
  for (const wrapper of ['output', 'body', 'data']) {
    if (segs[base] !== wrapper) continue
    const fixed = [...segs.slice(0, base), ...segs.slice(base + 1)]
    if (fixed.length > base && judge(fixed, { ...j, called: false }).ok) return fixed
  }
  return undefined
}

export interface MappingCheck {
  problems: string[]
  /** Sources mapped from their documented example (allowed by allowDocumentedSample after a declined test) */
  documentedUsed: string[]
}

/** Cheap pre-check: does any text possibly reference data (so the catalogue must be built)? */
export function mightReference(texts: MapText[], js: JsonScript | undefined): boolean {
  const names = namesOf(js)
  const heads = new RegExp(String.raw`(?<![\w$./@-])(?:${headList(PROSE_HEADS, names).join('|')})\s*(?:\??\.|\[)`, 'i')
  return texts.some((t) => /context|\$\{|\{\{|<<|\$[.\w]|\{\s*[A-Za-z_$][\w$.[\]"']*\s*\}/.test(t.text) || heads.test(t.text))
}

/** Checks every reference against the catalogue. Problems are written for the model: what is wrong and what to use. */
export function checkMappings(texts: MapText[], cat: Catalogue, o: CheckOptions): MappingCheck {
  const problems: string[] = []
  const documented = new Set<string>()
  const names = namesOf(cat.js)
  const add = (p: string) => {
    if (!problems.includes(p) && problems.length < MAX_PROBLEMS) problems.push(p)
  }
  const fixFor = (segs: Seg[] | undefined, mode: MapMode, wanted: Seg[]): string => {
    const j: JudgeCtx = { cat, o, mode, called: false }
    const verdict = segs ? judge(segs, j) : undefined
    const good = segs && verdict?.ok ? segs : segs ? repaired(segs, j) : undefined
    if (good) return `Write it as ${mode === 'code' ? pathText('context', good) : insertText('context', good)}.`
    const s = closestInserts(cat, segs ?? wanted, o.allowDocumented, 3)
    const shown = mode === 'code' ? s.map(asCodePath) : s
    const reason = verdict && !verdict.ok ? ` Note: ${verdict.why}.` : ''
    return `Use ${mode === 'code' ? 'a path' : 'an insert text'} from vs_get_variables${shown.length ? `, e.g. ${shown.join(', ')}` : ''}.${reason}`
  }
  const checkCode = (where: string, src: string, mode: MapMode, contextOnly = false) => {
    const mask = stringMask(src)
    const chains = chainsFrom(src, CONTEXT_HEAD, mask)
    if (mode === 'template' && wrappedAccess(src, chains, mask)) add(`${where}: \${${truncate(src.trim(), 60)}}: ${COMPUTED}.`)
    // Bare data names the code does not declare itself (body.x, trigger.x, Step_Slug.x) fail at run time.
    const declared = declaredNames(src.replace(/./g, (c, i: number) => (mask[i] ? ' ' : c)))
    const heads = contextOnly ? [] : headList(CODE_HEADS, names).filter((h) => !declared.has(h.replace(/\\/g, '')))
    if (heads.length) {
      const re = new RegExp(String.raw`(?<![\w$.])(?:${heads.join('|')})(?=\s*(?:\??\.|\[))`, 'g')
      for (const c of chainsFrom(src, re, mask)) {
        const head = src.slice(c.start).match(/^[A-Za-z_$][\w$]*/)?.[0] ?? ''
        const known = c.segs.filter((s): s is Seg => s !== null)
        // A trailing method call (body.text.includes(...)) is not part of the data path.
        const path = c.called ? known.slice(0, -1) : known
        if (!path.length) continue
        const segs = headToContext(head, path, names)
        add(`${where}: ${c.raw} is not defined when the flow runs (data is read from context). ${fixFor(segs, mode, [head, ...path])}`)
      }
    }
    for (const c of chains) {
      const v = judge(c.segs, { cat, o, mode, called: c.called })
      if (v.ok) {
        if (v.documented) documented.add(v.documented)
      } else add(`${where}: ${c.raw}: ${withSuggestions(v, mode)}.`)
    }
    // `const o = context.req.body; o.total` and `const { total } = context.req.body` read the same paths.
    if (mode === 'code' && !contextOnly) {
      for (const use of aliasUses(src, chains, mask)) {
        const v = judge(use.segs, { cat, o, mode, called: use.called })
        if (v.ok) {
          if (v.documented) documented.add(v.documented)
        } else add(`${where}: ${use.raw} (${use.via}): ${withSuggestions(v, mode)}.`)
      }
    }
  }
  for (const t of texts) {
    if (t.mode === 'template') {
      const { literal, exprs } = templateParts(t.text)
      if (!t.literalOk) {
        for (const f of plainFindings(literal, names)) {
          const segs = findingSegs(f.path, names)
          const what = f.placeholder
            ? 'is a placeholder from another tool; viaSocket fills in only ${...} insert texts'
            : 'is a data path typed as plain text'
          add(`${t.where}: "${truncate(f.token, 60)}" ${what}, so it would be sent literally. ${fixFor(segs, 'template', segsOf(f.path))}`)
        }
      }
      for (const expr of exprs) checkCode(t.where, stripComments(expr), 'template')
    } else checkCode(t.where, stripComments(t.text), 'code', t.contextOnly === true)
  }
  return { problems, documentedUsed: [...documented] }
}

/** Trigger fields take fixed values or dropdown choices only; any data reference or placeholder there is a mistake. */
export function checkTriggerValues(texts: MapText[], actionName?: string): string[] {
  const out: string[] = []
  const names: PathNames = { slugs: new Map(), actionName: actionName && IDENT_RE.test(actionName) ? actionName : undefined }
  for (const t of texts) {
    const { literal } = templateParts(t.text)
    const plain = t.literalOk ? [] : plainFindings(literal, names)
    if (t.text.includes('${') || /(?<![\w$.])context\s*\??\.\s*(?:req|res|vals)\b/.test(t.text) || plain.length) {
      out.push(`${t.where}: trigger fields take fixed values or dropdown choices only; data references, paths and placeholders are not allowed there.`)
    }
  }
  return out.slice(0, MAX_PROBLEMS)
}

/** References a saved step uses, for checking them against the data a test would send. */
export function referencedTexts(where: string, text: string | undefined, mode: MapMode): MapText[] {
  return typeof text === 'string' && text ? [{ where, text, mode }] : []
}
