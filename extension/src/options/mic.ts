// Microphone & Audio Testing in Settings.
// Provides live volume VU meter, speech recognition preview, voice recording playback (echo test),
// and speaker output chime test.

import { byId, openBrowserPage, setStatus } from './dom'

type MicState = PermissionState | 'unknown'

const LABELS: Record<MicState, string> = {
  granted: 'Allowed',
  denied: 'Blocked',
  prompt: 'Not allowed yet',
  unknown: 'Unknown',
}

const statusEl = byId('mic-status', HTMLElement)
const allowBtn = byId('mic-allow', HTMLButtonElement)
const speakerTestBtn = byId('speaker-test', HTMLButtonElement)
const helpEl = byId('mic-help', HTMLDivElement)
const settingsButton = byId('mic-settings', HTMLButtonElement)
const resultEl = byId('mic-result', HTMLParagraphElement)

const meterBox = byId('mic-meter-box', HTMLDivElement)
const meterState = byId('mic-meter-state', HTMLSpanElement)
const meterVal = byId('mic-meter-val', HTMLSpanElement)
const meterFill = byId('mic-meter-fill', HTMLDivElement)

const sttPreview = byId('mic-stt-preview', HTMLDivElement)
const sttText = byId('mic-stt-text', HTMLParagraphElement)

const playbackRow = byId('mic-playback-row', HTMLDivElement)
const audioPlayer = byId('mic-audio-player', HTMLAudioElement)

// Test session state
let isTesting = false
let currentStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let animFrameId = 0
let mediaRecorder: MediaRecorder | null = null
let recordedChunks: BlobPart[] = []
let speechRecognizer: any = null
let recordedBlobUrl: string | null = null
let autoStopTimer: any = null
let smoothedLevel = 0
let hasDetectedAudio = false
let hasTranscribedSpeech = false

export function initMic(): void {
  allowBtn.addEventListener('click', () => {
    if (isTesting) {
      stopTest(true)
    } else {
      void startTest()
    }
  })

  speakerTestBtn.addEventListener('click', () => {
    void playSpeakerTest()
  })

  settingsButton.addEventListener('click', () =>
    openBrowserPage(`chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`),
  )

  window.addEventListener('beforeunload', () => {
    stopTest(false)
  })

  void watchPermission()
}

function showPermissionState(state: MicState): void {
  statusEl.textContent = LABELS[state]
  helpEl.hidden = state !== 'denied'
  if (!isTesting) {
    allowBtn.textContent = state === 'granted' ? 'Start microphone test' : 'Allow microphone'
  }
}

async function watchPermission(): Promise<void> {
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    showPermissionState(perm.state)
    perm.addEventListener('change', () => showPermissionState(perm.state))
  } catch {
    showPermissionState('unknown')
  }
}

async function startTest(): Promise<void> {
  stopTest(false)
  setStatus(resultEl, "Opening microphone…", 'busy')

  if (recordedBlobUrl) {
    URL.revokeObjectURL(recordedBlobUrl)
    recordedBlobUrl = null
  }
  audioPlayer.removeAttribute('src')
  playbackRow.hidden = true
  sttPreview.hidden = true
  sttText.textContent = 'Listening…'
  meterFill.style.width = '0%'
  meterVal.textContent = '0%'
  smoothedLevel = 0
  hasDetectedAudio = false
  hasTranscribedSpeech = false

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    currentStream = stream
    showPermissionState('granted')
    isTesting = true

    allowBtn.textContent = 'Stop test'
    allowBtn.classList.remove('button-primary')
    meterBox.hidden = false
    setStatus(resultEl, 'Microphone is active. Speak into it to test volume and speech recognition.', 'ok')

    // 1. Audio Meter Analyser
    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext
      audioCtx = new AudioCtxClass()
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume()
      }
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)

      const bufferLength = analyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)

      const updateMeter = () => {
        if (!isTesting) return
        analyser.getByteFrequencyData(dataArray)

        let sum = 0
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i] ?? 0
        }
        const avg = sum / bufferLength
        // Normalize 0..128 to 0..100 with sensitivity curve
        const rawPct = Math.min(100, (avg / 70) * 100)
        smoothedLevel = smoothedLevel * 0.65 + rawPct * 0.35

        const clamped = Math.min(100, Math.max(0, Math.round(smoothedLevel)))
        meterFill.style.width = `${clamped}%`
        meterVal.textContent = `${clamped}%`

        if (clamped > 3) {
          hasDetectedAudio = true
          meterState.textContent = 'Hearing your voice! (Signal healthy)'
        } else {
          meterState.textContent = 'Listening… Speak into your microphone'
        }

        animFrameId = requestAnimationFrame(updateMeter)
      }
      animFrameId = requestAnimationFrame(updateMeter)
    } catch (err) {
      console.warn('[mic-test] AudioContext meter error:', err)
    }

    // 2. MediaRecorder for voice echo playback
    recordedChunks = []
    try {
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      const supportedMime = mimeTypes.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
      mediaRecorder = supportedMime ? new MediaRecorder(stream, { mimeType: supportedMime }) : new MediaRecorder(stream)

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data)
        }
      }
      mediaRecorder.start(200)
    } catch (err) {
      console.warn('[mic-test] MediaRecorder error:', err)
    }

    // 3. Live Speech Recognition (STT Preview)
    try {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (SpeechRecognition) {
        const recognizer = new SpeechRecognition()
        recognizer.continuous = true
        recognizer.interimResults = true
        recognizer.lang = navigator.language || 'en-US'

        recognizer.onresult = (ev: any) => {
          let transcript = ''
          for (let i = 0; i < ev.results.length; i++) {
            transcript += (ev.results[i][0]?.transcript || '') + ' '
          }
          const text = transcript.trim()
          if (text) {
            hasTranscribedSpeech = true
            sttPreview.hidden = false
            sttText.textContent = `"${text}"`
          }
        }
        recognizer.onerror = (e: any) => {
          console.warn('[mic-test] SpeechRecognition event error:', e?.error)
        }
        recognizer.start()
        speechRecognizer = recognizer
      }
    } catch (err) {
      console.warn('[mic-test] SpeechRecognition init error:', err)
    }

    // Auto-stop after 25 seconds if left running
    clearTimeout(autoStopTimer)
    autoStopTimer = setTimeout(() => {
      if (isTesting) stopTest(true)
    }, 25000)
  } catch (e) {
    stopTest(false)
    const name = e instanceof DOMException ? e.name : ''
    const message = e instanceof Error ? e.message : ''
    if ((name === 'NotAllowedError' || name === 'SecurityError') && /system/i.test(message)) {
      setStatus(
        resultEl,
        'Your operating system is blocking Chrome from using the microphone. Allow Chrome in your system privacy settings, then try again.',
        'error',
      )
    } else if (name === 'NotAllowedError' || name === 'SecurityError') {
      showPermissionState('denied')
      setStatus(resultEl, 'Chrome blocked the microphone for this extension. Click "Open microphone settings" above.', 'error')
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      setStatus(resultEl, 'No microphone found. Please connect a microphone and try again.', 'error')
    } else if (name === 'NotReadableError') {
      setStatus(resultEl, 'The microphone is in use by another application or blocked by your system.', 'error')
    } else {
      setStatus(resultEl, message || "Couldn't open the microphone.", 'error')
    }
  }
}

function stopTest(showPlayback: boolean): void {
  clearTimeout(autoStopTimer)
  autoStopTimer = null

  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = 0
  }

  if (speechRecognizer) {
    try {
      speechRecognizer.stop()
    } catch {}
    speechRecognizer = null
  }

  // Stop MediaRecorder and build playback
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') {
        const type = mediaRecorder.mimeType || 'audio/webm'
        mediaRecorder.onstop = () => {
          if (showPlayback && recordedChunks.length > 0) {
            const blob = new Blob(recordedChunks, { type })
            recordedBlobUrl = URL.createObjectURL(blob)
            audioPlayer.src = recordedBlobUrl
            playbackRow.hidden = false
          }
        }
        mediaRecorder.stop()
      } else if (showPlayback && recordedChunks.length > 0) {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' })
        recordedBlobUrl = URL.createObjectURL(blob)
        audioPlayer.src = recordedBlobUrl
        playbackRow.hidden = false
      }
    } catch {}
    mediaRecorder = null
  }

  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      track.stop()
    }
    currentStream = null
  }

  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }

  meterFill.style.width = '0%'
  meterVal.textContent = '0%'

  if (isTesting) {
    isTesting = false
    allowBtn.textContent = 'Start microphone test'
    allowBtn.classList.add('button-primary')

    if (hasDetectedAudio || hasTranscribedSpeech) {
      setStatus(
        resultEl,
        'Microphone test complete! Voice signal detected cleanly. Play back your recording below to verify.',
        'ok',
      )
    } else {
      setStatus(
        resultEl,
        'Test ended. No sound was detected. Make sure your microphone is not muted and the input volume is turned up.',
        'warn',
      )
    }
  } else {
    allowBtn.textContent = 'Start microphone test'
  }
}

// Speaker / Audio Output Test (plays a pleasant harmonic chime)
async function playSpeakerTest(): Promise<void> {
  setStatus(resultEl, 'Playing speaker test chime…', 'busy')
  try {
    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext
    const ctx = new AudioCtxClass()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    const now = ctx.currentTime
    // Chime notes: C5 (523.25 Hz), E5 (659.25 Hz), G5 (783.99 Hz), C6 (1046.5 Hz)
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + index * 0.16)

      gain.gain.setValueAtTime(0, now + index * 0.16)
      gain.gain.linearRampToValueAtTime(0.2, now + index * 0.16 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.5)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now + index * 0.16)
      osc.stop(now + index * 0.16 + 0.55)
    })

    setTimeout(() => {
      ctx.close().catch(() => {})
      // Optional speech confirmation
      if ('speechSynthesis' in window) {
        const utt = new SpeechSynthesisUtterance('Audio output is working.')
        utt.rate = 1.0
        window.speechSynthesis.speak(utt)
      }
      setStatus(resultEl, 'Speaker output test finished! Did you hear the chime and speech?', 'ok')
    }, 1100)
  } catch (err: any) {
    setStatus(resultEl, `Speaker test error: ${err?.message || 'Could not play audio'}`, 'error')
  }
}
