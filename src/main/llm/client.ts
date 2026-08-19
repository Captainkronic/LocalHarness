/**
 * Streaming chat client for the OpenAI-compatible endpoint.
 *
 * The endpoint is a chain — local sanitising proxy 127.0.0.1:1235 -> Mac Studio
 * :1234 (lmstudio-lab relay) -> LM Studio :1235 — and every hop speaks plain
 * OpenAI HTTP. The relay cannot upgrade a connection, so this is `fetch` and
 * hand-rolled SSE parsing only: no websockets, no EventSource, no SDK.
 *
 * Three behaviours of this specific server drive the shape of the parser:
 *  - `usage` arrives in the FINAL SSE chunk, and that chunk's `choices` array is
 *    empty. An empty `choices` is normal, not an error.
 *  - Reasoning models put their scratchpad in `delta.reasoning_content`, a
 *    sibling of `delta.content`. It never belongs in the answer.
 *  - When `max_tokens` is too small a reasoning model burns the whole budget on
 *    reasoning and returns empty content with `finish_reason: 'length'`. That is
 *    why the finish reason is always surfaced, even on an empty completion.
 */

import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { WireTool } from '@shared/types'

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  temperature: number
  /**
   * Penalises tokens by how often they have already appeared. Measured on
   * qwen3.8: 0.5 cut reasoning from ~920 tokens to 480 while INCREASING the
   * answer, which is the profile you want — a model re-deriving its own
   * conclusions is exhibiting repetition, and this is the knob for it.
   */
  frequencyPenalty?: number
  /** Penalises a token for having appeared at all. Measured as weaker than
   *  frequencyPenalty here (781 vs 480), kept for completeness. */
  presencePenalty?: number
  /** llama.cpp-style multiplicative penalty. Measured at 1.15: 764 tokens. */
  repetitionPenalty?: number
  topP: number
  topK?: number
  minP?: number
  maxTokens: number
  /** OpenAI `reasoning_effort`. Omitted leaves the model's own default alone;
   *  'none' suppresses reasoning entirely, which is what makes spoken replies
   *  start in ~0.3s instead of ~3.9s. */
  reasoningEffort?: string
  signal: AbortSignal
}

export interface StreamEvents {
  onFirstToken(): void
  onContent(delta: string): void
  onReasoning(delta: string): void
  onToolCallDelta(
    index: number,
    id: string | undefined,
    name: string | undefined,
    argsDelta: string
  ): void
  onUsage(u: { promptTokens: number; completionTokens: number }): void
  onDone(finishReason: string): void
}

/* ------------------------------------------------------------------ */
/* Wire shapes we expect back. Every field is optional because the      */
/* parser must not assume any backend fills them all in.                */
/* ------------------------------------------------------------------ */

interface WireToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface WireDelta {
  content?: string | null
  /** LM Studio's reasoning channel. Some builds spell it `reasoning`. */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCallDelta[]
}

interface WireChoice {
  index?: number
  delta?: WireDelta
  finish_reason?: string | null
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage | null
  error?: unknown
}

const MAX_ERROR_PREVIEW = 600

export async function streamChat(req: ChatRequest, ev: StreamEvents): Promise<void> {
  const url = `${trimTrailingSlash(req.baseUrl)}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
  if (req.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${req.apiKey.trim()}`
  }

  const payload: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    // LM Studio sends usage in the last chunk without being asked; other
    // backends behind the same proxy need this flag to do the same.
    stream_options: { include_usage: true },
    temperature: req.temperature,
    top_p: req.topP,
    // Omitted entirely when unset rather than sent as a default — "unset" and
    // "the value that happens to be the default" are different requests, and
    // only the first lets the server decide.
    ...(req.topK === undefined ? {} : { top_k: req.topK }),
    ...(req.minP === undefined ? {} : { min_p: req.minP }),
    // Only sent when set, so a model or server that rejects one is not handed
    // it by default.
    ...(req.frequencyPenalty !== undefined ? { frequency_penalty: req.frequencyPenalty } : {}),
    ...(req.presencePenalty !== undefined ? { presence_penalty: req.presencePenalty } : {}),
    ...(req.repetitionPenalty !== undefined ? { repetition_penalty: req.repetitionPenalty } : {}),
    max_tokens: req.maxTokens
  }
  if (req.reasoningEffort !== undefined) {
    // Measured on gemma-4-e4b: 'none' moves the first speakable token from
    // 3,946ms to 312ms. Note that chat_template_kwargs {reasoning:'off'} does
    // NOT achieve this — it still reasoned; only reasoning_effort works.
    payload.reasoning_effort = req.reasoningEffort
  }
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools
    payload.tool_choice = 'auto'
  }

  let doneEmitted = false
  const emitDone = (reason: string): void => {
    if (doneEmitted) return
    doneEmitted = true
    ev.onDone(reason)
  }

  let firstTokenSeen = false
  const markFirstToken = (): void => {
    if (firstTokenSeen) return
    firstTokenSeen = true
    ev.onFirstToken()
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: req.signal
    })
  } catch (err) {
    if (isAbort(err, req.signal)) {
      emitDone('aborted')
      return
    }
    throw new Error(`Cannot reach ${url}: ${messageOf(err)}`)
  }

  if (!response.ok) {
    // The body carries the real cause — "Failed to load model" means the box is
    // out of memory. Pass it through verbatim; do not reinterpret it.
    const body = await response.text().catch(() => '')
    const detail = body.trim().length > 0 ? body.trim() : '(empty response body)'
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${detail}`)
  }

  const stream = response.body as WebReadableStream<Uint8Array> | null
  if (stream === null) {
    throw new Error(`${url} returned a response with no body`)
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let finishReason = ''
  let sawChunk = false
  let sawDoneSentinel = false
  let aborted = false
  /** Kept only so a non-SSE 200 (a proxy answering with a JSON error) can be reported. */
  let rawPreview = ''

  /** Returns true when the `[DONE]` sentinel has been seen. */
  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) return false
    // ':' prefixed lines are SSE comments (heartbeats); `event:` names are unused here.
    if (line.startsWith(':')) return false
    if (!line.startsWith('data:')) return false

    const data = line.slice(5).trim()
    if (data.length === 0) return false
    if (data === '[DONE]') return true

    const chunk = parseChunk(data)
    if (chunk === null) return false
    sawChunk = true

    if (chunk.usage) {
      ev.onUsage({
        promptTokens: numberOr(chunk.usage.prompt_tokens, 0),
        completionTokens: numberOr(chunk.usage.completion_tokens, 0)
      })
    }

    // The final usage chunk carries `choices: []`. That is expected, not a fault.
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason
      }
      const delta = choice.delta
      if (!delta) continue

      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : ''
      if (reasoning.length > 0) {
        markFirstToken()
        ev.onReasoning(reasoning)
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        markFirstToken()
        ev.onContent(delta.content)
      }

      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        if (!call) continue
        markFirstToken()
        // `index` is what the caller accumulates by; fall back to array position
        // for backends that omit it on a single-call stream.
        const index = typeof call.index === 'number' ? call.index : i
        const name =
          typeof call.function?.name === 'string' ? call.function.name : undefined
        const args =
          typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        ev.onToolCallDelta(
          index,
          typeof call.id === 'string' ? call.id : undefined,
          name,
          args
        )
      }
    }
    return false
  }

  try {
    while (!req.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue

      const text = decoder.decode(value, { stream: true })
      if (!sawChunk && rawPreview.length < MAX_ERROR_PREVIEW) {
        rawPreview += text
      }
      buffer += text

      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        if (handleLine(line)) {
          sawDoneSentinel = true
          break
        }
        newlineAt = buffer.indexOf('\n')
      }
      if (sawDoneSentinel) break
    }
    if (req.signal.aborted) aborted = true
  } catch (err) {
    if (!isAbort(err, req.signal)) {
      // undici throws a bare `TypeError: terminated` when a streaming body ends
      // before the server said it was done. Surfaced raw it reads as a verdict
      // from the model — "terminated" appeared in the transcript for twenty
      // minutes of work and explained nothing. It is a dropped connection, and
      // the useful facts are which endpoint dropped it and how far it got.
      if (/^terminated$/i.test(messageOf(err))) {
        throw new Error(
          `The connection to ${url} dropped part-way through the response. ` +
            `Nothing was wrong with the request — the stream ended early. ` +
            `Check the inference server is still up, then send again.`
        )
      }
      throw err
    }
    aborted = true
  } finally {
    // Releases the socket whether we drained the stream or bailed out of it.
    void reader.cancel().catch(() => undefined)
  }

  if (aborted) {
    // Abort is a clean exit, never an AbortError thrown at the caller. The
    // terminal event still fires so the caller always gets exactly one, and
    // 'aborted' cannot be mistaken for 'stop' or 'tool_calls'.
    emitDone('aborted')
    return
  }

  if (!sawDoneSentinel) {
    // Flush any multi-byte sequence the last chunk left half-decoded.
    buffer += decoder.decode()
    if (buffer.length > 0) handleLine(buffer)
  }

  if (!sawChunk && !sawDoneSentinel) {
    const preview = rawPreview.trim()
    if (preview.length > 0) {
      // A 200 that was never SSE: usually a proxy answering with a JSON error.
      throw new Error(`${url} returned a non-streaming response: ${preview.slice(0, MAX_ERROR_PREVIEW)}`)
    }
  }

  emitDone(finishReason)
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function parseChunk(data: string): WireChunk | null {
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== 'object' || value === null) return null
    return value as WireChunk
  } catch {
    return null
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause
    if (cause instanceof Error && cause.message !== err.message) {
      return `${err.message} (${cause.message})`
    }
    return err.message
  }
  return String(err)
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
