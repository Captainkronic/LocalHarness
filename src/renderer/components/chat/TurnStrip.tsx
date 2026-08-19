/**
 * What is happening, right now, directly under the composer.
 *
 * This replaces `Working()`, which rendered three bouncing dots and the word
 * "Working" — and which had two faults that made a long turn unreadable. It was
 * gated on `toolCalls.length === 0`, so it VANISHED the moment the first tool
 * call arrived, taking the only liveness signal away for the twelve minutes it
 * was most needed. And it lived inside a message, so it appeared above whatever
 * the turn produced afterwards.
 *
 * Anchoring to the composer removes both problems by construction: the strip is
 * always visible, always in the same place, and its position no longer depends
 * on how a message happens to be shaped.
 *
 * ONE RULE GOVERNS EVERYTHING HERE: no throughput rate, anywhere. Every number
 * in this strip is a monotonic count or a wall clock, so there is nothing that
 * CAN linger from a dead turn. That is deliberate. A frozen "18.3 tok/s" sat in
 * the HUD for five minutes while the wire was silent and the app looked busy
 * doing nothing — the rate was real when measured and a lie by the time it was
 * read. The HUD keeps the rates, with its own grammar for held and projected
 * values; this strip keeps the strictly-now story and holds no cache at all.
 */

import { useEffect, useReducer, useRef, useState, type CSSProperties, type JSX } from 'react'

import { formatChars, formatMs, formatTokens, usageColor } from '@renderer/lib/format'
import { PHASE_TIP } from '@renderer/lib/phases'
import { useStore } from '@renderer/state/store'
import type { AppState } from '@renderer/state/store'
import './chat.css'

/** Silence from the main process before we say so. */
const STALE_PUSH_MS = 10_000
/** Silence on the wire before the sentence mentions it. */
const QUIET_WIRE_MS = 20_000
/**
 * Grace period before a turn that ran out of steps carries on by itself.
 *
 * Long enough to read the sentence and stop it, short enough that a build left
 * running does not sit waiting for someone who has walked away. Typing anything
 * cancels it, because reaching for the keyboard IS the interruption.
 */
const AUTO_CONTINUE_MS = 10_000

export interface TurnStripProps {
  /** Computed by Composer already; passed down rather than derived twice. */
  activeModel: string | null
  /**
   * The composer has text in it. Cancels the auto-continue countdown: someone
   * typing is someone taking over, and carrying on underneath them would be
   * answering a question they had not finished asking.
   */
  userTyping?: boolean
}

type Tone = 'idle' | 'live' | 'warn' | 'error'

/**
 * The open call, read as SCALARS.
 *
 * `assistant.toolCalls` is rebuilt as a fresh array on every argument delta and
 * republished at up to ~16Hz, so selecting the object would re-render this
 * component continuously — including through the silences it exists to report.
 */
function openCall(s: AppState) {
  const m = s.conversation?.messages.at(-1)
  const calls = m?.role === 'assistant' ? (m.toolCalls ?? []) : []
  return (
    calls.find((c) => c.status === 'running') ??
    [...calls].reverse().find((c) => c.status === 'pending') ??
    null
  )
}

export function TurnStrip({ activeModel, userTyping = false }: TurnStripProps): JSX.Element {
  const phase = useStore((s) => s.live.phase)
  const promptTokens = useStore((s) => s.live.promptTokens)
  const completionTok = useStore((s) => s.live.completionTokens)
  const elapsedMs = useStore((s) => s.live.elapsedMs)
  const prefillEtaMs = useStore((s) => s.live.prefillEtaMs)

  const approvalName = useStore((s) => s.approvals[0]?.toolName ?? null)
  const approvalCount = useStore((s) => s.approvals.length)

  const turnStartedAt = useStore((s) => {
    const ms = s.conversation?.messages
    for (let i = (ms?.length ?? 0) - 1; i >= 0; i--) {
      if (ms![i]!.role === 'user') return ms![i]!.createdAt
    }
    return null
  })
  const lastError = useStore((s) => {
    const m = s.conversation?.messages.at(-1)
    return m?.role === 'assistant' && m.error ? m.error : null
  })
  /* A typed marker, never a phrase match — see ChatMessage.stoppedAtCap. */
  const stoppedAtCap = useStore((s) => {
    const m = s.conversation?.messages.at(-1)
    return m?.role === 'assistant' && m.stoppedAtCap === true
  })
  const lastMessageId = useStore((s) => s.conversation?.messages.at(-1)?.id ?? null)
  const continueTurn = useStore((s) => s.continueTurn)

  const callName = useStore((s) => openCall(s)?.name ?? null)
  const callArgLen = useStore((s) => openCall(s)?.arguments.length ?? 0)
  const callOpenedAt = useStore((s) => openCall(s)?.openedAt ?? null)
  const callStartedAt = useStore((s) => openCall(s)?.startedAt ?? null)
  const callMsg = useStore((s) => openCall(s)?.progressMessage ?? null)
  const callFrac = useStore((s) => openCall(s)?.progressFraction ?? null)

  /* A 1Hz heartbeat while a turn is live.
     Without it this component only re-renders when the main process pushes, so
     a main process that STOPPED pushing would freeze the clock at a plausible
     value — indistinguishable from a healthy one. The clock has to be driven by
     something that keeps running when the data stops. */
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (phase === 'idle') return
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [phase])

  /* When we last saw movement, tracked separately for the two silences that
     mean different things: main→renderer, and model→wire. */
  const seen = useRef({ el: -1, gen: -1, elAt: 0, genAt: 0 })
  useEffect(() => {
    const now = Date.now()
    if (elapsedMs !== seen.current.el) {
      seen.current.el = elapsedMs
      seen.current.elAt = now
    }
    // Strict INCREASE. The meter resets to zero at every tool call, and reading
    // that reset as a token would falsely restart the gap at the exact moment a
    // long silence begins.
    if (completionTok > seen.current.gen) {
      seen.current.gen = completionTok
      seen.current.genAt = now
    }
  }, [elapsedMs, completionTok])
  useEffect(() => {
    if (phase === 'idle') seen.current = { el: -1, gen: -1, elAt: 0, genAt: 0 }
  }, [phase])

  const now = Date.now()
  const pushGapMs = phase === 'idle' || seen.current.elAt === 0 ? 0 : now - seen.current.elAt
  const tokenGapMs = phase === 'idle' || seen.current.genAt === 0 ? 0 : now - seen.current.genAt

  const running = phase !== 'idle'

  /*
   * Carry on by itself when a turn ran out of steps.
   *
   * Keyed on the message id so each cap gets exactly one countdown: without it
   * a re-render after the timer fired would start a second one, and two
   * continuations would race for the same turn.
   *
   * `armed` holds the id being counted down; null means nothing pending.
   */
  const [remainMs, setRemainMs] = useState<number | null>(null)
  const armed = useRef<string | null>(null)
  const cancelled = useRef<string | null>(null)

  useEffect(() => {
    if (!stoppedAtCap || running || lastMessageId === null) {
      setRemainMs(null)
      armed.current = null
      return
    }
    if (cancelled.current === lastMessageId) return
    if (armed.current === lastMessageId) return
    armed.current = lastMessageId
    const startedAt = Date.now()
    setRemainMs(AUTO_CONTINUE_MS)
    const id = setInterval(() => {
      const left = AUTO_CONTINUE_MS - (Date.now() - startedAt)
      if (left > 0) {
        setRemainMs(left)
        return
      }
      clearInterval(id)
      setRemainMs(null)
      void continueTurn()
    }, 250)
    return () => clearInterval(id)
  }, [stoppedAtCap, running, lastMessageId, continueTurn])

  /* Typing is taking over. Remember WHICH message was cancelled so the
     countdown does not simply re-arm on the next render. */
  useEffect(() => {
    if (userTyping && remainMs !== null && lastMessageId !== null) {
      cancelled.current = lastMessageId
      armed.current = null
      setRemainMs(null)
    }
  }, [userTyping, remainMs, lastMessageId])

  const stopAutoContinue = (): void => {
    cancelled.current = lastMessageId
    armed.current = null
    setRemainMs(null)
  }

  const { text, detail, tone } = describe()

  return (
    <div className="turn-strip">
      <ContextRing />
      <span className={`ts-status is-${tone}`} title={detail}>
        {text}
        {running && pushGapMs >= STALE_PUSH_MS ? (
          <span className="ts-stale" title={STALE_TIP(pushGapMs)}>
            {' · no update for '}
            {Math.round(pushGapMs / 1000)}s
          </span>
        ) : null}
      </span>
      {remainMs !== null ? (
        <button type="button" className="ts-hold" onClick={stopAutoContinue}>
          stay stopped
        </button>
      ) : running && turnStartedAt !== null ? (
        <span className="ts-clock tnum" aria-hidden="true" title={CLOCK_TIP(elapsedMs)}>
          {formatMs(now - turnStartedAt)}
        </span>
      ) : (
        <span className="ts-hint">
          <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
        </span>
      )}
      {/* Announced once per phase change rather than once per second: the
          durations are stripped so the live region does not re-fire on the tick. */}
      <span className="sr-only" role="status" aria-live="polite">
        {text}
      </span>
    </div>
  )

  function describe(): { text: string; detail: string; tone: Tone } {
    /* Approval first, and before phase: 'awaiting_approval' is never assigned
       in main, so a call waiting on the user still reads 'running'. */
    if (approvalCount > 0) {
      return {
        text:
          approvalCount === 1
            ? `Waiting for you to approve ${approvalName ?? 'a tool call'}`
            : `Waiting for you to approve ${approvalCount} tool calls`,
        detail: 'The turn is paused. Nothing is being generated until you allow or deny this.',
        tone: 'warn'
      }
    }

    if (phase === 'idle') {
      if (remainMs !== null) {
        return {
          text: `Ran out of steps — carrying on in ${Math.ceil(remainMs / 1000)}s. Type anything to stop it.`,
          detail:
            'The turn used its whole step budget without finishing. Nothing is lost: the history ' +
            'is intact and continuing simply runs the loop again against it. Typing cancels this, ' +
            'and so does the button on the right.',
          tone: 'warn'
        }
      }
      if (lastError !== null) {
        return {
          // Nothing else from the dead turn is shown. Its token counts and
          // durations describe work that was thrown away.
          text: `The last turn stopped early — ${firstLine(lastError)}`,
          detail: lastError,
          tone: 'error'
        }
      }
      if (activeModel === null) {
        return {
          text: 'No model loaded — pick one in Settings or load it on the Mac Studio.',
          detail: 'The app has no model to send to.',
          tone: 'warn'
        }
      }
      return { text: activeModel, detail: activeModel, tone: 'idle' }
    }

    if (phase === 'queued') {
      return {
        text: 'Request sent — the server has not started on it yet',
        detail: PHASE_TIP.queued,
        tone: 'live'
      }
    }

    if (phase === 'prefill') {
      if (promptTokens === 0) {
        return { text: 'Sending the prompt', detail: PHASE_TIP.prefill, tone: 'live' }
      }
      const head = `Reading ${formatTokens(promptTokens)} tokens of context`
      if (typeof prefillEtaMs === 'number' && prefillEtaMs > 1500) {
        return {
          text: `${head} — ≈${formatMs(prefillEtaMs)} left, estimated`,
          detail:
            'The model is re-reading the whole conversation before it writes anything. No tokens are produced during this phase and the streaming protocol reports no progress through it, so the time left is a projection from the prefill rate this model reached on earlier turns — it is not measured. That is what ≈ means.',
          tone: 'live'
        }
      }
      return {
        // No em dash for the ETA: in this app an em dash means "a number exists
        // and we do not know it". Here no number exists at all.
        text: `${head} — no estimate yet`,
        detail:
          'The model is re-reading the whole conversation before it writes anything. There is no time estimate yet — this model has not completed enough turns for a rate to be learned, and the app will not guess one.',
        tone: 'live'
      }
    }

    if (phase === 'decode') {
      if (callName !== null || callArgLen > 0) {
        const what = callName ? `the ${callName} call` : 'a tool call'
        if (callArgLen > 0) {
          return {
            text: `Writing ${what} — ${formatChars(callArgLen)} of arguments`,
            detail: COMPOSING_TIP(callName),
            tone: 'live'
          }
        }
        const composing =
          callOpenedAt !== null ? ` for ${formatMs(now - callOpenedAt)}` : ''
        if (tokenGapMs >= QUIET_WIRE_MS) {
          return {
            text: `Writing ${what} — nothing on the wire${composing}`,
            detail: COMPOSING_TIP(callName),
            tone: 'live'
          }
        }
        return {
          text: `Writing ${what} — nothing on the wire yet`,
          detail: COMPOSING_TIP(callName),
          tone: 'live'
        }
      }
      return {
        // "this step", never "this turn": the meter resets at every tool call,
        // and an agentic turn is several requests back to back.
        text: `Writing the reply — ${formatTokens(completionTok)} tokens this step`,
        detail:
          'Tokens generated since the last tool call. An agentic turn is several requests back to back, so this count restarts at each one and is not a total for the whole turn.',
        tone: 'live'
      }
    }

    // phase === 'tool'
    const toolFor = callStartedAt !== null ? ` (${formatMs(now - callStartedAt)})` : ''
    if (callName === null) {
      return { text: 'Running a tool', detail: PHASE_TIP.tool, tone: 'live' }
    }
    if (callMsg !== null && typeof callFrac === 'number') {
      return {
        // The server's own phrase, quoted verbatim rather than reworded.
        text: `${callName} — ${callMsg} (${Math.round(callFrac * 100)}%)${toolFor}`,
        detail: PHASE_TIP.tool,
        tone: 'live'
      }
    }
    if (callMsg !== null) {
      return { text: `${callName} — ${callMsg}${toolFor}`, detail: PHASE_TIP.tool, tone: 'live' }
    }
    return { text: `Running ${callName}${toolFor}`, detail: PHASE_TIP.tool, tone: 'live' }
  }
}

function COMPOSING_TIP(name: string | null): string {
  return (
    `The model is composing the arguments for ${name ?? 'this call'}. This server sends a tool ` +
    `call's arguments in one piece rather than streaming them, so there is nothing to show until ` +
    `the whole call lands — on a file-sized argument that is minutes. Nothing here is a health ` +
    `check: if the clock on the right is still moving, the app is still receiving from the model.`
  )
}

function STALE_TIP(ms: number): string {
  return (
    `The main process has not sent a telemetry update in ${Math.round(ms / 1000)} seconds. It ` +
    `normally sends one every 250ms. This states what was observed, not a conclusion — main may ` +
    `simply be blocked writing to disk.`
  )
}

function CLOCK_TIP(stepMs: number): string {
  return (
    `Time since you sent this message. The HUD's elapsed restarts at every request in an agentic ` +
    `turn; this one does not. This step: ${formatMs(stepMs)}.`
  )
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]!.trim()
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * Context window fullness, as a 16px ring.
 *
 * Does no arithmetic: `usage.fraction` is computed in main from the same numbers
 * the HUD's meter reads, so the two cannot disagree. When the window size is
 * unknown the ring is drawn as a dashed track with no arc — never a guess, and
 * never zero, which would read as "empty".
 */
function ContextRing(): JSX.Element {
  const used = useStore((s) => s.usage.used)
  const max = useStore((s) => s.usage.max)
  const fraction = useStore((s) => s.usage.fraction)
  const warnAt = useStore((s) => s.settings.contextWarnFraction)

  const maxTokens = max !== null && max > 0 ? max : null
  const known = maxTokens !== null
  const pct = fraction === null ? 0 : Math.min(1, fraction) * 100
  /* r=7 in a 16-box with stroke 2: circumference 43.98. */
  const CIRC = 2 * Math.PI * 7

  const tip = known
    ? `${used.toLocaleString()} of ${maxTokens.toLocaleString()} tokens of context used. ` +
      `Trimming begins a little before this reads full — the reply budget and tool schemas are ` +
      `reserved out of the same window, so the ring under-warns rather than over-warns.`
    : 'The loaded context window is not known, so there is nothing to measure against. ' +
      'It becomes known once a model is resident.'

  return (
    <svg
      className="ts-ring"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      role="progressbar"
      aria-label="Context window used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known && fraction !== null ? Math.round(pct) : undefined}
      aria-valuetext={known ? `${used} of ${maxTokens} tokens` : 'window size unknown'}
      style={{ '--meter': usageColor(fraction, warnAt) } as CSSProperties}
    >
      {/* SVG has no title ATTRIBUTE — a <title> child is how it gets a tooltip. */}
      <title>{tip}</title>
      {/* Track first — painting it after would cover the reading. */}
      <circle className={known ? 'ts-track' : 'ts-track is-unknown'} cx="8" cy="8" r="7" />
      {known && fraction !== null ? (
        <circle
          className="ts-arc"
          cx="8"
          cy="8"
          r="7"
          strokeDasharray={`${(pct / 100) * CIRC} ${CIRC}`}
        />
      ) : null}
    </svg>
  )
}

export default TurnStrip
