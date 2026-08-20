#!/usr/bin/env node
/**
 * Assemble the MCP payload that ships inside the installer.
 *
 * The servers live under ~/.config/*-mcp as a working installation, which is a
 * very different thing from a distributable one. On this machine that directory
 * holds 3.5 GB, and most of it must never leave: 884 MB of screenshots, 487 MB
 * of Chrome profiles, four abandoned browser profiles from crashed runs, and a
 * credentials.json with a live Duffel token in it.
 *
 * So this does not copy directories. It copies a named list of files per
 * server, and then AUDITS what it produced and refuses to continue if anything
 * forbidden is present. The audit is the point: an allowlist can be got wrong
 * by adding a file next to server.py, and a token reaching a DMG is the one
 * mistake here with no way back.
 *
 * The venvs are deliberately not copied — they cannot be. pyvenv.cfg names an
 * absolute pyenv path and the console scripts have this machine's username in
 * their shebangs. What ships instead is a requirements.txt per server, read out
 * of the live venv, plus wheels for it.
 *
 *   node scripts/bundle-mcp.mjs            # stage sources + manifests
 *   node scripts/bundle-mcp.mjs --wheels   # ...and download wheels
 *   node scripts/bundle-mcp.mjs --audit    # audit an existing staging dir only
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = homedir()
const STAGE = join(ROOT, 'resources', 'mcp')
const WHEELS = join(ROOT, 'resources', 'wheels')

/**
 * What each server is, reduced to the files that actually constitute it.
 *
 * `files` and `dirs` are an allowlist. Anything not named here does not ship,
 * which is why runtime state (geocache.json, progress.json, case.json) simply
 * never appears — it is not excluded so much as never invited.
 *
 * `tier` drives what the wizard pre-ticks. `deps` says whether a venv is needed
 * at all; six of these are pure standard library and need only the runtime.
 */
const SERVERS = [
  { id: 'websearch',   dir: 'websearch-mcp',  files: ['server.py'], tier: 'core', deps: false },
  { id: 'fastfacts',   dir: 'fastfacts-mcp',  files: ['server.py'], tier: 'core', deps: false },
  { id: 'health',      dir: 'health-mcp',     files: ['server.py'], dirs: ['cases'], tier: 'core', deps: false },
  { id: 'ui-review',   dir: 'ui-review-mcp',  files: ['server.py', 'sync-skills.sh', 'README.md'], dirs: ['vendor'], tier: 'core', deps: false },
  { id: 'data',        dir: 'data-mcp',       files: ['server.py'], tier: 'core', deps: true },
  { id: 'webassets',   dir: 'webassets-mcp',  files: ['server.py', 'fetch-icons.sh'], dirs: ['icons'], tier: 'core', deps: true },
  { id: 'docgen',      dir: 'docgen-mcp',     files: ['server.py'], tier: 'core', deps: true },
  { id: 'playwright',  dir: 'playwright-mcp', files: ['server.py', 'README.md'], tier: 'core', deps: true },
  /* Opt-in. flights ships its FIXTURE but never its credentials; comfy needs a
     ComfyUI server; voice needs 1.4 GB of torch and spacy and is fetched after
     install rather than carried. */
  { id: 'flights',     dir: 'flights-mcp',    files: ['server.py', 'fixture-duffel.json'], tier: 'optional', deps: false },
  { id: 'comfy-image', dir: 'comfy-mcp',      files: ['server.py', 'idle-unload.py', 'watch-progress.py', 'fetch-audio-models.sh'], tier: 'optional', deps: false },
  { id: 'comfy-audio', dir: 'comfy-audio',    files: ['server.py'], tier: 'optional', deps: false },
  { id: 'voice',       dir: 'voice-mcp',      files: ['server.py'], tier: 'optional', deps: true, depsOnDemand: true }
]

/**
 * Anything matching these in the staged tree fails the build.
 *
 * Every one of these is a real thing sitting in ~/.config right now, not a
 * hypothetical. The check runs over what was produced rather than over what was
 * requested, because the bug worth catching is a file that arrived by a route
 * nobody thought about.
 */
/**
 * Structural exclusions: never ship, whatever the file is called.
 *
 * Every one of these is a real thing sitting in ~/.config right now, not a
 * hypothetical.
 */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)venv($|\/)/,       why: 'a virtualenv (not portable — ships as requirements.txt)' },
  { re: /__pycache__/,            why: 'compiled bytecode' },
  { re: /chrome-profile/,         why: 'a browser profile (runtime state, hundreds of MB)' },
  { re: /(^|\/)shots($|\/)/,      why: 'captured screenshots (runtime output)' },
  { re: /\.bak/,                  why: 'a hand-made backup' },
  { re: /(^|\/)\.git($|\/)/,      why: 'a git directory' },
  { re: /(^|\/)(inbox|staged|selftest-out)($|\/)/, why: 'runtime working state' },
  { re: /(^|\/)\.env($|\/)/,      why: 'an environment file' }
]

/**
 * Extensions that could carry a secret.
 *
 * A name-based rule cannot tell a key from an icon, and the first run of this
 * audit proved it by rejecting `jsonwebtokens.svg` and
 * `basicattentiontoken.svg` — two brand icons in the webassets set. Narrowing
 * the name check to config-shaped files, and adding a CONTENT check below,
 * catches the actual risk instead of the spelling of it.
 */
const CONFIGISH = /\.(json|txt|ya?ml|ini|cfg|conf|pem|key|toml)$/i
const SECRET_NAME = /(credential|secret|apikey|api[-_]key|token)/i

/**
 * A key that names a secret, holding a value long enough to be one.
 *
 * This is the check that matters. The live duffel_token is 55 characters, and
 * it would pass any filename rule if it were ever stored somewhere unexpected —
 * so the payload is read, not just listed. Short values are ignored: a config
 * saying `"api_key": ""` or `"token": "none"` is not a leak.
 */
const SECRET_KEY = /"[^"]*(token|secret|api[_-]?key|password|credential)[^"]*"\s*:\s*"([^"]{16,})"/i

function contentProblems(stageDir, rel) {
  if (!CONFIGISH.test(rel)) return []
  let text
  try {
    text = readFileSync(join(stageDir, rel), 'utf8')
  } catch {
    return [] // binary or unreadable: nothing a regex would find anyway
  }
  const hit = SECRET_KEY.exec(text)
  if (!hit) return []
  return [`${rel} — contains a "${hit[0].split('"')[1]}" value ${hit[2].length} characters long`]
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}

function audit(stageDir) {
  if (!existsSync(stageDir)) fail(`nothing staged at ${stageDir}`)
  const problems = []
  for (const rel of walk(stageDir)) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(rel)) problems.push(`${rel} — ${rule.why}`)
    }
    if (CONFIGISH.test(rel) && SECRET_NAME.test(rel)) {
      problems.push(`${rel} — named like a credentials file`)
    }
    problems.push(...contentProblems(stageDir, rel))
  }
  return problems
}

function fail(message) {
  console.error(`\n\x1b[31mbundle-mcp: ${message}\x1b[0m\n`)
  process.exit(1)
}

function bytes(n) {
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

function sizeOf(dir) {
  return walk(dir).reduce((n, rel) => n + statSync(join(dir, rel)).size, 0)
}

/* ------------------------------------------------------------------ */

const args = new Set(process.argv.slice(2))

if (args.has('--audit')) {
  const problems = audit(STAGE)
  if (problems.length > 0) fail(`staging is contaminated:\n  ${problems.join('\n  ')}`)
  console.log('audit clean')
  process.exit(0)
}

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

const manifest = []
let missing = 0

for (const server of SERVERS) {
  const src = join(HOME, '.config', server.dir)
  if (!existsSync(src)) {
    console.log(`  skip  ${server.id} — not installed on this machine`)
    missing++
    continue
  }
  const dest = join(STAGE, server.id)
  mkdirSync(dest, { recursive: true })

  for (const file of server.files ?? []) {
    const from = join(src, file)
    if (!existsSync(from)) fail(`${server.id}: expected ${file} and it is not there`)
    cpSync(from, join(dest, file))
  }
  for (const d of server.dirs ?? []) {
    const from = join(src, d)
    if (existsSync(from)) cpSync(from, join(dest, d), { recursive: true })
  }

  /* Requirements come out of the live venv, because nothing else records them:
     there is no requirements.txt anywhere under ~/.config. */
  let requirements = null
  const venvPip = join(src, 'venv', 'bin', 'python')
  if (server.deps && existsSync(venvPip)) {
    const frozen = execFileSync(venvPip, ['-m', 'pip', 'freeze'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim() && !/^(pip|setuptools|wheel)==/.test(l))
      .join('\n')
    requirements = 'requirements.txt'
    writeFileSync(join(dest, requirements), `${frozen}\n`)
  }

  manifest.push({
    id: server.id,
    tier: server.tier,
    deps: Boolean(server.deps),
    depsOnDemand: Boolean(server.depsOnDemand),
    requirements,
    entry: (server.files ?? [])[0] ?? 'server.py'
  })
  console.log(`  ok    ${server.id.padEnd(12)} ${bytes(sizeOf(dest)).padStart(9)}${requirements ? '  + requirements.txt' : ''}`)
}

writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

/* The audit runs over the RESULT, so a file that arrived by an unexpected
   route is still caught. */
const problems = audit(STAGE)
if (problems.length > 0) fail(`staging is contaminated — refusing to build:\n  ${problems.join('\n  ')}`)

console.log(`\nstaged ${manifest.length} server(s), ${bytes(sizeOf(STAGE))} total${missing ? `, ${missing} not installed here` : ''}`)
console.log('audit clean — no credentials, venvs, profiles or captures')

if (args.has('--wheels')) {
  console.log('\nwheels: not yet implemented — needs the bundled runtime to resolve against')
  console.log('        (a wheel built for 3.9 will not install into a 3.12 venv)')
}
