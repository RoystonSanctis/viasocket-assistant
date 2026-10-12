// Hold-to-talk hotkey (default Control+Option/Alt held on its own).
//
// Talking starts only after the exact chord has been held for holdMs with nothing else pressed, so ordinary
// shortcuts that share the modifiers (Ctrl+Alt+X) keep working: pressing any other key during the hold cancels it,
// and the chord stays ignored until every key is released.

import type { HotkeySetting } from '../shared/settings'
import { isMascotHost } from './mascot'
import { isEditable } from './mascot/dom'

export interface HotkeyOptions {
  setting(): HotkeySetting
  holdMs(): number
  /** False while the mascot is hidden or the page is unsupported */
  enabled(): boolean
  onStart(): void
  onStop(): void
  /** Another key joined after talking started (a slow Ctrl+Alt+X); the caller should drop what was heard */
  onCancel(): void
}

export interface Hotkey {
  destroy(): void
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
])
const PRINTABLE_CODE =
  /^(?:Key[A-Z]|Digit\d|Numpad(?:\d|Decimal|Divide|Multiply|Subtract|Add)|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|IntlRo|IntlYen|Semicolon|Quote|Comma|Period|Slash)$/
const IS_MAC = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform,
)

function hasChord(s: HotkeySetting): boolean {
  return s.ctrl || s.alt || s.shift || s.meta || s.code !== ''
}

function anyModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.altKey || e.shiftKey || e.metaKey
}

/** Shift (and Option on a Mac) still type characters, so a chord made only of those plus a character key is typing */
function typesCharacter(s: HotkeySetting): boolean {
  return PRINTABLE_CODE.test(s.code) && !s.ctrl && !s.meta && (!s.alt || IS_MAC)
}

function inTextField(e: KeyboardEvent): boolean {
  // Focus inside the mascot's closed shadow root shows up as its host (the composer is the only text field there).
  const t = e.composedPath()[0] ?? e.target
  return isMascotHost(t) || (t instanceof Element && isEditable(t))
}

function modifiersMatch(e: KeyboardEvent, s: HotkeySetting): boolean {
  // AltGr on Windows layouts reports Ctrl+Alt; it is used for typing characters, never for talking.
  if (e.getModifierState?.('AltGraph')) return false
  return e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta
}

export function createHotkey(opts: HotkeyOptions): Hotkey {
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let active = false
  /** Set when anything else was pressed during the chord; cleared once all keys are up */
  let tainted = false
  let codeDown = false

  function cancelHold(): void {
    clearTimeout(holdTimer)
    holdTimer = undefined
  }

  function stopTalking(): void {
    cancelHold()
    if (active) {
      active = false
      opts.onStop()
    }
  }

  function taint(): void {
    tainted = true
    cancelHold()
    if (active) {
      active = false
      opts.onCancel()
    }
  }

  function reset(): void {
    stopTalking()
    tainted = false
    codeDown = false
  }

  function satisfied(e: KeyboardEvent, s: HotkeySetting): boolean {
    return modifiersMatch(e, s) && (s.code === '' || codeDown)
  }

  function armIfReady(e: KeyboardEvent, s: HotkeySetting): void {
    if (tainted || active || holdTimer || !satisfied(e, s)) return
    const ms = Math.min(Math.max(opts.holdMs(), 50), 2000)
    holdTimer = setTimeout(() => {
      holdTimer = undefined
      active = true
      opts.onStart()
    }, ms)
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Page scripts can dispatch keyboard events too; only the user's own keys may open the microphone.
    if (!e.isTrusted) return
    const s = opts.setting()
    if (!opts.enabled() || !hasChord(s)) return
    const isModifier = MODIFIER_CODES.has(e.code)
    const isCode = s.code !== '' && e.code === s.code
    if (isCode && typesCharacter(s) && inTextField(e)) return

    if (isCode && modifiersMatch(e, s)) {
      // With a character key in the chord, stop it from typing into whatever has focus.
      e.preventDefault()
    }
    if (e.repeat) return

    if (!isModifier && !isCode) {
      // A shortcut is being typed, not a talk chord.
      if (holdTimer || active || anyModifier(e)) taint()
      return
    }
    if (isCode) codeDown = true
    if ((holdTimer || active) && !satisfied(e, s)) {
      // An extra modifier joined the chord (e.g. Ctrl+Alt+Shift…), so this is some other shortcut.
      taint()
      return
    }
    armIfReady(e, s)
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (!e.isTrusted) return
    const s = opts.setting()
    if (s.code !== '' && e.code === s.code) {
      codeDown = false
      if (modifiersMatch(e, s)) e.preventDefault()
    }
    if ((holdTimer || active) && !satisfied(e, s)) stopTalking()
    if (!anyModifier(e) && !codeDown) tainted = false
  }

  function onPointer(e: Event): void {
    if (!e.isTrusted) return
    // Ctrl+click / Ctrl+wheel during the hold is a mouse gesture, not talking.
    if (holdTimer) taint()
  }

  function onVisibility(): void {
    if (document.visibilityState !== 'visible') reset()
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('wheel', onPointer, { capture: true, passive: true })
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    destroy() {
      reset()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('wheel', onPointer, { capture: true })
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
