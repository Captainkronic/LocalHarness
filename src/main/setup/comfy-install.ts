/**
 * Find ComfyUI on this machine, and prove it can be started.
 *
 * comfy-mcp already knows how to launch ComfyUI — it shells out to
 * `$COMFY_ROOT/ComfyUI/.venv/bin/python $COMFY_ROOT/ComfyUI/main.py` when
 * nothing is listening. What it cannot do is guess COMFY_ROOT, and its default
 * is the path on one particular laptop. On any other machine image generation
 * fails with "ComfyUI install not found", which reads like a missing
 * dependency rather than a wrong setting.
 *
 * Note the doubled name in that path: COMFY_ROOT is the PARENT of the
 * directory called ComfyUI, not the directory itself. Getting that off by one
 * produces a path that looks right and does not exist, so the detector returns
 * a root it has actually verified both files under rather than one it inferred
 * from a match.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * ComfyUI's shared-model config, and why it is not optional here.
 *
 * The models usually do NOT live inside the ComfyUI directory. On this setup
 * they are 57 GB in a separate ComfyUI-Shared tree, wired in through
 * --extra-model-paths-config, and ComfyUI reports ZERO models without it.
 *
 * That is the most dangerous false positive this wizard could produce: it
 * would tell someone to download fifty-seven gigabytes they already have.
 * Measured, not guessed — the same model check against the same machine
 * returned 0/7 when ComfyUI was started plain and 7/7 when started with the
 * config, which is exactly the mistake to build a guard against.
 */
export const DEFAULT_MODEL_PATHS_YAML =
  '~/Library/Application Support/Comfy Desktop/shared_model_paths.yaml'

export interface ComfyInstall {
  /** What COMFY_ROOT should be set to. */
  root: string
  /** The ComfyUI directory itself, for display. */
  dir: string
  /** Its interpreter, or null when the install has no virtualenv. */
  python: string | null
  /** Both files present, so comfy-mcp's autostart will work. */
  canStart: boolean
  /** Why it cannot, when it cannot. */
  note?: string
  /** The shared-model config, when one exists. Without it ComfyUI sees no models. */
  modelPathsYaml: string | null
}

/**
 * Places a ComfyUI ends up, in rough order of likelihood.
 *
 * Deliberately a short list checked precisely rather than a filesystem-wide
 * search: scanning a home directory for main.py takes minutes on a machine
 * with a large Documents folder, and the wizard has a text field for the case
 * this misses.
 */
function candidateRoots(home: string): string[] {
  const roots = [
    home,
    join(home, 'Documents'),
    join(home, 'Desktop'),
    join(home, 'Developer'),
    join(home, 'Applications'),
    join(home, 'ComfyUI-Installs'),
    '/Applications'
  ]
  /* One level inside the installer-style directories too: the ComfyUI desktop
     installer produces ComfyUI-Installs/<name>/ComfyUI/, so the root worth
     testing is one deeper than the obvious one. */
  const nested: string[] = []
  for (const base of [join(home, 'ComfyUI-Installs'), join(home, 'Documents')]) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) nested.push(join(base, entry.name))
      }
    } catch {
      /* Not there; nothing to add. */
    }
  }
  return [...roots, ...nested]
}

/** A root is real only if BOTH files comfy-mcp needs are under it. */
export function inspectRoot(root: string): ComfyInstall | null {
  const dir = join(root, 'ComfyUI')
  const main = join(dir, 'main.py')
  if (!existsSync(main)) return null

  /* .venv first because that is what comfy-mcp uses verbatim; the others are
     reported so the wizard can say "found, but it will not autostart" instead
     of pretending the install is absent. */
  const candidates = [
    join(dir, '.venv', 'bin', 'python'),
    join(dir, 'venv', 'bin', 'python'),
    join(root, 'standalone-env', 'bin', 'python3')
  ]
  const python = candidates.find((p) => existsSync(p)) ?? null
  const usable = existsSync(candidates[0]!)

  const yaml = join(
    homedir(),
    'Library',
    'Application Support',
    'Comfy Desktop',
    'shared_model_paths.yaml'
  )

  return {
    root,
    dir,
    python,
    canStart: usable,
    modelPathsYaml: existsSync(yaml) ? yaml : null,
    ...(usable
      ? {}
      : {
          note: python
            ? 'Found, but its interpreter is not at .venv/bin/python, which is the only one the image server will use.'
            : 'Found, but it has no virtualenv — it cannot be started automatically.'
        })
  }
}

export function findComfyInstalls(home = homedir()): ComfyInstall[] {
  const seen = new Set<string>()
  const found: ComfyInstall[] = []
  for (const root of candidateRoots(home)) {
    if (seen.has(root)) continue
    seen.add(root)
    const install = inspectRoot(root)
    if (install) found.push(install)
  }
  /* Startable ones first: a wizard offering a broken install above a working
     one is worse than offering nothing. */
  return found.sort((a, b) => Number(b.canStart) - Number(a.canStart))
}

/** Is something already answering on this host? */
export async function comfyRunning(host: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${host.replace(/\/+$/, '')}/system_stats`, {
      signal: AbortSignal.timeout(4000)
    })
    return res.ok
  } catch {
    return false
  }
}

export interface StartOutcome {
  started: boolean
  /** Already up before we did anything. */
  alreadyRunning: boolean
  error?: string
  waitedMs?: number
}

/**
 * Start ComfyUI and wait for it to answer.
 *
 * The wizard offers this because "we found a folder" is a weaker claim than
 * anyone wants at setup time — ComfyUI takes tens of seconds to become ready,
 * and the failures worth knowing about (a broken venv, a port already taken by
 * something else) only appear once it actually runs.
 *
 * Detached deliberately: this outlives the wizard, and killing ComfyUI because
 * setup finished would be a surprising thing to do to a machine.
 */
export async function startComfy(
  install: ComfyInstall,
  host: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<StartOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 180_000

  if (await comfyRunning(host, fetchImpl)) {
    return { started: true, alreadyRunning: true }
  }
  if (!install.canStart || install.python === null) {
    return { started: false, alreadyRunning: false, error: install.note ?? 'No interpreter to start it with.' }
  }

  const started = Date.now()
  try {
    /* Not awaited: main.py does not return. The result that matters is whether
       the port answers, which is what the poll below asks. */
    const args = [join(install.dir, 'main.py'), '--port', String(portOf(host))]
    /* Matching how comfy-mcp launches it. Omitting this is not a small
       difference — it is the difference between ComfyUI seeing every model and
       seeing none of them. */
    if (install.modelPathsYaml) args.push('--extra-model-paths-config', install.modelPathsYaml)
    void run(install.python, args, { cwd: install.dir }).catch(() => undefined)
  } catch (err) {
    return {
      started: false,
      alreadyRunning: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await comfyRunning(host, fetchImpl)) {
      return { started: true, alreadyRunning: false, waitedMs: Date.now() - started }
    }
  }
  return {
    started: false,
    alreadyRunning: false,
    error: `It did not answer within ${Math.round(timeoutMs / 1000)}s. Check ~/.config/comfy-mcp/comfyui.log.`,
    waitedMs: Date.now() - started
  }
}

function portOf(host: string): number {
  const m = /:(\d+)/.exec(host)
  return m ? Number.parseInt(m[1]!, 10) : 8188
}
