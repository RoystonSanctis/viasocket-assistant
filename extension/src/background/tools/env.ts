// viaSocket environments, keyed by the UI hostname. The UI ships one build per environment with fixed values,
// so the hostname (not which cookie happens to exist) decides everything. Both the 'prod' and 'testing'
// cookies live on .viasocket.com, which is why the cookie name must come from this table.

export interface ViaSocketEnv {
  name: 'prod' | 'testing' | 'local'
  /** Cookie holding the raw proxy_auth_token (named after VITE_API_ENVIRONMENT) */
  cookieName: string
  /** URL used to read the cookie with chrome.cookies */
  cookieUrl: string
  apiBase: string
  vmBase: string
  authBase: string
  /** True on hosts where the UI renders beta-gated features (anything but flow.viasocket.com) */
  betaUi: boolean
}

const PROD = {
  name: 'prod',
  cookieName: 'prod',
  apiBase: 'https://flow-api.viasocket.com',
  vmBase: 'https://flow.sokt.io',
  authBase: 'https://auth.viasocket.com',
} as const

const TESTING = {
  name: 'testing',
  cookieName: 'testing',
  apiBase: 'https://dev-api.viasocket.com',
  vmBase: 'https://dev.sokt.io',
  authBase: 'https://dev-auth.viasocket.com',
} as const

const HOSTS: Record<string, ViaSocketEnv> = {
  'flow.viasocket.com': { ...PROD, cookieUrl: 'https://flow.viasocket.com/', betaUi: false },
  'beta-flow.viasocket.com': { ...PROD, cookieUrl: 'https://beta-flow.viasocket.com/', betaUi: true },
  'dev-flow.viasocket.com': { ...TESTING, cookieUrl: 'https://dev-flow.viasocket.com/', betaUi: true },
}

/**
 * Returns the environment for an app host, or null for hosts the assistant must not run on
 * (marketing site, embedfrontend which uses an embed token, auth popups, unknown hosts).
 */
export function resolveEnv(host: string): ViaSocketEnv | null {
  return HOSTS[host.toLowerCase()] ?? null
}

export const SUPPORTED_APP_HOSTS = Object.keys(HOSTS)
