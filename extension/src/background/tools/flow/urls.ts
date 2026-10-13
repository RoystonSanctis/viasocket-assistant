// App-internal paths for router navigation. Every id is validated, so nothing the model says can turn a path into
// another origin, route or query. Query keys the app reads as routing state (mode, orgId, scriptId, ...) are never
// added: the UI lets query params override route params.

export const DH_SECTION_KEYS = ['auth', 'pluginDetails', 'action', 'trigger', 'customAction', 'analytics', 'components'] as const
export type DhSectionKey = (typeof DH_SECTION_KEYS)[number]

export type AppTarget =
  | { to: 'flow'; orgId: string; projectId: string; scriptId: string; tab?: 'draft' | 'published' | 'logs' }
  | { to: 'project'; orgId: string; projectId: string }
  | { to: 'home'; orgId: string }
  | { to: 'dh-home'; orgId: string }
  | { to: 'dh-plugin'; orgId: string; pluginId: string }
  | { to: 'dh-section'; orgId: string; pluginId: string; sectionKey: DhSectionKey; sectionId?: string; versionId?: string }

const ID = /^[A-Za-z0-9]{1,40}$/

function id(v: string, what: string): string {
  if (!ID.test(v)) throw new Error(`Invalid ${what}`)
  return v
}

export function appPath(t: AppTarget): string {
  const org = id(t.orgId, 'workspace id')
  switch (t.to) {
    case 'flow':
      return `/projects/${org}/${id(t.projectId, 'project id')}/workflow/${id(t.scriptId, 'flow id')}/${t.tab ?? 'draft'}`
    case 'project':
      return `/projects/${org}/${id(t.projectId, 'project id')}`
    case 'home':
      return `/home/${org}`
    case 'dh-home':
      return `/developer/${org}`
    case 'dh-plugin':
      return `/developer/${org}/plugin/${id(t.pluginId, 'plugin id')}`
    case 'dh-section': {
      if (!(DH_SECTION_KEYS as readonly string[]).includes(t.sectionKey)) throw new Error('Invalid section')
      let p = `/developer/${org}/plugin/${id(t.pluginId, 'plugin id')}/${t.sectionKey}`
      if (t.sectionId) p += `/${id(t.sectionId, 'section id')}`
      if (t.versionId) p += `?versionId=${id(t.versionId, 'version id')}`
      return p
    }
  }
}

/**
 * Editor query params the tools may change: the open step panel (stepType names the Get Data panel's kind,
 * flowCondition the trigger's loop / run-if panel) and the refetch stamp.
 */
const EDITOR_PARAMS = new Set(['stepId', 'slugName', 'position', 'parent', 'timestamp', 'stepType', 'flowCondition'])

/** Path + query of the current page with some editor params set (string) or removed (null). */
export function pagePathWithParams(pageUrl: string, changes: Record<string, string | null>): string {
  const u = new URL(pageUrl)
  for (const [k, v] of Object.entries(changes)) {
    if (!EDITOR_PARAMS.has(k)) throw new Error(`Refusing to change query param ${k}`)
    if (v === null) u.searchParams.delete(k)
    else u.searchParams.set(k, v)
  }
  return u.pathname + u.search
}
