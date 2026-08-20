#!/usr/bin/env node
/**
 * Can a machine that has never seen these servers actually build them?
 *
 * That is the entire premise of the installer, and it is not provable by
 * inspection. The existing venvs cannot be copied — pyvenv.cfg names an
 * absolute pyenv path and the console scripts carry a username in their
 * shebangs — so the plan is a bundled relocatable Python plus a wheelhouse,
 * and venvs built on arrival.
 *
 * This proves the three things that plan rests on, offline:
 *   1. the bundled runtime creates a venv
 *   2. every requirement installs from the local wheels with --no-index
 *   3. the result imports, and points at the BUNDLED python rather than at
 *      whatever the build machine happened to have
 *
 * Kept out of `npm test` on purpose: it needs resources/ populated and takes
 * tens of seconds.
 *
 *   node scripts/fetch-runtime.mjs && node scripts/bundle-mcp.mjs --wheels
 *   node scripts/installer-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(ROOT, 'resources', 'runtime', 'python', 'bin', 'python3')
const WHEELS = join(ROOT, 'resources', 'wheels')
const STAGE = join(ROOT, 'resources', 'mcp')

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

if (!existsSync(RUNTIME) || !existsSync(WHEELS)) {
  console.error('resources not built — run fetch-runtime.mjs and bundle-mcp.mjs --wheels first')
  process.exit(1)
}

/** One import per server that proves the package actually landed. */
const PROBE = {
  data: "import duckdb; duckdb.__version__",
  webassets: "import PIL; PIL.__version__",
  docgen: "import docx, openpyxl, pptx, lxml; 'ok'",
  playwright: "import playwright, yaml; 'ok'"
}

const manifest = JSON.parse(readFileSync(join(STAGE, 'manifest.json'), 'utf8'))
const buildable = manifest.filter((m) => m.requirements && !m.depsOnDemand)
const work = mkdtempSync(join(tmpdir(), 'installer-smoke-'))

console.log(`\nBuilding ${buildable.length} server environments offline\n`)
for (const m of buildable) {
  const venv = join(work, m.id)
  try {
    execFileSync(RUNTIME, ['-m', 'venv', venv], { stdio: 'ignore' })
    execFileSync(join(venv, 'bin', 'python'), [
      '-m', 'pip', 'install', '--quiet', '--no-index', '--find-links', WHEELS,
      '-r', join(STAGE, m.id, m.requirements)
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    check(`${m.id}: builds offline`, false, String(err?.stderr ?? err).trim().split('\n').slice(-2).join(' '))
    continue
  }
  check(`${m.id}: builds offline from the wheelhouse`, true)

  const probe = PROBE[m.id]
  if (probe) {
    try {
      execFileSync(join(venv, 'bin', 'python'), ['-c', probe], { stdio: 'ignore' })
      check(`${m.id}: its packages import`, true)
    } catch {
      check(`${m.id}: its packages import`, false, 'installed but does not import')
    }
  }

  /* The portability check. A venv pointing at pyenv or Homebrew is one that
     works here and nowhere else, which is the exact failure this design
     exists to avoid. */
  const cfg = readFileSync(join(venv, 'pyvenv.cfg'), 'utf8')
  const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim() ?? ''
  check(`${m.id}: bound to the bundled runtime`, home.startsWith(join(ROOT, 'resources', 'runtime')),
    `home = ${home}`)
  check(`${m.id}: no pyenv or Homebrew dependency`, !/\.pyenv|homebrew|\/opt\//i.test(cfg), home)
}

rmSync(work, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mthe installer premise holds — offline, portable\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
