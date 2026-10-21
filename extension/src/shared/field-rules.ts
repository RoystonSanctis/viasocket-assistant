// Field rules shared by the agent's app-step tools (background/tools/flow/fields.ts) and the subfunctions panel
// (content/subfunctions-ui.ts): when a field has a value, what context.inputData looks like to visibility rules and
// option loaders, which sibling fields a loader reads, and a small evaluator for visibilityCondition.
//
// visibilityCondition is a JavaScript expression. eval is unavailable in MV3 extension contexts, so a small evaluator
// handles the common forms (comparisons, &&, ||, !, includes) and answers "unknown" for anything else.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Same rule as the editor: booleans and numbers count, empty strings, arrays and objects do not. */
export function valueExists(v: unknown): boolean {
  if (typeof v === 'boolean' || typeof v === 'number') return true
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (isRecord(v)) return Object.keys(v).length > 0
  return false
}

/** context.inputData as visibility conditions and option loaders see it: values only, underscore copies removed. */
export function conditionValues(inputData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputData)) {
    if (k.startsWith('_') || k.endsWith('-Type') || k.includes('["_')) continue
    const m = /^([^[\]]+)\["([^"\]]+)"\]$/.exec(k)
    if (m && m[1] && m[2]) {
      const group = isRecord(out[m[1]]) ? (out[m[1]] as Record<string, unknown>) : {}
      group[m[2]] = v
      out[m[1]] = group
    } else out[k] = v
  }
  return out
}

/** Sibling fields an option loader reads (context.inputData.X), unless the definition lists them. */
export function fieldDeps(key: string, def: { dependsOn?: unknown; source?: unknown }): string[] {
  if (Array.isArray(def.dependsOn) && def.dependsOn.length) return def.dependsOn.filter((d): d is string => typeof d === 'string' && d !== key)
  return usedInputs(def.source, key)
}

/** The editor's extractUsedVariables: context.inputData.X (and ["X"]) read by a source. */
export function usedInputs(source: unknown, key: string): string[] {
  const src = typeof source === 'string' ? source.replaceAll('?.', '.') : ''
  const out = new Set<string>()
  for (const m of src.matchAll(/context\.inputData\.([A-Za-z_$][\w$]*)/g)) if (m[1] && m[1] !== key) out.add(m[1])
  for (const m of src.matchAll(/context\.inputData\[\s*["']([^"']+)["']\s*\]/g)) if (m[1] && m[1] !== key) out.add(m[1])
  return [...out]
}

// ---- visibilityCondition evaluator ---------------------------------------------------------------------------

class Unknown extends Error {}
/** Reading a property of undefined throws in the editor, which then treats the rule as false. */
class EvalFalse extends Error {}

type Tok = { t: 'str' | 'num' | 'id' | 'op'; v: string }

const OPS = ['===', '!==', '?.[', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '!', '<', '>', '(', ')', '[', ']', '.', ',']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1] ?? ''
          j += 2
          continue
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') throw new Unknown()
        s += src[j]
        j++
      }
      if (j >= src.length) throw new Unknown()
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Unknown()
    out.push({ t: 'op', v: op })
    i += op.length
  }
  return out
}

const CONTEXT = Symbol('context')

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null
  if (typeof a === typeof b) return a === b
  const na = typeof a === 'boolean' ? Number(a) : a
  const nb = typeof b === 'boolean' ? Number(b) : b
  if (typeof na === 'number' && typeof nb === 'string') return na === Number(nb)
  if (typeof na === 'string' && typeof nb === 'number') return Number(na) === nb
  return na === nb
}

/**
 * true / false for a visibility rule over context.inputData, or undefined when the rule uses anything this small
 * evaluator does not know (other context data, functions, assignments).
 */
export function evalCondition(src: string, inputValues: Record<string, unknown>): boolean | undefined {
  let toks: Tok[]
  try {
    toks = tokenize(src)
  } catch {
    return undefined
  }
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new Unknown()
    p++
  }

  const member = (obj: unknown, key: unknown, optional: boolean): unknown => {
    if (obj === CONTEXT) {
      if (key === 'inputData') return inputValues
      throw new Unknown()
    }
    if (obj == null) {
      if (optional) return undefined
      throw new EvalFalse()
    }
    if (typeof key !== 'string' && typeof key !== 'number') throw new Unknown()
    if (key === 'length' && (typeof obj === 'string' || Array.isArray(obj))) return obj.length
    if (isRecord(obj) || Array.isArray(obj)) return (obj as Record<string, unknown>)[key as string]
    return undefined
  }

  const callMethod = (obj: unknown, name: string, args: unknown[]): unknown => {
    if (typeof obj === 'string') {
      const a = args[0]
      switch (name) {
        case 'includes':
          return typeof a === 'string' && obj.includes(a)
        case 'startsWith':
          return typeof a === 'string' && obj.startsWith(a)
        case 'endsWith':
          return typeof a === 'string' && obj.endsWith(a)
        case 'trim':
          return obj.trim()
        case 'toLowerCase':
          return obj.toLowerCase()
        case 'toUpperCase':
          return obj.toUpperCase()
      }
    }
    if (Array.isArray(obj) && name === 'includes') return obj.some((x) => x === args[0])
    if (obj == null && (name === 'includes' || name === 'startsWith' || name === 'endsWith')) return false
    throw new Unknown()
  }

  const primary = (): unknown => {
    const tk = peek()
    if (!tk) throw new Unknown()
    p++
    if (tk.t === 'str') return tk.v
    if (tk.t === 'num') return Number(tk.v)
    if (tk.t === 'id') {
      if (tk.v === 'true') return true
      if (tk.v === 'false') return false
      if (tk.v === 'null') return null
      if (tk.v === 'undefined') return undefined
      if (tk.v === 'context') return CONTEXT
      throw new Unknown()
    }
    if (tk.v === '(') {
      const v = expr()
      expectOp(')')
      return v
    }
    if (tk.v === '[') {
      const items: unknown[] = []
      while (!isOp(']')) {
        items.push(expr())
        if (isOp(',')) p++
        else break
      }
      expectOp(']')
      return items
    }
    throw new Unknown()
  }

  const postfix = (): unknown => {
    let v = primary()
    for (;;) {
      if (isOp('.') || isOp('?.')) {
        const optional = peek()?.v === '?.'
        p++
        const name = peek()
        if (name?.t !== 'id') throw new Unknown()
        p++
        if (isOp('(')) {
          p++
          const args: unknown[] = []
          while (!isOp(')')) {
            args.push(expr())
            if (isOp(',')) p++
            else break
          }
          expectOp(')')
          v = callMethod(v, name.v, args)
        } else v = member(v, name.v, optional)
      } else if (isOp('[') || isOp('?.[')) {
        const optional = peek()?.v === '?.['
        p++
        const key = expr()
        expectOp(']')
        v = member(v, key, optional)
      } else return v
    }
  }

  const unary = (): unknown => {
    if (isOp('!')) {
      p++
      return !truthy(unary())
    }
    return postfix()
  }
  const truthy = (v: unknown): boolean => {
    if (v === CONTEXT) return true
    return !!v
  }
  const relational = (): unknown => {
    let v = unary()
    while (isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
      const op = peek()?.v
      p++
      const r = unary()
      if ((typeof v !== 'number' && typeof v !== 'string') || (typeof r !== 'number' && typeof r !== 'string')) throw new Unknown()
      v = op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r
    }
    return v
  }
  const equality = (): unknown => {
    let v = relational()
    while (isOp('===') || isOp('!==') || isOp('==') || isOp('!=')) {
      const op = peek()?.v
      p++
      const r = relational()
      if (v === CONTEXT || r === CONTEXT) throw new Unknown()
      v = op === '===' ? v === r : op === '!==' ? v !== r : op === '==' ? looseEq(v, r) : !looseEq(v, r)
    }
    return v
  }
  const and = (): unknown => {
    let v = equality()
    while (isOp('&&')) {
      p++
      const r = equality()
      v = truthy(v) ? r : v
    }
    return v
  }
  const or = (): unknown => {
    let v = and()
    while (isOp('||') || isOp('??')) {
      const op = peek()?.v
      p++
      const r = and()
      v = op === '||' ? (truthy(v) ? v : r) : v ?? r
    }
    return v
  }
  const expr = (): unknown => or()

  try {
    const v = expr()
    if (p !== toks.length) return undefined
    return truthy(v)
  } catch (e) {
    return e instanceof EvalFalse ? false : undefined
  }
}
