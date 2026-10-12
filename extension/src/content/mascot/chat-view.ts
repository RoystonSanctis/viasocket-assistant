// Scrollable conversation history. Lines are keyed by id so a re-sent line (e.g. a streamed reply) updates
// in place instead of duplicating.

import type { ChatLine } from '../../shared/mascot'
import { h } from './dom'
import { renderMarkdown } from './markdown'

const MAX_LINES = 200
const NEAR_BOTTOM_PX = 48

export class ChatView {
  readonly el: HTMLDivElement
  private readonly empty: HTMLDivElement
  private readonly nodes = new Map<string, HTMLElement>()

  constructor() {
    this.empty = h('div', { class: 'chat-empty' })
    this.el = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' }, this.empty)
  }

  setEmptyText(text: string): void {
    this.empty.textContent = text
  }

  setHistory(lines: ChatLine[]): void {
    for (const node of this.nodes.values()) node.remove()
    this.nodes.clear()
    for (const line of lines.slice(-MAX_LINES)) this.append(line)
    this.syncEmpty()
    this.scrollToEnd()
  }

  add(line: ChatLine): void {
    const stick = this.nearBottom() || line.role === 'user'
    const node = this.render(line)
    const existing = this.nodes.get(line.id)
    if (existing) existing.replaceWith(node)
    else this.el.append(node)
    this.nodes.set(line.id, node)
    this.trim()
    this.syncEmpty()
    if (stick) this.scrollToEnd()
  }

  scrollToEnd(): void {
    this.el.scrollTop = this.el.scrollHeight
  }

  private append(line: ChatLine): void {
    const node = this.render(line)
    this.nodes.set(line.id, node)
    this.el.append(node)
  }

  private render(line: ChatLine): HTMLElement {
    const time = Number.isFinite(line.at) ? new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    if (line.role === 'system-note') {
      return h('div', { class: 'msg sys', 'data-line': line.id, title: time, text: line.text })
    }
    const body = h('div', { class: line.role === 'assistant' ? 'msg-body md' : 'msg-body plain' })
    if (line.role === 'assistant') body.append(renderMarkdown(line.text))
    else body.textContent = line.text
    return h(
      'div',
      { class: `msg ${line.role}`, 'data-line': line.id, title: time },
      h('span', { class: 'sr-only', text: line.role === 'user' ? 'You: ' : 'Assistant: ' }),
      body,
    )
  }

  private trim(): void {
    while (this.nodes.size > MAX_LINES) {
      const first = this.nodes.keys().next()
      if (first.done) break
      this.nodes.get(first.value)?.remove()
      this.nodes.delete(first.value)
    }
  }

  private syncEmpty(): void {
    this.empty.hidden = this.nodes.size > 0
  }

  private nearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < NEAR_BOTTOM_PX
  }
}
