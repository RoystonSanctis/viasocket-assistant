// Mascot UI entry: one closed-shadow host appended to <html> (never inside React-owned nodes: the page alerts
// on foreign mutations of its tree), a single frame loop that idles at a few Hz when nothing moves, and the
// glue between the orb, thinking line, panel, spotlight and motion controller.

import type { ClientConfig, MascotConfig } from '../../shared/config'
import { normalizePlan, type ChatLine, type ConfirmRequest, type HighlightTarget, type MascotMode, type Suggestion, type WorkflowPlan } from '../../shared/mascot'
import type { SttEngine, VoiceState } from '../../shared/messages'
import type { PageContext, PageKind } from '../../shared/page'
import type { UserSettings } from '../../shared/settings'
import type { CreateMascot, MascotCallbacks, MascotController } from './api'
import { Bubble } from './bubble'
import { DEFAULT_MASCOT } from './defaults'
import { h, isEditable } from './dom'
import { resolveTarget, Spotlight, type ResolvedTarget } from './highlight'
import { viewport, type Rect } from './geometry'
import { Motion } from './motion'
import { OrbInput } from './orb-input'
import { Panel } from './panel'
import { loadPark, savePark, type ParkSpot } from './park-store'
import { restingText } from './plan-card'
import { Selectors } from './selectors'
import { STYLES } from './styles'
import { ThinkingLine } from './thinking'

const HOST_TAG = 'vs-assistant-root'
const IDLE_TICK_MS = 250
const WAKING_MS = 900
const ACTIVITY_THROTTLE_MS = 500
const FALLBACK_COLOR = '#5DCAA5'
/** Upper bound on waiting for the saved park spot before the orb first appears */
const READY_FALLBACK_MS = 800

/** Moods that fall back to idle on their own if nobody changes them (the worker also resets after runs) */
const TRANSIENT_MS: Partial<Record<MascotMode, number>> = {
  celebrate: 4000,
  happy: 3500,
  confused: 8000,
  curious: 8000,
  suggest: 15000,
}
/** Modes in which the orb hovers in place instead of roaming */
const HOLD_MODES = new Set<MascotMode>(['listening', 'thinking', 'searching', 'working'])
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Meta', 'Shift', 'AltGraph'])
/** Events that must not leak from the panel to the page's document/window handlers (shortcuts, click-away) */
const CONTAINED_EVENTS = [
  'keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'focusin', 'focusout',
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu',
] as const

const HOST_STYLE: Array<[string, string]> = [
  ['all', 'initial'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['width', '0'],
  ['height', '0'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['display', 'block'],
  ['overflow', 'visible'],
  ['z-index', '2147483000'],
  ['pointer-events', 'none'],
  // Any of these on the host would turn it into the containing block for our position:fixed children.
  ['transform', 'none'],
  ['filter', 'none'],
  ['contain', 'none'],
  ['opacity', '1'],
  ['visibility', 'visible'],
]

function safeColor(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && CSS.supports('color', value) ? value : null
}

function pathOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** Page-level listeners see focus and keys inside the closed shadow root as coming from the host element. */
export function isMascotHost(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.localName === HOST_TAG
}

class Mascot implements MascotController {
  private readonly host: HTMLElement
  private readonly root: HTMLDivElement
  private readonly live: HTMLDivElement
  private readonly sel = new Selectors()
  private readonly bubble = new Bubble()
  private readonly thinking = new ThinkingLine()
  private readonly panel: Panel
  private readonly spot: Spotlight
  private readonly motion: Motion
  private readonly orbInput: OrbInput
  private readonly reducedMotion: MediaQueryList
  private readonly hostObserver: MutationObserver
  private readonly cleanups: Array<() => void> = []
  private readonly cb: MascotCallbacks

  private mascot: MascotConfig = DEFAULT_MASCOT
  private size = DEFAULT_MASCOT.size
  private page: PageContext | null = null
  private enabled = true
  private destroyed = false
  private mode: MascotMode = 'idle'
  private modeBeforeHighlight: MascotMode | null = null
  /** The current highlight was asked for (not a reaction's), so a target that never shows up is reported */
  private reportMiss = false
  private busy = false
  private plan: WorkflowPlan | null = null
  private voice: VoiceState = 'off'
  private asleep = false
  private wakingUntil = 0
  private lastActivity = performance.now()
  private pageTyping = false
  private unread = false
  private parkLoadSeq = 0
  /** False until the saved park spot is known, so the orb doesn't appear in a corner and then fly away */
  private ready = false
  private readyTimer = 0
  private raf = 0
  private idleTimer = 0
  private modeTimer = 0
  private wakeTimer = 0

  constructor(cb: MascotCallbacks) {
    this.cb = cb
    this.host = document.createElement(HOST_TAG)
    for (const [prop, value] of HOST_STYLE) this.host.style.setProperty(prop, value, 'important')
    // Closed: page scripts (and session-replay recorders) cannot read the conversation out of the DOM.
    const shadow = this.host.attachShadow({ mode: 'closed' })

    this.spot = new Spotlight(this.sel, (unseen) => this.onSpotLost(unseen), () => this.clearHighlight())
    this.panel = new Panel({
      callbacks: cb,
      onOpenChange: (open) => this.onPanelOpenChange(open),
      onActivity: () => this.activity(),
      onResize: () => this.positionPanel(),
      focusOrb: () => this.bubble.button.focus(),
    })
    this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })
    this.bubble.mover.append(this.thinking.el)
    this.root = h('div', { class: 'root' }, this.spot.ring, this.spot.note, this.bubble.mover, this.panel.el, this.live)
    const style = document.createElement('style')
    style.textContent = STYLES
    shadow.append(style, this.root)

    this.motion = new Motion({
      mover: this.bubble.mover,
      host: this.host,
      sel: this.sel,
      isHeld: () => this.isHeld(),
      isPanelOpen: () => this.panel.isOpen,
      highlightAnchor: () => this.spot.anchor(),
      // The orb dodges the panel's destination: dodging its mid-transition box made the two chase each other.
      panelRect: () => this.panel.targetRect(),
      onMoved: (x) => this.onMoved(x),
    })

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.setReducedMotion(this.reducedMotion.matches)
    this.listen(this.reducedMotion, 'change', () => {
      this.motion.setReducedMotion(this.reducedMotion.matches)
      this.kick()
    })

    this.orbInput = new OrbInput(this.bubble.button, this.motion, {
      onActivity: () => this.activity(),
      onDragStart: () => this.onDragStart(),
      onDragEnd: (spot) => this.onDragEnd(spot),
      onUnpark: () => this.onUnpark(),
      onToggle: () => this.panel.toggle(),
      onEscape: () => this.panel.close(false),
    })

    this.applyMascotConfig(DEFAULT_MASCOT)
    this.wireDocument(shadow)

    document.documentElement.append(this.host)
    // Some SPAs rebuild <html>'s children on navigation; put the host back if it gets dropped.
    this.hostObserver = new MutationObserver(() => {
      if (!this.destroyed && !this.host.isConnected) document.documentElement.append(this.host)
    })
    this.hostObserver.observe(document.documentElement, { childList: true })

    this.readyTimer = window.setTimeout(() => this.markReady(), READY_FALLBACK_MS)
    this.kick()
  }

  // ---------- MascotController ----------

  setConfig(config: ClientConfig): void {
    if (this.destroyed) return
    this.sel.set(config.selectors)
    this.applyMascotConfig(config.mascot)
    this.motion.invalidate()
    this.kick()
  }

  setPage(page: PageContext): void {
    if (this.destroyed) return
    const kindChanged = this.page?.kind !== page.kind
    // Query-only changes (?stepId, ?timestamp) often come right before or after a highlight; the spotlight copes
    // with targets that disappear, so only a different page clears it.
    const pathChanged = pathOf(this.page?.url) !== pathOf(page.url)
    this.page = page
    if (pathChanged) this.clearHighlight()
    this.motion.setPage(page)
    this.panel.setPageKind(page.kind)
    if (kindChanged) this.loadParkFor(page.kind)
    this.kick()
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed) return
    this.enabled = enabled
    this.root.classList.toggle('hidden', !enabled)
    if (enabled) {
      this.activity()
      this.syncResting()
      this.kick()
      return
    }
    this.panel.close(false)
    this.clearHighlight()
    this.thinking.clear()
    this.syncResting()
    this.pause()
  }

  setMode(mode: MascotMode, text?: string): void {
    if (this.destroyed) return
    this.lastActivity = performance.now()
    if (mode === 'sleeping') {
      this.mode = 'idle'
      this.fallAsleep()
      return
    }
    if (this.asleep) {
      this.asleep = false
      if (mode === 'idle') this.beginWaking()
      else this.bubble.stretch()
      this.syncResting()
    }
    this.mode = mode
    this.scheduleRevert(mode)
    if (text) this.setThinking(text)
    this.applyMode()
    this.kick()
  }

  setThinking(text: string): void {
    if (this.destroyed) return
    if (text.trim()) this.activity()
    const shown = this.thinking.set(text, this.mascot.thinkingTextMaxChars, this.reducedMotion.matches)
    this.panel.setThinking(shown)
    // While the panel is open its header status (also a live region) shows the same text.
    if (shown && !this.panel.isOpen) this.live.textContent = shown
  }

  addChat(line: ChatLine): void {
    if (this.destroyed) return
    this.panel.addChat(line)
    if (line.role === 'assistant' && !this.panel.isOpen) this.unread = true
    this.syncBadge()
    this.activity()
  }

  setHistory(lines: ChatLine[]): void {
    if (this.destroyed) return
    this.panel.setHistory(lines)
  }

  setPlan(raw: WorkflowPlan | null): void {
    if (this.destroyed) return
    const prev = this.plan
    const plan = normalizePlan(raw)
    this.plan = plan
    this.panel.setPlan(plan)
    // A plan proposed during a run waits for the user like a confirmation does, so the panel opens (focus stays put).
    // One replayed from history (a reload, another tab) does not pop the panel open.
    const newRequest = !!plan?.awaitingConfirmation && (!prev || prev.id !== plan.id || !prev.awaitingConfirmation)
    if (newRequest && this.busy && this.enabled) this.panel.open(false)
    if (plan) this.activity()
    this.syncResting()
    this.syncBadge()
  }

  showConfirm(request: ConfirmRequest): void {
    if (this.destroyed) return
    this.activity()
    // A pending confirmation blocks the agent, so the panel opens; focus moves only if the user isn't typing.
    this.panel.showConfirm(request, !this.pageTyping)
    this.syncBadge()
  }

  dismissConfirm(id: string): void {
    if (this.destroyed) return
    this.panel.dismissConfirm(id)
    this.syncBadge()
  }

  dismissSuggestions(ids: string[]): void {
    if (this.destroyed) return
    this.panel.dismissSuggestions(ids)
    this.syncBadge()
  }

  showSuggestion(suggestion: Suggestion): void {
    if (this.destroyed) return
    this.activity()
    this.panel.showSuggestion(suggestion)
    if (suggestion.mood) this.setMode(suggestion.mood)
    const target = suggestion.target
    // Reactions only point at what is on screen right now; they never wait for a target or report a miss.
    const resolved =
      this.enabled && !this.spot.active && typeof target === 'object' && target !== null ? resolveTarget(target, this.sel) : null
    if (target && resolved) this.startHighlight(target, resolved, suggestion.message, false)
    else if (!this.panel.isOpen) this.setThinking(suggestion.message)
    this.syncBadge()
  }

  highlight(target: HighlightTarget, note?: string): boolean {
    if (this.destroyed || !this.enabled || typeof target !== 'object' || target === null) return false
    // Unresolved targets stay pending (a slider may still be opening after navigation); misses are reported later.
    this.startHighlight(target, resolveTarget(target, this.sel), note, true)
    return true
  }

  private startHighlight(target: HighlightTarget, resolved: ResolvedTarget | null, note: unknown, reportMiss: boolean): void {
    this.activity()
    this.reportMiss = reportMiss
    this.spot.show(target, resolved, typeof note === 'string' ? note : undefined, performance.now())
    if (this.mode !== 'suggest') this.modeBeforeHighlight = this.mode
    else this.modeBeforeHighlight ??= this.busy ? 'thinking' : 'idle'
    this.mode = 'suggest'
    clearTimeout(this.modeTimer)
    this.applyMode()
    this.kick()
  }

  clearHighlight(): void {
    const wasActive = this.spot.active
    this.reportMiss = false
    this.spot.clear()
    if (this.mode === 'suggest' && this.modeBeforeHighlight !== null) this.mode = this.modeBeforeHighlight
    this.modeBeforeHighlight = null
    if (!wasActive) return
    this.applyMode()
    this.positionPanel()
    this.kick()
  }

  setVoiceState(state: VoiceState, detail?: string, progress?: number): void {
    if (this.destroyed) return
    this.voice = state
    this.panel.setVoiceState(state, detail, progress)
    if (state !== 'listening') this.bubble.resetLevel()
    if (state !== 'off' && state !== 'ready') this.activity()
    // The "Allow microphone" button lives in the panel, so show it.
    if (state === 'needs-permission') this.panel.open(false)
    if (state === 'error' && !this.panel.isOpen) this.setThinking(detail?.trim() || 'Voice input failed.')
    this.applyMode()
    this.kick()
  }

  setSttEngine(engine: SttEngine): void {
    if (this.destroyed) return
    this.panel.setSttEngine(engine)
  }

  setVoiceLevel(level: number): void {
    if (this.destroyed) return
    this.bubble.setLevel(level)
    this.panel.setVoiceLevel(level)
  }

  setTranscript(text: string, final: boolean): void {
    if (this.destroyed) return
    this.panel.setTranscript(text, final)
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || this.panel.isOpen) return
    // Show the end of what is being said; the start has already scrolled past.
    const max = Math.max(8, this.mascot.thinkingTextMaxChars)
    this.thinking.set(clean.length > max ? `…${clean.slice(-(max - 1))}` : clean, max, true)
  }

  setBusy(busy: boolean): void {
    if (this.destroyed) return
    this.busy = busy
    this.thinking.setBusy(busy)
    this.panel.setBusy(busy)
    if (!busy) {
      this.panel.dropConfirms()
      this.syncBadge()
    }
    this.activity()
    this.kick()
  }

  openPanel(takeFocus = true): void {
    if (this.destroyed || !this.enabled) return
    this.activity()
    this.panel.open(takeFocus)
  }

  closePanel(): void {
    if (this.destroyed) return
    this.panel.close(false)
  }

  togglePanel(): void {
    if (this.destroyed || !this.enabled) return
    this.activity()
    if (this.panel.isOpen) this.panel.close(true)
    else this.panel.open(true)
  }

  isPanelOpen(): boolean {
    return !this.destroyed && this.panel.isOpen
  }

  setVoiceEnabled(enabled: boolean): void {
    if (this.destroyed) return
    this.panel.setVoiceEnabled(enabled)
  }

  setStatus(llmReady: boolean, reason?: string): void {
    if (this.destroyed) return
    this.panel.setStatus(llmReady, reason)
  }

  setSettings(settings: UserSettings): void {
    if (this.destroyed) return
    this.panel.setSettings(settings)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.pause()
    for (const t of [this.modeTimer, this.wakeTimer, this.readyTimer]) clearTimeout(t)
    for (const fn of this.cleanups.splice(0)) fn()
    this.hostObserver.disconnect()
    this.orbInput.destroy()
    this.bubble.destroy()
    this.thinking.destroy()
    this.panel.destroy()
    this.host.remove()
  }

  // ---------- frame loop ----------

  private readonly kick = (): void => {
    if (!this.running()) return
    clearTimeout(this.idleTimer)
    this.idleTimer = 0
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (!this.running()) return
    const tracking = this.spot.update(now)
    const moving = this.ready ? this.motion.step(now) : false
    if (this.panel.isOpen) this.positionPanel()
    if (this.motion.placed) {
      this.thinking.place(this.motion.position.x, this.size, this.getSidePanelRect())
      this.bubble.setVisible(true)
    }
    this.bubble.setLook(this.motion.look.x, this.motion.look.y)
    this.checkSleep(now)
    // Something above (e.g. a lost highlight) may already have kicked off the next frame; never run two chains.
    if (tracking || moving || this.orbInput.dragging) {
      if (!this.raf) this.raf = requestAnimationFrame(this.frame)
    } else if (!this.raf) this.idleTimer = window.setTimeout(this.kick, IDLE_TICK_MS)
  }

  private running(): boolean {
    return this.enabled && !this.destroyed && !document.hidden
  }

  private pause(): void {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.idleTimer)
    this.raf = 0
    this.idleTimer = 0
  }

  // ---------- mode, sleep, activity ----------

  private applyMode(): void {
    const now = performance.now()
    let m: MascotMode = this.mode
    if (this.asleep) m = 'sleeping'
    else if (now < this.wakingUntil) m = 'waking'
    else if (this.voice === 'listening') m = 'listening'
    const color = this.colorFor(m)
    this.bubble.setMode(m)
    this.bubble.setColor(color)
    this.panel.setMode(m)
    this.panel.setModeColor(color)
  }

  private colorFor(mode: MascotMode): string {
    const colors = this.mascot.colors as Partial<Record<MascotMode, string>>
    const fallback = DEFAULT_MASCOT.colors as Partial<Record<MascotMode, string>>
    return safeColor(colors[mode]) ?? safeColor(fallback[mode]) ?? safeColor(colors.idle) ?? FALLBACK_COLOR
  }

  private scheduleRevert(mode: MascotMode): void {
    clearTimeout(this.modeTimer)
    this.modeTimer = 0
    const ms = TRANSIENT_MS[mode]
    if (!ms) return
    this.modeTimer = window.setTimeout(() => {
      this.modeTimer = 0
      if (this.mode !== mode || (mode === 'suggest' && this.spot.active)) return
      this.mode = this.busy ? 'thinking' : 'idle'
      this.applyMode()
      this.kick()
    }, ms)
  }

  private beginWaking(): void {
    this.wakingUntil = performance.now() + WAKING_MS
    clearTimeout(this.wakeTimer)
    this.wakeTimer = window.setTimeout(() => {
      this.applyMode()
      this.kick()
    }, WAKING_MS + 20)
  }

  private activity(): void {
    this.lastActivity = performance.now()
    if (!this.asleep) return
    this.asleep = false
    this.beginWaking()
    this.syncResting()
    this.applyMode()
    this.kick()
  }

  private fallAsleep(): void {
    if (this.asleep) return
    this.asleep = true
    this.thinking.clear()
    this.syncResting()
    this.applyMode()
    this.kick()
  }

  /** While idle, the line next to the orb shows where the plan stands (the item in progress); asleep it shows nothing. */
  private syncResting(): void {
    const text = this.enabled && !this.asleep && !this.destroyed ? restingText(this.plan) : ''
    this.thinking.setResting(text, this.mascot.thinkingTextMaxChars)
  }

  private checkSleep(now: number): void {
    if (this.asleep) return
    const after = this.mascot.roam.sleepAfterSeconds
    if (!(after > 0) || now - this.lastActivity < after * 1000) return
    if (this.busy || this.panel.isOpen || this.spot.active || this.orbInput.pressed) return
    if (this.voice === 'listening' || this.voice === 'transcribing' || this.voice === 'loading-model') return
    if (this.mode !== 'idle' && this.mode !== 'happy') return
    this.fallAsleep()
  }

  private isHeld(): boolean {
    return (
      this.busy ||
      this.asleep ||
      this.pageTyping ||
      this.orbInput.pressed ||
      this.panel.isOpen ||
      this.voice === 'listening' ||
      this.voice === 'transcribing' ||
      HOLD_MODES.has(this.mode)
    )
  }

  // ---------- layout ----------

  private applyMascotConfig(m: MascotConfig): void {
    this.mascot = m
    this.size = Math.min(96, Math.max(24, Number.isFinite(m.size) ? m.size : DEFAULT_MASCOT.size))
    this.bubble.setSize(this.size)
    this.motion.setSize(this.size)
    this.motion.setRoam(m.roam)
    this.panel.setLines(m.lines)
    this.root.style.setProperty('--hl', this.colorFor('suggest'))
    this.applyMode()
    // thinkingTextMaxChars may have changed. (The first call runs from the constructor, before the plan exists.)
    if (this.plan) this.syncResting()
  }

  private onMoved(x: number): void {
    this.thinking.place(x, this.size, this.getSidePanelRect())
    this.positionPanel()
  }

  private getSidePanelRect(): Rect | null {
    const r = this.motion.getDockRect()
    const vp = viewport()
    if (r && r.left > (vp.right - vp.left) * 0.35 && r.right >= vp.right - 40) {
      return r
    }
    return null
  }

  private positionPanel(): void {
    if (!this.panel.isOpen) return
    this.motion.ensurePlaced()
    const sideDrawer = this.getSidePanelRect()
    this.panel.position(this.motion.position, this.size, this.spot.anchor()?.rect ?? null, sideDrawer)
    this.kick()
  }

  private onPanelOpenChange(open: boolean): void {
    this.bubble.setExpanded(open)
    this.root.classList.toggle('panel-open', open)
    if (open) {
      this.unread = false
      this.positionPanel()
      this.activity()
    }
    this.syncBadge()
    this.cb.onPanelOpenChange?.(open)
    this.kick()
  }

  private syncBadge(): void {
    this.bubble.setBadge(!this.panel.isOpen && (this.unread || this.panel.pendingCount > 0 || this.panel.planNeedsAnswer))
  }

  private loadParkFor(kind: PageKind): void {
    const seq = ++this.parkLoadSeq
    void loadPark(kind).then((spot) => {
      if (seq !== this.parkLoadSeq || this.destroyed) return
      this.motion.setPark(spot)
      this.bubble.setParked(spot !== null)
      this.markReady()
      this.kick()
    })
  }

  private markReady(): void {
    clearTimeout(this.readyTimer)
    this.ready = true
    this.kick()
  }

  private onSpotLost(unseen: boolean): void {
    const report = unseen && this.reportMiss
    this.clearHighlight()
    if (report) this.cb.onHighlightMissed()
  }

  // ---------- orb interaction ----------

  private onDragStart(): void {
    this.bubble.setDragging(true)
    this.panel.resetPosition()
    if (this.spot.active) this.clearHighlight()
    this.kick()
  }

  private onDragEnd(spot: ParkSpot): void {
    this.bubble.setDragging(false)
    this.bubble.setParked(true)
    this.parkLoadSeq++
    this.panel.resetPosition()
    if (this.page) void savePark(this.page.kind, spot)
    this.positionPanel()
    this.kick()
  }

  private onUnpark(): void {
    this.bubble.setParked(false)
    this.parkLoadSeq++
    this.panel.resetPosition()
    if (this.page) void savePark(this.page.kind, null)
    this.kick()
  }

  // ---------- page-level listeners ----------

  private wireDocument(shadow: ShadowRoot): void {
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.pause()
      else this.kick()
    })
    this.listen(window, 'resize', () => {
      this.motion.invalidate()
      this.positionPanel()
      this.kick()
    }, { passive: true })

    const onUser = (): void => {
      if (!this.asleep && performance.now() - this.lastActivity < ACTIVITY_THROTTLE_MS) return
      this.activity()
    }
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) {
      this.listen(document, type, onUser, { capture: true, passive: true })
    }

    this.listen(document, 'focusin', (e) => {
      const t = e.target
      this.pageTyping = t instanceof Element && t !== this.host && isEditable(t)
      if (this.pageTyping) this.activity()
      this.kick()
    }, true)
    this.listen(document, 'focusout', () => {
      // activeElement is only settled once the focus change finishes.
      queueMicrotask(() => {
        const a = document.activeElement
        this.pageTyping = a !== null && a !== this.host && isEditable(a)
        this.kick()
      })
    }, true)

    // Bubble-phase containment at the shadow boundary. The page's own capture listeners (and the content
    // script's hotkey, which listens in capture) still see everything; modifier keys pass so hold-to-talk works.
    const contain = (e: Event): void => {
      if (e instanceof KeyboardEvent && MODIFIER_KEYS.has(e.key)) return
      e.stopPropagation()
    }
    for (const type of CONTAINED_EVENTS) this.listen(shadow, type, contain)
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (e: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options)
    this.cleanups.push(() => target.removeEventListener(type, handler, options))
  }
}

export const createMascot: CreateMascot = (callbacks) => new Mascot(callbacks)
