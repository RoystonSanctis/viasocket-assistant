// Static review of code before a dry run executes it against the real app (skill §4.2: run only what cannot change
// anything). It is an ALLOWLIST: code counts as read-only only when every network call in it is a recognised form
// with a literal GET (axios.get(…), fetch(url) or fetch(url, {method:'GET'}), axios({method:'get', …}) /
// axios.request({method:'get', …})) and nothing else that can reach the network, a store or generated code appears.
// Anything the review cannot read that way is a reason to ask the user. It never proves code safe; it only decides
// when a confirmation card may be skipped. Nothing here evaluates the code (MV3 has no eval, and it must not).

type Tok =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'tpl'; parts: string[]; exprs: string[] }
  | { t: 'num' }
  | { t: 're' }
  | { t: 'p'; v: string; header?: boolean }

const MAX_CODE_CHARS = 400_000
const MAX_DEPTH = 24
const IDENT_RE = /^[A-Za-z_$][\w$]*$/
const ID_START = /[A-Za-z_$\u0080-￿]/
const ID_PART = /[\w$\u0080-￿]/
const PUNCT4 = ['>>>=']
const PUNCT3 = ['...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=']
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>']
const REGEX_AFTER_IDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'yield', 'await', 'else', 'do'])
const HEADER_IDS = new Set(['if', 'while', 'for', 'with'])
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

class Lexer {
  readonly seqs: Tok[][] = []
  readonly texts: string[] = []
  error: string | undefined
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  /** Lexes from i. With stopAtBrace it stops at the '}' that closes a template expression and returns its index. */
  run(start: number, stopAtBrace: boolean, depth: number): { toks: Tok[]; end: number } {
    const src = this.src
    const toks: Tok[] = []
    const parens: boolean[] = []
    let braces = 0
    let i = start
    while (i < src.length && !this.error) {
      const c = src[i] ?? ''
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') {
        i++
        continue
      }
      if (c === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i)
        const end = nl < 0 ? src.length : nl
        this.texts.push(src.slice(i + 2, end))
        i = end
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) {
          this.error = 'an unterminated comment'
          break
        }
        this.texts.push(src.slice(i + 2, end))
        i = end + 2
        continue
      }
      if (c === "'" || c === '"') {
        const r = this.string(i, c)
        if (!r) break
        toks.push({ t: 'str', v: r.v })
        this.texts.push(r.v)
        i = r.end
        continue
      }
      if (c === '`') {
        const r = this.template(i, depth)
        if (!r) break
        toks.push(r.tok)
        i = r.end
        continue
      }
      if (c === '\\') {
        this.error = 'a backslash escape outside a string (e.g. in a name)'
        break
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
        let j = i + 1
        while (j < src.length && /[0-9A-Za-z_.]/.test(src[j] ?? '')) j++
        toks.push({ t: 'num' })
        i = j
        continue
      }
      if (ID_START.test(c)) {
        let j = i + 1
        while (j < src.length && ID_PART.test(src[j] ?? '')) j++
        toks.push({ t: 'id', v: src.slice(i, j) })
        i = j
        continue
      }
      if (c === '/' && regexAllowed(toks[toks.length - 1])) {
        const end = scanRegex(src, i)
        if (end > 0) {
          this.texts.push(src.slice(i + 1, end))
          toks.push({ t: 're' })
          i = end
          continue
        }
      }
      if (stopAtBrace && c === '}' && braces === 0) return { toks, end: i }
      const p = punct(src, i)
      if (p === '{') braces++
      else if (p === '}') braces = Math.max(0, braces - 1)
      if (p === '(') {
        const prev = toks[toks.length - 1]
        parens.push(prev?.t === 'id' && HEADER_IDS.has(prev.v))
        toks.push({ t: 'p', v: p })
      } else if (p === ')') {
        toks.push({ t: 'p', v: p, header: parens.pop() === true })
      } else {
        toks.push({ t: 'p', v: p })
      }
      i += p.length
    }
    if (stopAtBrace && !this.error) this.error = 'an unterminated template expression'
    return { toks, end: i }
  }

  private string(i: number, q: string): { v: string; end: number } | undefined {
    const src = this.src
    let v = ''
    let j = i + 1
    while (j < src.length) {
      const ch = src[j] ?? ''
      if (ch === q) return { v, end: j + 1 }
      if (ch === '\n' || ch === '\r') break
      if (ch === '\\') {
        const n = src[j + 1]
        if (n === undefined) break
        if (n === '\n') {
          j += 2
          continue
        }
        if (n === '\r') {
          j += src[j + 2] === '\n' ? 3 : 2
          continue
        }
        if (n === 'x') {
          v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16) || 0)
          j += 4
          continue
        }
        if (n === 'u') {
          if (src[j + 2] === '{') {
            const close = src.indexOf('}', j + 3)
            if (close < 0) break
            const cp = parseInt(src.slice(j + 3, close), 16)
            v += Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
            j = close + 1
            continue
          }
          v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16) || 0)
          j += 6
          continue
        }
        v += ESCAPES[n] ?? n
        j += 2
        continue
      }
      v += ch
      j++
    }
    this.error = 'an unterminated string'
    return undefined
  }

  private template(i: number, depth: number): { tok: Tok; end: number } | undefined {
    const src = this.src
    const parts: string[] = ['']
    const exprs: string[] = []
    let j = i + 1
    while (j < src.length) {
      const ch = src[j] ?? ''
      if (ch === '\\') {
        parts[parts.length - 1] += src.slice(j, j + 2)
        j += 2
        continue
      }
      if (ch === '`') {
        this.texts.push(parts.join(' '))
        return { tok: { t: 'tpl', parts, exprs }, end: j + 1 }
      }
      if (ch === '$' && src[j + 1] === '{') {
        if (depth >= MAX_DEPTH) {
          this.error = 'template literals nested too deeply'
          return undefined
        }
        const r = this.run(j + 2, true, depth + 1)
        if (this.error) return undefined
        exprs.push(src.slice(j + 2, r.end))
        this.seqs.push(r.toks)
        parts.push('')
        j = r.end + 1
        continue
      }
      parts[parts.length - 1] += ch
      j++
    }
    this.error = 'an unterminated template literal'
    return undefined
  }
}

function punct(src: string, i: number): string {
  for (const list of [PUNCT4, PUNCT3, PUNCT2]) {
    for (const p of list) {
      if (src.startsWith(p, i)) {
        // "a?.5:b" is a ternary with .5, not optional chaining
        if (p === '?.' && /[0-9]/.test(src[i + 2] ?? '')) return '?'
        return p
      }
    }
  }
  return src[i] ?? ''
}

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true
  if (prev.t === 'id') return REGEX_AFTER_IDS.has(prev.v)
  if (prev.t !== 'p') return false
  if (prev.v === ')') return prev.header === true
  if (prev.v === ']') return false
  return true
}

/** End index of a regex literal starting at i, or -1 when '/' is more likely a division. */
function scanRegex(src: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\n' || ch === '\r') return -1
    if (ch === '\\') {
      j++
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      j++
      while (j < src.length && /[a-z]/i.test(src[j] ?? '')) j++
      return j
    }
  }
  return -1
}

// ---------- token helpers ----------

function isP(t: Tok | undefined, v: string): boolean {
  return t?.t === 'p' && t.v === v
}

function isDot(t: Tok | undefined): boolean {
  return t?.t === 'p' && (t.v === '.' || t.v === '?.')
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** Index of the bracket closing toks[open], or -1. */
function matchClose(toks: Tok[], open: number): number {
  let depth = 0
  for (let k = open; k < toks.length; k++) {
    const t = toks[k]
    if (t?.t !== 'p') continue
    if (OPEN[t.v]) depth++
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

/** Comma-separated parts of toks between open and close (exclusive), at bracket depth 0. */
function splitTop(toks: Tok[], open: number, close: number, sep = ','): Tok[][] {
  const out: Tok[][] = []
  let cur: Tok[] = []
  let depth = 0
  for (let k = open + 1; k < close; k++) {
    const t = toks[k]
    if (!t) continue
    if (t.t === 'p' && OPEN[t.v]) depth++
    else if (t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--
    if (depth === 0 && isP(t, sep)) {
      out.push(cur)
      cur = []
      continue
    }
    cur.push(t)
  }
  if (cur.length) out.push(cur)
  return out
}

interface ObjEntry {
  key?: string
  colon: boolean
  spread: boolean
  computed: boolean
  value: Tok[]
}

/** Entries of an object literal toks[0..last] (toks[0] is '{', toks[last] its '}'). */
function objectEntries(toks: Tok[]): ObjEntry[] {
  return splitTop(toks, 0, toks.length - 1).map((e) => {
    const first = e[0]
    if (isP(first, '...')) return { colon: false, spread: true, computed: false, value: e.slice(1) }
    if (isP(first, '[')) return { colon: false, spread: false, computed: true, value: e }
    const key = first?.t === 'id' || first?.t === 'str' ? first.v : undefined
    const colon = isP(e[1], ':')
    return { ...(key !== undefined ? { key } : {}), colon, spread: false, computed: false, value: colon ? e.slice(2) : e }
  })
}

function wholeObject(arg: Tok[] | undefined): boolean {
  return !!arg && arg.length >= 2 && isP(arg[0], '{') && matchClose(arg, 0) === arg.length - 1
}

function literalText(toks: Tok[]): string | undefined {
  if (toks.length !== 1) return undefined
  const t = toks[0]
  if (t?.t === 'str') return t.v
  if (t?.t === 'tpl' && !t.exprs.length) return t.parts[0]
  return undefined
}

// ---------- the review ----------

/** Names in the VM sandbox (or the language) that can reach the network, a store, or run generated code. */
const FORBIDDEN_IDS = new Map<string, string>([
  ['XMLHttpRequest', 'uses XMLHttpRequest'],
  ['WebSocket', 'opens a WebSocket'],
  ['EventSource', 'opens an EventSource'],
  ['sendBeacon', 'uses sendBeacon'],
  ['importScripts', 'loads scripts'],
  ['require', 'loads a module (require)'],
  ['import', 'imports a module'],
  ['eval', 'evaluates generated code (eval)'],
  ['Function', 'builds a function from text (Function)'],
  ['Reflect', 'calls functions indirectly (Reflect)'],
  ['Proxy', 'uses a Proxy'],
  ['globalThis', 'reads the global object'],
  ['global', 'reads the global object'],
  ['window', 'reads the global object'],
  ['this', 'reads `this` (can reach the global object)'],
  ['navigator', 'uses navigator'],
  ['process', 'uses process'],
  ['https', 'uses the https module'],
  ['http', 'uses the http module'],
  ['got', 'uses a request library (got)'],
  ['superagent', 'uses a request library (superagent)'],
  ['needle', 'uses a request library (needle)'],
  ['ky', 'uses a request library (ky)'],
  ['undici', 'uses a request library (undici)'],
  ['actualAxios', 'uses the raw axios instance'],
  ['customAxios', 'uses the raw axios instance'],
  ['customFetch', 'uses the raw fetch'],
  ['defaultFetch', 'uses the raw fetch'],
  ['usaProxy', 'uses the proxy helper'],
  ['sendToParent', 'sends events to the runtime'],
  ['_allAuthData', 'reads every connection of the run'],
  ['getAccessToken', 'reads connection tokens directly'],
  ['_getAccessToken', 'reads connection tokens directly'],
  ['getBasicAuthData', 'reads connection data directly'],
])
const FORBIDDEN_MEMBERS = new Map<string, string>([
  ['constructor', 'reaches a constructor (can build functions from text)'],
  ['__proto__', 'touches a prototype'],
  ['prototype', 'touches a prototype'],
  ['sendBeacon', 'uses sendBeacon'],
  ['fetch', 'calls a .fetch method'],
])
const WRITE_MEMBERS = new Set(['post', 'put', 'patch', 'delete', 'request'])
/** Text inside strings, template text, regexes and comments that reads like a call: hidden or mis-read code. */
const HIDDEN_CALL =
  /\b(?:axios|actualAxios|XMLHttpRequest|WebSocket|EventSource|sendToParent|usaProxy)\s*(?:\(|\.|\[|\?\.)|\b(?:fetch|require|importScripts|eval|sendBeacon)\s*\(|\bimport\s*\(|\bnew\s+Function\b|\.\s*(?:post|put|patch|delete|request)\s*\(|\bhttps?\s*\.\s*(?:get|request)\s*\(/

/** Hosts a no-card run may call: exact names (a leading "www." is ignored) and "*.x" suffixes. */
export interface HostRules {
  exact: Set<string>
  suffixes: string[]
}

function bareHost(h: string): string {
  return h.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

/** Builds the host rules from the plug's domain and every whitelist (plug and connection). */
export function hostRules(domain: string | undefined, ...lists: unknown[]): HostRules {
  const exact = new Set<string>()
  const suffixes: string[] = []
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.trim()) return
    let s = raw.trim().toLowerCase()
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
    if (s.startsWith('*.')) {
      const suffix = bareHost(s.slice(2))
      if (/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(suffix)) suffixes.push(suffix)
      return
    }
    const h = bareHost(s)
    if (/^[a-z0-9.-]+$/.test(h) && h.includes('.')) exact.add(h)
  }
  add(domain)
  for (const raw of lists) {
    let list: unknown = raw
    // DbDash may hand back an array column as JSON text.
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        list = JSON.parse(raw)
      } catch {
        list = undefined
      }
    }
    if (Array.isArray(list)) list.forEach(add)
  }
  return { exact, suffixes }
}

function hostAllowed(host: string, rules: HostRules): boolean {
  const h = bareHost(host)
  return rules.exact.has(h) || rules.suffixes.some((s) => h === s || h.endsWith(`.${s}`))
}

/** Host of a URL whose static prefix ends its authority inside the literal text; else undefined. */
function hostOfPrefix(prefix: string): string | undefined {
  const m = /^\s*https?:\/\/([^/?#\\\s]*)[/?#]/i.exec(prefix)
  const authority = m?.[1]
  if (!authority || authority.includes('@')) return undefined
  const host = authority.replace(/:\d+$/, '').toLowerCase()
  return /^[a-z0-9.-]+$/.test(host) ? host : undefined
}

interface UrlCall {
  label: string
  url: Tok[] | undefined
  base?: Tok[] | undefined
}

interface Review {
  reasons: Set<string>
  calls: UrlCall[]
  /** const NAME = <single literal token> declarations; a name declared twice is ambiguous (null). */
  consts: Map<string, Tok | null>
  /** Non-member, non-key occurrences of every identifier. */
  occurrences: Map<string, number>
}

function reviewSeq(toks: Tok[], r: Review): void {
  const reason = (s: string) => r.reasons.add(s)
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]
    if (!tok) continue
    if (tok.t === 'str') {
      // Computed access by name, e.g. obj['constructor'] or this['fetch'].
      if (FORBIDDEN_MEMBERS.has(tok.v) || FORBIDDEN_IDS.has(tok.v) || tok.v === 'axios' || tok.v === 'fetch') {
        if (isP(toks[k - 1], '[')) reason(`reads "${tok.v}" by name`)
      }
      continue
    }
    if (tok.t !== 'id') continue
    const prev = toks[k - 1]
    const next = toks[k + 1]

    if (isDot(prev)) {
      const why = FORBIDDEN_MEMBERS.get(tok.v)
      if (why) reason(why)
      // axios.request({...}) is reviewed with axios itself.
      const owner = toks[k - 2]
      const axiosRequest = tok.v === 'request' && owner?.t === 'id' && owner.v === 'axios' && !isDot(toks[k - 3])
      // .post.call(…) counts too; error.request.path does not.
      if (WRITE_MEMBERS.has(tok.v) && !axiosRequest && (isP(next, '(') || (tok.v !== 'request' && isDot(next)))) reason(`calls .${tok.v}(…)`)
      continue
    }
    // An object key ({ name: … }) is not a use of the name.
    if (isP(next, ':') && (isP(prev, '{') || isP(prev, ','))) continue
    r.occurrences.set(tok.v, (r.occurrences.get(tok.v) ?? 0) + 1)

    if (tok.v === 'const' || tok.v === 'let' || tok.v === 'var') {
      const name = toks[k + 1]
      if (name?.t === 'id' && isP(toks[k + 2], '=')) {
        const init = toks[k + 3]
        const after = toks[k + 4]
        const single =
          tok.v === 'const' &&
          (init?.t === 'str' || init?.t === 'tpl') &&
          (after === undefined || isP(after, ';') || isP(after, ',') || isP(after, '}') || (after.t === 'id' && after.v !== 'in' && after.v !== 'instanceof'))
        r.consts.set(name.v, r.consts.has(name.v) || !single || !init ? null : init)
      }
      continue
    }
    if (tok.v === 'axios') {
      reviewAxios(toks, k, r)
      continue
    }
    if (tok.v === 'fetch') {
      reviewFetch(toks, k, r)
      continue
    }
    if ((tok.v === 'setTimeout' || tok.v === 'setInterval') && isP(next, '(')) {
      const arg = toks[k + 2]
      if (arg?.t === 'str' || arg?.t === 'tpl') reason(`runs text as code (${tok.v} with a string)`)
      continue
    }
    const why = FORBIDDEN_IDS.get(tok.v)
    if (why) reason(why)
    else if (tok.v.startsWith('__')) reason(`uses the runtime helper ${tok.v.slice(0, 40)}`)
  }
}

function reviewAxios(toks: Tok[], k: number, r: Review): void {
  const n1 = toks[k + 1]
  if (isDot(n1)) {
    const n2 = toks[k + 2]
    const member = n2?.t === 'id' ? n2.v : undefined
    if (member === 'get' && isP(toks[k + 3], '(')) {
      const close = matchClose(toks, k + 3)
      if (close < 0) return void r.reasons.add('calls axios.get with unbalanced brackets')
      r.calls.push({ label: 'axios.get', url: splitTop(toks, k + 3, close)[0] })
      return
    }
    if (member === 'request' && isP(toks[k + 3], '(')) return reviewConfigCall(toks, k + 3, 'axios.request', r)
    r.reasons.add(`uses axios.${member ?? '[…]'}${member === 'get' ? ' other than as a direct call' : ''}`)
    return
  }
  if (isP(n1, '(')) return reviewConfigCall(toks, k + 1, 'axios', r)
  r.reasons.add('uses axios in a way the review cannot read (as a value, with [ ] or reassigned)')
}

function reviewConfigCall(toks: Tok[], open: number, label: string, r: Review): void {
  const close = matchClose(toks, open)
  if (close < 0) return void r.reasons.add(`calls ${label} with unbalanced brackets`)
  const args = splitTop(toks, open, close)
  const cfg = args[0]
  if (args.length !== 1 || !wholeObject(cfg) || !cfg) {
    return void r.reasons.add(`calls ${label}(…) without a single literal config object`)
  }
  const entries = objectEntries(cfg)
  if (entries.some((e) => e.spread || e.computed)) r.reasons.add(`calls ${label}(…) with a config it spreads or computes`)
  const methods = entries.filter((e) => e.key === 'method')
  if (!methods.length) r.reasons.add(`calls ${label}(…) without a literal method`)
  for (const m of methods) {
    const lit = m.colon ? literalText(m.value) : undefined
    if (lit?.toLowerCase() !== 'get') r.reasons.add(`calls ${label}(…) with method ${lit ? `"${lit.slice(0, 20)}"` : 'set at run time'}`)
  }
  const url = entries.find((e) => e.key === 'url' && e.colon)
  const base = entries.find((e) => e.key === 'baseURL' && e.colon)
  const shorthandUrl = entries.find((e) => e.key === 'url' && !e.colon)
  r.calls.push({ label, url: url?.value ?? shorthandUrl?.value, ...(base ? { base: base.value } : {}) })
}

function reviewFetch(toks: Tok[], k: number, r: Review): void {
  if (!isP(toks[k + 1], '(')) return void r.reasons.add('uses fetch in a way the review cannot read (as a value)')
  const close = matchClose(toks, k + 1)
  if (close < 0) return void r.reasons.add('calls fetch with unbalanced brackets')
  const args = splitTop(toks, k + 1, close)
  if (!args.length || args.length > 2) return void r.reasons.add(`calls fetch with ${args.length} arguments`)
  const opts = args[1]
  if (opts) {
    if (!wholeObject(opts)) {
      r.reasons.add('calls fetch with options built elsewhere (the method cannot be read)')
    } else {
      const entries = objectEntries(opts)
      if (entries.some((e) => e.spread || e.computed)) r.reasons.add('calls fetch with options it spreads or computes')
      const methods = entries.filter((e) => e.key === 'method')
      if (!methods.length) r.reasons.add("calls fetch with options but no literal method 'GET'")
      for (const m of methods) {
        const lit = m.colon ? literalText(m.value) : undefined
        if (lit?.toLowerCase() !== 'get') r.reasons.add(`calls fetch with method ${lit ? `"${lit.slice(0, 20)}"` : 'set at run time'}`)
      }
    }
  }
  // fetch(request) takes its method from a Request object, so the first argument must be something that is
  // certainly a URL string; anything else (new Request(...), a variable or member read we can't trace) gets a card.
  if (!plainUrlArg(args[0] ?? [], r)) r.reasons.add('calls fetch with a request object or a URL the review cannot read')
  r.calls.push({ label: 'fetch', url: args[0] })
}

/** A string literal or template, a simple const of one, or a '+' chain with at least one literal (always a string). */
function plainUrlArg(toks: Tok[], r: Review): boolean {
  if (toks.length === 1) {
    const t = toks[0]
    if (t?.t === 'str' || t?.t === 'tpl') return true
    return t?.t === 'id' && !!r.consts.get(t.v)
  }
  let stringy = false
  for (const t of toks) {
    if (t.t === 'p') {
      if (t.v === '+') stringy = true
      else if (t.v !== '.' && t.v !== '?.') return false
    } else if (t.t === 'str' || t.t === 'tpl') stringy = true
    else if (t.t === 're' || (t.t === 'id' && t.v === 'new')) return false
  }
  return stringy
}

// ---------- URL resolution for the host check ----------

interface Prefix {
  text: string
  complete: boolean
}

/** Const names a URL resolution read: all of them, and those read straight from the URL expression. */
interface Names {
  all: string[]
  direct: string[]
}

function constPrefix(name: string, r: Review, names: Names, depth: number): Prefix | undefined {
  const init = r.consts.get(name)
  if (!init || depth > 3) return undefined
  names.all.push(name)
  if (depth === 0) names.direct.push(name)
  return tokenPrefix(init, r, names, depth + 1)
}

function tokenPrefix(t: Tok, r: Review, names: Names, depth: number): Prefix | undefined {
  if (t.t === 'str') return { text: t.v, complete: true }
  if (t.t === 'id') return constPrefix(t.v, r, names, depth)
  if (t.t !== 'tpl') return undefined
  let text = ''
  for (let i = 0; i < t.parts.length; i++) {
    text += t.parts[i] ?? ''
    if (i >= t.exprs.length) break
    const expr = (t.exprs[i] ?? '').trim()
    const sub = IDENT_RE.test(expr) ? constPrefix(expr, r, names, depth) : undefined
    if (!sub) return { text, complete: false }
    text += sub.text
    if (!sub.complete) return { text, complete: false }
  }
  return { text, complete: true }
}

/** Static leading text of a URL expression: literals, simple consts, templates and '+' chains of them. */
function urlPrefix(toks: Tok[] | undefined, r: Review, names: Names): Prefix | undefined {
  if (!toks?.length) return undefined
  const operands: Tok[][] = [[]]
  for (const t of toks) {
    if (isP(t, '+')) operands.push([])
    else if (t.t === 'p') return undefined
    else operands[operands.length - 1]?.push(t)
  }
  let text = ''
  let complete = true
  for (const op of operands) {
    const t = op.length === 1 ? op[0] : undefined
    const p = t ? tokenPrefix(t, r, names, 0) : undefined
    if (!p) {
      complete = false
      break
    }
    text += p.text
    if (!p.complete) {
      complete = false
      break
    }
  }
  return text ? { text, complete } : undefined
}

/** A fully static URL ends its host at the end of the text. */
function hostOf(p: Prefix): string | undefined {
  return hostOfPrefix(p.complete ? `${p.text}/` : p.text)
}

function checkHosts(r: Review, rules: HostRules): void {
  const results = r.calls.map((call) => {
    const names: Names = { all: [], direct: [] }
    const url = urlPrefix(call.url, r, names)
    let host: string | undefined
    if (url && /^\s*https?:/i.test(url.text)) {
      host = hostOf(url)
    } else if (call.base && url && /^\/(?!\/)/.test(url.text)) {
      // axios joins baseURL and a relative url; an absolute url would replace the base, so only a literal '/…' counts.
      const base = urlPrefix(call.base, r, names)
      if (base) host = base.complete ? hostOfPrefix(`${base.text}${url.text}`) ?? hostOf(base) : hostOf(base)
    }
    return { host, names }
  })
  const direct = new Map<string, number>()
  for (const x of results) for (const n of x.names.direct) direct.set(n, (direct.get(n) ?? 0) + 1)
  // A const read anywhere except as a URL base or inside another const (a parameter of the same name, any other
  // read) might not hold its literal at the call, so calls built from it count as built at run time.
  const shaky = (n: string) => (r.occurrences.get(n) ?? 0) !== 1 + (direct.get(n) ?? 0) + constRefs(n, r)
  const outside = new Set<string>()
  let dynamic = 0
  for (const x of results) {
    if (!x.host || x.names.all.some(shaky)) dynamic++
    else if (!hostAllowed(x.host, rules)) outside.add(x.host)
  }
  if (outside.size) r.reasons.add(`calls ${[...outside].slice(0, 3).join(', ')}, outside the plug's whitelisted hosts`)
  if (dynamic) r.reasons.add(`builds ${dynamic === 1 ? 'a request URL' : `${dynamic} request URLs`} at run time (the host cannot be checked)`)
}

/** How often a const is referenced from the initialisers of other consts (those reads are resolved too). */
function constRefs(name: string, r: Review): number {
  let n = 0
  for (const init of r.consts.values()) {
    if (init?.t !== 'tpl') continue
    for (const e of init.exprs) if (e.trim() === name) n++
  }
  return n
}

export interface ReviewOptions {
  /** Check every request URL against these hosts (the dry-run path). Omit to skip the host check. */
  hosts?: HostRules
}

/**
 * Reasons the code may do more than read; empty only when every network call is a recognised literal GET (and,
 * with `hosts`, goes to a whitelisted host through a URL whose host is written in the code).
 */
export function readOnlyReasons(code: string, opts: ReviewOptions = {}): string[] {
  if (code.length > MAX_CODE_CHARS) return ['is too long to review']
  const lexer = new Lexer(code)
  const main = lexer.run(0, false, 0)
  const r: Review = { reasons: new Set(), calls: [], consts: new Map(), occurrences: new Map() }
  if (lexer.error) r.reasons.add(`could not be read completely (${lexer.error})`)
  for (const seq of [main.toks, ...lexer.seqs]) reviewSeq(seq, r)
  if (lexer.texts.some((t) => HIDDEN_CALL.test(t))) r.reasons.add('has call-like code inside a string, pattern or comment')
  if (/\bmutation\b/.test(code)) r.reasons.add('sends a GraphQL mutation')
  if (/\bauthData\b/.test(code) && /\b(?:btoa|Buffer|charCodeAt|fromCharCode|codePointAt)\b/.test(code)) {
    r.reasons.add('transforms values that may include connection credentials')
  }
  if (opts.hosts) checkHosts(r, opts.hosts)
  return [...r.reasons]
}

/** inputData string values are compiled into template literals by the VM, so `${…}` or a backtick there is code. */
export function inputDataCode(v: unknown, path = 'inputData', depth = 0, out: string[] = []): string[] {
  if (out.length >= 10 || depth > 6) return out
  if (typeof v === 'string') {
    if (v.includes('${') || v.includes('`')) out.push(path)
  } else if (Array.isArray(v)) {
    v.slice(0, 200).forEach((x, i) => inputDataCode(x, `${path}[${i}]`, depth + 1, out))
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v).slice(0, 200)) {
      if (k.includes('${') || k.includes('`')) out.push(`${path} key ${k.slice(0, 40)}`)
      inputDataCode(x, `${path}.${k}`, depth + 1, out)
    }
  }
  return out
}

/** Hosts named in the code, for the confirmation card. */
export function codeHosts(code: string): string[] {
  return [...new Set([...code.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1] ?? ''))].filter(Boolean).slice(0, 5)
}

/** Shows the user what will run and which hosts it talks to, before they approve it. */
export function codePreview(code: string, max = 400): string {
  const hosts = codeHosts(code)
  const head = code.length > max ? `${code.slice(0, max)}…` : code
  return `\n\nCode to run${hosts.length ? ` (calls ${hosts.join(', ')})` : ''}:\n${head}`
}
