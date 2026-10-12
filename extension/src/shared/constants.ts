// Build-time constants.

declare const __EXT_VERSION__: string
export const EXT_VERSION: string = typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0'

export const REPO_URL = 'https://github.com/RoystonSanctis/viasocket-assistant'

/**
 * Raw base of the public repo. The live config is published (by the "Config" GitHub Action) from the repo's
 * config/ folder to one branch per channel, with the files at the branch root:
 *   `${CONFIG_REMOTE_BASE}/${CONFIG_BRANCH_PREFIX}${channel}/manifest.json`   e.g. …/config-stable/manifest.json
 * An empty string disables remote config (the bundled copy in dist/defaults is used).
 */
export const CONFIG_REMOTE_BASE = 'https://raw.githubusercontent.com/RoystonSanctis/viasocket-assistant'
export const CONFIG_BRANCH_PREFIX = 'config-'

/** How often the service worker re-checks the remote config (chrome.alarms minimum is 0.5) */
export const CONFIG_REFRESH_MINUTES = 10
