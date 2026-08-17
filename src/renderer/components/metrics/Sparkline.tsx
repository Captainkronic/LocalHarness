import type { ReactElement } from 'react'
import './metrics.css'

export interface SparklineProps {
  values: number[]
  /** Any CSS colour, including a `var(--token)` reference. */
  color?: string
  width?: number
  height?: number
}

/**
 * A dependency-free trend line. No axes, no scale, no tooltip — it exists to
 * show shape (is decode decaying with depth?), not to be read off.
 *
 * Renders nothing at all with fewer than two usable samples, rather than
 * drawing a single point that implies a trend we do not have.
 */
export function Sparkline({
  values,
  color = 'currentColor',
  width = 44,
  height = 18
}: SparklineProps): ReactElement | null {
  const vals = values.filter((v) => Number.isFinite(v))
  if (vals.length < 2 || width <= 0 || height <= 0) return null

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min
  // Keep the stroke inside the box so it is not clipped at the extremes.
  const pad = 1.5
  const innerW = Math.max(1, width - pad * 2)
  const innerH = Math.max(1, height - pad * 2)
  const step = innerW / (vals.length - 1)

  const pt = (v: number, i: number): [number, number] => [
    pad + i * step,
    span === 0 ? height / 2 : pad + innerH * (1 - (v - min) / span)
  ]

  const points = vals.map((v, i) => pt(v, i).map((n) => n.toFixed(2)).join(',')).join(' ')
  const [lastX, lastY] = pt(vals[vals.length - 1], vals.length - 1)

  return (
    <svg
      className="mx-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Marks "most recent" so the eye knows which end is now. */}
      <circle cx={lastX} cy={lastY} r={1.4} fill={color} />
    </svg>
  )
}

export default Sparkline
