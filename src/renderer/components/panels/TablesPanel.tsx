import { useMemo, type JSX } from 'react'
import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, extname, shortenPath } from '@renderer/lib/format'
import { openExternally, reveal } from './GalleryPanel'
import './panels.css'

/** Row/column counts are the two facts worth promoting to headline numbers;
 *  everything else in meta is listed as-is. */
const HEADLINE_KEYS = new Set(['rows', 'columns'])

function numericMeta(meta: Artifact['meta'], key: string): number | null {
  if (!meta) return null
  const v = meta[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function TablesPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)

  const tables = useMemo(
    () =>
      artifacts.filter((a) => a.kind === 'data').sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  )

  if (tables.length === 0) {
    return (
      <p className="pnl-empty">
        No result sets yet. Query outputs and generated data files appear here with their
        true row and column counts — not the truncated preview the model saw.
      </p>
    )
  }

  return (
    <div className="tbl-list">
      {tables.map((a) => {
        const rows = numericMeta(a.meta, 'rows')
        const cols = numericMeta(a.meta, 'columns')
        const rest = Object.entries(a.meta ?? {}).filter(([k]) => !HEADLINE_KEYS.has(k))
        const ext = extname(a.path ?? a.url ?? a.label)

        return (
          <div key={a.id} className="tbl-card">
            <div className="tbl-head">
              <span className="tbl-label" title={a.label}>
                {a.label}
              </span>
              {ext ? <span className="tbl-ext">{ext}</span> : null}
            </div>

            {rows !== null || cols !== null ? (
              <div className="tbl-figures">
                <span className="tbl-figure">
                  <span className="tbl-figure-n tnum">
                    {rows !== null ? rows.toLocaleString() : '—'}
                  </span>
                  <span className="tbl-figure-k">rows</span>
                </span>
                <span className="tbl-figure">
                  <span className="tbl-figure-n tnum">
                    {cols !== null ? cols.toLocaleString() : '—'}
                  </span>
                  <span className="tbl-figure-k">columns</span>
                </span>
              </div>
            ) : null}

            {rest.length > 0 ? (
              <dl className="tbl-meta">
                {rest.map(([k, v]) => (
                  <div key={k} className="tbl-meta-row">
                    <dt className="tbl-meta-k">{k}</dt>
                    <dd className="tbl-meta-v tnum">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <div className="tbl-foot">
              {a.path ? (
                <span className="tbl-path" title={a.path}>
                  {shortenPath(a.path, 2)}
                </span>
              ) : (
                <span className="tbl-path tnum">{clockTime(a.createdAt)}</span>
              )}
              <span className="pnl-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => reveal(a)}
                >
                  Reveal
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => openExternally(a)}
                >
                  Open
                </button>
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default TablesPanel
