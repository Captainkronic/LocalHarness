#!/usr/bin/env node
/**
 * Provisioning, on a throwaway install root.
 *
 * The behaviours worth pinning are the ones that only show up on someone
 * else's machine: that a venv-less server still gets a launchable command,
 * that one broken server does not abort the rest, and that the install lands
 * somewhere an app upgrade will not delete.
 *
 *   node scripts/provision-test.mjs      (needs resources/ built)
 */
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'prov-'))
await writeFile(join(dir, 'e.ts'), `export * from '${ROOT}/src/main/setup/provision'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const P = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

const RES = join(ROOT, 'resources')
if (!existsSync(join(RES, 'mcp', 'manifest.json'))) {
  console.error('resources not built — run `npm run bundle` first'); process.exit(1)
}

console.log('\nReading the bundle')
const manifest = P.readManifest(RES)
check('the manifest lists servers', manifest.length >= 10, `${manifest.length}`)
check('seven need no dependencies at all', manifest.filter((m) => !m.deps).length === 7,
  `${manifest.filter((m) => !m.deps).length} — these run straight on the bundled python`)
check('voice is marked deps-on-demand', manifest.find((m) => m.id === 'voice')?.depsOnDemand === true)
check('the bundled python exists', existsSync(P.bundledPython(RES)))

console.log('\nResolving where resources live')
check('prefers a packaged resourcesPath when it has a manifest', P.resourcesRoot(RES, ROOT) === RES)
check('falls back to the repo when packaged resources are absent',
  P.resourcesRoot('/nonexistent-resources', ROOT) === join(ROOT, 'resources'))

console.log('\nInstalling into a throwaway root')
const root = mkdtempSync(join(tmpdir(), 'servers-'))
const seen = []
/* websearch is stdlib-only, data needs duckdb: one of each kind, plus a
   deliberately bogus id to prove a failure is contained. */
const res = await P.provision(['websearch', 'data', 'no-such-server'], {
  resources: RES, installRoot: root, onProgress: (p) => seen.push(`${p.id}:${p.phase}`)
})
check('the good servers installed', res.installed.includes('websearch') && res.installed.includes('data'),
  res.installed.join(','))
check('an unknown server fails without taking the others down', res.failed.length === 1,
  JSON.stringify(res.failed))
check('progress was reported per phase', seen.includes('data:creating-env') && seen.includes('data:installing'),
  seen.join(' '))

console.log('\nWhat a launch looks like afterwards')
const stdlib = P.launchSpec(root, RES, manifest.find((m) => m.id === 'websearch'))
check('a stdlib server runs on the bundled interpreter', stdlib.command === P.bundledPython(RES))
check('and points at its own copy, not the bundle', stdlib.args[0].startsWith(root))
const withVenv = P.launchSpec(root, RES, manifest.find((m) => m.id === 'data'))
check('a server with deps runs on its OWN venv', withVenv.command.startsWith(join(root, 'data', 'venv')),
  withVenv.command)
const cfg = readFileSync(join(root, 'data', 'venv', 'pyvenv.cfg'), 'utf8')
check('that venv is bound to the bundled runtime, not pyenv or Homebrew',
  !/\.pyenv|homebrew/i.test(cfg), cfg.split('\n')[0])

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mall provisioning checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
