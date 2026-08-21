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

import { Agent, fetch as undiciFetch } from 'undici'

import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { WireTool } from '@shared/types'

/**
 * Our own connection pool, because the default one gives up during a normal
 * tool call.
 *
 * LM Studio does not stream a tool call's arguments. It buffers the whole thing
 * and sends it in ONE delta when the call is complete — measured: a counter sat
 * frozen at 380 tokens for 217 seconds and then 11,161 characters arrived at
 * once. So while the model composes a file-sized argument, NOTHING crosses the
 * wire. Not a heartbeat, not an empty chunk. Minutes of legitimate silence.
 *
 * Node's global fetch is undici with a 300s `bodyTimeout`, and that timeout
 * measures the gap BETWEEN chunks. A tool call that takes longer than five
 * minutes to compose therefore kills its own connection every single time.
 * Confirmed against a local server that sent one chunk and went quiet:
 *
 *     301.0s  TypeError: terminated
 *             cause = BodyTimeoutError: Body Timeout Error
 *
 * That is the whole of the "terminated" failure. It was never the network: a
 * 20-minute, 5.3MB stream of ordinary content across the same hops finished
 * cleanly, because ordinary content never goes quiet.
 *
 * The value is derived, not picked. The reply is capped at 16,384 tokens
 * (workflows.ts, Code), and this hardware has been measured as low as 8 tok/s
 * when something else is sharing the GPU, so the longest legitimate silence is
 * about 34 minutes. 45 gives that headroom without being infinite — a socket
 * that is genuinely dead should still eventually say so rather than leaving the
 * app waiting forever on a connection that is never going to speak again.
 *
 * `headersTimeout` stays short by comparison: headers come back immediately even
 * when the request is queued behind another, so a long wait there is a real
 * fault rather than a model thinking.
 */
const STREAM_AGENT_BODY_TIMEOUT_MS = 45 * 60_000

/**
 * How long the server may say nothing BEFORE the first token, as opposed to after.
 *
 * The 45 minutes above is the right allowance for silence *mid-reply*, because
 * a tool call being composed genuinely crosses the wire in one piece at the
 * end. It is the wrong allowance for silence *before the reply starts*, and the
 * difference is what makes this a separate timer rather than a smaller one.
 *
 * The failure it exists for: a run whose prompt had grown past the server's real
 * per-slot context sat in prefill for THIRTY-ONE MINUTES. The GPU was pinned at
 * 100% the whole time — llama.cpp context-shifting on every step, making no
 * progress it could ever finish. Nothing distinguished it from health, because
 * silence is exactly what a healthy prefill looks like too, and the body
 * timeout could not fire until 45 minutes had passed.
 *
 * Before the first token there is no tool call to be composing, so the only
 * thing that can legitimately take this long is prefill itself — and prefill is
 * bounded by prompt size over prefill rate. The slowest measured rate on this
 * hardware is ~175 tok/s, so even a 100k prompt reads in about ten minutes.
 * Fifteen leaves half again on top and still catches a wedge less than half way
 * through the old ceiling.
 *
 * Deliberately NOT a settings knob: it is a fault detector, and a fault the
 * user can raise until it stops firing is one they will stop seeing.
 */
const FIRST_TOKEN_TIMEOUT_MS = 15 * 60_000

const STREAM_AGENT = new Agent({
  bodyTimeout: STREAM_AGENT_BODY_TIMEOUT_MS,
  headersTimeout: 2 * 60_000
})

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

  /*
   * One line per request, describing what is ACTUALLY on the wire.
   *
   * This exists because the app's own record of a request disagreed with the
   * request. Metrics said reasoning_effort 'none' on turns where nothing in
   * the code could have set it, and a whole afternoon went into arguing with a
   * field recorded after the fact instead of reading what was sent. Anything
   * downstream — a meter, a footer, a panel — is a copy; this is the original.
   */
  console.log(
    `[llm] -> ${String(payload.model)} ` +
      `effort=${payload.reasoning_effort === undefined ? '(omitted)' : String(payload.reasoning_effort)} ` +
      `temp=${String(payload.temperature)} top_p=${String(payload.top_p)} ` +
      `max_tokens=${String(payload.max_tokens)} ` +
      `msgs=${Array.isArray(payload.messages) ? payload.messages.length : 0} ` +
      `tools=${Array.isArray(payload.tools) ? payload.tools.length : 0}`
  )

  let doneEmitted = false
  const emitDone = (reason: string): void => {
    if (doneEmitted) return
    doneEmitted = true
    ev.onDone(reason)
  }

  let firstTokenSeen = false
  /* Set only by the watchdog below, and read after the loop: cancelling the
     reader ends the read normally, so without a flag a wedge is indistinguishable
     from a server that simply finished. */
  let prefillStalled = false
  let firstTokenTimer: NodeJS.Timeout | null = null
  const clearFirstTokenTimer = (): void => {
    if (firstTokenTimer !== null) {
      clearTimeout(firstTokenTimer)
      firstTokenTimer = null
    }
  }
  const markFirstToken = (): void => {
    if (firstTokenSeen) return
    firstTokenSeen = true
    // The reply has started, so any silence from here is the tool-call case
    // that STREAM_AGENT's 45 minutes exists to allow.
    clearFirstTokenTimer()
    ev.onFirstToken()
  }

  let response: Response
  try {
    response = (await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: req.signal,
      // Must be undici's own fetch, not the global one: a dispatcher only
      // applies to the copy of undici it came from.
      dispatcher: STREAM_AGENT
    })) as unknown as Response
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

  firstTokenTimer = setTimeout(() => {
    if (firstTokenSeen) return
    prefillStalled = true
    // Ends the read; the throw happens after the loop where the reason is known.
    void reader.cancel().catch(() => undefined)
  }, FIRST_TOKEN_TIMEOUT_MS)
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
      // minutes of work and explained nothing.
      //
      // Test the ERROR, not a rendering of it. The previous version matched
      // /^terminated$/i against messageOf(err), and messageOf appends the cause:
      // the real error stringifies to "terminated (Body Timeout Error)", the
      // anchored regex missed, and the raw word went to the transcript anyway.
      // The guard had never once fired.
      if (err instanceof TypeError && /^terminated$/i.test(err.message)) {
        const cause = err.cause
        const causeName = cause instanceof Error ? cause.name : ''
        if (causeName === 'BodyTimeoutError') {
          // Distinguish the two silences, because the remedies are opposite.
          // This one means the server accepted the request and then said
          // nothing for the whole timeout — with LM Studio that is usually a
          // tool call being composed, which crosses the wire only when it is
          // finished. See STREAM_AGENT.
          throw new Error(
            `${url} accepted the request and then sent nothing for ` +
              `${Math.round(STREAM_AGENT_BODY_TIMEOUT_MS / 60_000)} minutes, so the connection was closed. ` +
              `Nothing was wrong with the request. If the model was composing a large tool call, ` +
              `it may simply have needed longer than that.`
          )
        }
        throw new Error(
          `The connection to ${url} dropped part-way through the response` +
            (causeName ? ` (${causeName})` : '') +
            `. Nothing was wrong with the request — the stream ended early. ` +
            `Check the inference server is still up, then send again.`
        )
      }
      throw err
    }
    aborted = true
  } finally {
    clearFirstTokenTimer()
    // Releases the socket whether we drained the stream or bailed out of it.
    void reader.cancel().catch(() => undefined)
  }

  /*
   * Checked before `aborted`, because the watchdog's cancel LOOKS like a clean
   * end of stream and would otherwise be reported as a turn that simply
   * finished with nothing to say.
   */
  if (prefillStalled) {
    throw new Error(
      `${url} accepted the request and never produced a first token in ` +
        `${Math.round(FIRST_TOKEN_TIMEOUT_MS / 60_000)} minutes. That is not a model thinking: ` +
        `before the first token there is no tool call to compose, so the server is stuck ` +
        `rather than slow. The usual cause is a prompt longer than the context a single ` +
        `request actually gets — llama.cpp splits its window across --parallel slots, so a ` +
        `server showing 101632 with PARALLEL 4 gives one request 25408 and shifts context ` +
        `forever past that. Check the PARALLEL column of \`lms ps\` against the app's ` +
        `contextSlots setting, or start a new conversation to shorten the prompt.`
    )
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
