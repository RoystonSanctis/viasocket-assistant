// Follows the single-page app's route. The hook reports pushState/replaceState, popstate covers back/forward, and a
// 1s poll catches anything else (e.g. the hook missing because the page loaded before the extension).

import { parsePage, type PageContext } from '../shared/page'

const DEBOUNCE_MS = 250
const POLL_MS = 1000

export interface PageWatch {
  /** Freshly parsed from the current URL */
  current(): PageContext
  /** Something (the hook) says the route may have changed */
  poke(): void
  destroy(): void
}

export function watchPage(onChange: (page: PageContext) => void): PageWatch {
  let seenHref = location.href
  let emittedHref = location.href
  let debounce: ReturnType<typeof setTimeout> | undefined

  function emit(): void {
    debounce = undefined
    const href = location.href
    // Routes often change twice in a row (push then replace); only the settled URL is reported.
    if (href === emittedHref) return
    emittedHref = href
    onChange(parsePage(href))
  }

  function check(): void {
    const href = location.href
    if (href === seenHref) return
    seenHref = href
    clearTimeout(debounce)
    debounce = setTimeout(emit, DEBOUNCE_MS)
  }

  window.addEventListener('popstate', check)
  window.addEventListener('hashchange', check)
  const poll = setInterval(check, POLL_MS)

  return {
    current: () => parsePage(location.href),
    poke: check,
    destroy() {
      clearTimeout(debounce)
      clearInterval(poll)
      window.removeEventListener('popstate', check)
      window.removeEventListener('hashchange', check)
    },
  }
}
