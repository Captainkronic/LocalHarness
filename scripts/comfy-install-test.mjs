#!/usr/bin/env node
/**
 * Finding ComfyUI, and not lying about its models.
 *
 * Two failures this guards against, both observed on a real machine:
 *
 * COMFY_ROOT is the PARENT of the directory called ComfyUI, so the path has
 * the name twice. Off by one produces a plausible path that does not exist.
 *
 * And the models usually are not inside the install at all — here they are
 * 57 GB in a separate tree wired in with --extra-model-paths-config. The same
 * model check against the same machine returned 0/7 started plain and 7/7
 * started with the config. A wizard that got this wrong would tell someone to
 * re-download fifty-seven gigabytes they already had.
 *
 *   node scripts/comfy-install-test.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'comfyi-'))
await writeFile(join(dir, 'e.ts'),
  `export * from '${ROOT}/src/main/setup/comfy-install'\nexport * from '${ROOT}/src/main/setup/comfy-models'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const M = await import(pathToFileURL(out).href)

let failed = 0
const check = (n, c, e = '') => { if (c) console.log(`  ok  ${n}`); else { failed++; console.log(`  FAIL ${n}${e ? ` — ${e}` : ''}`) } }

/** Build a fake install: <root>/ComfyUI/main.py plus an interpreter. */
const fake = (opts = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'comfyroot-'))
  const c = join(root, 'ComfyUI')
  mkdirSync(join(c, '.venv', 'bin'), { recursive: true })
  if (opts.noMain !== true) writeFileSync(join(c, 'main.py'), '# comfy')
  if (opts.venv !== false) writeFileSync(join(c, '.venv', 'bin', 'python'), '#!/bin/sh\n')
  return root
}

console.log('\nFinding an install')
const good = fake()
const found = M.inspectRoot(good)
check('a real layout is recognised', found !== null)
check('root is the PARENT of ComfyUI, not ComfyUI itself', found.root === good,
  'this is the off-by-one that produces a path which looks right and is not')
check('and dir is the one comfy-mcp will cd into', found.dir === join(good, 'ComfyUI'))
check('it can be started', found.canStart === true)

const noPy = fake({ venv: false })
const broken = M.inspectRoot(noPy)
check('an install with no virtualenv is still FOUND', broken !== null,
  'reporting it absent would send someone to reinstall something they have')
check('but is marked unstartable', broken.canStart === false)
check('with a reason worth reading', /virtualenv/.test(broken.note ?? ''), broken.note)

check('a folder with no main.py is not an install', M.inspectRoot(fake({ noMain: true })) === null)
check('nor is an empty directory', M.inspectRoot(mkdtempSync(join(tmpdir(), 'empty-'))) === null)

console.log('\nStarting it')
const up = async () => ({ ok: true, status: 200 })
const already = await M.startComfy(found, 'http://127.0.0.1:8188', { fetchImpl: up })
check('an already-running server is not started twice', already.alreadyRunning === true)
const down = async () => { throw new Error('ECONNREFUSED') }
const cannot = await M.startComfy(broken, 'http://127.0.0.1:8188', { fetchImpl: down, timeoutMs: 100 })
check('an unstartable install fails fast, with the reason', cannot.started === false && /virtualenv/.test(cannot.error ?? ''),
  cannot.error)

console.log('\nGuidance when something is missing')
const missing = [
  { feature: 'Music', slot: 'checkpoint', file: 'ace_step_1.5_turbo_aio.safetensors' },
  { feature: 'Z-Image Turbo', slot: 'unet', file: 'z_image_turbo_bf16.safetensors' }
]
const g = M.guidanceFor(missing, '/models')
const known = g.find((x) => x.file.startsWith('ace_step'))
check('a model with a recorded source gets a runnable command', /^curl -fL -C -/.test(known.command ?? ''), known.command)
check('the command targets the right folder', (known.command ?? '').includes('/models/checkpoints/'))
check('and is resumable, which matters at 10 GB', (known.command ?? '').includes('-C -'))
check('its size is stated up front', known.sizeGb === 10)

const unknown = g.find((x) => x.file.startsWith('z_image'))
check('a model with NO recorded source offers no command', unknown.command === undefined,
  'a guessed Hugging Face repo is a 404 and a loss of trust in every other instruction')
check('and says so plainly instead', /not recorded/.test(unknown.advice), unknown.advice)
check('while still naming the exact destination', /diffusion_models\/z_image_turbo/.test(unknown.advice))

check('no-ComfyUI advice explains the doubled path', /CONTAINING ComfyUI/.test(M.NO_COMFY_ADVICE))
check('and does not insist it be on this machine', /does not have to be/.test(M.NO_COMFY_ADVICE))

for (const d of [good, noPy]) rmSync(d, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mall comfy-install checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
