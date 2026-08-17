import { useMemo, type JSX } from 'react'
import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime } from '@renderer/lib/format'
import './panels.css'

function hostnameOf(a: Artifact): string {
  const raw = a.url ?? a.path ?? ''
  if (raw === '') return ''
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return raw
  }
}

export function SourcesPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)

  const links = useMemo(
    () =>
      artifacts.filter((a) => a.kind === 'link').sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  )

  if (links.length === 0) {
    return (
      <p className="pnl-empty">
        No sources yet. Every page searched or fetched this session is collected here as a
        citation, so you can check what an answer was actually built from.
      </p>
    )
  }

  return (
    <ol className="src-list">
      {links.map((a, i) => {
        const target = a.url ?? a.path
        const host = hostnameOf(a)
        return (
          <li key={a.id} className="src-row">
            <span className="src-n tnum">{links.length - i}</span>
            <button
              type="button"
              className="src-main"
              title={target ?? a.label}
              disabled={!target}
              onClick={() => {
                if (target) void window.harness.invoke('artifacts:open', target)
              }}
            >
              <span className="src-title">{a.label}</span>
              <span className="src-sub">
                {host ? <span className="src-host">{host}</span> : null}
                <span className="src-time tnum">{clockTime(a.createdAt)}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export default SourcesPanel
