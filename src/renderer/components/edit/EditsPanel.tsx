/**
 * Finished edits, as an index into the feed.
 *
 * Deliberately not a gallery: the thumbnail is here to identify a row, and the
 * row's job is to get you back to the card where the source, the prompt and the
 * result sit together.
 */

import { useMemo, type JSX } from 'react'

import type { EditJob } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { relativeTime } from '@renderer/lib/format'
import { EditImage, scrollToJob, useEditImage } from './EditCard'
import './edit.css'

export function EditsPanel(): JSX.Element {
  const jobs = useStore((s) => s.editJobs)

  const done = useMemo(
    () =>
      jobs
        .filter((j) => j.status === 'done' && j.outputPath !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [jobs]
  )

  if (done.length === 0) {
    return (
      <p className="pnl-empty">
        Rendered edits land here as you make them — thumbnail, the prompt that produced
        it, and a way back to the card it came from.
      </p>
    )
  }

  return (
    <ul className="ed-panel-list">
      {done.map((job) => (
        <PanelRow key={job.id} job={job} />
      ))}
    </ul>
  )
}

function PanelRow({ job }: { job: EditJob }): JSX.Element {
  const img = useEditImage(job.outputPath, job.outputDataUrl)
  const line = (job.refinedPrompt ?? job.userInstruction).trim()

  return (
    <li className="ed-panel-item">
      <button
        type="button"
        className="ed-panel-row"
        onClick={() => scrollToJob(job.id)}
        title={`${job.userInstruction}\n\n${job.refinedPrompt ?? ''}`.trim()}
      >
        <span className="ed-panel-thumb">
          <EditImage
            state={img}
            alt={line === '' ? 'Edit result' : line}
            className="ed-img-tiny"
          />
        </span>
        <span className="ed-panel-text">
          <span className="ed-panel-line">{line === '' ? 'Untitled edit' : line}</span>
          <span className="ed-panel-meta">
            {job.parentId !== undefined ? <span className="ed-panel-iter">iteration</span> : null}
            <span>{relativeTime(job.updatedAt)}</span>
          </span>
        </span>
      </button>
    </li>
  )
}

export default EditsPanel
