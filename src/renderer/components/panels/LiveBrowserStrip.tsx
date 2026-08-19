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

import { useMemo, type JSX } from 'react'

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
function Strip(): JSX.Element {
  const frame = useStore((s) => s.browserFrame)
  const status = useStore((s) => s.browserMirror)
  useMirrorStream()

  return (
    <section className="lbs">
      <div className="lbs-head">
        <span className="section-label">Live browser</span>
        <span className={status === 'live' ? 'lbs-dot is-on' : 'lbs-dot'} aria-hidden="true" />
      </div>
      <div className="lbs-stage">
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
    </section>
  )
}

export default LiveBrowserStrip
