/**
 * The warning that the context window is filling, and the record of what has
 * already been dropped.
 *
 * Two states, and they say different things, so they are not merged:
 *
 * - APPROACHING. Nothing has been lost yet. This is the point at which starting
 *   a fresh conversation is free, so it offers exactly that and nothing else.
 * - TRIMMED. The oldest exchanges are no longer being sent. This is not a
 *   warning, it is a fact about what the model can currently see, and it stays
 *   on screen for the rest of the conversation because it stays true.
 *
 * It exists because the alternative is invisible. The trimmer drops history to
 * keep turns working, which means the failure it prevents is silent — the model
 * simply stops knowing things it used to know, and without this the only
 * evidence is an assistant that has mysteriously become forgetful.
 */

import type { ReactElement } from 'react'

import { useStore } from '@renderer/state/store'
import { formatTokens } from '@renderer/lib/format'
import './chat.css'

export function ContextBanner(): ReactElement | null {
  const usage = useStore((s) => s.usage)
  const warnAt = useStore((s) => s.settings.contextWarnFraction)
  const conversation = useStore((s) => s.conversation)
  const newConversation = useStore((s) => s.newConversation)

  const trimmed = conversation?.trimmedMessages ?? 0
  const { fraction, used, max } = usage

  if (trimmed > 0) {
    return (
      <div className="ctx-banner is-trimmed" role="status">
        <span className="ctx-banner-mark" aria-hidden="true">
          ⤺
        </span>
        <span className="ctx-banner-text">
          <strong>
            {trimmed} earlier message{trimmed === 1 ? '' : 's'}
          </strong>{' '}
          {trimmed === 1 ? 'is' : 'are'} no longer being sent — this conversation outgrew the
          model&apos;s window. Everything is still saved here; the model just cannot see that far
          back.
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void newConversation()}>
          New chat
        </button>
      </div>
    )
  }

  // Only meaningful when the window is actually known. Warning about a fraction
  // of an unknown total would be a number invented to look useful.
  if (fraction === null || max === null || max <= 0) return null

  // Over the window but nothing dropped yet. Reachable without any trimming
  // having happened: loading a smaller model shrinks `max` under an existing
  // `used`, so the conversation stops fitting without a single message being
  // touched. Said in the present tense, because it is already true.
  if (fraction >= 1) {
    return (
      <div className="ctx-banner is-trimmed" role="status">
        <span className="ctx-banner-mark" aria-hidden="true">
          ◑
        </span>
        <span className="ctx-banner-text">
          This conversation no longer fits the model&apos;s loaded window (
          {formatTokens(used)} of {formatTokens(max)}).{' '}
          <strong>The oldest exchanges will be dropped</strong> from the next message.
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void newConversation()}>
          New chat
        </button>
      </div>
    )
  }

  if (fraction < warnAt) return null

  return (
    <div className="ctx-banner" role="status">
      <span className="ctx-banner-mark" aria-hidden="true">
        ◑
      </span>
      <span className="ctx-banner-text">
        <strong>{Math.round(fraction * 100)}% of the context window used</strong> (
        {formatTokens(used)} of {formatTokens(max)}). When it fills, the oldest exchanges stop
        being sent.
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void newConversation()}>
        New chat
      </button>
    </div>
  )
}

export default ContextBanner
