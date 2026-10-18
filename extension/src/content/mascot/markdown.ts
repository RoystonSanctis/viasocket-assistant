// Minimal markdown for assistant replies: paragraphs, line breaks, **bold**, `code`, fenced code, lists,
// headings (shown as bold lines) and https links. Output is DOM nodes + textContent only.

import { h } from './dom'

// 1: `code`  2: **bold**  3,4: [label](url)  5: bare http(s) URL
const INLINE = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]{}"']+)/g
const TRAILING_PUNCT = /[.,;:!?]+$/
const LIST_ITEM = /^\s*(?:([-*•])|(\d{1,4})[.)])\s+(.*)$/
const FENCE = /^\s*```/
const HEADING = /^\s*#{1,6}\s+(.*)$/

/** Only https links become clickable; anything else stays plain text. */
export function safeHttpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

function link(label: string, href: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href, text: label })
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * Replies can be steered by page or run content, so a link may show its own label only when that label is the
 * link's host or the address itself. Otherwise the full address is the clickable text and the label is plain text.
 */
function labelledLink(label: string, url: URL): Node {
  if (sameText(label, url.hostname) || sameText(label, url.host) || sameText(label, url.href)) return link(label, url.href)
  const frag = document.createDocumentFragment()
  frag.append(`${label} (`, link(url.href, url.href), ')')
  return frag
}

function appendInline(parent: Node, text: string, allowBold = true): void {
  let last = 0
  // matchAll works on a clone of the regex, so the recursion for bold text is safe.
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    let consumed = m[0].length
    if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)))

    if (m[1] !== undefined) {
      parent.appendChild(h('code', { text: m[1] }))
    } else if (m[2] !== undefined) {
      if (allowBold) {
        const strong = h('strong')
        appendInline(strong, m[2], false)
        parent.appendChild(strong)
      } else {
        parent.appendChild(document.createTextNode(m[2]))
      }
    } else if (m[3] !== undefined && m[4] !== undefined) {
      if (/^#(?:prompt|action):/.test(m[4])) {
        let promptText = m[4].replace(/^#(?:prompt|action):/, '')
        try {
          promptText = decodeURIComponent(promptText)
        } catch {
          // ignore malformed URI components
        }
        parent.appendChild(
          h('button', {
            type: 'button',
            class: 'chat-chip',
            'data-prompt': promptText.trim() || m[3],
            text: m[3],
          }),
        )
      } else {
        const url = safeHttpsUrl(m[4])
        parent.appendChild(url ? labelledLink(m[3], url) : document.createTextNode(m[0]))
      }
    } else if (m[5] !== undefined) {
      const raw = m[5].replace(TRAILING_PUNCT, '')
      consumed = raw.length
      const url = safeHttpsUrl(raw)
      parent.appendChild(url ? link(url.href, url.href) : document.createTextNode(raw))
    }
    last = at + consumed
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: HTMLUListElement | HTMLOListElement | null = null
  let lastItem: HTMLLIElement | null = null

  const flushPara = (): void => {
    if (para.length === 0) return
    const p = h('p')
    para.forEach((line, i) => {
      if (i > 0) p.append(h('br'))
      appendInline(p, line)
    })
    frag.append(p)
    para = []
  }
  const endList = (): void => {
    list = null
    lastItem = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (FENCE.test(line)) {
      flushPara()
      endList()
      const body: string[] = []
      for (i++; i < lines.length && !FENCE.test(lines[i] ?? ''); i++) body.push(lines[i] ?? '')
      frag.append(h('pre', {}, h('code', { text: body.join('\n') })))
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      flushPara()
      const ordered = item[2] !== undefined
      if (!list || (list instanceof HTMLOListElement) !== ordered) {
        list = ordered ? h('ol') : h('ul')
        if (ordered && item[2] !== '1') list.setAttribute('start', String(Number(item[2])))
        frag.append(list)
      }
      lastItem = h('li')
      appendInline(lastItem, item[3] ?? '')
      list.append(lastItem)
      continue
    }

    if (line.trim() === '') {
      flushPara()
      endList()
      continue
    }

    if (lastItem && /^\s{2,}\S/.test(line)) {
      // Indented continuation of the previous list item
      lastItem.append(' ')
      appendInline(lastItem, line.trim())
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushPara()
      endList()
      const strong = h('strong')
      appendInline(strong, heading[1] ?? '', false)
      frag.append(h('p', { class: 'md-heading' }, strong))
      continue
    }

    endList()
    para.push(line.trim())
  }
  flushPara()
  return frag
}
