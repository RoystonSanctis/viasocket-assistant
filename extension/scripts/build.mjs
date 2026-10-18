// Builds the unpacked extension into dist/.
// Each entry is bundled on its own because MV3 contexts load scripts differently:
// content scripts must be classic (IIFE) scripts, the service worker and extension pages can be ES modules.
import { build, context } from 'esbuild'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const configRepo = resolve(root, '..', 'config')
const watch = process.argv.includes('--watch')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const common = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  sourcemap: true,
  minify: !watch,
  legalComments: 'eof',
  logLevel: 'info',
  define: { __EXT_VERSION__: JSON.stringify(pkg.version) },
}

// Transformers.js defaults ONNX Runtime's .mjs/.wasm location to a jsDelivr URL. It is dead code here (asr.ts points
// wasmPaths at the packaged ort/ before anything loads) and the CSP would block it, but a remote script base in the
// package reads as remotely hosted code, so the prefix is emptied at bundle time. checkNoCdn() enforces the result.
const ORT_CDN_PREFIX = /https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{[^}]*\}\/dist\//g
const stripOrtCdn = {
  name: 'strip-ort-cdn',
  setup(b) {
    b.onLoad({ filter: /[\\/]@huggingface[\\/]transformers[\\/].*\.m?js$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(ORT_CDN_PREFIX, ''),
      loader: 'js',
    }))
  },
}

const entries = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content', format: 'iife' },
  { in: 'src/main-world/hook.ts', out: 'page-hook', format: 'iife' },
  { in: 'src/offscreen/offscreen.ts', out: 'offscreen', format: 'esm', plugins: [stripOrtCdn] },
  { in: 'src/options/options.ts', out: 'options', format: 'esm' },
]

async function copyStatic() {
  await mkdir(dist, { recursive: true })

  const manifest = JSON.parse(await readFile(join(root, 'src', 'manifest.json'), 'utf8'))
  manifest.version = pkg.version
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2))

  for (const page of ['offscreen/offscreen.html', 'options/options.html', 'options/options.css']) {
    const src = join(root, 'src', page)
    if (existsSync(src)) await cp(src, join(dist, page.split('/').pop()))
  }
  if (existsSync(join(root, 'public'))) await cp(join(root, 'public'), dist, { recursive: true })
  await copyConfig()
}

// The config repo is bundled as the last-resort fallback so a broken or unreachable remote never bricks the extension.
// Only manifest.json and the files it lists are shipped (not the repo's README, package files or tooling).
async function copyConfig() {
  const manifestPath = join(configRepo, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Config repo not found at ${configRepo}; the bundled fallback is required.`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const { prompts = {}, ...files } = manifest.files ?? {}
  const listed = ['manifest.json', ...Object.values(files), ...Object.values(prompts)]
  for (const rel of listed) {
    if (typeof rel !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/.test(rel) || rel.split('/').includes('..')) {
      throw new Error(`Unsafe path in config manifest: ${rel}`)
    }
    const dest = join(dist, 'defaults', rel)
    await mkdir(dirname(dest), { recursive: true })
    await cp(join(configRepo, rel), dest)
  }
}

// ONNX Runtime ships its WASM separately; MV3 forbids loading code from a CDN, so it must live in the package.
// Only the variants the bundled runtime actually references are copied (the full set is ~85 MB).
async function copyOrt(all) {
  const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')
  if (!existsSync(ortDist)) throw new Error('onnxruntime-web is not installed; run npm install.')
  const available = (await readdir(ortDist)).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f))
  let wanted = available
  if (!all) {
    const bundle = await readFile(join(dist, 'offscreen.js'), 'utf8')
    const referenced = new Set(bundle.match(/ort-wasm[\w.-]*?\.(?:wasm|mjs)/g) ?? [])
    for (const f of available) {
      if (f.includes('jsep')) referenced.add(f)
    }
    wanted = available.filter((f) => referenced.has(f))
    if (!wanted.length) {
      console.warn('No ONNX Runtime files referenced by offscreen.js; copying all variants.')
      wanted = available
    }
  }
  await mkdir(join(dist, 'ort'), { recursive: true })
  for (const file of wanted) await cp(join(ortDist, file), join(dist, 'ort', file))
}

/** Fails the build if any shipped script still names a CDN (Chrome Web Store treats that as remote code). */
async function checkNoCdn() {
  const scripts = [
    ...(await readdir(dist)).filter((f) => f.endsWith('.js')),
    ...(await readdir(join(dist, 'ort'))).filter((f) => f.endsWith('.mjs')).map((f) => join('ort', f)),
  ]
  for (const file of scripts) {
    if ((await readFile(join(dist, file), 'utf8')).includes('cdn.jsdelivr.net')) {
      throw new Error(`dist/${file} references cdn.jsdelivr.net; extend the strip-ort-cdn plugin in scripts/build.mjs.`)
    }
  }
}

await rm(dist, { recursive: true, force: true })
await copyStatic()

const options = entries.map((e) => ({
  ...common,
  entryPoints: [join(root, e.in)],
  outfile: join(dist, `${e.out}.js`),
  format: e.format,
  plugins: e.plugins ?? [],
}))

if (watch) {
  await copyOrt(true)
  const contexts = await Promise.all(options.map((o) => context(o)))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('Watching for changes. Static files and config are copied once; restart to pick up their changes.')
} else {
  await Promise.all(options.map((o) => build(o)))
  await copyOrt(false)
  await checkNoCdn()
  console.log(`Built ${pkg.name}@${pkg.version} into dist/`)
}
