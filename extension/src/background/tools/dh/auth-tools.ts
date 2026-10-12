// Connection (oauth_details) tools. Connection versions have no publish lock: an in-place save changes live
// behaviour for every flow using that version, so updates are 'confirm' and risky edits are steered to a copy.
// Client secrets never reach the model: they are omitted from results and live-update events, and cannot be set here.

import * as z from '../../../shared/zod'
import type { Tool, ToolContext } from '../types'
import { authUsageCounts, dhCreate, dhGet, dhGetOne, dhUpdate, fail } from './api'
import { P, dhTool, rowId } from './define'
import {
  authFieldsOf, authVersionNumber, clip, decodeAuthCode, encodeAuthCode, obj, parseQueryParams, rowsOf, sameJson, str,
  type Row,
} from './rows'
import { syncConnection } from './sync'
import { dhOpen, pageAuthId, requirePluginId } from './target'

const AUTH_CODE_FIELDS = ['testcode', 'accesstokencode', 'refreshtokencode', 'revokeapicode'] as const
type AuthCodeField = (typeof AUTH_CODE_FIELDS)[number]

const AUTH_FULL_PARTS = [...AUTH_CODE_FIELDS, 'authfields', 'authenticationpaths'] as const
const GRANT_TYPES = ['Authorization Code', 'Implicit', 'Client Credentials', 'Password Credentials'] as const
const NEW_TYPES = ['Basic', 'Auth2.0', 'NoAuth'] as const

/** Edits the UI itself warns about because they can silently break existing users' connections. */
const RISKY_KEYS = new Set(['refreshtokencode', 'accesstokencode', 'uniquekeytostoreauth', 'authenticationpaths', 'authfields'])

// Copied verbatim into a new version. Everything else (rowid, orgid, metadata, audit and UI-only keys) is dropped.
const AUTH_COPY_KEYS = [
  'type', 'granttype', 'authfields', 'clientid', 'authrequrl', 'queryparams', 'scopeseperatedby', 'redirecturl',
  'accesstokencode', 'refreshtokencode', 'testcode', 'revokeapicode', 'connectionlabelkey', 'connectionlabelvalue',
  '_connectionlabelvalue', 'isconnectionlabelmasked', 'iconurlpath', 'uniquekeytostoreauth', 'authenticationpaths',
  'skipwhitelistvalidation', 'whitelistdomains', 'auth1parameters',
] as const

const CODE_LABELS: Record<AuthCodeField, string> = {
  testcode: 'test code',
  accesstokencode: 'access token code',
  refreshtokencode: 'refresh token code',
  revokeapicode: 'revoke code',
}

function authSummary(a: Row, defaultId: string | undefined, usage: Map<string, number>, codeMax: number) {
  const id = str(a.rowid)
  const code: Partial<Record<AuthCodeField, string>> = {}
  for (const f of AUTH_CODE_FIELDS) {
    const src = decodeAuthCode(a[f])
    if (src.trim()) code[f] = clip(src, codeMax)
  }
  const paths = a.authenticationpaths
  const pathsJson = JSON.stringify(paths ?? null) ?? 'null'
  return {
    id,
    version: str(a.authversion),
    type: str(a.type),
    grantType: str(a.granttype),
    isDefault: !!id && id === defaultId,
    usedByActionVersions: id ? usage.get(id) ?? 0 : undefined,
    credentialFields: authFieldsOf(a).map((f) => ({ key: str(f.key), label: str(f.label), type: str(f.type), required: f.required === true })),
    code,
    authUrl: str(a.authrequrl),
    queryParams: parseQueryParams(a.queryparams),
    scopeSeparator: str(a.scopeseperatedby),
    clientId: str(a.clientid),
    clientSecretSet: !!str(a.clientsecret),
    requestParams: pathsJson.length <= 1500 ? paths : clip(pathsJson, 1500),
    connectionLabel: str(a.connectionlabelkey) ? { key: str(a.connectionlabelkey), value: str(a.connectionlabelvalue) } : undefined,
    uniqueKey: str(a.uniquekeytostoreauth),
  }
}

const listAuthVersions = dhTool({
  name: 'dh_list_auth_versions',
  description:
    "List a plug's connection (auth) versions: type (Basic = API key / custom fields, Auth2.0, Auth1, NoAuth), grant type, the " +
    'credential fields users fill in, auth endpoints and scopes, request headers/params injected into every call, connection ' +
    'label, test/token code (truncated) and how many action versions use each. Pass authId plus `full` for one part untruncated. ' +
    'Secrets are never returned.',
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
    const sorted = rows.slice().sort((x, y) => authVersionNumber(x) - authVersionNumber(y))

    if (a.authId) {
      const one = sorted.find((r) => r.rowid === a.authId)
      if (!one) fail(`Connection version ${a.authId} does not belong to plug ${pluginId}.`)
      const budget = Math.max(2000, ctx.maxResultChars - 800)
      if (a.full === 'authfields' || a.full === 'authenticationpaths') {
        const json = JSON.stringify(one[a.full] ?? null) ?? 'null'
        return { authId: a.authId, part: a.full, value: json.length <= budget ? one[a.full] : clip(json, budget) }
      }
      if (a.full) return { authId: a.authId, part: a.full, code: clip(decodeAuthCode(one[a.full]), budget) }
      return { pluginId, connection: authSummary(one, defaultId, usage, 2500), open: authOpen(pluginId, a.authId) }
    }
    if (a.full) fail('Pass authId together with `full`.')
    return {
      pluginId,
      defaultAuthId: defaultId,
      connections: sorted.map((r) => authSummary(r, defaultId, usage, 700)),
      ...(sorted.length ? {} : { tip: 'No connection yet: create one with dh_update_auth_version (createNewVersion:true, type).' }),
    }
  },
})

function authOpen(pluginId: string, authId: string) {
  // The connection page keys its query on the plug id, as the Developer Hub UI does.
  return dhOpen(pluginId, 'auth', authId, pluginId)
}

// ---------- update / new version ----------

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
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => {
    try {
      return new URL(s).protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an https URL')

const updateSchema = z.object({
  pluginId: rowId.optional(),
  authId: rowId.optional(),
  createNewVersion: z.boolean().optional(),
  type: z.enum(NEW_TYPES).optional(),
  grantType: z.enum(GRANT_TYPES).optional(),
  code: z
    .object({
      testcode: codeSource.optional(),
      accesstokencode: codeSource.optional(),
      refreshtokencode: codeSource.optional(),
      revokeapicode: codeSource.optional(),
    })
    .optional(),
  authFields: z.array(authField).max(30).optional(),
  authRequestUrl: httpsUrl.optional(),
  scopes: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  queryParams: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(2000)).optional(),
  scopeSeparator: z.enum(['space', 'comma']).optional(),
  clientId: z.string().trim().max(500).optional(),
  requestParams: z
    .object({
      headers: z.array(nameValue).max(30).optional(),
      queryParams: z.array(nameValue).max(30).optional(),
      body: z.array(nameValue).max(30).optional(),
    })
    .optional(),
  connectionLabel: z.object({ key: z.string().trim().max(100), value: z.string().max(500) }).optional(),
  uniqueKey: z.string().trim().max(300).optional(),
})
type UpdateArgs = z.infer<typeof updateSchema>

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function authFieldsType(type: string | undefined): string {
  return type === 'Auth2.0' ? 'Auth2.0' : type === 'NoAuth' ? 'noauth' : type === 'Auth1' ? 'Auth1' : 'basic'
}

/** Only the keys whose stored value would actually change, in the stored encoding. */
function buildChanges(a: UpdateArgs, current: Row, inPlace: boolean): Row {
  const out: Row = {}
  const set = (k: string, v: unknown) => {
    if (!sameJson(current[k], v)) out[k] = v
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
  if (a.clientId !== undefined) set('clientid', a.clientId)
  if (a.requestParams) {
    const cur = obj(current.authenticationpaths) ?? {}
    set('authenticationpaths', {
      headers: a.requestParams.headers ?? rowsOf(cur.headers),
      queryParams: a.requestParams.queryParams ?? rowsOf(cur.queryParams),
      body: a.requestParams.body ?? rowsOf(cur.body),
    })
  }
  if (a.connectionLabel) {
    set('connectionlabelkey', a.connectionLabel.key)
    set('connectionlabelvalue', a.connectionLabel.value)
    // The label editor renders this HTML twin; keep it in step so the page does not show the old label.
    if ('connectionlabelkey' in out || 'connectionlabelvalue' in out) out._connectionlabelvalue = escapeHtml(a.connectionLabel.value)
  }
  if (a.uniqueKey !== undefined) set('uniquekeytostoreauth', a.uniqueKey)
  return out
}

const NULL_CODE = JSON.stringify({ source: null })
const EMPTY_CODE = encodeAuthCode('')

function authTemplate(type: (typeof NEW_TYPES)[number], grant: (typeof GRANT_TYPES)[number] | undefined, authBase: string): Row {
  if (type === 'NoAuth') {
    return {
      type,
      authfields: { authentication: { type: 'noauth', fields: [] } },
      testcode: EMPTY_CODE,
      accesstokencode: EMPTY_CODE,
      refreshtokencode: EMPTY_CODE,
      revokeapicode: EMPTY_CODE,
      queryparams: JSON.stringify({ scope: '', response_type: '' }),
      redirecturl: `${authBase}/redirect/auth2.0`,
    }
  }
  if (type === 'Basic') {
    return {
      type,
      granttype: null,
      authfields: {
        authentication: { type: 'basic', fields: [{ key: 'api_key', label: 'API Key', type: 'password', required: true, help: '' }] },
      },
      queryparams: '{}',
      testcode: NULL_CODE,
      accesstokencode: NULL_CODE,
      refreshtokencode: NULL_CODE,
      revokeapicode: NULL_CODE,
      isconnectionlabelmasked: true,
      redirecturl: `${authBase}/redirect/auth1`,
    }
  }
  const granttype = grant ?? 'Authorization Code'
  const fields =
    granttype === 'Client Credentials'
      ? [
          { key: 'clientid', label: 'Client ID', type: 'string', required: true, help: '' },
          { key: 'clientsecret', label: 'Client Secret', type: 'password', required: true, help: '' },
        ]
      : granttype === 'Password Credentials'
        ? [
            { key: 'username', label: 'Username', type: 'string', required: true, help: '' },
            { key: 'password', label: 'Password', type: 'password', required: true, help: '' },
          ]
        : null
  const responseType = granttype === 'Authorization Code' ? 'code' : granttype === 'Implicit' ? 'token' : ''
  return {
    type,
    granttype,
    authfields: { authentication: { type: 'Auth2.0', fields } },
    queryparams: JSON.stringify({ scope: '', response_type: responseType }),
    scopeseperatedby: 'space',
    testcode: EMPTY_CODE,
    accesstokencode: EMPTY_CODE,
    refreshtokencode: EMPTY_CODE,
    revokeapicode: EMPTY_CODE,
    isconnectionlabelmasked: true,
    redirecturl: `${authBase}/redirect/auth2.0`,
  }
}

/**
 * Copies a version's configuration. The client secret comes back decrypted only when isencrypted is the string
 * 'true' (a boolean true means the GET returned ciphertext), so it is copied only when it is known to be plaintext.
 */
function copyAuth(source: Row): { base: Row; secretCopied: boolean } {
  const base: Row = {}
  for (const k of AUTH_COPY_KEYS) {
    const v = source[k]
    if (v === undefined || v === null) continue
    base[k] = (AUTH_CODE_FIELDS as readonly string[]).includes(k) || k === 'queryparams' ? (typeof v === 'string' ? v : JSON.stringify(v)) : v
  }
  const secret = str(source.clientsecret)
  const secretCopied = !!secret && source.isencrypted !== true
  if (secretCopied) base.clientsecret = secret
  return { base, secretCopied }
}

function changeLabels(a: UpdateArgs): string[] {
  const out: string[] = []
  for (const f of AUTH_CODE_FIELDS) if (a.code?.[f] !== undefined) out.push(CODE_LABELS[f])
  if (a.authFields) out.push('credential fields')
  if (a.authRequestUrl !== undefined) out.push('authorization URL')
  if (a.scopes || a.queryParams) out.push('scopes/query params')
  if (a.scopeSeparator) out.push('scope separator')
  if (a.clientId !== undefined) out.push('client ID')
  if (a.requestParams) out.push('request headers/params')
  if (a.connectionLabel) out.push('connection label')
  if (a.uniqueKey !== undefined) out.push('unique key')
  return out
}

function riskyLabels(a: UpdateArgs): string[] {
  const out: string[] = []
  if (a.code?.refreshtokencode !== undefined) out.push('refresh token code')
  if (a.code?.accesstokencode !== undefined) out.push('access token code')
  if (a.requestParams) out.push('request headers/params')
  if (a.authFields) out.push('credential fields')
  if (a.uniqueKey !== undefined) out.push('unique key')
  return out
}

async function updateInPlace(a: UpdateArgs, ctx: ToolContext, pluginId: string, versions: Row[], defaultId: string | undefined) {
  if (a.type || a.grantType) {
    fail('Changing the connection type or grant type in place would break every existing connection. Pass createNewVersion:true.')
  }
  const authId = a.authId ?? pageAuthId(ctx) ?? defaultId
  if (!authId) fail('Which connection version? Pass authId (see dh_list_auth_versions).')
  const current = versions.find((v) => v.rowid === authId)
  if (!current) fail(`Connection version ${authId} does not belong to plug ${pluginId}.`)
  const changes = buildChanges(a, current, true)
  const changed = Object.keys(changes).filter((k) => k !== 'isScopeSeperatorChanged' && k !== '_connectionlabelvalue')
  if (!changed.length) return { authId, version: str(current.authversion), changed: [], message: 'Nothing to change: the values already match.' }

  await dhUpdate(ctx, 'oauth_details', 'updateAuthDetails', authId, changes)
  const [usage, page] = await Promise.all([
    authUsageCounts(ctx, pluginId),
    syncConnection(ctx, pluginId, { kind: 'update', authId, requestPayload: changes }),
  ])
  const risky = changed.filter((k) => RISKY_KEYS.has(k))
  return {
    authId,
    version: str(current.authversion),
    changed,
    usedByActionVersions: usage.get(authId) ?? 0,
    ...(risky.length ? { warning: `Live change to ${risky.join(', ')} for every flow using this connection version.` } : {}),
    ...(page ? { page } : {}),
    open: authOpen(pluginId, authId),
  }
}

async function createVersion(a: UpdateArgs, ctx: ToolContext, pluginId: string, versions: Row[], defaultId: string | undefined) {
  const sorted = versions.slice().sort((x, y) => authVersionNumber(x) - authVersionNumber(y))
  const sourceId = a.authId ?? pageAuthId(ctx) ?? defaultId
  const source = (sourceId ? sorted.find((v) => v.rowid === sourceId) : undefined) ?? (a.authId ? undefined : sorted[sorted.length - 1])
  if (a.authId && !source) fail(`Connection version ${a.authId} does not belong to plug ${pluginId}.`)

  const type = a.type ?? str(source?.type)
  if (!type) {
    fail('This plug has no connection version yet. Pass type: "Basic" (API key or custom fields), "Auth2.0" (OAuth 2) or "NoAuth".')
  }
  if (a.grantType && type !== 'Auth2.0') fail('grantType only applies to type "Auth2.0".')

  const sameShape = !!source && type === str(source.type) && (!a.grantType || a.grantType === str(source.granttype))
  let base: Row
  let secretCopied = false
  if (sameShape && source) {
    const copied = copyAuth(source)
    base = copied.base
    secretCopied = copied.secretCopied
  } else {
    if (type !== 'Basic' && type !== 'Auth2.0' && type !== 'NoAuth') fail(`Creating a fresh ${type} connection is not supported; copy an existing one.`)
    base = authTemplate(type, a.grantType, ctx.vs.env.authBase)
  }
  const changes = buildChanges(a, base, false)
  const nextNumber = Math.max(0, ...sorted.map(authVersionNumber)) + 1
  const body: Row = { ...base, ...changes, pluginrecordid: pluginId, authversion: `V${nextNumber}` }

  const { rows } = await dhCreate(ctx, 'oauth_details', body)
  const row = rows[0]
  const newId = str(row?.rowid)
  if (!row || !newId) fail('viaSocket did not return the new connection version id. Check dh_list_auth_versions before retrying.')

  const notes: string[] = []
  if (!defaultId) {
    try {
      await dhUpdate(ctx, 'plugins', 'updatePluginDetails', pluginId, { preferedauthversion: newId })
      notes.push('Set as the plug\'s default connection version.')
    } catch {
      notes.push('Could not set it as the plug\'s default connection version.')
    }
  }
  const hadSecret = !!str(source?.clientsecret)
  if (sameShape && hadSecret && !secretCopied) notes.push('The client secret could not be copied; ask the user to paste it in the App credentials panel.')
  if (source) notes.push('Existing user connections belong to the old version: users (and dry runs) need a new connection made with this version.')

  const page = await syncConnection(ctx, pluginId, { kind: 'create', requestPayload: body, row })
  return {
    authId: newId,
    version: `V${nextNumber}`,
    type,
    copiedFrom: sameShape ? str(source?.authversion) : undefined,
    changed: Object.keys(changes).filter((k) => k !== '_connectionlabelvalue'),
    notes,
    ...(page ? { page } : {}),
    open: authOpen(pluginId, newId),
    next: 'Point a drafted action version at it with dh_update_action_version (authId) when ready.',
  }
}

const updateAuthVersion = dhTool({
  name: 'dh_update_auth_version',
  description:
    "Edit a plug's connection (auth) version, or create a new one. Connection versions have NO publish lock: saving in place " +
    'changes live behaviour immediately for every flow and published action using that version. For risky changes (token or ' +
    'refresh code, request headers, credential fields, unique key) prefer createNewVersion:true, which copies the version ' +
    '(default: the open or default one) into V<n+1> with your changes and leaves the live one untouched; then point a new action ' +
    'version at it. createNewVersion:true with type also creates the FIRST connection of a new plug. Only send what changes. ' +
    'Never ask the user for a client secret in chat: they paste it in the App credentials panel themselves.',
  properties: {
    pluginId: P.pluginId,
    authId: { ...P.authId, description: 'Version to edit (or copy from). Defaults to the open connection page, else the default version.' },
    createNewVersion: { type: 'boolean', description: 'Copy into a new version V<n+1> (or create the first one) instead of editing in place.' },
    type: { type: 'string', enum: [...NEW_TYPES], description: 'Only with createNewVersion: connection type of the new version.' },
    grantType: { type: 'string', enum: [...GRANT_TYPES], description: 'Only with createNewVersion and type Auth2.0.' },
    code: {
      type: 'object',
      description:
        'JavaScript sources to save: function bodies using context.authData (the credential field values, e.g. ' +
        'context.authData.api_key; for OAuth also context.authData.accesstokencode) and axios. testcode must call a cheap ' +
        '"who am I" endpoint and return its data.',
      properties: {
        testcode: { type: 'string' },
        accesstokencode: { type: 'string' },
        refreshtokencode: { type: 'string' },
        revokeapicode: { type: 'string' },
      },
      additionalProperties: false,
    },
    authFields: {
      type: 'array',
      description: 'Replaces the credential inputs users fill in when connecting (Basic type).',
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
    },
    authRequestUrl: { type: 'string', description: 'OAuth authorize URL (https).' },
    scopes: { type: 'array', items: { type: 'string' }, description: 'OAuth scopes; joined with the scope separator.' },
    queryParams: { type: 'object', description: 'Extra authorize-URL query params, string values. Merged into the existing ones.' },
    scopeSeparator: { type: 'string', enum: ['space', 'comma'], description: 'How scopes are joined; stored scopes are re-joined.' },
    clientId: { type: 'string', description: 'OAuth client ID (not secret).' },
    requestParams: {
      type: 'object',
      description:
        'Injected into every API request made with this connection. Each list replaces the existing one. Values are JS ' +
        'bodies that return the value, e.g. "return `Bearer ${context.authData.api_key}`".',
      properties: {
        headers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
        queryParams: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
        body: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
      },
      additionalProperties: false,
    },
    connectionLabel: {
      type: 'object',
      description: 'How connections are named, e.g. {key:"email", value:"${context.data.email}"} where context.data is the test code result.',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    uniqueKey: { type: 'string', description: 'Template that de-duplicates connections of the same account.' },
  },
  danger: 'confirm',
  schema: updateSchema,
  describe: (a) => (a.createNewVersion ? 'Creating a connection version' : 'Saving connection changes'),
  confirmText(a, ctx) {
    const parts = changeLabels(a)
    if (a.createNewVersion) {
      return (
        `Create a new connection version${a.type ? ` (${a.type}${a.grantType ? `, ${a.grantType}` : ''})` : ''} for this plug` +
        `${parts.length ? `, with changes to: ${parts.join(', ')}` : ''}. Existing connection versions stay untouched.`
      )
    }
    const risky = riskyLabels(a)
    const open = pageAuthId(ctx)
    const target = a.authId
      ? `connection version ${a.authId}`
      : open
        ? `connection version ${open} (open on your screen)`
        : "the plug's default connection version"
    return (
      `Save ${parts.join(', ') || 'changes'} to ${target}. Connection versions have no ` +
      'publish lock: this changes behaviour immediately for every flow and published action using this connection.' +
      (risky.length ? ` Risky: ${risky.join(', ')}. A new version (createNewVersion) would be safer.` : '')
    )
  },
  async run(a, ctx) {
    const pluginId = requirePluginId(ctx, a.pluginId)
    const [plugin, versions] = await Promise.all([
      dhGetOne(ctx, 'plugins', 'getPluginDetails', pluginId, 'Plug'),
      dhGet(ctx, 'oauth_details', 'getAuthDetails', pluginId),
    ])
    const defaultId = str(plugin.preferedauthversion)
    return a.createNewVersion ? createVersion(a, ctx, pluginId, versions, defaultId) : updateInPlace(a, ctx, pluginId, versions, defaultId)
  },
})

export const AUTH_TOOLS: Tool<any>[] = [listAuthVersions, updateAuthVersion]
