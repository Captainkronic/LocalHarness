/**
 * Saved avatars for Live.
 *
 * Same shape as the artifact store and for the same reason: an avatar is
 * expensive to make — a base render plus one edit per frame, several minutes of
 * GPU — so losing the set on a restart would mean rebuilding it, and nobody
 * would use the feature twice.
 *
 * Only paths are stored. The frames live wherever ComfyUI wrote them, and the
 * renderer reads them back through main as data URLs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Avatar, AvatarFrame } from '@shared/types'
import { AVATAR_FRAMES } from '@shared/types'

import { atomicWriteSync, expandTilde } from './paths'

const FILE_NAME = 'avatars.json'

export class AvatarStore {
  private readonly file: string
  private readonly avatars = new Map<string, Avatar>()

  /** @param dir the app's userData directory. */
  constructor(dir: string) {
    this.file = join(expandTilde(dir), FILE_NAME)
    this.load()
  }

  /** Newest first. */
  list(): Avatar[] {
    return [...this.avatars.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Avatar | null {
    return this.avatars.get(id) ?? null
  }

  save(avatar: Avatar): Avatar {
    const stored: Avatar = { ...avatar, updatedAt: Date.now() }
    this.avatars.set(stored.id, stored)
    this.write()
    return stored
  }

  delete(id: string): void {
    if (!this.avatars.delete(id)) return
    this.write()
  }

  /* ---------------------------------------------------------------- */

  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!isRecord(raw) || !Array.isArray(raw.avatars)) return
    for (const entry of raw.avatars) {
      const avatar = normalize(entry)
      if (avatar !== null) this.avatars.set(avatar.id, avatar)
    }
  }

  private write(): void {
    try {
      atomicWriteSync(
        this.file,
        JSON.stringify({ version: 1, avatars: this.list() }, null, 2)
      )
    } catch (err) {
      console.warn('[avatars] could not persist:', err)
    }
  }
}

/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Frames whose file has gone are dropped, and an avatar with no `rest` frame is
 * dropped entirely — it has no face to show, so offering it in a picker would
 * only produce an empty stage the user cannot diagnose.
 */
function normalize(raw: unknown): Avatar | null {
  if (!isRecord(raw)) return null
  const { id, name, basePrompt } = raw
  if (typeof id !== 'string' || id === '') return null
  if (!isRecord(raw.frames)) return null

  const frames: Partial<Record<AvatarFrame, string>> = {}
  for (const frame of AVATAR_FRAMES) {
    const path = raw.frames[frame]
    if (typeof path === 'string' && path !== '' && existsSync(path)) frames[frame] = path
  }
  if (frames.rest === undefined) return null

  return {
    id,
    name: typeof name === 'string' && name !== '' ? name : 'Avatar',
    basePrompt: typeof basePrompt === 'string' ? basePrompt : '',
    frames,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}
