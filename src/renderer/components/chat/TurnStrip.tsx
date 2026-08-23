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
  /*
   * Scan back to the most recent ASSISTANT message rather than reading the last
   * message.
   *
   * Every finished call pushes a `role: 'tool'` result, so from call #2 of a
   * batch onward the last message was a tool result, this returned null, and
   * the strip fell to the anonymous "Running a tool" — no name, no progress, and
   * (because that branch returns before the clock is built) no elapsed either.
   * A 59-second command in position 2 was indistinguishable from a hang, while
   * the identical command in position 1 ticked correctly.
   */
  const msgs = s.conversation?.messages ?? []
  let m: (typeof msgs)[number] | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    const candidate = msgs[i]
    if (candidate?.role === 'assistant') {
      m = candidate
      break
    }
    // Only tool results sit between an assistant message and its running calls.
    if (candidate?.role !== 'tool') break
  }
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
  const reasoningTok = useStore((s) => s.live.reasoningTokens)
  const elapsedMs = useStore((s) => s.live.elapsedMs)
  const prefillEtaMs = useStore((s) => s.live.prefillEtaMs)
  const prefillTps = useStore((s) => s.live.prefillTps)
  const prefillEstimated = useStore((s) => s.live.prefillEstimated)
  /* One field, computed once in the meter, so this line and the header gauge
     cannot drift apart the way they did. */
  const sustainedTps = useStore((s) => s.live.decodeTpsSustained)

  /*
   * How long this conversation's finished steps have taken.
   *
   * A duration on its own is not information. "Composing — 1m 21s" could be
   * healthy or wedged and the reader has no way to tell; the same number beside
   * "earlier steps took 45s–3m10s" answers the only question they actually have.
   * Taken from this conversation rather than a global average because step
   * length depends on the model, the backend and the size of what is being
   * written, and all three change.
   */
  const stepRange = useStore((s) => {
    const ms = s.conversation?.messages ?? []
    const spans: number[] = []
    for (let i = ms.length - 1; i >= 0 && spans.length < 6; i--) {
      const m = ms[i]
      if (m?.role !== 'assistant') continue
      const t = m.metrics?.totalMs
      if (typeof t === 'number' && t > 0) spans.push(t)
    }
    if (spans.length < 2) return null
    return { lo: Math.min(...spans), hi: Math.max(...spans) }
  })

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
    /*
     * ANY change, not a strict increase.
     *
     * This required the count to grow, to stop the per-request reset to zero
     * being read as a token. It does stop that — and it also means that once
     * the meter resets, the count can never exceed the high-water mark from the
     * previous request, so `genAt` is never stamped again and the gap grows
     * without bound. The detector went permanently quiet after the first
     * request of every turn, which is the opposite of the failure it guards.
     *
     * A reset IS movement: it means a new request just started. Both readings
     * are handled by treating any change as life.
     */
    if (completionTok !== seen.current.gen) {
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
  /* The details panel under the ring. Closed by default: this strip's job is
     one sentence, and everything below is for when that sentence is not enough. */
  const [statsOpen, setStatsOpen] = useState(false)

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
      <button
        type="button"
        className={`ts-ringbtn${statsOpen ? ' is-open' : ''}`}
        aria-expanded={statsOpen}
        aria-label={statsOpen ? 'Hide session details' : 'Show session details'}
        onClick={() => setStatsOpen((v) => !v)}
      >
        <ContextRing />
      </button>
      {statsOpen ? <SessionStats onClose={() => setStatsOpen(false)} /> : null}
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
      const head =
        `Reading ${formatTokens(promptTokens)} tokens of context` +
        (prefillTps !== null && prefillTps > 0
          ? ` at ${prefillEstimated ? '≈' : ''}${Math.round(prefillTps)} tok/s`
          : '')
      if (typeof prefillEtaMs === 'number' && prefillEtaMs > 1500) {
        return {
          text: `${head} — ≈${formatMs(prefillEtaMs)} left, estimated`,
          detail:
            'The model is re-reading the whole conversation before it writes anything. No tokens are produced during this phase and the streaming protocol reports no progress through it, so the time left is a projection from the prefill rate this model reached on earlier turns — it is not measured. That is what ≈ means.\n\n' +
            turnSteps('prefill'),
          tone: 'live'
        }
      }
      /*
       * Three cases, not two. This branch used to catch both "no rate has ever
       * been learned" and "the projection has run out", and told the user the
       * former in both — while the same line quoted a tok/s rate two words
       * earlier. It claimed to have no estimate and showed one in the same
       * sentence, during exactly the stretch where a person is trying to work
       * out whether anything is wrong.
       */
      if (prefillEtaMs !== null) {
        return {
          text: `${head} — any moment now`,
          detail:
            'The projected prefill time has elapsed. That projection comes from the rate this model reached on earlier turns, so a longer prompt, a colder cache or a busier machine all overrun it. Nothing is wrong yet; the streaming protocol reports no progress through prefill, so there is nothing more precise to show until the first token lands.',
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
        /*
         * "composing", not "nothing on the wire".
         *
         * Both sentences describe the same healthy state — this server sends a
         * tool call's arguments in one piece, so a file-sized argument really
         * does put nothing on the wire for minutes. But one of them names what
         * IS happening and the other names an absence, and an absence reads as
         * a fault. Watching a run at 4am, "nothing on the wire for 3m 7s" is
         * indistinguishable from a hang, and the honest reading — that the
         * model is working hard and there is simply nothing to show yet —
         * arrives only if you hover the tooltip.
         *
         * A genuine stall is caught elsewhere and properly: the first-token
         * watchdog in llm/client.ts fails a request that never starts, and
         * silence AFTER the reply has started is legitimate for as long as the
         * body timeout allows. So this line has no fault to report, and should
         * not imply one.
         */
        if (tokenGapMs >= QUIET_WIRE_MS) {
          return {
            text: `Writing ${what} — composing${composing}`,
            detail: COMPOSING_TIP(callName),
            tone: 'live'
          }
        }
        return {
          text: `Writing ${what} — composing`,
          detail: COMPOSING_TIP(callName),
          tone: 'live'
        }
      }
      /*
       * Reasoning deltas are generated tokens, so the phase flips to 'decode' on
       * the first one and everything below used to read "Writing the reply".
       * On the run this was found, 51.0k of 68.6k generated tokens were
       * reasoning: three quarters of all generation time announced as work that
       * had not started, while the reply was still empty.
       */
      /*
       * A long silence with no tool call visible.
       *
       * Not every backend streams tool-call arguments. LM Studio sends them as
       * deltas, so the app can say "Writing the write_file call — 4.1 kB of
       * arguments". oMLX parses tool calls out of the finished text instead, so
       * while the model composes a stylesheet nothing arrives at all: measured
       * here at seven minutes of frozen counter under the words "Writing the
       * reply", which reads as a hang.
       *
       * The gap was already tracked and was only ever consulted inside the
       * tool-call branch — the one path this backend never takes.
       */
      if (tokenGapMs >= QUIET_WIRE_MS) {
        /*
         * Adam, watching this line: "it feels stuck when it says nothing on the
         * wire... not sure exactly what that means."
         *
         * It said `nothing on the wire for 1m 21s`, which describes the plumbing
         * rather than the work, and names an ABSENCE — and an absence reads as a
         * fault however carefully the tooltip explains otherwise. The server was
         * generating at 18.3 tok/s throughout.
         *
         * So: say what is happening, and give the duration something to be
         * measured against. A bare "1m 21s" is not information; beside "earlier
         * steps took 45s–3m10s" it answers the only question being asked.
         */
        const yard =
          stepRange === null
            ? ' · this server sends a tool call only once it is finished, so there is nothing to show yet'
            : ` · earlier steps took ${formatMs(stepRange.lo)}–${formatMs(stepRange.hi)}`
        return {
          text: `Composing — ${formatMs(tokenGapMs)} so far${yard}`,
          detail:
            'The model is generating, and the request is still open — this is silence, not an error. ' +
            'Some backends stream a tool call as it is written and some send it only when it is complete; ' +
            'on the latter, writing a large file looks exactly like this and the whole file arrives at once. ' +
            'The comparison is to finished steps in this conversation, which is the closest thing to an ' +
            'expectation the app can honestly offer. Stop is always available.\n\n' + turnSteps('compose'),
          tone: 'live'
        }
      }
      if (reasoningTok > 0 && completionTok <= reasoningTok) {
        return {
          text: `Thinking — ${formatTokens(reasoningTok)} tokens so far${rate(sustainedTps)}`,
          detail:
            'The model is reasoning, not writing. Reasoning is generated at the same cost as the reply and counts toward the same budget, but none of it is the answer — and none of it is replayed to the model on the next request.\n\n' +
            turnSteps('think'),
          tone: 'live'
        }
      }
      return {
        // "this step", never "this turn": the meter resets at every tool call,
        // and an agentic turn is several requests back to back.
        text:
          `Writing the reply — ${formatTokens(Math.max(0, completionTok - reasoningTok))} ` +
          `tokens this step${rate(sustainedTps)}`,
        detail:
          'Tokens of REPLY generated since the last tool call, with reasoning excluded. An agentic turn is several requests back to back, so this count restarts at each one and is not a total for the whole turn.',
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

/**
 * " · 18.4 tok/s", or nothing at all.
 *
 * Nothing until a rate exists, rather than a placeholder: a rate of zero and a
 * rate not yet known look identical once rendered, and one of them is alarming.
 */
function rate(tps: number | null): string {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return ''
  return ` · ${tps >= 10 ? tps.toFixed(1) : tps.toFixed(2)} tok/s`
}

/**
 * The shape of a turn, appended to every live-phase tooltip.
 *
 * Adam, on the status line: "can you add a tooltip to this section with more
 * detailed descriptions of each step happening". The individual states were each
 * explained, but nothing said what the SEQUENCE was, so a reader could know what
 * "composing" meant and still not know whether it came before or after the tool
 * ran, or how many more of these a turn contains.
 *
 * The arrow marks where you are, so the same text answers both "what is this"
 * and "how far along is it".
 */
function turnSteps(at: 'prefill' | 'think' | 'compose' | 'tool'): string {
  const rows: Array<[typeof at, string]> = [
    ['prefill', 'Reading — the model re-reads the whole conversation before it can write anything. No tokens are produced; this is the slowest part of a deep turn.'],
    ['think', 'Thinking — reasoning tokens. Billed from the same budget as the answer, and not replayed to the model on the next step.'],
    ['compose', 'Composing — writing a reply or a tool call. A file-sized tool call can take minutes and some backends send it only when finished.'],
    ['tool', 'Running — the tool executes: a file is written, a command runs, a page is read. Then the loop repeats until the model stops asking for tools.']
  ]
  return (
    'A step of a turn runs in this order, and a turn is many steps:\n\n' +
    rows.map(([k, text]) => `${k === at ? '▸ ' : '  '}${text}`).join('\n')
  )
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

/* ------------------------------------------------------------------ */
/* Session details                                                     */
/* ------------------------------------------------------------------ */

/** One label/value row. `hint` becomes the row's tooltip. */
function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: string
  hint?: string
  tone?: 'warn' | 'bad'
}): JSX.Element {
  return (
    <div className="ss-row" title={hint}>
      <span className="ss-label">{label}</span>
      <span className={`ss-value tnum${tone ? ` is-${tone}` : ''}`}>{value}</span>
    </div>
  )
}

/**
 * What the one-line strip cannot say.
 *
 * The strip is deliberately a single sentence about right now, and everything
 * it leaves out was previously unreachable without opening devtools: how full
 * the window is and WHAT is filling it, whether history has been dropped, what
 * this request actually cost, and what the conversation has spent in total.
 *
 * Two rules carried over from the strip. Nothing here is a throughput rate the
 * component computed itself — the rates come from the same live metrics the HUD
 * reads, and are shown only while a request is in flight, so a dead number
 * cannot linger. And an unknown is rendered "—", never zero and never a guess:
 * a window whose size is not yet known must not read as an empty one.
 */
function SessionStats({ onClose }: { onClose: () => void }): JSX.Element {
  const usage = useStore((s) => s.usage)
  const warnAt = useStore((s) => s.settings.contextWarnFraction)
  const slots = useStore((s) => s.settings.contextSlots)
  const live = useStore((s) => s.live)
  const health = useStore((s) => s.health)
  const trimmed = useStore((s) => s.conversation?.trimmedMessages ?? 0)
  const messages = useStore((s) => s.conversation?.messages ?? [])

  /* Whole-conversation totals, walked once. Cheap next to a render that only
     happens while the panel is open. */
  let toolCalls = 0
  let outTokens = 0
  let reasoningTokens = 0
  let requests = 0
  let slowestMs = 0
  for (const m of messages) {
    toolCalls += m.toolCalls?.length ?? 0
    const mt = m.metrics
    if (!mt) continue
    requests += 1
    outTokens += mt.completionTokens
    reasoningTokens += mt.reasoningTokens ?? 0
    if (mt.totalMs > slowestMs) slowestMs = mt.totalMs
  }

  const max = usage.max !== null && usage.max > 0 ? usage.max : null
  const headroom = max === null ? null : Math.max(0, max - usage.used)
  const pct = usage.fraction === null ? null : Math.round(usage.fraction * 100)
  const overWarn = usage.fraction !== null && usage.fraction >= warnAt
  const running = live.phase !== 'idle'

  return (
    <div className="ss-panel" role="dialog" aria-label="Session details">
      <div className="ss-head">
        <span>Session</span>
        <button type="button" className="ss-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="ss-group">Context window</div>
      <Stat
        label="Used"
        value={max === null ? `${formatTokens(usage.used)} / —` : `${formatTokens(usage.used)} / ${formatTokens(max)}`}
        tone={overWarn ? 'warn' : undefined}
        hint={
          max === null
            ? 'The loaded window is not known yet. It becomes known once a model is resident.'
            : 'Everything that would be sent on the next request: system prompt, tool schemas, and the messages that survive trimming.'
        }
      />
      <Stat
        label="Full"
        value={pct === null ? '—' : `${pct}%`}
        tone={overWarn ? 'warn' : undefined}
        hint={`Trimming starts before this reads full — the reply budget and tool schemas are reserved out of the same window. Your warning threshold is ${Math.round(warnAt * 100)}%.`}
      />
      <Stat
        label="Headroom"
        value={headroom === null ? '—' : formatTokens(headroom)}
        hint="Tokens left before the window is full. History is trimmed well before this reaches zero."
      />
      {slots > 1 ? (
        <Stat
          label="Server slots"
          value={`${slots}`}
          tone="warn"
          hint="llama.cpp divides its context across parallel slots, so one request gets the loaded length divided by this. The figures above already account for it."
        />
      ) : null}
      <Stat
        label="Dropped"
        value={trimmed === 0 ? 'none' : `${trimmed} message${trimmed === 1 ? '' : 's'}`}
        tone={trimmed > 0 ? 'warn' : undefined}
        hint="Earlier messages removed from the prompt to fit the window. The model is told this has happened; the messages are still in the transcript."
      />

      <div className="ss-group">What is filling it</div>
      <Stat label="Messages" value={formatTokens(usage.breakdown.messages)} hint="The conversation itself." />
      <Stat
        label="Tool schemas"
        value={formatTokens(usage.breakdown.tools)}
        hint="Sent on every single request. Turning off an MCP server you are not using is the fastest way to shrink this."
      />
      <Stat label="System prompt" value={formatTokens(usage.breakdown.system)} hint="The workflow's instructions, plus the date and your workspace root." />
      {usage.breakdown.attachments > 0 ? (
        <Stat label="Attachments" value={formatTokens(usage.breakdown.attachments)} hint="Images and files carried in the conversation." />
      ) : null}

      {running ? (
        <>
          <div className="ss-group">This request</div>
          <Stat label="Phase" value={live.phase} hint={PHASE_TIP[live.phase] ?? ''} />
          <Stat label="Prompt sent" value={formatTokens(live.promptTokens)} hint="Our own count of what went out, known before the reply starts." />
          <Stat label="Generated" value={formatTokens(live.completionTokens)} hint="Tokens produced since the last tool call. An agentic turn is several requests back to back, so this restarts at each one." />
          <Stat label="Time to first token" value={live.ttftMs === null ? '—' : formatMs(live.ttftMs)} hint="How long prefill took. Null until the first token lands." />
          <Stat
            label="Prefill"
            value={live.prefillTps === null ? '—' : `${Math.round(live.prefillTps)} tok/s${live.prefillEstimated ? ' est.' : ''}`}
            hint="Reading the prompt. Marked est. while it is a projection from earlier turns rather than a measurement of this one."
          />
          <Stat label="Decode" value={live.decodeTps === null ? '—' : `${live.decodeTps.toFixed(1)} tok/s`} hint="Writing the reply, over a rolling window." />
        </>
      ) : null}

      <div className="ss-group">This conversation</div>
      <Stat label="Requests" value={`${requests}`} hint="Model calls made across every turn here. One turn is usually many." />
      <Stat label="Tool calls" value={`${toolCalls}`} />
      <Stat label="Tokens generated" value={formatTokens(outTokens)} hint="Everything the model has written here, replies and tool arguments together." />
      <Stat
        label="…thinking"
        value={reasoningTokens === 0 ? 'none' : formatTokens(reasoningTokens)}
        hint="Of those, the ones spent reasoning. Billed against the same budget as the answer."
      />
      <Stat label="Slowest request" value={slowestMs === 0 ? '—' : formatMs(slowestMs)} />

      <div className="ss-group">Server</div>
      <Stat label="Model" value={live.modelId ?? health.residentModelId ?? '—'} />
      <Stat
        label="Endpoint"
        /* host:port only. The scheme and the /v1 path are the same on every
           endpoint this app talks to, and spending two wrapped lines on them
           pushed the part that actually differs out of sight. */
        value={health.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}
        tone={health.reachable ? undefined : 'bad'}
        hint={`${health.endpoint} — ${health.reachable ? 'reachable' : 'NOT reachable; the last check failed'}.`}
      />
      <Stat label="Latency" value={health.latencyMs === null ? '—' : `${health.latencyMs} ms`} />
    </div>
  )
}
