/**
 * What the session is doing, as a shape that moves.
 *
 * This replaces a 26px orb that sat in a row of its own above the composer and
 * did not move: a whole row of window spent on a dot that looked identical
 * whether the microphone was open, closed, or had just heard a sentence.
 *
 * The split here is deliberate and is the whole point of the component:
 *
 *   When there IS a level — listening, hearing you, speaking — the bars are
 *   driven by the ACTUAL number coming off the audio graph. That is what makes
 *   "it can hear me" believable rather than decorative: go quiet and the bars
 *   fall, because they are a meter, not an animation.
 *
 *   When there is NO level — transcribing, thinking, running a tool — nothing
 *   real is arriving, so the bars run a travelling wave instead. An animation
 *   standing in for data would be a lie; an animation standing in for "working,
 *   nothing to report" is honest, and the silence it covers is exactly the
 *   moment a conversation feels broken.
 */

import { useEffect, useRef, useState, type JSX } from 'react'

import type { LiveSessionState } from '@shared/types'
import { useStore } from '@renderer/state/store'
import './talk.css'

/** Per-bar shape, so the meter reads as a voice rather than a bar chart. */
const BARS = [0.55, 0.82, 1, 0.82, 0.55]

/** States where the level is real and should drive the bars. */
const METERED = new Set<LiveSessionState>(['listening', 'capturing', 'speaking'])

/**
 * Follows the level, falling on a needle rather than snapping.
 *
 * The source is the audio worklet at ~31Hz, republished on every animation
 * frame, so this is as immediate as the machine can be — no IPC in the path.
 * Attack is therefore instant: a syllable moves the bars on the very frame it
 * is heard. Only the fall is smoothed, and only enough that the meter does not
 * strobe between words; too much and it stops looking like a response to your
 * voice, which was the whole complaint.
 */
const RELEASE = 0.4

function useSmoothLevel(level: number, active: boolean): number {
  const [shown, setShown] = useState(0)
  const target = useRef(0)
  const raf = useRef(0)

  target.current = active ? Math.min(1, Math.max(0, level)) : 0

  useEffect(() => {
    let live = true
    let current = 0
    const tick = (): void => {
      if (!live) return
      const t = target.current
      current = t > current ? t : current + (t - current) * RELEASE
      setShown(current)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      live = false
      cancelAnimationFrame(raf.current)
    }
  }, [])

  return shown
}

export function VoiceIndicator({ state }: { state: LiveSessionState }): JSX.Element {
  /* From the store, not from liveStatus: main sets liveStatus.level to 0 when
     the session starts and never touches it again, because the level is
     measured in the renderer. Reading it there is what made this meter sit
     flat at its floor through an entire call. */
  const level = useStore((s) => s.micLevel)
  const metered = METERED.has(state)
  const shown = useSmoothLevel(level, metered)

  return (
    <span className="tk-meter" data-state={state} aria-hidden="true">
      {BARS.map((shape, i) => {
        /* A floor so the meter never collapses to nothing: an empty control
           reads as broken, and silence during a call is still a live mic. */
        const h = metered ? 0.22 + shape * shown * 0.78 : 1
        return (
          <span
            key={i}
            className="tk-bar"
            style={{
              /* Height as a scale keeps every bar on one compositor layer;
                 animating height itself would lay the row out each frame. */
              transform: `scaleY(${h.toFixed(3)})`,
              animationDelay: `${i * 90}ms`
            }}
          />
        )
      })}
    </span>
  )
}

export default VoiceIndicator
