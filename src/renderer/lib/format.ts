/** Shared formatting helpers. Every renderer component uses these so numbers
 *  are rendered identically everywhere. */

/** 1234 -> "1.2k", 48231 -> "48.2k", 987 -> "987" */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * The fastest prefill this hardware can actually do, tokens/sec.
 *
 * Measured, not guessed: across 61 conversations the FIRST request of each —
 * the only guaranteed cache miss — clusters between 1,700 and 4,600 tok/s. And
 * even those are flattered, because the system prompt and tool schemas are
 * byte-identical across conversations, so their first few thousand tokens are
 * already in the server's cache too.
 *
 * Anything above this did not happen. See formatPrefill.
 */
export const PREFILL_CEILING_TPS = 5000

/**
 * Prefill throughput, or "cached" when the number is impossible.
 *
 * `promptTokens / ttft` silently measures three different things: real prefill,
 * a prompt-cache hit where the prefix was never reprocessed, and — when a turn
 * is composing a tool call — minutes of wire silence that had nothing to do
 * with reading the prompt. Across one conversation the reported figure ranged
 * from 127 to 27,076 tok/s, a 213x spread, and 27,000 tok/s on a 27B model on
 * this box is not slow measurement, it is arithmetic on a divisor that
 * represents no work.
 *
 * In an agentic loop this is the COMMON case, not the exception: every request
 * re-sends the whole history, so almost all of them are near-total cache hits.
 * Saying "cached" is both truer and more useful than a fictional rate — it
 * tells you the prompt did not have to be read again.
 *
 * The server offers no help here: LM Studio's usage carries prompt_tokens,
 * completion_tokens and reasoning_tokens, and no cached_tokens field, so how
 * much was actually processed cannot be known. Only that it cannot have been
 * all of it.
 */
export function formatPrefill(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return '—'
  if (tps > PREFILL_CEILING_TPS) return 'cached'
  return `${formatTps(tps)} tok/s`
}

/** Tokens per second, one decimal under 100. */
export function formatTps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  return n < 100 ? n.toFixed(1) : String(Math.round(n))
}

/** 850 -> "850ms", 4200 -> "4.2s", 96000 -> "1m 36s" */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/** 0.42 -> "42%" */
export function formatPercent(f: number | null | undefined, digits = 0): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—'
  return `${(f * 100).toFixed(digits)}%`
}

/**
 * A count of CHARACTERS, labelled as characters.
 *
 * Distinct from formatBytes on purpose. A model's tool-call arguments are a
 * JavaScript string, so `.length` counts UTF-16 code units, and calling that
 * "KB" is wrong for anything non-ASCII — it was being reported as KB, which
 * overstates ASCII by 1024/1000 and understates multibyte text by half.
 */
export function formatChars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)} chars`
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k chars`
  return `${Math.round(n / 1000)}k chars`
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`
}

/** "just now", "4m ago", "3h ago", "Aug 12" */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 45_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.round(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Strip a leading home dir so paths fit in the UI. */
export function shortenPath(p: string, maxSegments = 3): string {
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= maxSegments) return p
  return `…/${parts.slice(-maxSegments).join('/')}`
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}

/** Clamp a 0..1 fraction for use in a width/stroke calculation. */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Colour for a context-usage fraction: calm until it matters.
 *
 * `warnAt` is settings.contextWarnFraction — the Settings panel promises the
 * meter turns amber past it, so it has to be the actual threshold rather than a
 * hardcoded one. Danger sits halfway between the warning point and full.
 */
export function usageColor(fraction: number | null, warnAt = 0.75): string {
  if (fraction === null) return 'var(--fg-faint)'
  const warn = Math.min(Math.max(warnAt, 0.05), 0.98)
  if (fraction >= warn + (1 - warn) / 2) return 'var(--danger)'
  if (fraction >= warn) return 'var(--warn)'
  return 'var(--metric-context)'
}
