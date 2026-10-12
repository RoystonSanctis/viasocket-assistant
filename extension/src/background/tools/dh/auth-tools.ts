// Connection (oauth_details) tools, following the skill's connection rules:
// - create: the connection-KB "Create Payload" with every key, client ID/secret always empty;
// - existing rows: a non-breaking change on an unused connection of an unpublished plug is saved in place, then the
//   plug is MERGEd (that is what clears the runtime's cached auth settings); a breaking change (type and grant
//   included), or any change to a connection in use or on a published plug, is COPIED into a new version that becomes
//   the plug's default (existing actions stay on the old one).
// Client secrets never reach the model: they are never fetched into results, never copied, never accepted, and
// secret-looking values hardcoded in connection code or request params are masked when read.

import * as z from '../../../shared/zod'
import type { Tool, ToolContext } from '../types'
import { checkFunctionCode } from '../flow/js-check'
import { authUsageCounts, dhCreate, dhGet, dhGetOne, dhMerge, dhUpdate, fail } from './api'
import { P, dhTool, hostname, rowId } from './define'
import { SECRET_MASK, maskSecrets, maskSecretsDeep } from './text-guards'
import {
  authFieldsOf, authVersionNumber, clip, decodeAuthCode, encodeAuthCode, obj, parseQueryParams, rowsOf, sameJson, str,
  type Row,
} from './rows'
import { syncConnection } from './sync'
import { authOpen, pageAuthId, requirePluginId } from './target'

const AUTH_CODE_FIELDS = ['testcode', 'accesstokencode', 'refreshtokencode', 'revokeapicode'] as const
type AuthCodeField = (typeof AUTH_CODE_FIELDS)[number]

const AUTH_FULL_PARTS = [...AUTH_CODE_FIELDS, 'authfields', 'authenticationpaths'] as const
const GRANT_TYPES = ['Authorization Code', 'Implicit', 'Client Credentials', 'Password Credentials'] as const
const AUTH_TYPES = ['Basic', 'Auth2.0', 'Auth1', 'NoAuth'] as const
const SIGNATURE_METHODS = ['HMAC-SHA1', 'HMAC-SHA256', 'RSA-SHA1', 'PLAINTEXT'] as const

// Copied into a new version. Everything else (rowid, orgid, metadata, audit, joined and UI-only keys) is dropped,
// and so is clientsecret: it is encrypted at rest and the skill never copies it.
const AUTH_COPY_KEYS = [
  'type', 'granttype', 'description', 'authfields', 'clientid', 'authrequrl', 'queryparams', 'scopeseperatedby',
  'redirecturl', 'accesstokencode', 'refreshtokencode', 'testcode', 'revokeapicode', 'connectionlabelkey',
  'connectionlabelvalue', '_connectionlabelvalue', 'isconnectionlabelmasked', 'iconurlpath', 'uniquekeytostoreauth',
  'authenticationpaths', 'skipwhitelistvalidation', 'whitelistdomains', 'auth1parameters',
] as const

const CODE_LABELS: Record<AuthCodeField, string> = {
  testcode: 'test code',
  accesstokencode: 'access token code',
  refreshtokencode: 'refresh token code',
  revokeapicode: 'revoke code',
}

const NULL_CODE = JSON.stringify({ source: null })

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function authFieldsType(type: string | undefined): string {
  return type === 'Auth2.0' ? 'Auth2.0' : type === 'NoAuth' ? 'noauth' : type === 'Auth1' ? 'Auth1' : 'basic'
}

function sortedAuths(rows: Row[]): Row[] {
  return rows.slice().sort((x, y) => authVersionNumber(x) - authVersionNumber(y))
}

function nextAuthVersion(rows: Row[]): string {
  return `V${Math.max(0, ...rows.map(authVersionNumber)) + 1}`
}

function hostList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : []
}

function codeError(where: string, src: string, mustReturn: boolean): string | undefined {
  if (!src.trim()) return undefined
  const r = checkFunctionCode(src)
  if (r.error) return `${where}: ${r.error}`
  if (mustReturn && r.warning) return `${where} must return a value.`
  return undefined
}

/** Connection code with hardcoded secret-looking values masked (a developer may have pasted a partner key). */
function safeCode(v: unknown, counter: { masked: number }): string {
  const r = maskSecrets(decodeAuthCode(v))
  counter.masked += r.masked
  return r.text
}

function safeJson(v: unknown, counter: { masked: number }): unknown {
  const r = maskSecretsDeep(v ?? null)
  counter.masked += r.masked
  return r.value
}

function authSummary(a: Row, defaultId: string | undefined, usage: Map<string, number> | undefined, codeMax: number, counter: { masked: number }) {
  const id = str(a.rowid)
  const code: Partial<Record<AuthCodeField, string>> = {}
  for (const f of AUTH_CODE_FIELDS) {
    const src = safeCode(a[f], counter)
    if (src.trim()) code[f] = clip(src, codeMax)
  }
  const paths = safeJson(a.authenticationpaths, counter)
  const pathsJson = JSON.stringify(paths ?? null) ?? 'null'
  return {
    id,
    version: str(a.authversion),
    type: str(a.type),
    grantType: str(a.granttype),
    isDefault: !!id && id === defaultId,
    usedByActionVersions: id ? (usage ? (usage.get(id) ?? 0) : 'unknown') : undefined,
    credentialFields: authFieldsOf(a).map((f) => ({ key: str(f.key), label: str(f.label), type: str(f.type), required: f.required === true })),
    code,
    authUrl: str(a.authrequrl),
    queryParams: safeJson(parseQueryParams(a.queryparams), counter),
    scopeSeparator: str(a.scopeseperatedby),
    clientIdSet: !!str(a.clientid),
    clientSecretSet: !!str(a.clientsecret),
    requestParams: pathsJson.length <= 1500 ? paths : clip(pathsJson, 1500),
    connectionLabel: str(a.connectionlabelkey) ? { key: str(a.connectionlabelkey), value: str(a.connectionlabelvalue) } : undefined,
    uniqueKey: str(a.uniquekeytostoreauth),
    whitelistDomains: a.whitelistdomains,
  }
}

// ---------- dh_list_auth_versions ----------

const listAuthVersions = dhTool({
  name: 'dh_list_auth_versions',
  description:
    "List a plug's connection (auth) versions in detail: type (Basic = API key / custom fields, Auth2.0, Auth1, NoAuth), grant " +
    'type, the credential fields users fill in, auth endpoints and scopes, request headers/params injected into every call, ' +
    'connection label, test/token code (truncated) and how many action versions use each. Pass authId plus `full` for one ' +
    'part untruncated. Secrets are never returned (only whether they are set); secret-looking values hardcoded in code or ' +
    `request params are shown as "${SECRET_MASK}" and must never be written back.`,
  properties: {
    pluginId: P.pluginId,
    authId: { ...P.authId, description: 'Only this connection version (defaults to all).' },
    full: { type: 'string', enum: [...AUTH_FULL_PARTS], description: 'With authId: return only this part, untruncated.' },
  },
  danger: 'safe',
  schema: z.object({ pluginId: rowId.optional(), authId: rowId.optional(), full: z.enum(AUTH_FULL_PARTS).optional() }),
  describe: () => 'Checking connection versions',
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    const [plugin, rows, usage] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId),
      authUsageCounts(ctx, pluginId),
    ])
    const defaultId = str(plugin.preferedauthversion)
    const sorted = sortedAuths(rows)
    const counter = { masked: 0 }
    const maskNote = () =>
      counter.masked ? { secretsMasked: counter.masked, maskNote: `Secret-looking values were replaced by "${SECRET_MASK}". Never write that placeholder back; ask the developer to move the secret into a credential field.` } : {}

    if (a.authId) {
      const one = sorted.find((r) => r.rowid === a.authId)
      if (!one) fail(`Connection version ${a.authId} does not belong to plug ${pluginId}.`)
      const budget = Math.max(2000, ctx.maxResultChars - 800)
      if (a.full === 'authfields' || a.full === 'authenticationpaths') {
        const value = safeJson(one[a.full], counter)
        const json = JSON.stringify(value ?? null) ?? 'null'
        return { authId: a.authId, part: a.full, value: json.length <= budget ? value : clip(json, budget), ...maskNote() }
      }
      if (a.full) return { authId: a.authId, part: a.full, code: clip(safeCode(one[a.full], counter), budget), ...maskNote() }
      const connection = authSummary(one, defaultId, usage, 2500, counter)
      return { pluginId, connection, open: authOpen(pluginId, a.authId), ...maskNote() }
    }
    if (a.full) fail('Pass authId together with `full`.')
    const connections = sorted.map((r) => authSummary(r, defaultId, usage, 700, counter))
    return {
      pluginId,
      defaultAuthId: defaultId,
      connections,
      ...maskNote(),
      ...(sorted.length ? {} : { tip: 'No connection yet: create one with dh_create_connection.' }),
    }
  },
})

// ---------- shared argument schemas ----------

const codeSource = z.string().max(100_000)
const authField = z.looseObject({
  key: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be an identifier like api_key'),
  label: z.string().trim().min(1).max(120),
  type: z.enum(['string', 'password', 'dropdown', 'help']),
  required: z.boolean().optional(),
  help: z.string().max(2000).optional(),
  placeholder: z.string().max(500).optional(),
  source: z.string().max(20_000).optional(),
  visibilityCondition: z.string().max(2000).optional(),
})
const nameValue = z.object({ name: z.string().trim().min(1).max(200), value: z.string().max(5000) })
const requestParamsSchema = z.object({
  headers: z.array(nameValue).max(30).optional(),
  queryParams: z.array(nameValue).max(30).optional(),
  body: z.array(nameValue).max(30).optional(),
})
const codeSchema = z.object({
  testcode: codeSource.optional(),
  accesstokencode: codeSource.optional(),
  refreshtokencode: codeSource.optional(),
  revokeapicode: codeSource.optional(),
})
/** https URL that may contain ${context…} templates (the authorize URL supports interpolation). */
const templateHttpsUrl = z.string().trim().min(9).max(2000).regex(/^https:\/\/\S+$/, 'must be an https URL')
const queryParamsSchema = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(2000))
const labelSchema = z.object({ key: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(500) })

const CODE_PROP = {
  type: 'object',
  description:
    'Raw JavaScript function bodies (stored as {"source"} strings for you) using context.authData (credential field values, ' +
    'e.g. context.authData.api_key; for OAuth also context.authData.accesstokencode) and axios. testcode calls a cheap "who am ' +
    'I" endpoint and returns its data (the connection label reads it). Follow dh-connection-kb.md.',
  properties: {
    testcode: { type: 'string' },
    accesstokencode: { type: 'string' },
    refreshtokencode: { type: 'string' },
    revokeapicode: { type: 'string' },
  },
  additionalProperties: false,
}
const AUTH_FIELDS_PROP = {
  type: 'array',
  description: 'Credential inputs users fill in when connecting (Basic; also Client/Password Credentials). Never secrets\' values.',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Identifier, read as context.authData.<key>' },
      label: { type: 'string' },
      type: { type: 'string', enum: ['string', 'password', 'dropdown', 'help'] },
      required: { type: 'boolean' },
      help: { type: 'string' },
      placeholder: { type: 'string' },
    },
    required: ['key', 'label', 'type'],
  },
}
const NV_ITEMS = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } }
const REQUEST_PARAMS_PROP = {
  type: 'object',
  description:
    'Injected into every API request made with this connection (each list replaces the existing one). Values are JS bodies ' +
    'that return the value, e.g. "return `Bearer ${context.authData.api_key}`".',
  properties: { headers: NV_ITEMS, queryParams: NV_ITEMS, body: NV_ITEMS },
  additionalProperties: false,
}
const LABEL_PROP = {
  type: 'object',
  description: 'How connections are named, e.g. {key:"email", value:"${context.data.email}"} (context.data is the test code result).',
  properties: { key: { type: 'string' }, value: { type: 'string' } },
  required: ['key', 'value'],
  additionalProperties: false,
}

function checkCodeArgs(code: z.infer<typeof codeSchema> | undefined, requestParams: z.infer<typeof requestParamsSchema> | undefined): void {
  const values = [
    ...AUTH_CODE_FIELDS.map((f) => code?.[f]),
    ...[requestParams?.headers, requestParams?.queryParams, requestParams?.body].flatMap((l) => (l ?? []).map((p) => p.value)),
  ]
  if (values.some((v) => typeof v === 'string' && v.includes(SECRET_MASK))) {
    fail(`The code contains the "${SECRET_MASK}" placeholder from a masked read; writing it would break the connection. Keep the original value (edit in the Developer Hub) or move the secret into a credential field.`)
  }
  for (const f of AUTH_CODE_FIELDS) {
    const src = code?.[f]
    const err = src === undefined ? undefined : codeError(CODE_LABELS[f], src, f === 'testcode' || f === 'accesstokencode')
    if (err) fail(err)
  }
  for (const list of [requestParams?.headers, requestParams?.queryParams, requestParams?.body]) {
    for (const p of list ?? []) {
      if (!/\breturn\b/.test(p.value)) fail(`Request param ${p.name}: the value must be a function body that returns, e.g. "return \`Bearer \${context.authData.api_key}\`".`)
      const r = checkFunctionCode(p.value)
      if (r.error) fail(`Request param ${p.name}: ${r.error}`)
    }
  }
}

function authPaths(rp: z.infer<typeof requestParamsSchema> | undefined, current?: Row): Row {
  const cur = obj(current?.authenticationpaths) ?? {}
  return {
    headers: rp?.headers ?? rowsOf(cur.headers),
    body: rp?.body ?? rowsOf(cur.body),
    queryParams: rp?.queryParams ?? rowsOf(cur.queryParams),
  }
}

/** What the plug's metadata.aiContext.auth records about a connection (skill: type etc.; never secrets). */
function authFacts(row: Row): Row {
  const facts: Row = { type: str(row.type), connectionVersion: str(row.authversion) }
  const grant = str(row.granttype)
  if (grant) facts.grantType = grant
  const scope = parseQueryParams(row.queryparams).scope
  if (typeof scope === 'string' && scope.trim()) facts.scopes = clip(scope, 300)
  return facts
}

/**
 * The plug MERGE after a connection write (skill: "the write, then MERGE the plug"): the default connection when
 * asked, every new host whitelisted, and metadata.aiContext.auth. With `always` the MERGE runs even with nothing else
 * to change, because a plug update is what clears the runtime's cached auth settings for every connection of the plug.
 */
async function mergePlugAfterConnection(
  ctx: ToolContext,
  plugin: Row,
  authId: string,
  hosts: string[],
  setDefault: boolean,
  note: string,
  extra: { always?: boolean; auth?: Row } = {},
): Promise<string[]> {
  const notes: string[] = []
  const pluginId = String(plugin.rowid)
  const current = hostList(plugin.whitelistdomains)
  const added = hosts.filter((h) => !current.includes(h))
  const changes: Row = {}
  if (setDefault && str(plugin.preferedauthversion) !== authId) changes.preferedauthversion = authId
  if (added.length) changes.whitelistdomains = [...current, ...added]
  if (!Object.keys(changes).length && !extra.always && !extra.auth) return notes
  try {
    await dhMerge(ctx, 'plugins', pluginId, changes, { note, skill: 'connection', ...(extra.auth ? { aiContext: { auth: extra.auth } } : {}) })
    if (changes.preferedauthversion) notes.push("Set as the plug's default connection version.")
    if (added.length) notes.push(`Added ${added.join(', ')} to the plug's whitelisted hosts.`)
    if (extra.always) notes.push("The plug was saved too, which clears viaSocket's cached connection settings.")
  } catch (e) {
    notes.push(
      `Could not update the plug (${(e as Error).message}); ` +
        (extra.always ? 'viaSocket may keep using the cached connection settings until the plug is saved (e.g. dh_update_plugin with a note). ' : '') +
        'Set the default connection / hosts with dh_update_plugin.',
    )
  }
  return notes
}

// ---------- dh_create_connection ----------

const createSchema = z.object({
  pluginId: rowId.optional(),
  type: z.enum(AUTH_TYPES),
  grantType: z.enum(GRANT_TYPES).optional(),
  authFields: z.array(authField).max(30).optional(),
  code: codeSchema.optional(),
  authRequestUrl: templateHttpsUrl.optional(),
  scopes: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  queryParams: queryParamsSchema.optional(),
  scopeSeparator: z.enum(['space', 'comma']).optional(),
  requestParams: requestParamsSchema.optional(),
  connectionLabel: labelSchema.optional(),
  isConnectionLabelMasked: z.boolean().optional(),
  uniqueKey: z.string().trim().max(300).optional(),
  description: z.string().trim().max(500).optional(),
  whitelistDomains: z.array(hostname).max(30).optional(),
  auth1Parameters: z
    .object({
      requestTokenUrl: templateHttpsUrl,
      authorizeUrl: templateHttpsUrl,
      accessTokenUrl: templateHttpsUrl,
      signatureMethod: z.enum(SIGNATURE_METHODS),
    })
    .optional(),
})

const createConnection = dhTool({
  name: 'dh_create_connection',
  description:
    "Create a connection (auth) version on a plug with the connection KB's full create payload: the first one is V1, later " +
    'ones V<n+1>. To change the auth type or grant of an existing connection use dh_update_auth_version (type/grantType): ' +
    'it copies the connection into a new default version. Client ID/secret are always left empty: the developer enters them in ' +
    'the Developer Hub; never ask for credentials in chat. Prefer Auth2.0 when documented (KB priority). The connection ' +
    "label is mandatory except for NoAuth. If the plug has no default connection, this one becomes it. Read " +
    'dh-connection-kb.md first. Next: dh_check_connection / dh_connect.',
  properties: {
    pluginId: P.pluginId,
    type: { type: 'string', enum: [...AUTH_TYPES], description: 'Basic = API key / custom fields; Auth2.0 = OAuth 2; Auth1 = OAuth 1.0; NoAuth.' },
    grantType: { type: 'string', enum: [...GRANT_TYPES], description: 'Auth2.0 only (default Authorization Code).' },
    authFields: AUTH_FIELDS_PROP,
    code: CODE_PROP,
    authRequestUrl: { type: 'string', description: 'OAuth authorize URL (https; ${context…} templates allowed).' },
    scopes: { type: 'array', items: { type: 'string' }, description: 'Minimal OAuth scopes for the connection/test API.' },
    queryParams: { type: 'object', description: 'Extra authorize-URL query params (string values).' },
    scopeSeparator: { type: 'string', enum: ['space', 'comma'], description: 'Auth2.0: how scopes are joined (default space).' },
    requestParams: REQUEST_PARAMS_PROP,
    connectionLabel: LABEL_PROP,
    isConnectionLabelMasked: { type: 'boolean', description: 'Mask the label in the UI (default false).' },
    uniqueKey: { type: 'string', description: 'Template that de-duplicates connections of the same account.' },
    description: { type: 'string', description: 'Optional description of this connection version.' },
    whitelistDomains: { type: 'array', items: { type: 'string' }, description: 'API hosts this connection calls. Default: the plug\'s hosts and domain.' },
    auth1Parameters: {
      type: 'object',
      description: 'Auth1 only.',
      properties: {
        requestTokenUrl: { type: 'string' },
        authorizeUrl: { type: 'string' },
        accessTokenUrl: { type: 'string' },
        signatureMethod: { type: 'string', enum: [...SIGNATURE_METHODS] },
      },
      required: ['requestTokenUrl', 'authorizeUrl', 'accessTokenUrl', 'signatureMethod'],
      additionalProperties: false,
    },
  },
  required: ['type'],
  danger: 'write',
  schema: createSchema,
  describe: (a) => `Creating a ${a.type} connection`,
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    if (a.grantType && a.type !== 'Auth2.0') fail('grantType only applies to type "Auth2.0".')
    if (a.auth1Parameters && a.type !== 'Auth1') fail('auth1Parameters only apply to type "Auth1".')
    const grant = a.type === 'Auth2.0' ? (a.grantType ?? 'Authorization Code') : undefined
    if ((grant === 'Authorization Code' || grant === 'Implicit') && !a.authRequestUrl) fail('OAuth Authorization Code / Implicit needs authRequestUrl.')
    if (a.type === 'Auth1' && !a.auth1Parameters) fail('Auth1 needs auth1Parameters.')
    if (a.type !== 'NoAuth' && !a.code?.testcode?.trim()) fail('Pass code.testcode: a cheap "who am I" call that returns the account data.')
    if (grant && grant !== 'Implicit' && !a.code?.accesstokencode?.trim()) fail(`${grant} needs code.accesstokencode.`)
    if (a.type === 'Basic' && !a.authFields?.length) fail('Basic connections need authFields (e.g. an api_key password field).')
    if (a.type !== 'NoAuth' && !a.connectionLabel) fail('connectionLabel is mandatory: e.g. {key:"email", value:"${context.data.email}"}.')
    checkCodeArgs(a.code, a.requestParams)

    const [plugin, versions] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId),
    ])
    if (str(plugin.status) === 'deleted') fail(`Plug ${pluginId} is deleted.`)
    const labelArg = a.connectionLabel ?? { key: 'name', value: str(plugin.name) ?? 'Connection' }
    const authBase = ctx.vs.env.authBase
    const separator = a.scopeSeparator ?? 'space'
    const query: Record<string, unknown> = { ...(a.queryParams ?? {}) }
    if (a.type === 'Auth2.0') {
      if (a.scopes) query.scope = a.scopes.join(separator === 'comma' ? ',' : ' ')
      query.scope ??= ''
      query.response_type ??= grant === 'Authorization Code' ? 'code' : grant === 'Implicit' ? 'token' : ''
    } else if (a.type === 'NoAuth') {
      query.scope ??= ''
      query.response_type ??= ''
    } else if (a.scopes) {
      fail('scopes only apply to Auth2.0 connections.')
    }
    const hosts = [...new Set([...(a.whitelistDomains ?? []), ...hostList(plugin.whitelistdomains), ...(str(plugin.domain) ? [String(plugin.domain)] : [])])]
    const version = nextAuthVersion(versions)

    const body: Row = {
      type: a.type,
      authversion: version,
      granttype: grant ?? null,
      pluginrecordid: pluginId,
      redirecturl: `${authBase}/redirect/${a.type === 'Basic' || a.type === 'Auth1' ? 'auth1' : 'auth2.0'}`,
      queryparams: JSON.stringify(query),
      isconnectionlabelmasked: a.isConnectionLabelMasked ?? false,
      authfields: { authentication: { type: authFieldsType(a.type), fields: a.authFields ?? [] } },
      testcode: a.code?.testcode !== undefined ? encodeAuthCode(a.code.testcode) : NULL_CODE,
      accesstokencode: a.code?.accesstokencode !== undefined ? encodeAuthCode(a.code.accesstokencode) : NULL_CODE,
      refreshtokencode: a.code?.refreshtokencode !== undefined ? encodeAuthCode(a.code.refreshtokencode) : NULL_CODE,
      revokeapicode: a.code?.revokeapicode !== undefined ? encodeAuthCode(a.code.revokeapicode) : NULL_CODE,
      authenticationpaths: authPaths(a.requestParams),
      scopeseperatedby: a.type === 'Auth2.0' ? separator : null,
      clientid: '',
      clientsecret: '',
      connectionlabelkey: labelArg.key,
      connectionlabelvalue: labelArg.value,
      _connectionlabelvalue: escapeHtml(labelArg.value),
      iconurlpath: '',
      whitelistdomains: hosts,
      ...(a.uniqueKey ? { uniquekeytostoreauth: a.uniqueKey } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(a.auth1Parameters ? { auth1parameters: a.auth1Parameters } : {}),
    }
    const { rows } = await dhCreate(ctx, 'oauth_details', body)
    const row = rows[0]
    const authId = str(row?.rowid)
    if (!row || !authId) fail('viaSocket did not return the new connection id. Check dh_get_plugin before retrying.')

    const notes = await mergePlugAfterConnection(ctx, plugin, authId, hosts, !str(plugin.preferedauthversion), 'connection created', {
      auth: authFacts({ ...body, authversion: version }),
    })
    if (versions.length) notes.push('Existing connection versions and the actions using them are unchanged.')
    const { clientsecret: _s, ...safeBody } = body
    const page = await syncConnection(ctx, pluginId, { kind: 'create', requestPayload: safeBody, row })
    const developerEnters =
      a.type === 'Auth2.0' || a.type === 'Auth1'
        ? 'The developer must save the app\'s client ID and secret on this connection in the Developer Hub before anyone can connect.'
        : a.type === 'NoAuth'
          ? 'Nothing to enter.'
          : 'Nothing for the developer; users type their own credentials when they connect.'
    return {
      authId,
      version,
      type: a.type,
      ...(grant ? { grantType: grant } : {}),
      developerEnters,
      ...(notes.length ? { notes } : {}),
      ...(page ? { page } : {}),
      open: authOpen(pluginId, authId),
      next: 'Check for a working connection with dh_check_connection (or open the connection window with dh_connect).',
    }
  },
})

// ---------- dh_update_auth_version ----------

const auth1Schema = z.object({
  requestTokenUrl: templateHttpsUrl,
  authorizeUrl: templateHttpsUrl,
  accessTokenUrl: templateHttpsUrl,
  signatureMethod: z.enum(SIGNATURE_METHODS),
})

const updateSchema = z.object({
  pluginId: rowId.optional(),
  authId: rowId.optional(),
  createNewVersion: z.boolean().optional(),
  type: z.enum(AUTH_TYPES).optional(),
  grantType: z.enum(GRANT_TYPES).optional(),
  auth1Parameters: auth1Schema.optional(),
  code: codeSchema.optional(),
  authFields: z.array(authField).max(30).optional(),
  authRequestUrl: templateHttpsUrl.optional(),
  scopes: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  queryParams: queryParamsSchema.optional(),
  scopeSeparator: z.enum(['space', 'comma']).optional(),
  requestParams: requestParamsSchema.optional(),
  connectionLabel: labelSchema.optional(),
  uniqueKey: z.string().trim().max(300).optional(),
  whitelistDomains: z.array(hostname).max(30).optional(),
  description: z.string().trim().max(500).optional(),
})
type UpdateArgs = z.infer<typeof updateSchema>

/** Only the keys whose stored value would actually change, in the stored encoding. */
function buildChanges(a: UpdateArgs, current: Row, inPlace: boolean): Row {
  const out: Row = {}
  const set = (k: string, v: unknown) => {
    if (!sameJson(current[k] ?? null, v)) out[k] = v
  }
  for (const f of AUTH_CODE_FIELDS) {
    const src = a.code?.[f]
    if (src !== undefined && decodeAuthCode(current[f]) !== src) out[f] = encodeAuthCode(src)
  }
  if (a.authFields) {
    const auth = obj(obj(current.authfields)?.authentication) ?? {}
    set('authfields', { authentication: { ...auth, type: str(auth.type) ?? authFieldsType(str(current.type)), fields: a.authFields } })
  }
  if (a.authRequestUrl !== undefined) set('authrequrl', a.authRequestUrl)

  const oldSeparator = str(current.scopeseperatedby) === 'comma' ? 'comma' : 'space'
  const separator = a.scopeSeparator ?? oldSeparator
  const sepChar = (s: 'comma' | 'space') => (s === 'comma' ? ',' : ' ')
  const before = parseQueryParams(current.queryparams)
  let query: Record<string, unknown> | undefined
  if (a.queryParams || a.scopes) {
    query = { ...before, ...a.queryParams }
    if (a.scopes) query.scope = a.scopes.join(sepChar(separator))
  }
  const rejoin = separator !== oldSeparator
  // The stored scope string is re-joined here: the server only rewrites it when queryparams is in the body.
  if (rejoin && !a.scopes) {
    query ??= { ...before }
    if (typeof query.scope === 'string') {
      query.scope = query.scope
        .split(sepChar(oldSeparator))
        .map((s) => s.trim())
        .filter(Boolean)
        .join(sepChar(separator))
    }
  }
  const hasScope = rejoin && typeof query?.scope === 'string'
  if (query && (hasScope || !sameJson(before, query))) out.queryparams = JSON.stringify(query)
  if (a.scopeSeparator && a.scopeSeparator !== str(current.scopeseperatedby)) {
    out.scopeseperatedby = a.scopeSeparator
    // Makes the server rewrite the scopes cached on action versions; without a queryparams scope string in the
    // body that rewrite throws and is silently skipped.
    if (inPlace && hasScope) out.isScopeSeperatorChanged = true
  }
  if (a.requestParams) set('authenticationpaths', authPaths(a.requestParams, current))
  if (a.connectionLabel) {
    set('connectionlabelkey', a.connectionLabel.key)
    set('connectionlabelvalue', a.connectionLabel.value)
    // The label editor renders this HTML twin; keep it in step so the page does not show the old label.
    if ('connectionlabelkey' in out || 'connectionlabelvalue' in out) out._connectionlabelvalue = escapeHtml(a.connectionLabel.value)
  }
  if (a.uniqueKey !== undefined) set('uniquekeytostoreauth', a.uniqueKey)
  if (a.whitelistDomains) set('whitelistdomains', [...new Set([...hostList(current.whitelistdomains), ...a.whitelistDomains])])
  if (a.description !== undefined) set('description', a.description)
  return out
}

/** Skill: breaking = type, grant, scopes, field keys, token URLs, auth header shape (plus required fields and dedupe key). */
function breakingReasons(changes: Row, a: UpdateArgs, current: Row): string[] {
  const out: string[] = []
  if ('queryparams' in changes || 'scopeseperatedby' in changes) out.push('scopes / authorize parameters')
  if ('authrequrl' in changes) out.push('authorize URL')
  if ('accesstokencode' in changes) out.push('access token code (token URL)')
  if ('authenticationpaths' in changes) out.push('auth header / request params')
  if ('uniquekeytostoreauth' in changes) out.push('unique key')
  if ('authfields' in changes && a.authFields) {
    const old = new Map(authFieldsOf(current).map((f) => [str(f.key), f]))
    const added = a.authFields.filter((f) => !old.has(f.key))
    if (added.some((f) => f.required === true)) out.push('new required credential field')
    if (a.authFields.some((f) => old.has(f.key) && f.required === true && old.get(f.key)?.required !== true)) out.push('field made required')
    if (a.authFields.some((f) => old.has(f.key) && f.type !== str(old.get(f.key)?.type))) out.push('field type changed')
  }
  return out
}

function changeLabels(a: UpdateArgs): string[] {
  const out: string[] = []
  if (a.type) out.push(`auth type (${a.type})`)
  if (a.grantType) out.push(`grant type (${a.grantType})`)
  if (a.auth1Parameters) out.push('OAuth 1.0 endpoints')
  for (const f of AUTH_CODE_FIELDS) if (a.code?.[f] !== undefined) out.push(CODE_LABELS[f])
  if (a.authFields) out.push('credential fields')
  if (a.authRequestUrl !== undefined) out.push('authorize URL')
  if (a.scopes || a.queryParams) out.push('scopes/query params')
  if (a.scopeSeparator) out.push('scope separator')
  if (a.requestParams) out.push('request headers/params')
  if (a.connectionLabel) out.push('connection label')
  if (a.uniqueKey !== undefined) out.push('unique key')
  if (a.whitelistDomains) out.push('whitelisted hosts')
  if (a.description !== undefined) out.push('description')
  return out
}

/** Skill "Existing rows": a type or grant change is breaking, so it always becomes a new default version. */
interface TypeChange {
  type: string
  grant: string | undefined
  /** what changed, for the report */
  what: string[]
}

function typeChangeOf(a: UpdateArgs, current: Row): TypeChange | undefined {
  const curType = str(current.type)
  const type = a.type ?? curType ?? 'Basic'
  if (a.grantType && type !== 'Auth2.0') fail('grantType only applies to type "Auth2.0".')
  if (a.auth1Parameters && type !== 'Auth1') fail('auth1Parameters only apply to type "Auth1".')
  const typeChanged = !!a.type && a.type !== curType
  const curGrant = str(current.granttype)
  const grant = type === 'Auth2.0' ? (a.grantType ?? (typeChanged ? 'Authorization Code' : curGrant)) : undefined
  const grantChanged = type === 'Auth2.0' && !!grant && grant !== curGrant
  const auth1Changed = !!a.auth1Parameters && !sameJson(current.auth1parameters ?? null, a.auth1Parameters)
  const what = [
    ...(typeChanged ? [`type ${curType ?? '?'} → ${type}`] : []),
    ...(grantChanged && !typeChanged ? [`grant ${curGrant ?? 'none'} → ${grant}`] : []),
    ...(auth1Changed ? ['OAuth 1.0 endpoints'] : []),
  ]
  return what.length ? { type, grant, what } : undefined
}

/** Rewrites a copied body for another auth type / grant, the way dh_create_connection builds one, and validates it. */
function applyTypeChange(body: Row, tc: TypeChange, a: UpdateArgs, current: Row, authBase: string): void {
  const { type, grant } = tc
  const auth = obj(obj(body.authfields)?.authentication) ?? {}
  // Credential inputs carry over only where the new type still uses them (Basic, client/password credentials).
  const keepFields = str(current.type) === type || type === 'Basic' || grant === 'Client Credentials' || grant === 'Password Credentials'
  const fields = a.authFields ?? (keepFields ? rowsOf(auth.fields) : [])
  body.type = type
  body.granttype = grant ?? null
  body.redirecturl = `${authBase}/redirect/${type === 'Basic' || type === 'Auth1' ? 'auth1' : 'auth2.0'}`
  body.scopeseperatedby = type === 'Auth2.0' ? (a.scopeSeparator ?? (str(current.scopeseperatedby) === 'comma' ? 'comma' : 'space')) : null
  body.authfields = { authentication: { ...auth, type: authFieldsType(type), fields } }
  const query = parseQueryParams(body.queryparams)
  if (type === 'Auth2.0') {
    query.scope ??= ''
    query.response_type = grant === 'Authorization Code' ? 'code' : grant === 'Implicit' ? 'token' : ''
  } else if (type === 'NoAuth') {
    query.scope ??= ''
    query.response_type ??= ''
  } else {
    delete query.response_type
    if (!str(query.scope)) delete query.scope
  }
  body.queryparams = JSON.stringify(query)
  // A different auth type never reuses the old client id (the secret is never copied anyway).
  if (str(current.type) !== type) body.clientid = ''
  if (type === 'Auth1') body.auth1parameters = a.auth1Parameters ?? current.auth1parameters
  else delete body.auth1parameters
  delete body.isScopeSeperatorChanged

  if ((grant === 'Authorization Code' || grant === 'Implicit') && !str(body.authrequrl)) fail(`${type} ${grant} needs authRequestUrl.`)
  if (grant && grant !== 'Implicit' && !decodeAuthCode(body.accesstokencode).trim()) fail(`${grant} needs code.accesstokencode.`)
  if (type === 'Basic' && !fields.length) fail('Basic connections need authFields (e.g. an api_key password field).')
  if (type !== 'NoAuth' && !decodeAuthCode(body.testcode).trim()) fail('Pass code.testcode: a cheap "who am I" call that returns the account data.')
  if (type === 'Auth1' && !obj(body.auth1parameters)) fail('Auth1 needs auth1Parameters.')
  if (type !== 'NoAuth' && !str(body.connectionlabelkey)) fail('connectionLabel is mandatory: e.g. {key:"email", value:"${context.data.email}"}.')
}

const updateAuthVersion = dhTool({
  name: 'dh_update_auth_version',
  description:
    "Change an existing connection (auth) version, deciding like the skill: a non-breaking change (label, help, test code, " +
    'optional field, host, refresh/revoke code) on a connection no action uses, on an unpublished plug, is saved in place ' +
    'and the plug is saved too (that clears viaSocket\'s cached connection settings); a breaking change (auth type or grant, ' +
    'scopes, authorize/token URL or code, header shape, required fields, unique key), or any change to a connection in use ' +
    'or on a published plug, is copied into a new version V<n+1> that becomes the plug\'s default (existing actions stay on ' +
    'the old one: say so in the report). createNewVersion:true always copies. Field keys can never be renamed or removed ' +
    '(except with a type change, in the new version). Only send what changes.',
  properties: {
    pluginId: P.pluginId,
    authId: { ...P.authId, description: 'Version to change. Defaults to the open connection page, else the default version.' },
    createNewVersion: { type: 'boolean', description: 'Always copy into a new version instead of editing in place.' },
    type: { type: 'string', enum: [...AUTH_TYPES], description: 'New auth type (always copied into a new default version).' },
    grantType: { type: 'string', enum: [...GRANT_TYPES], description: 'Auth2.0 grant (a change is always copied into a new default version).' },
    auth1Parameters: {
      type: 'object',
      description: 'Auth1 only: OAuth 1.0 endpoints (a change is always copied into a new default version).',
      properties: {
        requestTokenUrl: { type: 'string' },
        authorizeUrl: { type: 'string' },
        accessTokenUrl: { type: 'string' },
        signatureMethod: { type: 'string', enum: [...SIGNATURE_METHODS] },
      },
      required: ['requestTokenUrl', 'authorizeUrl', 'accessTokenUrl', 'signatureMethod'],
      additionalProperties: false,
    },
    code: CODE_PROP,
    authFields: { ...AUTH_FIELDS_PROP, description: 'Replaces the credential inputs; must keep every existing key (unless the type changes).' },
    authRequestUrl: { type: 'string', description: 'OAuth authorize URL (https).' },
    scopes: { type: 'array', items: { type: 'string' }, description: 'OAuth scopes; joined with the scope separator.' },
    queryParams: { type: 'object', description: 'Extra authorize-URL query params (string values), merged into the existing ones.' },
    scopeSeparator: { type: 'string', enum: ['space', 'comma'], description: 'How scopes are joined; stored scopes are re-joined.' },
    requestParams: REQUEST_PARAMS_PROP,
    connectionLabel: LABEL_PROP,
    uniqueKey: { type: 'string', description: 'Template that de-duplicates connections of the same account.' },
    whitelistDomains: { type: 'array', items: { type: 'string' }, description: 'API hosts to add to this connection (and the plug).' },
    description: { type: 'string' },
  },
  danger: 'confirm',
  schema: updateSchema,
  describe: (a) => (a.createNewVersion || a.type || a.grantType ? 'Creating a connection version' : 'Saving connection changes'),
  confirmText(a, ctx) {
    const parts = changeLabels(a)
    const open = pageAuthId(ctx)
    const target = a.authId ? `connection version ${a.authId}` : open ? `connection version ${open} (open on your screen)` : "the plug's default connection version"
    if (a.createNewVersion || a.type || a.grantType || a.auth1Parameters) {
      return (
        `Copy ${target} into a new connection version with changes to: ${parts.join(', ') || 'nothing'}, and make it the ` +
        "plug's default (if the type or grant does not actually change and nothing else is breaking, it may be edited in place). " +
        'Existing actions keep the old version.'
      )
    }
    return (
      `Change ${parts.join(', ') || 'settings'} of ${target}. If the change is breaking, or the connection is used by any ` +
      "action or the plug is published, a new connection version is created instead and made the plug's default (existing " +
      'actions stay on the old one); otherwise the version is edited in place and the plug is saved to clear cached settings.'
    )
  },
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    checkCodeArgs(a.code, a.requestParams)
    const [plugin, versions, usage] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId),
      authUsageCounts(ctx, pluginId),
    ])
    if (str(plugin.status) === 'deleted') fail(`Plug ${pluginId} is deleted.`)
    if (!versions.length) fail('This plug has no connection yet. Create one with dh_create_connection.')
    const defaultId = str(plugin.preferedauthversion)
    const authId = a.authId ?? pageAuthId(ctx) ?? defaultId
    if (!authId) fail('Which connection version? Pass authId (see dh_get_plugin).')
    const current = versions.find((v) => v.rowid === authId)
    if (!current) fail(`Connection version ${authId} does not belong to plug ${pluginId}.`)
    const typeChange = typeChangeOf(a, current)

    if (a.authFields && !(typeChange && a.type && a.type !== str(current.type))) {
      const keys = new Set(a.authFields.map((f) => f.key))
      const dropped = authFieldsOf(current).map((f) => str(f.key)).filter((k): k is string => !!k && !keys.has(k))
      if (dropped.length) fail(`Credential field keys can never be renamed or removed (every action reading them breaks): keep ${dropped.join(', ')}.`)
    }

    const inPlaceChanges = buildChanges(a, current, true)
    const changed = Object.keys(inPlaceChanges).filter((k) => k !== 'isScopeSeperatorChanged' && k !== '_connectionlabelvalue')
    if (!changed.length && !a.createNewVersion && !typeChange) {
      return { authId, version: str(current.authversion), changed: [], message: 'Nothing to change: the values already match.' }
    }
    const breaking = [...(typeChange?.what ?? []), ...breakingReasons(inPlaceChanges, a, current)]
    const usedBy = usage?.get(authId)
    const inUse = usedBy === undefined ? usage === undefined : usedBy > 0
    const published = str(plugin.status) === 'published' || str(plugin.status) === 'integration_only'
    const why = [
      ...(a.createNewVersion ? ['requested'] : []),
      ...(breaking.length ? [`breaking change (${breaking.join(', ')})`] : []),
      ...(inUse ? [usage ? `used by ${usedBy} action version(s)` : 'usage unknown, treated as in use'] : []),
      ...(published ? ['the plug is published'] : []),
    ]
    const newHosts = a.whitelistDomains ?? []

    if (!why.length) {
      await dhUpdate(ctx, 'oauth_details', 'updateAuthDetails', authId, { pluginrecordid: pluginId, rowid: authId, ...inPlaceChanges })
      // Skill: the write, THEN MERGE the plug: updateAuthDetails clears the runtime's cached auth settings only for a few
      // keys, while a plug update clears them for every connection of the plug.
      const notes = await mergePlugAfterConnection(ctx, plugin, authId, newHosts, false, 'connection updated', {
        always: true,
        auth: authFacts({ ...current, ...inPlaceChanges }),
      })
      const page = await syncConnection(ctx, pluginId, { kind: 'update', authId, requestPayload: inPlaceChanges })
      return {
        mode: 'edited in place',
        authId,
        version: str(current.authversion),
        changed,
        ...(notes.length ? { notes } : {}),
        ...(page ? { page } : {}),
        open: authOpen(pluginId, authId),
      }
    }

    // COPY: the source minus DB-managed keys and the secret, plus the change, as V<n+1>.
    const base: Row = {}
    for (const k of AUTH_COPY_KEYS) {
      const v = current[k]
      if (v === undefined || v === null) continue
      base[k] = (AUTH_CODE_FIELDS as readonly string[]).includes(k) || k === 'queryparams' ? (typeof v === 'string' ? v : JSON.stringify(v)) : v
    }
    const changes = buildChanges(a, base, false)
    const version = nextAuthVersion(versions)
    const body: Row = {
      ...base,
      ...changes,
      pluginrecordid: pluginId,
      authversion: version,
      metadata: { duplicatedfrom: { rowid: authId, authversion: str(current.authversion) } },
    }
    if (typeChange) applyTypeChange(body, typeChange, a, current, ctx.vs.env.authBase)
    const { rows } = await dhCreate(ctx, 'oauth_details', body)
    const row = rows[0]
    const newId = str(row?.rowid)
    if (!row || !newId) fail('viaSocket did not return the new connection version id. Check dh_get_plugin before retrying.')
    const hosts = [...hostList(body.whitelistdomains), ...newHosts]
    // Skill: the new version becomes the plug's default (preferedauthversion).
    const notes = await mergePlugAfterConnection(ctx, plugin, newId, hosts, true, 'new connection version', { auth: authFacts(body) })
    notes.push(`Actions and flows on ${str(current.authversion) ?? 'the old version'} keep using it; point a draft action version at ${version} with dh_update_action_version (authId) when ready. Say so in the report.`)
    notes.push('Users (and dry runs) need a new connection made with this version.')
    if (str(body.type) === 'Auth2.0' || str(body.type) === 'Auth1') {
      notes.push(
        typeChange && str(current.type) !== str(body.type)
          ? "The developer must save the app's client ID and secret on the new version in the Developer Hub before anyone can connect."
          : 'The client secret is never copied: the developer must enter it on the new version in the Developer Hub.',
      )
    }
    const { clientsecret: _s, ...safeBody } = body
    const page = await syncConnection(ctx, pluginId, { kind: 'create', requestPayload: safeBody, row })
    return {
      mode: 'copied to a new version',
      why,
      authId: newId,
      version,
      ...(typeChange ? { type: str(body.type), ...(str(body.granttype) ? { grantType: str(body.granttype) } : {}) } : {}),
      copiedFrom: { authId, version: str(current.authversion) },
      changed: [...new Set([...Object.keys(changes), ...(typeChange ? ['type', 'granttype'] : [])])].filter((k) => k !== '_connectionlabelvalue'),
      notes,
      ...(page ? { page } : {}),
      open: authOpen(pluginId, newId),
    }
  },
})

export const AUTH_TOOLS: Tool<any>[] = [listAuthVersions, createConnection, updateAuthVersion]

