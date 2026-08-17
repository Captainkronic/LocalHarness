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
import './metrics.css'

const PHASE_TIP: Record<InferencePhase, string> = {
  idle: 'Nothing in flight.',
  queued: 'Request sent. The server has not begun answering it yet.',
  prefill: 'The model is reading the prompt. No tokens are produced during this phase, and the protocol reports no progress through it.',
  decode: 'The model is generating tokens.',
  tool: 'A tool call is running. The wait here is the tool, not the GPU.'
}

/**
 * The always-visible instrument strip.
 *
 * Every slot is a fixed width and every number is tabular, because a HUD that
 * shifts under the cursor while it updates is worse than no HUD. Values that
 * are unknown render an em dash in place rather than collapsing.
 */
export function MetricsHud(): ReactElement {
  const [open, setOpen] = useState(false)
  const phase = useStore((s) => s.live.phase)
  const elapsedMs = useStore((s) => s.live.elapsedMs)
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
          <span className="mx-phase-el tnum">{active ? formatMs(elapsedMs) : '—'}</span>
        </div>

        <span className="mx-sep" aria-hidden="true" />
        <PrefillBar />

        <span className="mx-sep" aria-hidden="true" />
        <SpeedGauge kind="prefill" />
        <span className="mx-sep mx-sep-faint" aria-hidden="true" />
        <SpeedGauge kind="decode" />

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

      {open && <MetricsDrawer onClose={() => setOpen(false)} />}
    </div>
  )
}

export default MetricsHud
