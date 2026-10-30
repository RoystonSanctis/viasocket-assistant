// Where the user is inside viaSocket, derived only from the URL so it works without any change to the viaSocket UI.

export type PageKind =
  | 'flow-editor'
  | 'project'
  | 'home'
  | 'workspace-select'
  | 'developer-hub'
  | 'developer-hub-plugin'
  | 'other'

export interface PageContext {
  kind: PageKind
  url: string
  host: string
  orgId?: string
  projectId?: string
  serviceId?: string
  scriptId?: string
  /** 'draft' | 'published' on the flow editor */
  tabName?: string
  /** Set when a step panel is open (?stepId=&slugName=) */
  stepId?: string
  slugName?: string
  pluginId?: string
  sectionKey?: string
  sectionId?: string
}

const FLOW_EDITOR = /^\/projects\/([^/]+)\/([^/]+)\/(?:service\/([^/]+)\/)?workflow\/([^/]+)(?:\/([^/]+))?(\/slider)?/
const PROJECT = /^\/projects\/([^/]+)(?:\/([^/]+))?\/?$/
const HOME = /^\/home\/([^/]+)/
const DH_PLUGIN = /^\/developer\/([^/]+)\/plugin\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/
const DH = /^\/developer\/([^/]+)/
const WORKSPACE_SELECT = /^\/(?:org(?:s)?|projects)\/?$/
const ORG_PAGE = /^\/org(?:s)?\/([^/]+)\/?$/

// Embed routes: /integrations/embed/:orgId/:projectId[/service/:serviceId]/workflow/:scriptId/:tabName
const EMBED_FLOW_EDITOR = /^\/integrations\/embed\/([^/]+)\/([^/]+)\/(?:service\/([^/]+)\/)?workflow\/([^/]+)(?:\/([^/]+))?/
const EMBED_PROJECT = /^\/integrations\/embed\/([^/]+)\/([^/]+)/

export function parsePage(href: string): PageContext {
  const u = new URL(href)
  const base: PageContext = { kind: 'other', url: href, host: u.host }
  const path = u.pathname
  const q = u.searchParams

  let m = FLOW_EDITOR.exec(path)
  if (m) {
    return {
      ...base,
      kind: 'flow-editor',
      orgId: m[1],
      projectId: m[2],
      serviceId: m[3],
      scriptId: m[4],
      tabName: m[5],
      // The editor opens step panels purely from these query params, on the normal route as well as /slider.
      stepId: q.get('stepId')?.slice(0, 100) || undefined,
      slugName: q.get('slugName')?.slice(0, 100) || undefined,
    }
  }
  m = DH_PLUGIN.exec(path)
  if (m) {
    return { ...base, kind: 'developer-hub-plugin', orgId: m[1], pluginId: m[2], sectionKey: m[3], sectionId: m[4] }
  }
  m = DH.exec(path)
  if (m) return { ...base, kind: 'developer-hub', orgId: m[1] }
  m = WORKSPACE_SELECT.exec(path)
  if (m) return { ...base, kind: 'workspace-select' }
  m = ORG_PAGE.exec(path)
  if (m) return { ...base, kind: 'home', orgId: m[1] }
  m = PROJECT.exec(path)
  if (m) return { ...base, kind: 'project', orgId: m[1], projectId: m[2] || undefined }
  m = HOME.exec(path)
  if (m) return { ...base, kind: 'home', orgId: m[1] }

  // Embed routes (/integrations/embed/…) — same URL shape as the flow editor but on the embed host.
  m = EMBED_FLOW_EDITOR.exec(path)
  if (m) {
    return {
      ...base,
      kind: 'flow-editor',
      orgId: m[1],
      projectId: m[2],
      serviceId: m[3],
      scriptId: m[4],
      tabName: m[5],
      stepId: q.get('stepId')?.slice(0, 100) || undefined,
      slugName: q.get('slugName')?.slice(0, 100) || undefined,
    }
  }
  m = EMBED_PROJECT.exec(path)
  if (m) return { ...base, kind: 'project', orgId: m[1], projectId: m[2] }

  return base
}

/** Stable key for per-page conversation memory: one thread per flow / per plug. */
export function threadKey(p: PageContext): string {
  if (p.kind === 'flow-editor') return `flow:${p.orgId}:${p.scriptId}`
  if (p.kind === 'developer-hub-plugin') return `plug:${p.orgId}:${p.pluginId}`
  return `page:${p.kind}:${p.orgId ?? ''}`
}
