// What a run acts on. The page and viaSocket client are pinned when the run starts, so navigating the tab
// mid-run can never retarget its tools to another flow, plug or org. A run only follows navigations it asked for.

import { parsePage, threadKey, type PageContext } from '../../shared/page'
import type { ViaSocketClient } from '../tools/viasocket-client'
import type { PendingSuggestion, Session } from './session'

/** A page the run navigated to. Fields the run did not specify match anything, since the app may fill them in. */
interface ExpectedPage {
  place: string
  sectionKey?: string
  sectionId?: string
  versionId?: string
}

export interface RunTarget {
  page: PageContext
  vs: ViaSocketClient
  expected: ExpectedPage[]
}

export class PageMovedError extends Error {
  constructor() {
    super('You moved to a different flow or plug, so I stopped. Ask me again here if you want me to carry on.')
    this.name = 'PageMovedError'
  }
}

const activeTargets = new WeakMap<Session, RunTarget>()
const suggestionPages = new WeakMap<PendingSuggestion, string>()

/** Which flow, plug or project the page is. Project pages share one thread per org, so the project is added. */
export function pageKey(p: PageContext): string {
  return `${p.host}|${threadKey(p)}|${p.projectId ?? ''}`
}

/**
 * pageKey plus what Developer Hub tools default to: the open section and its ?versionId. Moving to another action
 * of the same plug must not retarget a write either.
 */
export function focusKey(p: PageContext): string {
  if (p.kind !== 'developer-hub-plugin') return pageKey(p)
  return `${pageKey(p)}|${p.sectionKey ?? ''}|${p.sectionId ?? ''}|${versionOf(p)}`
}

function versionOf(p: PageContext): string {
  try {
    return new URL(p.url).searchParams.get('versionId') ?? ''
  } catch {
    return ''
  }
}

function matchesExpected(e: ExpectedPage, p: PageContext): boolean {
  if (e.place !== pageKey(p)) return false
  if (e.sectionKey && e.sectionKey !== p.sectionKey) return false
  if (e.sectionId && e.sectionId !== p.sectionId) return false
  return !e.versionId || e.versionId === versionOf(p)
}

export function pinTarget(session: Session): RunTarget | null {
  if (!session.page || !session.vs) return null
  const target: RunTarget = { page: session.page, vs: session.vs, expected: [] }
  activeTargets.set(session, target)
  return target
}

export function releaseTarget(session: Session, target: RunTarget | null): void {
  if (target && activeTargets.get(session) === target) activeTargets.delete(session)
}

/** The page the current run acts on, falling back to the tab's page outside a run. */
export function actingPage(session: Session): PageContext | null {
  return activeTargets.get(session)?.page ?? session.page
}

/** Records a navigation the running run requested, so the run follows it instead of stopping. */
export function expectNavigation(session: Session, url: string): void {
  const target = activeTargets.get(session)
  if (!target) return
  let p: PageContext
  try {
    p = parsePage(url)
  } catch {
    return
  }
  const e: ExpectedPage = { place: pageKey(p) }
  if (p.kind === 'developer-hub-plugin') {
    if (p.sectionKey) e.sectionKey = p.sectionKey
    if (p.sectionId) e.sectionId = p.sectionId
    const versionId = versionOf(p)
    if (versionId) e.versionId = versionId
  }
  target.expected.push(e)
}

/**
 * True while the tab still shows the run's flow, plug or project, or a page the run navigated to itself. The
 * target then takes the tab's latest URL (an opened step panel, the flow the run just created). False means the
 * user went somewhere else and the run must stop.
 */
export function followPage(session: Session, target: RunTarget): boolean {
  const now = session.page
  if (!now || !session.vs) return false
  const hit = target.expected.findIndex((e) => matchesExpected(e, now))
  if (hit !== -1) {
    // Used up on arrival, so a page the user opens later in the same plug does not ride on this navigation.
    target.expected.splice(hit, 1)
    target.page = now
    target.vs = session.vs
    return true
  }
  if (pageKey(now) !== pageKey(target.page)) return false
  // Same plug but another section or version the user opened: keep acting on the pinned one.
  if (focusKey(now) === focusKey(target.page)) target.page = now
  return true
}

export function rememberSuggestionPage(entry: PendingSuggestion, page: PageContext | null): void {
  if (page) suggestionPages.set(entry, focusKey(page))
}

/** A suggestion can only be applied on the page it was made for. */
export function suggestionStillApplies(entry: PendingSuggestion, page: PageContext | null): boolean {
  const key = suggestionPages.get(entry)
  return !!key && !!page && focusKey(page) === key
}
