/**
 * Turn the bundled payload into working MCP servers on this machine.
 *
 * The servers ship as source plus a requirements.txt, never as virtualenvs,
 * because a virtualenv is not portable: `pyvenv.cfg` names an absolute
 * interpreter path and the console scripts carry the building machine's
 * username in their shebangs. So the environments are built here, on arrival,
 * against the relocatable Python that ships alongside them.
 *
 * Servers are installed into Application Support rather than inside the .app.
 * The installer replaces the bundle wholesale on upgrade, and an environment
 * that took two minutes to build should not be destroyed by that — nor should
 * a credentials file the user typed in.
 */

import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ProvisionProgress, ProvisionResult } from '@shared/setup'

const run = promisify(execFile)

export interface ServerManifestEntry {
  id: string
  tier: 'core' | 'optional'
  deps: boolean
  /** True when the dependencies are too large to ship and are fetched later. */
  depsOnDemand: boolean
  requirements: string | null
  entry: string
}



/**
 * Where the bundled payload lives.
 *
 * Packaged, `extraResources` puts it beside the asar. In development it is the
 * `resources/` directory the build scripts populate. Both are checked rather
 * than branching on `app.isPackaged`, so running a packaged build from a
 * checkout still finds something.
 */
export function resourcesRoot(resourcesPath: string, repoRoot: string): string {
  if (existsSync(join(resourcesPath, 'mcp', 'manifest.json'))) return resourcesPath
  return join(repoRoot, 'resources')
}

export function bundledPython(resources: string): string {
  return join(resources, 'runtime', 'python', 'bin', 'python3')
}

export function readManifest(resources: string): ServerManifestEntry[] {
  const file = join(resources, 'mcp', 'manifest.json')
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')) as ServerManifestEntry[]
}

/**
 * Install the chosen servers.
 *
 * Each is independent: one failing does not stop the others, because a broken
 * docgen is no reason to leave the browser tools uninstalled. Failures are
 * collected and reported together so the wizard can show what did and did not
 * work rather than dying on the first problem.
 */
export async function provision(
  ids: string[],
  opts: { resources: string; installRoot: string; onProgress?: (p: ProvisionProgress) => void }
): Promise<ProvisionResult> {
  const { resources, installRoot, onProgress } = opts
  const manifest = readManifest(resources)
  const python = bundledPython(resources)
  const wheels = join(resources, 'wheels')
  const installed: string[] = []
  const failed: { id: string; error: string }[] = []

  mkdirSync(installRoot, { recursive: true })

  for (const id of ids) {
    const entry = manifest.find((m) => m.id === id)
    if (!entry) {
      failed.push({ id, error: 'not in the bundled manifest' })
      onProgress?.({ id, phase: 'failed', error: 'not in the bundled manifest' })
      continue
    }

    const src = join(resources, 'mcp', id)
    const dest = join(installRoot, id)

    try {
      onProgress?.({ id, phase: 'copying' })
      /* Copied rather than run from the bundle: several servers write beside
         their own source (caches, captured output), and the app bundle is
         replaced on upgrade. */
      mkdirSync(dest, { recursive: true })
      cpSync(src, dest, { recursive: true })

      if (entry.requirements && !entry.depsOnDemand) {
        onProgress?.({ id, phase: 'creating-env' })
        await run(python, ['-m', 'venv', join(dest, 'venv')])

        onProgress?.({ id, phase: 'installing' })
        /* --no-index is not an optimisation. It is the assertion that this
           install is genuinely offline: if a requirement is missing from the
           wheelhouse the build should fail here, loudly, rather than silently
           reaching for PyPI and producing a machine that only worked because
           it happened to have a network. */
        await run(join(dest, 'venv', 'bin', 'python'), [
          '-m', 'pip', 'install', '--quiet', '--no-index',
          '--find-links', wheels,
          '-r', join(dest, entry.requirements)
        ])
      }

      installed.push(id)
      onProgress?.({ id, phase: 'done' })
    } catch (err) {
      const error = messageOf(err)
      failed.push({ id, error })
      onProgress?.({ id, phase: 'failed', error })
    }
  }

  return { installed, failed, root: installRoot }
}

/**
 * pip's useful output is on stderr and its last lines are the ones that say
 * what went wrong; the stack above them is noise in a wizard.
 */
function messageOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'stderr' in err) {
    const text = String((err as { stderr: unknown }).stderr).trim()
    if (text !== '') return text.split('\n').slice(-3).join(' ').slice(0, 300)
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * The command and args to launch an installed server.
 *
 * The registry's baked-in `~/.config/<id>-mcp` paths describe the development
 * machine, not an installed one, so resolution goes through here instead.
 */
export function launchSpec(
  installRoot: string,
  resources: string,
  entry: ServerManifestEntry
): { command: string; args: string[] } {
  const dir = join(installRoot, entry.id)
  const venvPython = join(dir, 'venv', 'bin', 'python')
  return {
    /* A server with no dependencies has no venv and runs on the bundled
       interpreter directly — seven of the twelve are pure standard library. */
    command: existsSync(venvPython) ? venvPython : bundledPython(resources),
    args: [join(dir, entry.entry)]
  }
}
