import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '@renderer/state/store'
import { clockTime, formatPrefill, formatTps, PREFILL_CEILING_TPS } from '@renderer/lib/format'
import Sparkline from './Sparkline'
import './metrics.css'

export interface SpeedGaugeProps {
  /** Whether this gauge's chart is currently open. */
  expanded?: boolean
  /** Omit to render a plain, non-interactive gauge. */
  onToggle?: () => void
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
export function SpeedGauge({ kind, expanded = false, onToggle }: SpeedGaugeProps): ReactElement {
  const livePrefill = useStore((s) => s.live.prefillTps)
  /*
   * The sustained rate, not the two-second window.
   *
   * Adam: "the tok/sec readout at the bottom of the screen does not seem
   * syncronized [with] the tok/sec monitor at the top". They were two different
   * metrics wearing the same unit — this gauge showed the rolling window while
   * the status line showed the step average, so they disagreed by 3-4x during
   * any pause. Both now read one field the meter computes once. The sparkline
   * beside this number still carries the per-request history, which is where
   * variation belongs.
   */
  const liveDecode = useStore((s) => s.live.decodeTpsSustained)
  const prefillEstimated = useStore((s) => s.live.prefillEstimated)
  const labHistory = useStore((s) => s.labHistory)

  const live = kind === 'prefill' ? livePrefill : liveDecode

  /*
   * A cached prefix is not a prefill measurement and must not reach the trend.
   *
   * prefillTps is promptTokens / ttft, and when the server reuses a cached
   * prefix it never processed those tokens — 47k of them "in" 1.6s reads as
   * 29,755 tok/s. Arithmetically right, physically meaningless. Left in the
   * series it also destroys the sparkline it appears in: a real 250 tok/s
   * reading is drawn as a flat line along the bottom next to a 30k spike, so
   * the one thing this gauge exists to show — throughput decaying with context
   * depth — becomes invisible.
   */
  const values = useMemo(
    () =>
      labHistory
        .slice(-HISTORY)
        .map((r) => (kind === 'prefill' ? r.prefillTps : r.tps))
        .filter((v) => Number.isFinite(v) && v > 0)
        .filter((v) => kind !== 'prefill' || v <= PREFILL_CEILING_TPS),
    [labHistory, kind]
  )

  const last = useMemo(() => {
    for (let i = labHistory.length - 1; i >= 0; i--) {
      const r = labHistory[i]
      const v = kind === 'prefill' ? r.prefillTps : r.tps
      if (!Number.isFinite(v) || v <= 0) continue
      // Same reason as above: the last CACHED request is not the last measured
      // prefill rate, and quoting it in the tooltip would be a made-up number.
      if (kind === 'prefill' && v > PREFILL_CEILING_TPS) continue
      return { v, ts: r.ts, model: r.model }
    }
    return null
  }, [labHistory, kind])

  // Between turns there is no live rate, but there IS a real one: the last
  // completed request. Showing "—" while holding a measured number was just
  // withholding it — prefill never looked empty because it falls back to its
  // estimate, so only decode ever read as broken. Marked as not-live rather
  // than passed off as current: '≈' means projected, '·' means last measured.
  const value = live ?? (kind === 'decode' ? (last?.v ?? null) : null)
  /* Prefill says "cached" rather than quoting a rate for work never done.
     Not formatPrefill(), which appends its own unit — this gauge renders the
     unit in a separate slot so the two would collide. */
  const cached = kind === 'prefill' && value !== null && value > PREFILL_CEILING_TPS
  const text = cached ? 'cached' : formatTps(value)
  const isEstimate = kind === 'prefill' && prefillEstimated && value !== null && !cached
  const isLast = live === null && value !== null

  const tip =
    TIP[kind] +
    (last
      ? `\n\nLast completed request: ${kind === 'prefill' ? formatPrefill(last.v) : formatTps(last.v)} tok/s at ${clockTime(last.ts)} (${last.model}).` +
        `\nTrend: last ${values.length} request${values.length === 1 ? '' : 's'} from the Lab feed, oldest left.`
      : '\n\nNo completed requests recorded yet — the trend line appears once the Lab feed reports one.')

  /* A button, because it opens something. The sparkline beside it can only
     honestly show shape at 44x18; the chart underneath is where the numbers
     live, and nothing said the strip was clickable. */
  const Tag = onToggle ? 'button' : 'div'
  return (
    <Tag
      type={onToggle ? 'button' : undefined}
      className={`mx-slot mx-gauge is-${kind}${onToggle ? ' is-clickable' : ''}${expanded ? ' is-open' : ''}`}
      title={onToggle ? `${tip}\n\nClick to open the full chart.` : tip}
      onClick={onToggle}
      aria-expanded={onToggle ? expanded : undefined}
    >
      <span className="mx-label">{kind}</span>
      {/* Reserved glyph slot: marks the number as projected or as the last
          measured one, without shifting it. */}
      <span className="mx-approx" aria-hidden={!isEstimate && !isLast}>
        {isEstimate ? '≈' : isLast ? '·' : ''}
      </span>
      <span
        className={`mx-val tnum${value === null ? ' mx-null' : ''}${isLast ? ' is-last' : ''}`}
      >
        {text}
      </span>
      {/* No unit after "cached" — it is a state, not a rate, and "cached tok/s"
          reads as a number that got mangled. */}
      <span className="mx-unit">{cached ? '' : 'tok/s'}</span>
      <span className="mx-spark-slot">
        <Sparkline values={values} color={COLOR[kind]} width={44} height={18} />
      </span>
    </Tag>
  )
}

export default SpeedGauge
