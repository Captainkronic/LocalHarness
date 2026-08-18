import { useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

import type { Avatar } from '@shared/types'
import { AVATAR_FRAME_SPECS } from '@shared/avatar'
import { useStore } from '@renderer/state/store'
import './live.css'

/**
 * Describe a person, get a face that talks.
 *
 * The build is ten to twelve minutes of GPU — a portrait plus one edit per
 * frame — which makes two things non-negotiable in the UI.
 *
 * The wait has to be legible, so every step is listed as it happens rather than
 * hidden behind a spinner. Ten minutes of "working…" is indistinguishable from
 * a hang, and there is nowhere else the user could look to check.
 *
 * And closing this must not cancel anything. The build lives in main and its
 * progress is held in the store, so the dialog is a window onto it rather than
 * its owner — you can shut it, go and do something else, and the avatar will
 * be waiting in the Face picker.
 */

export interface AvatarBuilderDialogProps {
  open: boolean
  onClose: () => void
  /** Called when a build finishes, so the caller can refresh its list. */
  onBuilt: (avatar: Avatar) => void
  /** Existing faces, so an interrupted one can be offered a way to finish. */
  avatars: Avatar[]
}

/** rest plus one per recipe entry. */
const TOTAL_FRAMES = AVATAR_FRAME_SPECS.length + 1

const EXAMPLES = [
  'a man in his fifties with grey stubble and round glasses, wearing a charcoal roll-neck',
  'a woman in her twenties with braided hair and gold earrings, wearing a mustard shirt',
  'an older woman with silver hair pinned up, wearing a blue linen shirt',
  'a young man with dark curls, wearing a denim jacket over a white tee'
]

export function AvatarBuilderDialog({
  open,
  onClose,
  onBuilt,
  avatars
}: AvatarBuilderDialogProps): JSX.Element | null {
  const progress = useStore((s) => s.avatarBuild)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [includeExtras, setIncludeExtras] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const unfinished = avatars.filter((a) => Object.keys(a.frames).length < TOTAL_FRAMES)

  if (!open) return null

  const start = async (): Promise<void> => {
    if (description.trim() === '') return
    setRunning(true)
    setError(null)
    try {
      const avatar = await window.harness.invoke('avatars:build', {
        name: name.trim() || 'Avatar',
        description: description.trim(),
        includeExtras
      })
      if (avatar) onBuilt(avatar)
      else setError('The build did not produce a face. The log has the reason.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const finish = async (id: string): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      const avatar = await window.harness.invoke('avatars:finish', id)
      if (avatar) onBuilt(avatar)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const pct =
    progress !== null && progress.total > 0
      ? Math.round((progress.step / progress.total) * 100)
      : 0

  return createPortal(
    <div className="set-scrim" onMouseDown={onClose} role="presentation">
      <div
        className="set-modal av-build"
        role="dialog"
        aria-modal="true"
        aria-label="New face"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="set-head">
          <h2 className="set-title">New face</h2>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            {running ? 'Hide' : 'Close'}
          </button>
        </header>

        <div className="set-body scroll-y">
          {/* An interrupted build leaves a face that barely moves and no way
              back to it. Offered first, because someone reopening this dialog
              after a build died is far more likely to want to finish that one
              than to start another. */}
          {!running && unfinished.length > 0 ? (
            <div className="av-unfinished">
              <span className="av-field-label">Unfinished</span>
              {unfinished.map((a) => (
                <div key={a.id} className="av-unfinished-row">
                  <span>
                    {a.name}
                    <span className="av-hint">
                      {' '}
                      — {Object.keys(a.frames).length} of {TOTAL_FRAMES} frames
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void finish(a.id)}
                  >
                    Finish
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <label className="av-field">
            <span className="av-field-label">Name</span>
            <input
              className="av-input"
              value={name}
              placeholder="Ada"
              onChange={(e) => setName(e.target.value)}
              disabled={running}
            />
          </label>

          <label className="av-field">
            <span className="av-field-label">What do they look like?</span>
            <textarea
              className="av-textarea"
              rows={3}
              value={description}
              placeholder="a woman in her thirties with short dark hair, wearing a green jumper"
              onChange={(e) => setDescription(e.target.value)}
              disabled={running}
            />
            {/* Style is added for them. Asking a person to specify "painted,
                front-on, plain background, even margins" is asking them to know
                why those matter — and every one of them is a requirement of the
                frames lining up, not a taste. */}
            <span className="av-hint">
              Say who they are and what they are wearing. The painted style, the framing
              and the plain background are added for you — the frames have to line up.
            </span>
          </label>

          {!running ? (
            <div className="av-examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip av-example"
                  onClick={() => setDescription(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          ) : null}

          <label className="av-check">
            <input
              type="checkbox"
              checked={includeExtras}
              onChange={(e) => setIncludeExtras(e.target.checked)}
              disabled={running}
            />
            <span>
              Include a smile and a listening look
              <span className="av-hint"> — two more renders, about three minutes</span>
            </span>
          </label>

          {progress !== null ? (
            <div className="av-progress" aria-live="polite">
              <div className="av-progress-head">
                <span className="av-progress-label">{progress.label}</span>
                <span className="av-progress-count tnum">
                  {progress.step} / {progress.total}
                </span>
              </div>
              <div className="av-bar">
                <div className="av-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              {progress.status === 'error' && progress.error ? (
                <p className="av-error">{progress.error}</p>
              ) : null}
              {progress.step >= 1 && progress.status !== 'error' ? (
                <p className="av-hint">
                  Already usable — the face is saved and selectable. Each frame from here
                  makes it move better.
                </p>
              ) : null}
            </div>
          ) : null}

          {error !== null ? <p className="av-error">{error}</p> : null}
        </div>

        <footer className="av-foot">
          {running ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void window.harness.invoke('avatars:cancelBuild')}
            >
              Stop after this frame
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start()}
            disabled={running || description.trim() === ''}
          >
            {running ? 'Building…' : 'Build face'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

export default AvatarBuilderDialog
