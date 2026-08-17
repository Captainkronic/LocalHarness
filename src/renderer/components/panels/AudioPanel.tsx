import { useMemo, useState, type JSX } from 'react'
import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, extname, formatMs, shortenPath } from '@renderer/lib/format'
import { openExternally, reveal, useArtifactSrc } from './GalleryPanel'
import './panels.css'

/** Duration from the artifact's own metadata, if it carried any. Servers are
 *  inconsistent about the unit, so both are accepted and anything else is shown
 *  verbatim rather than reinterpreted. */
function metaDuration(meta: Artifact['meta']): string | null {
  if (!meta) return null
  const ms = meta.durationMs
  if (typeof ms === 'number' && Number.isFinite(ms)) return formatMs(ms)
  const secs = meta.duration ?? meta.seconds
  if (typeof secs === 'number' && Number.isFinite(secs)) return formatMs(secs * 1000)
  if (typeof secs === 'string' && secs.trim() !== '') return secs
  return null
}

function AudioRow({ artifact }: { artifact: Artifact }): JSX.Element {
  const src = useArtifactSrc(artifact)
  // Fallback when the artifact carried no duration: ask the element once it has
  // loaded its metadata. That is a measurement, not a guess.
  const [probed, setProbed] = useState<number | null>(null)
  const duration = metaDuration(artifact.meta) ?? (probed !== null ? formatMs(probed) : null)
  const ext = extname(artifact.path ?? artifact.url ?? '')

  return (
    <div className="aud-row">
      <div className="aud-head">
        <span className="aud-label" title={artifact.label}>
          {artifact.label}
        </span>
        <span className="aud-facts tnum">
          {duration ? <span className="aud-dur">{duration}</span> : null}
          {ext ? <span className="aud-ext">{ext}</span> : null}
          <span className="aud-time">{clockTime(artifact.createdAt)}</span>
        </span>
      </div>

      {src ? (
        <audio
          className="aud-player"
          controls
          preload="metadata"
          src={src}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) setProbed(d * 1000)
          }}
        />
      ) : (
        <p className="aud-missing">This file could not be read back from disk.</p>
      )}

      <div className="aud-foot">
        {artifact.path ? (
          <span className="aud-path" title={artifact.path}>
            {shortenPath(artifact.path, 3)}
          </span>
        ) : (
          <span className="aud-path" />
        )}
        <span className="pnl-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => reveal(artifact)}>
            Reveal
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => openExternally(artifact)}
          >
            Open
          </button>
        </span>
      </div>
    </div>
  )
}

export function AudioPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)

  const clips = useMemo(
    () =>
      artifacts
        .filter((a) => a.kind === 'audio')
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  )

  if (clips.length === 0) {
    return (
      <p className="pnl-empty">
        No audio yet. Music, sound effects and speech generated in this conversation appear
        here with an inline player. Generation runs for minutes, not seconds.
      </p>
    )
  }

  return (
    <div className="aud-list">
      {clips.map((a) => (
        <AudioRow key={a.id} artifact={a} />
      ))}
    </div>
  )
}

export default AudioPanel
