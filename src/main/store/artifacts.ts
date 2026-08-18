/**
 * The gallery, kept across restarts.
 *
 * Artifacts used to live in a `Map<WorkflowId, Artifact[]>` on the orchestrator,
 * which meant the right-hand panel emptied every time the app quit. That is
 * wrong for what the panel actually is: a record of everything this machine has
 * rendered, which is worth more the longer it runs. A render costs one to two
 * minutes of the whole GPU, so losing the index of them on a restart throws away
 * real work — the files were still on disk, just no longer findable from here.
 *
 * Two decisions worth stating.
 *
 * **Only the reference is stored, never the bytes.** An artifact is a path plus
 * a label; the panel asks main for a data URL when it needs to draw one. So this
 * file stays small — a few hundred bytes per entry — and thousands of entries
 * cost less disk than one PNG.
 *
 * **Entries whose file has gone are dropped on load.** A gallery that lists
 * images you cannot open is worse than a shorter one: every dead row is a click
 * that fails. Pruning only ever removes things the user themselves deleted, and
 * it is logged rather than silent.
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Artifact, WorkflowId } from '@shared/types'

import { atomicWriteSync, expandTilde } from './paths'

const FILE_NAME = 'artifacts.json'

/**
 * Per workflow, not in total. Generous because an entry is a path and a label,
 * not an image — at roughly 200 bytes each this is a file of a few hundred
 * kilobytes at the cap, and Adam asked for a history that grows.
 */
const MAX_PER_WORKFLOW = 2000

export class ArtifactStore {
  private readonly file: string
  private readonly byWorkflow = new Map<WorkflowId, Artifact[]>()
  /** Reported once by the owner after construction, so the count is visible. */
  private prunedOnLoad = 0

  /** @param dir the app's userData directory. */
  constructor(dir: string) {
    this.file = join(expandTilde(dir), FILE_NAME)
    this.load()
  }

  /** Newest first, as recorded. */
  list(workflowId: WorkflowId): Artifact[] {
    return [...(this.byWorkflow.get(workflowId) ?? [])]
  }

  /**
   * Newest first, and de-duplicated by id so a re-emitted artifact does not
   * appear twice after a reload.
   */
  add(workflowId: WorkflowId, artifact: Artifact): void {
    const list = this.byWorkflow.get(workflowId) ?? []
    const existing = list.findIndex((a) => a.id === artifact.id)
    if (existing !== -1) list.splice(existing, 1)
    list.unshift(artifact)
    this.byWorkflow.set(workflowId, list.slice(0, MAX_PER_WORKFLOW))
    this.write()
  }

  /** How many dead entries the last load dropped, then resets to zero. */
  takePrunedCount(): number {
    const n = this.prunedOnLoad
    this.prunedOnLoad = 0
    return n
  }

  /* ---------------------------------------------------------------- */

  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // No file yet, or an unreadable one. Either way this is a fresh gallery,
      // never a crash on boot.
      return
    }
    if (!isRecord(raw) || !isRecord(raw.byWorkflow)) return

    for (const [workflowId, value] of Object.entries(raw.byWorkflow)) {
      if (!Array.isArray(value)) continue
      const kept: Artifact[] = []
      for (const entry of value) {
        const artifact = normalize(entry)
        if (artifact === null) continue
        // A URL-only artifact has nothing on disk to check.
        if (artifact.path !== undefined && !existsSync(artifact.path)) {
          this.prunedOnLoad++
          continue
        }
        kept.push(artifact)
      }
      if (kept.length > 0) {
        this.byWorkflow.set(workflowId as WorkflowId, kept.slice(0, MAX_PER_WORKFLOW))
      }
    }

    // Make the prune durable. Without this the dead entries stay in the file
    // until the next add() happens to rewrite it, so every launch in between
    // re-discovers and re-reports the same ones — a log line that cries wolf on
    // every boot is one nobody reads.
    if (this.prunedOnLoad > 0) this.write()
  }

  private write(): void {
    const byWorkflow: Record<string, Artifact[]> = {}
    for (const [id, list] of this.byWorkflow) byWorkflow[id] = list
    try {
      atomicWriteSync(this.file, JSON.stringify({ version: 1, byWorkflow }, null, 2))
    } catch (err) {
      // Losing the gallery index is not worth taking the app down for.
      console.warn('[artifacts] could not persist:', err)
    }
  }
}

/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Anything not shaped like an artifact is dropped rather than trusted. This file
 * is user-writable and survives upgrades, so it is the one place a malformed
 * entry could otherwise reach the renderer.
 */
function normalize(raw: unknown): Artifact | null {
  if (!isRecord(raw)) return null
  const { id, kind, label } = raw
  if (typeof id !== 'string' || id === '') return null
  if (typeof kind !== 'string' || kind === '') return null
  if (typeof label !== 'string') return null

  // createdAt orders the gallery, so a missing one is filled rather than
  // dropped — an entry with no timestamp is still an image worth showing.
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  const artifact: Artifact = { id, kind: kind as Artifact['kind'], label, createdAt }
  if (typeof raw.path === 'string' && raw.path !== '') artifact.path = raw.path
  if (typeof raw.url === 'string' && raw.url !== '') artifact.url = raw.url
  if (typeof raw.mimeType === 'string') artifact.mimeType = raw.mimeType
  if (typeof raw.parentId === 'string') artifact.parentId = raw.parentId
  if (isRecord(raw.meta)) {
    const meta: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(raw.meta)) {
      if (typeof v === 'string' || typeof v === 'number') meta[k] = v
    }
    artifact.meta = meta
  }
  // Neither a path nor a URL means nothing can ever be shown for it.
  return artifact.path === undefined && artifact.url === undefined ? null : artifact
}
