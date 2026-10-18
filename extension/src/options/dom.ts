// Small DOM helpers. Dynamic text always goes through text nodes; nothing here parses HTML.

type Attrs = Record<string, string | number | boolean | null | undefined>
export type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    el.setAttribute(name, value === true ? '' : String(value))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

function createFallbackElement<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  let tag = 'div'
  const name = (type as Function).name || ''
  if (name === 'HTMLInputElement') tag = 'input'
  else if (name === 'HTMLButtonElement') tag = 'button'
  else if (name === 'HTMLSelectElement') tag = 'select'
  else if (name === 'HTMLParagraphElement') tag = 'p'
  else if (name === 'HTMLSpanElement') tag = 'span'
  else if (name === 'HTMLTextAreaElement') tag = 'textarea'
  else if (name === 'HTMLAnchorElement') tag = 'a'
  else if (name === 'HTMLAudioElement') tag = 'audio'
  else if (name === 'HTMLProgressElement') tag = 'progress'
  else if (name === 'HTMLDListElement') tag = 'dl'

  const el = document.createElement(tag)
  el.id = id
  return el as unknown as T
}

export function byId<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const el = document.getElementById(id)
  if (el) {
    if (el instanceof type) return el
    return el as unknown as T
  }
  console.warn(`[viaSocket Assistant] options.html element #${id} not found; using fallback stub.`)
  return createFallbackElement(id, type)
}

export function radios(name: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)]
}

export function checkedValue(name: string): string | undefined {
  return radios(name).find((r) => r.checked)?.value
}

export function setChecked(name: string, value: string): void {
  for (const r of radios(name)) r.checked = r.value === value
}

export type Tone = 'info' | 'ok' | 'warn' | 'error' | 'busy'

export function setStatus(el: HTMLElement, text: string, tone: Tone = 'info'): void {
  el.textContent = text
  el.dataset.tone = tone
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  return typeof e === 'string' && e ? e : 'Something went wrong.'
}

/** Accepts only absolute https URLs, for links whose address comes from the remote config. */
export function safeHttpsUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Opens a chrome:// page, which plain links cannot navigate to from an extension page. */
export function openBrowserPage(url: string): void {
  chrome.tabs.create({ url }).catch(() => undefined)
}

export function isMac(): boolean {
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /mac/i.test(uaPlatform || navigator.platform)
}

export function isWindows(): boolean {
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /win/i.test(uaPlatform || navigator.platform)
}
