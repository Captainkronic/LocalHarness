/**
 * One conversation turn. Role differentiation is the whole point here: a user
 * message is a compact bubble, an assistant message is full-width prose with
 * its tool calls, reasoning and telemetry attached.
 */

import { useState } from 'react'
import type { Attachment, ChatMessage } from '@shared/types'
import { basename, formatMs, formatTokens, formatTps } from '@renderer/lib/format'
import Markdown from './Markdown'
import ToolCallCard from './ToolCallCard'
import './chat.css'

export interface MessageProps {
  message: ChatMessage
  /** Tool results recorded as separate role:'tool' messages, keyed by call id. */
  toolResults?: ReadonlyMap<string, string>
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
  const toolCalls = message.toolCalls ?? []
  const hasBody = message.content !== ''

  return (
    <div className="msg msg-assistant">
      {message.reasoning !== undefined && message.reasoning !== '' ? (
        <Reasoning text={message.reasoning} />
      ) : null}

      {hasBody ? (
        <div>
          <Markdown text={message.content} />
          {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      ) : message.streaming && toolCalls.length === 0 ? (
        <span className="caret" aria-hidden="true" />
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
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n').length
  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
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
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        Reasoning
        <span className="reasoning-count tnum">
          {formatTokens(Math.ceil(text.length / 4))} tok · {lines} lines
        </span>
      </button>
      {open ? <div className="reasoning-body scroll-y">{text}</div> : null}
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
