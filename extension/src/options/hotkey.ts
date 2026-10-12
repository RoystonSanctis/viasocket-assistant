// Push-to-talk key recorder. Modifier-only combinations are allowed (hold Control+Option to talk), so a
// combination is also captured when a modifier is released before any other key was pressed.

import { DEFAULT_SETTINGS } from '../shared/settings'
import type { HotkeySetting } from '../shared/settings'
import { byId, errorMessage, h, isMac, isWindows, setStatus } from './dom'
import { store, subscribe, updateSettings } from './store'

type ModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta'
type Mods = Pick<HotkeySetting, ModifierKey>

const ORDER: ModifierKey[] = ['ctrl', 'alt', 'shift', 'meta']
const MAC_NAMES: Record<ModifierKey, string> = { ctrl: 'Control', alt: 'Option', shift: 'Shift', meta: 'Command' }
const PC_NAMES: Record<ModifierKey, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
])
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS'])
const KEY_NAMES: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}
const CANCELLED = 'Cancelled. Your keys were not changed.'
const PRINTABLE_CODE =
  /^(?:Key[A-Z]|Digit\d|Numpad(?:\d|Decimal|Divide|Multiply|Subtract|Add)|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|IntlRo|IntlYen|Semicolon|Quote|Comma|Period|Slash)$/

const display = byId('hotkey-display', HTMLSpanElement)
const changeButton = byId('hotkey-change', HTMLButtonElement)
const resetButton = byId('hotkey-reset', HTMLButtonElement)
const hint = byId('hotkey-hint', HTMLParagraphElement)
const warning = byId('hotkey-warning', HTMLParagraphElement)

let recording = false
let peak: Mods = noMods()

export function initHotkey(): void {
  subscribe(render)
  changeButton.addEventListener('click', () => (recording ? stopRecording(CANCELLED) : startRecording()))
  resetButton.addEventListener('click', () => {
    if (recording) stopRecording('')
    void save({ ...DEFAULT_SETTINGS.hotkey })
  })
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', () => {
    if (recording) stopRecording(CANCELLED)
  })
}

function noMods(): Mods {
  return { ctrl: false, alt: false, shift: false, meta: false }
}

function modsOf(e: KeyboardEvent): Mods {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
}

function isModifier(e: KeyboardEvent): boolean {
  return MODIFIER_CODES.has(e.code) || MODIFIER_KEYS.has(e.key)
}

function countMods(m: Mods): number {
  return ORDER.filter((k) => m[k]).length
}

/** Shift (and Option on a Mac) still type characters, so with only those the key would fire while typing */
function typesCharacter(hk: Mods & { code: string }): boolean {
  return PRINTABLE_CODE.test(hk.code) && !hk.ctrl && !hk.meta && (!hk.alt || isMac())
}

/** Modifiers that never change what a key types, for hints */
function safeModifiers(): string {
  const n = isMac() ? MAC_NAMES : PC_NAMES
  return isMac() ? `${n.ctrl} or ${n.meta}` : `${n.ctrl} or ${n.alt}`
}

function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (code.startsWith('Numpad')) return `Numpad ${code.slice(6)}`
  return KEY_NAMES[code] ?? code
}

export function hotkeyParts(hk: Mods & { code?: string }): string[] {
  const names = isMac() ? MAC_NAMES : PC_NAMES
  const parts = ORDER.filter((k) => hk[k]).map((k) => names[k])
  if (hk.code) parts.push(keyLabel(hk.code))
  return parts
}

function renderKeys(parts: string[], pending = false): void {
  const nodes: Node[] = []
  parts.forEach((p, i) => {
    if (i > 0) nodes.push(document.createTextNode('+'))
    nodes.push(h('kbd', {}, p))
  })
  if (pending) nodes.push(document.createTextNode(parts.length ? '+ …' : '…'))
  if (!nodes.length) nodes.push(document.createTextNode('not set'))
  display.replaceChildren(...nodes)
}

function warningFor(hk: HotkeySetting): string | null {
  if (typesCharacter(hk) && countMods(hk) > 0) {
    return `This combination also types a character, so it is ignored while you type in a text field. Add ${safeModifiers()} to use it everywhere.`
  }
  if (!(hk.ctrl && hk.alt)) return null
  if (isMac()) return 'Control+Option is the VoiceOver key on macOS. If you use VoiceOver, pick a different combination.'
  if (isWindows()) {
    return 'On many keyboard layouts Ctrl+Alt works as AltGr, which types characters like @, € or ł, so typing those may start the assistant.'
  }
  return null
}

function render(): void {
  if (recording) return
  const hk = store.settings.hotkey
  renderKeys(hotkeyParts(hk))
  const warn = warningFor(hk)
  warning.textContent = warn ?? ''
  warning.hidden = !warn
}

function startRecording(): void {
  recording = true
  peak = noMods()
  changeButton.textContent = 'Cancel'
  display.classList.add('recording')
  renderKeys([], true)
  setStatus(hint, 'Press the keys you want, then let go. Press Esc to cancel.', 'info')
}

function stopRecording(message: string): void {
  recording = false
  changeButton.textContent = 'Change'
  display.classList.remove('recording')
  setStatus(hint, message, 'info')
  render()
}

function onKeyDown(e: KeyboardEvent): void {
  if (!recording) return
  const mods = modsOf(e)
  // Tab keeps working for keyboard users: it leaves the recorder instead of becoming the hotkey.
  if (e.code === 'Tab' && countMods(mods) === 0) {
    stopRecording(CANCELLED)
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (e.repeat) return
  if (e.code === 'Escape') {
    stopRecording(CANCELLED)
    return
  }
  if (isModifier(e)) {
    for (const k of ORDER) peak[k] = peak[k] || mods[k]
    renderKeys(hotkeyParts(peak), true)
    return
  }
  // Some IMEs and virtual keyboards report no physical key; there is nothing stable to bind to.
  if (!e.code || e.code === 'Unidentified') return
  if (countMods(mods) === 0 && !/^F\d{1,2}$/.test(e.code)) {
    setStatus(hint, `Add ${safeModifiers()} (or use an F key) so normal typing never starts the assistant.`, 'warn')
    return
  }
  if (typesCharacter({ ...mods, code: e.code })) {
    const n = isMac() ? MAC_NAMES : PC_NAMES
    const typing = isMac() ? `${n.shift} and ${n.alt} change what you type` : `${n.shift} changes what you type`
    setStatus(hint, `${typing}, so that combination can't work while you type in a text field. Add ${safeModifiers()}.`, 'warn')
    return
  }
  finish({ ...mods, code: e.code })
}

function onKeyUp(e: KeyboardEvent): void {
  if (!recording || !isModifier(e)) return
  e.preventDefault()
  e.stopPropagation()
  const n = countMods(peak)
  if (n >= 2) {
    finish({ ...peak, code: '' })
  } else if (n === 1 && countMods(modsOf(e)) === 0) {
    peak = noMods()
    renderKeys([], true)
    setStatus(hint, 'A single modifier goes off too easily while typing. Hold two together, or add a letter.', 'warn')
  }
}

function finish(hk: HotkeySetting): void {
  recording = false
  changeButton.textContent = 'Change'
  display.classList.remove('recording')
  void save(hk)
}

async function save(hk: HotkeySetting): Promise<void> {
  try {
    await updateSettings({ hotkey: hk })
    setStatus(hint, `Saved. Hold ${hotkeyParts(hk).join('+')} to talk.`, 'ok')
  } catch (e) {
    setStatus(hint, errorMessage(e), 'error')
  }
  render()
}
