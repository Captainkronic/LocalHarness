import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '@renderer/state/store'
import { formatMs, formatTokens, formatTps } from '@renderer/lib/format'
import './metrics.css'

export interface PayloadBudgetProps {
  /**
   * Opens the MCP panel. `AppState` has no UI action for that, so the HUD
   * renders this readout non-interactive unless a handler is supplied.
   */
  onOpenMcp?: () => void
}

/** Last resort prefill rate, used only when nothing has been measured yet. */
const FALLBACK_TPS = 250
/** Recent Lab records to average the learned prefill rate over. */
const RATE_WINDOW = 8

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * What it costs, every single message, to have these tools loaded.
 *
 * Tool schemas are re-sent with every request, so this is not a one-off — it is
 * a tax on each turn, paid in prefill wall-clock. Showing the seconds is the
 * point; the token figure alone never made anyone turn a server off.
 */
export function PayloadBudget({ onOpenMcp }: PayloadBudgetProps): ReactElement {
  const mcpStates = useStore((s) => s.mcpStates)
  const mcpSpecs = useStore((s) => s.mcpSpecs)
  const nativeTools = useStore((s) => s.nativeTools)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const labHistory = useStore((s) => s.labHistory)
  const livePrefillTps = useStore((s) => s.live.prefillTps)
  const livePrefillEstimated = useStore((s) => s.live.prefillEstimated)
  const residentModelId = useStore((s) => s.health.residentModelId)

  const cost = useMemo(() => {
    // Only ready servers have tools on the wire; starting/failed ones cost nothing yet.
    const ready = mcpStates.filter((s) => s.status === 'ready')
    const pending = mcpStates.filter((s) => s.status === 'starting').length
    const mcpTokens = ready.reduce((n, s) => n + s.tokenCost, 0)

    const wf = workflows.find((w) => w.id === activeWorkflow)
    const enabledNative = new Set<string>(wf ? wf.nativeTools : [])
    const native = nativeTools.filter((t) => enabledNative.has(t.id))
    const nativeTokens = native.reduce((n, t) => n + t.tokens, 0)

    const labelFor = (id: string): string => mcpSpecs.find((s) => s.id === id)?.label ?? id

    return {
      total: mcpTokens + nativeTokens,
      mcpTokens,
      nativeTokens,
      nativeCount: native.length,
      pending,
      servers: ready.map((s) => ({ label: labelFor(s.id), tokens: s.tokenCost }))
    }
  }, [mcpStates, mcpSpecs, nativeTools, workflows, activeWorkflow])

  // Prefer a rate somebody actually measured over anything we assume.
  const rate = useMemo(() => {
    const usable = labHistory.filter((r) => Number.isFinite(r.prefillTps) && r.prefillTps > 0)
    const forModel = residentModelId ? usable.filter((r) => r.model === residentModelId) : []
    const pool = (forModel.length > 0 ? forModel : usable).slice(-RATE_WINDOW)
    if (pool.length > 0) {
      return {
        tps: median(pool.map((r) => r.prefillTps)),
        measured: true,
        source: `median of the last ${pool.length} completed request${pool.length === 1 ? '' : 's'}`
      }
    }
    if (livePrefillTps !== null && livePrefillTps > 0 && !livePrefillEstimated) {
      return { tps: livePrefillTps, measured: true, source: 'measured on the current turn' }
    }
    return { tps: FALLBACK_TPS, measured: false, source: 'assumed default — nothing measured yet' }
  }, [labHistory, residentModelId, livePrefillTps, livePrefillEstimated])

  const addedMs = cost.total > 0 ? (cost.total / rate.tps) * 1000 : 0

  // Blank strings are deliberate paragraph breaks; nulls are lines that do not apply.
  const tip = [
    `${cost.total} tool tokens are sent with every message, not once.`,
    '',
    ...cost.servers.map((s) => `  ${s.label}: ${s.tokens}`),
    cost.nativeCount > 0 ? `  Native tools (${cost.nativeCount}): ${cost.nativeTokens}` : null,
    cost.servers.length === 0 && cost.nativeCount === 0
      ? '  Nothing loaded — no tool payload.'
      : null,
    cost.pending > 0
      ? `  (${cost.pending} server${cost.pending === 1 ? '' : 's'} still starting — not on the wire yet)`
      : null,
    '',
    `At ${formatTps(rate.tps)} tok/s prefill that is about ${formatMs(addedMs)} added to every turn.`,
    `Prefill rate: ${rate.source}.`,
    rate.measured ? null : 'Marked "est." because no real prefill rate has been observed yet.',
    'Token counts are estimated from schema length at roughly 4 characters per token.'
  ]
    .filter((l): l is string => l !== null)
    .join('\n')

  const body = (
    <>
      <span className="mx-label">payload</span>
      <span className="mx-val tnum">{formatTokens(cost.total)}</span>
      <span className="mx-pay-time tnum">{cost.total > 0 ? `+${formatMs(addedMs)}` : '—'}</span>
      <span className="mx-pay-est">{cost.total > 0 && !rate.measured ? 'est.' : ''}</span>
    </>
  )

  if (onOpenMcp) {
    return (
      <button type="button" className="mx-slot mx-pay is-clickable" title={tip} onClick={onOpenMcp}>
        {body}
      </button>
    )
  }

  return (
    <div className="mx-slot mx-pay" title={tip}>
      {body}
    </div>
  )
}

export default PayloadBudget
