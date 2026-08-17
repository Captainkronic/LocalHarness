import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { LabStatus } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, formatMs, formatTokens, formatTps, relativeTime } from '@renderer/lib/format'
import Sparkline from './Sparkline'
import './metrics.css'

export interface MetricsDrawerProps {
  onClose?: () => void
}

/** Rows shown in the record table. */
const TABLE_ROWS = 20
/** Records feeding the decode trend line. */
const TREND_ROWS = 40

/*
 * `LabRecord.ttft` is already in MILLISECONDS by the time it reaches the
 * renderer: lmstudio-lab.py reports seconds, and `normaliseTtft` in
 * src/main/telemetry/lab.ts converts before emitting. Converting again here
 * rendered a real 0.85s TTFT as "14m 10s" in every row.
 */

const LAB_DOT: Record<LabStatus, string> = {
  connected: 'dot-ok',
  connecting: 'dot-busy',
  disconnected: 'dot-warn',
  unavailable: ''
}

const LAB_EMPTY: Record<LabStatus, string> = {
  connected: 'Connected to the Lab feed. No completed requests have been reported yet — the first one will appear here.',
  connecting: 'Connecting to the Lab feed…',
  disconnected: 'The Lab feed dropped and is reconnecting with backoff. Nothing else is affected.',
  unavailable: 'No Lab feed.'
}

/** Measures its element so the trend line can be drawn at real pixel width. */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setWidth(Math.round(rect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** The full picture behind the strip: what we are talking to, and what it did. */
export function MetricsDrawer({ onClose }: MetricsDrawerProps): ReactElement {
  const health = useStore((s) => s.health)
  const labHistory = useStore((s) => s.labHistory)
  const [trendRef, trendWidth] = useElementWidth<HTMLDivElement>()

  // Store order is oldest-first; the table reads newest-first, the trend does not.
  const rows = useMemo(() => labHistory.slice(-TABLE_ROWS).reverse(), [labHistory])
  const trend = useMemo(
    () =>
      labHistory
        .slice(-TREND_ROWS)
        .map((r) => r.tps)
        .filter((v) => Number.isFinite(v) && v > 0),
    [labHistory]
  )

  const trendRange =
    trend.length >= 2 ? { hi: Math.max(...trend), lo: Math.min(...trend) } : null

  return (
    <div className="mx-drawer" role="region" aria-label="Inference telemetry">
      <div className="mx-drawer-head">
        <span className="section-label">telemetry</span>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <div className="mx-drawer-body scroll-y">
        <section className="mx-health">
          <div className="mx-health-cell">
            <span className="section-label">endpoint</span>
            <span className="mx-health-v mx-mono mx-ell" title={health.endpoint}>
              {health.endpoint || <span className="mx-null">not configured</span>}
            </span>
          </div>
          <div className="mx-health-cell">
            <span className="section-label">reachable</span>
            <span className="mx-health-v">
              <i className={`dot ${health.reachable ? 'dot-ok' : 'dot-error'}`} aria-hidden="true" />
              {health.reachable ? 'yes' : 'no'}
              {health.error && (
                <span className="mx-health-err" title={health.error}>
                  {health.error}
                </span>
              )}
            </span>
          </div>
          <div className="mx-health-cell">
            <span className="section-label">latency</span>
            <span className="mx-health-v tnum">{formatMs(health.latencyMs)}</span>
          </div>
          <div className="mx-health-cell">
            <span className="section-label">resident model</span>
            <span className="mx-health-v mx-ell" title={health.residentModelId ?? undefined}>
              {health.residentModelId ?? <span className="mx-null">none resident</span>}
            </span>
          </div>
          <div className="mx-health-cell">
            <span className="section-label">lab feed</span>
            <span className="mx-health-v">
              <i className={`dot ${LAB_DOT[health.labStatus]}`} aria-hidden="true" />
              {health.labStatus}
            </span>
          </div>
          <div className="mx-health-cell">
            <span className="section-label">last checked</span>
            <span className="mx-health-v">{relativeTime(health.lastCheckedAt)}</span>
          </div>
        </section>

        <div className="hr" />

        <section className="mx-trend">
          <div className="mx-trend-head">
            <span className="section-label">decode rate, last {trend.length} requests</span>
            {trendRange && (
              <span className="mx-trend-range tnum">
                {formatTps(trendRange.lo)}–{formatTps(trendRange.hi)} tok/s
              </span>
            )}
          </div>
          <div className="mx-trend-plot" ref={trendRef}>
            {trendWidth > 0 && trend.length >= 2 ? (
              <Sparkline
                values={trend}
                color="var(--metric-decode)"
                width={trendWidth}
                height={44}
              />
            ) : (
              <span className="mx-null mx-trend-none">
                Two completed requests are needed before a trend means anything.
              </span>
            )}
          </div>
        </section>

        <div className="hr" />

        <section className="mx-records">
          {rows.length === 0 ? (
            <div className="mx-empty">
              <p>{LAB_EMPTY[health.labStatus]}</p>
              <p>
                The Lab feed is optional telemetry from <strong>lmstudio-lab.py</strong> on the Mac
                Studio. It reports engine-measured throughput for every request the box serves — a
                better source than client-side timing, but a personal service on one machine.
                LocalHarness measures its own numbers regardless, and everything here works without
                it.
              </p>
            </div>
          ) : (
            <table className="mx-tbl">
              <thead>
                <tr>
                  <th>time</th>
                  <th>source</th>
                  <th>model</th>
                  <th>in</th>
                  <th>out</th>
                  <th title="Prefill throughput reported by the engine">prefill</th>
                  <th title="Decode throughput reported by the engine">decode</th>
                  <th title="Time to first token, as reported by the Lab feed">ttft</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td className="mx-td-l tnum">{clockTime(r.ts)}</td>
                    <td className="mx-td-l">
                      <span className="mx-ell" title={r.source}>
                        {r.source}
                      </span>
                    </td>
                    <td className="mx-td-l">
                      <span className="mx-ell mx-td-model" title={r.model}>
                        {r.model}
                      </span>
                    </td>
                    <td className="tnum">{formatTokens(r.inTokens)}</td>
                    <td className="tnum">{formatTokens(r.outTokens)}</td>
                    <td className="tnum mx-td-prefill">{formatTps(r.prefillTps)}</td>
                    <td className="tnum mx-td-decode">{formatTps(r.tps)}</td>
                    <td className="tnum">{formatMs(r.ttft)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )
}

export default MetricsDrawer
