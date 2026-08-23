import type { ServerProgress } from '@shared/types'

/**
 * Ask the inference server what it is actually doing right now.
 *
 * The streaming protocol carries no progress. Nothing arrives during prefill,
 * and on a backend that sends a tool call only once it is complete, nothing
 * arrives while a file is being written either — so a turn can look dead for
 * eight minutes while the machine is flat out. Every estimate the app showed
 * through those stretches was a projection from earlier turns.
 *
 * oMLX publishes the truth at /admin/api/activity:
 *
 *   prefilling: [{ processed: 16384, total: 39049, speed: 159.3, eta: 142.3 }]
 *
 * Measured, not projected, and it advances in whole prefill chunks. Asking for
 * it turns "nothing on the wire for 8m 1s" into "reading 16,384 of 39,049
 * tokens, 159 tok/s, about 2m 22s left" — which is the difference between a
 * user believing the app has hung and a user watching it work.
 *
 * Best effort in every direction. The path is not part of the OpenAI surface,
 * so most backends 404 and that is the normal case, not a fault: a server that
 * cannot answer simply leaves the app with the estimates it already had.
 */
export async function fetchServerProgress(
  baseUrl: string,
  signal: AbortSignal,
  timeoutMs = 2_000
): Promise<ServerProgress | null> {
  /* /v1 is the chat surface; the admin surface sits beside it, not under it. */
  const root = baseUrl.replace(/\/v\d+\/?$/, '').replace(/\/+$/, '')
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${root}/admin/api/activity`, {
      signal: ctl.signal,
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return null
    return parseActivity(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Exported for tests: the shape is the server's, and it will drift. */
export function parseActivity(payload: unknown): ServerProgress | null {
  const models = rec(rec(payload)?.active_models)?.models
  if (!Array.isArray(models)) return null

  for (const entry of models) {
    const m = rec(entry)
    if (m === null) continue

    const pre = firstRow(m.prefilling)
    if (pre !== null) {
      const processed = num(pre.processed)
      const total = num(pre.total)
      if (processed !== null && total !== null && total > 0) {
        return {
          phase: 'prefill',
          processed,
          total,
          tps: num(pre.speed),
          etaMs: num(pre.eta) === null ? null : (num(pre.eta) as number) * 1000
        }
      }
    }

    const gen = firstRow(m.generating)
    if (gen !== null) {
      /* Generation has no known total — max_tokens is a ceiling, not a plan —
         so the count is reported and no fraction is invented from it. */
      return {
        phase: 'generate',
        /* No `?? 0`. oMLX sends this row with processed absent, and a fabricated
           zero reads as "nothing is happening" for as long as generation lasts. */
        processed: num(gen.processed) ?? num(gen.tokens),
        total: null,
        tps: num(gen.speed),
        etaMs: null
      }
    }
  }
  return null
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function firstRow(v: unknown): Record<string, unknown> | null {
  return Array.isArray(v) && v.length > 0 ? rec(v[0]) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
