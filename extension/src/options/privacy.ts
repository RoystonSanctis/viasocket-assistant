// Privacy notice acknowledgement. The banner at the top stays until the user has read and ticked the notice.

import { byId } from './dom'
import { store, subscribe, updateSettings } from './store'

const ack = byId('privacy-ack', HTMLInputElement)
const banner = byId('privacy-banner', HTMLDivElement)

export function initPrivacy(): void {
  subscribe(render)
  ack.addEventListener('change', () => void updateSettings({ privacyAcknowledged: ack.checked }))
}

function render(): void {
  ack.checked = store.settings.privacyAcknowledged
  banner.hidden = store.settings.privacyAcknowledged
}
