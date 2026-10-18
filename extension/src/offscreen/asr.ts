// On-device speech recognition with Transformers.js v4. Model files download once from the Hugging Face Hub and
// stay in the Cache API; inference runs on WebGPU when the machine has a usable adapter, otherwise on WASM.

import { env, pipeline } from '@huggingface/transformers'
import type { DataType, ProgressInfo } from '@huggingface/transformers'

export type AsrDevice = 'webgpu' | 'cpu'
export type DevicePreference = AsrDevice | 'auto' | 'wasm'

type AsrPipeline = Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>>

export interface LoadedAsr {
  pipe: AsrPipeline
  device: AsrDevice
}

env.allowLocalModels = false
env.allowRemoteModels = true
env.useBrowserCache = true
// The extension CSP only runs scripts from 'self': the ONNX runtime must come from the package (copied to ort/ by
// the build), never from the default CDN, and never through the blob: URLs the WASM cache would create.
env.useWasmCache = false
const onnxWasm = env.backends.onnx.wasm
if (onnxWasm) {
  onnxWasm.wasmPaths = chrome.runtime.getURL('ort/')
  // Extension pages are not cross-origin isolated, so SharedArrayBuffer (and with it WASM threads) is unavailable.
  onnxWasm.numThreads = 1
  onnxWasm.proxy = false
}

const DTYPES: Record<AsrDevice, DataType | Record<string, DataType>> = {
  // Whisper on WebGPU: fp32 encoder for accuracy, 4-bit decoder for speed and memory (fp16 decoders are unreliable).
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  cpu: 'q8',
}

const GPU_PROBE_TIMEOUT_MS = 2000
const PROGRESS_MIN_INTERVAL_MS = 200

export type ProgressHandler = (model: string, percent: number) => void
let onProgress: ProgressHandler = () => undefined
export function setProgressHandler(handler: ProgressHandler): void {
  onProgress = handler
}

const pipelines = new Map<string, Promise<LoadedAsr>>()
const ready = new Set<string>()
const progressByModel = new Map<string, number>()

export function isReady(model: string): boolean {
  return ready.has(model)
}

export function lastProgress(model: string): number {
  return progressByModel.get(model) ?? 0
}

/** Loads (downloading on first use) the pipeline for a model. Concurrent callers share one load. */
export function loadAsr(model: string, preference: DevicePreference = 'auto'): Promise<LoadedAsr> {
  const existing = pipelines.get(model)
  if (existing) return existing
  // Settings use one model at a time; keeping a previous one loaded would hold hundreds of MB for nothing.
  for (const [id, other] of pipelines) {
    pipelines.delete(id)
    ready.delete(id)
    void other.then((l) => l.pipe.dispose()).catch(() => undefined)
  }
  const loading = create(model, preference)
  pipelines.set(model, loading)
  loading.then(
    () => ready.add(model),
    () => {
      if (pipelines.get(model) === loading) pipelines.delete(model)
      progressByModel.delete(model)
    },
  )
  return loading
}

async function create(model: string, preference: DevicePreference): Promise<LoadedAsr> {
  const pref = preference === 'wasm' ? 'cpu' : preference
  const device: AsrDevice = pref === 'auto' ? ((await hasWebGpu()) ? 'webgpu' : 'cpu') : pref
  try {
    return { pipe: await build(model, device), device }
  } catch (e) {
    if (device !== 'webgpu' || isNetworkError(e)) throw e
    // Some GPUs/drivers expose WebGPU but fail to compile the model; the CPU path is slower but works everywhere.
    console.warn('[asr] WebGPU pipeline failed, falling back to CPU:', e)
    return { pipe: await build(model, 'cpu'), device: 'cpu' }
  }
}

async function build(model: string, device: AsrDevice): Promise<AsrPipeline> {
  let best = 0
  let sent = -1
  let sentAt = 0
  progressByModel.set(model, 0)
  const progress_callback = (info: ProgressInfo) => {
    if (info.status !== 'progress_total') return
    // The total grows as new files start, so the raw percentage can dip; never move the bar backwards.
    best = Math.max(best, Math.min(100, Math.floor(info.progress)))
    progressByModel.set(model, best)
    const now = Date.now()
    if (best === sent || (best < 100 && now - sentAt < PROGRESS_MIN_INTERVAL_MS)) return
    sent = best
    sentAt = now
    onProgress(model, best)
  }
  const targetDevice = device === 'webgpu' ? 'webgpu' : 'cpu'
  return pipeline('automatic-speech-recognition', model, { device: targetDevice, dtype: DTYPES[targetDevice], progress_callback })
}

let gpuProbe: Promise<boolean> | null = null

type GpuNavigator = Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }

function hasWebGpu(): Promise<boolean> {
  gpuProbe ??= (async () => {
    const gpu = (navigator as GpuNavigator).gpu
    if (!gpu) return false
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GPU_PROBE_TIMEOUT_MS))
      const adapter = await Promise.race([gpu.requestAdapter(), timeout])
      return adapter != null
    } catch {
      return false
    }
  })()
  return gpuProbe
}

export function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /failed to fetch|networkerror|network error|load failed|err_internet|err_network/i.test(msg)
}

/** Only fields of the loaded model we branch on; read loosely because they come from the model's JSON config. */
interface ModelMeta {
  config?: { model_type?: string }
  generation_config?: { is_multilingual?: boolean }
}

export async function transcribe(loaded: LoadedAsr, audio: Float32Array, language?: string): Promise<string> {
  const meta = loaded.pipe.model as unknown as ModelMeta
  const options: Record<string, string | number> = {}
  if (meta.config?.model_type === 'whisper') {
    options.chunk_length_s = 30
    options.stride_length_s = 5
    // English-only Whisper checkpoints reject language/task. Multilingual ones cannot auto-detect in
    // Transformers.js and fall back to English when no language is given.
    if (meta.generation_config?.is_multilingual) {
      options.task = 'transcribe'
      if (language && /^[a-z]{2,3}$/.test(language)) options.language = language
    }
  }
  const out = await loaded.pipe(audio, options)
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
  return cleanTranscript(text)
}

/** Whisper marks non-speech as [BLANK_AUDIO], [Music], (silence) and similar; none of that is something the user said. */
function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:silence|music|noise|inaudible|applause|laughs?|blank_audio)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
