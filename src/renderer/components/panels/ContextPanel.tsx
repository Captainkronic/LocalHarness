import { useMemo, type JSX } from 'react'
import type { ArtifactKind, PanelKind } from '@shared/types'
import { useStore } from '@renderer/state/store'
import GalleryPanel from './GalleryPanel'
import AudioPanel from './AudioPanel'
import DocumentsPanel from './DocumentsPanel'
import SourcesPanel from './SourcesPanel'
import TablesPanel from './TablesPanel'
import FilesPanel from './FilesPanel'
import EditsPanel from '@renderer/components/edit/EditsPanel'
import TranscriptPanel from '@renderer/components/live/TranscriptPanel'
import './panels.css'

/**
 * The right-hand contextual panel. Which panel appears is a property of the
 * workflow, not of the conversation — switching profile switches the panel with
 * everything else the profile decides.
 */

const TITLES: Record<Exclude<PanelKind, 'none'>, string> = {
  transcript: 'Transcript',
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

  if (kind === 'none') return null

  return (
    <aside className="ctx-panel" aria-label={TITLES[kind]}>
      <header className="ctx-head">
        <span className="section-label">{TITLES[kind]}</span>
        {count !== null ? <span className="ctx-count tnum">{count}</span> : null}
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
      </div>
    </aside>
  )
}

export default ContextPanel
