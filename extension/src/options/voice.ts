// Voice section: speech engine, on-device model and language, model download, spoken replies,
// and a pointer to Chrome's own keyboard shortcut.

import { SUPPORTED_APP_HOSTS } from '../background/tools/env'
import type { FromOffscreen } from '../shared/messages'
import type { AudioOutputMode, ChatToggleShortcut } from '../shared/settings'
import { byId, checkedValue, errorMessage, h, openBrowserPage, radios, setChecked, setStatus } from './dom'
import { rpc } from './rpc'
import { store, subscribe, updateSettings } from './store'

const whisperOptions = byId('whisper-options', HTMLDivElement)
const voiceEnabled = byId('voice-enabled', HTMLInputElement)
const voiceSettingsBody = byId('voice-settings-body', HTMLDivElement)
const wakeWordEnabled = byId('wake-word-enabled', HTMLInputElement)
const wakeWordSilenceDelay = byId('wake-word-silence-delay', HTMLSelectElement)
const wakeWordDelayRow = byId('wake-word-delay-row', HTMLDivElement)
const hotkeyEnabled = byId('hotkey-enabled', HTMLInputElement)
const hotkeyDetailsGroup = byId('hotkey-details-group', HTMLDivElement)
const chatToggleShortcut = byId('chat-toggle-shortcut', HTMLSelectElement)
const sttModel = byId('stt-model', HTMLSelectElement)
const sttModelNote = byId('stt-model-note', HTMLParagraphElement)
const sttLanguage = byId('stt-language', HTMLSelectElement)
const sttLanguageNote = byId('stt-language-note', HTMLParagraphElement)
const downloadRow = byId('stt-download-row', HTMLDivElement)
const download = byId('stt-download', HTMLButtonElement)
const progress = byId('stt-progress', HTMLProgressElement)
const sttStatus = byId('stt-status', HTMLParagraphElement)
const shortcutCurrent = byId('shortcut-current', HTMLElement)
const shortcutOpen = byId('shortcut-open', HTMLButtonElement)
const siteMic = byId('site-mic', HTMLDivElement)
const siteMicButtons = byId('site-mic-buttons', HTMLDivElement)
const extensionMic = byId('mic', HTMLDivElement)

let modelsSignature = ''
let downloading = false

export function initVoice(): void {
  subscribe(render)
  voiceEnabled.addEventListener('change', () => void save({ voiceEnabled: voiceEnabled.checked }))
  wakeWordEnabled.addEventListener('change', () => void save({ wakeWordEnabled: wakeWordEnabled.checked }))
  wakeWordSilenceDelay.addEventListener('change', () => {
    const num = Number(wakeWordSilenceDelay.value)
    const val = Number.isFinite(num) && num > 0 ? num : 3
    void save({ wakeWordSilenceDelay: val })
  })
  hotkeyEnabled.addEventListener('change', () => void save({ hotkeyEnabled: hotkeyEnabled.checked }))
  chatToggleShortcut.addEventListener('change', () => {
    void save({ chatToggleShortcut: chatToggleShortcut.value as ChatToggleShortcut })
  })
  for (const r of radios('stt-engine')) {
    r.addEventListener('change', () => {
      if (r.checked) void save({ sttEngine: checkedValue('stt-engine') === 'browser' ? 'browser' : 'whisper-local' })
    })
  }
  sttModel.addEventListener('change', () => {
    setStatus(sttStatus, '')
    void save({ sttModel: sttModel.value })
  })
  sttLanguage.addEventListener('change', () => void save({ sttLanguage: sttLanguage.value }))
  for (const r of radios('audio-output')) {
    r.addEventListener('change', () => {
      if (r.checked) {
        const mode = (checkedValue('audio-output') ?? 'full') as AudioOutputMode
        void save({ audioOutput: mode, speakReplies: mode !== 'off' })
      }
    })
  }
  download.addEventListener('click', () => void onDownload())
  shortcutOpen.addEventListener('click', () => openBrowserPage('chrome://extensions/shortcuts'))
  for (const host of SUPPORTED_APP_HOSTS) {
    const button = h('button', { type: 'button', class: 'button' }, `Open settings for ${host}`)
    button.addEventListener('click', () =>
      openBrowserPage(`chrome://settings/content/siteDetails?site=${encodeURIComponent(`https://${host}`)}`),
    )
    siteMicButtons.append(button)
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  // The user may come back from Chrome's shortcuts page with a new combination.
  window.addEventListener('focus', () => void showChromeShortcut())
  void showChromeShortcut()
}

async function save(patch: Parameters<typeof updateSettings>[0]): Promise<void> {
  try {
    await updateSettings(patch)
  } catch (e) {
    setStatus(sttStatus, errorMessage(e), 'error')
  }
}

function selectedSttModel() {
  const id = store.settings.sttModel || store.state?.defaultSttModel || ''
  return { id, info: store.state?.sttModels.find((m) => m.id === id) }
}

function render(): void {
  const s = store.settings
  voiceEnabled.checked = s.voiceEnabled
  voiceSettingsBody.hidden = !s.voiceEnabled
  wakeWordEnabled.checked = s.wakeWordEnabled
  wakeWordSilenceDelay.value = String(s.wakeWordSilenceDelay ?? 3)
  wakeWordDelayRow.hidden = !s.wakeWordEnabled
  hotkeyEnabled.checked = s.hotkeyEnabled
  hotkeyDetailsGroup.hidden = !s.hotkeyEnabled
  chatToggleShortcut.value = s.chatToggleShortcut || 'shift-space'

  setChecked('stt-engine', s.sttEngine)
  const local = s.sttEngine === 'whisper-local'
  whisperOptions.hidden = !local
  downloadRow.hidden = !local
  // Keep microphone and audio testing available for all engines.
  extensionMic.hidden = false
  siteMic.hidden = local
  renderModels()
  renderLanguage(local)
  setChecked('audio-output', s.audioOutput ?? (s.speakReplies ? 'minimal' : 'off'))
}

function renderModels(): void {
  const models = store.state?.sttModels ?? []
  const { id, info } = selectedSttModel()
  const signature = JSON.stringify([models, id])
  if (signature !== modelsSignature) {
    modelsSignature = signature
    const opts = models.map((m) => h('option', { value: m.id }, `${m.label} (about ${m.approxSizeMb} MB)`))
    if (id && !info) opts.unshift(h('option', { value: id }, id))
    sttModel.replaceChildren(...opts)
  }
  sttModel.value = id
  const notes = [info?.note, info && !info.multilingual ? 'English only' : undefined, 'Downloads once, then works offline']
  sttModelNote.textContent = notes
    .filter((n): n is string => !!n)
    .map((n) => (/[.!?]$/.test(n) ? n : `${n}.`))
    .join(' ')
}

function renderLanguage(local: boolean): void {
  const value = store.settings.sttLanguage
  const optionsList = sttLanguage.options ? Array.from(sttLanguage.options) : []
  if (!optionsList.some((o) => o.value === value)) sttLanguage.append(h('option', { value }, value))
  sttLanguage.value = value

  const { info } = selectedSttModel()
  const englishOnly = local && info !== undefined && !info.multilingual
  sttLanguage.disabled = englishOnly
  if (!local) {
    sttLanguageNote.textContent = 'Chrome\'s speech service listens for this language. Auto uses your browser\'s language.'
  } else if (englishOnly) {
    sttLanguageNote.textContent = 'This model understands English only. Pick a multilingual model to speak other languages.'
  } else if (!value) {
    sttLanguageNote.textContent = "On-device models can't detect the language yet, so Auto means English. Pick yours if you speak something else."
  } else {
    sttLanguageNote.textContent = value === 'hi' ? 'Hindi also covers Hinglish (Hindi mixed with English).' : ''
  }
}

async function onDownload(): Promise<void> {
  if (downloading) return
  setDownloading(true)
  progress.value = 0
  setStatus(sttStatus, 'Starting the download…', 'busy')
  try {
    await rpc.sttWarmup()
  } catch (e) {
    setDownloading(false)
    setStatus(sttStatus, errorMessage(e), 'error')
  }
}

function setDownloading(value: boolean): void {
  downloading = value
  download.disabled = value
  progress.hidden = !value
}

function isFromOffscreen(m: unknown): m is FromOffscreen {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  return r.target === 'background' && (r.type === 'stt-state' || r.type === 'stt-error')
}

/** The offscreen document broadcasts its progress to every extension page, so the download can be shown here. */
function onRuntimeMessage(msg: unknown): void {
  if (!downloading || !isFromOffscreen(msg)) return
  if (msg.type === 'stt-error') {
    setDownloading(false)
    setStatus(sttStatus, typeof msg.message === 'string' ? msg.message : 'The download failed.', 'error')
    return
  }
  if (msg.type !== 'stt-state') return
  if (msg.state === 'loading-model') {
    const pct = Math.max(0, Math.min(100, Math.round(typeof msg.progress === 'number' ? msg.progress : 0)))
    progress.value = pct
    setStatus(sttStatus, pct >= 100 ? 'Getting the model ready…' : `Downloading the speech model… ${pct}%`, 'busy')
  } else if (msg.state === 'ready') {
    setDownloading(false)
    setStatus(sttStatus, 'The speech model is downloaded and ready. It stays on this computer.', 'ok')
  } else if (msg.state === 'error') {
    setDownloading(false)
    setStatus(sttStatus, 'The download failed. Please try again.', 'error')
  }
}

async function showChromeShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll()
    const cmd = commands.find((c) => c.name === 'toggle-voice')
    shortcutCurrent.textContent = cmd?.shortcut || 'not set'
  } catch {
    // Keep the default text from the page.
  }
}
