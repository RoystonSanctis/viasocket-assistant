// Content script injected into the top-level frame of host websites embedding viaSocket.
// Ensures any viaSocket embed iframe receives the permissions policy delegation
// (allow="microphone; clipboard-read; clipboard-write") so that speech recognition,
// audio capture, and clipboard interactions work seamlessly inside the embed.

const PERMISSIONS = 'microphone; clipboard-read; clipboard-write;'

function isViaSocketIframe(el: HTMLIFrameElement): boolean {
  if (el.id === 'viasocket-embed-iframe-component') return true
  const src = el.src || el.getAttribute('src') || ''
  return src.includes('embedfrontend.viasocket.com') || src.includes('dev-embedfrontend.viasocket.com') || src.includes('/integrations/embed')
}

function patchIframe(el: HTMLIFrameElement): void {
  const current = el.getAttribute('allow') || ''
  const needed = ['microphone', 'clipboard-read', 'clipboard-write']
  const missing = needed.filter((f) => !current.includes(f))
  if (missing.length > 0) {
    const updated = (current ? current + '; ' : '') + missing.join('; ')
    el.setAttribute('allow', updated)
    try {
      el.allow = updated
    } catch {
      // ignore
    }
  }
}

function scan(root: Node): void {
  if (root instanceof HTMLIFrameElement) {
    if (isViaSocketIframe(root)) patchIframe(root)
  } else if (root instanceof HTMLElement) {
    const frames = root.querySelectorAll<HTMLIFrameElement>(
      'iframe#viasocket-embed-iframe-component, iframe[src*="embedfrontend.viasocket.com"], iframe[src*="dev-embedfrontend.viasocket.com"]',
    )
    frames.forEach(patchIframe)
  }
}

// Observe DOM insertions
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      scan(node)
    }
    if (m.type === 'attributes' && m.target instanceof HTMLIFrameElement) {
      if (m.attributeName === 'src' || m.attributeName === 'id') {
        if (isViaSocketIframe(m.target)) patchIframe(m.target)
      }
    }
  }
})

// Also hook setAttribute on HTMLIFrameElement prototype so allow is attached before src navigation
try {
  const originalSetAttribute = HTMLIFrameElement.prototype.setAttribute
  HTMLIFrameElement.prototype.setAttribute = function (name: string, value: string): void {
    if (name === 'src' || name === 'id') {
      originalSetAttribute.call(this, name, value)
      if (isViaSocketIframe(this)) patchIframe(this)
      return
    }
    originalSetAttribute.call(this, name, value)
  }
} catch {
  // prototype patch may fail in strict environments
}

if (document.documentElement) {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'id'],
  })
  scan(document.documentElement)
}
