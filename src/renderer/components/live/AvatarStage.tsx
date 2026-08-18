import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { Avatar, AvatarFrame } from '@shared/types'
import { AVATAR_FRAMES } from '@shared/types'
import { AVATAR_MOUTH_FRAMES, mouthForLevel } from '@shared/avatar'
import type { LiveSessionState } from '@shared/types'
import './live.css'

/**
 * The talking head.
 *
 * A stack of stills, one per frame, cross-faded against the speaker's output
 * level. There is no video and no model at runtime — the whole animation is
 * opacity, which is why it holds 60fps while the machine is busy doing the
 * thing that actually costs something.
 *
 * ## Why this does not re-render
 *
 * The level changes every frame. Putting that through React state would
 * reconcile the whole subtree sixty times a second for a number that only ever
 * moves an opacity. So the level is READ from a ref inside a rAF loop and
 * written straight to `style.opacity`. React renders this component when the
 * avatar or the session state changes, and not otherwise.
 *
 * ## Why the fade is hand-rolled rather than a CSS transition
 *
 * The target frame changes faster than a transition can finish, and restarting
 * a CSS transition mid-flight makes it jump. Lerping toward the target every
 * frame is both smoother and shorter code — and it doubles as the fix for the
 * one real flaw in the generated frames: they drift a percent or two in scale
 * between renders, and a crossfade hides a small shift that a hard cut would
 * turn into a visible pop.
 */

export interface AvatarStageProps {
  avatar: Avatar
  /** Reads the assistant's current output level, 0..1. */
  readLevel: () => number
  /**
   * Whether audio is still coming out of the speaker.
   *
   * NOT the same as `state === 'speaking'`, and this is the whole bug this
   * prop exists to fix. Main leaves 'speaking' when the last sentence has been
   * SYNTHESISED, and Kokoro synthesises far faster than real time — so for a
   * three-sentence reply the session reports 'listening' after about a second
   * while some seven seconds of audio is still queued against the AudioContext
   * clock. Gating the mouth on the session state stopped it dead a second into
   * every reply. Anything that means "still talking" has to ask the audio
   * clock, exactly as barge-in already does.
   */
  isPlaying: () => boolean
  state: LiveSessionState
}

/** How fast a frame fades in. Per rAF step, so ~4 frames to settle at 60fps. */
const FADE = 0.34

/** Blink timing. Real blinks are 100-150ms and come every few seconds; both
 *  are jittered because a metronome blink reads as a machine. */
const BLINK_MS = 130
const BLINK_GAP_MIN = 2600
const BLINK_GAP_MAX = 7000

export function AvatarStage({
  avatar,
  readLevel,
  isPlaying,
  state
}: AvatarStageProps): JSX.Element {
  const [sources, setSources] = useState<Partial<Record<AvatarFrame, string>>>({})
  const nodes = useRef(new Map<AvatarFrame, HTMLImageElement>())
  const opacity = useRef(new Map<AvatarFrame, number>())
  const stateRef = useRef(state)
  stateRef.current = state

  /* The renderer cannot load file:// URLs, so every frame is read back through
     main as a data URL. Done once per avatar and held — re-reading a megabyte
     of PNG on a state change would stall the very loop this exists to keep
     smooth. */
  useEffect(() => {
    let cancelled = false
    const paths = Object.entries(avatar.frames) as Array<[AvatarFrame, string]>
    void Promise.all(
      paths.map(async ([frame, path]) => {
        const url = await window.harness.invoke('artifacts:readDataUrl', path).catch(() => null)
        return [frame, url] as const
      })
    ).then((pairs) => {
      if (cancelled) return
      const next: Partial<Record<AvatarFrame, string>> = {}
      for (const [frame, url] of pairs) if (url) next[frame] = url
      setSources(next)
    })
    return () => {
      cancelled = true
    }
  }, [avatar.id, avatar.frames])

  /** Frames we actually have art for, in stacking order. */
  const present = useMemo(
    () => AVATAR_FRAMES.filter((f) => sources[f] !== undefined),
    [sources]
  )

  useEffect(() => {
    if (present.length === 0) return
    let raf = 0
    let blinkUntil = 0
    let nextBlink = performance.now() + gap()

    const tick = (now: number): void => {
      // Blinking is independent of speech: people blink while talking. It wins
      // the eyes for its 130ms and the mouth carries on underneath, which is
      // why it is chosen BEFORE the mouth rather than competing with it.
      if (now >= nextBlink && sources.blink !== undefined) {
        blinkUntil = now + BLINK_MS
        nextBlink = now + BLINK_MS + gap()
      }
      const blinking = now < blinkUntil

      let target: AvatarFrame
      if (blinking) {
        target = 'blink'
      } else if (stateRef.current === 'speaking' || isPlaying()) {
        target = mouthForLevel(readLevel())
      } else if (stateRef.current === 'listening' && sources.listening !== undefined) {
        target = 'listening'
      } else {
        target = 'rest'
      }
      // Degrade along the mouth ladder rather than straight to rest. A set
      // missing only `mouthMid` would otherwise snap the mouth SHUT at medium
      // volume — the loudest part of a word closing the mouth, which reads as
      // broken rather than as a smaller set.
      if (sources[target] === undefined) target = nearestAvailable(target, sources)

      for (const frame of present) {
        const want = frame === target ? 1 : 0
        const current = opacity.current.get(frame) ?? (frame === 'rest' ? 1 : 0)
        const next = current + (want - current) * FADE
        // Snap the tail, so a frame that is visually gone stops being composited.
        const settled = Math.abs(want - next) < 0.01 ? want : next
        if (settled !== current) {
          opacity.current.set(frame, settled)
          const node = nodes.current.get(frame)
          if (node) node.style.opacity = String(settled)
        }
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [present, sources, readLevel, isPlaying])

  if (present.length === 0) {
    return (
      <div className="av-stage av-stage-empty" aria-label={`${avatar.name}, loading`}>
        <span className="av-loading">{avatar.name}</span>
      </div>
    )
  }

  return (
    <div className="av-stage" data-state={state} aria-label={avatar.name}>
      {present.map((frame) => (
        <img
          key={frame}
          ref={(node) => {
            if (node) nodes.current.set(frame, node)
            else nodes.current.delete(frame)
          }}
          className="av-frame"
          src={sources[frame]}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ opacity: frame === 'rest' ? 1 : 0 }}
        />
      ))}
    </div>
  )
}

/**
 * The closest frame we actually have art for.
 *
 * Mouth frames step DOWN the ladder, so a missing shape shows a smaller opening
 * rather than a closed mouth. Everything else falls back to rest, which is the
 * only frame an avatar is guaranteed to have.
 */
function nearestAvailable(
  want: AvatarFrame,
  sources: Partial<Record<AvatarFrame, string>>
): AvatarFrame {
  const ladder = AVATAR_MOUTH_FRAMES.indexOf(want)
  if (ladder > 0) {
    for (let i = ladder - 1; i >= 0; i--) {
      const candidate = AVATAR_MOUTH_FRAMES[i]
      if (sources[candidate] !== undefined) return candidate
    }
  }
  return 'rest'
}

/** A jittered gap between blinks — a fixed interval reads as a machine. */
function gap(): number {
  return BLINK_GAP_MIN + Math.random() * (BLINK_GAP_MAX - BLINK_GAP_MIN)
}

export default AvatarStage
