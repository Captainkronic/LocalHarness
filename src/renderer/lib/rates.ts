/**
 * The one place a prefill rate is derived.
 *
 * This existed twice, and the two copies disagreed by 15x on the same data:
 * one took the median of model-filtered records, the other the mean of
 * everything. The HUD said a 1.3k tool payload cost 8.2s per turn while the
 * sidebar said 273 tokens cost 114ms — implying ~2,400 tok/s on a box that
 * really does ~160-190.
 *
 * The mean is the wrong estimator here specifically because a request that hits
 * the server's prompt-prefix cache reports an enormous prefill rate — it barely
 * prefilled anything. Those outliers are common and one-sided, so they drag a
 * mean upward and make the payload look free. The median ignores them.
 */

import { PREFILL_CEILING_TPS } from './format'
import type { LabRecord } from '@shared/types'

/** Used only until something has actually been measured. */
export const FALLBACK_PREFILL_TPS = 250

/** How many recent records to consider. */
export const RATE_WINDOW = 12

export interface PrefillRate {
  tps: number
  /** False when this is the fallback, so the UI can mark it as an assumption. */
  measured: boolean
  /** Human explanation for a tooltip. */
  source: string
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

export function prefillRate(
  labHistory: LabRecord[],
  residentModelId: string | null,
  live: { tps: number | null; estimated: boolean }
): PrefillRate {
  /*
   * Cached prefixes are excluded, not averaged in.
   *
   * prefillTps is promptTokens / ttft, so a request whose prefix the server
   * already had reports tens of thousands of tokens per second for work it
   * never did. A median polluted by those makes the payload cost below look
   * FREE — "1.4k tokens adds 47ms to every turn" — when the real answer at a
   * measured ~250 tok/s is nearer six seconds. Understating a cost is the
   * worst direction to be wrong in for a number whose whole job is to let
   * someone decide what to switch off.
   */
  const usable = labHistory.filter(
    (r) => Number.isFinite(r.prefillTps) && r.prefillTps > 0 && r.prefillTps <= PREFILL_CEILING_TPS
  )
  // Prefer records from the model actually loaded — rates differ enormously
  // between a 27B and a 1B, and mixing them describes neither.
  const forModel = residentModelId ? usable.filter((r) => r.model === residentModelId) : []
  const pool = (forModel.length > 0 ? forModel : usable).slice(-RATE_WINDOW)

  if (pool.length > 0) {
    return {
      tps: median(pool.map((r) => r.prefillTps)),
      measured: true,
      source: `median of the last ${pool.length} completed request${pool.length === 1 ? '' : 's'}${
        forModel.length > 0 ? ' for this model' : ''
      }`
    }
  }
  if (live.tps !== null && live.tps > 0 && !live.estimated) {
    return { tps: live.tps, measured: true, source: 'measured on the current turn' }
  }
  return {
    tps: FALLBACK_PREFILL_TPS,
    measured: false,
    source: 'assumed default — nothing measured yet'
  }
}
