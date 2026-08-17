/**
 * One conversation turn. Role differentiation is the whole point here: a user
 * message is a compact bubble, an assistant message is full-width prose with
 * its tool calls, reasoning and telemetry attached.
 */

import { useEffect, useRef, useState } from 'react'
import type { Attachment, ChatMessage } from '@shared/types'
import { WORKFLOW_BY_ID } from '@shared/workflows'
import { basename, formatMs, formatTokens, formatTps } from '@renderer/lib/format'
import { useStore } from '@renderer/state/store'
import Markdown from './Markdown'
import ToolCallCard from './ToolCallCard'
import './chat.css'

export interface MessageProps {
  message: ChatMessage
  /** Tool results recorded as separate role:'tool' messages, keyed by call id. */
  toolResults?: ReadonlyMap<string, string>
}

/**
 * What the app is doing before a single token has arrived.
 *
 * Prefill is the longest phase of an agentic turn on this hardware — twenty to
 * twenty-five seconds between tool calls while the model re-reads the whole
 * conversation — and it used to show a blinking cursor, which is
 * indistinguishable from a hang. The numbers were all already being measured.
 *
 * The estimate is labelled as one. It comes from a fitted rate, so it is
 * genuinely a projection, and this app does not print projections bare.
 */
function Working() {
  const phase = useStore((st) => st.live.phase)
  const promptTokens = useStore((st) => st.live.promptTokens)
  const etaMs = useStore((st) => st.live.prefillEtaMs)

  // 'queued' is the window between the request going out and the first
  // token landing — i.e. prefill, which is the silence being fixed.
  const reading = phase === 'queued'
  return (
    <span className="working" role="status">
      <span className="working-dot" aria-hidden="true" />
      <span className="working-dot" aria-hidden="true" />
      <span className="working-dot" aria-hidden="true" />
      <span className="working-text">
        {reading && promptTokens > 0
          ? `Reading ${formatTokens(promptTokens)} tokens of context`
          : 'Working'}
        {reading && typeof etaMs === 'number' && etaMs > 1500
          ? ` — about ${formatMs(etaMs)} left, estimated`
          : ''}
      </span>
    </span>
  )
}

export default function Message({ message, toolResults }: MessageProps) {
  // System prompts are not part of the conversation the user reads, and tool
  // results are rendered inside the call they belong to.
  if (message.role === 'system' || message.role === 'tool') return null
  if (message.role === 'user') return <UserMessage message={message} />
  return <AssistantMessage message={message} toolResults={toolResults} />
}

function UserMessage({ message }: { message: ChatMessage }) {
  const attachments = message.attachments ?? []
  return (
    <div className="msg msg-user">
      {attachments.length > 0 ? (
        <div className="msg-atts">
          {attachments.map((a) => (
            <AttachmentPreview key={a.id} attachment={a} />
          ))}
        </div>
      ) : null}
      {message.content !== '' ? <div className="msg-bubble">{message.content}</div> : null}
    </div>
  )
}

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === 'image' && attachment.dataUrl !== undefined) {
    return (
      <img
        className="msg-att-thumb"
        src={attachment.dataUrl}
        alt={attachment.name}
        title={attachment.name}
      />
    )
  }
  return (
    <span className="chip" title={attachment.path}>
      <span className="att-name">{attachment.name}</span>
      <span className="att-tokens tnum">{formatTokens(attachment.tokens)}</span>
    </span>
  )
}

function AssistantMessage({
  message,
  toolResults
}: {
  message: ChatMessage
  toolResults?: ReadonlyMap<string, string>
}) {
  const activeWorkflow = useStore((st) => st.activeWorkflow)
  const toolCalls = message.toolCalls ?? []
  const hasBody = message.content !== ''

  return (
    <div className="msg msg-assistant">
      {message.reasoning !== undefined && message.reasoning !== '' ? (
        <Reasoning
          text={message.reasoning}
          tokens={message.metrics?.reasoningTokens}
          budget={WORKFLOW_BY_ID[activeWorkflow]?.sampling.maxTokens}
          answered={message.content.trim() !== ''}
        />
      ) : null}

      {hasBody ? (
        <div>
          <Markdown text={message.content} />
          {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      ) : message.streaming && toolCalls.length === 0 ? (
        // A bare blinking caret for the twenty-plus seconds of prefill is the
        // longest silence in the app and says nothing at all. Everything here
        // is already measured — the phase, how much is being read, and the
        // estimate — it just was never asked for.
        <Working />
      ) : null}

      {toolCalls.length > 0 ? (
        <div>
          {toolCalls.map((c) => (
            <ToolCallCard key={c.id} call={c} fallbackResult={toolResults?.get(c.id)} />
          ))}
        </div>
      ) : null}

      {message.error !== undefined && message.error !== '' ? (
        <div className="msg-error">{message.error}</div>
      ) : null}

      {message.metrics ? <Metrics metrics={message.metrics} /> : null}
    </div>
  )
}

/** Reasoning is a separate channel and stays collapsed — it is never mixed
 *  into the answer. */
/**
 * `tokens` is the measured count from the turn's metrics; it is absent while the
 * turn is still streaming.
 *
 * This header used to print `ceil(chars / 4)` labelled "tok", while the metrics
 * footer of the SAME message printed the real per-delta count under the same
 * word. Two numbers for one quantity, neither marked, on one screen — exactly
 * what this app's metrics are supposed never to do. It now shows the measured
 * figure once there is one, and marks the interim estimate with `~`, the way
 * PrefillBar already marks its own.
 */
/**
 * Past this share of the output ceiling with nothing written yet, the turn is
 * very likely to end in `length` having produced no answer at all. Measured the
 * hard way: a Code turn spent all 16,384 of its tokens reasoning and returned
 * nothing after twenty minutes.
 */
const REASONING_ALARM = 0.6

function Reasoning({
  text,
  tokens,
  budget,
  answered
}: {
  text: string
  tokens?: number
  /** The workflow's maxTokens — reasoning is billed against the same ceiling. */
  budget?: number
  /** True once any answer text has arrived. */
  answered: boolean
}) {
  // Open while it is still thinking. Minutes of reasoning behind a collapsed
  // header is the app hiding the only thing happening; once the answer lands
  // the header's count is enough and it folds itself away. A manual toggle
  // always wins from then on — `touched` records that the user has an opinion.
  const [touched, setTouched] = useState(false)
  const [open, setOpen] = useState(false)
  const lines = text.split('\n').length
  const measured = typeof tokens === 'number' && tokens > 0
  const used = measured ? tokens : Math.ceil(text.length / 4)
  // Only a warning while it is still true: once an answer has arrived the
  // budget was evidently sufficient, whatever it cost to get there.
  const runaway =
    !answered && typeof budget === 'number' && budget > 0 && used / budget >= REASONING_ALARM
  const share = typeof budget === 'number' && budget > 0 ? used / budget : null

  // "Still growing" is the only honest definition of live here: the renderer
  // sees reasoning as an ever-lengthening string, so a change since the last
  // tick means tokens are genuinely arriving. No answer yet AND no growth for
  // a few seconds means something else is happening — a tool, or a stall — and
  // the timer should not keep implying progress.
  const [startedAt] = useState(() => Date.now())
  const [tick, setTick] = useState(0)
  const lastLen = useRef({ len: text.length, at: Date.now() })
  if (text.length !== lastLen.current.len) lastLen.current = { len: text.length, at: Date.now() }
  const live = !answered && Date.now() - lastLen.current.at < 4000

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live, tick])

  const shown = touched ? open : live

  /* Follow the tail, the way the transcript follows streamed content — but only
     while the user is already at the bottom. Yanking the view back mid-scroll
     when they have deliberately gone up to read something is worse than not
     following at all. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !shown || !live) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [text, shown, live])
  return (
    <div className={runaway ? 'reasoning is-runaway' : 'reasoning'}>
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => {
          setTouched(true)
          setOpen((v) => !v)
        }}
        aria-expanded={shown}
      >
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
          style={{ transform: shown ? 'rotate(90deg)' : undefined }}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        {/* "Reasoning" alone is a static word for something that can run for
            minutes, so it reads as a hang. While tokens are still arriving it
            becomes a live count of how long it has been thinking — measured,
            not a spinner, and it stops the moment the text stops growing. */}
        {live ? <span className="reasoning-live" aria-hidden="true" /> : null}
        {live ? `Thinking ${formatMs(Date.now() - startedAt)}` : 'Reasoning'}
        <span
          className="reasoning-count tnum"
          title={
            measured
              ? 'Measured while the turn streamed'
              : 'Estimated from character count — the measured figure appears when the turn finishes'
          }
        >
          {measured ? '' : '~'}
          {formatTokens(used)}
          {/* Against the ceiling, because reasoning is billed from the same
              budget as the answer — a bare count cannot tell you it is about to
              run out, and the whole failure is that the answer never arrives. */}
          {share !== null ? ` / ${formatTokens(budget as number)} tok` : ' tok'} · {lines}{' '}
          lines
        </span>
        {runaway ? (
          <span className="reasoning-warn">
            {Math.round((share as number) * 100)}% of the budget, still no answer — Stop and ask
            something narrower
          </span>
        ) : null}
      </button>
      {shown ? (
        <div className="reasoning-body scroll-y" ref={bodyRef}>
          {text}
        </div>
      ) : null}
    </div>
  )
}

function Metrics({ metrics }: { metrics: NonNullable<ChatMessage['metrics']> }) {
  return (
    <div className="msg-metrics tnum">
      <span className="mm-model" title={metrics.modelId}>
        {basename(metrics.modelId)}
      </span>
      <span className="mm">
        <span className="mm-k">in</span>
        <span className="mm-v">{formatTokens(metrics.promptTokens)}</span>
      </span>
      <span className="mm">
        <span className="mm-k">out</span>
        <span className="mm-v">{formatTokens(metrics.completionTokens)}</span>
      </span>
      {metrics.reasoningTokens !== undefined && metrics.reasoningTokens > 0 ? (
        <span className="mm">
          <span className="mm-k">reasoning</span>
          <span className="mm-v">{formatTokens(metrics.reasoningTokens)}</span>
        </span>
      ) : null}
      <span className="mm">
        <span className="mm-k">ttft</span>
        <span className="mm-v">{formatMs(metrics.ttftMs)}</span>
      </span>
      <span className="mm mm-prefill">
        <span className="mm-k">prefill</span>
        <span className="mm-v">{formatTps(metrics.prefillTps)} tok/s</span>
      </span>
      <span className="mm mm-decode">
        <span className="mm-k">decode</span>
        <span className="mm-v">{formatTps(metrics.decodeTps)} tok/s</span>
      </span>
      <span className="mm">
        <span className="mm-k">total</span>
        <span className="mm-v">{formatMs(metrics.totalMs)}</span>
      </span>
      {metrics.finishReason !== undefined && metrics.finishReason !== 'stop' ? (
        <span className="mm-flag" title="Generation did not stop naturally">
          {metrics.finishReason}
        </span>
      ) : null}
      {metrics.source === 'lab' ? (
        <span className="mm-k" title="Measured on the Mac Studio, not client-side">
          lab
        </span>
      ) : null}
    </div>
  )
}
