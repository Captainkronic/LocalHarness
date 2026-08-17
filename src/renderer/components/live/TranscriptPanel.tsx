/**
 * The Live workflow's right-hand panel: the call, after the fact.
 *
 * Spoken words are gone the moment they are said, so this is the only record of
 * what was actually heard — which matters more here than in a chat, because the
 * transcript is a guess. Half the "the model misunderstood me" moments turn out
 * to be a misheard word visible in this rail.
 *
 * Newest first: during a call the interesting turn is the one that just landed,
 * and a rail that grows downward would put it off-screen.
 */

import { useMemo, type JSX } from 'react'

import type { LiveExchange } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, formatMs } from '@renderer/lib/format'
import './live.css'

export function TranscriptPanel(): JSX.Element {
  const exchanges = useStore((s) => s.liveExchanges)
  const status = useStore((s) => s.liveStatus)

  const ordered = useMemo(() => [...exchanges].sort((a, b) => b.at - a.at), [exchanges])

  /** Median rather than mean: one cold model load at 19 seconds would otherwise
   *  describe every turn after it. */
  const medianFirstAudio = useMemo(() => {
    const values = exchanges
      .map((e) => e.timings?.firstAudioMs)
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b)
    if (values.length === 0) return null
    const mid = Math.floor(values.length / 2)
    return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  }, [exchanges])

  // The turn in flight has no exchange yet, but it is the one being waited on.
  const pending =
    status.state === 'transcribing' || status.state === 'thinking' || status.state === 'speaking'

  if (ordered.length === 0 && !pending) {
    return (
      <p className="pnl-empty">
        Every spoken turn lands here — what was heard, what came back, the camera
        frame if the camera was on, and how long it took before you heard anything.
      </p>
    )
  }

  return (
    <div className="lvt">
      {ordered.length > 0 ? (
        <div className="lvt-stats">
          <span className="lvt-stat tnum">
            {ordered.length} turn{ordered.length === 1 ? '' : 's'}
          </span>
          {medianFirstAudio !== null ? (
            <span
              className="lvt-stat tnum"
              title="Median time from the end of your speech to the first audio you heard"
            >
              {formatMs(medianFirstAudio)} median
            </span>
          ) : null}
        </div>
      ) : null}

      <ul className="lvt-list">
        {pending ? (
          <li className="lvt-item is-live">
            <div className="lvt-head">
              <span className="lvt-time">now</span>
              <span className="lvt-phase">{status.state}</span>
            </div>
            {status.lastUserText.trim() !== '' ? (
              <p className="lvt-said">{status.lastUserText}</p>
            ) : (
              <p className="lvt-said is-waiting">transcribing…</p>
            )}
            {status.assistantText.trim() !== '' ? (
              <p className="lvt-reply">{status.assistantText}</p>
            ) : null}
          </li>
        ) : null}

        {ordered.map((exchange) => (
          <Row key={exchange.id} exchange={exchange} />
        ))}
      </ul>
    </div>
  )
}

function Row({ exchange }: { exchange: LiveExchange }): JSX.Element {
  const first = exchange.timings?.firstAudioMs ?? null

  return (
    <li className="lvt-item">
      <div className="lvt-head">
        <span className="lvt-time tnum">{clockTime(exchange.at)}</span>
        {first !== null ? (
          <span
            className="lvt-first tnum"
            title="From the end of your speech to the first audio you heard"
          >
            {formatMs(first)}
          </span>
        ) : null}
      </div>

      <div className="lvt-body">
        {exchange.frameDataUrl !== undefined ? (
          <img
            className="lvt-thumb"
            src={exchange.frameDataUrl}
            alt="Camera frame sent with this turn"
            loading="lazy"
          />
        ) : null}
        <div className="lvt-text">
          <p className="lvt-said">{exchange.userText}</p>
          <p className="lvt-reply">{exchange.assistantText}</p>
        </div>
      </div>
    </li>
  )
}

export default TranscriptPanel
