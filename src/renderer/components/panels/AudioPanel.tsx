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

/** Keys that are presentation or lineage rather than part of the recipe. */
const NOT_RECIPE = new Set(['changed', 'duration', 'durationMs'])

function AudioRow({ artifact, take }: { artifact: Artifact; take: number | null }): JSX.Element {
  const src = useArtifactSrc(artifact)
  // Fallback when the artifact carried no duration: ask the element once it has
  // loaded its metadata. That is a measurement, not a guess.
  const [probed, setProbed] = useState<number | null>(null)
  const duration = metaDuration(artifact.meta) ?? (probed !== null ? formatMs(probed) : null)
  const ext = extname(artifact.path ?? artifact.url ?? '')
  const recipe = Object.entries(artifact.meta ?? {}).filter(([k]) => !NOT_RECIPE.has(k))

  return (
    <div className="aud-row">
      <div className="aud-head">
        {take !== null ? <span className="aud-take">Take {take}</span> : null}
        <span className="aud-label" title={artifact.label}>
          {artifact.label}
        </span>
        <span className="aud-facts tnum">
          {duration ? <span className="aud-dur">{duration}</span> : null}
          {ext ? <span className="aud-ext">{ext}</span> : null}
          <span className="aud-time">{clockTime(artifact.createdAt)}</span>
        </span>
      </div>

      {/* What produced this take, and what moved since the last one. Without
          these two lines the panel is a pile of unrelated mp3s: a song cannot
          be edited, only rendered again, so the parameters ARE the lineage. */}
      {recipe.length > 0 ? (
        <dl className="aud-recipe">
          {recipe.map(([k, v]) => (
            <div key={k} className="aud-recipe-cell">
              <dt>{k}</dt>
              <dd className="tnum" title={String(v)}>
                {String(v)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {typeof artifact.meta?.['changed'] === 'string' ? (
        <p className="aud-changed" title="What moved since the previous take">
          {artifact.meta['changed']}
        </p>
      ) : null}

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

  // Take numbers come from the parentId chain, counted oldest-first, so "Take 3"
  // means the third render in that lineage rather than the third row on screen.
  const takeOf = new Map<string, number>()
  const byId = new Map(clips.map((c) => [c.id, c]))
  for (const clip of clips) {
    let depth = 1
    let cursor: Artifact | undefined = clip
    const seen = new Set<string>()
    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId)
      cursor = byId.get(cursor.parentId)
      if (!cursor) break
      depth += 1
    }
    // A lone render is not "Take 1 of 1" — the label only earns its place once
    // there is something to compare against.
    takeOf.set(clip.id, depth)
  }
  const hasChain = [...takeOf.values()].some((d) => d > 1)

  return (
    <div className="aud-list">
      {clips.map((a) => (
        <AudioRow key={a.id} artifact={a} take={hasChain ? (takeOf.get(a.id) ?? null) : null} />
      ))}
    </div>
  )
}

export default AudioPanel
