// The workflow plan as a compact checklist pinned at the top of the chat. Every string from the plan is set with
// textContent; the plan itself comes from the model (ui_plan) through the worker and is only ever displayed.

import {
  currentPlanItem, normalizePlan, type PlanItem, type PlanKind, type PlanStatus, type WorkflowPlan,
} from '../../shared/mascot'
import { h, icon } from './dom'

const STATUS_LABEL: Record<PlanStatus, string> = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
  skipped: 'Skipped',
  blocked: 'Needs you',
}

const STATUS_ANNOUNCE: Record<PlanStatus, string> = {
  todo: 'Back to do',
  doing: 'Started',
  done: 'Done',
  skipped: 'Skipped',
  blocked: 'Needs your input',
}

const KIND_LABEL: Record<PlanKind, string> = {
  trigger: 'Trigger',
  step: 'Step',
  condition: 'Condition',
  branch: 'Branch',
  delay: 'Delay',
  ai: 'AI',
  loop: 'Loop',
  'run-if': 'Run if',
  'get-data': 'Get data',
  response: 'Response',
  test: 'Test',
  publish: 'Publish',
}

const MAX_ANNOUNCEMENTS = 3

export interface PlanProgress {
  done: number
  /** Items that still count (skipped ones do not) */
  total: number
  /** 0..1 */
  ratio: number
}

export function planProgress(plan: WorkflowPlan): PlanProgress {
  const total = plan.items.filter((i) => i.status !== 'skipped').length
  const done = plan.items.filter((i) => i.status === 'done').length
  return { done, total, ratio: total ? done / total : 1 }
}

/** The line next to the orb while the assistant is idle: what is going on with the plan, or nothing. */
export function restingText(plan: WorkflowPlan | null): string {
  if (!plan) return ''
  if (plan.awaitingConfirmation) return 'Plan ready: waiting for your OK'
  const doing = currentPlanItem(plan)
  if (doing) return `Now: ${doing.title}`
  const blocked = plan.items.find((i) => i.status === 'blocked')
  if (blocked) return `Needs you: ${blocked.title}`
  return ''
}

/** What a screen reader should hear about a plan change (status changes, a new plan, approval requests). */
export function planAnnouncements(prev: WorkflowPlan | null, next: WorkflowPlan | null): string[] {
  if (!next) return prev ? ['Plan cleared'] : []
  if (!prev || prev.id !== next.id) {
    const steps = `${next.items.length} ${next.items.length === 1 ? 'step' : 'steps'}`
    return [`New plan${next.title ? ` "${next.title}"` : ''}, ${steps}${next.awaitingConfirmation ? ', waiting for your approval' : ''}`]
  }
  const before = new Map(prev.items.map((i) => [i.id, i]))
  const out: string[] = []
  for (const item of next.items) {
    const old = before.get(item.id)
    if (!old || old.status === item.status) continue
    out.push(`${STATUS_ANNOUNCE[item.status]}: ${item.title}${item.status === 'blocked' && item.note ? `. ${item.note}` : ''}`)
  }
  if (next.awaitingConfirmation && !prev.awaitingConfirmation) out.push('The plan is waiting for your approval')
  if (out.length > MAX_ANNOUNCEMENTS) return [...out.slice(0, MAX_ANNOUNCEMENTS), `and ${out.length - MAX_ANNOUNCEMENTS} more changes`]
  return out
}

export interface PlanCardHooks {
  /** "Looks good, start" */
  onApprove(): void
  /** "Change something" */
  onChange(): void
}

export class PlanCard {
  readonly el: HTMLElement
  private readonly toggle: HTMLButtonElement
  private readonly titleEl: HTMLSpanElement
  private readonly countEl: HTMLSpanElement
  private readonly nowEl: HTMLDivElement
  private readonly barFill: HTMLDivElement
  private readonly list: HTMLOListElement
  private readonly actions: HTMLDivElement
  private readonly approveBtn: HTMLButtonElement
  private readonly changeBtn: HTMLButtonElement
  private readonly live: HTMLDivElement
  private plan: WorkflowPlan | null = null
  private collapsed = false
  private busy = false
  /** Rev of the plan the user already approved with the button; its buttons stay hidden even if no update follows */
  private answered: { id: string; rev: number } | null = null
  private lastDoing: string | null = null
  private liveTimer = 0

  constructor(private readonly hooks: PlanCardHooks) {
    this.titleEl = h('span', { class: 'plan-title' })
    this.toggle = h(
      'button',
      { type: 'button', class: 'plan-toggle', 'aria-expanded': 'true', 'aria-controls': 'vsa-plan-list' },
      h('span', { class: 'plan-chev' }, icon('chevron')),
      h('span', { class: 'plan-label', text: 'Plan' }),
      this.titleEl,
    )
    this.countEl = h('span', { class: 'plan-count' })
    this.nowEl = h('div', { class: 'plan-now', hidden: true })
    this.barFill = h('div', { class: 'plan-bar-fill' })
    const bar = h('div', { class: 'plan-bar', 'aria-hidden': 'true' }, this.barFill)
    this.list = h('ol', { class: 'plan-list', role: 'list', id: 'vsa-plan-list', 'aria-label': 'Plan steps' })
    this.changeBtn = h('button', { type: 'button', class: 'btn ghost small', text: 'Change something' })
    this.approveBtn = h('button', { type: 'button', class: 'btn primary small', text: 'Looks good, start' })
    this.actions = h('div', { class: 'plan-actions', hidden: true }, this.changeBtn, this.approveBtn)
    this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })
    this.el = h(
      'section',
      { class: 'plan', 'aria-label': 'Workflow plan', hidden: true },
      h('div', { class: 'plan-hdr' }, this.toggle, this.countEl),
      this.nowEl,
      bar,
      this.list,
      this.actions,
      this.live,
    )

    this.toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed
      this.renderChrome()
    })
    this.approveBtn.addEventListener('click', () => {
      if (!this.plan || this.busy) return
      this.answered = { id: this.plan.id, rev: this.plan.rev }
      this.renderChrome()
      this.hooks.onApprove()
    })
    this.changeBtn.addEventListener('click', () => {
      if (this.busy) return
      this.hooks.onChange()
    })
  }

  /** The plan is waiting for the user's answer and the buttons are showing */
  get needsAnswer(): boolean {
    const p = this.plan
    return !!p && p.awaitingConfirmation && !(this.answered?.id === p.id && this.answered.rev === p.rev)
  }

  get current(): WorkflowPlan | null {
    return this.plan
  }

  set(raw: WorkflowPlan | null): void {
    const plan = normalizePlan(raw)
    const prev = this.plan
    this.plan = plan
    if (!plan) {
      this.el.hidden = true
      this.list.replaceChildren()
      this.answered = null
      this.lastDoing = null
      if (prev) this.announce(planAnnouncements(prev, null))
      return
    }
    if (!prev || prev.id !== plan.id) {
      // A new plan opens expanded, whatever the user did with the last one.
      this.collapsed = false
      this.answered = null
      this.lastDoing = null
    }
    this.el.hidden = false
    this.renderItems(plan)
    this.renderChrome()
    this.revealDoing(plan)
    this.announce(planAnnouncements(prev, plan))
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    this.approveBtn.disabled = busy
    this.changeBtn.disabled = busy
  }

  destroy(): void {
    clearTimeout(this.liveTimer)
  }

  // ---------- rendering ----------

  private renderChrome(): void {
    const plan = this.plan
    if (!plan) return
    const { done, total, ratio } = planProgress(plan)
    this.titleEl.textContent = plan.title ?? ''
    this.titleEl.hidden = !plan.title
    this.toggle.title = plan.title ? `Plan: ${plan.title}` : 'Plan'
    this.countEl.textContent = `${done}/${total}`
    this.countEl.setAttribute('aria-label', `${done} of ${total} done`)
    this.barFill.style.width = `${Math.round(ratio * 100)}%`
    this.el.classList.toggle('collapsed', this.collapsed)
    this.el.classList.toggle('complete', total > 0 && done === total)
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed))
    this.list.hidden = this.collapsed
    const now = restingText(plan)
    this.nowEl.textContent = now
    this.nowEl.hidden = !this.collapsed || !now
    this.actions.hidden = !this.needsAnswer
  }

  private renderItems(plan: WorkflowPlan): void {
    const scroll = this.list.scrollTop
    // While the user reviews a proposed plan every detail shows; afterwards only the active item's.
    const allDetails = plan.awaitingConfirmation
    this.list.replaceChildren(...plan.items.map((item) => itemNode(item, allDetails)))
    this.list.scrollTop = scroll
  }

  /** Scrolls the list (never the page) so a newly started item is in view. */
  private revealDoing(plan: WorkflowPlan): void {
    const doing = currentPlanItem(plan)
    const id = doing?.id ?? null
    if (id === this.lastDoing) return
    this.lastDoing = id
    if (!doing || this.collapsed) return
    const node = Array.from(this.list.children).find((c) => (c as HTMLElement).dataset.id === doing.id) as HTMLElement | undefined
    if (!node) return
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top < this.list.scrollTop || bottom > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = Math.max(0, top - 6)
    }
  }

  private announce(messages: string[]): void {
    if (!messages.length) return
    // Re-setting the same text is not announced again; clear first.
    this.live.textContent = ''
    clearTimeout(this.liveTimer)
    this.liveTimer = window.setTimeout(() => {
      this.live.textContent = messages.join('. ')
    }, 60)
  }
}

function itemNode(item: PlanItem, showDetail: boolean): HTMLLIElement {
  const active = item.status === 'doing' || item.status === 'blocked'
  const li = h('li', {
    class: `plan-item s-${item.status}`,
    'data-id': item.id,
    'aria-current': item.status === 'doing' ? 'step' : undefined,
  })
  if (item.depth) li.style.setProperty('--depth', String(item.depth))
  if (item.detail && !(showDetail || active)) li.title = item.detail
  li.append(
    h('span', { class: 'plan-ico', 'aria-hidden': 'true' }, icon(item.status)),
    h(
      'div',
      { class: 'plan-body' },
      h(
        'div',
        { class: 'plan-line' },
        h('span', { class: 'sr-only', text: `${STATUS_LABEL[item.status]}: ` }),
        h('span', { class: 'plan-item-title', text: item.title }),
        item.kind ? h('span', { class: 'plan-kind', text: KIND_LABEL[item.kind] }) : null,
      ),
      item.detail && (showDetail || active) ? h('div', { class: 'plan-item-detail', text: item.detail }) : null,
      item.note ? h('div', { class: 'plan-item-note', text: item.note }) : null,
    ),
  )
  return li
}
