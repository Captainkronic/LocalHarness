/**
 * Path helpers shared by the stores, the MCP client and the tool sandbox.
 *
 * Two jobs: expanding `~` the way a shell would (the MCP registry stores
 * commands, args and env values with tildes in them), and answering "is this
 * path inside one of the workspace roots" in a way that a symlink or a `..`
 * cannot talk its way past.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** `~` and `~/x` become the real home dir. Anything else is returned as-is —
 *  notably `~user` is left alone rather than guessed at. */
export function expandTilde(p: string): string {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** Expands `~` in every value of an env map. Keys are untouched. */
export function expandEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = typeof value === 'string' ? expandTilde(value) : value
  }
  return out
}

/**
 * Canonical absolute form of `p`, or null when it cannot be resolved at all.
 *
 * The path is allowed not to exist — a write target never does — so we realpath
 * the deepest ancestor that *does* exist and re-attach the missing tail. That is
 * what makes the containment check symlink-proof without forbidding new files.
 */
function resolveRealPath(p: unknown): string | null {
  if (typeof p !== 'string') return null
  if (p.trim().length === 0) return null
  // A NUL byte would throw in every fs call downstream; refuse it here so it can
  // never be smuggled past the containment check as an "unresolvable tail".
  if (p.includes('\0')) return null

  let current: string
  try {
    current = resolve(expandTilde(p))
  } catch {
    return null
  }

  const missing: string[] = []
  for (;;) {
    try {
      // .native asks the OS, so the result carries the true on-disk casing.
      const real = realpathSync.native(current)
      return missing.length > 0 ? join(real, ...missing.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return null // walked to the root and nothing resolved
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * True when `target` is one of `roots` or lives underneath one, after resolving
 * symlinks and `..` on both sides. Never throws.
 *
 * Containment is a path-segment test, not a string prefix test: `/etcfoo` is not
 * inside `/etc`. A root of `/` is legal and matches every absolute path.
 */
export function isInsideAny(target: string, roots: string[]): boolean {
  try {
    const real = resolveRealPath(target)
    if (real === null) return false
    if (!Array.isArray(roots)) return false

    for (const root of roots) {
      const realRoot = resolveRealPath(root)
      if (realRoot === null) continue
      if (real === realRoot) return true
      const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
      if (real.startsWith(prefix)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Directories a login shell has but a Finder-launched app does not.
 *
 * An app opened from Spotlight, Launchpad or the Dock inherits launchd's PATH —
 * roughly /usr/bin:/bin:/usr/sbin:/sbin — NOT the PATH from a login shell. Every
 * child it spawns inherits that too, so a helper that shells out to a Homebrew
 * binary fails with a bare "No such file or directory".
 *
 * That is not hypothetical: mlx_whisper always invokes `ffmpeg`, so the Live
 * workflow's transcription died with "[Errno 2] No such file or directory:
 * 'ffmpeg'" when the app was launched from the icon — while working perfectly
 * from `npm run dev`, because a terminal has the full PATH.
 */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

/**
 * PATH for a spawned child: the inherited one plus the places tools actually
 * live, de-duplicated and with the inherited entries kept in front so a user's
 * own ordering still wins.
 */
export function augmentedPath(inherited = process.env['PATH'] ?? ''): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...inherited.split(':'), ...EXTRA_PATH_DIRS]) {
    const d = dir.trim()
    if (d === '' || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out.join(':')
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(expandTilde(dir), { recursive: true })
}

/** Temp name in the *same* directory, so the rename stays on one filesystem
 *  and is therefore atomic. */
function tempNameFor(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/** Write via a temp file + rename, so a crash mid-write leaves the previous
 *  contents intact rather than a truncated file. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const target = expandTilde(file)
  await ensureDir(dirname(target))
  const tmp = tempNameFor(target)
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

export function atomicWriteSync(file: string, data: string): void {
  const target = expandTilde(file)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = tempNameFor(target)
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* the temp file may never have been created */
    }
    throw err
  }
}
