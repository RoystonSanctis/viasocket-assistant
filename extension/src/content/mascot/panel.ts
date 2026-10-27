// The chat panel: header with status and menu, setup banner, the plan checklist, history, confirm/suggestion cards,
// live transcript, voice row and the composer (text + hold-to-talk). Non-modal dialog next to the orb.

import type { PageKind } from '../../shared/page'
import { PLAN_APPROVE_TEXT, type ChatLine, type ConfirmRequest, type MascotMode, type Suggestion, type WorkflowPlan } from '../../shared/mascot'
import type { SttEngine, VoiceState } from '../../shared/messages'
import { DEFAULT_SETTINGS, saveSettings, type AudioOutputMode, type Proactivity, type UserSettings } from '../../shared/settings'
import type { MascotCallbacks } from './api'
import { confirmCard, suggestionCard, type Card } from './cards'
import { ChatView } from './chat-view'
import { h, icon, iconButton } from './dom'
import { boxAt, hasArea, intersects, rectOf, viewport, type Point, type Rect } from './geometry'
import { PlanCard } from './plan-card'
import { VoiceRow } from './voice-row'

const MAX_INPUT = 2000
const PANEL_WIDTH = 360
const EDGE = 12
const GAP = 12
const MAX_SUGGESTIONS = 4
const FINAL_TRANSCRIPT_MS = 1500
const INPUT_PLACEHOLDER = 'Ask me to build or fix something…'
const CHANGE_PLAN_PLACEHOLDER = 'What should change in the plan?'

const STATUS: Record<MascotMode, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  searching: 'Searching',
  working: 'Working',
  suggest: 'Has a suggestion',
  confused: 'Something went wrong',
  celebrate: 'Done',
  sleeping: 'Napping',
  waking: 'Waking up',
  happy: 'Ready',
  curious: 'Curious',
}

export interface PanelHooks {
  callbacks: MascotCallbacks
  onOpenChange(open: boolean): void
  /** Any interaction inside the panel (keeps the mascot awake) */
  onActivity(): void
  /** Panel size changed while open; the controller repositions it */
  onResize(): void
  /** Focus should go back to the orb (Escape / close) */
  focusOrb(): void
}

interface PendingCard {
  card: Card
  kind: 'confirm' | 'suggestion'
}

export class Panel {
  readonly el: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly proactivityBtn: HTMLButtonElement
  private readonly audioBtn: HTMLButtonElement
  private readonly menuBtn: HTMLButtonElement
  private readonly proactivityMenu: HTMLDivElement
  private readonly audioMenu: HTMLDivElement
  private readonly menu: HTMLDivElement
  private readonly banner: HTMLDivElement
  private readonly bannerText: HTMLSpanElement
  private readonly chat: ChatView
  private readonly plan: PlanCard
  private readonly cards: HTMLDivElement
  private readonly transcript: HTMLDivElement
  /** Screen-reader announcements that must not move focus (a confirmation arriving while the user types) */
  private readonly announcer: HTMLDivElement
  private readonly voice: VoiceRow
  private readonly input: HTMLTextAreaElement
  private readonly micBtn: HTMLButtonElement
  private readonly sendBtn: HTMLButtonElement
  private readonly pending = new Map<string, PendingCard>()
  private readonly audioItems = new Map<AudioOutputMode, HTMLButtonElement>()
  private readonly proactivityItems = new Map<Proactivity, HTMLButtonElement>()
  private readonly resizeObs: ResizeObserver
  private settings: UserSettings = DEFAULT_SETTINGS
  private lines: Record<string, string> = {}
  private pageKind: PageKind = 'other'
  private opened = false
  private busy = false
  private mode: MascotMode = 'idle'
  private llmReady = true
  private micHeld = false
  private micDownTime = 0
  private isMicToggled = false
  private stoppedFromToggle = false
  private inputPrefix = ''
  private transcriptTimer = 0
  private thinking = ''
  private appliedLeft = Number.NaN
  private appliedTop = Number.NaN
  private panelDrag: {
    id: number
    startX: number
    startY: number
    startLeft: number
    startTop: number
    moved: boolean
  } | null = null
  private userMoved = false
  private userLeft = Number.NaN
  private userTop = Number.NaN

  constructor(private readonly hooks: PanelHooks) {
    const cb = hooks.callbacks

    // ----- header -----
    this.status = h('div', { class: 'status', 'aria-live': 'polite', text: 'Ready' })
    this.proactivityBtn = h('button', {
      type: 'button',
      class: 'icon-btn hdr-proactivity-btn',
      'aria-label': 'Bot proactivity',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Bot proactivity',
    })
    this.proactivityBtn.append(icon('zap'))
    this.audioBtn = h('button', {
      type: 'button',
      class: 'icon-btn hdr-audio-btn',
      'aria-label': 'Audio output',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Audio output',
    })
    this.audioBtn.append(icon('volumeFull'))
    this.menuBtn = iconButton('more', 'More options')
    this.menuBtn.setAttribute('aria-haspopup', 'menu')
    this.menuBtn.setAttribute('aria-expanded', 'false')
    const closeBtn = iconButton('close', 'Close SOCKET panel')
    const header = h(
      'div',
      { class: 'hdr' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('div', { class: 'hdr-text' }, h('div', { class: 'title', id: 'vsa-title', text: 'SOCKET' }), this.status),
      this.proactivityBtn,
      this.audioBtn,
      this.menuBtn,
      closeBtn,
    )
    header.addEventListener('pointerdown', this.onHeaderDown)
    header.addEventListener('pointermove', this.onHeaderMove)
    header.addEventListener('pointerup', this.onHeaderEnd)
    header.addEventListener('pointercancel', this.onHeaderEnd)
    header.addEventListener('lostpointercapture', this.onHeaderEnd)
    header.addEventListener('dblclick', this.onHeaderDblClick)

    // ----- menus -----
    const buildRadioItem = (opts: {
      iconName?: 'volumeFull' | 'volumeLow' | 'volumeMute'
      title: string
      sub?: string
      onClick: () => void
    }): HTMLButtonElement => {
      const check = h('span', { class: 'menu-item-check' }, icon('check'))
      const textDiv = h('div', { class: 'menu-item-text' }, h('span', { class: 'menu-item-title', text: opts.title }))
      if (opts.sub) {
        textDiv.append(h('span', { class: 'menu-item-sub', text: opts.sub }))
      }
      const content = h('div', { class: 'menu-item-content' })
      if (opts.iconName) {
        content.append(h('span', { class: 'menu-item-icon' }, icon(opts.iconName)))
      }
      content.append(textDiv)
      const item = h('button', { type: 'button', role: 'menuitemradio', class: 'menu-item' }, content, check)
      item.addEventListener('click', opts.onClick)
      return item
    }

    // 1. More menu (three-dot menu: Clear conversation and Settings only)
    const clearItem = h('button', { type: 'button', role: 'menuitem', class: 'menu-item', text: 'Clear conversation' })
    const settingsItem = h('button', { type: 'button', role: 'menuitem', class: 'menu-item', text: 'Settings' })

    this.menu = h(
      'div',
      { class: 'menu more-menu', role: 'menu', 'aria-label': 'SOCKET options', hidden: true },
      clearItem,
      h('div', { class: 'menu-divider', role: 'separator' }),
      settingsItem,
    )

    // 2. Audio menu (outside icon popover)
    const setAudio = (mode: AudioOutputMode) => {
      this.settings.audioOutput = mode
      this.settings.speakReplies = mode !== 'off'
      this.syncAudioBtn()
      this.syncMenuChecks()
      this.toggleAudioMenu(false)
      hooks.onActivity()
      void saveSettings({ audioOutput: mode })
    }

    const audioFull = buildRadioItem({
      iconName: 'volumeFull',
      title: 'Full response',
      sub: 'Speaks entire answer',
      onClick: () => setAudio('full'),
    })
    const audioMinimal = buildRadioItem({
      iconName: 'volumeLow',
      title: 'Minimal response',
      sub: 'First sentence only',
      onClick: () => setAudio('minimal'),
    })
    const audioOff = buildRadioItem({
      iconName: 'volumeMute',
      title: 'Muted',
      sub: 'Silent, text only',
      onClick: () => setAudio('off'),
    })
    this.audioItems.set('full', audioFull)
    this.audioItems.set('minimal', audioMinimal)
    this.audioItems.set('off', audioOff)

    this.audioMenu = h(
      'div',
      { class: 'menu audio-menu', role: 'menu', 'aria-label': 'Audio output options', hidden: true },
      h('div', { class: 'menu-label', text: 'Audio output' }),
      audioFull,
      audioMinimal,
      audioOff,
    )

    // 3. Proactivity menu (outside icon popover)
    const setProactivity = (mode: Proactivity) => {
      this.settings.proactivity = mode
      this.syncProactivityBtn()
      this.syncMenuChecks()
      this.toggleProactivityMenu(false)
      hooks.onActivity()
      void saveSettings({ proactivity: mode })
    }

    const proProactive = buildRadioItem({
      title: 'Proactive',
      sub: 'Suggests fixes & next steps',
      onClick: () => setProactivity('proactive'),
    })
    const proHelpful = buildRadioItem({
      title: 'Helpful',
      sub: 'Tips on saves & errors',
      onClick: () => setProactivity('helpful'),
    })
    const proQuiet = buildRadioItem({
      title: 'Quiet',
      sub: 'Speaks only when asked',
      onClick: () => setProactivity('quiet'),
    })
    this.proactivityItems.set('proactive', proProactive)
    this.proactivityItems.set('helpful', proHelpful)
    this.proactivityItems.set('quiet', proQuiet)

    this.proactivityMenu = h(
      'div',
      { class: 'menu proactivity-menu', role: 'menu', 'aria-label': 'Bot proactivity options', hidden: true },
      h('div', { class: 'menu-label', text: 'Bot proactivity' }),
      proProactive,
      proHelpful,
      proQuiet,
    )

    this.syncAudioBtn()
    this.syncProactivityBtn()
    this.syncMenuChecks()

    // ----- banner -----
    this.bannerText = h('span', { class: 'banner-text' })
    const bannerBtn = h('button', { type: 'button', class: 'btn small', text: 'Settings' })
    this.banner = h('div', { class: 'banner', role: 'alert', hidden: true }, this.bannerText, bannerBtn)

    // ----- body -----
    this.plan = new PlanCard({
      onApprove: () => {
        this.resetPlaceholder()
        cb.onUserText(PLAN_APPROVE_TEXT)
        hooks.onActivity()
      },
      onChange: () => {
        // The user says what to change in their own words; the model then replaces the plan.
        this.input.placeholder = CHANGE_PLAN_PLACEHOLDER
        this.input.focus()
        hooks.onActivity()
      },
    })
    this.chat = new ChatView({
      onPrompt: (text) => {
        cb.onUserText(text)
        hooks.onActivity()
      },
    })
    this.cards = h('div', { class: 'cards' })
    this.transcript = h('div', { class: 'transcript', 'aria-live': 'polite', hidden: true })
    this.announcer = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })
    // Browser speech uses the site's microphone permission, Whisper the extension's; settings has a section for each.
    this.voice = new VoiceRow((engine) => cb.onOpenSettings(engine === 'browser' ? 'site-mic' : 'mic'))

    // ----- composer -----
    this.input = h('textarea', {
      class: 'input',
      rows: '1',
      maxlength: String(MAX_INPUT),
      placeholder: INPUT_PLACEHOLDER,
      'aria-label': 'Message SOCKET',
    })
    this.micBtn = iconButton('mic', 'Hold to talk', 'icon-btn mic')
    this.micBtn.setAttribute('aria-pressed', 'false')
    this.sendBtn = iconButton('send', 'Send message', 'icon-btn send')
    const composer = h('div', { class: 'composer' }, this.input, this.micBtn, this.sendBtn)

    this.el = h(
      'div',
      { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'vsa-title', hidden: true },
      header,
      this.proactivityMenu,
      this.audioMenu,
      this.menu,
      this.banner,
      this.plan.el,
      this.chat.el,
      this.cards,
      this.transcript,
      this.voice.el,
      composer,
      this.announcer,
    )
    this.syncEmptyText()

    // ----- wiring -----
    closeBtn.addEventListener('click', () => this.close(true))
    this.proactivityBtn.addEventListener('click', () => this.toggleProactivityMenu())
    this.audioBtn.addEventListener('click', () => this.toggleAudioMenu())
    this.menuBtn.addEventListener('click', () => this.toggleMenu())
    clearItem.addEventListener('click', () => {
      this.toggleMenu(false)
      cb.onClearThread()
    })
    settingsItem.addEventListener('click', () => {
      this.toggleMenu(false)
      cb.onOpenSettings()
    })
    bannerBtn.addEventListener('click', () => cb.onOpenSettings())
    this.menu.addEventListener('keydown', (e) => this.handleMenuKeys(this.menu, e, () => this.toggleMenu(false)))
    this.audioMenu.addEventListener('keydown', (e) => this.handleMenuKeys(this.audioMenu, e, () => this.toggleAudioMenu(false)))
    this.proactivityMenu.addEventListener('keydown', (e) => this.handleMenuKeys(this.proactivityMenu, e, () => this.toggleProactivityMenu(false)))

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        if (this.isMicToggled) {
          this.isMicToggled = false
          this.releaseMic()
        }
        this.submit()
      }
    })
    this.input.addEventListener('input', () => this.autoGrow())
    this.sendBtn.addEventListener('click', () => {
      if (this.isMicToggled) {
        this.isMicToggled = false
        this.releaseMic()
      }
      if (this.busy) cb.onCancel()
      else this.submit()
    })
    this.wireMic()

    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (!this.menu.hidden || !this.audioMenu.hidden || !this.proactivityMenu.hidden) {
        if (!this.menu.hidden) {
          this.toggleMenu(false)
          this.menuBtn.focus()
        }
        if (!this.audioMenu.hidden) {
          this.toggleAudioMenu(false)
          this.audioBtn.focus()
        }
        if (!this.proactivityMenu.hidden) {
          this.toggleProactivityMenu(false)
          this.proactivityBtn.focus()
        }
      } else this.close(true)
    })
    this.el.addEventListener('pointerdown', (e) => {
      hooks.onActivity()
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && e.target !== this.menuBtn && !this.menuBtn.contains(e.target as Node)) {
        this.toggleMenu(false)
      }
      if (!this.audioMenu.hidden && !this.audioMenu.contains(e.target as Node) && e.target !== this.audioBtn && !this.audioBtn.contains(e.target as Node)) {
        this.toggleAudioMenu(false)
      }
      if (!this.proactivityMenu.hidden && !this.proactivityMenu.contains(e.target as Node) && e.target !== this.proactivityBtn && !this.proactivityBtn.contains(e.target as Node)) {
        this.toggleProactivityMenu(false)
      }
    })
    this.el.addEventListener('input', () => hooks.onActivity())

    this.resizeObs = new ResizeObserver(() => {
      if (this.opened) hooks.onResize()
    })
    this.resizeObs.observe(this.el)
  }

  get isOpen(): boolean {
    return this.opened
  }

  /** Where the open panel is going. Its left/top are CSS-transitioned, so the live rect lags behind position(). */
  targetRect(): Rect | null {
    if (!this.opened) return null
    if (!Number.isFinite(this.appliedLeft) || !Number.isFinite(this.appliedTop)) return rectOf(this.el)
    return {
      left: this.appliedLeft,
      top: this.appliedTop,
      right: this.appliedLeft + this.el.offsetWidth,
      bottom: this.appliedTop + this.el.offsetHeight,
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** A proposed plan is waiting for "Looks good, start" or "Change something" */
  get planNeedsAnswer(): boolean {
    return this.plan.needsAnswer
  }

  open(takeFocus: boolean): void {
    if (!this.opened) {
      this.opened = true
      this.el.hidden = false
      // Next frame so the open transition runs from the hidden state.
      requestAnimationFrame(() => this.el.classList.toggle('open', this.opened))
      this.chat.scrollToEnd()
      this.hooks.onOpenChange(true)
    }
    if (takeFocus) this.focusBest()
  }

  close(restoreFocus: boolean): void {
    if (!this.opened) return
    const hadFocus = this.hasFocus()
    this.opened = false
    this.panelDrag = null
    this.el.classList.remove('dragging')
    this.isMicToggled = false
    this.closeAllMenus()
    this.el.classList.remove('open')
    this.el.hidden = true
    this.releaseMic()
    this.hooks.onOpenChange(false)
    if (restoreFocus && hadFocus) this.hooks.focusOrb()
  }

  resetPosition(): void {
    this.userMoved = false
    this.userLeft = Number.NaN
    this.userTop = Number.NaN
  }

  toggle(): void {
    if (this.opened) this.close(true)
    else this.open(true)
  }

  setLines(lines: Record<string, string>): void {
    this.lines = lines
    this.syncEmptyText()
    if (!this.llmReady) this.setStatus(false, this.bannerText.dataset.reason)
  }

  setPageKind(kind: PageKind): void {
    this.pageKind = kind
    this.syncEmptyText()
  }

  setMode(mode: MascotMode): void {
    this.mode = mode
    this.syncStatus()
  }

  /** While a run is going, the header shows what the assistant is doing instead of a generic status */
  setThinking(text: string): void {
    this.thinking = text.replace(/\s+/g, ' ').trim()
    this.syncStatus()
  }

  setModeColor(color: string): void {
    this.el.style.setProperty('--mode-color', color)
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) this.thinking = ''
    this.plan.setBusy(busy)
    this.el.classList.toggle('busy', busy)
    this.sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'))
    const label = busy ? 'Stop' : 'Send message'
    this.sendBtn.setAttribute('aria-label', label)
    this.sendBtn.title = label
    this.syncStatus()
  }

  setStatus(llmReady: boolean, reason?: string): void {
    this.llmReady = llmReady
    this.banner.hidden = llmReady
    if (!llmReady) {
      this.bannerText.dataset.reason = reason ?? ''
      this.bannerText.textContent = reason?.trim() || this.lines.noKey || 'I need an AI key to think. Open settings to add one.'
    }
    this.syncStatus()
  }

  setHistory(lines: ChatLine[]): void {
    this.chat.setHistory(lines)
  }

  addChat(line: ChatLine): void {
    this.chat.add(line)
    if (line.role === 'user' && this.input.value.trim()) {
      const draft = this.input.value.replace(/\s+/g, ' ').trim()
      const posted = line.text.replace(/\s+/g, ' ').trim()
      if (draft === posted) {
        this.clearInput()
      }
    }
  }

  setPlan(plan: WorkflowPlan | null): void {
    this.plan.set(plan)
    if (!this.plan.needsAnswer) this.resetPlaceholder()
  }

  showConfirm(req: ConfirmRequest, takeFocus: boolean): void {
    this.removeCard(req.id)
    const card = confirmCard(req, (approved) => {
      this.removeCard(req.id)
      this.hooks.callbacks.onConfirm(req.id, approved)
      this.hooks.onActivity()
      if (this.opened) this.focusBest()
    })
    // Read before open(): a Space or Enter meant for the composer must not land on the card's buttons.
    const typing = this.typing()
    this.pending.set(req.id, { card, kind: 'confirm' })
    this.cards.prepend(card.el)
    this.open(false)
    if (takeFocus && !typing) card.focusTarget.focus()
    else this.announce(`Needs your confirmation: ${req.title}`)
  }

  dismissConfirm(id: string): void {
    if (this.pending.get(id)?.kind === 'confirm') this.removeCard(id)
  }

  /** Confirmations only exist inside an agent run; once the run ends they can no longer be answered. */
  dropConfirms(): void {
    for (const [id, p] of [...this.pending.entries()]) if (p.kind === 'confirm') this.removeCard(id)
  }

  dismissSuggestions(ids: string[]): void {
    for (const id of ids) if (this.pending.get(id)?.kind === 'suggestion') this.removeCard(id)
  }

  showSuggestion(s: Suggestion): void {
    this.removeCard(s.id)
    const card = suggestionCard(s, (action) => {
      this.removeCard(s.id)
      this.hooks.callbacks.onSuggestion(s.id, action)
      this.hooks.onActivity()
    })
    this.pending.set(s.id, { card, kind: 'suggestion' })
    this.cards.append(card.el)
    // Old unanswered suggestions are dropped quietly; they were only ever offers.
    const suggestions = [...this.pending.entries()].filter(([, p]) => p.kind === 'suggestion')
    for (const [id] of suggestions.slice(0, Math.max(0, suggestions.length - MAX_SUGGESTIONS))) this.removeCard(id)
  }

  setVoiceEnabled(enabled: boolean): void {
    this.micBtn.hidden = !enabled
  }

  setSettings(settings: UserSettings): void {
    this.settings = settings
    this.syncAudioBtn()
    this.syncProactivityBtn()
    this.syncMenuChecks()
  }

  setSttEngine(engine: SttEngine): void {
    this.voice.setEngine(engine, this.lines)
  }

  setVoiceState(state: VoiceState, detail?: string, progress?: number): void {
    this.voice.set(state, this.lines, detail, progress)
    if (state === 'listening') {
      this.isMicToggled = true
      this.micBtn.setAttribute('aria-pressed', 'true')
      this.micBtn.classList.add('held')
    } else if (state !== 'transcribing') {
      this.isMicToggled = false
      this.micHeld = false
      this.micBtn.setAttribute('aria-pressed', 'false')
      this.micBtn.classList.remove('held')
    }
    if (state === 'off' || state === 'ready' || state === 'error' || state === 'needs-permission') {
      if (!this.transcriptTimer) this.setTranscriptText('')
      this.inputPrefix = ''
    }
  }

  setVoiceLevel(level: number): void {
    this.voice.setLevel(level)
  }

  setTranscript(text: string, final: boolean): void {
    clearTimeout(this.transcriptTimer)
    this.transcriptTimer = 0
    this.setTranscriptText(text)

    if (final) {
      this.clearInput()
      this.transcriptTimer = window.setTimeout(() => {
        this.transcriptTimer = 0
        this.setTranscriptText('')
      }, FINAL_TRANSCRIPT_MS)
      if (this.isMicToggled) {
        this.isMicToggled = false
        this.releaseMicVisual()
      }
      return
    }

    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) {
      this.input.value = this.inputPrefix ? `${this.inputPrefix}${clean}` : clean
      this.autoGrow()
      this.hooks.onActivity()
    }
  }

  private readonly onHeaderDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const target = e.target as Element | null
    if (target?.closest('button, .icon-btn, .menu, a, input, textarea')) return
    const rect = this.el.getBoundingClientRect()
    this.panelDrag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }

  private readonly onHeaderMove = (e: PointerEvent): void => {
    const d = this.panelDrag
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return
      d.moved = true
      this.el.classList.add('dragging')
    }
    const vp = viewport(EDGE)
    const w = this.el.offsetWidth || PANEL_WIDTH
    const hgt = this.el.offsetHeight || 420
    const nextLeft = clamp(Math.round(d.startLeft + dx), vp.left, Math.max(vp.left, vp.right - w))
    const nextTop = clamp(Math.round(d.startTop + dy), vp.top, Math.max(vp.top, vp.bottom - hgt))

    this.userLeft = nextLeft
    this.userTop = nextTop
    this.userMoved = true

    this.appliedLeft = nextLeft
    this.appliedTop = nextTop
    this.el.style.left = `${nextLeft}px`
    this.el.style.top = `${nextTop}px`
    this.hooks.onActivity()
    this.hooks.onResize()
  }

  private readonly onHeaderEnd = (e: PointerEvent): void => {
    const d = this.panelDrag
    if (!d || e.pointerId !== d.id) return
    this.panelDrag = null
    this.el.classList.remove('dragging')
    this.hooks.onActivity()
    this.hooks.onResize()
  }

  private readonly onHeaderDblClick = (e: MouseEvent): void => {
    const target = e.target as Element | null
    if (target?.closest('button, .icon-btn, .menu, a, input, textarea')) return
    this.resetPosition()
    this.hooks.onResize()
  }

  /** Returns the bounding box of the automation flow area (center canvas / step nodes), or the center corridor */
  private getAutomationArea(vp: Rect): Rect {
    const nodes = document.querySelectorAll(
      '[data-testid^="step-node-"], [data-testid^="inflow-node-"], [data-testid^="delay-step-node-"], [data-testid^="if-component-"], [data-testid^="break-component-"], [data-testid="add-step-button"], [data-testid="vertical-stick-add-step"], [data-testid="select-trigger-prompt"], [data-testid="ai-first-empty-state"]',
    )
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let count = 0

    for (const node of nodes) {
      const r = node.getBoundingClientRect()
      if (r.width > 20 && r.height > 20) {
        minX = Math.min(minX, r.left)
        minY = Math.min(minY, r.top)
        maxX = Math.max(maxX, r.right)
        maxY = Math.max(maxY, r.bottom)
        count++
      }
    }

    if (count > 0 && Number.isFinite(minX) && maxX > minX) {
      return {
        left: Math.max(vp.left, minX - 24),
        top: Math.max(vp.top, minY - 24),
        right: Math.min(vp.right, maxX + 24),
        bottom: Math.min(vp.bottom, maxY + 24),
      }
    }

    const vw = vp.right - vp.left
    return {
      left: vp.left + vw * 0.3,
      top: vp.top + 40,
      right: vp.left + vw * 0.7,
      bottom: vp.bottom - 40,
    }
  }

  /** Places the panel beside the orb, inside the viewport, preferring a side that doesn't cover `avoid` */
  position(orb: Point, size: number, avoid: Rect | null, sideDrawer?: Rect | null): void {
    if (!this.opened) return
    const vp = viewport(EDGE)
    const w = Math.min(PANEL_WIDTH, vp.right - vp.left)
    const hgt = Math.min(this.el.offsetHeight || 420, vp.bottom - vp.top)

    if (this.userMoved && Number.isFinite(this.userLeft) && Number.isFinite(this.userTop)) {
      const l = clamp(this.userLeft, vp.left, Math.max(vp.left, vp.right - w))
      const t = clamp(this.userTop, vp.top, Math.max(vp.top, vp.bottom - hgt))
      if (l !== this.appliedLeft || t !== this.appliedTop) {
        this.appliedLeft = l
        this.appliedTop = t
        this.el.style.left = `${l}px`
        this.el.style.top = `${t}px`
      }
      return
    }

    const orbBox = boxAt(orb, size)
    const midX = (vp.left + vp.right) / 2

    // Check if the flow side panel / drawer is open on the right
    const hasRightDrawer = Boolean(sideDrawer && sideDrawer.left > (vp.right + EDGE) * 0.35)

    // Left edge boundary taking into account any left navigation bar
    let leftEdge = vp.left + 8
    const leftNav = document.querySelector(
      '[data-testid="custom-sidebar"], [data-testid="project-sidebar"], [data-testid="sidebar"], aside, nav',
    )
    if (leftNav) {
      const nr = rectOf(leftNav)
      if (hasArea(nr) && nr.left < 20 && nr.right > 20 && nr.right < 140) {
        leftEdge = Math.max(leftEdge, Math.round(nr.right + GAP))
      }
    }

    const autoArea = this.getAutomationArea(vp)

    // Keep the chat window towards the outside edges (never in the center flow area):
    // If the right drawer is open, or the orb is on the left half of the screen, place on the left outside.
    // Otherwise place on the right outside.
    const placeOnLeft = hasRightDrawer || (orb.x + size / 2) < midX

    let targetX: number
    if (placeOnLeft) {
      targetX = leftEdge
      // Ensure we don't extend into the automation area from the left
      if (autoArea && targetX + w > autoArea.left) {
        const maxLeft = autoArea.left - w - GAP
        if (maxLeft >= leftEdge) {
          targetX = Math.round(maxLeft)
        }
      }
    } else {
      targetX = Math.round(vp.right - w - 8)
      // Ensure we don't extend into the automation area from the right
      if (autoArea && targetX < autoArea.right) {
        const minRight = autoArea.right + GAP
        if (minRight <= vp.right - w - 8) {
          targetX = Math.round(minRight)
        }
      }
    }

    // Follow the orb vertically
    let top = clamp(orb.y + size / 2 - hgt / 2, vp.top + 30, vp.bottom - hgt)

    // Ensure the panel does not cover the orb:
    // If overlapping, place the panel above or below the orb along the outer edge.
    const testRect = { left: targetX, top, right: targetX + w, bottom: top + hgt }
    if (intersects(testRect, orbBox)) {
      if (orb.y - hgt - GAP >= vp.top + 30) {
        top = Math.round(orb.y - hgt - GAP)
      } else if (orb.y + size + GAP + hgt <= vp.bottom) {
        top = Math.round(orb.y + size + GAP)
      }
    }

    // Avoid covering any active highlight target
    if (avoid && intersects({ left: targetX, top, right: targetX + w, bottom: top + hgt }, avoid)) {
      if (avoid.top - hgt - GAP >= vp.top + 30) {
        top = Math.round(avoid.top - hgt - GAP)
      } else if (avoid.bottom + GAP + hgt <= vp.bottom) {
        top = Math.round(avoid.bottom + GAP)
      }
    }

    const l = Math.round(targetX)
    const t = Math.round(top)
    if (l !== this.appliedLeft || t !== this.appliedTop) {
      this.appliedLeft = l
      this.appliedTop = t
      this.el.style.left = `${l}px`
      this.el.style.top = `${t}px`
    }
    this.el.classList.toggle('from-left', l <= midX)
  }

  destroy(): void {
    clearTimeout(this.transcriptTimer)
    this.plan.destroy()
    this.resizeObs.disconnect()
    this.releaseMic()
  }

  // ---------- internals ----------

  private submit(): void {
    if (this.isMicToggled) {
      this.isMicToggled = false
      this.releaseMic()
    }
    const text = this.input.value.trim()
    if (!text) return
    this.hooks.callbacks.onUserText(text.slice(0, MAX_INPUT))
    this.clearInput()
    this.hooks.onActivity()
  }

  private clearInput(): void {
    this.input.value = ''
    this.inputPrefix = ''
    this.resetPlaceholder()
    this.autoGrow()
  }

  private resetPlaceholder(): void {
    if (this.input.placeholder !== INPUT_PLACEHOLDER) this.input.placeholder = INPUT_PLACEHOLDER
  }

  private autoGrow(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 132)}px`
  }

  private wireMic(): void {
    this.micBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      this.micDownTime = Date.now()

      if (this.isMicToggled || this.micHeld) {
        // Was already recording; clicking again turns it off
        this.stoppedFromToggle = true
        this.isMicToggled = false
        this.releaseMic()
        return
      }

      this.stoppedFromToggle = false
      try {
        this.micBtn.setPointerCapture(e.pointerId)
      } catch {}

      this.inputPrefix = this.input.value ? this.input.value.trim() + ' ' : ''
      this.pressMic()
    })

    this.micBtn.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      if (this.stoppedFromToggle) {
        this.stoppedFromToggle = false
        return
      }

      const holdDuration = Date.now() - this.micDownTime
      this.micHeld = false

      if (holdDuration < 350) {
        // Quick tap: keep recording in toggle mode without flickering
        this.isMicToggled = true
        this.micBtn.setAttribute('aria-pressed', 'true')
        this.micBtn.classList.add('held')
      } else {
        // Long hold (> 350ms): push-to-talk released
        this.isMicToggled = false
        this.releaseMic()
      }
    })

    this.micBtn.addEventListener('pointercancel', () => {
      this.micHeld = false
      if (!this.isMicToggled) this.releaseMic()
    })

    // Keyboard users: Space or Enter on the mic button toggles dictation
    this.micBtn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault()
        if (this.micHeld || this.isMicToggled) {
          this.releaseMic()
        } else {
          this.isMicToggled = true
          this.inputPrefix = this.input.value ? this.input.value.trim() + ' ' : ''
          this.pressMic()
        }
      }
    })

    this.micBtn.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private pressMic(): void {
    if (this.micHeld) return
    this.micHeld = true
    this.micBtn.setAttribute('aria-pressed', 'true')
    this.micBtn.classList.add('held')
    this.hooks.onActivity()
    this.hooks.callbacks.onMicDown()
  }

  private releaseMic(): void {
    this.isMicToggled = false
    this.micHeld = false
    this.micBtn.setAttribute('aria-pressed', 'false')
    this.micBtn.classList.remove('held')
    this.hooks.callbacks.onMicUp()
  }

  private releaseMicVisual(): void {
    if (this.micHeld || this.isMicToggled) return
    this.micBtn.setAttribute('aria-pressed', 'false')
    this.micBtn.classList.remove('held')
  }

  private setTranscriptText(text: string): void {
    const clean = text.trim()
    this.transcript.textContent = clean
    this.transcript.hidden = clean.length === 0
  }

  private removeCard(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    p.card.el.remove()
    this.pending.delete(id)
  }

  private focusBest(): void {
    if (!this.typing()) {
      for (const p of this.pending.values()) {
        if (p.kind === 'confirm') {
          p.card.focusTarget.focus()
          return
        }
      }
    }
    this.input.focus()
  }

  /** The user is writing a message (composer focused, or a draft in it while focus is in the panel) */
  private typing(): boolean {
    if (!this.hasFocus()) return false
    const root = this.el.getRootNode()
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement
    return active === this.input || this.input.value.length > 0
  }

  private announce(text: string): void {
    // Re-setting the same text is not announced again; clear first.
    this.announcer.textContent = ''
    requestAnimationFrame(() => {
      this.announcer.textContent = text
    })
  }

  private closeAllMenus(): void {
    this.toggleMenu(false)
    this.toggleAudioMenu(false)
    this.toggleProactivityMenu(false)
  }

  private toggleMenu(force?: boolean): void {
    const open = force ?? Boolean(this.menu.hidden)
    if (open) {
      this.toggleAudioMenu(false)
      this.toggleProactivityMenu(false)
    }
    this.menu.hidden = !open
    this.menuBtn.setAttribute('aria-expanded', String(open))
    this.menuBtn.classList.toggle('active', open)
    if (open) this.menu.querySelector<HTMLButtonElement>('.menu-item')?.focus()
  }

  private toggleAudioMenu(force?: boolean): void {
    const open = force ?? Boolean(this.audioMenu.hidden)
    if (open) {
      this.toggleMenu(false)
      this.toggleProactivityMenu(false)
    }
    this.audioMenu.hidden = !open
    this.audioBtn.setAttribute('aria-expanded', String(open))
    this.audioBtn.classList.toggle('active', open)
    if (open) this.audioMenu.querySelector<HTMLButtonElement>('.menu-item.active, .menu-item')?.focus()
  }

  private toggleProactivityMenu(force?: boolean): void {
    const open = force ?? Boolean(this.proactivityMenu.hidden)
    if (open) {
      this.toggleMenu(false)
      this.toggleAudioMenu(false)
    }
    this.proactivityMenu.hidden = !open
    this.proactivityBtn.setAttribute('aria-expanded', String(open))
    this.proactivityBtn.classList.toggle('active', open)
    if (open) this.proactivityMenu.querySelector<HTMLButtonElement>('.menu-item.active, .menu-item')?.focus()
  }

  private handleMenuKeys(menuEl: HTMLElement, e: KeyboardEvent, onClose: () => void): void {
    const items = Array.from(menuEl.querySelectorAll<HTMLButtonElement>('.menu-item'))
    const root = this.el.getRootNode() as ShadowRoot | Document
    const i = items.indexOf(root.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    } else if (e.key === 'Tab') {
      onClose()
    }
  }

  private syncStatus(): void {
    let text = STATUS[this.mode]
    if (this.busy && (this.mode === 'idle' || this.mode === 'happy')) text = 'Working'
    if (this.busy && this.thinking) text = this.thinking
    if (!this.llmReady) text = 'Needs setup'
    this.status.textContent = text
    this.status.title = text
  }

  private hasFocus(): boolean {
    const root = this.el.getRootNode()
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement
    return active !== null && this.el.contains(active)
  }

  private syncEmptyText(): void {
    const devHub = this.pageKind === 'developer-hub' || this.pageKind === 'developer-hub-plugin'
    const greeting = (devHub ? this.lines.greetingDevHub : undefined) ?? this.lines.greeting
    this.chat.setEmptyText(greeting ?? 'Hi! Tell me what to build, or hold the mic button and talk.')
  }

  private syncAudioBtn(): void {
    const mode = this.settings.audioOutput ?? (this.settings.speakReplies === false ? 'off' : 'full')
    const iconName = mode === 'full' ? 'volumeFull' : mode === 'minimal' ? 'volumeLow' : 'volumeMute'
    const label =
      mode === 'full'
        ? 'Full response'
        : mode === 'minimal'
          ? 'Minimal response'
          : 'Muted'
    this.audioBtn.title = `Audio output: ${label}`
    this.audioBtn.setAttribute('aria-label', `Audio output: ${label}`)
    this.audioBtn.replaceChildren(icon(iconName))
  }

  private syncProactivityBtn(): void {
    const mode = this.settings.proactivity ?? 'proactive'
    const label =
      mode === 'proactive'
        ? 'Proactive'
        : mode === 'helpful'
          ? 'Helpful'
          : 'Quiet'
    this.proactivityBtn.title = `Bot proactivity: ${label}`
    this.proactivityBtn.setAttribute('aria-label', `Bot proactivity: ${label}`)
    this.proactivityBtn.classList.toggle('proactive-mode', mode === 'proactive')
    this.proactivityBtn.classList.toggle('quiet-mode', mode === 'quiet')
  }

  private syncMenuChecks(): void {
    const curAudio = this.settings.audioOutput ?? (this.settings.speakReplies === false ? 'off' : 'full')
    for (const [mode, btn] of this.audioItems) {
      const active = mode === curAudio
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-checked', String(active))
    }
    const curProactivity = this.settings.proactivity ?? 'proactive'
    for (const [mode, btn] of this.proactivityItems) {
      const active = mode === curProactivity
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-checked', String(active))
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi))
}
