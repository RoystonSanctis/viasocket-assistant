// "Test key" in settings: one cheap request that proves the key works, with friendly wording for the result.

import type { KeyTestResult } from '../../shared/messages'
import { anthropicHeaders } from './anthropic'
import { LIST_TIMEOUT_MS, asRecord, llmFetch, providerUrl } from './http'
import { openaiHeaders } from './openai'
import { adapterFor } from './registry'
import { LlmError, type ResolvedProvider } from './types'

type Details = Record<string, string | number | boolean>

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Reads an OpenRouter-style /key answer: {data:{is_free_tier, free_model_daily_requests, limit_remaining, ...}}. */
function describeKeyInfo(p: ResolvedProvider, json: unknown): KeyTestResult {
  const data = asRecord(asRecord(json)?.data) ?? asRecord(json) ?? {}
  const details: Details = {}
  const parts: string[] = [p.key ? `Your ${p.name} key works.` : `Connected to ${p.name}.`]

  if (typeof data.is_free_tier === 'boolean') {
    details.freeTier = data.is_free_tier
    parts.push(data.is_free_tier ? 'You are on the free tier.' : 'Your account has paid credits.')
  }

  const daily = asRecord(data.free_model_daily_requests)
  if (daily) {
    const used = num(daily.used)
    const limit = num(daily.limit)
    const remaining = num(daily.remaining) ?? (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined)
    if (used !== undefined) details.freeDailyUsed = used
    if (limit !== undefined) details.freeDailyLimit = limit
    if (remaining !== undefined) details.freeDailyRemaining = remaining
    if (remaining !== undefined && limit !== undefined) {
      parts.push(`${remaining} of ${limit} free-model requests left today.`)
    } else if (remaining !== undefined) {
      parts.push(`${remaining} free-model requests left today.`)
    }
  }

  const creditsLeft = num(data.limit_remaining)
  if (creditsLeft !== undefined) {
    details.creditsRemaining = Math.round(creditsLeft * 100) / 100
    if (creditsLeft <= 0 && data.is_free_tier !== true) parts.push('The key has no credit left, so only free models will work.')
  }
  const usage = num(data.usage)
  if (usage !== undefined) details.creditsUsed = Math.round(usage * 100) / 100

  return { ok: true, message: parts.join(' '), details }
}

function failure(p: ResolvedProvider, e: unknown): KeyTestResult {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case 'auth':
        if (!p.key) return { ok: false, message: e.message }
        return { ok: false, message: `${e.message} Copy the key again from ${p.name}'s key page if this keeps happening.` }
      case 'quota':
        if (e.status === 429) return { ok: true, message: `The key works, but ${p.name} reports a usage limit right now. (${e.message})` }
        return { ok: false, message: `The key works, but the ${p.name} account has no credit left. (${e.message})` }
      case 'rate-limit':
        // A rate limit means the key itself was accepted.
        return { ok: true, message: `The key works, but ${p.name} is rate limiting it right now. (${e.message})` }
      default:
        return { ok: false, message: e.message }
    }
  }
  return { ok: false, message: `Testing ${p.name} failed unexpectedly: ${(e as Error)?.message ?? String(e)}` }
}

export async function testProvider(p: ResolvedProvider, validatePath?: string): Promise<KeyTestResult> {
  const path = validatePath ?? p.validatePath
  try {
    if (path) {
      try {
        const headers = p.adapter === 'anthropic' ? anthropicHeaders(p) : openaiHeaders(p)
        const json = await llmFetch(p, providerUrl(p, path), { method: 'GET', headers, timeoutMs: LIST_TIMEOUT_MS })
        return describeKeyInfo(p, json)
      } catch (e) {
        // A missing or changed validation endpoint is not the key's fault; fall back to listing models.
        if (!(e instanceof LlmError) || e.kind !== 'bad-request') throw e
      }
    }
    const models = await adapterFor(p.adapter).listModels(p)
    const withTools = models.filter((m) => m.supportsTools).length
    const details: Details = { models: models.length }
    if (withTools) details.toolModels = withTools
    if (!models.length) {
      return { ok: true, message: `Connected to ${p.name}, but it lists no models. Download or enable a model first.`, details }
    }
    const toolNote = withTools ? ` (${withTools} can use tools)` : ''
    return { ok: true, message: `Connected to ${p.name}. ${models.length} models available${toolNote}.`, details }
  } catch (e) {
    return failure(p, e)
  }
}
