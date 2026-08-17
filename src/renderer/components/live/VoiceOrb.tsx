/**
 * The thing you look at during a call.
 *
 * One element carries the whole session state, because during a spoken turn the
 * user's attention is on their own words, not on the screen — whatever the UI
 * says has to be readable out of the corner of an eye. So state is a colour and
 * a shape before it is a word, and the word is there for when the glance lands.
 *
 * The level ring is the honest part: it is a static arc, not an animation, so it
 * still reports the microphone under prefers-reduced-motion when every pulse and
 * swell in here has been switched off.
 */

import type { CSSProperties, JSX } from 'react'

import type { LiveSessionState } from '@shared/types'
import { clamp01 } from '@renderer/lib/format'
import './live.css'

export interface VoiceOrbProps {
  state: LiveSessionState
  /** Microphone level while listening, playback level while speaking. 0..1. */
  level: number
}

/** Bar positions relative to the orb centre, and a fixed per-bar weight so the
 *  shape reads as speech rather than a uniform pulse. */
const BAR_OFFSETS = [-24, -12, 0, 12, 24]
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55]

/**
 * The instrument frame.
 *
 * JARVIS reads as precision instrumentation rather than as an assistant blob,
 * and precision is drawn with ticks and brackets, not with glow. These are
 * fixed marks on a dial: they do NOT encode anything, which is exactly why they
 * are allowed to move — an ornament that rotates is honest, whereas a number
 * that animates without being measured is not.
 */
const TICK_COUNT = 60
/** Every fifth tick is long, the way a dial marks its fifths. */
const TICKS = Array.from({ length: TICK_COUNT }, (_, i) => {
  const angle = (i / TICK_COUNT) * Math.PI * 2 - Math.PI / 2
  const major = i % 5 === 0
  const outer = 94
  const inner = major ? 87 : 90.5
  return {
    key: i,
    major,
    x1: 100 + Math.cos(angle) * inner,
    y1: 100 + Math.sin(angle) * inner,
    x2: 100 + Math.cos(angle) * outer,
    y2: 100 + Math.sin(angle) * outer
  }
})

/** Corner brackets, as a fraction of the box. Drawn as four rotations of one
 *  path so the shape can never drift between corners. */
const BRACKET = 'M4 26V8a4 4 0 014-4h18'

const LABELS: Record<LiveSessionState, string> = {
  off: 'Not in a call',
  starting: 'Opening the microphone',
  listening: 'Listening',
  capturing: 'Hearing you',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  tool: 'Looking it up',
  speaking: 'Speaking',
  error: 'Something went wrong'
}

export function VoiceOrb({ state, level }: VoiceOrbProps): JSX.Element {
  const lvl = clamp01(level)
  // The arc reads as a meter, so it never fully empties while a call is up —
  // an empty ring would be indistinguishable from a dead session. Off, it is
  // not drawn at all: a zero-length dash with a round cap still paints a dot,
  // which looked like an index mark nobody put there.
  const arc = 6 + lvl * 94

  return (
    <div
      className="orb"
      data-state={state}
      style={{ '--orb-level': lvl.toFixed(3) } as CSSProperties}
      role="img"
      aria-label={LABELS[state]}
    >
      <svg className="orb-svg" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id="orb-fill" cx="38%" cy="32%" r="76%">
            <stop offset="0%" stopColor="var(--orb-c)" stopOpacity="0.85" />
            <stop offset="55%" stopColor="var(--orb-c)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--orb-c)" stopOpacity="0.06" />
          </radialGradient>
          <filter id="orb-soften" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>

        {/* ---- instrument frame ---- */}
        {/* A graduated dial. Static: it is the bezel, not a reading. */}
        <g className="orb-ticks">
          {TICKS.map((t) => (
            <line
              key={t.key}
              className={t.major ? 'orb-tick orb-tick-major' : 'orb-tick'}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
            />
          ))}
        </g>

        {/* Two sweeps, counter-rotating, on their own radii. Ornament — they
            run whenever a call is up and stop dead under reduced motion. */}
        <g className="orb-sweeps">
          <circle
            className="orb-sweep orb-sweep-cw"
            cx="100"
            cy="100"
            r="88"
            pathLength="100"
            strokeDasharray="13 87"
          />
          <circle
            className="orb-sweep orb-sweep-ccw"
            cx="100"
            cy="100"
            r="83"
            pathLength="100"
            strokeDasharray="5 45"
          />
        </g>

        {/* Corner brackets. They frame the core the way a reticle frames a
            target, and they are what makes the whole thing read as an
            instrument rather than a bubble. */}
        <g className="orb-brackets">
          <path className="orb-bracket" d={BRACKET} />
          <path className="orb-bracket" d={BRACKET} transform="rotate(90 100 100)" />
          <path className="orb-bracket" d={BRACKET} transform="rotate(180 100 100)" />
          <path className="orb-bracket" d={BRACKET} transform="rotate(270 100 100)" />
        </g>

        {/* Bloom. Scales with level, so a loud room is visibly a loud room. */}
        <circle
          className="orb-aura"
          cx="100"
          cy="100"
          r="58"
          fill="var(--orb-c)"
          filter="url(#orb-soften)"
        />

        {/* Two rings that travel outward while the turn is being processed. */}
        <circle className="orb-ping orb-ping-1" cx="100" cy="100" r="60" />
        <circle className="orb-ping orb-ping-2" cx="100" cy="100" r="60" />

        <circle className="orb-shell" cx="100" cy="100" r="56" fill="url(#orb-fill)" />
        <circle className="orb-edge" cx="100" cy="100" r="56" />

        {/* The meter. pathLength normalises the circumference so the dash array
            is a plain percentage rather than a number derived from the radius.
            Track first: it is the groove the arc runs in, and painting it after
            would hide the reading it is there to frame. */}
        <circle className="orb-arc-track" cx="100" cy="100" r="76" pathLength="100" />
        {state === 'off' ? null : (
          <circle
            className="orb-arc"
            cx="100"
            cy="100"
            r="76"
            pathLength="100"
            strokeDasharray={`${arc.toFixed(1)} 100`}
          />
        )}

        <StateGlyph state={state} level={lvl} />
      </svg>

      <span className="orb-label">{LABELS[state]}</span>
    </div>
  )
}

/** A different shape per phase, so the state survives being colour-blind or
 *  glanced at from across the desk. */
function StateGlyph({
  state,
  level
}: {
  state: LiveSessionState
  level: number
}): JSX.Element | null {
  switch (state) {
    case 'listening':
    case 'capturing':
      return (
        <g className="orb-glyph orb-bars">
          <rect className="orb-bar orb-bar-1" x="88" y="88" width="5" height="24" rx="2.5" />
          <rect className="orb-bar orb-bar-2" x="97.5" y="82" width="5" height="36" rx="2.5" />
          <rect className="orb-bar orb-bar-3" x="107" y="88" width="5" height="24" rx="2.5" />
        </g>
      )
    case 'transcribing':
      return (
        <g className="orb-glyph">
          <path
            className="orb-stroke"
            d="M85 92h30M85 100h30M85 108h18"
            strokeLinecap="round"
          />
        </g>
      )
    case 'thinking':
      return (
        <g className="orb-glyph orb-dots">
          <circle className="orb-dot orb-dot-1" cx="88" cy="100" r="4" />
          <circle className="orb-dot orb-dot-2" cx="100" cy="100" r="4" />
          <circle className="orb-dot orb-dot-3" cx="112" cy="100" r="4" />
        </g>
      )
    case 'tool':
      // Deliberately not the thinking dots. Reaching for a tool is the one
      // pause in a spoken turn the user cannot attribute to the model, so it
      // has to be distinguishable at a glance and not merely a different
      // colour: a scanning reticle, which is also what it is doing.
      return (
        <g className="orb-glyph orb-scan">
          <circle className="orb-stroke" cx="100" cy="100" r="13" />
          <path
            className="orb-stroke"
            d="M100 81v6M100 113v6M81 100h6M113 100h6"
            strokeLinecap="round"
          />
          <circle className="orb-solid" cx="100" cy="100" r="2.4" />
        </g>
      )
    case 'speaking':
      // A live equaliser rather than a static squiggle: the bars are driven by
      // the actual playback level, so you can see him talking and not merely be
      // told. Deliberately symmetrical about the centre — the JARVIS read is
      // precise instrumentation, not a party visualiser.
      return (
        <g className="orb-glyph orb-bars">
          {BAR_OFFSETS.map((dx, i) => {
            const falloff = 1 - Math.abs(dx) / 34
            const h = 6 + level * 30 * falloff * BAR_WEIGHTS[i]
            return (
              <rect
                key={dx}
                className="orb-bar"
                x={100 + dx - 2}
                y={100 - h / 2}
                width={4}
                height={Math.max(4, h)}
                rx={2}
                style={{ animationDelay: `${i * 90}ms` }}
              />
            )
          })}
        </g>
      )
    case 'error':
      return (
        <g className="orb-glyph">
          <path className="orb-stroke" d="M100 86v18" strokeLinecap="round" />
          <circle className="orb-solid" cx="100" cy="112" r="2.6" />
        </g>
      )
    case 'starting':
      return (
        <g className="orb-glyph orb-dots">
          <circle className="orb-dot orb-dot-1" cx="88" cy="100" r="3.4" />
          <circle className="orb-dot orb-dot-2" cx="100" cy="100" r="3.4" />
          <circle className="orb-dot orb-dot-3" cx="112" cy="100" r="3.4" />
        </g>
      )
    case 'off':
    default:
      return (
        <g className="orb-glyph">
          <path
            className="orb-stroke"
            d="M100 82a8 8 0 018 8v12a8 8 0 01-16 0V90a8 8 0 018-8z"
          />
          <path className="orb-stroke" d="M86 102a14 14 0 0028 0M100 116v6" strokeLinecap="round" />
        </g>
      )
  }
}

export default VoiceOrb
