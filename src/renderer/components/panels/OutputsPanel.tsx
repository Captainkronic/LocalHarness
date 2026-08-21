/**
 * Everything a conversation produced, in one list.
 *
 * The pieces already existed and were scattered by type: images in the gallery,
 * songs in the audio panel, PDFs in documents. A workflow that can write all
 * three had no single place showing what it had made — a spoken "make me an
 * invoice" wrote the PDF, said so out loud, and the file was findable only by
 * knowing where docgen puts things.
 *
 * So this is by RECENCY, not by type. What you are looking for is almost always
 * the thing that was just made, and sorting by kind buries it under whatever
 * category it happens to fall in.
 *
 * Preview is inline where inline is honest — a thumbnail, a player, the head of
 * a text file — and a lightbox for anything worth seeing large. Formats the web
 * cannot render (docx, xlsx, pptx) say so and offer the application that can,
 * rather than showing a broken frame.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

import type { Artifact } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename, clockTime, extname } from '@renderer/lib/format'
import { openExternally, reveal } from './GalleryPanel'
import './panels.css'

/**
 * Where the bytes can actually be read from.
 *
 * An artifact may carry a path, a URL, or both — and the URL is often a
 * file:// one, which is useless here: the renderer is not permitted to read the
 * filesystem, so an <img> or <embed> pointed at file:// renders nothing at all,
 * silently. A blank PDF frame is exactly what that looks like.
 *
 * So only http(s) URLs are handed to the DOM directly. Everything local goes
 * through main, including the case where the ONLY locator is a file:// URL,
 * which is unpicked back into a path rather than being given up on.
 */
function remoteUrl(a: Artifact): string | undefined {
  return a.url !== undefined && /^https?:\/\//i.test(a.url) ? a.url : undefined
}

function localPath(a: Artifact): string | undefined {
  if (a.path !== undefined && a.path !== '') return a.path
  if (a.url !== undefined && a.url.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(a.url).pathname)
    } catch {
      return undefined
    }
  }
  return undefined
}

interface Preview {
  /** A blob: URL, not the data: URL main sent. */
  src: string
  mime: string
  bytes: number
  /** Decoded, for the kinds that are shown as text. */
  text?: string
  /** The bytes are a picture of the file, not the file. */
  renderedFrom?: 'pdf'
}

/**
 * Loads a file's bytes only when something is going to show them, as a blob.
 *
 * The conversion is not cosmetic. Chromium's PDF viewer refuses a data: URL —
 * an <embed> pointed at one renders an empty grey rectangle with no error, in
 * the console or anywhere else, which is indistinguishable from a file that
 * failed to load. Blob URLs are same-origin and the viewer accepts them.
 *
 * It is also the cheaper representation: base64 costs a third again in size,
 * and a rendered song or a long PDF held as a JavaScript string is real memory
 * for as long as the component is mounted. The object URL is revoked on the way
 * out, or every preview leaks its file until the window closes.
 */
function usePreview(path: string | undefined, enabled: boolean): Preview | null | 'loading' {
  const [state, setState] = useState<Preview | null | 'loading'>(null)

  useEffect(() => {
    if (!enabled || path === undefined) {
      setState(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState('loading')
    window.harness
      .invoke('artifacts:preview', path)
      .then((p) => {
        if (cancelled || p === null) {
          if (!cancelled) setState(null)
          return
        }
        const comma = p.dataUrl.indexOf(',')
        const bin = atob(comma === -1 ? '' : p.dataUrl.slice(comma + 1))
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: p.mime }))
        const preview: Preview = { src: objectUrl, mime: p.mime, bytes: p.bytes }
        if (p.renderedFrom !== undefined) preview.renderedFrom = p.renderedFrom
        if (p.mime.startsWith('text/')) preview.text = new TextDecoder().decode(bytes)
        setState(preview)
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [path, enabled])

  return state
}

type Shape = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'opaque'

/**
 * What the row can do with this file, decided by extension.
 *
 * Not by Artifact.kind: that is set by whatever produced the artifact and is
 * 'document' for everything docgen writes, PDF and .docx alike — one of which
 * renders here and one of which cannot. The suffix is the honest answer to
 * "can this be shown", which is the only question being asked.
 */
function shapeOf(a: Artifact): Shape {
  const ext = extname(a.path ?? a.url ?? a.label).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (['txt', 'md', 'csv', 'json', 'log', 'html'].includes(ext)) return 'text'
  return 'opaque'
}

function badgeOf(a: Artifact): string {
  const ext = extname(a.path ?? a.url ?? a.label)
  return ext === '' ? 'file' : ext.toLowerCase()
}

function Thumb({ artifact }: { artifact: Artifact }): JSX.Element {
  const remote = remoteUrl(artifact)
  const preview = usePreview(localPath(artifact), remote === undefined)
  const src = remote ?? (preview !== null && preview !== 'loading' ? preview.src : null)
  if (src === null) return <span className="op-badge">{badgeOf(artifact)}</span>
  /* A rendered page needs paper under it — see .op-page. */
  const page = shapeOf(artifact) === 'pdf'
  return <img className={page ? 'op-thumb op-page' : 'op-thumb'} src={src} alt="" />
}

function Row({
  artifact,
  onLightbox
}: {
  artifact: Artifact
  onLightbox: (a: Artifact) => void
}): JSX.Element {
  const shape = shapeOf(artifact)
  const [open, setOpen] = useState(false)
  /* Audio and text load only once expanded: a panel that eagerly pulled every
     rendered song across the bridge would move hundreds of megabytes to show a
     list of filenames. */
  const inline = usePreview(localPath(artifact), open && (shape === 'audio' || shape === 'text'))

  const canShow = shape !== 'opaque'
  const activate = useCallback(() => {
    if (shape === 'image' || shape === 'pdf' || shape === 'video') onLightbox(artifact)
    else if (shape === 'audio' || shape === 'text') setOpen((v) => !v)
    else openExternally(artifact)
  }, [shape, artifact, onLightbox])

  return (
    <li className="op-row">
      <div className="op-main">
        <button
          type="button"
          className="op-hit"
          onClick={activate}
          title={localPath(artifact) ?? artifact.url ?? artifact.label}
        >
          {shape === 'image' || shape === 'pdf' ? (
            <Thumb artifact={artifact} />
          ) : (
            <span className="op-badge">{badgeOf(artifact)}</span>
          )}
          <span className="op-text">
            <span className="op-name">{basename(localPath(artifact) ?? artifact.label)}</span>
            <span className="op-meta">
              {clockTime(artifact.createdAt)}
              {canShow ? '' : ' · opens in its own app'}
            </span>
          </span>
        </button>
        <span className="op-acts">
          <button type="button" className="op-act" onClick={() => openExternally(artifact)} title="Open">
            Open
          </button>
          <button type="button" className="op-act" onClick={() => reveal(artifact)} title="Show in Finder">
            Reveal
          </button>
        </span>
      </div>

      {open && shape === 'audio' ? (
        inline === 'loading' ? (
          <p className="op-note">Loading…</p>
        ) : inline === null ? (
          <p className="op-note">Too large to play here — use Open.</p>
        ) : (
          <audio className="op-audio" controls preload="metadata" src={inline.src} />
        )
      ) : null}

      {open && shape === 'text' ? (
        inline === 'loading' ? (
          <p className="op-note">Loading…</p>
        ) : inline === null ? (
          <p className="op-note">Too large to show here — use Open.</p>
        ) : (
          <pre className="op-pre">{(inline.text ?? '').slice(0, 4000)}</pre>
        )
      ) : null}
    </li>
  )
}

/** Full-window, because a PDF or a render in a 300px column is not a preview. */
function Lightbox({ artifact, onClose }: { artifact: Artifact; onClose: () => void }): JSX.Element {
  const shape = shapeOf(artifact)
  const remote = remoteUrl(artifact)
  const preview = usePreview(localPath(artifact), remote === undefined)
  const src = remote ?? (preview !== null && preview !== 'loading' ? preview.src : null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="op-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="op-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="op-lightbox-bar">
          <span className="op-lightbox-name">{basename(localPath(artifact) ?? artifact.label)}</span>
          <button type="button" className="op-act" onClick={() => openExternally(artifact)}>
            Open
          </button>
          <button type="button" className="op-act" onClick={() => reveal(artifact)}>
            Reveal
          </button>
          <button type="button" className="op-act" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {src === null ? (
          <p className="op-note">
            {preview === 'loading' ? 'Loading…' : 'Too large to show here — use Open.'}
          </p>
        ) : shape === 'video' ? (
          <video className="op-frame" controls src={src} />
        ) : (
          <img
            className={
              preview !== null && preview !== 'loading' && preview.renderedFrom === 'pdf'
                ? 'op-full op-page'
                : 'op-full'
            }
            src={src}
            alt={artifact.label}
          />
        )}
        {preview !== null && preview !== 'loading' && preview.renderedFrom === 'pdf' ? (
          /* Said explicitly. A one-page picture of a document is a preview, and
             silently showing it as though it were the whole thing would make a
             ten-page report look like a one-page one. */
          <p className="op-note">First page — Open to read the whole document.</p>
        ) : null}
      </div>
    </div>,
    document.body
  )
}

export function OutputsPanel(): JSX.Element {
  const artifacts = useStore((s) => s.artifacts)
  const [lightbox, setLightbox] = useState<Artifact | null>(null)

  /* Newest first, and de-duplicated by the file itself. The same path can be
     recorded twice — once from a resource block and once mined out of the prose
     that names it — and two rows for one file reads as two files. */
  const files = useMemo(() => {
    const seen = new Set<string>()
    return [...artifacts]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((a) => {
        const key = a.path ?? a.url ?? a.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [artifacts])

  if (files.length === 0) {
    return (
      <div className="op is-empty">
        <p className="op-empty">
          Files made in this conversation show up here — images, audio, documents and data.
        </p>
      </div>
    )
  }

  return (
    <div className="op">
      <ul className="op-list">
        {files.map((a) => (
          <Row key={a.id} artifact={a} onLightbox={setLightbox} />
        ))}
      </ul>
      {lightbox === null ? null : (
        <Lightbox artifact={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  )
}

export default OutputsPanel
