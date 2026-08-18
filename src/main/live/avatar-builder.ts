/**
 * Builds an avatar: one base portrait, then one edit per frame.
 *
 * This is a long job — a generation plus six edits, roughly ten to twelve
 * minutes of GPU — and that shapes every decision here.
 *
 * **It saves after every step.** A twelve-minute job that yields nothing when
 * the seventh render fails is a job nobody runs twice. The avatar exists and is
 * selectable the moment the base portrait lands; each frame that follows makes
 * it better. AvatarStage already degrades down the mouth ladder, so a set that
 * stopped after three frames animates rather than breaks.
 *
 * **It reports every step.** Ten minutes with no output is indistinguishable
 * from a hang, and the user has no other way to see that ComfyUI is working.
 *
 * **Cancelling stops the QUEUE, not the render.** A dispatched ComfyUI job
 * finishes whatever we do; all this can do is stop asking for more and keep
 * what already landed. Said plainly rather than pretending otherwise.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type {
  Avatar,
  AvatarFrame,
  AvatarBuildSpec,
  AvatarBuildProgress
} from '@shared/types'
import { AVATAR_BASE_PROMPT_HINT, AVATAR_FRAME_SPECS } from '@shared/avatar'

import type { LogFn } from '../mcp/manager'
import type { AvatarStore } from '../store/avatars'

const execFileAsync = promisify(execFile)

/**
 * The comfy-image command line, not its MCP tools.
 *
 * The MCP route looked obvious and is wrong here. MCP servers are started per
 * WORKFLOW, and Live runs fastfacts and gmail — not comfy-image — so a build
 * started from Live would have found no tool at all. Adding comfy-image to
 * Live's set would fix that by putting its 3,007 tokens of schema on every
 * message of every call, to serve a button pressed once.
 *
 * The CLI has none of that coupling: it imports the same server module and
 * calls the same functions, starts ComfyUI itself if nothing is listening, and
 * does not care which workflow is on screen. This is the app doing a job, not a
 * model calling a tool, so it belongs on the side MCP is not on.
 */
const COMFY_CLI = join(homedir(), '.config', 'comfy-mcp', 'comfy-image')

/** Long enough for a cold start plus a render; the CLI's own timeout is 900s. */
const RENDER_TIMEOUT_MS = 960_000

/** Frames worth waiting for before the extras. Order is the build order, and
 *  it is deliberate: the mouth is what makes the avatar work at all. */
const ESSENTIAL: readonly AvatarFrame[] = ['mouthSlight', 'mouthMid', 'mouthWide', 'blink']

export interface AvatarBuilderOptions {
  store: AvatarStore
  onProgress: (p: AvatarBuildProgress) => void
  onLog: LogFn
  /** Runs the comfy-image CLI and returns its stdout. Injectable so the build
   *  ORDER can be tested without a quarter of an hour of GPU per run. */
  run?: (args: string[]) => Promise<string>
}

export class AvatarBuilder {
  private readonly o: AvatarBuilderOptions
  private cancelled = false
  private building = false

  constructor(opts: AvatarBuilderOptions) {
    this.o = opts
  }

  isBuilding(): boolean {
    return this.building
  }

  cancel(): void {
    if (!this.building) return
    this.cancelled = true
    this.o.onLog(
      'info',
      'avatar',
      'Build cancelled. The render already sent to ComfyUI will finish on its own; ' +
        'no further frames will be requested.'
    )
  }

  async build(spec: AvatarBuildSpec): Promise<Avatar | null> {
    if (this.building) {
      this.o.onLog('warn', 'avatar', 'A build is already running.')
      return null
    }
    this.building = true
    this.cancelled = false

    const id = randomUUID()
    const wanted = spec.includeExtras
      ? AVATAR_FRAME_SPECS
      : AVATAR_FRAME_SPECS.filter((s) => ESSENTIAL.includes(s.frame))
    const total = wanted.length + 1
    const dir = join(homedir(), 'Documents', 'llm-avatars', id)

    const report = (
      step: number,
      label: string,
      status: AvatarBuildProgress['status'],
      error?: string
    ): void => this.o.onProgress({ avatarId: id, step, total, label, status, error })

    try {
      await mkdir(dir, { recursive: true })

      /* ---- the base portrait ---- */
      report(0, 'Painting the portrait', 'working')
      const prompt = `${spec.description.trim()}. ${AVATAR_BASE_PROMPT_HINT}`
      const base = await this.callImage('generate', [
        prompt,
        '--quality', 'balanced',
        '--out', dir
      ])
      if (base === null) {
        report(0, 'Painting the portrait', 'error', 'The portrait did not render.')
        return null
      }

      let avatar: Avatar = {
        id,
        name: spec.name.trim() || 'Avatar',
        basePrompt: prompt,
        frames: { rest: base },
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      // Saved here, so the avatar is selectable before any frame exists. It
      // will not move its mouth yet, but it is a face and it is hers.
      avatar = this.o.store.save(avatar)
      report(1, 'Portrait ready', 'saved')

      /* ---- one edit per frame ---- */
      avatar = await this.renderFrames(avatar, base, wanted, report)
      report(total, 'Done', 'done')
      return avatar
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.o.onLog('error', 'avatar', `build failed: ${message}`)
      report(0, 'Failed', 'error', message)
      return null
    } finally {
      this.building = false
      this.cancelled = false
    }
  }

  /**
   * Fills in whatever frames an existing avatar is missing.
   *
   * A twelve-minute job gets interrupted — the app is quit, the machine
   * sleeps, someone reinstalls mid-build — and without this the only remedy is
   * to throw away the frames that did land and start again. Which nobody does,
   * so they live with a two-frame face that barely moves.
   */
  async finish(avatarId: string): Promise<Avatar | null> {
    if (this.building) {
      this.o.onLog('warn', 'avatar', 'A build is already running.')
      return null
    }
    const existing = this.o.store.get(avatarId)
    if (existing === null) return null
    const base = existing.frames.rest
    if (base === undefined) return null

    const missing = AVATAR_FRAME_SPECS.filter((spec) => existing.frames[spec.frame] === undefined)
    if (missing.length === 0) return existing

    this.building = true
    this.cancelled = false
    const total = missing.length
    const report = (
      step: number,
      label: string,
      status: AvatarBuildProgress['status'],
      error?: string
    ): void => this.o.onProgress({ avatarId, step, total, label, status, error })

    try {
      const done = await this.renderFrames(existing, base, missing, report, 0)
      report(total, 'Done', 'done')
      return done
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.o.onLog('error', 'avatar', `finish failed: ${message}`)
      report(0, 'Failed', 'error', message)
      return this.o.store.get(avatarId)
    } finally {
      this.building = false
      this.cancelled = false
    }
  }

  /**
   * Renders a list of frames onto an avatar, saving after each one.
   *
   * `offset` shifts the reported step numbers, because a fresh build counts the
   * base portrait as step zero and a resume does not.
   */
  private async renderFrames(
    avatar: Avatar,
    base: string,
    specs: readonly (typeof AVATAR_FRAME_SPECS)[number][],
    report: (
      step: number,
      label: string,
      status: AvatarBuildProgress['status'],
      error?: string
    ) => void,
    offset = 1
  ): Promise<Avatar> {
    let current = avatar
    for (let i = 0; i < specs.length; i++) {
      if (this.cancelled) {
        report(i + offset, 'Cancelled', 'cancelled')
        return current
      }
      const spec = specs[i]
      report(i + offset, spec.label, 'working')

      const path = await this.callImage('edit', [base, spec.instruction, '--out', dirOf(base)])
      if (path === null) {
        // One bad frame is not a failed avatar. AvatarStage steps down the
        // mouth ladder, so the set stays usable without it.
        this.o.onLog('warn', 'avatar', `${spec.label} did not render; skipping it.`)
        report(i + offset, `${spec.label} — skipped`, 'error')
        continue
      }
      current = this.o.store.save({
        ...current,
        frames: { ...current.frames, [spec.frame]: path }
      })
      report(i + offset, spec.label, 'saved')
    }
    return current
  }

  /* ---------------------------------------------------------------- */

  /** Runs the CLI and returns the path it wrote, or null. */
  private async callImage(
    tool: 'generate' | 'edit',
    args: string[]
  ): Promise<string | null> {
    const run =
      this.o.run ??
      (async (argv: string[]): Promise<string> => {
        const { stdout } = await execFileAsync(COMFY_CLI, argv, {
          timeout: RENDER_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          // Elicitation cannot reach a non-interactive process, so the CLI must
          // not try to ask. The user already approved by pressing Build.
          env: { ...process.env, COMFY_ASK_MODEL: '0' }
        })
        return stdout
      })

    const stdout = await run([tool, ...args])
    // The CLI prints the destination it actually used, which is the only
    // reliable source — it may differ from --out when a name collides.
    const match = /^Full path:\s*(.+)$/m.exec(stdout)
    return match?.[1]?.trim() ?? null
  }
}

/** The folder a frame lives in, so resumed frames land beside the originals. */
function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/')) || '.'
}
