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

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  Avatar,
  AvatarFrame,
  AvatarBuildSpec,
  AvatarBuildProgress
} from '@shared/types'
import { AVATAR_BASE_PROMPT_HINT, AVATAR_FRAME_SPECS } from '@shared/avatar'

import type { McpManager } from '../mcp/manager'
import type { LogFn } from '../mcp/manager'
import type { AvatarStore } from '../store/avatars'

const COMFY_SERVER_ID = 'comfy-image'

/** Frames worth waiting for before the extras. Order is the build order, and
 *  it is deliberate: the mouth is what makes the avatar work at all. */
const ESSENTIAL: readonly AvatarFrame[] = ['mouthSlight', 'mouthMid', 'mouthWide', 'blink']

export interface AvatarBuilderOptions {
  mcp: McpManager
  store: AvatarStore
  onProgress: (p: AvatarBuildProgress) => void
  onLog: LogFn
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
      const base = await this.callImage('generate_image', {
        prompt,
        quality: 'balanced',
        width: 1024,
        height: 1024,
        output_dir: dir,
        confirm: true
      })
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
      for (let i = 0; i < wanted.length; i++) {
        if (this.cancelled) {
          report(i + 1, 'Cancelled', 'cancelled')
          return avatar
        }
        const frameSpec = wanted[i]
        report(i + 1, frameSpec.label, 'working')

        const path = await this.callImage('edit_image', {
          instruction: frameSpec.instruction,
          source: base,
          confirm: true,
          output_dir: dir
        })
        if (path === null) {
          // One bad frame is not a failed avatar. AvatarStage steps down the
          // mouth ladder, so the set stays usable without it.
          this.o.onLog('warn', 'avatar', `${frameSpec.label} did not render; skipping it.`)
          report(i + 1, `${frameSpec.label} — skipped`, 'error')
          continue
        }
        avatar = this.o.store.save({
          ...avatar,
          frames: { ...avatar.frames, [frameSpec.frame]: path }
        })
        report(i + 1, frameSpec.label, 'saved')
      }

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

  /* ---------------------------------------------------------------- */

  /** Calls a comfy-image tool and returns the path it wrote, or null. */
  private async callImage(
    tool: string,
    args: Record<string, unknown>
  ): Promise<string | null> {
    const state = this.o.mcp.states().find((s) => s.id === COMFY_SERVER_ID)
    if (state === undefined || state.status !== 'ready') {
      throw new Error(
        `The ${COMFY_SERVER_ID} server is ${state?.status ?? 'not in the registry'}. ` +
          'Start it from the MCP panel and try again.'
      )
    }
    const entry = state.tools.find((t) => t.name === tool)
    if (entry === undefined) {
      throw new Error(`${COMFY_SERVER_ID} exposes no ${tool} tool.`)
    }
    // The manager rewrites names the OpenAI grammar rejects, so resolve from
    // what it reports rather than assuming the wire name.
    const wire =
      this.o.mcp.wireTools().find((t) => t.function.name.endsWith(`__${tool}`))?.function.name ??
      entry.qualifiedName

    const result = await this.o.mcp.callTool(wire, args)
    if (result.isError) throw new Error(result.text.trim() || `${tool} reported an error.`)

    const image = result.artifacts.find((a) => a.kind === 'image' && typeof a.path === 'string')
    return (image?.path as string | undefined) ?? null
  }
}
