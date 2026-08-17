/**
 * The conversation column: transcript (or the workflow's zero state) above,
 * composer pinned below.
 */

import { useCallback, useMemo, useState } from 'react'
import { useStore } from '@renderer/state/store'
import { workflowPayload } from '@renderer/lib/payload'
import { formatTokens } from '@renderer/lib/format'
import { WORKFLOW_BY_ID } from '@shared/workflows'
import ContextBanner from './ContextBanner'
import MessageList from './MessageList'
import Composer from './Composer'
import './chat.css'

export default function ChatView() {
  const conversation = useStore((s) => s.conversation)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const mcpStates = useStore((s) => s.mcpStates)

  const [draft, setDraft] = useState('')
  const [focusSignal, setFocusSignal] = useState(0)

  // Bootstrap hands over the real definitions; the static table covers the
  // first paint before that lands.
  const workflow = useMemo(
    () => workflows.find((w) => w.id === activeWorkflow) ?? WORKFLOW_BY_ID[activeWorkflow],
    [workflows, activeWorkflow]
  )

  const hasMessages =
    conversation !== null &&
    conversation.messages.some((m) => m.role === 'user' || m.role === 'assistant')

  // Straight from the shared payload arithmetic, so this can never disagree with
  // the sidebar or the HUD about what is loaded.
  const loaded = useMemo(() => {
    const { mcpToolCount, mcpTokens, servers } = workflowPayload(mcpStates, workflow)
    return {
      tools: mcpToolCount + workflow.nativeTools.length,
      servers: servers.filter((s) => s.tools.length > 0).length,
      tokens: mcpTokens
    }
  }, [mcpStates, workflow])

  const applySuggestion = useCallback((s: string) => {
    setDraft(s)
    setFocusSignal((n) => n + 1)
  }, [])

  return (
    <div className="chat">
      <ContextBanner />
      {hasMessages ? (
        <MessageList />
      ) : (
        <div className="chat-empty">
          <span className="chat-empty-glyph" aria-hidden="true">
            {workflow.glyph}
          </span>
          <h1 className="chat-empty-title">{workflow.label}</h1>
          {/* What to DO, not what this is. The label and the blurb are both
              already on screen in the sidebar, so repeating them here spent the
              one moment the user is deciding what to ask on telling them what
              they had just read. */}
          <p className="chat-empty-blurb">{workflow.firstMove}</p>
          {/* And what it costs. Payload control is the point of this app, so the
              moment before the first message is exactly when the standing cost
              should be visible rather than buried in the sidebar. */}
          <p className="chat-empty-cost">
            {loaded.tools === 0 ? (
              'No tools loaded — nothing but your words goes to the server.'
            ) : (
              <>
                <strong>{loaded.tools}</strong> tool{loaded.tools === 1 ? '' : 's'} ready
                {loaded.servers > 0 ? ` from ${loaded.servers} server${loaded.servers === 1 ? '' : 's'}` : ''}
                {loaded.tokens > 0 ? (
                  <>
                    , costing <strong>{formatTokens(loaded.tokens)}</strong> tokens of every message
                  </>
                ) : null}
                .
              </>
            )}
          </p>
          {workflow.suggestions.length > 0 ? (
            <>
              <span className="section-label chat-empty-label">Start with</span>
              <div className="chat-suggestions">
                {workflow.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip chat-suggestion"
                    onClick={() => applySuggestion(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}
      <Composer value={draft} onValueChange={setDraft} focusSignal={focusSignal} />
    </div>
  )
}
