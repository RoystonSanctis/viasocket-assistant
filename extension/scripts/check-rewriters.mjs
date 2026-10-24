// Self-check for the code rewriters that edit a user's JS step: the subfunction parser and the dynamicVariables
// extraction. Each case is one that once broke saved code. Bundled in memory like check-config.mjs.
//
//   node scripts/check-rewriters.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = `
export * from './src/shared/subfunctions-parser.ts'
export { autoExtractDynamicVariables } from './src/background/tools/flow/function-vars.ts'
export { InputsModel } from './src/shared/subfunction-inputs.ts'
`
const out = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'check-rewriters-entry.js', loader: 'js' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'error',
  define: { __EXT_VERSION__: '"0.0.0"' },
})
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)

const cases = {
  'dynamicVariables keep ?.': () => {
    const r = m.autoExtractDynamicVariables('return context.res.Get_Rows?.rows ?? []', {})
    assert.deepEqual(r.dynamicVariables, { rows: '${context.res.Get_Rows?.rows}' })
    assert.equal(r.code, 'return rows ?? []')
  },
  'dynamicVariables avoid an arrow parameter name': () => {
    const r = m.autoExtractDynamicVariables('return items.map(name => ({ name, owner: context.res.Get_Owner.name }))', {})
    assert.ok(!('name' in r.dynamicVariables), JSON.stringify(r.dynamicVariables))
    assert.match(r.code, /owner: Get_Owner_name/)
  },
  'dynamicVariables avoid a destructured name': () => {
    const r = m.autoExtractDynamicVariables('const { email } = input\nreturn { other: context.res.Lookup.email }', {})
    assert.ok(!('email' in r.dynamicVariables), JSON.stringify(r.dynamicVariables))
  },
  'regex with a backtick does not hide calls': () => {
    const code = "const t = s.replace(/`/g, '')\nawait sendMessage({ inputData: { text: t } })\nconst u = `done`"
    assert.equal(m.countCalls(code, 'sendMessage'), 1)
  },
  'regex with a quote keeps the inserted call before return': () => {
    const code = "const safe = name.replace(/'/g, \"\\\\'\")\nreturn { safe }"
    const next = m.insertSubfunctionCall(code, 'sendMessage', { text: 'safe' })
    assert.ok(next.indexOf('await sendMessage(') < next.indexOf('return { safe }'), next)
  },
  'division is not a regex': () => {
    const code = 'const half = total / 2\nawait sendMessage({ inputData: { n: half / 3 } })'
    assert.equal(m.findSubfunctionCalls(code, ['sendMessage'])[0]?.fields?.n, 'half / 3')
  },
  'trailing line comment does not swallow the comma': () => {
    const code = 'await sendMessage({ inputData: {\n  channel: "C1",\n  text: "hi" // greeting\n} })'
    const call = m.findSubfunctionCalls(code, ['sendMessage'])[0]
    assert.equal(call.fields.text, '"hi"')
    assert.doesNotThrow(() => new Function(`return async () => { ${m.replaceCallInput(code, call, { ...call.fields, extra: '"x"' })} }`))
  },
  'multi-line template value stays verbatim': () => {
    const code = 'await sendMessage({ inputData: {\n    text: `Line 1\n  Line 2`\n  } })'
    const call = m.findSubfunctionCalls(code, ['sendMessage'])[0]
    assert.match(m.replaceCallInput(code, call, call.fields), /`Line 1\n {2}Line 2`/)
  },
  'removing a call keeps blank lines inside strings': () => {
    const code = 'const body = `Hi,\n\n\n\nThanks`\nawait sendMessage({ inputData: { text: body } })\nreturn body'
    const r = m.removeCallStatements(code, 'sendMessage')
    assert.equal(r.removed, 1)
    assert.match(r.code, /`Hi,\n\n\n\nThanks`/)
  },
  'generated group fields load by label and show mappings': () => {
    const code = 'await addRow({ inputData: {\n  column_selected: ["name"],\n  column_name: {\n    name: context.req.body?.name\n  }\n} })'
    const call = m.findSubfunctionCalls(code, ['addRow'])[0]
    const model = new m.InputsModel({
      // The group is listed but empty until its fields are generated, as the panel loads it.
      steps: { root: ['column_selected', 'column_name'], column_name: [] },
      fields: {
        column_selected: { key: 'column_selected', type: 'multiselect', label: 'Columns' },
        column_name: { key: 'column_name', type: 'input groups', label: 'Column Values', generates: true },
      },
    })
    model.load(call.fields)
    const child = 'column_name["A"]'
    model.groupLoaded('column_name', { steps: { column_name: [child] }, fields: { [child]: { key: child, type: 'string', label: 'Name' } } })
    assert.deepEqual(model.values.get(child)?.value, { kind: 'text', text: '${context.req.body?.name}' })
    assert.equal(model.extras.get('column_name'), undefined)
    // Unchanged values are written back as the code had them, under the app's own key.
    assert.match(model.inputDataFields().column_name, /A: context\.req\.body\?\.name/)
  },
  'rename skips method definitions': () => {
    const code = 'const api = { sendMessage(x) { return x } }\nawait sendMessage({ inputData: { a: 1 } })\nreturn api.sendMessage(1)'
    const next = m.renameSubfunction(code, 'sendMessage', 'notifyUser')
    assert.match(next, /\{ sendMessage\(x\)/)
    assert.match(next, /await notifyUser\(\{/)
    assert.match(next, /api\.sendMessage\(1\)/)
    assert.equal(m.countCalls(code, 'sendMessage'), 1)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(cases)) {
  try {
    fn()
  } catch (e) {
    failed++
    console.error(`FAIL ${name}\n  ${e.message.split('\n').join('\n  ')}`)
  }
}
if (failed) {
  console.error(`${failed} of ${Object.keys(cases).length} rewriter checks failed`)
  process.exit(1)
}
console.log(`Rewriter checks passed (${Object.keys(cases).length})`)
