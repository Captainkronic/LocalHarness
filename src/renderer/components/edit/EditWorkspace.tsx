/**
 * The centre column for the Edit workflow.
 *
 * Not a transcript: this workflow is a fixed two-stage pipeline, so the column
 * is the composer over a feed of edits, newest first. Drafts stay in the
 * composer — a card only appears once a job has a prompt being written for it,
 * because an empty triptych says nothing.
 */

import { useMemo, type DragEvent, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import EditComposer from './EditComposer'
import EditCard from './EditCard'
import './edit.css'

export function EditWorkspace(): JSX.Element {
  const jobs = useStore((s) => s.editJobs)

  const feed = useMemo(
    () =>
      jobs.filter((j) => j.status !== 'draft').sort((a, b) => b.createdAt - a.createdAt),
    [jobs]
  )

  /* A file dropped anywhere but the drop zone would otherwise navigate the
     window to it and take the whole app with it. The composer's own handler
     runs first, on the way up; this only stops the browser default. */
  const swallowDrop = (e: DragEvent<HTMLDivElement>): void => e.preventDefault()

  return (
    <div className="ed" onDragOver={swallowDrop} onDrop={swallowDrop}>
      <EditComposer />

      <div className="ed-feed scroll-y">
        <div className="ed-feed-inner">
          {feed.length === 0 ? (
            <div className="ed-empty">
              <p className="ed-empty-line">
                Attach a photo, say what to change, and the model writes the render prompt.
              </p>
              <p className="ed-empty-sub">
                The prompt is yours to read and edit before a single pixel is rendered.
              </p>
            </div>
          ) : (
            feed.map((job) => <EditCard key={job.id} job={job} />)
          )}
        </div>
      </div>
    </div>
  )
}

export default EditWorkspace
