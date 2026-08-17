/** Shared formatting helpers. Every renderer component uses these so numbers
 *  are rendered identically everywhere. */

/** 1234 -> "1.2k", 48231 -> "48.2k", 987 -> "987" */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
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

/** Colour for a context-usage fraction: calm until it matters. */
export function usageColor(fraction: number | null): string {
  if (fraction === null) return 'var(--fg-faint)'
  if (fraction >= 0.9) return 'var(--danger)'
  if (fraction >= 0.75) return 'var(--warn)'
  return 'var(--metric-context)'
}
