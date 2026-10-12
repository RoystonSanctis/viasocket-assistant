// Offscreen document: microphone capture and on-device speech-to-text.
// The service worker has no DOM or media APIs, so it sends ToOffscreen commands here and relays what comes back
// (FromOffscreen) to the content script. Audio never leaves this document.

import type { FromOffscreen, ToOffscreen, VoiceState } from '../shared/messages'
import { isNetworkError, isReady, lastProgress, loadAsr, setProgressHandler, transcribe } from './asr'
import type { DevicePreference } from './asr'
import { decodeToMono16k, peakRms, SILENCE_RMS, TARGET_RATE } from './audio'
import { startRecording } from './recorder'
import type { Recording } from './recorder'

const MAX_RECORDING_MS = 60_000
/** Shorter clips are almost always an accidental tap of the hotkey */
const MIN_SAMPLES = Math.round(TARGET_RATE * 0.3)
const MODEL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

interface Session {
  recording: Recording
  model: string
  language?: string
  device: DevicePreference
  hardStop: ReturnType<typeof setTimeout>
}

let session: Session | null = null
/** A start still waiting on getUserMedia; a stop that arrives meanwhile is remembered here instead of being lost. */
let pending: { stop: boolean; epoch: number } | null = null
/** Bumped by stt-cancel only, so work that finishes after a cancel is dropped (a new start must not drop it). */
let epoch = 0
/** Callers (warmup, a finished recording) currently waiting on a model load, so its progress is worth showing */
let loadWatchers = 0
const LOADING_DETAIL = 'Preparing the speech model'

function send(msg: FromOffscreen): void {
  // Rejects when the service worker is restarting; there is nobody to tell, so the message is dropped.
  chrome.runtime.sendMessage(msg).catch(() => undefined)
}

function state(s: VoiceState, extra: { detail?: string; progress?: number } = {}): void {
  send({ target: 'background', type: 'stt-state', state: s, ...extra })
}

/** Status of background work (loading, transcribing) must not overwrite 'listening' while a new recording runs. */
function idleState(s: VoiceState, extra: { detail?: string; progress?: number } = {}): void {
  if (!session) state(s, extra)
}

function fail(e: unknown): void {
  send({ target: 'background', type: 'stt-error', message: friendlyError(e) })
}

setProgressHandler((_model, percent) => {
  if (loadWatchers > 0 && !session) state('loading-model', { detail: LOADING_DETAIL, progress: percent })
})

async function watchLoad<T>(load: Promise<T>): Promise<T> {
  loadWatchers++
  try {
    return await load
  } finally {
    loadWatchers--
  }
}

async function start(msg: Extract<ToOffscreen, { type: 'stt-start' }>): Promise<void> {
  if (session) {
    state('listening')
    return
  }
  if (!MODEL_ID.test(msg.model)) {
    fail(new Error('No speech model is selected. Pick one in the extension settings.'))
    return
  }
  if (pending && pending.epoch === epoch) {
    // Pressed again before the microphone opened: the user wants to talk after all.
    pending.stop = false
    return
  }
  const startedEpoch = epoch
  const p = { stop: false, epoch: startedEpoch }
  pending = p
  let recording: Recording
  try {
    recording = await startRecording((level) => send({ target: 'background', type: 'stt-level', level }))
  } catch (e) {
    if (startedEpoch !== epoch) return
    if (isPermissionError(e)) state('needs-permission', { detail: 'Allow microphone access in the extension settings.' })
    else fail(e)
    return
  } finally {
    if (pending === p) pending = null
  }
  // Cancelled while getUserMedia was pending, or a second start raced this one.
  if (startedEpoch !== epoch || session) {
    recording.cancel()
    return
  }
  session = {
    recording,
    model: msg.model,
    language: msg.language,
    device: msg.device ?? 'auto',
    hardStop: setTimeout(() => void stop(), MAX_RECORDING_MS),
  }
  state('listening')
  if (p.stop) {
    // A quick tap: the clip is below MIN_SAMPLES, so stop() reports an empty result instead of recording for a minute.
    void stop()
    return
  }
  // Load the model while the user talks so transcription can begin the moment they stop. Errors surface at stop.
  loadAsr(msg.model, session.device).catch(() => undefined)
}

async function stop(): Promise<void> {
  const s = session
  if (!s) return
  session = null
  clearTimeout(s.hardStop)
  const startedEpoch = epoch
  const live = () => startedEpoch === epoch
  state('transcribing')
  try {
    const blob = await s.recording.stop()
    const audio = blob.size > 0 ? await decodeToMono16k(blob) : new Float32Array(0)
    if (!live()) return
    if (audio.length < MIN_SAMPLES || peakRms(audio) < SILENCE_RMS) {
      finish('')
      return
    }
    if (!isReady(s.model)) idleState('loading-model', { detail: LOADING_DETAIL, progress: lastProgress(s.model) })
    const loaded = await watchLoad(loadAsr(s.model, s.device))
    if (!live()) return
    idleState('transcribing')
    const text = await transcribe(loaded, audio, s.language)
    if (live()) finish(text)
  } catch (e) {
    if (live()) fail(e)
  }
}

function finish(text: string): void {
  // An empty result tells the service worker the turn is over and nothing was heard.
  send({ target: 'background', type: 'stt-result', text })
  idleState('ready')
}

function cancel(): void {
  epoch++
  const s = session
  session = null
  if (s) {
    clearTimeout(s.hardStop)
    s.recording.cancel()
  }
  state('ready')
}

async function warmup(msg: Extract<ToOffscreen, { type: 'stt-warmup' }>): Promise<void> {
  if (!MODEL_ID.test(msg.model)) {
    fail(new Error('No speech model is selected. Pick one in the extension settings.'))
    return
  }
  if (isReady(msg.model)) {
    idleState('ready')
    return
  }
  idleState('loading-model', { detail: LOADING_DETAIL, progress: lastProgress(msg.model) })
  try {
    await watchLoad(loadAsr(msg.model, msg.device ?? 'auto'))
    idleState('ready')
  } catch (e) {
    fail(e)
  }
}

function isPermissionError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
}

function friendlyError(e: unknown): string {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found. Connect one and try again.'
      case 'NotReadableError':
      case 'AbortError':
        return 'The microphone is busy or blocked by your system. Close other apps using it and try again.'
      case 'EncodingError':
        return "Couldn't read the recording. Please try again."
    }
  }
  if (isNetworkError(e)) return "Couldn't download the speech model. Check your internet connection and try again."
  const msg = e instanceof Error ? e.message : String(e)
  if (/out of memory|oom|allocation failed|bad_alloc/i.test(msg)) {
    return 'Not enough memory for this speech model. Pick a smaller one in the extension settings.'
  }
  if (msg.startsWith('No speech model')) return msg
  const short = msg.length > 140 ? `${msg.slice(0, 137)}...` : msg
  return `Voice input failed: ${short || 'unknown error'}`
}

const DEVICES = new Set(['webgpu', 'wasm', 'auto'])

function isToOffscreen(m: unknown): m is ToOffscreen {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  if (r.target !== 'offscreen') return false
  if (r.device !== undefined && !(typeof r.device === 'string' && DEVICES.has(r.device))) return false
  switch (r.type) {
    case 'stt-start':
      return typeof r.model === 'string' && (r.language === undefined || typeof r.language === 'string')
    case 'stt-warmup':
      return typeof r.model === 'string'
    case 'stt-stop':
    case 'stt-cancel':
      return true
    default:
      return false
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only extension pages and the service worker may drive the microphone; content scripts can message here too.
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return
  if (!isToOffscreen(msg)) return
  // Ack at once so the sender's promise settles (it retries on rejection); results follow as separate messages.
  sendResponse(true)
  switch (msg.type) {
    case 'stt-start':
      void start(msg)
      break
    case 'stt-stop':
      if (!session && pending && pending.epoch === epoch) pending.stop = true
      else void stop()
      break
    case 'stt-cancel':
      cancel()
      break
    case 'stt-warmup':
      void warmup(msg)
      break
  }
})
