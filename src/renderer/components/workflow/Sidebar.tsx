import { useCallback, useMemo, useState, type JSX } from 'react'
import type { WorkflowId } from '@shared/types'
import { workflowPayload } from '@renderer/lib/payload'
import { useStore } from '@renderer/state/store'
import { relativeTime } from '@renderer/lib/format'
import McpPanel from './McpPanel'
import ReasoningPicker from './ReasoningPicker'
import SamplingPanel from './SamplingPanel'
import SkillsPanel from './SkillsPanel'
import './workflow.css'

/**
 * The left column: what this workflow is, what it will load, and everything
 * you have talked to it about.
 */

function PlusIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.4M9.2 7v3.4" />
    </svg>
  )
}

export function Sidebar(): JSX.Element {
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const mcpStates = useStore((s) => s.mcpStates)
  const selectConversation = useStore((s) => s.selectConversation)
  const newConversation = useStore((s) => s.newConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)

  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const definition = useMemo(
    () => workflows.find((w) => w.id === activeWorkflow) ?? null,
    [workflows, activeWorkflow]
  )

  const glyphById = useMemo(() => {
    const map = new Map<WorkflowId, string>()
    for (const w of workflows) map.set(w.id, w.glyph)
    return map
  }, [workflows])

  /** What this profile actually puts on the wire: native tools it declares plus
   *  the enabled tools it is ALLOWED on each server that finished its
   *  handshake. A workflow may be given only part of a server, so counting the
   *  server whole overstates it — Live is handed 2 of gmail's 19. */
  const toolCount = useMemo(() => {
    const native = definition?.nativeTools.length ?? 0
    const { mcpToolCount, pending } = workflowPayload(mcpStates, definition ?? undefined)
    return { native, mcp: mcpToolCount, pending, total: native + mcpToolCount }
  }, [definition, mcpStates])

  // Scoped to the active workflow. A conversation belongs to where it was
  // started: an image-generation thread listed under Code is noise, and its
  // prompts do not transfer to what that workflow is for.
  const ordered = useMemo(
    () =>
      conversations
        .filter((c) => c.workflowId === activeWorkflow)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, activeWorkflow]
  )

  // Through the store, not a raw invoke: the store re-reads the list and moves
  // off a deleted active conversation, and its `call` helper turns a rejection
  // into a log entry instead of an unhandled rejection inside React.
  const remove = useCallback(
    async (id: string): Promise<void> => {
      setPendingDelete(id)
      try {
        await deleteConversation(id)
      } finally {
        setPendingDelete(null)
      }
    },
    [deleteConversation]
  )

  return (
    <aside className="sidebar">
      <section className="sb-section wf-card">
        {definition ? (
          <>
            <div className="wf-card-head">
              <span className="wf-card-glyph" aria-hidden="true">
                {definition.glyph}
              </span>
              <span className="wf-card-label">{definition.label}</span>
            </div>
            <p className="wf-blurb">{definition.blurb}</p>
            <div className="wf-tools">
              <span className="chip tnum" title="Tools this profile puts in every request">
                {toolCount.total} tools
              </span>
              <span className="wf-tools-split tnum">
                {toolCount.native} native · {toolCount.mcp} MCP
                {toolCount.pending > 0 ? ` · ${toolCount.pending} starting` : ''}
              </span>
            </div>
          </>
        ) : (
          <p className="wf-blurb">Loading profile…</p>
        )}
      </section>

      <section className="sb-section">
        <McpPanel />
      </section>

      {/* Beside the MCP servers on purpose: both are capability the model can
          reach for, and the cost difference is only legible side by side. */}
      <section className="sb-section">
        <ReasoningPicker />
        <SamplingPanel />
        <SkillsPanel />
      </section>

      <section className="sb-section sb-convs">
        <div className="sb-convs-head">
          <span className="section-label">Conversations</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost sb-new"
            title="Start a new conversation in this workflow"
            onClick={() => void newConversation()}
          >
            <PlusIcon />
            New
          </button>
        </div>

        {ordered.length === 0 ? (
          <p className="sb-empty">
            No {definition ? definition.label : 'workflow'} conversations yet. Each
            workflow keeps its own; anything you send here is saved and titled from
            your first message.
          </p>
        ) : (
          <div className="sb-conv-list scroll-y">
            {ordered.map((c) => {
              const isActive = c.id === activeConversationId
              return (
                <div
                  key={c.id}
                  className={isActive ? 'sb-conv is-active' : 'sb-conv'}
                  data-deleting={pendingDelete === c.id ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="sb-conv-main"
                    onClick={() => {
                      if (!isActive) void selectConversation(c.id)
                    }}
                    title={c.title}
                  >
                    <span className="sb-conv-glyph" aria-hidden="true">
                      {glyphById.get(c.workflowId) ?? '·'}
                    </span>
                    <span className="sb-conv-text">
                      <span className="sb-conv-title">{c.title}</span>
                      <span className="sb-conv-sub tnum">
                        {relativeTime(c.updatedAt)} · {c.messageCount} msg
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost btn-danger sb-conv-del"
                    aria-label={`Delete ${c.title}`}
                    title="Delete conversation"
                    disabled={pendingDelete === c.id}
                    onClick={() => void remove(c.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </aside>
  )
}

export default Sidebar
