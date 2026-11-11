// Validates this config repo before it reaches users: node scripts/validate.mjs
// Errors fail the run (exit code 1). Warnings are printed but never fail it.
//
// The extension validates everything again with its own zod schemas and keeps the last good config when a
// file is invalid, so this script is the early, friendlier gate rather than the only one.

import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MAX_PROMPT_BYTES = 64 * 1024
const PROMPT_PLACEHOLDERS = new Set(['orgId', 'projectId', 'scriptId', 'pluginId', 'page', 'date', 'proactivity'])
const CONFIG_VERSION_STYLE = /^\d{4}\.\d{2}\.\d{2}-\d+$/

// Tool names implemented by the extension. Keep in sync with the extension's tool registry.
const KNOWN_TOOLS = new Set([
  'ui_open_step', 'ui_close_panel', 'ui_highlight', 'ui_suggest', 'ui_refresh_page', 'ui_navigate', 'ui_plan',
  'vs_list_projects', 'vs_list_flows', 'vs_create_flow', 'vs_get_flow', 'vs_get_step', 'vs_get_variables',
  'vs_search_apps', 'vs_list_app_actions', 'vs_list_builtin_tools', 'vs_list_ai_agents', 'vs_get_action',
  'vs_get_field_options', 'vs_list_connections', 'vs_connect_app', 'vs_add_step', 'vs_update_step',
  'vs_set_response', 'vs_delete_step', 'vs_move_step', 'vs_set_trigger', 'vs_test_trigger', 'vs_set_get_data',
  'vs_set_trigger_loop', 'vs_set_run_condition', 'vs_test_step', 'vs_test_flow', 'vs_get_recent_run',
  'vs_publish_flow', 'vs_discard_changes', 'vs_rename_flow',
  'dh_search_plugins', 'dh_get_plugin', 'dh_create_plugin', 'dh_brand_details', 'dh_update_plugin',
  'dh_publish_plugin', 'dh_kb', 'dh_list_auth_versions', 'dh_create_connection', 'dh_update_auth_version',
  'dh_check_connection', 'dh_connect', 'dh_list_actions', 'dh_get_action_version', 'dh_list_components',
  'dh_create_action', 'dh_new_action_version', 'dh_update_action_version', 'dh_create_component',
  'dh_map_component', 'dh_dry_run', 'dh_publish_action_version',
])

// Providers whose base URL is compiled into the extension. For these, a baseUrl in providers.json is ignored.
const BUILT_IN_PROVIDERS = new Set([
  'openrouter', 'groq', 'gemini', 'mistral', 'openai', 'anthropic', 'deepseek', 'ollama', 'lmstudio',
])

// The repo is public. Catch pasted keys and references to private material before they are pushed.
const LEAK_PATTERNS = [
  { re: /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{24,}/, what: 'what looks like an API key' },
  { re: /\bgsk_[A-Za-z0-9]{20,}/, what: 'what looks like a Groq API key' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'what looks like a Google API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\/, what: 'a local file path' },
  { re: /internal-notes|Citations:\s*\//, what: 'a reference to private notes' },
]

const errors = []
const warnings = []
const error = (file, msg) => errors.push(`${file}: ${msg}`)
const warn = (file, msg) => warnings.push(`${file}: ${msg}`)

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)

async function compileSchema(name) {
  const schema = JSON.parse(await readFile(join(root, 'schemas', `${name}.schema.json`), 'utf8'))
  return ajv.compile(schema)
}

function isSafeRelPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('..') && !p.includes('\\') && !p.includes('://')
}

/** Reads a repo-relative file, refusing anything that would escape the repo. Returns null (and records an error) on failure. */
async function readRepoText(rel, owner) {
  if (!isSafeRelPath(rel)) {
    error(owner, `"${rel}" must be a relative path inside the repo (no leading "/", "..", "\\" or URL)`)
    return null
  }
  const abs = resolve(root, rel)
  if (!abs.startsWith(root + sep)) {
    error(owner, `"${rel}" points outside the repo`)
    return null
  }
  try {
    return await readFile(abs, 'utf8')
  } catch {
    error(owner, `references "${rel}", which does not exist`)
    return null
  }
}

function scanForLeaks(file, text) {
  for (const { re, what } of LEAK_PATTERNS) {
    if (re.test(text)) error(file, `contains ${what}; remove it before publishing`)
  }
}

function parseJson(file, text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    error(file, `is not valid JSON (${e.message})`)
    return undefined
  }
}

function reportSchemaErrors(file, validateFn) {
  for (const e of validateFn.errors ?? []) {
    const where = e.instancePath || '(root)'
    let extra = ''
    if (e.params && 'additionalProperty' in e.params) extra = `: "${e.params.additionalProperty}"`
    else if (e.params && 'allowedValues' in e.params) extra = `: ${JSON.stringify(e.params.allowedValues)}`
    else if (e.params && 'propertyName' in e.params) extra = `: "${e.params.propertyName}"`
    error(file, `${where} ${e.message}${extra}`)
  }
}

/** CSS selectors can't be parsed without a DOM here, so catch the common breakages: unbalanced brackets and stray braces. */
function selectorProblem(sel) {
  const closers = []
  let quote = null
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[') closers.push(']')
    else if (c === '(') closers.push(')')
    else if (c === ']' || c === ')') {
      if (closers.pop() !== c) return `unbalanced "${c}"`
    } else if (c === '{' || c === '}') return 'braces are only allowed inside quotes for the {slugName} template'
  }
  if (quote) return 'unclosed quote'
  if (closers.length) return `missing "${closers[closers.length - 1]}"`
  for (const m of sel.matchAll(/\{([^}]*)\}/g)) {
    if (m[1] !== 'slugName') return `unknown template "{${m[1]}}" (only {slugName} is supported)`
  }
  return null
}

function checkProviders(file, data) {
  const seen = new Set()
  for (const p of data.providers) {
    if (seen.has(p.id)) error(file, `provider id "${p.id}" is used more than once`)
    seen.add(p.id)
    if (p.keyPattern !== undefined) {
      try {
        new RegExp(p.keyPattern)
      } catch (e) {
        error(file, `provider "${p.id}" keyPattern is not a valid regular expression (${e.message})`)
      }
    }
    if (BUILT_IN_PROVIDERS.has(p.id) && p.baseUrl) {
      warn(file, `provider "${p.id}" is built in, so its baseUrl is ignored (the address compiled into the extension is used)`)
    }
    if (!BUILT_IN_PROVIDERS.has(p.id) && !p.baseUrl) {
      warn(file, `provider "${p.id}" is not built in and has no baseUrl; users will have to enter the address themselves`)
    }
    if (p.noKey && p.keyPattern) warn(file, `provider "${p.id}" has noKey and a keyPattern; the pattern is never used`)
  }
}

function checkSelectors(file, data) {
  for (const host of data.appHosts) {
    if (!host.endsWith('.viasocket.com')) warn(file, `appHosts "${host}" is not a viasocket.com host; the extension only runs on viasocket.com`)
  }
  const all = [
    ...Object.entries(data.flow).map(([k, v]) => [`flow.${k}`, v]),
    ...Object.entries(data.devHub).map(([k, v]) => [`devHub.${k}`, v]),
    ...data.fieldLabel.containers.map((v, i) => [`fieldLabel.containers[${i}]`, v]),
    ...data.fieldLabel.labels.map((v, i) => [`fieldLabel.labels[${i}]`, v]),
    ...data.avoid.map((v, i) => [`avoid[${i}]`, v]),
  ]
  for (const [where, sel] of all) {
    const problem = selectorProblem(sel)
    if (problem) error(file, `${where} ${problem}: ${sel}`)
  }
  const flowKeys = new Set(Object.keys(data.flow))
  for (const k of Object.keys(data.devHub)) {
    if (flowKeys.has(k)) warn(file, `"${k}" exists in both flow and devHub; highlights by key may pick either`)
  }
}

function checkMascot(file, data, selectors) {
  const selectorKeys = selectors ? new Set([...Object.keys(selectors.flow), ...Object.keys(selectors.devHub)]) : null
  const seen = new Set()
  data.reactions.forEach((r, i) => {
    if (r.highlight && r.highlight !== 'step' && selectorKeys && !selectorKeys.has(r.highlight)) {
      error(file, `reactions[${i}] highlights "${r.highlight}", which is neither "step" nor a key in selectors.json`)
    }
    const signature = JSON.stringify([r.on, r.when?.ok, r.when?.byAssistant])
    if (seen.has(signature)) warn(file, `reactions[${i}] repeats the "${r.on}" condition of an earlier reaction`)
    seen.add(signature)
  })
  const [min, max] = data.roam.restSeconds ?? [0, 0]
  if (min > max) error(file, `roam.restSeconds must be [min, max] (got [${min}, ${max}])`)
}

function checkFlags(file, data) {
  for (const name of data.alwaysConfirm ?? []) {
    if (!KNOWN_TOOLS.has(name)) warn(file, `alwaysConfirm lists "${name}", which is not a known tool`)
  }
}

function checkTools(file, data) {
  const listed = new Set(Object.keys(data.tools))
  for (const name of listed) {
    if (!KNOWN_TOOLS.has(name)) warn(file, `"${name}" is not a known tool; the extension will ignore it`)
  }
  for (const name of KNOWN_TOOLS) {
    if (!listed.has(name)) warn(file, `"${name}" is not listed (it stays enabled with its built-in description)`)
  }
}

function checkVoice(file, data) {
  const ids = data.stt.models.map((m) => m.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) error(file, `stt model "${dup}" is listed more than once`)
  if (!ids.includes(data.stt.defaultModel)) error(file, `stt.defaultModel "${data.stt.defaultModel}" is not one of stt.models`)
}

function checkPrompt(file, text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (!text.trim()) error(file, 'is empty')
  if (bytes >= MAX_PROMPT_BYTES) error(file, `is ${bytes} bytes; prompts must stay under ${MAX_PROMPT_BYTES} bytes`)
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!PROMPT_PLACEHOLDERS.has(m[1])) warn(file, `unknown placeholder {{${m[1]}}} will be sent as-is`)
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean)

/** Warns when config files changed but configVersion did not: clients only notice a new configVersion. */
function checkVersionBump(manifest, referencedFiles) {
  const files = ['manifest.json', ...referencedFiles]
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('not a work tree')
    git(['rev-parse', '--verify', 'HEAD'])
  } catch {
    return 'skipped configVersion check (no git history)'
  }

  let base
  let changed = [
    ...lines(git(['diff', '--name-only', '--relative', 'HEAD', '--', ...files])),
    ...lines(git(['ls-files', '--others', '--exclude-standard', '--', ...files])),
  ]
  if (changed.length) {
    base = 'HEAD'
  } else {
    try {
      git(['rev-parse', '--verify', 'HEAD~1'])
    } catch {
      return 'skipped configVersion check (first commit)'
    }
    base = 'HEAD~1'
    changed = lines(git(['diff', '--name-only', '--relative', 'HEAD~1', 'HEAD', '--', ...files]))
  }
  if (!changed.length) return `configVersion check: no config changes since ${base}`

  let previous
  try {
    previous = JSON.parse(git(['show', `${base}:./manifest.json`])).configVersion
  } catch {
    return `skipped configVersion check (no manifest.json in ${base})`
  }
  if (previous === manifest.configVersion) {
    warn('manifest.json', `configVersion is still "${previous}" but ${changed.join(', ')} changed since ${base}; bump it so clients pick up the change`)
  }
  return `configVersion check against ${base}: ${previous} -> ${manifest.configVersion}`
}

async function main() {
  const validators = {}
  for (const name of ['manifest', 'providers', 'selectors', 'mascot', 'flags', 'tools', 'voice']) {
    validators[name] = await compileSchema(name)
  }

  const manifestText = await readRepoText('manifest.json', 'manifest.json')
  if (manifestText === null) return finish()
  scanForLeaks('manifest.json', manifestText)
  const manifest = parseJson('manifest.json', manifestText)
  if (manifest === undefined) return finish()
  if (!validators.manifest(manifest)) {
    reportSchemaErrors('manifest.json', validators.manifest)
    return finish()
  }
  if (!CONFIG_VERSION_STYLE.test(manifest.configVersion)) {
    warn('manifest.json', `configVersion "${manifest.configVersion}" does not follow the YYYY.MM.DD-N convention`)
  }

  const data = {}
  const referenced = []
  for (const key of ['providers', 'selectors', 'mascot', 'flags', 'tools', 'voice']) {
    const rel = manifest.files[key]
    referenced.push(rel)
    const text = await readRepoText(rel, `manifest.json files.${key}`)
    if (text === null) continue
    scanForLeaks(rel, text)
    const json = parseJson(rel, text)
    if (json === undefined) continue
    if (validators[key](json)) data[key] = json
    else reportSchemaErrors(rel, validators[key])
  }

  for (const [key, rel] of Object.entries(manifest.files.prompts)) {
    referenced.push(rel)
    if (!rel.endsWith('.md')) warn(`manifest.json files.prompts.${key}`, `"${rel}" is not a .md file`)
    const text = await readRepoText(rel, `manifest.json files.prompts.${key}`)
    if (text === null) continue
    scanForLeaks(rel, text)
    checkPrompt(rel, text)
  }

  const dupPath = referenced.find((p, i) => referenced.indexOf(p) !== i)
  if (dupPath) warn('manifest.json', `"${dupPath}" is referenced more than once`)

  if (data.providers) checkProviders(manifest.files.providers, data.providers)
  if (data.selectors) checkSelectors(manifest.files.selectors, data.selectors)
  if (data.mascot) checkMascot(manifest.files.mascot, data.mascot, data.selectors)
  if (data.flags) checkFlags(manifest.files.flags, data.flags)
  if (data.tools) checkTools(manifest.files.tools, data.tools)
  if (data.voice) checkVoice(manifest.files.voice, data.voice)

  let versionNote
  try {
    versionNote = checkVersionBump(manifest, referenced)
  } catch (e) {
    versionNote = `skipped configVersion check (${e.message})`
  }
  return finish(manifest.configVersion, versionNote)
}

function finish(configVersion, note) {
  for (const w of warnings) console.warn(`WARN   ${w}`)
  for (const e of errors) console.error(`ERROR  ${e}`)
  if (note) console.log(note)
  const summary = `${errors.length} error(s), ${warnings.length} warning(s)`
  if (errors.length) {
    console.error(`Config is NOT valid: ${summary}`)
    process.exitCode = 1
  } else {
    console.log(`Config ${configVersion ?? ''} is valid: ${summary}`.replace('  ', ' '))
  }
}

await main()
