/**
 * The permission gate. Renders the head of the approval queue as a modal — the
 * turn is blocked behind it, so it deliberately takes over the window rather
 * than sitting quietly in the transcript.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@renderer/state/store'
import { relativeTime } from '@renderer/lib/format'
import DiffView from './DiffView'
import './chat.css'

export default function ApprovalDialog() {
  const approvals = useStore((s) => s.approvals)
  const respondApproval = useStore((s) => s.respondApproval)
  const updateSettings = useStore((s) => s.updateSettings)
  const cardRef = useRef<HTMLDivElement>(null)

  const request = approvals.length > 0 ? approvals[0] : null
  const requestId = request?.id ?? null

  // Esc is a denial, not a dismissal — there is a promise waiting on this.
  useEffect(() => {
    if (requestId === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void respondApproval(requestId, 'deny')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [requestId, respondApproval])

  useEffect(() => {
    if (requestId !== null) cardRef.current?.focus()
  }, [requestId])

  if (request === null) return null

  const queued = approvals.length - 1

  return (
    <div className="appr-scrim" role="presentation">
      <div
        ref={cardRef}
        className={request.mutating ? 'appr appr-mutating' : 'appr'}
        role="dialog"
        aria-modal="true"
        aria-label={`Approve ${request.toolName}`}
        tabIndex={-1}
      >
        <div className="appr-head">
          <span className="appr-kind">{request.mutating ? 'Will modify' : 'Read only'}</span>
          <span className="appr-tool">{request.toolName}</span>
          {queued > 0 ? (
            <span className="chip appr-queue">{queued} more queued</span>
          ) : (
            <span className="appr-queue appr-esc">{relativeTime(request.createdAt)}</span>
          )}
        </div>

        <div className="appr-body">
          <div className="appr-summary">{request.summary}</div>

          {request.command !== undefined && request.command !== '' ? (
            <div>
              <div className="section-label appr-section-label">Command</div>
              <pre className="appr-pre appr-cmd">{request.command}</pre>
            </div>
          ) : null}

          {request.diff !== undefined && request.diff !== '' ? (
            <div>
              <div className="section-label appr-section-label">Changes</div>
              <DiffView diff={request.diff} />
            </div>
          ) : null}

          {request.argsPreview !== '' ? (
            <div>
              <div className="section-label appr-section-label">Arguments</div>
              <pre className="appr-pre">{request.argsPreview}</pre>
            </div>
          ) : null}
        </div>

        <div className="appr-foot">
          <span className="appr-esc">
            <kbd>esc</kbd> denies
          </span>
          <div className="appr-actions">
            {/* The way out of being asked at all. Someone who has approved five
                writes in a row wants this, and hunting through Settings for it
                mid-turn is not a reasonable ask. */}
            <button
              type="button"
              className="btn btn-ghost appr-auto"
              title="Stop asking: run every tool automatically from now on. Change it back in Settings."
              onClick={() => {
                void updateSettings({ approvalMode: 'auto_all' })
                void respondApproval(request.id, 'allow_once')
              }}
            >
              Don't ask again
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void respondApproval(request.id, 'deny')}
            >
              Deny
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void respondApproval(request.id, 'allow_session')}
            >
              Allow for session
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void respondApproval(request.id, 'allow_once')}
            >
              Allow once
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
