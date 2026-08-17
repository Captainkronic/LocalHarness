#!/usr/bin/env node
/**
 * Exercises the real LmStudioControl against the real Mac Studio: list, load,
 * inspect config, unload. This ACTUALLY LOADS AND UNLOADS MODELS, so it is not
 * part of `npm test` — run it deliberately.
 *
 *   node scripts/control-test.mjs [modelKey] [contextLength]
 *
 * Defaults to google/gemma-4-e4b, the small high-throughput VLM the Live
 * workflow is built around.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = process.argv[2] ?? 'google/gemma-4-e4b'
const CTX = process.argv[3] ? Number(process.argv[3]) : 16384

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = await mkdtemp(join(tmpdir(), 'lh-control-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { LmStudioControl } from '${ROOT}/src/main/llm/control'\n`
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') },
  external: ['electron']
})
const { LmStudioControl } = await import(pathToFileURL(outfile).href)

const SETTINGS = {
  nativeApiUrl: 'http://adams-mac-studio.tailc7bb1e.ts.net:1234',
  baseUrl: 'http://127.0.0.1:1235/v1',
  apiKey: 'lm-studio',
  labUrl: '',
  defaultModelId: null,
  approvalMode: 'always_ask',
  workspaceRoots: [],
  shellAllowlist: [],
  contextWarnFraction: 0.75,
  theme: 'dark',
  modelPollMs: 15000,
  workflowMcpOverrides: {}
}

const progress = []
const control = new LmStudioControl({
  getSettings: () => SETTINGS,
  onState: () => {},
  onProgress: (p) => progress.push(p),
  onLog: (lvl, scope, msg) => {
    if (lvl === 'error') console.log(`      \x1b[2m[${scope}] ${msg}\x1b[0m`)
  }
})

console.log(`\n\x1b[1mModel control — ${MODEL} @ ${CTX.toLocaleString()} ctx\x1b[0m\n`)
control.start()

// Give the socket a moment to come up.
for (let i = 0; i < 30 && control.state().status !== 'connected'; i++) await wait(500)
check('control websocket connects', control.state().status === 'connected', control.state().url)

const before = await control.refresh()
check('catalog reads over HTTP', before.catalog.length > 0, `${before.catalog.length} models`)
check(
  'resident set reads over the socket',
  Array.isArray(before.loaded),
  before.loaded.map((l) => `${l.identifier}@${l.contextLength.toLocaleString()}`).join(', ') || 'none'
)

const target = before.catalog.find((m) => m.modelKey === MODEL)
check('target model is in the catalog', target !== undefined, target && `max ${target.maxContextLength.toLocaleString()}, vision ${target.vision}`)

/* ---- load ---- */
const t0 = Date.now()
const loadResult = await control.load(MODEL, { contextLength: CTX })
const loadMs = Date.now() - t0
check('load() succeeds', loadResult.ok, loadResult.error ?? `${(loadMs / 1000).toFixed(1)}s`)
check('load reported progress', progress.length > 0, `${progress.length} progress events`)

if (loadResult.ok) {
  const after = await control.refresh()
  const inst = after.loaded.find((l) => l.modelKey === MODEL)
  check('model is now resident', inst !== undefined, inst?.identifier)
  check(
    'requested context length was honoured',
    inst !== undefined && inst.contextLength === CTX,
    inst ? `asked ${CTX.toLocaleString()}, got ${inst.contextLength.toLocaleString()}` : ''
  )

  if (inst) {
    const fields = await control.getConfig(inst.identifier)
    const ctxField = fields.find((f) => f.key === 'llm.load.contextLength')
    check('getConfig returns the live field set', fields.length > 0, `${fields.length} fields`)
    check('config agrees with the instance', ctxField?.value === CTX, `contextLength=${String(ctxField?.value)}`)
  }
}

console.log('')
console.log(
  failures === 0
    ? '\x1b[32mall control checks passed\x1b[0m'
    : `\x1b[31m${failures} failed\x1b[0m`
)
console.log(
  '\x1b[2mLeaving the model loaded — pass a model to unload explicitly if needed.\x1b[0m\n'
)
control.stop()
await rm(dir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
