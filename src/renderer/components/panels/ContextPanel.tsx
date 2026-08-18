import { useCallback, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ArtifactKind, PanelKind } from '@shared/types'
import {
  PANEL_W_COLLAPSED,
  PANEL_W_DEFAULT,
  PANEL_W_MAX,
  PANEL_W_MIN
} from '@shared/types'
import { useStore } from '@renderer/state/store'
import GalleryPanel from './GalleryPanel'
import AudioPanel from './AudioPanel'
import DocumentsPanel from './DocumentsPanel'
import SourcesPanel from './SourcesPanel'
import TablesPanel from './TablesPanel'
import FilesPanel from './FilesPanel'
import EditsPanel from '@renderer/components/edit/EditsPanel'
import TranscriptPanel from '@renderer/components/live/TranscriptPanel'
import FlightsPanel from './FlightsPanel'
import HealthPanel from './HealthPanel'
import './panels.css'

/**
 * The right-hand contextual panel. Which panel appears is a property of the
 * workflow, not of the conversation — switching profile switches the panel with
 * everything else the profile decides.
 */

const TITLES: Record<Exclude<PanelKind, 'none'>, string> = {
  transcript: 'Transcript',
  flights: 'Flights',
  health: 'Case notes',
  files: 'Workspace',
  gallery: 'Gallery',
  edits: 'Edits',
  audio: 'Audio',
  documents: 'Documents',
  sources: 'Sources',
  tables: 'Tables'
}

/** Which artifact kind each panel counts in its header. `files` counts nothing —
 *  it is derived from tool calls, not artifacts. */
const COUNTED: Partial<Record<Exclude<PanelKind, 'none'>, ArtifactKind>> = {
  gallery: 'image',
  audio: 'audio',
  documents: 'document',
  sources: 'link',
  tables: 'data'
}

export function ContextPanel(): JSX.Element | null {
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const artifacts = useStore((s) => s.artifacts)
  const panelLayout = useStore((s) => s.settings.panelLayout)
  const updateSettings = useStore((s) => s.updateSettings)

  const kind: PanelKind = useMemo(
    () => workflows.find((w) => w.id === activeWorkflow)?.panel ?? 'none',
    [workflows, activeWorkflow]
  )

  const count = useMemo(() => {
    if (kind === 'none') return null
    const wanted = COUNTED[kind]
    if (!wanted) return null
    return artifacts.reduce((n, a) => n + (a.kind === wanted ? 1 : 0), 0)
  }, [kind, artifacts])

  const saved = kind === 'none' ? undefined : panelLayout[kind]
  const savedWidth = saved?.width ?? PANEL_W_DEFAULT
  const collapsed = saved?.collapsed ?? false

  /* Width is held locally WHILE dragging and read from settings otherwise.
     Writing every pointermove would put a settings round-trip (and a disk
     write) behind every frame of the drag; reading from settings the rest of
     the time means a width set in one workflow is already there when another
     with the same panel opens. */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const widthRef = useRef(savedWidth)
  const width = dragWidth ?? savedWidth
  widthRef.current = width

  const persist = useCallback(
    (patch: { width?: number; collapsed?: boolean }) => {
      if (kind === 'none') return
      void updateSettings({
        panelLayout: {
          ...panelLayout,
          [kind]: {
            width: patch.width ?? widthRef.current,
            collapsed: patch.collapsed ?? collapsed
          }
        }
      })
    },
    [kind, panelLayout, collapsed, updateSettings]
  )

  const onHandleDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    // Capture on the handle, so a fast drag that outruns the cursor does not
    // drop the gesture the moment it leaves the 6px hit area.
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    setDragWidth(widthRef.current)
  }, [])

  const onHandleMove = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    // The panel is anchored right, so its width is the distance from the
    // pointer to the window edge.
    const next = clamp(window.innerWidth - e.clientX)
    setDragWidth(next)
  }, [])

  const onHandleUp = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (dragWidth !== null) persist({ width: dragWidth })
    setDragWidth(null)
  }, [dragWidth, persist])

  /* The handle is a real control, not just a hit area: focusable, and nudged
     with the arrow keys. A drag-only resize is unusable without a pointer. */
  const onHandleKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 40 : 8
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      persist({ width: clamp(widthRef.current + step) })
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      persist({ width: clamp(widthRef.current - step) })
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      persist({ collapsed: !collapsed })
    }
  }, [persist, collapsed])

  if (kind === 'none') return null

  if (collapsed) {
    return (
      <aside
        className="ctx-panel is-collapsed"
        style={{ width: PANEL_W_COLLAPSED }}
        aria-label={`${TITLES[kind]} (collapsed)`}
      >
        <button
          type="button"
          className="ctx-reopen"
          onClick={() => persist({ collapsed: false })}
          title={`Show ${TITLES[kind]}`}
        >
          <ChevronIcon direction="left" />
          <span className="ctx-reopen-label">{TITLES[kind]}</span>
          {count !== null && count > 0 ? (
            <span className="ctx-reopen-count tnum">{count}</span>
          ) : null}
        </button>
      </aside>
    )
  }

  return (
    <aside
      className={`ctx-panel${dragWidth !== null ? ' is-resizing' : ''}`}
      style={{ width }}
      aria-label={TITLES[kind]}
    >
      <div
        className="ctx-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${TITLES[kind]}`}
        aria-valuenow={width}
        aria-valuemin={PANEL_W_MIN}
        aria-valuemax={PANEL_W_MAX}
        tabIndex={0}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={onHandleKey}
        onDoubleClick={() => persist({ width: PANEL_W_DEFAULT })}
        title="Drag to resize, double-click to reset"
      />
      <header className="ctx-head">
        <span className="section-label">{TITLES[kind]}</span>
        {count !== null ? <span className="ctx-count tnum">{count}</span> : null}
        <button
          type="button"
          className="ctx-collapse"
          onClick={() => persist({ collapsed: true })}
          title={`Hide ${TITLES[kind]}`}
        >
          <ChevronIcon direction="right" />
        </button>
      </header>
      <div className="ctx-body scroll-y">
        {kind === 'gallery' ? <GalleryPanel /> : null}
        {kind === 'audio' ? <AudioPanel /> : null}
        {kind === 'documents' ? <DocumentsPanel /> : null}
        {kind === 'sources' ? <SourcesPanel /> : null}
        {kind === 'tables' ? <TablesPanel /> : null}
        {kind === 'files' ? <FilesPanel /> : null}
        {kind === 'edits' ? <EditsPanel /> : null}
        {kind === 'transcript' ? <TranscriptPanel /> : null}
        {kind === 'flights' ? <FlightsPanel /> : null}
        {kind === 'health' ? <HealthPanel /> : null}
      </div>
    </aside>
  )
}

function clamp(w: number): number {
  return Math.round(Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, w)))
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === 'right' ? 'M6 3.5L10.5 8L6 12.5' : 'M10 3.5L5.5 8L10 12.5'} />
    </svg>
  )
}

export default ContextPanel
