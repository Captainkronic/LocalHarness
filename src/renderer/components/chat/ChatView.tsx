/**
 * The conversation column: transcript (or the workflow's zero state) above,
 * composer pinned below.
 */

import { useCallback, useMemo, useState } from 'react'
import { useStore } from '@renderer/state/store'
import { WORKFLOW_BY_ID } from '@shared/workflows'
import ContextBanner from './ContextBanner'
import MessageList from './MessageList'
import Composer from './Composer'
import './chat.css'

export default function ChatView() {
  const conversation = useStore((s) => s.conversation)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)

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
          <p className="chat-empty-blurb">{workflow.blurb}</p>
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
