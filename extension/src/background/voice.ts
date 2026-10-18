// Voice plumbing in the service worker. Local speech recognition runs in the offscreen document (the worker has
// no microphone or DOM); the browser Web Speech engine runs in the content script and never comes through here.

import type { FromOffscreen, ToOffscreen, VoiceState } from '../shared/messages'
import { loadSettings } from '../shared/settings'
import type { VoiceConfig } from '../shared/config'
import { getConfig } from './config-loader'
import { runAgent } from './agent/loop'
import { postLine } from './agent/conversation'
import { allSessions, type Session } from './agent/session'
import { isVoiceExit, parseConfirmIntent } from '../shared/voice-intent'

const OFFSCREEN_URL = 'offscreen.html'
const VOICE_STATES: readonly VoiceState[] = ['off', 'loading-model', 'ready', 'listening', 'transcribing', 'error', 'needs-permission']
/** States that end a voice turn (the offscreen document reports 'ready' after the result) */
const TURN_OVER: ReadonlySet<VoiceState> = new Set(['ready', 'error', 'needs-permission', 'off'])
const MAX_TRANSCRIPT_CHARS = 2000
export const STT_IDLE_ALARM = 'stt-idle'
/** The offscreen document holds the speech model (hundreds of MB); it is closed after this long without voice use. */
const IDLE_CLOSE_MS = 10 * 60_000
/** With no viaSocket tab open nothing can use the model; a reloading tab reconnects well within this. */
const NO_TABS_IDLE_MS = 60_000

let creatingOffscreen: Promise<void> | null = null
/** Session (not tab id: a reload reuses the id) that started the current recording; results and levels go only there. */
let ownerSession: Session | null = null
let voiceQueue: Promise<void> = Promise.resolve()
let lastVoiceUse = 0

/**
 * Runs voice steps one at a time, so a stop or cancel reaches the offscreen document only after the start it ends
 * was delivered, and ownership is settled before the next step reads it.
 */
function enqueue<T>(step: () => Promise<T>): Promise<T> {
  const run = voiceQueue.then(step)
  voiceQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function liveOwner(): Session | undefined {
  return ownerSession && !ownerSession.closed ? ownerSession : undefined
}

export async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })
  if (contexts.length > 0) return
  // createDocument rejects if a document already exists, so concurrent callers share one creation.
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Record voice commands for on-device speech recognition',
    })
    .finally(() => {
      creatingOffscreen = null
    })
  await creatingOffscreen
}

async function toOffscreen(msg: ToOffscreen): Promise<void> {
  // The document's listener can register a moment after createDocument resolves.
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.runtime.sendMessage(msg)
      return
    } catch (e) {
      if (attempt >= 2) throw e
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function handleVoiceCommand(session: Session, action: 'start' | 'stop' | 'toggle' | 'cancel'): Promise<void> {
  return enqueue(async () => {
    if (session.closed) return
    const settings = await loadSettings()
    if (settings.sttEngine === 'browser') return
    if (action === 'cancel') return cancelListening(session)
    const start = action === 'start' || (action === 'toggle' && !session.voiceActive)
    if (start) await startListening(session, settings.sttModel, settings.sttLanguage)
    else await stopListening(session)
  })
}

async function startListening(session: Session, sttModel: string, sttLanguage: string): Promise<void> {
  const config = await getConfig()
  if (ownerSession && ownerSession !== session) {
    const previous = ownerSession
    previous.voiceActive = false
    previous.voiceTurn = false
    previous.send({ type: 'voice-state', state: 'off' })
    await toOffscreen({ target: 'offscreen', type: 'stt-cancel' }).catch(() => undefined)
  }
  ownerSession = session
  session.voiceActive = true
  session.voiceTurn = true
  scheduleIdleCheck()
  chrome.tts.stop()
  try {
    await ensureOffscreen()
    await toOffscreen({
      target: 'offscreen',
      type: 'stt-start',
      model: sttModel || config.voice.stt.defaultModel,
      language: sttLanguage || undefined,
      device: 'auto',
    })
  } catch (e) {
    session.voiceActive = false
    session.voiceTurn = false
    session.send({ type: 'voice-state', state: 'error', detail: errorText(e) })
    postLine(session, 'system-note', `Voice input is unavailable right now: ${errorText(e)}`)
  }
}

async function stopListening(session: Session): Promise<void> {
  session.voiceActive = false
  // Keep ownerSession: the transcription result arrives after the stop.
  if (ownerSession !== session) return
  await toOffscreen({ target: 'offscreen', type: 'stt-stop' }).catch((e: unknown) => {
    session.voiceTurn = false
    session.send({ type: 'voice-state', state: 'error', detail: errorText(e) })
  })
}

async function cancelListening(session: Session): Promise<void> {
  session.voiceActive = false
  session.voiceTurn = false
  if (ownerSession !== session) return
  ownerSession = null
  await toOffscreen({ target: 'offscreen', type: 'stt-cancel' }).catch(() => undefined)
  session.send({ type: 'voice-state', state: 'ready' })
}

/** The tab closed, reloaded or navigated away: stop a recording it owns instead of letting it run to the time limit. */
export function releaseVoice(session: Session): Promise<void> {
  return enqueue(async () => {
    session.voiceActive = false
    session.voiceTurn = false
    if (ownerSession !== session) return
    ownerSession = null
    await toOffscreen({ target: 'offscreen', type: 'stt-cancel' }).catch(() => undefined)
  })
}

/** Loads the speech model ahead of time (options page "download now"). Progress reaches the options page directly. */
export async function warmupStt(): Promise<void> {
  const [settings, config] = await Promise.all([loadSettings(), getConfig()])
  scheduleIdleCheck()
  await ensureOffscreen()
  await toOffscreen({ target: 'offscreen', type: 'stt-warmup', model: settings.sttModel || config.voice.stt.defaultModel, device: 'auto' })
}

// ---------- releasing the offscreen document ----------

function scheduleIdleCheck(): void {
  lastVoiceUse = Date.now()
  chrome.alarms.create(STT_IDLE_ALARM, { delayInMinutes: IDLE_CLOSE_MS / 60_000 }).catch(() => undefined)
}

/**
 * Closes the offscreen document, and with it the loaded speech model, when no voice turn is running and nothing
 * has used it for minIdleMs. Returns how long to wait before checking again (0 once closed or nothing to close).
 * ensureOffscreen() recreates the document on the next use.
 */
export function closeOffscreenIfIdle(minIdleMs = IDLE_CLOSE_MS): Promise<number> {
  // Queued with the voice commands so a start cannot be cut off between creating the document and using it.
  return enqueue(async () => {
    if (liveOwner()?.voiceTurn || creatingOffscreen) return minIdleMs
    const idleFor = Date.now() - lastVoiceUse
    if (idleFor < minIdleMs) return minIdleMs - idleFor
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    })
    if (contexts.length > 0) await chrome.offscreen.closeDocument().catch(() => undefined)
    return 0
  })
}

/** The idle alarm fired: close the document, or check again once it could have been idle long enough. */
export async function handleIdleAlarm(): Promise<void> {
  const wait = await closeOffscreenIfIdle(allSessions().length ? IDLE_CLOSE_MS : NO_TABS_IDLE_MS)
  // Alarms fire no sooner than 30 s apart anyway.
  if (wait > 0) await chrome.alarms.create(STT_IDLE_ALARM, { delayInMinutes: Math.max(0.5, wait / 60_000) })
}

/** The last viaSocket tab closed: check for an idle document soon instead of after the full idle period. */
export function noSessionsLeft(): void {
  chrome.alarms.create(STT_IDLE_ALARM, { delayInMinutes: NO_TABS_IDLE_MS / 60_000 }).catch(() => undefined)
}

/** Narrows an untrusted runtime message to a FromOffscreen value. */
export function parseFromOffscreen(raw: unknown): FromOffscreen | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.target !== 'background') return null
  switch (m.type) {
    case 'stt-state':
      if (!VOICE_STATES.includes(m.state as VoiceState)) return null
      return {
        target: 'background',
        type: 'stt-state',
        state: m.state as VoiceState,
        detail: typeof m.detail === 'string' ? m.detail.slice(0, 300) : undefined,
        progress: typeof m.progress === 'number' && Number.isFinite(m.progress) ? m.progress : undefined,
      }
    case 'stt-level':
      return typeof m.level === 'number' && Number.isFinite(m.level)
        ? { target: 'background', type: 'stt-level', level: Math.min(1, Math.max(0, m.level)) }
        : null
    case 'stt-result':
      return typeof m.text === 'string' ? { target: 'background', type: 'stt-result', text: m.text.slice(0, MAX_TRANSCRIPT_CHARS) } : null
    case 'stt-error':
      return typeof m.message === 'string' ? { target: 'background', type: 'stt-error', message: m.message.slice(0, 300) } : null
    default:
      return null
  }
}

export async function handleOffscreenMessage(msg: FromOffscreen): Promise<void> {
  // Model download progress counts as use, so a download from settings is not cut off as idle.
  lastVoiceUse = Date.now()
  if (msg.type === 'stt-state' && msg.state === 'listening') chrome.tts.stop()
  const owner = liveOwner()
  if (!owner) return

  switch (msg.type) {
    case 'stt-state': {
      // Outside a voice turn this is a settings-page warmup; that tab's mascot has nothing to show for it.
      if (!owner.voiceTurn) return
      owner.voiceActive = msg.state === 'listening' || msg.state === 'loading-model'
      if (TURN_OVER.has(msg.state)) owner.voiceTurn = false
      owner.send({ type: 'voice-state', state: msg.state, detail: msg.detail, progress: msg.progress })
      if (msg.state === 'needs-permission') {
        const config = await getConfig()
        postLine(owner, 'system-note', config.mascot.lines.noMic ?? 'Allow the microphone in settings so I can hear you.')
      }
      return
    }
    case 'stt-level':
      owner.send({ type: 'voice-level', level: msg.level })
      return
    case 'stt-error':
      if (!owner.voiceTurn) return
      owner.voiceActive = false
      owner.voiceTurn = false
      owner.send({ type: 'voice-state', state: 'error', detail: msg.message })
      postLine(owner, 'system-note', `I couldn't hear that: ${msg.message}`)
      return
    case 'stt-result': {
      const config = await getConfig()
      const text = correctTranscript(cleanTranscript(msg.text), config.voice.stt.vocabulary)
      owner.send({ type: 'transcript', text, final: true })
      if (!text) return
      if (owner.pendingConfirms.size > 0) {
        const intent = parseConfirmIntent(text)
        if (intent !== null) {
          const firstId = owner.pendingConfirms.keys().next().value
          if (firstId) {
            owner.resolveConfirm(firstId, intent)
            owner.send({ type: 'confirm-cancel', id: firstId })
            return
          }
        }
      }
      if (isVoiceExit(text)) {
        postLine(owner, 'system-note', 'Voice session ended.')
        return
      }
      await runAgent(owner, text, 'voice')
      return
    }
  }
}

/** Drops the non-speech markers small Whisper models emit for silence or noise ("[BLANK_AUDIO]", "(music)"). */
function cleanTranscript(text: string): string {
  const t = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(t) ? t : ''
}

// ---------- speech output ----------

let activeTtsSession: Session | null = null

export function speak(text: string, tts: VoiceConfig['tts'], session?: Session): void {
  if (!tts.enabled || !text) {
    if (session) session.send({ type: 'tts-state', speaking: false })
    return
  }
  activeTtsSession = session ?? null
  if (session) session.send({ type: 'tts-state', speaking: true })
  let doneReported = false
  const notifyDone = () => {
    if (doneReported) return
    doneReported = true
    if (activeTtsSession) {
      activeTtsSession.send({ type: 'tts-state', speaking: false })
      activeTtsSession = null
    }
  }
  try {
    chrome.tts.speak(text, {
      rate: tts.rate,
      pitch: tts.pitch,
      enqueue: false,
      onEvent: (event) => {
        if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
          notifyDone()
        }
      },
    })
  } catch {
    notifyDone()
  }
}

export function stopSpeaking(): void {
  try {
    chrome.tts.stop()
  } catch {}
  if (activeTtsSession) {
    activeTtsSession.send({ type: 'tts-state', speaking: false })
    activeTtsSession = null
  }
}

/** Speaks an assistant reply when the user has audio output on (full or minimal). */
export async function speakReply(text: string, session?: Session): Promise<void> {
  const [settings, config] = await Promise.all([loadSettings(), getConfig()])
  const mode = settings.audioOutput ?? (settings.speakReplies === false ? 'off' : 'full')
  if (mode === 'off' || !settings.speakReplies) {
    if (session) session.send({ type: 'tts-state', speaking: false })
    return
  }
  const maxChars = mode === 'full' ? Math.max(config.voice.tts.maxChars, 4000) : config.voice.tts.maxChars
  speak(speechText(text, maxChars, mode), config.voice.tts, session)
}

// Periods in these do not end a sentence ("e.g. the Slack app"). Swapped for a stand-in while the sentence is found.
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|approx|incl)\./gi
const DOT_STAND_IN = '\u2024'
const HEADING_LINE = /^\s*#{1,6}\s/
/** A list item line, its marker stripped in group 1 */
const LIST_ITEM = /^\s*(?:[*_]{0,2}\d{1,3}[.)][*_]{0,2}|[-*+\u2022])\s+(.*)$/

/**
 * Reply as plain text for speech synthesis:
 * - 'minimal': extracts only the first sentence
 * - 'full': cleans markdown syntax and speaks the full response capped at maxChars
 */
export function speechText(text: string, maxChars: number, mode: 'full' | 'minimal' = 'minimal'): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((line) => {
      if (mode === 'minimal' && HEADING_LINE.test(line)) return ''
      if (mode === 'full' && HEADING_LINE.test(line)) {
        return line.replace(HEADING_LINE, '').trim().replace(/[^.!?:;]$/, '$&:')
      }
      const item = LIST_ITEM.exec(line)?.[1]?.trim()
      return item === undefined ? line : item.replace(/[^.!?:;]$/, '$&.')
    })
    .join(' ')
    .replace(/[*_#>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, DOT_STAND_IN))

  let s = mode === 'full' ? plain.replaceAll(DOT_STAND_IN, '.') : (/^(.{2,}?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain).replaceAll(DOT_STAND_IN, '.')
  if (s.length > maxChars) {
    s = s.slice(0, Math.max(1, maxChars - 1))
    const cut = s.lastIndexOf(' ')
    if (cut > maxChars * 0.6) s = s.slice(0, cut)
    s += '…'
  }
  return s
}

// ---------- transcript correction ----------

/** Shorter words are never respelled, only re-cased on an exact match: too many ordinary words sit nearby. */
const MIN_FUZZY_CHARS = 5

// Ordinary words near a vocabulary term that must never be "corrected" into it
// (e.g. "discard" is a viaSocket action, not Discord; "Jason" is a person, not JSON).
const COMMON_WORDS = new Set([
  'discard', 'discards', 'discarded', 'calendar', 'calendars', 'stack', 'snack', 'slick', 'strike', 'strip', 'stride',
  'strive', 'plus', 'plum', 'nation', 'open', 'opens', 'opened', 'linked', 'linking', 'tiger', 'click', 'clicks',
  'clicked', 'checkup', 'zoo', 'hotspot', 'crop', 'crow', 'crown', 'con', 'disco', 'telegraph', 'twister', 'jason',
  'interim', 'interior', 'freshness',
])

/**
 * Spoken split forms of one-word names. Only these are joined: other splits are ordinary phrases
 * ("click up there", "I linked in step two"), so a window of more words than the term must be listed here.
 */
const SPLIT_NAMES: Readonly<Record<string, string>> = {
  'via socket': 'viasocket', 'g mail': 'gmail', 'web hook': 'webhook', 'hub spot': 'hubspot', 'air table': 'airtable',
  'git hub': 'github', 'drop box': 'dropbox', 'open ai': 'openai', 'type form': 'typeform', 'web flow': 'webflow',
  'mail chimp': 'mailchimp', 'pipe drive': 'pipedrive', 'fresh desk': 'freshdesk', 'zen desk': 'zendesk',
  'razor pay': 'razorpay', 'whats app': 'whatsapp', 'insta gram': 'instagram', 'tele gram': 'telegram',
  'inter com': 'intercom',
}
const SPLIT_MAX_WORDS = Math.max(...Object.keys(SPLIT_NAMES).map((k) => k.split(' ').length))

interface Term {
  display: string
  norm: string
  words: number
  maxDist: number
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const leadingPunct = (t: string): string => /^[^\p{L}\p{N}]*/u.exec(t)?.[0] ?? ''
const trailingPunct = (t: string): string => /[^\p{L}\p{N}]*$/u.exec(t)?.[0] ?? ''

function prepareTerms(vocabulary: string[]): Term[] {
  const terms: Term[] = []
  for (const raw of vocabulary) {
    const display = raw.trim()
    const norm = normalize(display)
    if (!norm) continue
    // One edit only, and only for long names: shorter ones have too many real words one edit away.
    terms.push({ display, norm, words: display.split(/\s+/).length, maxDist: norm.length >= 8 ? 1 : 0 })
  }
  return terms
}

/**
 * Corrects app names small speech models mishear ("google sheet" -> "Google Sheets", "via socket" -> "viaSocket").
 * A window with the term's own number of words (or one word fewer, run together) may differ by one edit when the
 * name has 8+ letters; a window with more words must be a listed split form; single words under 5 letters or
 * common words are never respelled.
 */
export function correctTranscript(text: string, vocabulary: string[]): string {
  const terms = prepareTerms(vocabulary)
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!terms.length || !tokens.length) return text
  const maxWindow = Math.max(SPLIT_MAX_WORDS, ...terms.map((t) => t.words))
  const out: string[] = []
  for (let i = 0; i < tokens.length; ) {
    const match = bestMatch(tokens, i, terms, maxWindow)
    if (!match) {
      out.push(tokens[i] ?? '')
      i++
      continue
    }
    out.push(leadingPunct(tokens[i] ?? '') + match.term.display + trailingPunct(tokens[i + match.size - 1] ?? ''))
    i += match.size
  }
  return out.join(' ')
}

function bestMatch(tokens: string[], start: number, terms: Term[], maxWindow: number): { term: Term; size: number } | null {
  let best: { term: Term; size: number; dist: number } | null = null
  for (let size = Math.min(maxWindow, tokens.length - start); size >= 1; size--) {
    const window = tokens.slice(start, start + size)
    // Punctuation between words ("Slack, then") separates phrases.
    if (window.slice(0, -1).some((t) => trailingPunct(t) !== '') || window.slice(1).some((t) => leadingPunct(t) !== '')) continue
    const words = window.map(normalize)
    if (words.some((w) => !w)) continue
    const joined = words.join('')
    const split = size > 1 ? SPLIT_NAMES[words.join(' ')] : undefined
    for (const term of terms) {
      let dist = Infinity
      if (size > term.words) dist = split === term.norm ? 0 : Infinity
      else if (size >= term.words - 1) dist = joined === term.norm ? 0 : fuzzyDistance(joined, term, size === 1)
      if (dist === Infinity) continue
      if (!best || dist < best.dist || (dist === best.dist && size > best.size)) best = { term, size, dist }
    }
  }
  return best
}

function fuzzyDistance(word: string, term: Term, singleWord: boolean): number {
  if (term.maxDist === 0 || word[0] !== term.norm[0]) return Infinity
  // Inflections of the term itself ("webhooks", "triggered") are already right.
  if (word.startsWith(term.norm)) return Infinity
  if (singleWord && (word.length < MIN_FUZZY_CHARS || COMMON_WORDS.has(word))) return Infinity
  if (Math.abs(word.length - term.norm.length) > term.maxDist) return Infinity
  const d = levenshtein(word, term.norm)
  return d <= term.maxDist ? d : Infinity
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost))
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}
