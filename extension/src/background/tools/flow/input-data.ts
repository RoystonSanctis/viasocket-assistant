// selectedValues.inputData encoding for app steps and app triggers.
//
// Each field has up to three entries: `key` (the executed value; strings are compiled as JS template literals, so
// references are `${context...}`), `_key` (the display copy) and `_key-Type` (the coercion type the runtime
// uses for numbers, booleans, lists and defaults). Group children use parent["child"] / parent["_child"].

import { fieldList } from './catalog'
import { checkTemplateText } from './js-check'
import type { FieldDef, InputJson } from './types'
import { isRecord } from './util'

const COERCION: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  dropdown: 'dropdown',
  multiselect: 'multiselect',
  date: 'date',
  html: 'html',
  markdown: 'markdown',
  dictionary: 'dictionary',
  aifield: 'aifield',
}

function coercionType(def: FieldDef): string {
  const t = typeof def.type === 'string' ? def.type : 'string'
  if (def.list && t === 'string') return 'liststring'
  if (def.list && t === 'number') return 'listnumber'
  return COERCION[t] ?? 'string'
}

function siblingKeys(key: string): { display: string; type: string } {
  const m = /^(.+)\["([^"\]]+)"\]$/.exec(key)
  if (m) return { display: `${m[1]}["_${m[2]}"]`, type: `${m[1]}["_${m[2]}-Type"]` }
  return { display: `_${key}`, type: `_${key}-Type` }
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v) ?? ''
}

function normalize(raw: unknown, coercion: string): unknown {
  switch (coercion) {
    case 'boolean':
      if (raw === true || raw === 'true') return true
      if (raw === false || raw === 'false') return false
      return asText(raw)
    case 'liststring':
    case 'listnumber':
    case 'multiselect':
      return (Array.isArray(raw) ? raw : [raw]).map(asText)
    case 'dictionary': {
      if (!isRecord(raw)) return asText(raw)
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) {
        // vs_get_step shows saved entries in their stored {key, value, _value} shape; an echoed entry keeps its value.
        const value = isRecord(v) && 'value' in v && ('_value' in v || 'key' in v) ? v.value : v
        out[k] = { key: k, _key: k, value: asText(value), _value: asText(value) }
      }
      return out
    }
    default:
      return asText(raw)
  }
}

function templateProblems(key: string, value: unknown): string[] {
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  const out: string[] = []
  for (const t of texts) {
    const p = checkTemplateText(t)
    if (p) out.push(`${key}: ${p}`)
  }
  return out
}

export interface EncodedInput {
  inputData: Record<string, unknown>
  /** Keys that are not fields of this action (dropped) */
  unknownKeys: string[]
  /** Value problems that would break the generated code */
  problems: string[]
  /** Required, always-visible fields still empty */
  missingRequired: string[]
}

/**
 * Merges model-provided values (field key -> value; null clears a field) into `base` with the sibling entries
 * the UI and runtime expect. Only keys defined by the action are kept.
 */
export function encodeInputData(values: Record<string, unknown>, ij: InputJson, base: Record<string, unknown> = {}): EncodedInput {
  const inputData: Record<string, unknown> = { ...base }
  const unknownKeys: string[] = []
  const problems: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    const def = ij.blocks[key]
    if (!def) {
      unknownKeys.push(key)
      continue
    }
    const sib = siblingKeys(key)
    if (raw === null) {
      delete inputData[key]
      delete inputData[sib.display]
      delete inputData[sib.type]
      continue
    }
    const coercion = coercionType(def)
    const value = normalize(raw, coercion)
    problems.push(...templateProblems(key, value))
    inputData[key] = value
    if (coercion !== 'boolean' && coercion !== 'multiselect' && coercion !== 'dictionary') inputData[sib.display] = value
    else delete inputData[sib.display]
    inputData[sib.type] = coercion
  }
  const missingRequired = fieldList(ij)
    .filter((f) => f.required && !f.visibleWhen && !f.group)
    .filter((f) => {
      const v = inputData[f.key]
      return v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
    })
    .map((f) => f.key)
  return { inputData, unknownKeys, problems, missingRequired }
}
