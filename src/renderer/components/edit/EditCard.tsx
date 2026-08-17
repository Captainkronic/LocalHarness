/**
 * One edit, as one grouped unit: source → prompt → result.
 *
 * The triptych is the deliverable of this workflow, so the three parts stay on
 * one row and only stack when the column is genuinely too narrow. That test is
 * a container query rather than a viewport one, because the centre column's
 * width depends on which side panels are open, not on the window.
 *
 * This module is also the leaf the other Edit components share — the image
 * resolver, the "local text, remote owner" input hook and the scroll helper all
 * live here, the same way GalleryPanel owns useArtifactSrc for AudioPanel.
 * Importing the other way round would make a cycle through EditWorkspace.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import type { EditJob, EditJobStatus } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename, formatMs, relativeTime, shortenPath } from '@renderer/lib/format'
import './edit.css'

/* ------------------------------------------------------------------ */
/* Shared: images off disk                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolved data URLs, kept across mounts so reopening a lightbox or scrolling a
 * card back into view does not pay another disk read and another base64 pass.
 * Capped because each entry is a whole image held as text.
 */
const SRC_CACHE = new Map<string, string>()
const SRC_CACHE_MAX = 16

function remember(path: string, src: string): void {
  SRC_CACHE.delete(path)
  SRC_CACHE.set(path, src)
  if (SRC_CACHE.size > SRC_CACHE_MAX) {
    const oldest = SRC_CACHE.keys().next().value
    if (oldest !== undefined) SRC_CACHE.delete(oldest)
  }
}

export interface ImageState {
  status: 'pending' | 'ready' | 'missing'
  src: string | null
}

function initialImageState(path: string | undefined, dataUrl: string | undefined): ImageState {
  if (dataUrl !== undefined && dataUrl !== '') return { status: 'ready', src: dataUrl }
  if (path !== undefined && path !== '') {
    const cached = SRC_CACHE.get(path)
    if (cached !== undefined) return { status: 'ready', src: cached }
    return { status: 'pending', src: null }
  }
  return { status: 'missing', src: null }
}

/**
 * A displayable source for an image that only exists as a path on disk. The
 * renderer cannot load file:// URLs, so main reads the bytes back for us; a job
 * that already carries a data URL skips the round trip entirely.
 */
export function useEditImage(
  path: string | undefined,
  dataUrl: string | undefined
): ImageState {
  const readImageDataUrl = useStore((s) => s.readImageDataUrl)
  const [state, setState] = useState<ImageState>(() => initialImageState(path, dataUrl))

  useEffect(() => {
    const immediate = initialImageState(path, dataUrl)
    setState(immediate)
    if (immediate.status !== 'pending' || path === undefined) return

    let cancelled = false
    // Promise.resolve so this holds whether the action is async or not.
    void Promise.resolve(readImageDataUrl(path)).then(
      (url) => {
        if (cancelled) return
        if (typeof url === 'string' && url.length > 0) {
          remember(path, url)
          setState({ status: 'ready', src: url })
        } else {
          setState({ status: 'missing', src: null })
        }
      },
      () => {
        if (!cancelled) setState({ status: 'missing', src: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [path, dataUrl, readImageDataUrl])

  return state
}

/** Skeleton while the bytes are in flight, an explicit failure when they never
 *  arrive — an <img> with no src reads as a design bug, not as a missing file. */
export function EditImage({
  state,
  alt,
  className
}: {
  state: ImageState
  alt: string
  className?: string
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [state.src])

  const cls = className === undefined ? 'ed-img' : `ed-img ${className}`

  if (state.status === 'pending') {
    return <span className={`${cls} ed-img-skeleton`} aria-label={`Loading ${alt}`} />
  }
  if (state.src === null || failed) {
    return (
      <span className={`${cls} ed-img-broken`} role="img" aria-label={`${alt} unavailable`}>
        could not be read from disk
      </span>
    )
  }
  return (
    <img className={cls} src={state.src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  )
}

/* ------------------------------------------------------------------ */
/* Shared: values main owns but the user types into                    */
/* ------------------------------------------------------------------ */

export interface SyncedValue<T> {
  value: T
  change: (next: T) => void
  /** Push a pending edit now — on blur, or before an action reads it in main. */
  flush: () => void
  /** Drop a pending edit without pushing it. */
  cancel: () => void
  /** Throw the local edit away and show what main actually holds. */
  reset: () => void
}

/**
 * A control whose value lives in the main process. Local while the user is
 * typing or dragging, pushed once they settle, and re-adopted when main's copy
 * changes underneath — but never while an edit is pending, or a refine landing
 * mid-sentence would yank the caret out from under them.
 */
export function useSyncedValue<T>(
  remote: T,
  commit: (next: T) => void,
  delayMs: number
): SyncedValue<T> {
  const [value, setValue] = useState<T>(remote)
  const valueRef = useRef<T>(remote)
  const remoteRef = useRef<T>(remote)
  const commitRef = useRef(commit)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    commitRef.current = commit
  })

  useEffect(() => {
    remoteRef.current = remote
    if (dirty.current) return
    setValue(remote)
    valueRef.current = remote
  }, [remote])

  const clear = useCallback((): void => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  useEffect(() => clear, [clear])

  const change = useCallback(
    (next: T): void => {
      setValue(next)
      valueRef.current = next
      dirty.current = true
      clear()
      timer.current = window.setTimeout(() => {
        dirty.current = false
        commitRef.current(next)
      }, delayMs)
    },
    [clear, delayMs]
  )

  const flush = useCallback((): void => {
    if (!dirty.current) return
    clear()
    dirty.current = false
    commitRef.current(valueRef.current)
  }, [clear])

  const cancel = useCallback((): void => {
    clear()
    dirty.current = false
  }, [clear])

  const reset = useCallback((): void => {
    clear()
    dirty.current = false
    setValue(remoteRef.current)
    valueRef.current = remoteRef.current
  }, [clear])

  return { value, change, flush, cancel, reset }
}

/* ------------------------------------------------------------------ */
/* Shared: jumping to a card                                           */
/* ------------------------------------------------------------------ */

export function cardDomId(jobId: string): string {
  return `edit-job-${jobId}`
}

/**
 * The feed and the right-hand panel are separate React trees whose only shared
 * state is the store, which this workflow does not own. The jump therefore goes
 * through the DOM rather than through a selection that does not exist.
 */
export function scrollToJob(jobId: string): void {
  const el = document.getElementById(cardDomId(jobId))
  if (el === null) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('is-flash')
  void el.offsetWidth // reflow, so clicking the same row twice re-runs it
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), 1400)
}

/* ------------------------------------------------------------------ */
/* Lightbox                                                            */
/* ------------------------------------------------------------------ */

function Lightbox({
  path,
  state,
  label,
  onClose
}: {
  path: string
  state: ImageState
  label: string
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="ed-lightbox" onMouseDown={onClose} role="presentation">
      <figure className="ed-lightbox-inner" onMouseDown={(e) => e.stopPropagation()}>
        {state.src !== null ? (
          <img className="ed-lightbox-img" src={state.src} alt={label} />
        ) : (
          <div className="ed-lightbox-missing">
            {state.status === 'pending'
              ? 'Reading the file…'
              : 'This image could not be read back from disk.'}
          </div>
        )}
        <figcaption className="ed-lightbox-bar">
          <div className="ed-lightbox-text">
            <span className="ed-lightbox-label">{label}</span>
            <span className="ed-lightbox-path" title={path}>
              {shortenPath(path, 4)}
            </span>
          </div>
          <div className="ed-lightbox-actions">
            <button type="button" className="btn btn-sm" onClick={() => revealPath(path)}>
              Reveal
            </button>
            <button type="button" className="btn btn-sm" onClick={() => openPath(path)}>
              Open
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </figcaption>
      </figure>
    </div>,
    document.body
  )
}

function revealPath(path: string): void {
  void window.harness.invoke('artifacts:reveal', path)
}

function openPath(path: string): void {
  void window.harness.invoke('artifacts:open', path)
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<EditJobStatus, string> = {
  draft: 'Draft',
  refining: 'Writing prompt',
  ready: 'Prompt ready',
  rendering: 'Rendering',
  done: 'Done',
  error: 'Failed'
}

const STATUS_DOT: Record<EditJobStatus, string> = {
  draft: '',
  refining: 'dot-busy',
  ready: 'dot-warn',
  rendering: 'dot-busy',
  done: 'dot-ok',
  error: 'dot-error'
}

/** Ticks while a job is busy. A two-minute wait with nothing moving reads as a
 *  hang, and there is no real progress to report — only elapsed time. */
function useElapsed(active: boolean, since: number): number {
  const [now, setNow] = useState(() => Date.now())
  const [start, setStart] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      setStart(null)
      return
    }
    // Latched once, from the timestamp of the transition into this stage: main
    // touches updatedAt on every push, and a counter that jumps back to zero
    // halfway through a render is worse than no counter at all.
    setStart((s) => s ?? since)
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
    // `since` is read at the moment the job goes busy and deliberately not
    // tracked after that, so it is not a dependency.
  }, [active])

  return start === null ? 0 : Math.max(0, now - start)
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface EditCardProps {
  job: EditJob
}

export function EditCard({ job }: EditCardProps): JSX.Element {
  const setEditPrompt = useStore((s) => s.setEditPrompt)
  const refineEdit = useStore((s) => s.refineEdit)
  const applyEdit = useStore((s) => s.applyEdit)
  const cancelEdit = useStore((s) => s.cancelEdit)
  const deleteEdit = useStore((s) => s.deleteEdit)
  const createEditFromPath = useStore((s) => s.createEditFromPath)

  const [lightbox, setLightbox] = useState<'source' | 'result' | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)

  const sourceImg = useEditImage(job.sourcePath, job.sourceDataUrl)
  const resultImg = useEditImage(job.outputPath, job.outputDataUrl)

  const busy = job.status === 'refining' || job.status === 'rendering'
  const elapsed = useElapsed(busy, job.updatedAt)

  const prompt = useSyncedValue(
    job.refinedPrompt ?? '',
    (next) => {
      void setEditPrompt(job.id, next)
    },
    350
  )

  useEffect(
    () => () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    },
    []
  )

  const hasPrompt = prompt.value.trim().length > 0
  const sourceName = job.sourceName !== '' ? job.sourceName : basename(job.sourcePath)
  // Bound as a const so the narrowing survives into the callbacks below.
  const outputPath = job.outputPath

  const copy = (): void => {
    navigator.clipboard.writeText(prompt.value).then(
      () => {
        setCopied(true)
        if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
      },
      () => setCopied(false)
    )
  }

  /** Re-refining overwrites the prompt, so a half-typed edit is dropped rather
   *  than pushed at a job that is about to replace it. */
  const rerefine = async (): Promise<void> => {
    prompt.cancel()
    await refineEdit(job.id)
  }

  /**
   * Main renders the prompt IT holds, so pending keystrokes have to land there
   * first — but only when the text really differs: setEditPrompt is what marks
   * a prompt hand-edited, and merely pressing Render must not claim that.
   */
  const render = async (): Promise<void> => {
    prompt.cancel()
    if (prompt.value !== (job.refinedPrompt ?? '')) {
      await setEditPrompt(job.id, prompt.value)
    }
    await applyEdit(job.id)
  }

  const editAgain = (): void => {
    if (outputPath === undefined) return
    void createEditFromPath(outputPath, job.id)
  }

  const parentId = job.parentId

  return (
    <article className="ed-card" id={cardDomId(job.id)} data-status={job.status}>
      <header className="ed-head">
        <span className="chip ed-status" data-status={job.status}>
          <span className={`dot ${STATUS_DOT[job.status]}`} />
          {STATUS_LABEL[job.status]}
        </span>

        {parentId !== undefined ? (
          <button
            type="button"
            className="chip ed-lineage"
            onClick={() => scrollToJob(parentId)}
            title="This started from another edit's result — jump to it"
          >
            <IterationIcon />
            iteration
          </button>
        ) : null}

        <span className="ed-head-time">{relativeTime(job.createdAt)}</span>

        <span className="ed-head-spacer" />

        <Timings job={job} />

        <button
          type="button"
          className="btn btn-sm btn-ghost btn-danger ed-icon-btn"
          onClick={() => void deleteEdit(job.id)}
          title="Remove this edit from the feed"
          aria-label="Remove this edit"
        >
          <TrashIcon />
        </button>
      </header>

      <div className="ed-row">
        {/* --- source --- */}
        <figure className="ed-col ed-col-shot">
          <span className="section-label">Source</span>
          <button
            type="button"
            className="ed-shot"
            onClick={() => setLightbox('source')}
            title="Open larger"
          >
            <EditImage state={sourceImg} alt={sourceName} />
          </button>
          <figcaption className="ed-file" title={job.sourcePath}>
            {sourceName}
          </figcaption>
        </figure>

        <ArrowIcon />

        {/* --- prompt --- */}
        <div className="ed-col ed-col-prompt">
          <span className="section-label">What you asked for</span>
          <p className="ed-said">
            {job.userInstruction.trim() === '' ? 'Nothing typed.' : job.userInstruction}
          </p>

          <div className="ed-prompt-head">
            <span className="section-label">Render prompt</span>
            {job.promptEdited ? <span className="chip ed-edited">hand-edited</span> : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost ed-copy"
              onClick={copy}
              disabled={!hasPrompt}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          {job.refinedPrompt === null && !hasPrompt ? (
            <p className="ed-prompt-empty">
              {job.status === 'refining'
                ? 'The model is looking at the photo and writing it now.'
                : 'No prompt yet — refine to write one from your words.'}
            </p>
          ) : (
            <textarea
              className="ed-prompt"
              aria-label="Render prompt"
              spellCheck={false}
              value={prompt.value}
              onChange={(e) => prompt.change(e.target.value)}
              onBlur={prompt.flush}
            />
          )}

          <p className="ed-prompt-note">
            This text is handed to the renderer verbatim. It describes the finished
            image, not the change — edit it freely before rendering.
          </p>

          <div className="ed-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void rerefine()}
              disabled={busy}
              title="Look at the photo again and rewrite the prompt from your words"
            >
              Re-refine
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void render()}
              disabled={!hasPrompt || busy}
              title={hasPrompt ? 'Render this prompt over the source' : 'Refine a prompt first'}
            >
              Render edit
            </button>
          </div>

          <Params job={job} />
        </div>

        <ArrowIcon />

        {/* --- result --- */}
        <figure className="ed-col ed-col-shot">
          <span className="section-label">Result</span>
          {outputPath !== undefined ? (
            <>
              <button
                type="button"
                className="ed-shot"
                onClick={() => setLightbox('result')}
                title="Open larger"
              >
                <EditImage state={resultImg} alt={`Result of ${sourceName}`} />
              </button>
              <figcaption className="ed-file" title={outputPath}>
                {basename(outputPath)}
              </figcaption>
              <div className="ed-col-actions">
                <button type="button" className="btn btn-sm" onClick={() => revealPath(outputPath)}>
                  Reveal
                </button>
                <button type="button" className="btn btn-sm" onClick={() => openPath(outputPath)}>
                  Open
                </button>
                <button type="button" className="btn btn-sm ed-again" onClick={editAgain}>
                  Edit this again
                </button>
              </div>
            </>
          ) : (
            <span className="ed-shot-empty">
              {job.status === 'rendering' ? 'rendering…' : 'nothing rendered yet'}
            </span>
          )}
        </figure>
      </div>

      {busy ? (
        <div className="ed-progress" role="status">
          <span className="ed-progress-bar" aria-hidden="true" />
          <span className="ed-progress-text">
            {job.status === 'refining'
              ? 'Reading the photo and writing the render prompt on the Mac Studio.'
              : 'Rendering on the Mac Studio — this takes 1–2 minutes.'}
          </span>
          <span className="ed-progress-elapsed tnum">{formatMs(elapsed)}</span>
          <button type="button" className="btn btn-sm" onClick={() => void cancelEdit(job.id)}>
            Cancel
          </button>
        </div>
      ) : null}

      {job.status === 'error' ? (
        <div className="ed-error" role="alert">
          <pre className="ed-error-msg">{job.error ?? 'The job failed without a message.'}</pre>
          <div className="ed-actions">
            {/* Which stage failed is not on the job, so retry the one that is
                actually outstanding: no prompt means stage 1 never finished. */}
            {job.refinedPrompt === null ? (
              <button type="button" className="btn btn-sm" onClick={() => void rerefine()}>
                Retry refine
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void render()}>
                Retry render
              </button>
            )}
          </div>
        </div>
      ) : null}

      {lightbox === 'source' ? (
        <Lightbox
          path={job.sourcePath}
          state={sourceImg}
          label={sourceName}
          onClose={() => setLightbox(null)}
        />
      ) : null}
      {lightbox === 'result' && outputPath !== undefined ? (
        <Lightbox
          path={outputPath}
          state={resultImg}
          label={basename(outputPath)}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </article>
  )
}

/* ------------------------------------------------------------------ */
/* Card pieces                                                         */
/* ------------------------------------------------------------------ */

function Timings({ job }: { job: EditJob }): JSX.Element | null {
  const refineMs = job.timings?.refineMs
  const renderMs = job.timings?.renderMs
  if (refineMs === undefined && renderMs === undefined) return null
  return (
    <span className="ed-timings tnum">
      {refineMs !== undefined ? (
        <span>
          refine <b>{formatMs(refineMs)}</b>
        </span>
      ) : null}
      {renderMs !== undefined ? (
        <span>
          render <b>{formatMs(renderMs)}</b>
        </span>
      ) : null}
    </span>
  )
}

function Params({ job }: { job: EditJob }): JSX.Element {
  const { denoise, steps, seed } = job.params
  return (
    <p className="ed-params tnum">
      <span className="ed-params-k">{job.status === 'done' ? 'Rendered with' : 'Will render with'}</span>
      <span>
        denoise <b>{denoise.toFixed(2)}</b>
      </span>
      <span>
        steps <b>{steps}</b>
      </span>
      <span>
        seed <b>{seed === undefined ? 'random' : seed}</b>
      </span>
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** The join between the three parts. Rotated to point down when stacked. */
function ArrowIcon(): JSX.Element {
  return (
    <span className="ed-arrow" aria-hidden="true">
      <Svg>
        <path d="M2.5 8h11M10 4.5 13.5 8 10 11.5" />
      </Svg>
    </span>
  )
}

function IterationIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.2v3h-3" />
    </Svg>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M3 4.5h10M6.4 4.5V3h3.2v1.5" />
      <path d="M4.6 4.5l.55 8a1 1 0 0 0 1 .95h3.7a1 1 0 0 0 1-.95l.55-8" />
    </Svg>
  )
}

export default EditCard
