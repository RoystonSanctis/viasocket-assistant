// Speech-to-text through the browser's built-in Web Speech API, used when settings.sttEngine === 'browser'.
// It runs in the content script because the recognizer needs a page with a microphone permission prompt; the
// local Whisper engine instead runs in the offscreen document and is driven by the service worker.
// Note: Chrome's recognizer streams audio to the browser vendor's speech service; the options page says so.

import type { VoiceState } from '../shared/messages'

// lib.dom ships the event types but not the recognizer itself.
export interface Recognizer {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onstart: ((ev: Event) => void) | null
  onresult: ((ev: SpeechRecognitionEvent) => void) | null
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null
  onend: ((ev: Event) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognizerCtor = new () => Recognizer

export interface BrowserSttOptions {
  /** BCP-47 tag; empty = navigator.language */
  language(): string
  onState(state: VoiceState, detail?: string): void
  onTranscript(text: string, final: boolean): void
  /** Final utterance, ready to send to the agent */
  onFinal(text: string): void
}

export interface BrowserStt {
  start(): void
  /** Stop listening and deliver what was heard */
  stop(): void
  /** Stop listening and drop what was heard */
  cancel(): void
  isListening(): boolean
}

export function recognizerCtor(): RecognizerCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function browserSttSupported(): boolean {
  return recognizerCtor() !== null
}

/** A hand-over (wake word to dictation) or a restart closes the mic only if it stays unused this long */
const MIC_RELEASE_MS = 2000
let micHolders = 0
let micStream: Promise<MediaStream | null> | null = null
let micReleaseTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Explicitly triggers Chrome's native microphone permission prompt in the browser.
 * Returns true if granted, false if dismissed or denied.
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Permission granted! Cache this stream so holdMic() reuses it
    micStream = Promise.resolve(stream)
    return true
  } catch {
    return false
  }
}

/**
 * Keeps one microphone stream open while any recognizer is in use. Chrome ends recognition on every pause and
 * each restart re-opened the mic, which blinked the address-bar mic icon and flickered the whole window.
 * Returns the release function; failing to open the stream only loses the smoothing, never the recognition.
 */
export function holdMic(): () => void {
  micHolders++
  clearTimeout(micReleaseTimer)
  micStream ??= navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => null) ?? Promise.resolve(null)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--micHolders > 0) return
    clearTimeout(micReleaseTimer)
    micReleaseTimer = setTimeout(() => {
      if (micHolders > 0 || !micStream) return
      const pending = micStream
      micStream = null
      void pending.then((s) => s?.getTracks().forEach((t) => t.stop()))
    }, MIC_RELEASE_MS)
  }
}

const ERROR_STATES: Record<string, { state: VoiceState; detail?: string }> = {
  'not-allowed': { state: 'needs-permission' },
  'service-not-allowed': { state: 'needs-permission', detail: 'Speech recognition is blocked in this browser.' },
  'audio-capture': { state: 'error', detail: 'No microphone was found.' },
  network: { state: 'error', detail: "The browser's speech service could not be reached." },
  'language-not-supported': { state: 'error', detail: 'That speech language is not supported by the browser.' },
}
/** Chrome ends recognition after a pause even in continuous mode; while the key is held it is restarted this often at most */
const MAX_RESTARTS = 20
/** Upper bound on one hold, in case the key-up never arrives (same limit as the Whisper recorder) */
const MAX_HOLD_MS = 60_000

/** One press of the talk key, which may span several recognizers */
interface Hold {
  /** Final text from recognizers of this hold that already ended */
  heard: string
  stopRequested: boolean
  cancelled: boolean
  /** An error ended the hold; nothing is delivered */
  failed: boolean
  noSpeech: boolean
  restarts: number
  timer: ReturnType<typeof setTimeout> | undefined
  releaseMic: () => void
}

function join(a: string, b: string): string {
  const x = a.trim()
  const y = b.trim()
  return x && y ? `${x} ${y}` : x || y
}

export function createBrowserStt(opts: BrowserSttOptions): BrowserStt {
  let rec: Recognizer | null = null
  let hold: Hold | null = null
  /** A new hold began while the previous recognizer was still shutting down */
  let startAfterEnd = false

  function start(): void {
    if (hold && !hold.stopRequested && !hold.cancelled) return
    if (rec) {
      startAfterEnd = true
      return
    }
    const Ctor = recognizerCtor()
    if (!Ctor) {
      opts.onState('error', 'This browser has no built-in speech recognition. Choose the local Whisper engine in settings.')
      return
    }

    void (async () => {
      // Check permission state: if not granted yet, trigger the Chrome permission prompt
      if (navigator.permissions?.query) {
        try {
          const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null)
          if (perm?.state === 'prompt') {
            const granted = await requestMicrophonePermission()
            if (!granted) {
              opts.onState('needs-permission', 'Microphone access is required for voice input.')
              return
            }
          }
        } catch {
          // ignore query failure, continue
        }
      }

      if (hold && !hold.stopRequested && !hold.cancelled) return
      const h: Hold = {
        heard: '',
        stopRequested: false,
        cancelled: false,
        failed: false,
        noSpeech: false,
        restarts: 0,
        timer: undefined,
        releaseMic: holdMic(),
      }
      hold = h
      h.timer = setTimeout(() => {
        if (hold === h) stop()
      }, MAX_HOLD_MS)
      listen(Ctor, h)
    })()
  }

  function listen(Ctor: RecognizerCtor, h: Hold): void {
    const r = new Ctor()
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    r.lang = opts.language() || navigator.language || 'en-US'
    let finalText = ''

    r.onstart = () => {
      if (!h.cancelled && !h.failed) opts.onState('listening')
    }
    r.onresult = (ev) => {
      // ev.results holds every result of this recognizer so far; final ones never change again.
      let done = ''
      let interim = ''
      for (let i = 0; i < ev.results.length; i++) {
        const result = ev.results[i]
        const text = result?.[0]?.transcript ?? ''
        if (result?.isFinal) done += text
        else interim += text
      }
      finalText = done
      const shown = join(h.heard, done + interim)
      if (shown && !h.cancelled) opts.onTranscript(shown, false)
    }
    r.onerror = (ev) => {
      // A pause is not the end of what the user is saying while the key is held; 'aborted' follows our own cancel.
      if (ev.error === 'no-speech') {
        h.noSpeech = true
        return
      }
      if (ev.error === 'aborted' || h.failed) return
      const mapped = ERROR_STATES[ev.error] ?? { state: 'error' as const, detail: `Speech recognition failed (${ev.error}).` }
      h.failed = true
      opts.onState(mapped.state, mapped.detail)
    }
    r.onend = () => {
      if (rec === r) rec = null
      h.heard = join(h.heard, finalText)
      if (!h.stopRequested && !h.cancelled && !h.failed) {
        if (h.restarts < MAX_RESTARTS) {
          h.restarts++
          listen(Ctor, h)
          return
        }
        h.failed = true
        opts.onState('error', 'Speech recognition kept stopping. Try again.')
      }
      finish(h)
    }

    rec = r
    try {
      r.start()
    } catch {
      rec = null
      if (!h.failed) {
        h.failed = true
        opts.onState('error', 'Speech recognition could not start. Try again.')
      }
      finish(h)
    }
  }

  function finish(h: Hold): void {
    clearTimeout(h.timer)
    h.releaseMic()
    if (hold === h) hold = null
    const text = h.heard.trim()
    const deliver = !h.cancelled && !h.failed && text !== ''
    if (deliver) {
      opts.onTranscript(text, true)
      opts.onFinal(text)
    }
    if (startAfterEnd) {
      startAfterEnd = false
      // The next hold is already under way; reporting 'ready' in between would end it. After an error the caller
      // already treats that hold as over, so it must not start listening behind its back.
      if (!h.failed) {
        start()
        return
      }
    }
    if (!h.failed) opts.onState('ready', !deliver && !h.cancelled && h.noSpeech ? "I didn't hear anything." : undefined)
  }

  function stop(): void {
    if (startAfterEnd) {
      // Released before the queued hold could start.
      startAfterEnd = false
      return
    }
    const h = hold
    if (!h || h.stopRequested) return
    h.stopRequested = true
    if (!rec) return finish(h)
    try {
      rec.stop()
    } catch {
      // already stopping
    }
  }

  return {
    start,
    stop,
    cancel() {
      if (startAfterEnd) {
        // Only the queued hold is cancelled; the one still ending was released normally and is delivered.
        startAfterEnd = false
        return
      }
      const h = hold
      if (!h) return
      h.cancelled = true
      if (!rec) return finish(h)
      try {
        rec.abort()
      } catch {
        // already stopped
      }
    },
    isListening: () => hold !== null && !hold.stopRequested && !hold.cancelled,
  }
}
