// Request bodies for saving steps (PUT /scripts/:scriptId/stepv2/:slug).
//
// Rules every body follows:
// - `title` is ALWAYS sent: the current slug, or the new slug when renaming. Without it the backend renames the
//   step to the key 'undefined'.
// - `type` equals the block's type.
// - description and sampleData are re-sent, because the save overwrites them with whatever arrives.

import type { ToolContext } from '../types'
import { call, ToolError } from './errors'
import { checkExpression, checkTemplateText } from './js-check'
import type { AuthData, FlowTarget, PluginData } from './types'
import { asArray, asRecord, isRecord, MASK, str } from './util'

const MAX_CODE_CHARS = 307_200

export interface SaveCommon {
  stepId: string
  /** Slug to save under: the current slug, or the new one when renaming */
  title: string
  description?: unknown
  sampleData?: unknown
  iconUrl?: unknown
  /** Template flows hide some steps; app-step saves overwrite the flag with whatever arrives. */
  hidden?: unknown
}

function common(c: SaveCommon): Record<string, unknown> {
  const out: Record<string, unknown> = { title: c.title, stepId: c.stepId }
  if (c.description !== undefined) out.description = c.description
  if (c.sampleData !== undefined) out.sampleData = c.sampleData
  if (typeof c.iconUrl === 'string' && c.iconUrl) out.iconUrl = c.iconUrl
  if (c.hidden !== undefined) out.hidden = c.hidden
  return out
}

/**
 * live:false skips the editor's live-apply. Use it when the step's panel is open: live-apply leaves the panel's
 * cached copy stale, while a plain save followed by a ?timestamp refetch (refreshEditorIfOpen) reloads it.
 */
export async function putStep(
  ctx: ToolContext,
  t: FlowTarget,
  slug: string,
  body: Record<string, unknown>,
  live = true,
): Promise<Record<string, unknown>> {
  const res = await call(`Saving step "${slug}"`, () =>
    ctx.vs.request({ method: 'PUT', path: `/scripts/${t.scriptId}/stepv2/${encodeURIComponent(slug)}`, body, live, signal: ctx.signal }),
  )
  return isRecord(res) ? res : {}
}

export function functionBody(
  c: SaveCommon,
  code: string,
  extra: { dynamicVariables?: Record<string, unknown>; authId?: unknown; subfunctions?: unknown },
): Record<string, unknown> {
  if (code.length > MAX_CODE_CHARS) throw new ToolError('Function code is too long.')
  const body: Record<string, unknown> = { type: 'function', ...common(c), code }
  if (extra.dynamicVariables && Object.keys(extra.dynamicVariables).length) body.dynamicVariables = extra.dynamicVariables
  if (typeof extra.authId === 'string' && extra.authId) body.auth_id = extra.authId
  if (Array.isArray(extra.subfunctions) && extra.subfunctions.length) body.subfunctions = extra.subfunctions
  return body
}

export interface Pair {
  name: string
  value: string
}

export interface ApiSpec {
  url?: string
  method?: string
  headers?: Pair[]
  queryParams?: Pair[]
  bodyType?: 'json' | 'form' | 'multipart' | 'none'
  body?: string
  formFields?: Pair[]
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function pairs(v: unknown): Pair[] {
  return asArray(v)
    .filter(isRecord)
    .map((p) => ({ name: str(p.name) ?? '', value: str(p.value) ?? '' }))
}

/** A value vs_get_step shortened ("…" appended) and the model sent back as it was. */
function isCutCopy(incoming: string, saved: string): boolean {
  return incoming.endsWith('…') && saved.length >= incoming.length && saved !== incoming && saved.startsWith(incoming.slice(0, -1))
}

/**
 * Lists the model sends back from vs_get_step: a masked secret (or a shortened value) keeps the saved value of the
 * same name, matched exactly first (same position preferred), then case-insensitively. A mask with nothing saved
 * behind it is a problem: saving it would store the mask text as the value.
 */
function restorePairs(incoming: Pair[], saved: Pair[], what: string, problems: string[]): Pair[] {
  return incoming.map((p, i) => {
    const at = saved[i]
    const lower = p.name.toLowerCase()
    const match = (at?.name === p.name ? at : undefined) ?? saved.find((s) => s.name === p.name) ?? saved.find((s) => s.name.toLowerCase() === lower)
    if (p.value === MASK) {
      if (match) return { name: p.name, value: match.value }
      problems.push(`${what} "${p.name}": no saved value to keep; ask the user for it.`)
      return p
    }
    return match && isCutCopy(p.value, match.value) ? { name: p.name, value: match.value } : p
  })
}

type BodyKind = NonNullable<ApiSpec['bodyType']>

function bodyKindOf(mimeType: string | undefined): Exclude<BodyKind, 'none'> {
  if (mimeType === 'multipart/form-data') return 'multipart'
  if (mimeType === 'application/x-www-form-urlencoded') return 'form'
  return 'json'
}

/**
 * API step code merged over the saved one. Masked header, query and form values (from vs_get_step) keep their
 * saved secret; bodyType alone changes only the encoding and never silently drops the saved body.
 */
export function buildApiCode(spec: ApiSpec, existing: Record<string, unknown>): { code: Record<string, unknown>; problems: string[] } {
  const problems: string[] = []
  const url = spec.url ?? str(existing.url) ?? ''
  if (!url) problems.push('url is required.')
  else if (!/^https?:\/\//i.test(url) && !url.startsWith('${')) problems.push('url must start with https:// (or be a ${...} reference).')
  const urlProblem = url ? checkTemplateText(url) : undefined
  if (urlProblem) problems.push(`url: ${urlProblem}`)

  const method = (spec.method ?? str(existing.method) ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) problems.push('method must be GET, POST, PUT, PATCH or DELETE.')

  const savedHeaders = pairs(existing.headers)
  const headers = spec.headers ? restorePairs(spec.headers, savedHeaders, 'header', problems) : savedHeaders
  const savedQuery = pairs(existing.queryString)
  const queryString = spec.queryParams ? restorePairs(spec.queryParams, savedQuery, 'query param', problems) : savedQuery
  for (const p of [...headers, ...queryString]) {
    if (!/^[A-Za-z0-9_.\-[\]]{1,200}$/.test(p.name)) problems.push(`"${p.name}" is not a valid header or query name.`)
    const tp = checkTemplateText(p.value)
    if (tp) problems.push(`${p.name}: ${tp}`)
  }

  const savedPost = asRecord(existing.postData)
  const savedKind = bodyKindOf(str(savedPost.mimeType))
  const savedText = str(savedPost.text) ?? ''
  const savedParams = pairs(savedPost.params)
  let postData: unknown = existing.postData ?? { mimeType: 'application/json', text: '', params: [] }
  if (spec.bodyType || spec.body !== undefined || spec.formFields) {
    const kind: BodyKind = spec.bodyType ?? (spec.formFields ? (savedKind === 'multipart' ? 'multipart' : 'form') : 'json')
    if (spec.body !== undefined && kind !== 'json') problems.push('body is only used with bodyType "json"; send form values as formFields.')
    if (spec.formFields && (kind === 'json' || kind === 'none')) problems.push('formFields are only used with bodyType "form" or "multipart".')
    if (kind === 'none') {
      postData = { mimeType: 'application/json', text: '', params: [] }
    } else if (spec.body === undefined && !spec.formFields && kind === savedKind) {
      // Encoding restated as it is: keep the saved body.
    } else if (kind === 'json') {
      if (spec.body === undefined && savedParams.length) problems.push('pass body together with bodyType "json", or the saved form fields would be lost.')
      let text = spec.body ?? ''
      if (isCutCopy(text, savedText)) text = savedText
      // The JSON body is a JS expression evaluated and passed to JSON.stringify at run time.
      const p = text.trim() ? checkExpression(text) : undefined
      if (p) problems.push(`body: ${p}`)
      postData = { mimeType: 'application/json', text, params: [] }
    } else {
      if (!spec.formFields && savedKind === 'json' && savedText.trim()) {
        problems.push(`pass formFields together with bodyType "${kind}", or the saved JSON body would be lost.`)
      }
      // form <-> multipart without formFields keeps the fields and changes only the encoding.
      const params = spec.formFields ? restorePairs(spec.formFields, savedParams, 'form field', problems) : savedKind === 'json' ? [] : savedParams
      for (const p of params) {
        const tp = checkTemplateText(p.value)
        if (tp) problems.push(`${p.name}: ${tp}`)
      }
      postData = { mimeType: kind === 'form' ? 'application/x-www-form-urlencoded' : 'multipart/form-data', text: '', params }
    }
  }
  return { code: { ...existing, url, method, headers, queryString, postData }, problems }
}

export function apiBody(
  c: SaveCommon,
  code: Record<string, unknown>,
  extra: { dynamicVariables?: Record<string, unknown>; authId?: unknown },
): Record<string, unknown> {
  const body: Record<string, unknown> = { type: 'api', ...common(c), code }
  if (extra.dynamicVariables && Object.keys(extra.dynamicVariables).length) body.dynamicVariables = extra.dynamicVariables
  if (typeof extra.authId === 'string' && extra.authId) body.auth_id = extra.authId
  return body
}

/** Full plugin code: the action's pluginData with filled selectedValues. inputJson is mandatory for the save. */
export function pluginBody(c: SaveCommon, base: PluginData, authData: AuthData, inputData: Record<string, unknown>): Record<string, unknown> {
  const actionVersionId = str(base.actionVersionId)
  if (!actionVersionId) throw new ToolError('This app step has no action version; delete it and add it again.')
  const inputJson = isRecord(base.inputJson) ? base.inputJson : { steps: { root: [] }, blocks: {} }
  const code: PluginData = {
    ...base,
    inputJson,
    actionVersionId,
    selectedValues: { ...(isRecord(base.selectedValues) ? base.selectedValues : {}), authData, inputData },
  }
  if ((JSON.stringify(code) ?? '').length > MAX_CODE_CHARS) throw new ToolError('The step configuration is too large to save.')
  return {
    type: 'plugin',
    ...common({ ...c, iconUrl: c.iconUrl ?? base.iconUrl }),
    code,
    auth_id: authData.id,
    action_id: actionVersionId,
  }
}

export function variableBody(c: SaveCommon, expression: string): Record<string, unknown> {
  return { type: 'variable', ...common(c), data: expression, html: expression }
}

export function ifBlockBody(c: SaveCommon, condition: string, statement: string, dynamicVariables: unknown): Record<string, unknown> {
  return {
    type: 'ifBlock',
    ...common({ ...c, sampleData: undefined }),
    condition,
    html: condition,
    statement,
    dynamicVariables: isRecord(dynamicVariables) ? dynamicVariables : {},
  }
}

export function commentBody(c: SaveCommon, text: string, metadata: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { type: 'comment', title: c.title, stepId: c.stepId, data: text }
  if (isRecord(metadata)) body.metadata = metadata
  return body
}

export function breakBody(c: SaveCommon, data: string, mode: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { type: 'break', title: c.title, stepId: c.stepId, data, _data: '' }
  if (typeof mode === 'string' && mode) body.mode = mode
  return body
}

export function responseBody(responseType: 'default' | 'custom', data: string, customHeaders: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: 'response',
    stepId: 'response',
    title: 'response',
    responseType,
    data: responseType === 'default' ? '' : data,
    _data: responseType === 'default' ? '' : data,
    isAIGenerated: false,
  }
  if (isRecord(customHeaders)) body.customHeaders = customHeaders
  return body
}
