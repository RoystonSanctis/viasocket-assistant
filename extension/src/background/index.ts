// Service worker entry. Every listener is registered synchronously at the top level: MV3 only delivers the
// event that woke the worker to listeners that exist by the end of the first turn of the event loop.

import { toClientConfig, type FullConfig } from '../shared/config'
import { CONFIG_REFRESH_MINUTES } from '../shared/constants'
import { PORT_NAME, type ContentToBackground, type OptionsRequest } from '../shared/messages'
import type { ObservedEvent, ObservedKind } from '../shared/observed'
import { parsePage, type PageContext } from '../shared/page'
import { SETTINGS_KEY, type UserSettings } from '../shared/settings'
import { getConfig, onConfigChanged, refreshConfig } from './config-loader'
import { clearThread, forgetIncognitoThreads, sendHistory } from './agent/conversation'
import { runAgent } from './agent/loop'
import { handleObserved, handleSuggestionResponse } from './agent/reactions'
import { suggestionStillApplies } from './agent/run-target'
import { allSessions, closeSession, getSession, openSession, type Session } from './agent/session'
import { computeStatus } from './agent/status'
import { migrateLegacyKeys, onKeysChanged } from './keys'
import { handleOptionsRequest } from './options-handler'
import { resolveEnv, SUPPORTED_APP_HOSTS } from './tools/env'
import {
  closeOffscreenIfIdle, handleIdleAlarm, handleOffscreenMessage, handleVoiceCommand, noSessionsLeft, parseFromOffscreen,
  releaseVoice, stopSpeaking, STT_IDLE_ALARM,
} from './voice'

const CONFIG_ALARM = 'config-refresh'
const MAX_TEXT_CHARS = 4000
const OPTIONS_SECTION = /^[a-z0-9-]{1,40}$/
const OBSERVED_KINDS: ReadonlySet<ObservedKind> = new Set([
  'flow-loaded', 'step-saved', 'step-created', 'step-deleted', 'step-tested', 'trigger-saved',
  'flow-published', 'flow-discarded', 'dh-saved', 'dh-dry-run', 'api-error', 'unknown-mutation',
])

/**
 * Incognito conversations (memory only) are dropped this long after the last incognito tab went, not at once, so
 * reloading the only incognito tab keeps its conversation.
 */
const INCOGNITO_FORGET_MS = 60_000

const warn = (what: string) => (e: unknown) => console.warn(`[assistant] ${what}:`, e instanceof Error ? e.message : e)

// ---------- content-script ports ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  const sender = port.sender
  const tabId = sender?.tab?.id
  if (sender?.id !== chrome.runtime.id || tabId === undefined || (sender.frameId ?? 0) !== 0) {
    port.disconnect()
    return
  }
  const session = openSession(port, tabId)
  port.onMessage.addListener((msg: unknown) => {
    handlePortMessage(session, msg).catch(warn('port message failed'))
  })
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    // A recording this tab started must not keep running (or reach the reloaded page) after it is gone.
    releaseVoice(session).catch(warn('could not stop recording'))
    closeSession(session)
    if (!allSessions().length) noSessionsLeft()
    if (session.incognito) scheduleIncognitoForget()
  })
})

let incognitoForgetTimer: ReturnType<typeof setTimeout> | undefined
function scheduleIncognitoForget(): void {
  clearTimeout(incognitoForgetTimer)
  incognitoForgetTimer = setTimeout(() => {
    if (!allSessions().some((s) => s.incognito)) forgetIncognitoThreads()
  }, INCOGNITO_FORGET_MS)
}

/**
 * Re-derives the page from its URL instead of trusting the fields the content script sent, and only accepts
 * URLs on the host the port was opened from (single-page navigation never changes the host).
 */
function trustedPage(session: Session, raw: unknown): PageContext | null {
  const url = raw && typeof raw === 'object' ? (raw as { url?: unknown }).url : undefined
  if (typeof url !== 'string') return null
  try {
    const page = parsePage(url)
    const senderUrl = session.port.sender?.url
    if (senderUrl && new URL(senderUrl).host !== page.host) return null
    return page
  } catch {
    return null
  }
}

function asObservedEvent(raw: unknown): ObservedEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (!OBSERVED_KINDS.has(e.kind as ObservedKind)) return null
  if (typeof e.method !== 'string' || typeof e.path !== 'string' || typeof e.status !== 'number') return null
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  return {
    kind: e.kind as ObservedKind,
    at: typeof e.at === 'number' ? e.at : Date.now(),
    method: e.method.slice(0, 10),
    path: e.path.slice(0, 300),
    status: e.status,
    ok: e.ok === true,
    byAssistant: e.byAssistant === true,
    scriptId: str(e.scriptId, 40),
    slugName: str(e.slugName, 80),
    errorText: str(e.errorText, 500),
    durationMs: typeof e.durationMs === 'number' ? e.durationMs : undefined,
  }
}

async function sendHello(session: Session): Promise<void> {
  const config = await getConfig()
  session.send({ type: 'config', config: toClientConfig(config) })
  // Chat lines and the plan checklist, so a reload keeps both.
  await sendHistory(session, session.threadKey)
  session.send(await computeStatus(config))
  // A panel that was mid-run when the worker restarted would otherwise stay "busy".
  session.send({ type: 'busy', busy: session.busy })
}

/** Page updates run one after another, so a slow cookie-store lookup for an older page never lands last. */
function queuePageUpdate(session: Session, page: PageContext): Promise<void> {
  const next = session.pageUpdate.then(() => session.setPage(page)).catch(() => undefined)
  session.pageUpdate = next
  return next
}

/** Suggestions are bound to the flow or plug they were made on; once the tab shows another one, their cards go. */
function dropStaleSuggestions(session: Session): void {
  const stale: string[] = []
  for (const [id, entry] of session.pendingSuggestions) if (!suggestionStillApplies(entry, session.page)) stale.push(id)
  for (const id of stale) session.pendingSuggestions.delete(id)
  if (stale.length) session.send({ type: 'suggestions-clear', ids: stale })
}

async function handlePortMessage(session: Session, raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return
  const msg = raw as ContentToBackground
  switch (msg.type) {
    case 'hello': {
      const page = trustedPage(session, msg.page)
      if (page) await queuePageUpdate(session, page)
      await sendHello(session)
      return
    }
    case 'page-changed': {
      const page = trustedPage(session, msg.page)
      if (!page) return
      const before = session.threadKey
      await queuePageUpdate(session, page)
      dropStaleSuggestions(session)
      // During a run the panel keeps showing the run; the thread follows the user when it ends.
      const now = session.threadOf(page)
      if (!session.busy && now !== before) await sendHistory(session, now)
      return
    }
    case 'user-input':
      if (typeof msg.text !== 'string') return
      await session.pageUpdate
      await runAgent(session, msg.text.slice(0, MAX_TEXT_CHARS), msg.source === 'voice' ? 'voice' : 'text')
      return
    case 'observed': {
      const event = asObservedEvent(msg.event)
      if (event) await handleObserved(session, event)
      return
    }
    case 'confirm-response':
      if (typeof msg.id === 'string') session.resolveConfirm(msg.id, msg.approved === true)
      return
    case 'dom-status':
      session.setDomStatus(msg.status)
      return
    case 'dom-status-response':
      if (typeof msg.requestId === 'string') {
        session.resolveDomStatus(msg.requestId, msg.status)
      }
      return
    case 'suggestion-response':
      if (typeof msg.id === 'string' && (msg.action === 'apply' || msg.action === 'dismiss')) {
        await session.pageUpdate
        await handleSuggestionResponse(session, msg.id, msg.action)
      }
      return
    case 'cancel':
      stopSpeaking()
      session.cancelRun()
      return
    case 'heartbeat':
      // Receiving it is the point: port traffic keeps the worker alive during long LLM calls.
      return
    case 'voice':
      if (msg.action === 'start' || msg.action === 'stop' || msg.action === 'toggle' || msg.action === 'cancel') {
        await handleVoiceCommand(session, msg.action)
      }
      return
    case 'clear-thread': {
      session.cancelRun()
      // A cancelled run still saves its last tool results; clearing first would let that save resurrect the thread.
      await session.whenIdle(5000)
      const key = session.page ? session.threadOf(session.page) : null
      if (key) await clearThread(key)
      // Empty history and no plan: the plan is stored with the thread and went with it.
      await sendHistory(session, null)
      return
    }
    case 'open-options':
      await openOptions(typeof msg.section === 'string' ? msg.section : undefined)
      return
  }
}

async function openOptions(section?: string): Promise<void> {
  if (section && OPTIONS_SECTION.test(section)) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${section}`) })
  } else {
    await chrome.runtime.openOptionsPage()
  }
}

import { handleStepClipboardRequest } from './step-clipboard'
import type { StepClipboardRequest } from '../shared/step-clipboard'
import { handleFlowTransferRequest } from './flow-transfer'
import type { FlowTransferRequest } from '../shared/flow-transfer'
import { handleSubfunctionsRequest } from './subfunctions'
import type { SubfnRequest } from '../shared/subfunctions'

/** The sender tab shows one of the supported viaSocket app hosts. */
function senderEnvOk(tabUrl: string | undefined): boolean {
  if (!tabUrl) return false
  try {
    return resolveEnv(new URL(tabUrl).host) !== null
  } catch {
    return false
  }
}

// ---------- options page and offscreen document ----------

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !raw || typeof raw !== 'object') return false
  const msg = raw as { target?: unknown; type?: unknown }
  if (msg.target !== 'background' || typeof msg.type !== 'string') return false

  if (msg.type.startsWith('options:')) {
    // Content scripts can message the worker too; key management is only for the options page.
    if (!sender.url?.startsWith(chrome.runtime.getURL('options.html'))) return false
    handleOptionsRequest(raw as OptionsRequest).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    return true
  }

  if (msg.type.startsWith('step:') || msg.type.startsWith('flow:') || msg.type.startsWith('subfn:')) {
    // Clipboard, transfer and subfunction-panel calls only make sense from a content script on a supported viaSocket host; a
    // message from any other extension context (options page, future pages) is refused instead of silently
    // operating against some default environment.
    if (sender.tab?.id === undefined || !senderEnvOk(sender.tab.url)) {
      sendResponse({ ok: false, error: 'This action only works from a viaSocket page' })
      return true
    }
    if (msg.type.startsWith('step:')) {
      handleStepClipboardRequest(raw as StepClipboardRequest, sender).then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    } else if (msg.type.startsWith('subfn:')) {
      handleSubfunctionsRequest(raw as SubfnRequest, sender).then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    } else {
      handleFlowTransferRequest(raw as FlowTransferRequest, sender).then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    }
    return true
  }

  if (msg.type.startsWith('stt-')) {
    if (!sender.url?.startsWith(chrome.runtime.getURL('offscreen.html'))) return false
    const parsed = parseFromOffscreen(raw)
    if (parsed) handleOffscreenMessage(parsed).catch(warn('voice message failed'))
  }
  return false
})

// ---------- commands, action, lifecycle ----------

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-voice') return
  void (async () => {
    const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
    // The tab owns push-to-talk for both engines (browser speech runs there), so it decides what toggling means.
    if (tabId !== undefined) getSession(tabId)?.send({ type: 'voice-command', action: 'toggle' })
  })().catch(warn('voice command failed'))
})

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage().catch(warn('could not open settings'))
})

async function ensureConfigAlarm(): Promise<void> {
  if (await chrome.alarms.get(CONFIG_ALARM)) return
  await chrome.alarms.create(CONFIG_ALARM, { periodInMinutes: CONFIG_REFRESH_MINUTES })
}

/**
 * Declared content scripts only reach pages loaded after an install or update, so app tabs that are already open get
 * them here. Both scripts guard against running twice; after an update the old page hook is still installed and the
 * new copy skips itself, and the orphaned content script releases that hook so the new one can pair with it.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: SUPPORTED_APP_HOSTS.map((host) => `https://${host}/*`) })
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.discarded) return
      const target = { tabId: tab.id }
      try {
        await chrome.scripting.executeScript({ target, files: ['page-hook.js'], world: 'MAIN', injectImmediately: true })
        await chrome.scripting.executeScript({ target, files: ['content.js'] })
      } catch (e) {
        // An error page, or the tab navigated away meanwhile.
        warn(`could not start the assistant in tab ${tab.id}`)(e)
      }
    }),
  )
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(warn('could not open settings'))
  }
  if (details.reason === 'install' || details.reason === 'update') {
    injectIntoOpenTabs().catch(warn('could not start the assistant in open tabs'))
  }
  ensureConfigAlarm().catch(warn('could not schedule config refresh'))
})

chrome.runtime.onStartup.addListener(() => {
  ensureConfigAlarm().catch(warn('could not schedule config refresh'))
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG_ALARM) refreshConfig().catch(warn('config refresh failed'))
  else if (alarm.name === STT_IDLE_ALARM) handleIdleAlarm().catch(warn('could not release the speech model'))
})

// Keys saved by older versions sit in chrome.storage.local, which content scripts can read; move them out now.
migrateLegacyKeys().catch(warn('could not migrate saved keys'))

// ---------- keeping open tabs in sync ----------

async function pushStatus(config?: FullConfig): Promise<void> {
  const sessions = allSessions()
  if (!sessions.length) return
  const status = await computeStatus(config ?? (await getConfig()))
  for (const s of sessions) s.send(status)
}

try {
  onConfigChanged((config) => {
    const client = toClientConfig(config)
    for (const s of allSessions()) s.send({ type: 'config', config: client })
    pushStatus(config).catch(warn('status update failed'))
  })
} catch (e) {
  warn('config listener failed')(e)
}

// Saving a key or switching provider/model in settings changes readiness without a config change.
let statusTimer: ReturnType<typeof setTimeout> | undefined
function scheduleStatusPush(): void {
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => pushStatus().catch(warn('status update failed')), 300)
}

onKeysChanged(scheduleStatusPush)

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  // With the browser speech engine the offscreen document and its model are dead weight.
  const settings = changes[SETTINGS_KEY]?.newValue as Partial<UserSettings> | undefined
  if (settings?.sttEngine === 'browser') closeOffscreenIfIdle(0).catch(warn('could not release the speech model'))
  scheduleStatusPush()
})
