import { useMemo, type JSX } from 'react'
import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, extname, shortenPath } from '@renderer/lib/format'
import { openExternally, reveal } from './GalleryPanel'
import './panels.css'

/** Extension drives the badge. Nothing is inferred from the mime type — the
 *  docgen server decides the format from the filename suffix, so the suffix is
 *  the honest answer. */
function badgeFor(a: Artifact): string {
  const ext = extname(a.path ?? a.url ?? a.label)
  return ext === '' ? 'file' : ext
}

const KNOWN_TYPES = new Set(['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'csv', 'md', 'txt', 'html'])

export function DocumentsPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)

  const docs = useMemo(
    () =>
      artifacts
        .filter((a) => a.kind === 'document')
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  )

  if (docs.length === 0) {
    return (
      <p className="pnl-empty">
        No documents yet. PDFs, Word files, decks and spreadsheets written in this
        conversation are listed here with their real path on disk.
      </p>
    )
  }

  return (
    <div className="doc-list">
      {docs.map((a) => {
        const badge = badgeFor(a)
        return (
          <div key={a.id} className="doc-row">
            <span
              className={KNOWN_TYPES.has(badge) ? 'doc-badge is-known' : 'doc-badge'}
              aria-hidden="true"
            >
              {badge}
            </span>
            <span className="doc-text">
              <span className="doc-label" title={a.label}>
                {a.label}
              </span>
              <span className="doc-sub">
                {a.path ? (
                  <span className="doc-path" title={a.path}>
                    {shortenPath(a.path, 2)}
                  </span>
                ) : null}
                <span className="doc-time tnum">{clockTime(a.createdAt)}</span>
              </span>
            </span>
            <span className="pnl-actions doc-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => reveal(a)}>
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
        )
      })}
    </div>
  )
}

export default DocumentsPanel
