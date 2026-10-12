// Confirmation and suggestion cards shown above the composer. Every string is set with textContent.

import type { ConfirmRequest, Suggestion } from '../../shared/mascot'
import { h } from './dom'

let seq = 0

export interface Card {
  el: HTMLElement
  /** The button keyboard focus should land on when the card appears */
  focusTarget: HTMLButtonElement
}

export function confirmCard(req: ConfirmRequest, onAnswer: (approved: boolean) => void): Card {
  const titleId = `vsa-card-${++seq}`
  const confirm = h('button', {
    type: 'button',
    class: req.danger ? 'btn danger' : 'btn primary',
    text: req.confirmLabel?.trim() || 'Confirm',
  })
  const cancel = h('button', { type: 'button', class: 'btn ghost', text: 'Cancel' })
  confirm.addEventListener('click', () => onAnswer(true))
  cancel.addEventListener('click', () => onAnswer(false))

  const el = h(
    'div',
    { class: req.danger ? 'card confirm danger' : 'card confirm', role: 'group', 'aria-labelledby': titleId },
    h('div', { class: 'card-title', id: titleId, text: req.title }),
    req.detail ? h('div', { class: 'card-detail', text: req.detail }) : null,
    h('div', { class: 'card-actions' }, cancel, confirm),
  )
  // Destructive actions get Cancel as the default focus so a stray Enter cannot delete anything.
  return { el, focusTarget: req.danger ? cancel : confirm }
}

export function suggestionCard(s: Suggestion, onAction: (action: 'apply' | 'dismiss') => void): Card {
  const dismiss = h('button', { type: 'button', class: 'btn ghost', text: 'Dismiss' })
  dismiss.addEventListener('click', () => onAction('dismiss'))
  let apply: HTMLButtonElement | null = null
  if (s.apply) {
    apply = h('button', { type: 'button', class: 'btn primary', text: s.apply.label?.trim() || 'Apply' })
    apply.addEventListener('click', () => onAction('apply'))
  }
  const el = h(
    'div',
    { class: 'card suggestion', role: 'group', 'aria-label': 'Suggestion' },
    h('div', { class: 'card-detail', text: s.message }),
    h('div', { class: 'card-actions' }, dismiss, apply),
  )
  return { el, focusTarget: apply ?? dismiss }
}
