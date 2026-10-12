// Requests from the options page to the service worker. The worker holds the keys and does all provider I/O;
// this page only ever sees key summaries (last 4 characters).

import type { ModelInfo } from '../background/llm/types'
import type { KeyTestResult, OptionsRequest, OptionsResponse, OptionsState } from '../shared/messages'

const NOT_RESPONDING = "The extension's background service isn't responding. Reload the extension and try again."

async function call<T>(req: OptionsRequest): Promise<T> {
  let res: OptionsResponse<T> | undefined
  try {
    res = await chrome.runtime.sendMessage<OptionsRequest, OptionsResponse<T> | undefined>(req)
  } catch {
    throw new Error(NOT_RESPONDING)
  }
  if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') throw new Error(NOT_RESPONDING)
  if (!res.ok) throw new Error(res.error || 'Something went wrong.')
  return res.data
}

function cleanModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return []
  const out: ModelInfo[] = []
  for (const m of raw as unknown[]) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    out.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name ? r.name : undefined,
      contextLength: typeof r.contextLength === 'number' ? r.contextLength : undefined,
      supportsTools: typeof r.supportsTools === 'boolean' ? r.supportsTools : undefined,
      free: typeof r.free === 'boolean' ? r.free : undefined,
    })
  }
  return out
}

export const rpc = {
  getState: () => call<OptionsState>({ target: 'background', type: 'options:get-state' }),

  saveKey: (providerId: string, key: string, baseUrl?: string) =>
    call<unknown>(
      baseUrl
        ? { target: 'background', type: 'options:save-key', providerId, key, baseUrl }
        : { target: 'background', type: 'options:save-key', providerId, key },
    ),

  removeKey: (providerId: string) => call<unknown>({ target: 'background', type: 'options:remove-key', providerId }),

  testKey: (providerId: string) => call<KeyTestResult>({ target: 'background', type: 'options:test-key', providerId }),

  listModels: async (providerId: string) =>
    cleanModels(await call<unknown>({ target: 'background', type: 'options:list-models', providerId })),

  refreshConfig: () => call<unknown>({ target: 'background', type: 'options:refresh-config' }),

  sttWarmup: () => call<unknown>({ target: 'background', type: 'options:stt-warmup' }),
}
