/**
 * Where an edit starts: a photo, a sentence, and the three knobs the renderer
 * actually honours.
 *
 * A draft job exists in main the moment a file is attached, so everything here
 * writes straight through to it rather than holding a private form. Picking
 * several files makes several drafts; the strip along the top steps through
 * them, since each one wants its own instruction.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'

import type { EditJob, EditMethod } from '@shared/types'
import { EDIT_IMAGE_EXTENSIONS, EDIT_METHOD_DEFAULTS } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename } from '@renderer/lib/format'
import { EditImage, useEditImage, useSyncedValue } from './EditCard'
import './edit.css'

/**
 * Derived from the shared allow-list so the drop zone cannot accept a file the
 * pipeline will reject. It previously took heic/avif/tiff, which the pipeline
 * refuses — and the refusal had nowhere to surface, so dropping an iPhone photo
 * did nothing at all.
 */
const IMAGE_RE = new RegExp(`\\.(${EDIT_IMAGE_EXTENSIONS.join('|')})$`, 'i')

/**
 * The two methods, in the words that matter to someone deciding between them.
 *
 * Deliberately phrased by what they DO to the photograph rather than by their
 * mechanism: "reference latent" and "img2img" are the right names but the wrong
 * question. The mechanism is in the note underneath, for when he wants it.
 */
const METHOD_COPY: Record<EditMethod, { label: string; hint: string; note: string }> = {
  instruction: {
    label: 'Instruction edit',
    hint: 'changes one thing, keeps the rest',
    note:
      'The renderer is handed your photo as well as your words, so it can change what you named and hold everything else. Ask for one thing at a time and it will stay a photograph of the same place.'
  },
  restyle: {
    label: 'Restyle',
    hint: 'reworks the whole frame',
    note:
      'The renderer re-paints a blurred copy of the photo against a description of the finished scene. It has no idea which part you meant, so everything is in play — right for “make this a watercolour”, wrong for “change the bowl and leave my dog alone”. Denoise is how much of the original survives.'
  }
}

/** Plain English for the one knob that decides how much of the photo survives. */
const DENOISE_SCALE: Array<{ upTo: number; label: string }> = [
  { upTo: 0.25, label: 'barely touches the photo' },
  { upTo: 0.4, label: 'keeps almost all of it' },
  { upTo: 0.6, label: 'keeps the composition, reworks the surface' },
  { upTo: 0.75, label: 'a real edit — framing and pose survive' },
  { upTo: 0.9, label: 'reinvents most of the frame' },
  { upTo: 1.01, label: 'all but ignores the original' }
]

function denoiseLabel(d: number): string {
  return DENOISE_SCALE.find((s) => d < s.upTo)?.label ?? DENOISE_SCALE[DENOISE_SCALE.length - 1].label
}

/**
 * The renderer needs a real path on disk — image bytes cannot travel through an
 * MCP tool call. Electron used to hang that path off `File`; it was removed in
 * Electron 32, so the drag's uri-list is tried as well. Neither is guaranteed,
 * which is why the caller reports an empty result instead of doing nothing.
 */
function pathsFromDrop(
  dt: DataTransfer,
  images: File[]
): { paths: string[]; fromFile: boolean } {
  const direct = images
    .map((f) => (f as File & { path?: string }).path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (direct.length > 0) return { paths: direct, fromFile: true }

  const fromUris = dt
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file:///'))
    .map((line) => {
      try {
        return decodeURIComponent(line.slice('file://'.length))
      } catch {
        return ''
      }
    })
    .filter((p) => p !== '' && IMAGE_RE.test(p))

  return { paths: fromUris, fromFile: false }
}

/** Named once, from the same map the main process validates against. */
const SUPPORTED = `Editable images are ${EDIT_IMAGE_EXTENSIONS.join(', ')}.`

export function EditComposer(): JSX.Element {
  const jobs = useStore((s) => s.editJobs)
  const pickEditSources = useStore((s) => s.pickEditSources)
  const createEditFromPath = useStore((s) => s.createEditFromPath)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  // Drafts oldest-first so the strip reads in the order they were attached.
  const drafts = useMemo(
    () =>
      jobs.filter((j) => j.status === 'draft').sort((a, b) => a.createdAt - b.createdAt),
    [jobs]
  )

  const newestId = drafts.length > 0 ? drafts[drafts.length - 1].id : null
  const active = drafts.find((d) => d.id === selectedId) ?? drafts[drafts.length - 1] ?? null

  // A newly attached photo takes over the form, including one arriving from
  // "Edit this again" further down the feed. Initialised from the first render,
  // so mounting the workflow with a draft already open steals nothing.
  const knownNewest = useRef(newestId)
  useEffect(() => {
    if (newestId === knownNewest.current) return
    knownNewest.current = newestId
    setSelectedId(null)
    setDropError(null)
  }, [newestId])

  const pick = (): void => {
    setDropError(null)
    void pickEditSources().then((accepted) => {
      // Zero accepted after the user actively chose files means every one was
      // refused — silence there reads as a broken button.
      if (accepted === 0) setDropError(`No usable image in that selection. ${SUPPORTED}`)
    })
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)

    const files = Array.from(e.dataTransfer.files)
    const images = files.filter((f) => f.type.startsWith('image/') || IMAGE_RE.test(f.name))
    if (images.length === 0) {
      setDropError(
        files.length === 0
          ? 'That drop carried no files.'
          : 'Only image files can be edited — that drop had none.'
      )
      return
    }

    const { paths, fromFile } = pathsFromDrop(e.dataTransfer, images)
    if (paths.length === 0) {
      setDropError(
        'Those files carried no filesystem path, and the renderer needs one — image bytes cannot travel through a tool call. Use Attach image instead.'
      )
      return
    }

    setDropError(
      fromFile && paths.length < images.length
        ? `${images.length - paths.length} of ${images.length} dropped files carried no filesystem path and were skipped.`
        : null
    )
    void Promise.all(paths.map((p) => createEditFromPath(p).then((ok) => ({ p, ok })))).then(
      (results) => {
        const refused = results.filter((r) => !r.ok).map((r) => r.p.split('/').pop() ?? r.p)
        if (refused.length === 0) return
        setDropError(
          refused.length === results.length
            ? `Could not use ${refused.length === 1 ? refused[0] : `any of those ${refused.length} files`}. ${SUPPORTED}`
            : `Skipped ${refused.join(', ')}. ${SUPPORTED}`
        )
      }
    )
  }

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    // Without this the drop never fires and Electron navigates to the file.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  return (
    <section className="ed-composer" aria-label="New edit">
      <div
        className={dragging ? 'ed-drop is-over' : 'ed-drop'}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {active === null ? (
          <div className="ed-drop-idle">
            <span className="ed-drop-glyph" aria-hidden="true">
              <PhotoIcon />
            </span>
            <p className="ed-drop-title">Drop a photo here to edit it</p>
            <button type="button" className="btn btn-primary" onClick={pick}>
              Attach image
            </button>
            <p className="ed-drop-note">
              The file stays where it is — the renderer reads it from that path, so it has
              to be a real file on this machine.
            </p>
          </div>
        ) : (
          <div className="ed-draft">
            {drafts.length > 1 ? (
              <div className="ed-strip" role="tablist" aria-label="Attached photos">
                {drafts.map((d, i) => (
                  <StripThumb
                    key={d.id}
                    job={d}
                    index={i + 1}
                    selected={d.id === active.id}
                    onSelect={() => setSelectedId(d.id)}
                  />
                ))}
                <button type="button" className="btn btn-sm ed-strip-add" onClick={pick}>
                  Add
                </button>
              </div>
            ) : null}

            {/* Keyed so switching photos gets clean local state rather than the
                previous draft's half-typed instruction. */}
            <DraftFields
              key={active.id}
              job={active}
              onAttachMore={pick}
              extraCount={drafts.length - 1}
            />
          </div>
        )}
      </div>

      {dropError !== null ? (
        <p className="ed-drop-error" role="alert">
          {dropError}
        </p>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Draft strip                                                         */
/* ------------------------------------------------------------------ */

function StripThumb({
  job,
  index,
  selected,
  onSelect
}: {
  job: EditJob
  index: number
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const img = useEditImage(job.sourcePath, job.sourceDataUrl)
  const name = job.sourceName !== '' ? job.sourceName : basename(job.sourcePath)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className="ed-strip-thumb"
      data-selected={selected}
      onClick={onSelect}
      title={name}
    >
      <EditImage state={img} alt={name} className="ed-img-tiny" />
      <span className="ed-strip-n tnum">{index}</span>
      {job.userInstruction.trim() !== '' ? (
        <span className="ed-strip-dot" title="Has an instruction" />
      ) : null}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* The form for one draft                                              */
/* ------------------------------------------------------------------ */

function DraftFields({
  job,
  onAttachMore,
  extraCount
}: {
  job: EditJob
  onAttachMore: () => void
  extraCount: number
}): JSX.Element {
  const setEditInstruction = useStore((s) => s.setEditInstruction)
  const setEditParams = useStore((s) => s.setEditParams)
  const refineEdit = useStore((s) => s.refineEdit)
  const deleteEdit = useStore((s) => s.deleteEdit)

  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const health = useStore((s) => s.health)
  const conversation = useStore((s) => s.conversation)

  const img = useEditImage(job.sourcePath, job.sourceDataUrl)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const instruction = useSyncedValue(
    job.userInstruction,
    (next) => {
      void setEditInstruction(job.id, next)
    },
    350
  )

  const denoise = useSyncedValue(
    job.params.denoise,
    (next) => {
      void setEditParams(job.id, { denoise: next })
    },
    150
  )

  const steps = useSyncedValue(
    String(job.params.steps),
    (next) => {
      const n = Number.parseInt(next, 10)
      if (Number.isFinite(n)) void setEditParams(job.id, { steps: Math.min(60, Math.max(1, n)) })
    },
    400
  )

  const seed = useSyncedValue(
    job.params.seed === undefined ? '' : String(job.params.seed),
    (next) => {
      const trimmed = next.trim()
      if (trimmed === '') {
        void setEditParams(job.id, { seed: undefined })
        return
      }
      const n = Number.parseInt(trimmed, 10)
      if (Number.isFinite(n) && n >= 0) void setEditParams(job.id, { seed: n })
    },
    400
  )

  useEffect(() => {
    taRef.current?.focus()
  }, [])

  const name = job.sourceName !== '' ? job.sourceName : basename(job.sourcePath)
  const canRefine = instruction.value.trim() !== ''

  /* Stage 1 reads the instruction main holds, so the pending keystrokes have to
     land before the refine is asked for. */
  const refine = async (): Promise<void> => {
    if (!canRefine) return
    instruction.cancel()
    await setEditInstruction(job.id, instruction.value.trim())
    await refineEdit(job.id)
  }

  const activeModelId =
    conversation?.modelId ?? settings.defaultModelId ?? health.residentModelId
  const activeModel = activeModelId === null ? undefined : models.find((m) => m.id === activeModelId)
  // Silent only when the model is genuinely unknown — never guess at vision.
  const textOnly = activeModel !== undefined && !activeModel.supportsVision

  return (
    <div className="ed-draft-body">
      <figure className="ed-draft-source">
        <EditImage state={img} alt={name} />
        <figcaption className="ed-file" title={job.sourcePath}>
          {name}
        </figcaption>
        <div className="ed-draft-source-actions">
          <button type="button" className="btn btn-sm" onClick={onAttachMore}>
            Add another
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => void deleteEdit(job.id)}
          >
            Remove
          </button>
        </div>
      </figure>

      <div className="ed-fields">
        <textarea
          ref={taRef}
          className="ed-instruction"
          rows={3}
          spellCheck={false}
          aria-label="What should change"
          placeholder="What should change? Plain words — “make it golden hour”, “remove the car behind her”."
          value={instruction.value}
          onChange={(e) => instruction.change(e.target.value)}
          onBlur={instruction.flush}
        />

        <div className="ed-methods" role="group" aria-label="Edit method">
          {(Object.keys(METHOD_COPY) as EditMethod[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`ed-method${job.params.method === m ? ' is-on' : ''}`}
              aria-pressed={job.params.method === m}
              onClick={() => void setEditParams(job.id, { method: m })}
            >
              <span className="ed-method-label">{METHOD_COPY[m].label}</span>
              <span className="ed-method-hint">{METHOD_COPY[m].hint}</span>
            </button>
          ))}
        </div>

        <div
          className={`ed-knobs${job.params.method === 'restyle' ? '' : ' ed-knobs-2'}`}
        >
          {job.params.method === 'restyle' ? (
            <label className="ed-knob">
              <span className="ed-knob-head">
                <span className="ed-knob-label">Denoise</span>
                <span className="ed-knob-value tnum">{denoise.value.toFixed(2)}</span>
              </span>
              <input
                className="ed-range"
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={denoise.value}
                onChange={(e) => denoise.change(Number(e.target.value))}
                onBlur={denoise.flush}
              />
              <span className="ed-knob-scale">{denoiseLabel(denoise.value)}</span>
            </label>
          ) : null}

          <label className="ed-knob">
            <span className="ed-knob-head">
              <span className="ed-knob-label">Steps</span>
            </span>
            <input
              className="ed-num tnum"
              type="number"
              min={1}
              max={60}
              step={1}
              value={steps.value}
              onChange={(e) => steps.change(e.target.value)}
              /* Push a number, put the field back to main's value for anything
                 else — an empty or half-typed box must not read as a setting. */
              onBlur={() =>
                Number.isFinite(Number.parseInt(steps.value, 10)) ? steps.flush() : steps.reset()
              }
            />
            <span className="ed-knob-scale">
              1–60, {EDIT_METHOD_DEFAULTS[job.params.method].steps} is the default
            </span>
          </label>

          <label className="ed-knob">
            <span className="ed-knob-head">
              <span className="ed-knob-label">Seed</span>
            </span>
            <input
              className="ed-num tnum"
              type="text"
              inputMode="numeric"
              placeholder="random"
              value={seed.value}
              onChange={(e) => seed.change(e.target.value)}
              /* Blank is a real choice here — it means "roll a new one". */
              onBlur={() =>
                seed.value.trim() === '' ||
                Number.isFinite(Number.parseInt(seed.value.trim(), 10))
                  ? seed.flush()
                  : seed.reset()
              }
            />
            <span className="ed-knob-scale">blank re-rolls each render</span>
          </label>
        </div>

        <p className="ed-knob-note">{METHOD_COPY[job.params.method].note}</p>

        {textOnly ? (
          <p className="ed-warn">
            <span className="dot dot-warn" />
            {activeModelId} has no vision, so the prompt will be written from your words
            alone without looking at the photo.
          </p>
        ) : null}

        <div className="ed-draft-actions">
          <span className="ed-draft-count">
            {extraCount > 0
              ? `${extraCount} more photo${extraCount === 1 ? '' : 's'} waiting`
              : 'Stage 1 writes the render prompt; you can edit it before anything renders.'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void refine()}
            disabled={!canRefine}
            title={canRefine ? 'Write the render prompt' : 'Say what should change first'}
          >
            Refine prompt
          </button>
        </div>
      </div>
    </div>
  )
}

function PhotoIcon(): JSX.Element {
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
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
      <circle cx="5.5" cy="6.5" r="1" />
      <path d="M2 11.2l3-2.8a1.1 1.1 0 0 1 1.5 0l2.3 2.2a1.1 1.1 0 0 0 1.5 0l1-1 2.7 2.4" />
    </svg>
  )
}

export default EditComposer
