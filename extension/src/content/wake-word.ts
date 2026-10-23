// Continuous "Hey SOCKET" wake-word listener using Web Speech API (webkitSpeechRecognition).
// Runs only when settings.voiceEnabled and settings.wakeWordEnabled are true.

import { recognizerCtor, type Recognizer } from './browser-stt'

export interface WakeWordOptions {
  enabled(): boolean
  onWake(trailingText: string): void
}

export interface WakeWordListener {
  start(): void
  stop(): void
  pause(): void
  resume(): void
  destroy(): void
}

// Matches "Hey Socket", "OK Socket", "Okay Socket", "Hello Socket", "Hi Socket", "Hey viaSocket", etc.
const WAKE_WORD_RE = /\b(?:hey|ok|okay|hello|hi)\s+(?:via\s*)?sockets?\b/i

export function createWakeWordListener(opts: WakeWordOptions): WakeWordListener {
  let rec: Recognizer | null = null
  let running = false
  let paused = false
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  function clearTimer(): void {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
  }

  function start(): void {
    if (destroyed || !opts.enabled()) return
    running = true
    paused = false
    clearTimer()
    if (rec) return

    const Ctor = recognizerCtor()
    if (!Ctor) return

    try {
      const r = new Ctor()
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1
      r.lang = 'en-US'

      r.onresult = (ev) => {
        if (!running || paused) return
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i]
          const transcript = res?.[0]?.transcript ?? ''
          const match = WAKE_WORD_RE.exec(transcript)
          if (match) {
            const trailing = transcript.slice(match.index + match[0].length).replace(/^[,.\s]+/, '').trim()
            pause()
            opts.onWake(trailing)
            return
          }
        }
      }

      r.onerror = (ev) => {
        if (ev.error === 'not-allowed') {
          console.warn('[SOCKET Wake Word] Microphone permission required for wake word detection.')
          running = false
          return
        }
        // Other errors (no-speech, network, aborted) are transient; onend will restart if still running.
      }

      r.onend = () => {
        rec = null
        if (running && !paused && !destroyed && opts.enabled()) {
          clearTimer()
          restartTimer = setTimeout(start, 500)
        }
      }

      rec = r
      r.start()
    } catch {
      rec = null
    }
  }

  function stop(): void {
    running = false
    paused = false
    clearTimer()
    if (rec) {
      const r = rec
      rec = null
      try {
        r.abort()
      } catch {}
    }
  }

  function pause(): void {
    paused = true
    clearTimer()
    if (rec) {
      const r = rec
      rec = null
      try {
        r.abort()
      } catch {}
    }
  }

  function resume(): void {
    if (!running || destroyed || !opts.enabled()) return
    paused = false
    clearTimer()
    start()
  }

  function destroy(): void {
    destroyed = true
    stop()
  }

  return { start, stop, pause, resume, destroy }
}
