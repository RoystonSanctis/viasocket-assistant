// UiBridge over the tab's port: how tools and the agent move the mascot, highlight things and ask for consent.

import type { Suggestion } from '../../shared/mascot'
import type { UiBridge } from '../tools/types'
import { speakReply } from '../voice'
import { postLine } from './conversation'
import { actingPage, expectNavigation, rememberSuggestionPage } from './run-target'
import type { PendingSuggestion, Session } from './session'

const CONFIRM_TIMEOUT_MS = 5 * 60_000

export function createUiBridge(session: Session): UiBridge {
  return {
    mascot(mode, text) {
      session.send({ type: 'mascot', mode, text })
    },
    thinking(text) {
      session.send({ type: 'thinking-text', text })
    },
    highlight(target, note) {
      session.send({ type: 'highlight', target, note })
    },
    clearHighlight() {
      session.send({ type: 'clear-highlight' })
    },
    navigate(url, opts) {
      const safe = safeAppUrl(session, url)
      if (!safe) {
        console.warn('[assistant] refused navigation outside the viaSocket app')
        return
      }
      expectNavigation(session, safe)
      session.send({ type: 'navigate', url: safe, replace: opts?.replace === true })
    },
    reloadPage(reason) {
      if (session.busy) session.pendingReload = reason
      else session.send({ type: 'reload-page', reason })
    },
    say(text) {
      postLine(session, 'assistant', text)
      speakReply(text).catch(() => undefined)
    },
    confirm(title, detail, danger, confirmLabel) {
      return requestConfirm(session, title, detail, danger, confirmLabel)
    },
    suggest(suggestion) {
      const id = crypto.randomUUID()
      const full: Suggestion = { ...suggestion, id }
      const entry: PendingSuggestion = { suggestion: full }
      // Bound to the page the run made it on: Apply elsewhere would hit another flow or plug.
      rememberSuggestionPage(entry, actingPage(session))
      session.addSuggestion(entry)
      session.send({ type: 'suggestion', suggestion: full })
      return id
    },
  }
}

function requestConfirm(session: Session, title: string, detail: string, danger: boolean, confirmLabel?: string): Promise<boolean> {
  if (session.closed || session.signal?.aborted) return Promise.resolve(false)
  const id = crypto.randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      session.resolveConfirm(id, false)
      session.send({ type: 'confirm-cancel', id })
    }, CONFIRM_TIMEOUT_MS)
    session.addConfirm(id, (approved) => {
      clearTimeout(timer)
      resolve(approved)
    })
    session.send({ type: 'confirm-request', request: { id, title, detail, danger, confirmLabel } })
  })
}

/** Only https URLs on the app host the user is on may be opened (in-app navigation keeps the session alive). */
function safeAppUrl(session: Session, url: string): string | null {
  if (!session.page) return null
  let u: URL
  try {
    u = new URL(url, session.page.url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  if (u.host !== session.page.host) return null
  return u.href
}
