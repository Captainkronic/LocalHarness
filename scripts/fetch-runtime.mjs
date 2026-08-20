#!/usr/bin/env node
/**
 * Fetch the relocatable Python the installer ships.
 *
 * Every venv on a target machine is built with this interpreter, and that is
 * not a convenience. The servers here currently run on three different Pythons
 * — a pyenv 3.12, a Homebrew 3.14, and /usr/bin/python3 — and the system one on
 * macOS is 3.9.6, which several of the required packages will not install
 * against. Depending on what a target Mac happens to have is how an installer
 * fails on someone else's machine.
 *
 * python-build-standalone's `install_only` build is relocatable: no absolute
 * paths baked in, so it runs from inside the .app bundle wherever that lands.
 * This is the one property that makes the whole approach work, and it is why
 * the venvs cannot simply be copied instead.
 *
 * The version is PINNED. An installer that quietly picks up a different Python
 * between builds is an installer whose wheels stop matching its runtime.
 *
 *   node scripts/fetch-runtime.mjs           # fetch if absent
 *   node scripts/fetch-runtime.mjs --force   # re-fetch
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'resources', 'runtime')
const PYTHON = join(DEST, 'python', 'bin', 'python3')

/* Pinned deliberately — see the header. Bump both together. */
const RELEASE = '20260814'
const VERSION = '3.12.14'
const ASSET = `cpython-${VERSION}+${RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`
const URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${ASSET}`
const LOCK = join(DEST, 'runtime.lock.json')

function log(msg) {
  console.log(`  ${msg}`)
}

function fail(msg) {
  console.error(`\n\x1b[31mfetch-runtime: ${msg}\x1b[0m\n`)
  process.exit(1)
}

const force = process.argv.includes('--force')

if (existsSync(PYTHON) && !force) {
  const v = execFileSync(PYTHON, ['-V'], { encoding: 'utf8' }).trim()
  log(`already present: ${v}`)
  process.exit(0)
}

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })

log(`downloading ${ASSET}`)
const res = await fetch(URL, { redirect: 'follow' })
if (!res.ok) fail(`download failed: HTTP ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(buf).digest('hex')
log(`${(buf.length / 1048576).toFixed(1)} MB, sha256 ${sha.slice(0, 16)}…`)

/* If a lock exists, the hash must match it. This is what stops a rebuild from
   silently shipping a different interpreter than the wheels were resolved
   against. */
if (existsSync(LOCK)) {
  const prev = JSON.parse(readFileSync(LOCK, 'utf8'))
  if (prev.sha256 !== sha) {
    fail(
      `the pinned runtime changed underneath us.\n` +
        `  expected ${prev.sha256}\n  got      ${sha}\n` +
        `  Delete ${LOCK} deliberately if this is intended.`
    )
  }
}

const tarball = join(DEST, ASSET)
writeFileSync(tarball, buf)
execFileSync('tar', ['xzf', tarball, '-C', DEST])
rmSync(tarball)

if (!existsSync(PYTHON)) fail('extracted, but no python3 where one was expected')

const reported = execFileSync(PYTHON, ['-V'], { encoding: 'utf8' }).trim()
if (!reported.includes(VERSION)) fail(`expected ${VERSION}, got "${reported}"`)

/*
 * Relocatability is the whole premise, so check it rather than trust it: a
 * build with absolute paths compiled in would work here and fail on the target,
 * which is the worst possible time to find out.
 */
const cfg = join(DEST, 'python', 'lib', `python3.12`, 'sysconfig.py')
const home = execFileSync(PYTHON, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' }).trim()
if (!home.startsWith(DEST)) {
  fail(`sys.prefix is ${home}, outside the bundle — this build is not relocatable`)
}

writeFileSync(LOCK, `${JSON.stringify({ asset: ASSET, version: VERSION, release: RELEASE, sha256: sha }, null, 2)}\n`)

log(`${reported} ready at resources/runtime/python`)
log(`sys.prefix resolves inside the bundle — relocatable`)
void cfg
