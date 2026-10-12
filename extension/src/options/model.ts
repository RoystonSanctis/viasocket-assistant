// Model section: list the active provider's models, pick one, and for OpenRouter up to three fallbacks.

import type { ModelInfo } from '../background/llm/types'
import { byId, errorMessage, h, setStatus } from './dom'
import { rpc } from './rpc'
import { activeProvider, store, subscribe, updateSettings } from './store'

const MAX_FALLBACKS = 3
const MODEL_ID = /^[\w.:/@+-]{1,200}$/

const providerName = byId('model-provider-name', HTMLElement)
const current = byId('model-current', HTMLElement)
const loadButton = byId('models-load', HTMLButtonElement)
const picker = byId('model-picker', HTMLDivElement)
const filter = byId('model-filter', HTMLInputElement)
const showAll = byId('models-show-all', HTMLInputElement)
const select = byId('model-select', HTMLSelectElement)
const count = byId('model-count', HTMLParagraphElement)
const custom = byId('model-custom', HTMLInputElement)
const customSave = byId('model-custom-save', HTMLButtonElement)
const status = byId('model-status', HTMLParagraphElement)
const fallbackGroup = byId('fallback-group', HTMLDivElement)
const fallbackSelects = [1, 2, 3].map((n) => byId(`fallback-${n}`, HTMLSelectElement))
const fallbackStatus = byId('fallback-status', HTMLParagraphElement)

let models: ModelInfo[] | null = null
let shownProvider: string | null = null
let loading = false
let fallbackSignature = ''

export function initModel(): void {
  subscribe(render)
  loadButton.addEventListener('click', () => void load())
  filter.addEventListener('input', renderList)
  showAll.addEventListener('change', () => {
    renderList()
    renderFallbacks()
  })
  select.addEventListener('change', () => void choose(select.value))
  customSave.addEventListener('click', () => void chooseCustom())
  custom.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void chooseCustom()
  })
  for (const s of fallbackSelects) s.addEventListener('change', () => void saveFallbacks())
}

function render(): void {
  const providerId = store.settings.providerId
  if (providerId !== shownProvider) {
    shownProvider = providerId
    models = null
    picker.hidden = true
    select.replaceChildren()
    filter.value = ''
    fallbackSignature = ''
    setStatus(status, '')
  }
  const p = activeProvider()
  providerName.textContent = p?.name ?? providerId
  // With no model saved the agent falls back to the provider's first recommended model, or refuses to run.
  const fallback = p?.recommendedModels[0]
  current.textContent = store.settings.model || (fallback ? `automatic (${fallback})` : 'none selected (load models and pick one)')

  const ready = !!p && (p.noKey ? p.hasPermission : p.hasKey)
  loadButton.disabled = loading || !ready
  loadButton.textContent = models ? 'Reload models' : 'Load models'
  if (!ready && !loading && store.state) {
    setStatus(status, p ? `Save a ${p.name} key above to load its models.` : 'Choose a provider above first.', 'info')
  } else if (ready && status.dataset.tone === 'info') {
    setStatus(status, '')
  }
  select.value = store.settings.model
  fallbackGroup.hidden = providerId !== 'openrouter'
  renderFallbacks()
}

async function load(): Promise<void> {
  const providerId = store.settings.providerId
  loading = true
  render()
  setStatus(status, 'Loading models…', 'busy')
  try {
    const list = await rpc.listModels(providerId)
    if (store.settings.providerId !== providerId) return
    models = list
    picker.hidden = false
    if (list.length) setStatus(status, '')
    else setStatus(status, 'This provider returned no models. You can enter a model ID by hand.', 'warn')
    renderList()
  } catch (e) {
    setStatus(status, errorMessage(e), 'error')
  } finally {
    loading = false
    render()
  }
}

function label(m: ModelInfo): string {
  const name = m.name ?? m.id
  const parts = [name]
  if (m.free && !/\bfree\b/i.test(name)) parts.push('free')
  if (m.supportsTools === true) parts.push('tools')
  else if (m.supportsTools === false) parts.push('no tools')
  return parts.join(' · ')
}

function option(m: ModelInfo): HTMLOptionElement {
  return h('option', { value: m.id, title: m.id }, label(m))
}

function usable(m: ModelInfo): boolean {
  // Unknown tool support stays visible; only models known to lack it are hidden.
  return showAll.checked || m.supportsTools !== false
}

/** Recommended models first (in the provider's order), then the rest alphabetically. */
function ordered(list: ModelInfo[]): { recommended: ModelInfo[]; rest: ModelInfo[] } {
  const ids = activeProvider()?.recommendedModels ?? []
  const byId = new Map(list.map((m) => [m.id, m]))
  const recommended = ids.map((id) => byId.get(id)).filter((m): m is ModelInfo => m !== undefined)
  const picked = new Set(recommended.map((m) => m.id))
  const rest = list.filter((m) => !picked.has(m.id)).sort((a, b) => label(a).localeCompare(label(b)))
  return { recommended, rest }
}

function renderList(): void {
  if (!models) return
  const query = filter.value.trim().toLowerCase()
  const visible = models.filter((m) => usable(m) && (!query || `${m.id} ${label(m)}`.toLowerCase().includes(query)))
  const { recommended, rest } = ordered(visible)
  if (recommended.length) {
    select.replaceChildren(
      h('optgroup', { label: 'Recommended' }, ...recommended.map(option)),
      ...(rest.length ? [h('optgroup', { label: 'All models' }, ...rest.map(option))] : []),
    )
  } else {
    select.replaceChildren(...rest.map(option))
  }
  select.value = store.settings.model

  const hidden = showAll.checked ? 0 : models.filter((m) => m.supportsTools === false).length
  count.textContent =
    `Showing ${visible.length} of ${models.length} models` +
    (hidden ? `, with ${hidden} that can't use tools hidden.` : '.')
}

async function choose(id: string): Promise<void> {
  if (!id || id === store.settings.model) return
  try {
    await updateSettings({ model: id, fallbackModels: store.settings.fallbackModels.filter((f) => f !== id) })
    const m = models?.find((x) => x.id === id)
    const name = m ? (m.name ?? m.id) : id
    if (m?.supportsTools === false) {
      setStatus(status, `Saved, but ${name} can't use tools, so the assistant won't be able to change your flows with it.`, 'warn')
    } else {
      setStatus(status, `Saved. The assistant will use ${name}.`, 'ok')
    }
  } catch (e) {
    setStatus(status, errorMessage(e), 'error')
  }
}

async function chooseCustom(): Promise<void> {
  const id = custom.value.trim()
  if (!MODEL_ID.test(id)) {
    setStatus(status, 'Enter a model ID without spaces, for example openai/gpt-4o-mini.', 'warn')
    custom.focus()
    return
  }
  await choose(id)
  custom.value = ''
}

function renderFallbacks(): void {
  if (fallbackGroup.hidden) return
  const chosen = store.settings.fallbackModels
  const pool = models ? ordered(models.filter(usable)) : { recommended: [], rest: [] }
  const poolList = [...pool.recommended, ...pool.rest]
  const signature = JSON.stringify([chosen, poolList.map((m) => m.id)])
  if (signature === fallbackSignature) return
  fallbackSignature = signature

  const poolIds = new Set(poolList.map((m) => m.id))
  fallbackSelects.forEach((sel, i) => {
    const value = chosen[i] ?? ''
    const opts: HTMLOptionElement[] = [h('option', { value: '' }, 'None')]
    if (value && !poolIds.has(value)) opts.push(h('option', { value }, value))
    for (const m of poolList) opts.push(option(m))
    sel.replaceChildren(...opts)
    sel.value = value
  })
  if (!models) setStatus(fallbackStatus, 'Load models above to choose fallbacks.', 'info')
  else if (fallbackStatus.dataset.tone === 'info') setStatus(fallbackStatus, '')
}

async function saveFallbacks(): Promise<void> {
  const picked = fallbackSelects.map((s) => s.value).filter(Boolean)
  const unique = [...new Set(picked)].filter((id) => id !== store.settings.model).slice(0, MAX_FALLBACKS)
  try {
    await updateSettings({ fallbackModels: unique })
    setStatus(
      fallbackStatus,
      unique.length ? `Saved ${unique.length} fallback model${unique.length === 1 ? '' : 's'}.` : 'No fallback models.',
      'ok',
    )
  } catch (e) {
    setStatus(fallbackStatus, errorMessage(e), 'error')
  }
}
