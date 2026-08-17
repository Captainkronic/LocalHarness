/**
 * LM Studio Lab feed.
 *
 * Adam's own `lmstudio-lab.py` on the Mac Studio sits between the proxy and LM
 * Studio and publishes what it sees at `GET {labUrl}/lab/events` as SSE. Its
 * `kind: "final"` records are server-side truth about a completed request —
 * measured at the engine, not inferred from the client's socket.
 *
 * This feed is strictly optional. An empty `labUrl` means the user has turned it
 * off: report 'unavailable' and never open a socket. A connection that fails
 * retries forever with exponential backoff to a 60s cap, and says so once rather
 * than logging on every attempt — the app is fully functional without it.
 */

import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { LabRecord, LabStatus } from '@shared/types'

export interface LabFeedOptions {
  getUrl: () => string
  onRecord: (record: LabRecord) => void
  onStatus: (status: LabStatus) => void
}

const HISTORY_LIMIT = 200
const BACKOFF_START_MS = 1_000
const BACKOFF_CAP_MS = 60_000

export class LabFeed {
  private readonly opts: LabFeedOptions
  private readonly records: LabRecord[] = []
  private currentStatus: LabStatus = 'unavailable'
  private running = false
  private controller: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private backoffMs = BACKOFF_START_MS
  /** Failures are reported once per outage, not once per retry. */
  private failureReported = false

  constructor(opts: LabFeedOptions) {
    this.opts = opts
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.backoffMs = BACKOFF_START_MS
    this.failureReported = false
    void this.connect()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.controller !== null) {
      this.controller.abort()
      this.controller = null
    }
  }

  history(): LabRecord[] {
    return this.records.slice()
  }

  status(): LabStatus {
    return this.currentStatus
  }

  /* ---------------------------------------------------------------- */

  private async connect(): Promise<void> {
    if (!this.running) return

    const root = this.opts.getUrl().trim()
    if (root.length === 0) {
      // Disabled by configuration. Not a failure, and never retried.
      this.setStatus('unavailable')
      this.running = false
      return
    }

    const url = `${root.replace(/\/+$/, '')}/lab/events`
    this.setStatus('connecting')

    const controller = new AbortController()
    this.controller = controller

    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`)
      }
      const body = res.body as WebReadableStream<Uint8Array> | null
      if (body === null) throw new Error('no response body')

      this.setStatus('connected')
      this.backoffMs = BACKOFF_START_MS
      this.failureReported = false

      await this.readStream(body, controller.signal)
      // A clean end of stream still means the feed is gone; reconnect.
      this.scheduleRetry(null)
    } catch (err) {
      if (!this.running || controller.signal.aborted) return
      this.scheduleRetry(err)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  private async readStream(
    body: WebReadableStream<Uint8Array>,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** Data lines of the SSE event currently being accumulated. */
    let dataLines: string[] = []

    try {
      while (!signal.aborted && this.running) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        buffer += decoder.decode(value, { stream: true })

        let newlineAt = buffer.indexOf('\n')
        while (newlineAt !== -1) {
          const raw = buffer.slice(0, newlineAt)
          buffer = buffer.slice(newlineAt + 1)
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

          if (line.length === 0) {
            // Blank line dispatches the accumulated event.
            if (dataLines.length > 0) {
              this.handleEvent(dataLines.join('\n'))
              dataLines = []
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
          // `event:`/`id:`/`retry:` fields and ':' comments carry no history.

          newlineAt = buffer.indexOf('\n')
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }

  private handleEvent(data: string): void {
    if (data.length === 0 || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const rec = asRecord(parsed)
    if (rec === null) return
    // 'progress' records and pings prove the feed is alive but are not history.
    if (rec.kind !== 'final') return

    const record = toLabRecord(rec)
    this.records.push(record)
    if (this.records.length > HISTORY_LIMIT) {
      this.records.splice(0, this.records.length - HISTORY_LIMIT)
    }
    this.opts.onRecord(record)
  }

  private scheduleRetry(err: unknown): void {
    if (!this.running) return
    this.setStatus('disconnected')

    if (!this.failureReported) {
      this.failureReported = true
      const reason = err === null ? 'stream ended' : messageOf(err)
      // Once per outage. This feed being down is normal and not worth a log storm.
      console.warn(`[lab] telemetry feed unavailable (${reason}); retrying in the background`)
    }

    const delay = this.backoffMs
    this.backoffMs = Math.min(BACKOFF_CAP_MS, this.backoffMs * 2)

    if (this.timer !== null) clearTimeout(this.timer)
    const timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
    timer.unref()
    this.timer = timer
  }

  private setStatus(status: LabStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    this.opts.onStatus(status)
  }
}

/* ------------------------------------------------------------------ */
/* mapping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Wire shape is snake_case with `in`/`out` for token counts:
 * {kind, ts, source, model, tps, ttft, prefill_tps, in, out, ctx_max, streamed}
 */
function toLabRecord(rec: Record<string, unknown>): LabRecord {
  return {
    ts: normaliseTimestamp(num(rec.ts)),
    source: str(rec.source) ?? 'lab',
    model: str(rec.model) ?? '',
    tps: num(rec.tps),
    ttft: normaliseTtft(num(rec.ttft)),
    prefillTps: num(rec.prefill_tps),
    inTokens: num(rec.in),
    outTokens: num(rec.out),
    ctxMax: num(rec.ctx_max),
    streamed: rec.streamed === true
  }
}

/** The relay is Python, so `ts` arrives as epoch seconds. The UI wants ms. */
function normaliseTimestamp(ts: number): number {
  if (ts <= 0) return Date.now()
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts)
}

/**
 * `ttft` likewise comes off a Python float in seconds. A sub-30ms time to first
 * token is not physically possible on this box, so a value in that range is
 * seconds and gets scaled; anything larger is already milliseconds.
 */
function normaliseTtft(ttft: number): number {
  if (ttft <= 0) return 0
  return ttft < 30 ? ttft * 1000 : ttft
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
