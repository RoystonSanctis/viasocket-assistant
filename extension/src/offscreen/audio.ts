// Audio maths for the recorder: level metering and conversion to the 16 kHz mono PCM that speech models expect.

export const TARGET_RATE = 16_000
/** Opus always decodes at 48 kHz, so decoding at that rate avoids a needless first resample */
const DECODE_RATE = 48_000
/** Loudest-window RMS below this (about -44 dBFS) is treated as silence */
export const SILENCE_RMS = 0.006
const WINDOW_SECONDS = 0.05

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length)
}

/** Maps RMS to 0..1 on a dB scale (-60 dBFS -> 0, 0 dBFS -> 1), which tracks perceived loudness. */
export function rmsToLevel(value: number): number {
  if (value <= 0) return 0
  const db = 20 * Math.log10(value)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/**
 * RMS of the loudest 50 ms window. Whisper invents phrases ("Thank you.") for silent input,
 * so silent recordings are skipped instead of transcribed.
 */
export function peakRms(samples: Float32Array, rate = TARGET_RATE): number {
  const win = Math.max(1, Math.round(rate * WINDOW_SECONDS))
  let peak = 0
  for (let start = 0; start < samples.length; start += win) {
    peak = Math.max(peak, rms(samples.subarray(start, start + win)))
  }
  return peak
}

/** Decodes a recorded blob and renders it to 16 kHz mono through an OfflineAudioContext (resample + downmix). */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const encoded = await blob.arrayBuffer()
  const decoded = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(encoded)
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  const ctx = new OfflineAudioContext(1, frames, TARGET_RATE)
  const source = ctx.createBufferSource()
  source.buffer = decoded
  source.connect(ctx.destination)
  source.start()
  const rendered = await ctx.startRendering()
  return rendered.getChannelData(0).slice()
}
