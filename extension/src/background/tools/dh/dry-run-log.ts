// Remembers which sliders the assistant dry-ran successfully, so the publish confirmation can tell the user what
// was actually tested. In-memory only: lost when the service worker restarts, which just means "not tested here".

const MAX_VERSIONS = 50
const log = new Map<string, Map<string, boolean>>()

export function recordDryRun(versionId: string, slider: string, ok: boolean): void {
  const entry = log.get(versionId) ?? new Map<string, boolean>()
  entry.set(slider, ok)
  log.delete(versionId)
  log.set(versionId, entry)
  if (log.size > MAX_VERSIONS) {
    const oldest = log.keys().next().value
    if (oldest !== undefined) log.delete(oldest)
  }
}

/** Code changes invalidate earlier results. */
export function forgetDryRuns(versionId: string, sliders: string[]): void {
  const entry = log.get(versionId)
  for (const s of sliders) entry?.delete(s)
}

export function dryRunSummary(versionId: string | undefined): string {
  const entry = versionId ? log.get(versionId) : undefined
  if (!entry?.size) return 'Not dry-run by the assistant in this session.'
  return `Dry runs this session: ${[...entry].map(([s, ok]) => `${s} ${ok ? 'passed' : 'failed'}`).join(', ')}.`
}
