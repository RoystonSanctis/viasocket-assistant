// Validates the config repo (../config, or the path given as the first argument) against the extension's own
// zod schemas, plus the cross-references the schemas cannot express: tool names, selector keys, models.
// The TypeScript sources are bundled in memory with esbuild and imported from a data: URL, so nothing is written.
//
//   node scripts/check-config.mjs [path/to/config]
import { build } from 'esbuild'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configDir = resolve(process.argv[2] ?? join(root, '..', 'config'))

const entry = `
export * from './src/shared/config.ts'
export { ALL_TOOLS } from './src/background/tools/index.ts'
export { BUILT_IN_BASE_URLS } from './src/background/llm/registry.ts'
`

const out = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'check-config-entry.js', loader: 'js' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'error',
  define: { __EXT_VERSION__: '"0.0.0"' },
})

// Background modules register chrome listeners at import time; a stub keeps them inert under Node.
const noop = () => undefined
const event = { addListener: noop, removeListener: noop }
globalThis.chrome = {
  runtime: { id: 'check', getURL: (p) => `chrome-extension://check/${p}`, onMessage: event, onConnect: event },
  storage: { onChanged: event, local: { get: async () => ({}), set: async () => undefined }, session: { get: async () => ({}), set: async () => undefined } },
}

const code = out.outputFiles[0].text
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const errors = []
const warnings = []
const fail = (msg) => errors.push(msg)

async function readText(rel) {
  const p = join(configDir, rel)
  await stat(p)
  return readFile(p, 'utf8')
}

function parse(schema, value, what) {
  const r = schema.safeParse(value)
  if (!r.success) {
    for (const i of r.error.issues.slice(0, 10)) fail(`${what}: ${i.path.join('.') || '(root)'}: ${i.message}`)
    return null
  }
  return r.data
}

async function json(rel, schema) {
  try {
    return parse(schema, JSON.parse(await readText(rel)), rel)
  } catch (e) {
    fail(`${rel}: ${e.message}`)
    return null
  }
}

const manifest = await json('manifest.json', mod.configManifestSchema)
if (!manifest) {
  console.error(errors.join('\n'))
  process.exit(1)
}

const f = manifest.files
const providers = await json(f.providers, mod.providersFileSchema)
const selectors = await json(f.selectors, mod.selectorsFileSchema)
const mascot = await json(f.mascot, mod.mascotFileSchema)
const flags = await json(f.flags, mod.flagsFileSchema)
const tools = await json(f.tools, mod.toolsFileSchema)
const voice = await json(f.voice, mod.voiceFileSchema)

for (const [name, rel] of Object.entries(f.prompts)) {
  try {
    const text = await readText(rel)
    if (!text.trim()) fail(`prompt ${name} (${rel}) is empty`)
    if (Buffer.byteLength(text) > 64 * 1024) fail(`prompt ${name} (${rel}) is over 64 KB; the loader would reject it`)
    const placeholders = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    const known = new Set(['date', 'page', 'orgId', 'projectId', 'scriptId', 'pluginId', 'proactivity'])
    for (const p of placeholders) if (!known.has(p)) warnings.push(`prompt ${name} uses unknown placeholder {{${p}}}`)
    if (name !== 'system' && placeholders.length) warnings.push(`prompt ${name} uses placeholders; only system.md is substituted`)
  } catch (e) {
    fail(`prompt ${name}: ${e.message}`)
  }
}

const toolNames = new Set(mod.ALL_TOOLS.map((t) => t.name))
if (tools) {
  for (const name of Object.keys(tools.tools)) if (!toolNames.has(name)) fail(`tools.json names unknown tool ${name}`)
  for (const name of toolNames) if (!(name in tools.tools)) warnings.push(`tools.json does not list ${name} (it stays enabled)`)
}
if (flags) {
  for (const name of flags.alwaysConfirm) if (!toolNames.has(name)) fail(`flags.alwaysConfirm names unknown tool ${name}`)
}

// OpenAI rejects the whole request when any function description is longer than this, so every page that offers
// the tool would stop working there. Checked after tools.json overrides, which replace the built-in wording.
const MAX_TOOL_DESCRIPTION = 1024
for (const t of mod.ALL_TOOLS) {
  const description = tools?.tools[t.name]?.description || t.description
  if (description.length > MAX_TOOL_DESCRIPTION) {
    fail(`tool ${t.name} description is ${description.length} characters; the limit is ${MAX_TOOL_DESCRIPTION}`)
  }
}

const REQUIRED_SELECTORS = {
  flow: ['canvasViewport', 'zoomContainer', 'stepNode', 'triggerNode', 'stepPanel', 'stepSave', 'stepTest', 'publishButton',
    'discardButton', 'controls', 'askAiButton', 'zoomFitButton', 'navbar'],
  devHub: ['section', 'saveButton', 'dryRunButton', 'sidebar'],
}
if (selectors) {
  for (const [group, keys] of Object.entries(REQUIRED_SELECTORS)) {
    for (const k of keys) if (!selectors[group][k]) fail(`selectors.${group}.${k} is missing`)
  }
  if (!selectors.flow.stepNode?.includes('{slugName}')) fail('selectors.flow.stepNode must contain {slugName}')
  const elementKeys = new Set([...Object.keys(selectors.flow), ...Object.keys(selectors.devHub)])
  const highlight = mod.ALL_TOOLS.find((t) => t.name === 'ui_highlight')
  for (const k of highlight?.parameters?.properties?.element?.enum ?? []) {
    if (!elementKeys.has(k)) fail(`ui_highlight offers element "${k}" but selectors.json has no such key`)
  }
  if (mascot) {
    for (const r of mascot.reactions) {
      if (r.highlight && r.highlight !== 'step' && !elementKeys.has(r.highlight)) fail(`reaction on ${r.on} highlights unknown key ${r.highlight}`)
    }
  }
}

if (voice && !voice.stt.models.some((m) => m.id === voice.stt.defaultModel)) fail(`voice.stt.defaultModel ${voice.stt.defaultModel} is not in models`)

if (providers) {
  const ids = new Set()
  for (const p of providers.providers) {
    if (ids.has(p.id)) fail(`duplicate provider id ${p.id}`)
    ids.add(p.id)
    const builtIn = Object.hasOwn(mod.BUILT_IN_BASE_URLS, p.id)
    if (!builtIn && !p.baseUrl) warnings.push(`provider ${p.id} is not built in and has no baseUrl; users must type one`)
    if (builtIn && p.baseUrl) warnings.push(`provider ${p.id} is built in; its baseUrl is ignored`)
    if (p.keyPattern) {
      try {
        new RegExp(p.keyPattern)
      } catch {
        fail(`provider ${p.id} keyPattern is not a valid regex`)
      }
    }
    for (const h of Object.keys(p.extraHeaders ?? {})) {
      if (!mod.ALLOWED_EXTRA_HEADERS.includes(h)) fail(`provider ${p.id} extra header ${h} is not allowed and would be dropped`)
    }
  }
}

for (const w of warnings) console.warn(`warning: ${w}`)
if (errors.length) {
  console.error(errors.map((e) => `error: ${e}`).join('\n'))
  console.error(`\n${errors.length} error(s) in ${configDir}`)
  process.exit(1)
}
console.log(`Config ${manifest.configVersion} in ${configDir} is valid (${toolNames.size} tools, ${warnings.length} warning(s)).`)
