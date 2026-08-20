/**
 * A conversation, cut into RUNS: one prompt and everything it caused.
 *
 * The app measures each REQUEST — the metrics line under every assistant
 * message is per-request and always has been. What it never showed is the thing
 * a person actually waits on: from pressing send to the model stopping. An
 * agentic turn is dozens of requests with tool calls between them, so "how long
 * did that take" was a sum nobody could do by eye, and the answer to "was that
 * slow because of the model or because of the tools" was not anywhere at all.
 *
 * Wall clock is measured from the user's message to the END of the last reply,
 * which means it INCLUDES the time tools spent running. That is the honest
 * reading — a browser call that takes ten seconds is ten seconds you waited —
 * and it is why `toolMs` is reported beside `modelMs` rather than folded into
 * it. On a browser-heavy run the two are wildly different, and which one is
 * large tells you where to look.
 */

import type { ChatMessage } from '@shared/types'

export interface RunSummary {
  /** Index of the user message that began it, for React keys. */
  id: string
  /** What was asked, verbatim — truncation is the renderer's business. */
  prompt: string
  startedAt: number
  /** Send to last token. Null while the run is still going. */
  wallMs: number | null
  /** Time inside model requests. */
  modelMs: number
  /** wallMs - modelMs: everything that was not the model. Null while running. */
  toolMs: number | null
  /** Model requests, which is what the step cap counts. */
  steps: number
  toolCalls: number
  completionTokens: number
  reasoningTokens: number
  /** The last request's prompt size — i.e. how full the window got. */
  contextTokens: number
  /** Total completion tokens over total decode time, not a mean of means. */
  decodeTps: number | null
  /** Total prompt tokens over total time-to-first-token. */
  prefillTps: number | null
  /** Set when the run ended in an error, so a fast run is not read as a good one. */
  error: string | null
  running: boolean
}

/**
 * Split messages into runs, newest last.
 *
 * A run opens at every user message. Anything before the first one — a restored
 * conversation can start with system or assistant content — is not part of any
 * run and is skipped rather than attributed to a prompt nobody sent.
 */
export function summariseRuns(messages: ChatMessage[]): RunSummary[] {
  const runs: RunSummary[] = []
  let current: ChatMessage[] = []
  let prompt: ChatMessage | null = null

  const flush = (): void => {
    if (prompt) runs.push(build(prompt, current))
    current = []
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      prompt = m
      continue
    }
    if (prompt) current.push(m)
  }
  flush()
  return runs
}

function build(prompt: ChatMessage, body: ChatMessage[]): RunSummary {
  const assistants = body.filter((m) => m.role === 'assistant')
  const withMetrics = assistants.filter((m) => m.metrics)

  let modelMs = 0
  let ttftMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let reasoningTokens = 0
  let contextTokens = 0
  for (const m of withMetrics) {
    const x = m.metrics!
    modelMs += x.totalMs
    ttftMs += x.ttftMs
    promptTokens += x.promptTokens
    completionTokens += x.completionTokens
    reasoningTokens += x.reasoningTokens ?? 0
    contextTokens = x.promptTokens
  }

  /* Still going if the last thing in the run is streaming, or if a message
     never got metrics — which is what an interrupted request leaves behind. */
  const last = body[body.length - 1]
  const running = body.length === 0 || Boolean(last?.streaming)

  const lastDone = [...withMetrics].pop()
  const endedAt = lastDone ? lastDone.createdAt + lastDone.metrics!.totalMs : null
  const wallMs = running || endedAt === null ? null : Math.max(0, endedAt - prompt.createdAt)

  /* Decode time is generation only: ttft is prefill and waiting, and counting
     it as decode would report a rate the model never achieved. */
  const decodeMs = modelMs - ttftMs
  const error = body.reduce<string | null>((acc, m) => m.error ?? acc, null)

  return {
    id: prompt.id,
    prompt: prompt.content,
    startedAt: prompt.createdAt,
    wallMs,
    modelMs,
    toolMs: wallMs === null ? null : Math.max(0, wallMs - modelMs),
    steps: assistants.length,
    toolCalls: body.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
    completionTokens,
    reasoningTokens,
    contextTokens,
    decodeTps: decodeMs > 0 && completionTokens > 0 ? (completionTokens / decodeMs) * 1000 : null,
    prefillTps: ttftMs > 0 && promptTokens > 0 ? (promptTokens / ttftMs) * 1000 : null,
    error,
    running
  }
}
