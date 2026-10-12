// Provider section: choose a provider, then save, test or remove its key.
// The key goes straight to the service worker; this page only ever sees its last four characters.

import type { KeyTestResult, ProviderView } from '../shared/messages'
import { byId, errorMessage, h, safeHttpsUrl, setStatus } from './dom'
import { rpc } from './rpc'
import { providerById, refreshState, store, subscribe, updateSettings } from './store'

const list = byId('provider-list', HTMLDivElement)
const detail = byId('provider-detail', HTMLDivElement)
const title = byId('provider-detail-title', HTMLHeadingElement)
const tip = byId('provider-tip', HTMLParagraphElement)
const keyLinkRow = byId('provider-keylink-row', HTMLParagraphElement)
const keyLink = byId('provider-keylink', HTMLAnchorElement)
const missingUrl = byId('provider-missing-url', HTMLParagraphElement)
const keyField = byId('key-field', HTMLDivElement)
const keyLabel = document.querySelector<HTMLLabelElement>('label[for="key-input"]')
const keyInput = byId('key-input', HTMLInputElement)
const keyShow = byId('key-show', HTMLButtonElement)
const keyHint = byId('key-hint', HTMLParagraphElement)
const keySave = byId('key-save', HTMLButtonElement)
const keyTest = byId('key-test', HTMLButtonElement)
const useButton = byId('provider-use', HTMLButtonElement)
const keyRemove = byId('key-remove', HTMLButtonElement)
const result = byId('key-result', HTMLParagraphElement)
const details = byId('key-details', HTMLDListElement)

let selectedId: string | null = null
let cardsSignature = ''
let busy = false

export function initProvider(): void {
  subscribe(render)
  keyShow.addEventListener('click', () => setKeyVisible(keyInput.type === 'password'))
  keyInput.addEventListener('input', renderKeyHint)
  keyInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    // A keydown is a user gesture too, so the permission prompt in onSave still works.
    keySave.click()
  })
  keySave.addEventListener('click', () => void onSave())
  keyTest.addEventListener('click', () => void onTest())
  useButton.addEventListener('click', () => void onUse())
  keyRemove.addEventListener('click', () => void onRemove())
}

function selected(): ProviderView | undefined {
  return selectedId ? providerById(selectedId) : undefined
}

function render(): void {
  const providers = store.state?.providers
  if (!providers) return
  if (!selectedId || !providers.some((p) => p.id === selectedId)) {
    selectedId = (providerById(store.settings.providerId) ?? providers[0])?.id ?? null
  }
  renderCards(providers)
  renderDetail()
}

function renderCards(providers: ProviderView[]): void {
  const activeId = store.settings.providerId
  const signature = JSON.stringify([activeId, providers.map((p) => [p.id, p.name, p.badges, p.hasKey, p.keyLast4, p.noKey])])
  if (signature !== cardsSignature) {
    cardsSignature = signature
    const focused = document.activeElement instanceof HTMLInputElement && list.contains(document.activeElement)
      ? document.activeElement.value
      : null
    list.replaceChildren(...providers.map((p) => card(p, p.id === activeId)))
    if (focused) radioFor(focused)?.focus()
  }
  for (const r of list.querySelectorAll<HTMLInputElement>('input[type="radio"]')) r.checked = r.value === selectedId
}

function radioFor(id: string): HTMLInputElement | undefined {
  return [...list.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === id)
}

function card(p: ProviderView, active: boolean): HTMLLabelElement {
  const input = h('input', { type: 'radio', name: 'provider', value: p.id })
  input.addEventListener('change', () => {
    if (!input.checked) return
    selectedId = p.id
    keyInput.value = ''
    setKeyVisible(false)
    clearResult()
    renderDetail()
  })
  return h(
    'label',
    { class: 'provider-card' },
    input,
    h(
      'span',
      { class: 'provider-main' },
      h('span', { class: 'provider-name' }, p.name),
      ...(p.badges ?? []).map((b) => h('span', { class: 'badge' }, b)),
      active && h('span', { class: 'badge badge-active' }, 'Active'),
    ),
    h('span', { class: 'provider-key' }, keyStatus(p)),
  )
}

function keyStatus(p: ProviderView): string {
  if (p.noKey) return 'No key needed'
  return p.hasKey ? `Key …${p.keyLast4 ?? ''}` : 'No key yet'
}

function originOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null
  try {
    const u = new URL(baseUrl)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

function isConfigured(p: ProviderView): boolean {
  return p.noKey ? p.hasPermission : p.hasKey
}

function renderDetail(): void {
  const p = selected()
  detail.hidden = !p
  if (!p) return
  const isActive = store.settings.providerId === p.id

  title.textContent = `${p.noKey ? 'Connect' : 'Set up'} ${p.name}`
  tip.textContent = p.setupTip ?? ''
  tip.hidden = !p.setupTip

  const link = p.noKey ? null : safeHttpsUrl(p.keyPageUrl)
  keyLinkRow.hidden = !link
  if (link) keyLink.href = link
  keyLink.textContent = `Get a key from ${p.name}`

  const origin = originOf(p.baseUrl)
  missingUrl.hidden = origin !== null
  keyField.hidden = p.noKey
  if (keyLabel) keyLabel.textContent = `${p.name} API key`
  keyInput.placeholder = p.hasKey
    ? `Saved key ends in ${p.keyLast4 ?? '????'}. Paste a new one to replace it.`
    : 'Paste your API key'
  renderKeyHint()

  keySave.textContent = p.noKey ? 'Connect and test' : p.hasKey ? 'Replace and test' : 'Save and test'
  keySave.disabled = busy || origin === null
  keyTest.hidden = !isConfigured(p)
  keyRemove.hidden = p.noKey || !p.hasKey
  useButton.hidden = isActive || !isConfigured(p)
  for (const b of [keyTest, keyRemove, useButton]) b.disabled = busy
  detail.setAttribute('aria-busy', String(busy))
}

function renderKeyHint(): void {
  const p = selected()
  if (!p) return
  const key = keyInput.value.trim()
  if (key && p.keyPattern && !matches(p.keyPattern, key)) {
    setStatus(keyHint, `This doesn't look like a ${p.name} key. Check that you copied all of it.`, 'warn')
    return
  }
  const origin = originOf(p.baseUrl)
  setStatus(keyHint, origin ? `Your key is sent only to ${origin}.` : '', 'info')
}

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return true
  }
}

function setKeyVisible(visible: boolean): void {
  keyInput.type = visible ? 'text' : 'password'
  keyShow.textContent = visible ? 'Hide' : 'Show'
  keyShow.setAttribute('aria-pressed', String(visible))
}

function setBusy(value: boolean): void {
  busy = value
  renderDetail()
}

function clearResult(): void {
  setStatus(result, '')
  details.replaceChildren()
  details.hidden = true
}

/** Asks Chrome for access to the provider's origin. Call it before any other await so the click still counts. */
async function requestAccess(origin: string): Promise<boolean> {
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
    if (!granted) {
      setStatus(result, `The assistant needs permission to contact ${origin}. Press the button again and choose Allow.`, 'error')
    }
    return granted
  } catch (e) {
    setStatus(result, `Chrome won't allow access to ${origin}: ${errorMessage(e)}`, 'error')
    return false
  }
}

async function onSave(): Promise<void> {
  const p = selected()
  if (!p || busy) return
  const key = keyInput.value.trim()
  if (!p.noKey && !key) {
    setStatus(result, p.hasKey ? 'Paste a new key to replace the saved one, or press Test again.' : 'Paste your API key first.', 'warn')
    keyInput.focus()
    return
  }
  const origin = originOf(p.baseUrl)
  if (!origin) return
  // Chrome shows the permission prompt only during the click's user gesture, so this must be the first await.
  if (!(await requestAccess(origin))) return

  clearResult()
  setBusy(true)
  try {
    if (!p.noKey) {
      setStatus(result, 'Saving your key…', 'busy')
      await rpc.saveKey(p.id, key, p.builtIn ? undefined : (p.baseUrl ?? undefined))
      keyInput.value = ''
      setKeyVisible(false)
    }
    await makeActive(p.id)
    await runTest(p.id)
  } catch (e) {
    setStatus(result, errorMessage(e), 'error')
  } finally {
    setBusy(false)
    await refreshState().catch(() => undefined)
  }
}

async function onTest(): Promise<void> {
  const p = selected()
  if (!p || busy) return
  const origin = originOf(p.baseUrl)
  if (origin && !p.hasPermission && !(await requestAccess(origin))) return
  clearResult()
  setBusy(true)
  try {
    await runTest(p.id)
  } catch (e) {
    setStatus(result, errorMessage(e), 'error')
  } finally {
    setBusy(false)
    await refreshState().catch(() => undefined)
  }
}

async function onUse(): Promise<void> {
  const p = selected()
  if (!p || busy) return
  const origin = originOf(p.baseUrl)
  if (origin && !p.hasPermission && !(await requestAccess(origin))) return
  try {
    await makeActive(p.id)
    setStatus(result, `${p.name} is now the active provider. Pick a model below.`, 'ok')
  } catch (e) {
    setStatus(result, errorMessage(e), 'error')
  }
}

async function onRemove(): Promise<void> {
  const p = selected()
  if (!p || busy) return
  if (!confirm(`Remove the saved ${p.name} key from this browser?`)) return
  clearResult()
  setBusy(true)
  try {
    await rpc.removeKey(p.id)
    setStatus(result, `The ${p.name} key was removed.`, 'ok')
  } catch (e) {
    setStatus(result, errorMessage(e), 'error')
  } finally {
    setBusy(false)
    await refreshState().catch(() => undefined)
  }
}

async function makeActive(id: string): Promise<void> {
  if (store.settings.providerId === id) return
  // Model IDs differ between providers, so carrying the old choice over would only fail on the new one.
  await updateSettings({ providerId: id, model: '', fallbackModels: [] })
}

async function runTest(id: string): Promise<void> {
  setStatus(result, 'Testing the connection…', 'busy')
  showTest(await rpc.testKey(id))
}

function showTest(r: KeyTestResult): void {
  setStatus(result, r.message || (r.ok ? 'Connected.' : 'The test failed.'), r.ok ? 'ok' : 'error')
  const entries = Object.entries(r.details ?? {})
  details.replaceChildren(...entries.flatMap(([k, v]) => [h('dt', {}, humanize(k)), h('dd', {}, formatValue(v))]))
  details.hidden = entries.length === 0
}

/** "requestsRemainingToday" / "free_tier" -> "Requests remaining today" / "Free tier" */
function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function formatValue(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return v.toLocaleString()
  return v
}
