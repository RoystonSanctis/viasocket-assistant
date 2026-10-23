// Fixed values from the Developer Hub plug skill (SKILL-PLUG-CREATION.md and its dh.mjs tool). The skill is the
// source of truth for how plugs are searched, created, extended, connected, dry-run and published; these constants
// keep the extension's writes identical to what the skill's own tool writes.

/** Knowledge base the skill reads with `node dh.mjs kb`. Fetched as plain text; it is reference data only. */
export const KB_REPO = 'RoystonSanctis/dh-planner-viasocket'
export const KB_REF = 'dev'
export const KB_FILES = [
  'dh-knowledgebase.md',
  'dh-connection-kb.md',
  'dh-connection-practice.md',
  'dh-connection-examples.md',
  'dh-connection-schema.md',
  'dh-Input-fields-json-builder.md',
  'perform-code.md',
  'ux-practice.md',
  'ux-worked-examples.md',
  'dh-review.md',
  'backed-plug-service.md',
  'dh-database-schema.md',
  'viasocket-flow-execution-script.md',
] as const
export type KbFile = (typeof KB_FILES)[number]

export function kbUrl(file: KbFile): string {
  return `https://raw.githubusercontent.com/${KB_REPO}/refs/heads/${KB_REF}/knowledge-base/${file}`
}

/** Metadata labels. Never a model, product or tool name. */
export const CREATED_BY = 'CREATED_BY_SKILL'
export const UPDATED_BY = 'UPDATED_BY_SKILL'
/** The skill names dh.mjs records in aiLogs entries (cfg.skill): one per kind of work (plug / connection / action). */
export const SKILL_NAMES = {
  plug: 'viasocket-developer-hub-plug',
  connection: 'viasocket-developer-hub-connection',
  action: 'viasocket-developer-hub-action',
} as const
export type SkillKind = keyof typeof SKILL_NAMES

/**
 * Model, vendor and tool names the skill forbids in metadata, notes and aiContext ("never write Claude or any model/tool
 * name"). Matched as standalone words only, never inside a URL, host or path, so docs links of such apps survive.
 */
export const MODEL_NAME_RE =
  /(?<![\w./:@-])(?:claude(?:[\s-]?(?:code|opus|sonnet|haiku))?|anthropic|open\s?ai|chat\s?gpt|gpt-?\d[\w.-]*|gpt|gemini|bard|llama\s?\d*|copilot|mistral|deepseek|grok|(?:an?\s+)?(?:ai|language)\s+model|llm)(?![\w./-])/gi

/** plugins columns returned by the plug search (the skill's `&fields=` list for plugins). */
export const PLUGIN_SEARCH_FIELDS = [
  'rowid', 'name', 'domain', 'status', 'audience', 'description', 'category', 'iconurl', 'orgid', 'preferedauthversion',
  'istriggeravailable', 'updatedat',
] as const

/** Column lists from the skill (`&fields=`); used to keep reads small and to never fetch secrets. */
export const ACTION_LIST_FIELDS = [
  'rowid', 'name', 'description', 'key', 'pluginrecordid', 'type', 'authid', 'isvisible', 'category', 'sub_category',
  'preferred_step_name', 'isaiaction', 'aiorgid', 'status', 'actionversionrecordid', 'authidlookup',
] as const
/** Deliberately without clientsecret/clientid/code columns. */
export const AUTH_SUMMARY_FIELDS = [
  'rowid', 'pluginrecordid', 'authversion', 'type', 'granttype', 'description', 'authfields', 'whitelistdomains',
  'connectionlabelkey', 'connectionlabelvalue', 'authrequrl', 'scopeseperatedby', 'queryparams',
] as const
export const COMPONENT_LIST_FIELDS = ['rowid', 'pluginrecordid', 'function_name', 'params', 'description', 'metadata'] as const

/** metadata.aiContext limit from the skill ("≤4 KB, no secrets"). */
export const AI_CONTEXT_MAX_BYTES = 4096
