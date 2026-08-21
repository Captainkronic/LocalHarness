/**
 * Converse's right-hand panel — reserved, deliberately empty.
 *
 * It held the orb, which has moved to sit directly above the Talk button: the
 * one thing that shows what the microphone is doing does not belong at the far
 * side of the window from the control that opens it.
 *
 * The panel stays because something is going here next, and a rail that
 * appears and disappears as a workflow gains a panel is more disorienting than
 * one that is quiet for a while. It says so rather than rendering a blank
 * rectangle, which reads as a component that failed to load.
 *
 * Everything either side of it already works: the conversation is in the main
 * thread whether it was typed or spoken, and the orb is in the composer.
 */

import { type JSX } from 'react'

import './panels.css'

export function VoicePanel(): JSX.Element {
  return (
    <div className="vp">
      <p className="vp-hint">Nothing here yet.</p>
    </div>
  )
}

export default VoicePanel
