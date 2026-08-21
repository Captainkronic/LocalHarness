/**
 * Tuning for "talk over it to cut it off", with the meter you tune against.
 *
 * First control in the settings panel, deliberately: it is the one setting here
 * whose right value cannot be reasoned about, only found, because it depends on
 * the room, the microphone, and how loudly this particular person talks.
 *
 * The setting existed and was off by default, buried in the Live workflow's
 * own settings — which the talk deck never shows, because it mounts that
 * workspace hidden for its microphone. So the feature was real, unreachable,
 * and disabled.
 *
 * The important part here is not the sliders, it is the meter under them. A
 * loudness threshold is untunable as a bare number: 0.45 of what, measured how,
 * against a voice at what distance from which microphone. With the live level
 * drawn on the same axis as the marker, tuning is talking normally, watching
 * where the level sits, and putting the line above it. Whether it is currently
 * over the line is drawn too, because "would that have interrupted it" is the
 * actual question being asked.
 */

import { useEffect, useRef, useState, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import '@renderer/components/talk/talk.css'

export function VoiceTuning(): JSX.Element {
  const live = useStore((s) => s.liveSettings)
  const update = useStore((s) => s.updateLiveSettings)
  const level = useStore((s) => s.micLevel)
  const running = useStore((s) => s.liveStatus.state !== 'off')
  /* Peak-hold: a syllable can peak and fall between two glances at the screen,
     so the loudest moment of the last couple of seconds stays marked. Tuning
     against an instantaneous reading means chasing a number that is gone by
     the time you have read it. */
  const [peak, setPeak] = useState(0)
  const peakRef = useRef({ value: 0, at: 0 })
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const now = performance.now()
      const p = peakRef.current
      if (level > p.value) {
        p.value = level
        p.at = now
      } else if (now - p.at > 2000) {
        p.value = level
      }
      setPeak(p.value)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [level])

  const over = level >= live.bargeThreshold
  const pct = (n: number): string => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`

  return (
    <div className="tk-tune">
      <label className="tk-tune-row">
        <input
          type="checkbox"
          checked={live.bargeIn}
          onChange={(e) => void update({ bargeIn: e.target.checked })}
        />
        <span className="tk-tune-label">Talk over it to cut it off</span>
      </label>
      <p className="tk-tune-note">
        {live.bargeIn
          ? 'Speak while it is talking and it stops to listen.'
          : 'Off — it finishes what it is saying. Interrupt still works.'}
      </p>

      <div className={live.bargeIn ? 'tk-tune-group' : 'tk-tune-group is-off'}>
        <div className="tk-tune-head">
          <span className="tk-tune-label">How loud</span>
          <span className="tk-tune-value tnum">{Math.round(live.bargeThreshold * 100)}</span>
        </div>
        {/*
          The meter and the marker share one axis, which is the whole point.
          bargeThreshold is stored on the level's own scale rather than as raw
          RMS so this line can sit honestly against these bars.
        */}
        <div className="tk-gauge">
          <div className="tk-gauge-fill" style={{ width: pct(level) }} data-over={over} />
          <div className="tk-gauge-peak" style={{ left: pct(peak) }} />
          <div className="tk-gauge-mark" style={{ left: pct(live.bargeThreshold) }} />
        </div>
        <input
          className="tk-slider"
          type="range"
          min={5}
          max={100}
          value={Math.round(live.bargeThreshold * 100)}
          onChange={(e) => void update({ bargeThreshold: Number(e.target.value) / 100 })}
          disabled={!live.bargeIn}
          aria-label="Loudness needed to interrupt"
        />
        <p className="tk-tune-note">
          {running
            ? over
              ? 'That would interrupt it.'
              : 'Talk now — the bar is your microphone. Put the line just above where you normally sit.'
            : 'Start a call to see your own level here.'}
        </p>

        <div className="tk-tune-head">
          <span className="tk-tune-label">For how long</span>
          <span className="tk-tune-value tnum">{live.bargeMs}ms</span>
        </div>
        <input
          className="tk-slider"
          type="range"
          min={40}
          max={800}
          step={10}
          value={live.bargeMs}
          onChange={(e) => void update({ bargeMs: Number(e.target.value) })}
          disabled={!live.bargeIn}
          aria-label="How long you must keep talking to interrupt"
        />
        <p className="tk-tune-note">
          Longer ignores a cough or a door; shorter cuts in sooner.
        </p>
      </div>

      <label className="tk-tune-row">
        <input
          type="checkbox"
          checked={live.speak}
          onChange={(e) => void update({ speak: e.target.checked })}
        />
        <span className="tk-tune-label">Speak replies aloud</span>
      </label>
      <p className="tk-tune-note">Off makes this dictation — you talk, it types.</p>
    </div>
  )
}

export default VoiceTuning
