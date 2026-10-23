// Structural sanity checks for the raw JS the model writes (function code, variable expressions, conditions,
// field templates). eval/new Function are unavailable in MV3 service workers, so nothing is parsed for real:
// this only catches unbalanced brackets and unterminated strings/templates/comments. The backend's syntax check
// stays authoritative for function code; variable data and conditions are NOT checked there, which is why the
// client-side check matters (a broken expression breaks the whole flow at runtime).

interface ScanResult {
  error?: string
  hasLineComment: boolean
}

const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'])
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|instanceof|yield|await)$/

export function regexAllowed(lastSig: string, src: string, i: number): boolean {
  if (REGEX_AFTER.has(lastSig)) return true
  if (/[\w$]/.test(lastSig)) return REGEX_KEYWORD.test(src.slice(Math.max(0, i - 12), i).trimEnd())
  return false
}

/** End index of a regex literal starting at i, or -1 when '/' is more likely a division. */
export function scanRegex(src: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\n') return -1
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

function scan(src: string): ScanResult {
  const stack: Array<{ ch: string; line: number }> = []
  let line = 1
  let lastSig = ''
  let hasLineComment = false
  let i = 0
  const fail = (error: string): ScanResult => ({ error, hasLineComment })

  while (i < src.length) {
    const c = src[i] ?? ''
    const top = stack[stack.length - 1]

    if (top?.ch === '`') {
      if (c === '\\') i += 2
      else if (c === '`') {
        stack.pop()
        lastSig = 'a'
        i++
      } else if (c === '$' && src[i + 1] === '{') {
        stack.push({ ch: '${', line })
        lastSig = '{'
        i += 2
      } else {
        if (c === '\n') line++
        i++
      }
      continue
    }

    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      hasLineComment = true
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return fail(`Unterminated /* comment on line ${line}`)
      line += (src.slice(i, end).match(/\n/g) ?? []).length
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      const startLine = line
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++
        else if (src[i] === '\n') return fail(`Unterminated string on line ${startLine}`)
        i++
      }
      if (i >= src.length) return fail(`Unterminated string on line ${startLine}`)
      i++
      lastSig = 'a'
      continue
    }
    if (c === '`') {
      stack.push({ ch: '`', line })
      i++
      continue
    }
    if (c === '/' && regexAllowed(lastSig, src, i)) {
      const end = scanRegex(src, i)
      if (end > 0) {
        i = end
        lastSig = 'a'
        continue
      }
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push({ ch: c, line })
      lastSig = c
      i++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop()
      if (!open) return fail(`Unexpected '${c}' on line ${line}`)
      if (c === '}' && open.ch === '${') {
        i++
        continue
      }
      const want = c === ')' ? '(' : c === ']' ? '[' : '{'
      if (open.ch !== want) return fail(`'${c}' on line ${line} does not match '${open.ch}' opened on line ${open.line}`)
      lastSig = c
      i++
      continue
    }
    lastSig = c
    i++
  }
  const open = stack.pop()
  if (open) {
    return fail(open.ch === '`' ? `Unterminated template literal opened on line ${open.line}` : `'${open.ch}' opened on line ${open.line} is never closed`)
  }
  return { hasLineComment }
}

/** Body of a function step (it runs inside an async function and must `return` its result). */
export function checkFunctionCode(code: string): { error?: string; warning?: string } {
  if (!code.trim()) return { error: 'Code is empty.' }
  const r = scan(code)
  if (r.error) return { error: r.error }
  return /\breturn\b/.test(code) ? {} : { warning: 'The code never returns; the step output (context.res.<slug>) will be undefined.' }
}

/** A raw JS expression spliced inline into the flow (variable data, if-conditions, response data). */
export function checkExpression(expr: string): string | undefined {
  if (!expr.trim()) return 'Expression is empty.'
  const r = scan(expr)
  if (r.error) return r.error
  // The runtime appends ';' after the expression, which a trailing // comment would swallow.
  if (r.hasLineComment) return 'Expressions cannot contain // comments.'
  return undefined
}

/**
 * Plugin field values, API urls and header values are compiled as JS template literals, so `${...}` must be
 * balanced and a raw backtick outside `${}` would end the literal early.
 */
export function checkTemplateText(text: string): string | undefined {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (depth === 0) {
      if (c === '`') return 'Contains a backtick (`), which breaks the value; remove it or use a ${...} expression.'
      if (c === '$' && text[i + 1] === '{') {
        depth = 1
        i++
      }
    } else if (c === '{') depth++
    else if (c === '}') depth--
  }
  if (depth !== 0) return 'Has an unclosed ${ ... } reference.'
  const r = scan('`' + text + '`')
  return r.error
}

export function checkCommentText(text: string): string | undefined {
  return text.includes('*/') ? "Comment text cannot contain '*/'." : undefined
}
