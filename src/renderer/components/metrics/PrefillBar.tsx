import type { ReactElement } from 'react'
import { useStore } from '@renderer/state/store'
import { clamp01, formatMs } from '@renderer/lib/format'
import './metrics.css'

/**
 * The honesty note that has to travel with this readout everywhere it appears.
 * Between the request leaving the client and the first token arriving, the
 * OpenAI streaming protocol says nothing at all — there is no prefill progress
 * on the wire. Anything we draw here is a projection.
 */
const ESTIMATE_TIP =
  'Estimated, not measured. The OpenAI streaming protocol carries no prefill progress — ' +
  'between sending the request and the first token there is silence on the wire. ' +
  'This bar is a projection from the prompt token count and the prefill rate learned ' +
  'from this model on previous turns. The hatched fill marks it as a projection; it is ' +
  'held below 100% until a token actually lands.'

const IDLE_TIP =
  'Prefill progress. Fills while the model is reading the prompt, before the first token.'

/** Only reachable if the client reports a measured prefill rate mid-prefill. */
const MEASURED_TIP =
  'Prefill progress, scaled from a prefill rate measured on this turn rather than the ' +
  'rate learned from previous ones. The position within the prompt is still inferred — ' +
  'the protocol reports no prefill progress.'

/** Thin determinate bar for prompt processing, with an ETA to first token. */
export function PrefillBar(): ReactElement {
  const phase = useStore((s) => s.live.phase)
  const progress = useStore((s) => s.live.prefillProgress)
  const estimated = useStore((s) => s.live.prefillEstimated)
  const etaMs = useStore((s) => s.live.prefillEtaMs)

  const active = phase === 'prefill'
  const determinate = active && progress !== null
  const pct = determinate ? clamp01(progress) * 100 : null

  return (
    <div
      className="mx-slot mx-pf"
      title={active ? (estimated ? ESTIMATE_TIP : MEASURED_TIP) : IDLE_TIP}
    >
      <div
        className={`mx-pf-track${active ? ' is-active' : ''}`}
        role="progressbar"
        aria-label={estimated ? 'Prefill progress (estimated)' : 'Prefill progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={
          pct === null
            ? active
              ? 'in progress, amount unknown'
              : 'idle'
            : `${Math.round(pct)}%${estimated ? ', estimated' : ''}`
        }
      >
        {determinate && (
          <div
            className={`mx-pf-fill${estimated ? ' is-est' : ''}`}
            style={{ width: `${pct ?? 0}%` }}
          />
        )}
        {/* No estimable progress: an indeterminate sweep, never a made-up percentage. */}
        {active && !determinate && <div className="mx-pf-shimmer" />}
      </div>

      {/* Fixed-width slots below: the strip must not reflow as these appear. */}
      <span className="mx-pf-est">{active && estimated ? 'est.' : ''}</span>
      <span className="mx-pf-eta tnum">{active ? formatMs(etaMs) : '—'}</span>
    </div>
  )
}

export default PrefillBar
