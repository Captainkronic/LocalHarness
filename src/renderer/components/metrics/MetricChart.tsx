import { useMemo, useState, type ReactElement } from 'react'
import type { LabRecord } from '@shared/types'
import { formatTokens, clockTime } from '@renderer/lib/format'
import './metrics.css'

export interface MetricChartProps {
  kind: 'prefill' | 'decode'
  rows: LabRecord[]
  /** Rates above this are cache hits, not measurements. Prefill only. */
  ceiling?: number
}

const PAD = { l: 40, r: 10, t: 10, b: 18 }
const W = 520
const H = 150

/**
 * The sparkline, opened up and made readable.
 *
 * The sparkline in the HUD is deliberately unreadable — no axes, no scale, no
 * tooltip — because at 44x18 pixels it can only honestly show shape. That is the
 * right call for a glanceable strip and the wrong one the moment someone asks
 * "yes, but what was that spike". This is the same data with the answers
 * attached: hover any point for the rate, the time, the model, and the prompt
 * and completion sizes that produced it.
 *
 * Per REQUEST, not per second. Each point is one completed request from the Lab
 * feed, which is why the x axis is an index rather than a clock — requests are
 * not evenly spaced in time and drawing them as if they were would imply a
 * cadence that does not exist.
 */
export function MetricChart({ kind, rows, ceiling }: MetricChartProps): ReactElement {
  const [hover, setHover] = useState<number | null>(null)

  const points = useMemo(() => {
    return rows
      .map((r) => ({ r, v: kind === 'prefill' ? r.prefillTps : r.tps }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0)
      /* A cached prefill is not a prefill measurement. Including it would put a
         3000 tok/s spike on the axis and flatten every real point against the
         floor. */
      .filter((p) => kind !== 'prefill' || ceiling === undefined || p.v <= ceiling)
  }, [rows, kind, ceiling])

  if (points.length < 2) {
    return (
      <div className="mx-chart mx-chart-empty">
        Not enough completed requests yet — the chart needs at least two.
      </div>
    )
  }

  const vals = points.map((p) => p.v)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  /* A flat series should read as flat, not as noise amplified to fill the box. */
  const span = hi - lo < hi * 0.05 ? hi * 0.05 : hi - lo
  const base = hi - lo < hi * 0.05 ? hi - span / 2 : lo

  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const x = (i: number): number =>
    PAD.l + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1))
  const y = (v: number): number => PAD.t + innerH * (1 - (v - base) / span)

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(PAD.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.t + innerH).toFixed(1)} Z`

  const at = hover === null ? null : points[hover]
  const stroke = kind === 'prefill' ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className="mx-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mx-chart-svg"
        role="img"
        aria-label={`${kind} rate over the last ${points.length} requests`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Three gridlines and their values — enough to read a magnitude off,
            few enough not to become the picture. */}
        {[0, 0.5, 1].map((f) => {
          const v = base + span * f
          return (
            <g key={f}>
              <line
                x1={PAD.l} x2={W - PAD.r}
                y1={y(v)} y2={y(v)}
                className="mx-chart-grid"
              />
              <text x={PAD.l - 6} y={y(v) + 3} className="mx-chart-axis" textAnchor="end">
                {Math.round(v)}
              </text>
            </g>
          )
        })}

        <path d={area} className="mx-chart-area" style={{ fill: stroke }} />
        <path d={path} className="mx-chart-line" style={{ stroke }} />

        {points.map((p, i) => (
          <circle
            key={p.r.ts + '-' + i}
            cx={x(i)} cy={y(p.v)}
            r={hover === i ? 4 : 2.5}
            className={hover === i ? 'mx-chart-dot is-on' : 'mx-chart-dot'}
            style={{ fill: stroke }}
          />
        ))}

        {/* Full-height hit strips: a 2.5px dot is not a hover target, and
            requiring precision to read a chart is a way of not being read. */}
        {points.map((p, i) => (
          <rect
            key={'hit' + p.r.ts + '-' + i}
            x={x(i) - innerW / points.length / 2}
            y={PAD.t}
            width={innerW / points.length}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {at !== null ? (
          <line
            x1={x(hover as number)} x2={x(hover as number)}
            y1={PAD.t} y2={PAD.t + innerH}
            className="mx-chart-cursor"
          />
        ) : null}
      </svg>

      <div className="mx-chart-read">
        {at === null ? (
          <span className="mx-chart-hint">
            {points.length} requests · hover a point for its numbers
          </span>
        ) : (
          <>
            <span className="mx-chart-val tnum">{Math.round(at.v)} tok/s</span>
            <span className="mx-chart-meta tnum">{clockTime(at.r.ts)}</span>
            <span className="mx-chart-meta">{at.r.model}</span>
            <span className="mx-chart-meta tnum">
              in {formatTokens(at.r.inTokens)} · out {formatTokens(at.r.outTokens)}
            </span>
            <span className="mx-chart-meta tnum">ttft {(at.r.ttft / 1000).toFixed(1)}s</span>
          </>
        )}
      </div>
    </div>
  )
}

export default MetricChart
