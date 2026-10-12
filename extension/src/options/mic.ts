// Microphone permission. The offscreen recorder cannot show Chrome's permission prompt, so access is granted to the
// extension's origin here, from a visible page and a real click.

import { byId, openBrowserPage, setStatus } from './dom'

type MicState = PermissionState | 'unknown'

const LABELS: Record<MicState, string> = {
  granted: 'Allowed',
  denied: 'Blocked',
  prompt: 'Not allowed yet',
  unknown: 'Unknown',
}

const status = byId('mic-status', HTMLElement)
const allow = byId('mic-allow', HTMLButtonElement)
const help = byId('mic-help', HTMLDivElement)
const settingsButton = byId('mic-settings', HTMLButtonElement)
const result = byId('mic-result', HTMLParagraphElement)

export function initMic(): void {
  allow.addEventListener('click', () => void onAllow())
  settingsButton.addEventListener('click', () =>
    openBrowserPage(`chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`),
  )
  void watchPermission()
}

function show(state: MicState): void {
  status.textContent = LABELS[state]
  help.hidden = state !== 'denied'
  allow.textContent = state === 'granted' ? 'Test microphone' : 'Allow microphone'
}

async function watchPermission(): Promise<void> {
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    show(perm.state)
    perm.addEventListener('change', () => show(perm.state))
  } catch {
    show('unknown')
  }
}

async function onAllow(): Promise<void> {
  setStatus(result, "Answer Chrome's prompt to allow the microphone…", 'busy')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const t of stream.getTracks()) t.stop()
    show('granted')
    setStatus(result, 'The microphone works. You can talk to the assistant now.', 'ok')
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    const message = e instanceof Error ? e.message : ''
    if ((name === 'NotAllowedError' || name === 'SecurityError') && /system/i.test(message)) {
      setStatus(result, 'Your operating system is blocking Chrome from using the microphone. Allow Chrome in your system privacy settings, then try again.', 'error')
    } else if (name === 'NotAllowedError' || name === 'SecurityError') {
      show('denied')
      setStatus(result, 'Chrome blocked the microphone for this extension.', 'error')
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      setStatus(result, 'No microphone was found. Connect one and try again.', 'error')
    } else if (name === 'NotReadableError') {
      setStatus(result, 'The microphone is in use by another app or blocked by your system.', 'error')
    } else {
      setStatus(result, message || "Couldn't open the microphone.", 'error')
    }
  }
}
