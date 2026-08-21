/**
 * The voice side of Converse: the orb, and what was said.
 *
 * Converse keeps the conversation in the centre pane, which is the whole point
 * of it — a spoken turn is an ordinary message and belongs in the thread with
 * the typed ones. That leaves the orb without a home, and it needs one: during
 * a spoken turn the only other signal is silence, and silence reads as a crash.
 *
 * So it lives here, beside the conversation rather than instead of it. You can
 * watch it think and read what it said at the same time, which is exactly what
 * the two-pane version made impossible.
 */

import { type JSX } from 'react'

import TranscriptPanel from '@renderer/components/live/TranscriptPanel'
import VoiceOrb from '@renderer/components/live/VoiceOrb'
import { useStore } from '@renderer/state/store'
import './panels.css'

export function VoicePanel(): JSX.Element {
  const status = useStore((s) => s.liveStatus)
  const idle = status.state === 'off'

  return (
    <div className="vp">
      <div className={idle ? 'vp-orb is-idle' : 'vp-orb'}>
        {/* `pausing` is deliberately not passed: it is local state inside
            LiveWorkspace, derived from the capture hook, and is not in the
            store. The orb loses the "held open in case you are only pausing"
            look until that is lifted — every other state is intact. */}
        <VoiceOrb state={status.state} level={status.level} />
        {idle ? (
          /* Named rather than left as a mystery circle: this panel appears the
             moment the workflow opens, before anything has been said. */
          <p className="vp-hint">Press Talk under the message box to start speaking.</p>
        ) : null}
      </div>
      <TranscriptPanel />
    </div>
  )
}

export default VoicePanel
