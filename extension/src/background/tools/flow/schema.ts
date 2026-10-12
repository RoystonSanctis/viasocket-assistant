// Tool parameter schemas and the validator that enforces them in code. The schema sent to the LLM is the same
// object the arguments are checked against, so the two cannot drift apart.

import type { JsonSchema } from '../../llm/types'
import type { Tool } from '../types'
import { ToolError } from './errors'
import { isRecord } from './util'

type Node = Record<string, unknown>

export function params(properties: Record<string, Node>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const S = {
  str: (description: string, extra: Node = {}): Node => ({ type: 'string', description, ...extra }),
  int: (description: string, extra: Node = {}): Node => ({ type: 'integer', description, ...extra }),
  bool: (description: string): Node => ({ type: 'boolean', description }),
  enum: (values: readonly (string | number)[], description: string): Node => ({
    type: typeof values[0] === 'number' ? 'integer' : 'string',
    enum: [...values],
    description,
  }),
  /** Free-form map (e.g. field values keyed by field key) */
  map: (description: string, values: Node = {}): Node => ({ type: 'object', description, additionalProperties: values }),
  pairs: (description: string): Node => ({
    type: 'array',
    description,
    maxItems: 50,
    items: {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 200 }, value: { type: 'string', maxLength: 4000 } },
      required: ['name', 'value'],
      additionalProperties: false,
    },
  }),
}

export function validateArgs(schema: Node, value: unknown): string[] {
  const errs: string[] = []
  check(schema, value, 'arguments', errs)
  return errs
}

function check(s: Node, v: unknown, path: string, errs: string[]): void {
  if (errs.length >= 8) return
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    errs.push(`${path} must be one of: ${s.enum.map(String).join(', ')}`)
    return
  }
  switch (s.type) {
    case 'string': {
      if (typeof v !== 'string') return void errs.push(`${path} must be a string`)
      if (typeof s.minLength === 'number' && v.length < s.minLength) errs.push(`${path} is too short`)
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) errs.push(`${path} is longer than ${s.maxLength} characters`)
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) errs.push(`${path} has an invalid format`)
      return
    }
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) {
        return void errs.push(`${path} must be ${s.type === 'integer' ? 'an integer' : 'a number'}`)
      }
      if (typeof s.minimum === 'number' && v < s.minimum) errs.push(`${path} must be >= ${s.minimum}`)
      if (typeof s.maximum === 'number' && v > s.maximum) errs.push(`${path} must be <= ${s.maximum}`)
      return
    }
    case 'boolean':
      if (typeof v !== 'boolean') errs.push(`${path} must be true or false`)
      return
    case 'array': {
      if (!Array.isArray(v)) return void errs.push(`${path} must be an array`)
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) errs.push(`${path} has more than ${s.maxItems} items`)
      if (isRecord(s.items)) v.forEach((item, i) => check(s.items as Node, item, `${path}[${i}]`, errs))
      return
    }
    case 'object': {
      if (!isRecord(v)) return void errs.push(`${path} must be an object`)
      const props = isRecord(s.properties) ? s.properties : {}
      for (const r of Array.isArray(s.required) ? s.required : []) {
        if (typeof r === 'string' && v[r] === undefined) errs.push(`${path}.${r} is required`)
      }
      for (const [k, val] of Object.entries(v)) {
        const ps = props[k]
        if (isRecord(ps)) check(ps, val, `${path}.${k}`, errs)
        else if (s.additionalProperties === false) errs.push(`${path}.${k} is not a known parameter`)
        else if (isRecord(s.additionalProperties)) check(s.additionalProperties, val, `${path}.${k}`, errs)
      }
      return
    }
    default:
      return
  }
}

/** Wraps run() so arguments are validated against the tool's own schema before anything happens. */
export function defineTool<A>(tool: Tool<A>): Tool<A> {
  return {
    ...tool,
    async run(args, ctx) {
      const errs = validateArgs(tool.parameters, args ?? {})
      if (errs.length) throw new ToolError(`Invalid arguments for ${tool.name}: ${errs.join('; ')}`)
      return tool.run(args ?? ({} as A), ctx)
    },
  }
}
