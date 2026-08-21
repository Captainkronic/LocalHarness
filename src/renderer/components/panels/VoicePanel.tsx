/**
 * Converse's right-hand panel: the orb, and nothing else.
 *
 * Every message goes in the main thread, whether it was typed or spoken. That
 * is the whole point of this workflow — a spoken turn is an ordinary message
 * and should be indistinguishable from a typed one once it has arrived, so
 * there is nothing here to read.
 *
 * The first version of this panel also carried the spoken transcript, which
 * put the same words in two places at once and made voice turns look like a
 * separate class of thing. They are not. What the orb adds is the one thing
 * the transcript cannot: what is happening RIGHT NOW, while it is happening.
 * During a spoken turn the only other signal is silence, and silence reads as
 * a crash.
 */

import { type JSX } from 'react'

import VoiceOrb from '@renderer/components/live/VoiceOrb'
import { useStore } from '@renderer/state/store'
import './panels.css'

export function VoicePanel(): JSX.Element {
  const state = useStore((s) => s.liveStatus.state)
  const level = useStore((s) => s.liveStatus.level)
  const idle = state === 'off'

  return (
    <div className={idle ? 'vp is-idle' : 'vp'}>
      {/* `pausing` is not passed: it is local state inside LiveWorkspace and
          not in the store, so the orb cannot show the "held open in case you
          are only pausing" beat. Every other state is intact. */}
      <VoiceOrb state={state} level={level} />
      {idle ? (
        /* Named rather than left as an unexplained circle — this panel is on
           screen from the moment the workflow opens, before anything is said. */
        <p className="vp-hint">Press Talk under the message box to start speaking.</p>
      ) : null}
    </div>
  )
}

export default VoicePanel
