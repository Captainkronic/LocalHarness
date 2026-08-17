/**
 * Persistence for image-edit jobs: one JSON file, `<userData>/edit-jobs.json`,
 * with every job held in memory so `list()` and `get()` stay synchronous.
 *
 * Three rules shape this file:
 *
 *  - `sourceDataUrl` / `outputDataUrl` are never written. They are megabytes of
 *    base64 apiece and are re-derivable from `sourcePath` / `outputPath` at any
 *    time, so they are stripped on the way in — from the cached copy as well as
 *    from disk. That keeps memory flat and makes a live session behave exactly
 *    like one restored after a relaunch.
 *  - A status that only means something while work is in flight ('refining',
 *    'rendering') cannot survive a restart: nothing is running after a relaunch,
 *    so those jobs come back settled rather than spinning forever.
 *  - `get()` and `list()` hand out copies. Callers mutate what they are given
 *    and hand it back to `save()`, so the cache must not be reachable by
 *    reference.
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { EditJob, EditJobStatus, EditParams } from '@shared/types'

import { atomicWriteSync, expandTilde } from '../store/paths'

const FILE_NAME = 'edit-jobs.json'
/** Oldest jobs beyond this are dropped; the panel is a working set, not an archive. */
const MAX_JOBS = 200

/** comfy-image's own bounds. A value outside them is a server-side error, so
 *  clamp rather than persist something that can only fail later. */
const DENOISE_MIN = 0.1
const DENOISE_MAX = 1.0
const STEPS_MIN = 1
const STEPS_MAX = 60
const SEED_MAX = 0xffff_ffff

const STATUSES: readonly EditJobStatus[] = [
  'draft',
  'refining',
  'ready',
  'rendering',
  'done',
  'error'
]

/** What a job persisted mid-flight is told when it comes back from disk. */
const INTERRUPTED = 'Interrupted when LocalHarness quit; nothing was rendered.'

export class EditJobStore {
  private readonly file: string
  private readonly jobs = new Map<string, EditJob>()

  /** @param dir the app's userData directory. */
  constructor(dir: string) {
    this.file = join(expandTilde(dir), FILE_NAME)
    this.load()
  }

  /** Newest first. */
  list(): EditJob[] {
    return [...this.jobs.values()].sort(newestFirst).map(cloneJob)
  }

  get(id: string): EditJob | null {
    const job = this.jobs.get(id)
    return job === undefined ? null : cloneJob(job)
  }

  save(job: EditJob): void {
    if (!isSafeId(job.id)) {
      console.warn('[edit-jobs] refusing to save a job with an unusable id')
      return
    }
    this.jobs.set(job.id, forStorage(job))
    this.prune()
    this.write()
  }

  delete(id: string): void {
    if (!this.jobs.delete(id)) return
    this.write()
  }

  /* ---------------------------------------------------------------- */

  private prune(): void {
    if (this.jobs.size <= MAX_JOBS) return
    const ordered = [...this.jobs.values()].sort(newestFirst)
    for (const job of ordered.slice(MAX_JOBS)) this.jobs.delete(job.id)
  }

  private write(): void {
    const jobs = [...this.jobs.values()].sort(newestFirst)
    try {
      atomicWriteSync(this.file, JSON.stringify({ version: 1, jobs }, null, 2))
    } catch (err) {
      // Best-effort, like the conversation store: a disk error must not take
      // down a render that has already happened.
      console.warn('[edit-jobs] failed to write', this.file, err)
    }
  }

  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (!isMissingFile(err)) console.warn('[edit-jobs] cannot read', this.file, err)
      return
    }

    // Tolerates a bare array as well as the `{version, jobs}` envelope.
    const entries: unknown[] = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.jobs)
        ? raw.jobs
        : []

    for (const entry of entries) {
      const job = normalizeJob(entry)
      if (job !== null) this.jobs.set(job.id, job)
    }
    this.prune()
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                      */
/* ------------------------------------------------------------------ */

function normalizeJob(raw: unknown): EditJob | null {
  if (!isRecord(raw)) return null
  if (!isSafeId(raw.id)) return null

  const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath.trim() : ''
  if (sourcePath.length === 0) return null

  const createdAt = finiteOr(raw.createdAt, Date.now())
  const refinedPrompt =
    typeof raw.refinedPrompt === 'string' && raw.refinedPrompt.length > 0
      ? raw.refinedPrompt
      : null

  const job: EditJob = {
    id: raw.id,
    sourcePath,
    sourceName:
      typeof raw.sourceName === 'string' && raw.sourceName.length > 0
        ? raw.sourceName
        : basename(sourcePath),
    userInstruction: typeof raw.userInstruction === 'string' ? raw.userInstruction : '',
    refinedPrompt,
    promptEdited: raw.promptEdited === true,
    status: settle(asStatus(raw.status), refinedPrompt),
    params: normalizeParams(raw.params),
    createdAt,
    updatedAt: finiteOr(raw.updatedAt, createdAt)
  }

  if (typeof raw.outputPath === 'string' && raw.outputPath.length > 0) {
    job.outputPath = raw.outputPath
  }
  if (typeof raw.parentId === 'string' && raw.parentId.length > 0) {
    job.parentId = raw.parentId
  }

  const timings = normalizeTimings(raw.timings)
  if (timings !== null) job.timings = timings

  const error = typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : null
  // An in-flight status is rewritten below, and the note explaining that takes
  // precedence over whatever error the job was carrying beforehand.
  if (asStatus(raw.status) !== job.status) job.error = INTERRUPTED
  else if (error !== null) job.error = error

  // Any persisted data: URL (from an older file) is dropped rather than trusted;
  // previews are always re-derived from the paths.
  return job
}

/** 'refining' / 'rendering' cannot be true after a restart — settle them. */
function settle(status: EditJobStatus, refinedPrompt: string | null): EditJobStatus {
  if (status !== 'refining' && status !== 'rendering') return status
  return refinedPrompt === null ? 'draft' : 'ready'
}

function normalizeParams(raw: unknown): EditParams {
  const rec = isRecord(raw) ? raw : {}
  const params: EditParams = {
    denoise: clamp(finiteOr(rec.denoise, 0.6), DENOISE_MIN, DENOISE_MAX),
    steps: Math.round(clamp(finiteOr(rec.steps, 8), STEPS_MIN, STEPS_MAX))
  }
  if (typeof rec.seed === 'number' && Number.isFinite(rec.seed)) {
    params.seed = Math.round(clamp(rec.seed, 0, SEED_MAX))
  }
  return params
}

function normalizeTimings(raw: unknown): { refineMs?: number; renderMs?: number } | null {
  if (!isRecord(raw)) return null
  const timings: { refineMs?: number; renderMs?: number } = {}
  if (typeof raw.refineMs === 'number' && Number.isFinite(raw.refineMs)) {
    timings.refineMs = raw.refineMs
  }
  if (typeof raw.renderMs === 'number' && Number.isFinite(raw.renderMs)) {
    timings.renderMs = raw.renderMs
  }
  return timings.refineMs === undefined && timings.renderMs === undefined ? null : timings
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function cloneJob(job: EditJob): EditJob {
  const copy: EditJob = { ...job, params: { ...job.params } }
  if (job.timings) copy.timings = { ...job.timings }
  return copy
}

/**
 * The form a job is kept in: no data: URLs, and params put through the same
 * clamp `load()` applies, so a job read back from the cache is identical to the
 * same job read back from disk.
 */
function forStorage(job: EditJob): EditJob {
  const copy = cloneJob(job)
  delete copy.sourceDataUrl
  delete copy.outputDataUrl
  copy.params = normalizeParams(job.params)
  return copy
}

function newestFirst(a: EditJob, b: EditJob): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  // Stable tiebreak, so two jobs created in the same millisecond (a multi-file
  // pick) keep one order across reloads.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function asStatus(value: unknown): EditJobStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as EditJobStatus)
    : 'draft'
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function isMissingFile(err: unknown): boolean {
  return isRecord(err) && err.code === 'ENOENT'
}
