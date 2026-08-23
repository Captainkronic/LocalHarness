import { useState } from 'react'
import type { ReactElement } from 'react'
import type { InferencePhase } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { formatMs, formatTokens } from '@renderer/lib/format'
import ContextMeter from './ContextMeter'
import MetricsDrawer from './MetricsDrawer'
import PayloadBudget from './PayloadBudget'
import PrefillBar from './PrefillBar'
import SpeedGauge from './SpeedGauge'
import MetricChart from './MetricChart'
import { PREFILL_CEILING_TPS } from '@renderer/lib/format'
import './metrics.css'
import { PHASE_TIP } from '@renderer/lib/phases'


/**
 * The always-visible instrument strip.
 *
 * Every slot is a fixed width and every number is tabular, because a HUD that
 * shifts under the cursor while it updates is worse than no HUD. Values that
 * are unknown render an em dash in place rather than collapsing.
 */
export function MetricsHud(): ReactElement {
  const [open, setOpen] = useState(false)
  /* Which gauge's chart is showing, if any. One at a time: two 150px charts
     stacked would push the transcript off the screen, which is the thing the
     strip exists to sit above rather than replace. */
  const [chart, setChart] = useState<'prefill' | 'decode' | null>(null)
  const labHistory = useStore((s) => s.labHistory)
  const phase = useStore((s) => s.live.phase)
  const elapsedMs = useStore((s) => s.live.elapsedMs)
  const phaseElapsedMs = useStore((s) => s.live.phaseElapsedMs)
  const promptTokens = useStore((s) => s.live.promptTokens)
  const completionTokens = useStore((s) => s.live.completionTokens)
  const ttftMs = useStore((s) => s.live.ttftMs)
  const modelId = useStore((s) => s.live.modelId)

  const active = phase !== 'idle'
  const phaseTip = [
    PHASE_TIP[phase],
    modelId ? `Model: ${modelId}` : '',
    active ? `Prompt: ${formatTokens(promptTokens)} tokens` : '',
    active ? `Generated: ${formatTokens(completionTokens)} tokens` : '',
    /* The clock beside the phase word measures the PHASE. The request's own age
       is the more surprising of the two once they differ, so it is named here
       rather than dropped. */
    active ? `This request has been open ${formatMs(elapsedMs)}` : '',
    ttftMs !== null ? `Time to first token: ${formatMs(ttftMs)}` : ''
  ]
    .filter((l) => l !== '')
    .join('\n')

  return (
    <div className="mx-hud-wrap">
      <div className="mx-hud" role="group" aria-label="Inference metrics">
        <div className="mx-slot mx-phase" title={phaseTip}>
          <i className={`dot mx-dot-${phase}`} aria-hidden="true" />
          <span className="mx-phase-name">{phase}</span>
          {/*
            * The phase's own elapsed, not the request's.
            *
            * This rendered `elapsedMs`, stamped once when the request left the
            * client and never re-stamped, so the number never reset when the
            * phase word changed. "tool 3m 30s" meant the request was 3m30s old,
            * not that the tool had run that long — and the turn strip directly
            * below simultaneously showed the same command's true "(10.2s)", so
            * the two surfaces contradicted each other on screen at once.
            */}
          <span className="mx-phase-el tnum">{active ? formatMs(phaseElapsedMs) : '—'}</span>
        </div>

        <span className="mx-sep" aria-hidden="true" />
        <PrefillBar />

        <span className="mx-sep" aria-hidden="true" />
        <SpeedGauge
          kind="prefill"
          expanded={chart === 'prefill'}
          onToggle={() => setChart(chart === 'prefill' ? null : 'prefill')}
        />
        <span className="mx-sep mx-sep-faint" aria-hidden="true" />
        <SpeedGauge
          kind="decode"
          expanded={chart === 'decode'}
          onToggle={() => setChart(chart === 'decode' ? null : 'decode')}
        />

        <span className="mx-sep" aria-hidden="true" />
        <ContextMeter />

        <span className="mx-sep" aria-hidden="true" />
        <PayloadBudget />

        <button
          type="button"
          className={`mx-toggle${open ? ' is-open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide telemetry detail' : 'Show telemetry detail'}
          title={open ? 'Hide telemetry detail' : 'Show telemetry detail'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4.5 6.5 8 10l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {chart !== null ? (
        <MetricChart
          kind={chart}
          rows={labHistory}
          ceiling={chart === 'prefill' ? PREFILL_CEILING_TPS : undefined}
        />
      ) : null}

      {open && <MetricsDrawer onClose={() => setOpen(false)} />}
    </div>
  )
}

export default MetricsHud
