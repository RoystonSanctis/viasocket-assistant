// Tool factory for the Developer Hub tools: every call re-validates the model's arguments with zod, because the
// JSON schema is only a hint to the model and the agent loop passes parsed JSON through as-is.

import * as z from '../../../shared/zod'
import type { JsonSchema } from '../../llm/types'
import type { PageKind } from '../../../shared/page'
import type { Tool, ToolContext, ToolDanger } from '../types'
import { ROW_ID_RE, fail } from './api'
import { notePage } from './sync'

export const DH_PAGES: PageKind[] = ['developer-hub', 'developer-hub-plugin']
/** Every page kind: the plug search is useful anywhere in the workspace. */
export const ALL_PAGES: PageKind[] = ['flow-editor', 'project', 'home', 'workspace-select', 'developer-hub', 'developer-hub-plugin', 'other']

interface DhToolSpec<S extends z.ZodType> {
  name: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  danger: ToolDanger
  pages?: PageKind[]
  schema: S
  describe(args: z.infer<S>): string
  confirmText?(args: z.infer<S>, ctx: ToolContext): string
  /** run() asks the user itself (only when needed), so the generic confirmation gate is skipped. */
  confirmsInRun?: boolean
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join('.') || 'arguments'}: ${i.message}`)
    .join('; ')
}

export function dhTool<S extends z.ZodType>(spec: DhToolSpec<S>): Tool<Record<string, unknown>> {
  const parse = (raw: unknown) => spec.schema.safeParse(raw ?? {})
  const parameters: JsonSchema = {
    type: 'object',
    properties: spec.properties,
    additionalProperties: false,
    ...(spec.required?.length ? { required: spec.required } : {}),
  }
  const confirmText = spec.confirmText
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    danger: spec.danger,
    pages: spec.pages ?? DH_PAGES,
    ...(spec.confirmsInRun ? { confirmsInRun: true } : {}),
    describe(raw) {
      const r = parse(raw)
      return r.success ? spec.describe(r.data) : 'Working in the Developer Hub'
    },
    confirmText: confirmText
      ? (raw, ctx) => {
          notePage(ctx)
          const r = parse(raw)
          return r.success ? confirmText(r.data, ctx) : 'The assistant sent invalid arguments; this will fail.'
        }
      : undefined,
    async run(raw, ctx) {
      const r = parse(raw)
      if (!r.success) fail(`Invalid arguments for ${spec.name}: ${formatIssues(r.error)}`)
      notePage(ctx)
      return spec.run(r.data, ctx)
    },
  }
}

// ---------- shared argument pieces (zod + matching JSON schema) ----------

export const rowId = z.string().trim().regex(ROW_ID_RE, "must be a Developer Hub id like 'rowab12cd34'")

export const P = {
  pluginId: {
    type: 'string',
    description: 'Plug id (starts with "row"). Defaults to the plug open in the Developer Hub.',
  },
  actionId: {
    type: 'string',
    description: 'Action/trigger id (starts with "row"). Defaults to the action/trigger open in the editor.',
  },
  versionId: {
    type: 'string',
    description:
      'Action version row id (starts with "row", not "V2"). Defaults to the version open in the editor, else the latest version.',
  },
  authId: {
    type: 'string',
    description: 'Connection (auth) version row id (starts with "row"). See dh_get_plugin or dh_list_auth_versions.',
  },
} as const

/** Clips a model-supplied name for the mascot's short thinking text. */
export function label(s: string, max = 28): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Accepts "teable.io", "https://teable.io/x" or "api.teable.io" and returns a bare lowercase hostname. */
export function toHostname(input: string): string | undefined {
  try {
    const host = new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase()
    return HOSTNAME_RE.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** Same site, ignoring a leading "www.". */
export function sameHost(a: string, b: string): boolean {
  const n = (h: string) => h.trim().toLowerCase().replace(/^www\./, '')
  return !!a && !!b && n(a) === n(b)
}

export const hostname = z
  .string()
  .trim()
  .max(260)
  .transform((s, c) => {
    const h = toHostname(s)
    if (!h) c.addIssue({ code: 'custom', message: 'must be a domain like "teable.io"' })
    return h ?? s
  })

export const httpsUrl = z
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

export { SECRET_MASK, findSecret, maskSecrets, maskSecretsDeep, scrubModelNames, scrubModelNamesDeep } from './text-guards'

export function jsonBytes(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v) ?? '').length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
