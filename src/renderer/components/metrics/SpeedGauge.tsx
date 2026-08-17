import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '@renderer/state/store'
import { clockTime, formatTps } from '@renderer/lib/format'
import Sparkline from './Sparkline'
import './metrics.css'

export interface SpeedGaugeProps {
  kind: 'prefill' | 'decode'
}

/** How many completed Lab records feed the trend line. */
const HISTORY = 30

const COLOR: Record<SpeedGaugeProps['kind'], string> = {
  prefill: 'var(--metric-prefill)',
  decode: 'var(--metric-decode)'
}

const TIP: Record<SpeedGaugeProps['kind'], string> = {
  prefill:
    'Prefill throughput — prompt tokens ÷ time to first token. Until the first token lands ' +
    'this is the rate learned from previous turns (shown with ≈), not a measurement of this turn.',
  decode:
    'Decode throughput — generated tokens per second over a rolling 2s window, so it shows the ' +
    'current rate rather than being dragged down by time-to-first-token.'
}

/**
 * One rate readout: live number plus the trend across recent completed
 * requests, so the decay of throughput with context depth is visible rather
 * than something you have to remember between turns.
 */
export function SpeedGauge({ kind }: SpeedGaugeProps): ReactElement {
  const livePrefill = useStore((s) => s.live.prefillTps)
  const liveDecode = useStore((s) => s.live.decodeTps)
  const prefillEstimated = useStore((s) => s.live.prefillEstimated)
  const labHistory = useStore((s) => s.labHistory)

  const live = kind === 'prefill' ? livePrefill : liveDecode

  const values = useMemo(
    () =>
      labHistory
        .slice(-HISTORY)
        .map((r) => (kind === 'prefill' ? r.prefillTps : r.tps))
        .filter((v) => Number.isFinite(v) && v > 0),
    [labHistory, kind]
  )

  const last = useMemo(() => {
    for (let i = labHistory.length - 1; i >= 0; i--) {
      const r = labHistory[i]
      const v = kind === 'prefill' ? r.prefillTps : r.tps
      if (Number.isFinite(v) && v > 0) return { v, ts: r.ts, model: r.model }
    }
    return null
  }, [labHistory, kind])

  // Between turns there is no live rate, but there IS a real one: the last
  // completed request. Showing "—" while holding a measured number was just
  // withholding it — prefill never looked empty because it falls back to its
  // estimate, so only decode ever read as broken. Marked as not-live rather
  // than passed off as current: '≈' means projected, '·' means last measured.
  const value = live ?? (kind === 'decode' ? (last?.v ?? null) : null)
  const isEstimate = kind === 'prefill' && prefillEstimated && value !== null
  const isLast = live === null && value !== null

  const tip =
    TIP[kind] +
    (last
      ? `\n\nLast completed request: ${formatTps(last.v)} tok/s at ${clockTime(last.ts)} (${last.model}).` +
        `\nTrend: last ${values.length} request${values.length === 1 ? '' : 's'} from the Lab feed, oldest left.`
      : '\n\nNo completed requests recorded yet — the trend line appears once the Lab feed reports one.')

  return (
    <div className={`mx-slot mx-gauge is-${kind}`} title={tip}>
      <span className="mx-label">{kind}</span>
      {/* Reserved glyph slot: marks the number as projected or as the last
          measured one, without shifting it. */}
      <span className="mx-approx" aria-hidden={!isEstimate && !isLast}>
        {isEstimate ? '≈' : isLast ? '·' : ''}
      </span>
      <span
        className={`mx-val tnum${value === null ? ' mx-null' : ''}${isLast ? ' is-last' : ''}`}
      >
        {formatTps(value)}
      </span>
      <span className="mx-unit">tok/s</span>
      <span className="mx-spark-slot">
        <Sparkline values={values} color={COLOR[kind]} width={44} height={18} />
      </span>
    </div>
  )
}

export default SpeedGauge
