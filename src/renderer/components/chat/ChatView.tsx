/**
 * The conversation column: transcript (or the workflow's zero state) above,
 * composer pinned below.
 */

import { useCallback, useMemo, useState, type JSX } from 'react'
import { useStore } from '@renderer/state/store'
import { workflowPayload } from '@renderer/lib/payload'
import { formatTokens } from '@renderer/lib/format'
import { WORKFLOW_BY_ID } from '@shared/workflows'
import { STARTER_GENERATORS } from '@shared/image-prompts'
import type { WorkflowDefinition } from '@shared/types'
import ContextBanner from './ContextBanner'
import MessageList from './MessageList'
import Composer from './Composer'
import './chat.css'

export default function ChatView() {
  const conversation = useStore((s) => s.conversation)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const mcpStates = useStore((s) => s.mcpStates)
  const residentModelId = useStore((s) => s.health.residentModelId)

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

  /** Non-null only when the first message here would evict a different model. */
  const swap = useMemo(() => {
    const want = workflow.preferredModel
    if (!want || !residentModelId || residentModelId === want) return null
    return { from: residentModelId, to: want }
  }, [workflow, residentModelId])

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
          {/* The other cost, and the expensive one. Each workflow carries a
              preferredModel and swaps to it on the first turn — which evicts
              whatever is resident and spends about twenty seconds doing it,
              because this machine holds one model at a time. That was surfaced
              nowhere in the renderer, so the first message in a workflow could
              silently unload the model you were part-way through using. */}
          {swap !== null ? (
            <p className="chat-empty-swap">
              Sending here loads <strong>{shortModel(swap.to)}</strong>, which unloads{' '}
              <strong>{shortModel(swap.from)}</strong> — about twenty seconds, and only one model
              fits at a time.
            </p>
          ) : null}
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
          {/* Keyed so it REMOUNTS, which is the whole mechanism: the hand is
              dealt in a state initialiser, so arriving at an empty state deals
              a fresh one, while typing in the composer below does not. */}
          <Starters
            key={`${workflow.id}:${conversation?.id ?? 'new'}`}
            workflow={workflow}
            onPick={applySuggestion}
          />
        </div>
      )}
      <Composer value={draft} onValueChange={setDraft} focusSignal={focusSignal} />
    </div>
  )
}

/**
 * The starter chips, as their own component so that MOUNTING is the thing that
 * deals a hand.
 *
 * It used to be a useMemo in the parent keyed on the conversation id, which
 * meant a workflow you open ten times a day showed the same three lines every
 * time — the id had not changed, so neither had the memo. Here the hand is
 * dealt once in a state initialiser and the parent keys this component on
 * workflow and conversation, so arriving at an empty state re-rolls while
 * typing in the composer below leaves it alone.
 */
function Starters({
  workflow,
  onPick
}: {
  workflow: WorkflowDefinition
  onPick: (s: string) => void
}): JSX.Element | null {
  // A generator wins where a workflow has one, because a fixed pool of seven
  // misrepresents a workflow whose range is "anything you can describe".
  const [suggestions] = useState(() => {
    const generate = STARTER_GENERATORS[workflow.id]
    return generate ? generate(3) : pickSome(workflow.suggestions, 3)
  })
  if (suggestions.length === 0) return null
  return (
    <>
      <span className="section-label chat-empty-label">Start with</span>
      <div className="chat-suggestions">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="chip chat-suggestion"
            onClick={() => onPick(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </>
  )
}

/** Fisher-Yates over a copy, take the first n. Unbiased, and never repeats an
 *  entry the way n independent picks would. */
function pickSome(pool: string[], n: number): string[] {
  const copy = pool.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

function shortModel(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.split('@')[0]
}
