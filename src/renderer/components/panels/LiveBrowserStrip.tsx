/**
 * The page the model is driving, in the workspace sidebar, while it drives it.
 *
 * This replaced an auto-switch. The Code column used to flip to the Browser tab
 * when a browser tool started and flip back when it stopped, which showed the
 * right thing at the cost of taking the conversation away — and the
 * conversation is where the model narrates what it is doing, which is half of
 * understanding what you are looking at. Watching it click and reading why it
 * clicked should not be alternatives.
 *
 * So the live view lives here instead, beside the transcript rather than on top
 * of it, and nothing moves. The Browser tab keeps its job: every frame the model
 * was actually given, with the vision reading of each, for as long as the
 * conversation lasts. This is the present tense, that is the record.
 *
 * It renders nothing at all when no browser tool is running, which also stops
 * the screencast — see useMirrorStream. An idle mirror is a JPEG a frame for
 * nobody.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import { useMirrorStream } from '@renderer/components/code/useMirrorStream'
import './panels.css'

const BROWSER_TOOL = /playwright__|browse_act|view_page|page_snapshot/

export function LiveBrowserStrip(): JSX.Element | null {
  const conversation = useStore((s) => s.conversation)
  const phase = useStore((s) => s.live.phase)

  /* Phase plus the most recent tool, not a per-call `pending` status: a short
     call can begin and end between two renders, and the strip would miss it. */
  const lastToolName = useMemo(() => {
    const messages = conversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const calls = messages[i].toolCalls ?? []
      if (calls.length > 0) return calls[calls.length - 1].name
    }
    return ''
  }, [conversation])

  /**
   * Visible for the whole browsing episode, not just while a call is in flight.
   *
   * `phase === 'tool'` was too narrow: the model spends most of a browser
   * episode in `decode`, reasoning about the page it just looked at, and the
   * strip vanished exactly then — which is when you most want to see what it is
   * talking about. It also made the panel flicker in and out between calls.
   *
   * So: any live turn whose most recent tool was a browser one. It goes when
   * the turn ends, or when the model moves on to something that is not the
   * browser.
   */
  const busy = phase !== 'idle' && BROWSER_TOOL.test(lastToolName)
  return busy ? <Strip /> : null
}

/**
 * Split out so the stream starts and stops with `busy`.
 *
 * useMirrorStream is a mount/unmount hook; calling it from the parent would
 * leave the screencast running for the whole session, since the parent stays
 * mounted the entire time the panel is open.
 */
/** Bounds for the drag. Below the floor the picture is unreadable; above the
 *  ceiling the sandbox and touched-files lists get pushed off the panel. */
const MIN_H = 140
const MAX_H = 760
const STORE_KEY = 'lh.liveBrowser.height'

function Strip(): JSX.Element {
  const frame = useStore((s) => s.browserFrame)
  const status = useStore((s) => s.browserMirror)
  useMirrorStream()

  /* Remembered across launches: a size you set is a preference, and being made
     to set it again every run would be worse than not offering the handle. */
  const [height, setHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORE_KEY))
    return Number.isFinite(saved) && saved >= MIN_H && saved <= MAX_H ? saved : 300
  })
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)

  /* Listeners on the WINDOW, not the handle: the pointer routinely leaves a
     10px grip mid-drag, and a handler bound to the grip would drop the drag
     the moment it did. */
  const onGripDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = stageRef.current?.getBoundingClientRect().height ?? 300
    setDragging(true)
    const move = (ev: PointerEvent): void => {
      const next = Math.min(MAX_H, Math.max(MIN_H, startH + (ev.clientY - startY)))
      setHeight(next)
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORE_KEY, String(Math.round(height)))
  }, [height])

  return (
    <section className="lbs" style={{ '--lbs-h': `${Math.round(height)}px` } as CSSProperties}>
      <div className="lbs-head">
        <span className="section-label">Live browser</span>
        <span className={status === 'live' ? 'lbs-dot is-on' : 'lbs-dot'} aria-hidden="true" />
      </div>
      <div className="lbs-stage" ref={stageRef}>
        {frame ? (
          <img className="lbs-frame" src={frame.dataUrl} alt="the page the model is driving" />
        ) : (
          /* Chrome emits a screencast frame only when something changes, so a
             page that has loaded and is sitting still produces nothing until
             the model touches it. Not an error, and worth not calling one. */
          <p className="lbs-idle">
            {status === 'live' ? 'waiting for the page to change' : 'opening the page'}
          </p>
        )}
      </div>
      {/* Keyboard-reachable as well as draggable: a resize that only exists for
          a mouse is a resize half the people using it cannot perform. */}
      <button
        type="button"
        className={dragging ? 'lbs-grip is-dragging' : 'lbs-grip'}
        onPointerDown={onGripDown}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setHeight((h) => Math.max(MIN_H, h - 24))
          if (e.key === 'ArrowDown') setHeight((h) => Math.min(MAX_H, h + 24))
        }}
        aria-label={`Resize the live browser (${Math.round(height)} pixels). Use the arrow keys.`}
        title="Drag to resize"
      />
    </section>
  )
}

export default LiveBrowserStrip
