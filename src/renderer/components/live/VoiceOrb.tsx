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

import { useEffect, useState, type CSSProperties, type JSX } from 'react'

import type { LiveSessionState } from '@shared/types'
import { clamp01 } from '@renderer/lib/format'
import './live.css'

export interface VoiceOrbProps {
  state: LiveSessionState
  /** Microphone level while listening, playback level while speaking. 0..1. */
  level: number
  /**
   * True while the microphone has gone quiet but the turn is deliberately being
   * held open in case the pause is only a pause.
   *
   * Worth its own state on screen. Without it the wait is indistinguishable
   * from the app having missed the question, and someone who thinks they were
   * missed repeats themselves — straight into the window that was being held
   * for them, which produces the exact interruption the hold exists to prevent.
   */
  pausing?: boolean
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

/**
 * The wireframe globe.
 *
 * This is the single thing that made the orb read as JARVIS rather than as a
 * generic assistant bubble: in the films he is not a glowing ball, he is a
 * latitude/longitude sphere drawn in hairlines, and the eye recognises the
 * construction long before it registers the colour.
 *
 * Latitudes are ellipses flattened by the sine of their angle, which is what
 * gives the sphere its curvature for free — no projection maths, just the fact
 * that a circle seen edge-on is a line.
 */
const GLOBE_R = 43
const LATITUDES = [-64, -42, -21, 0, 21, 42, 64].map((deg) => {
  const rad = (deg * Math.PI) / 180
  return {
    key: deg,
    equator: deg === 0,
    cy: 100 + Math.sin(rad) * GLOBE_R,
    rx: Math.cos(rad) * GLOBE_R,
    // Flattening rises away from the equator, so the poles read as looking down
    // on a curve rather than at a stack of flat rings.
    ry: Math.max(1.2, Math.cos(rad) * GLOBE_R * 0.2 + Math.abs(Math.sin(rad)) * 5)
  }
})
/** Meridians collapse and reopen on a stagger. Six of them at a sixth of a turn
 *  apart is enough for the eye to read it as one sphere rotating. */
const MERIDIANS = [0, 1, 2, 3, 4, 5]

/**
 * Dial graduations, in degrees.
 *
 * Fixed bearings on a bezel, NOT telemetry. The distinction is the same one the
 * tick marks make above: an ornament may move, but a number may not appear to
 * be a reading unless something actually read it. Four compass marks are true
 * of the dial itself, so they can be drawn without lying.
 */
const DIAL = [
  { label: '000', angle: -90 },
  { label: '090', angle: 0 },
  { label: '180', angle: 90 },
  { label: '270', angle: 180 }
].map((d) => {
  const rad = (d.angle * Math.PI) / 180
  return { ...d, x: 100 + Math.cos(rad) * 78, y: 100 + Math.sin(rad) * 78 }
})

/** Segmented rings. Irregular on purpose: even dashes read as a loading
 *  spinner, uneven ones read as an instrument. */
const RINGS = [
  { key: 'a', r: 88, dash: '14 5 3 9 2 67', cls: 'orb-ring-cw' },
  { key: 'b', r: 83, dash: '4 3 22 6 5 60', cls: 'orb-ring-ccw' },
  { key: 'c', r: 68, dash: '30 8 6 4 2 50', cls: 'orb-ring-cw-slow' }
]

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

/**
 * Whether the user has asked for reduced motion.
 *
 * Needed in JS, not CSS, because the speaking equaliser's bar heights are SVG
 * presentation attributes computed from the live playback level — no media
 * query can reach them, so `prefers-reduced-motion` was silently ignored by the
 * one element in here that moves the most.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function VoiceOrb({ state, level, pausing = false }: VoiceOrbProps): JSX.Element {
  const reduced = useReducedMotion()
  // NOT reduced. The arc meter is this component's honest reading of the
  // microphone, and it survives reduced motion precisely because it is static
  // geometry rather than an animation. Damping it here would turn an
  // accessibility preference into a lie about the input level.
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
      data-pausing={pausing && (state === 'listening' || state === 'capturing') ? 'yes' : undefined}
      style={{ '--orb-level': lvl.toFixed(3) } as CSSProperties}
      role="img"
      aria-label={
        pausing && (state === 'listening' || state === 'capturing')
          ? 'Still listening, waiting in case you are only pausing'
          : LABELS[state]
      }
    >
      <svg className="orb-svg" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          {/* Lit from the centre, not from a corner. A top-left highlight
              reads as a glass bead catching a lamp; JARVIS is a projection,
              and a projection is brightest where it is densest. */}
          <radialGradient id="orb-fill" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="var(--orb-hot)" stopOpacity="0.5" />
            <stop offset="42%" stopColor="var(--orb-c)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--orb-c)" stopOpacity="0.03" />
          </radialGradient>
          <clipPath id="orb-clip">
            <circle cx="100" cy="100" r="56" />
          </clipPath>
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

        {/* Segmented rings, counter-rotating on their own radii. Ornament —
            they run whenever a call is up and stop dead under reduced motion. */}
        <g className="orb-sweeps">
          {RINGS.map((ring) => (
            <circle
              key={ring.key}
              className={`orb-sweep ${ring.cls}`}
              cx="100"
              cy="100"
              r={ring.r}
              pathLength="100"
              strokeDasharray={ring.dash}
            />
          ))}
        </g>

        {/* Bearings on the bezel. See DIAL: graduations, not readings. */}
        <g className="orb-dial">
          {DIAL.map((d) => (
            <text key={d.label} className="orb-dial-mark" x={d.x} y={d.y}>
              {d.label}
            </text>
          ))}
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

        {/* The globe. Clipped to the shell so the scan line cannot escape it. */}
        <g className="orb-globe" clipPath="url(#orb-clip)">
          {LATITUDES.map((l) => (
            <ellipse
              key={l.key}
              className={l.equator ? 'orb-lat orb-lat-equator' : 'orb-lat'}
              cx="100"
              cy={l.cy}
              rx={l.rx}
              ry={l.ry}
            />
          ))}
          <circle className="orb-limb" cx="100" cy="100" r={GLOBE_R} />
          {MERIDIANS.map((i) => (
            <ellipse
              key={i}
              className="orb-meridian"
              cx="100"
              cy="100"
              rx={GLOBE_R}
              ry={GLOBE_R}
              // NEGATIVE, so the six start already spread through the cycle.
              // A positive delay leaves them stacked as one circle until the
              // last one joins, and for those first seconds it is not a sphere.
              style={{ animationDelay: `${(-i * 7) / MERIDIANS.length}s` }}
            />
          ))}
          <rect className="orb-sweepline" x="42" y="98" width="116" height="2.5" />
        </g>

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

        <StateGlyph state={state} level={lvl} reduced={reduced} />
      </svg>

      <span className="orb-label">
        {pausing && (state === 'listening' || state === 'capturing')
          ? 'Still listening — take your time'
          : LABELS[state]}
      </span>
    </div>
  )
}

/** A different shape per phase, so the state survives being colour-blind or
 *  glanced at from across the desk. */
function StateGlyph({
  state,
  level,
  reduced
}: {
  state: LiveSessionState
  level: number
  reduced: boolean
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
            // Held at a representative level under reduced motion, so the shape
            // still reads as "speaking" without the bars dancing. Frozen at
            // zero would read as broken; the arc meter beside it keeps
            // reporting the real level either way.
            const amp = reduced ? 0.45 : level
            const h = 6 + amp * 30 * falloff * BAR_WEIGHTS[i]
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
