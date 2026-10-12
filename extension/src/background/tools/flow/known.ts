// Flows and projects the assistant has seen from viaSocket in this service-worker lifetime (listed or created).
// Tools may act on a flow other than the open one only when its id came from here, never from the model alone:
// the step and trigger routes silently create a flow for an unknown id, and project-scoped reads switch the
// user's active org when the project belongs to another workspace.

const flows = new Map<string, string>()
const projects = new Set<string>()

export function rememberFlow(orgId: string, scriptId: string, projectId: string): void {
  flows.set(`${orgId}:${scriptId}`, projectId)
  projects.add(`${orgId}:${projectId}`)
}

export function knownFlowProject(orgId: string, scriptId: string): string | undefined {
  return flows.get(`${orgId}:${scriptId}`)
}

export function rememberProject(orgId: string, projectId: string): void {
  projects.add(`${orgId}:${projectId}`)
}

export function isKnownProject(orgId: string, projectId: string): boolean {
  return projects.has(`${orgId}:${projectId}`)
}
