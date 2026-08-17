import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clockTime, shortenPath } from '@renderer/lib/format'
import './panels.css'

/**
 * Image artifacts.
 *
 * Sources: an artifact carries either a URL the renderer can load directly, or
 * only a path on disk. In the second case we ask main for a data URL rather than
 * pointing an <img> at file://, which the renderer is not allowed to read.
 *
 * The hook is exported because AudioPanel needs exactly the same resolution and
 * this file is the leaf of the two — importing the other way round would make a
 * cycle through ContextPanel.
 */
export function useArtifactSrc(artifact: Artifact): string | null {
  const { url, path } = artifact
  const [src, setSrc] = useState<string | null>(url ?? null)

  useEffect(() => {
    if (url) {
      setSrc(url)
      return
    }
    if (!path) {
      setSrc(null)
      return
    }
    let cancelled = false
    window.harness
      .invoke('artifacts:readDataUrl', path)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [url, path])

  return src
}

export function reveal(artifact: Artifact): void {
  const target = artifact.path ?? artifact.url
  if (target) void window.harness.invoke('artifacts:reveal', target)
}

export function openExternally(artifact: Artifact): void {
  const target = artifact.path ?? artifact.url
  if (target) void window.harness.invoke('artifacts:open', target)
}

function Thumb({
  artifact,
  onOpen
}: {
  artifact: Artifact
  onOpen: (id: string) => void
}): JSX.Element {
  const src = useArtifactSrc(artifact)
  const dims =
    artifact.meta && 'width' in artifact.meta && 'height' in artifact.meta
      ? `${String(artifact.meta.width)}×${String(artifact.meta.height)}`
      : null

  return (
    <button
      type="button"
      className="gal-thumb"
      title={`${artifact.label}\n${clockTime(artifact.createdAt)}`}
      onClick={() => onOpen(artifact.id)}
    >
      {src ? (
        <img className="gal-img" src={src} alt={artifact.label} loading="lazy" />
      ) : (
        <span className="gal-img-missing">no preview</span>
      )}
      <span className="gal-thumb-foot">
        <span className="gal-thumb-label">{artifact.label}</span>
        {dims ? <span className="gal-thumb-dims tnum">{dims}</span> : null}
      </span>
    </button>
  )
}

function Lightbox({
  artifact,
  onClose,
  onStep
}: {
  artifact: Artifact
  onClose: () => void
  onStep: (delta: number) => void
}): JSX.Element {
  const src = useArtifactSrc(artifact)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowRight') {
        onStep(1)
      } else if (e.key === 'ArrowLeft') {
        onStep(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep])

  const meta = Object.entries(artifact.meta ?? {})

  return createPortal(
    <div className="gal-lightbox" onMouseDown={onClose} role="presentation">
      <figure className="gal-lightbox-inner" onMouseDown={(e) => e.stopPropagation()}>
        {src ? (
          <img className="gal-lightbox-img" src={src} alt={artifact.label} />
        ) : (
          <div className="gal-lightbox-missing">
            This image could not be read back from disk.
          </div>
        )}
        <figcaption className="gal-lightbox-bar">
          <div className="gal-lightbox-text">
            <span className="gal-lightbox-label">{artifact.label}</span>
            <span className="gal-lightbox-meta">
              {artifact.path ? (
                <span className="gal-lightbox-path" title={artifact.path}>
                  {shortenPath(artifact.path, 3)}
                </span>
              ) : null}
              {meta.map(([k, v]) => (
                <span key={k} className="gal-lightbox-fact tnum">
                  {k} {String(v)}
                </span>
              ))}
              <span className="gal-lightbox-fact tnum">{clockTime(artifact.createdAt)}</span>
            </span>
          </div>
          <div className="gal-lightbox-actions">
            <button type="button" className="btn btn-sm" onClick={() => reveal(artifact)}>
              Reveal
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => openExternally(artifact)}
            >
              Open
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </figcaption>
      </figure>
    </div>,
    document.body
  )
}

export function GalleryPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)
  const [openId, setOpenId] = useState<string | null>(null)

  const images = useMemo(
    () =>
      artifacts
        .filter((a) => a.kind === 'image')
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  )

  const openIndex = images.findIndex((a) => a.id === openId)
  const open = openIndex >= 0 ? images[openIndex] : undefined

  const step = useCallback(
    (delta: number): void => {
      if (openIndex < 0 || images.length === 0) return
      const next = (openIndex + delta + images.length) % images.length
      const target = images[next]
      if (target) setOpenId(target.id)
    },
    [openIndex, images]
  )

  if (images.length === 0) {
    return (
      <p className="pnl-empty">
        No images yet. Anything ComfyUI renders or edits in this conversation lands here,
        newest first, with its path and dimensions.
      </p>
    )
  }

  return (
    <>
      <div className="gal-grid">
        {images.map((a) => (
          <Thumb key={a.id} artifact={a} onOpen={setOpenId} />
        ))}
      </div>
      {open ? (
        <Lightbox artifact={open} onClose={() => setOpenId(null)} onStep={step} />
      ) : null}
    </>
  )
}

export default GalleryPanel
