// Microphone capture: MediaRecorder for the audio itself, an AnalyserNode for the live level meter.
// The tracks are always stopped when recording ends, so Chrome's "recording" indicator goes away.

import { rms, rmsToLevel } from './audio'

/** About 12 level updates per second: smooth enough for the mascot, cheap on the message channel */
const LEVEL_INTERVAL_MS = 83
const TIMESLICE_MS = 250
const PREFERRED_MIME = 'audio/webm;codecs=opus'

export interface Recording {
  /** Stops recording, releases the microphone and resolves with everything captured */
  stop(): Promise<Blob>
  /** Stops recording, releases the microphone and throws the audio away */
  cancel(): void
}

export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(PREFERRED_MIME) ? { mimeType: PREFERRED_MIME } : {})
  } catch (e) {
    for (const t of stream.getTracks()) t.stop()
    throw e
  }

  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const meter = startMeter(stream, onLevel)
  let released = false
  const release = () => {
    if (released) return
    released = true
    meter.stop()
    for (const t of stream.getTracks()) t.stop()
  }
  recorder.onerror = release

  recorder.start(TIMESLICE_MS)

  const collect = () => new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        if (recorder.state === 'inactive') {
          release()
          resolve(collect())
          return
        }
        recorder.addEventListener(
          'stop',
          () => {
            release()
            resolve(collect())
          },
          { once: true },
        )
        recorder.stop()
      }),
    cancel: () => {
      recorder.ondataavailable = null
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // Already stopped
      }
      chunks.length = 0
      release()
    },
  }
}

function startMeter(stream: MediaStream, onLevel: (level: number) => void): { stop(): void } {
  let ctx: AudioContext | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    // A context created without a user gesture can start suspended; resume() is a no-op when already running.
    void ctx.resume().catch(() => undefined)
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      onLevel(rmsToLevel(rms(buf)))
    }, LEVEL_INTERVAL_MS)
  } catch {
    // The meter is cosmetic; recording works without it.
  }
  return {
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      if (ctx) void ctx.close().catch(() => undefined)
      ctx = null
    },
  }
}
