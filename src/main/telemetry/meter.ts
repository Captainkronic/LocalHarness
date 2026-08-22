/**
 * Client-side turn measurement.
 *
 * Everything here except prefill progress is measured. Prefill progress is an
 * ESTIMATE and is flagged as one, because the OpenAI wire protocol carries no
 * prefill signal at all: between the request leaving and the first token
 * arriving there is literal silence on the socket. The estimate is
 * `elapsed / (promptTokens / calibratedPrefillTps)`, clamped to 0.99 until the
 * first token actually lands, and `null` when the model has no calibrated rate
 * yet — a cold start shows no bar rather than a fabricated one.
 *
 * Decode rate is measured over a rolling 2s window rather than cumulatively, so
 * it reflects the current rate instead of being dragged down by TTFT.
 */

import type { InferencePhase, LiveMetrics, TurnMetrics } from '@shared/types'

/** Rolling window for the decode rate. */
const DECODE_WINDOW_MS = 2_000
/** Below this the window is too short to divide by; report nothing instead. */
const MIN_DECODE_SPAN_MS = 150
/** EMA weight for calibration, per the spec. */
const CALIBRATION_WEIGHT = 0.3
/**
 * Prompts shorter than this measure round-trip latency, not prefill throughput,
 * so they are not allowed to poison the estimate.
 *
 * This is not a conservative guess — it is measured. A 15-token prompt against a
 * warm qwen3.8-27b on this box returns its first token in 1,372ms, which implies
 * "10.9 tok/s" if you divide naively. The box's true prefill rate is ~170 tok/s.
 * Essentially all of that 1,372ms is fixed overhead (scheduling, template
 * rendering, sampler setup), so a single short prompt understates the rate by
 * more than an order of magnitude.
 */
const MIN_CALIBRATION_PROMPT_TOKENS = 512

/**
 * A TTFT this long on a prompt this short cannot be prefill — it is LM Studio
 * JIT-loading the model. Measured cold on this box: 19,071ms for 15 prompt
 * tokens, against 1,372ms warm. Feeding that to the calibrator would teach it
 * 0.8 tok/s and make every later estimate useless, so it is discarded outright.
 */
const COLD_LOAD_MS = 8_000
const COLD_LOAD_TOKEN_FLOOR = 4_000

/** Two samples must differ by at least this many prompt tokens before the slope
 *  between them says anything about throughput rather than about noise. */
const MIN_CALIBRATION_SPREAD = 512

/** Samples retained per model for the fit. Enough to span depths, few enough
 *  that a stale one ages out quickly. */
const MAX_SAMPLES_PER_MODEL = 12

interface PrefillSample {
  promptTokens: number
  ttftMs: number
}

interface DecodeSample {
  at: number
  tokens: number
}

export class TurnMeter {
  private modelId: string | null = null
  private promptTokens = 0
  private completionTokens = 0
  private reasoningTokens = 0
  /** What was actually sent as reasoning_effort, recorded so the footer can
   *  show the setting beside its cost. */
  private reasoningEffort: string | undefined
  private reasoningCap: number | undefined
  private toolSchemaTokens = 0
  private estimatedPrefillTps: number | null = null
  private estimatedOverheadMs = 0
  private startedAt: number | null = null
  private firstTokenAt: number | null = null
  private finishedAt: number | null = null
  private phaseStartedAt: number | null = null
  private phase: InferencePhase = 'idle'
  private samples: DecodeSample[] = []

  /**
   * Call as the request leaves the client. `estimatedPrefillTps` comes from
   * `RateCalibrator.prefillTps(modelId)` and may be null on a cold start.
   *
   * `estimatedOverheadMs` is an ADDITION TO THE SPEC: TTFT is
   * `overhead + tokens / rate`, and leaving the overhead out makes the ETA read
   * as zero for a short prompt when the real wait is still over a second.
   */
  start(
    modelId: string,
    promptTokens: number,
    estimatedPrefillTps: number | null,
    estimatedOverheadMs = 0
  ): void {
    this.reset()
    this.modelId = modelId
    this.promptTokens = Math.max(0, Math.round(promptTokens))
    this.estimatedPrefillTps =
      estimatedPrefillTps !== null && estimatedPrefillTps > 0 ? estimatedPrefillTps : null
    this.estimatedOverheadMs = Math.max(0, estimatedOverheadMs)
    this.startedAt = Date.now()
    this.setPhase('prefill')
  }

  markQueued(): void {
    this.setPhase('queued')
  }

  markFirstToken(): void {
    if (this.firstTokenAt !== null) return
    this.firstTokenAt = Date.now()
    this.setPhase('decode')
  }

  /** One generated content token (or `n` of them). */
  countCompletionToken(n = 1): void {
    if (n <= 0) return
    this.completionTokens += n
    this.samples.push({ at: Date.now(), tokens: n })
  }

  /**
   * ADDITION TO THE SPEC. Reasoning deltas are generated tokens too, so they
   * count toward decode rate and completion total, but are tracked separately
   * for `TurnMetrics.reasoningTokens`. Call this OR `countCompletionToken` for a
   * given delta, never both.
   */
  countReasoningToken(n = 1): void {
    if (n <= 0) return
    this.reasoningTokens += n
    this.countCompletionToken(n)
  }

  /**
   * ADDITION TO THE SPEC. `TurnMetrics.toolSchemaTokens` is required but only
   * the orchestrator knows how much of the prompt was tool schemas; it hands the
   * number over here so `finish()` can return a complete record.
   */
  setReasoningEffort(effort: string | undefined): void {
    this.reasoningEffort = effort
  }

  /** The reasoning ceiling in force for this request, so the UI can divide by
   *  the number that actually governs rather than by the output ceiling. */
  setReasoningCap(cap: number | undefined): void {
    this.reasoningCap = cap
  }

  setToolSchemaTokens(n: number): void {
    this.toolSchemaTokens = Math.max(0, Math.round(n))
  }

  markToolPhase(): void {
    this.setPhase('tool')
  }

  markDecodePhase(): void {
    this.setPhase('decode')
  }

  snapshot(): LiveMetrics {
    const now = Date.now()
    const elapsedMs = this.startedAt === null ? 0 : now - this.startedAt
    const ttftMs =
      this.startedAt === null || this.firstTokenAt === null
        ? null
        : this.firstTokenAt - this.startedAt

    // Once the first token lands, prefill throughput can be measured — but only
    // when the prompt was deep enough that prefill dominated the wait. Below
    // that, promptTokens/ttft is mostly fixed overhead and reporting it as a
    // measured rate would be a lie with a precise-looking decimal point on it.
    // (Measured here: 15 tokens warm => "10.9 tok/s" against a true ~170.)
    const measuredPrefill =
      ttftMs !== null && ttftMs > 0 && this.promptTokens >= MIN_CALIBRATION_PROMPT_TOKENS
        ? this.promptTokens / (ttftMs / 1000)
        : null

    const prefillEstimated = measuredPrefill === null
    const prefillTps = measuredPrefill ?? this.estimatedPrefillTps

    const expectedPrefillMs = this.expectedPrefillMs()
    let prefillProgress: number | null
    let prefillEtaMs: number | null
    if (this.firstTokenAt !== null) {
      prefillProgress = 1
      prefillEtaMs = 0
    } else if (expectedPrefillMs === null) {
      // No calibrated rate for this model yet — show nothing, invent nothing.
      prefillProgress = null
      prefillEtaMs = null
    } else {
      prefillProgress = Math.min(0.99, Math.max(0, elapsedMs / expectedPrefillMs))
      prefillEtaMs = Math.max(0, expectedPrefillMs - elapsedMs)
    }

    return {
      phase: this.phase,
      modelId: this.modelId,
      elapsedMs,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      ttftMs,
      prefillTps,
      prefillEstimated,
      prefillProgress,
      prefillEtaMs,
      decodeTps: this.decodeTps(now),
      reasoningTokens: this.reasoningTokens,
      phaseElapsedMs: this.phaseStartedAt === null ? elapsedMs : now - this.phaseStartedAt
    }
  }

  finish(
    usage: { promptTokens: number; completionTokens: number },
    finishReason: string
  ): TurnMetrics {
    const now = Date.now()
    this.finishedAt = now
    this.setPhase('idle')

    const startedAt = this.startedAt ?? now
    const totalMs = now - startedAt
    // Server-reported usage wins; our own count is the fallback when a backend
    // omits it (LM Studio does not, but the proxy chain is not the only path).
    const promptTokens = usage.promptTokens > 0 ? usage.promptTokens : this.promptTokens
    const completionTokens =
      usage.completionTokens > 0 ? usage.completionTokens : this.completionTokens

    // No first token at all — a reasoning model that spent the whole budget on
    // reasoning_content and returned empty with finish_reason 'length'. The
    // entire turn was time-to-nothing, so that is what ttft reports.
    const ttftMs = this.firstTokenAt === null ? totalMs : this.firstTokenAt - startedAt
    const decodeMs = this.firstTokenAt === null ? 0 : now - this.firstTokenAt

    const metrics: TurnMetrics = {
      modelId: this.modelId ?? '',
      promptTokens,
      completionTokens,
      ttftMs,
      totalMs,
      prefillTps: ttftMs > 0 && promptTokens > 0 ? promptTokens / (ttftMs / 1000) : 0,
      // Floored by the same span the live gauge demands. A 16-token reply that
      // finishes in three milliseconds divides out to "5333 tok/s", which is a
      // division artifact wearing the costume of a measurement — and one
      // absurd figure costs more trust than a missing one, since the reader
      // cannot tell which of the other numbers to believe afterwards.
      decodeTps:
        decodeMs >= MIN_DECODE_SPAN_MS && completionTokens > 0
          ? completionTokens / (decodeMs / 1000)
          : 0,
      toolSchemaTokens: this.toolSchemaTokens,
      source: 'client',
      finishReason
    }
    if (this.reasoningTokens > 0) metrics.reasoningTokens = this.reasoningTokens
    if (this.reasoningEffort !== undefined) metrics.reasoningEffortUsed = this.reasoningEffort
    if (this.reasoningCap !== undefined) metrics.reasoningCapUsed = this.reasoningCap
    return metrics
  }

  /**
   * Every phase change goes through here so the clock beside the phase word can
   * mean the phase.
   *
   * It used to render `elapsedMs`, which is stamped once when the request
   * leaves the client and never re-stamped. So "tool 3m 30s" meant the request
   * was 3m30s old, not that the tool had run that long — while the turn strip
   * directly below it showed the same command's true "(10.2s)". Two surfaces
   * contradicting each other on screen at the same moment.
   */
  private setPhase(next: InferencePhase): void {
    if (this.phase === next) return
    this.phase = next
    this.phaseStartedAt = Date.now()
  }

  reset(): void {
    this.modelId = null
    this.promptTokens = 0
    this.completionTokens = 0
    this.reasoningTokens = 0
    this.reasoningEffort = undefined
    this.reasoningCap = undefined
    this.toolSchemaTokens = 0
    this.estimatedPrefillTps = null
    this.estimatedOverheadMs = 0
    this.startedAt = null
    this.firstTokenAt = null
    this.finishedAt = null
    this.phase = 'idle'
    this.phaseStartedAt = null
    this.samples = []
  }

  /* ---------------------------------------------------------------- */

  private expectedPrefillMs(): number | null {
    if (this.estimatedPrefillTps === null || this.promptTokens <= 0) return null
    return this.estimatedOverheadMs + (this.promptTokens / this.estimatedPrefillTps) * 1000
  }

  private decodeTps(now: number): number | null {
    if (this.firstTokenAt === null) return null
    /*
     * Nothing is decoding during a tool call, and a held number rendered in the
     * live grammar is worse than no number. finish() stamps `finishedAt` but
     * never clears `samples`, so the window below used to anchor to that stamp
     * and return the SAME value forever: a 3-minute npm install sat under an
     * unmoving "decode 13.9 tok/s" in full live colour. Returning null hands the
     * gauge back its own held-value grammar — the '·' glyph and the dimming.
     */
    if (this.phase === 'tool' || this.phase === 'idle') return null
    const reference = this.finishedAt ?? now
    const windowStart = Math.max(reference - DECODE_WINDOW_MS, this.firstTokenAt)
    const span = reference - windowStart
    if (span < MIN_DECODE_SPAN_MS) return null

    let tokens = 0
    let keepFrom = 0
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i]
      if (sample === undefined) continue
      if (sample.at < windowStart) {
        keepFrom = i + 1
        continue
      }
      tokens += sample.tokens
    }
    // Drop samples that have fallen out of the window so this stays O(window).
    if (keepFrom > 0) this.samples = this.samples.slice(keepFrom)

    // No tokens in the window is NOT a rate of zero — it is a gap, and in an
    // agentic turn most of the wall clock is gaps: between tool calls the model
    // re-prefills for twenty seconds or more and emits nothing. Returning 0
    // made formatTps render "—", so decode read as dead at exactly the moments
    // the user is wondering whether the app has hung. null means "unknown",
    // which the gauge already handles by holding the last measured rate and
    // marking it as not-current.
    if (tokens === 0) return null
    return tokens / (span / 1000)
  }
}

/**
 * Learns per-model prefill and decode rates from completed turns as an
 * exponential moving average (weight 0.3). Persists nothing: a cold start simply
 * shows no estimate until the first turn completes.
 */
/**
 * Learns each model's prefill and decode rates from completed turns.
 *
 * TTFT is not proportional to prompt size — it is `overhead + tokens / rate`,
 * where the overhead is hundreds of milliseconds to a couple of seconds. Fitting
 * a rate from one sample folds that overhead into the slope and produces a
 * number that is wrong by an order of magnitude at small prompt sizes. So the
 * rate comes from the *slope between two samples at different depths*, which
 * cancels the overhead, and the overhead falls out of the same fit.
 */
export class RateCalibrator {
  private readonly prefill = new Map<string, number>()
  private readonly overhead = new Map<string, number>()
  private readonly decode = new Map<string, number>()
  private readonly samples = new Map<string, PrefillSample[]>()
  /** Models whose rate came from a real two-point fit rather than a placeholder. */
  private readonly fitted = new Set<string>()

  observe(
    modelId: string,
    promptTokens: number,
    ttftMs: number,
    completionTokens: number,
    decodeMs: number
  ): void {
    if (modelId.length === 0) return

    if (completionTokens > 0 && decodeMs > 0) {
      this.blend(this.decode, modelId, completionTokens / (decodeMs / 1000))
    }

    if (ttftMs <= 0 || promptTokens <= 0) return
    // A JIT model load masquerading as a slow prefill. Never calibrate on it.
    if (ttftMs > COLD_LOAD_MS && promptTokens < COLD_LOAD_TOKEN_FLOOR) return

    const list = this.samples.get(modelId) ?? []
    list.push({ promptTokens, ttftMs })
    if (list.length > MAX_SAMPLES_PER_MODEL) list.shift()
    this.samples.set(modelId, list)
    this.refit(modelId, list)
  }

  prefillTps(modelId: string): number | null {
    return this.prefill.get(modelId) ?? null
  }

  /** Fixed per-request latency before prefill throughput starts to matter.
   *  0 when it has not been separated from the rate yet. */
  overheadMs(modelId: string): number {
    return this.overhead.get(modelId) ?? 0
  }

  decodeTps(modelId: string): number | null {
    return this.decode.get(modelId) ?? null
  }

  /**
   * Two-point fit across the widest depth spread available. Falls back to a
   * single deep sample when there is no spread yet, and to nothing at all when
   * every sample so far is short — in which case the UI shows no estimate,
   * which is the honest answer.
   */
  private refit(modelId: string, list: PrefillSample[]): void {
    const sorted = [...list].sort((a, b) => a.promptTokens - b.promptTokens)
    const lo = sorted[0]
    const hi = sorted[sorted.length - 1]

    if (
      lo !== undefined &&
      hi !== undefined &&
      hi.promptTokens - lo.promptTokens >= MIN_CALIBRATION_SPREAD &&
      hi.ttftMs > lo.ttftMs
    ) {
      const rate =
        (hi.promptTokens - lo.promptTokens) / ((hi.ttftMs - lo.ttftMs) / 1000)
      if (Number.isFinite(rate) && rate > 0) {
        // The first real fit REPLACES any single-sample guess rather than
        // blending with it. Blending would drag a correct slope toward a value
        // that was only ever a placeholder — measured here as 170 tok/s being
        // pulled to 148 by one earlier short-prompt estimate.
        if (this.fitted.has(modelId)) {
          this.blend(this.prefill, modelId, rate)
          this.blend(this.overhead, modelId, Math.max(0, lo.ttftMs - (lo.promptTokens / rate) * 1000))
        } else {
          this.fitted.add(modelId)
          this.prefill.set(modelId, rate)
          this.overhead.set(modelId, Math.max(0, lo.ttftMs - (lo.promptTokens / rate) * 1000))
        }
        return
      }
    }

    // No usable spread yet. A single sufficiently deep sample still beats
    // nothing, because at that size prefill dominates the fixed overhead — but
    // it is a placeholder, and a proper fit will overwrite rather than blend.
    if (
      !this.fitted.has(modelId) &&
      hi !== undefined &&
      hi.promptTokens >= MIN_CALIBRATION_PROMPT_TOKENS
    ) {
      this.blend(this.prefill, modelId, hi.promptTokens / (hi.ttftMs / 1000))
    }
  }

  /**
   * How much our character-based token estimate undercounts, per model.
   *
   * `estimateTokens` divides characters by 4, which is the right ratio for
   * English prose and badly wrong for what an agentic coding turn is actually
   * made of — source, JSON tool arguments, diffs, stack traces. Dense
   * punctuation and identifiers tokenise far worse than prose.
   *
   * Measured on a flight-sim build: the meter read **42.3k** while the server
   * reported **63.7k** prompt tokens for the same request — an effective 2.66
   * characters per token, a 1.5x undercount. That is not a cosmetic error. The
   * history budget is derived from the same estimate, so trimming believed it
   * had 20k of headroom that did not exist, never fired, and the turn died with
   * `finish_reason: length` having spent its entire output budget reasoning and
   * produced nothing.
   *
   * There is no need to guess at a better constant: the server reports real
   * `prompt_tokens` on every single request. So the ratio is learned, per model,
   * from the previous turns of this very conversation.
   */
  private readonly promptRatio = new Map<string, number>()

  /**
   * Record what the server said the prompt really cost against what we guessed.
   *
   * Both must be for the SAME request, and `estimated` must be the figure that
   * came out of `estimateTokens`, or the ratio measures the wrong thing.
   */
  observePromptEstimate(modelId: string, estimated: number, actual: number): void {
    if (modelId.length === 0 || estimated <= 0 || actual <= 0) return
    /* Guard against nonsense in either direction. A ratio below 1 means the
       estimate was already generous; above 4 means something other than
       tokenisation differs, and scaling by it would trim a conversation to
       nothing. */
    const ratio = actual / estimated
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 4) return
    this.blend(this.promptRatio, modelId, ratio)
  }

  /**
   * Multiplier to apply to a character-based estimate for this model.
   *
   * Returns 1 until something has been measured, so a fresh model behaves
   * exactly as before rather than being trimmed on the strength of a guess.
   */
  promptTokenRatio(modelId: string): number {
    return this.promptRatio.get(modelId) ?? 1
  }

  private blend(store: Map<string, number>, modelId: string, sample: number): void {
    if (!Number.isFinite(sample) || sample <= 0) return
    const previous = store.get(modelId)
    store.set(
      modelId,
      previous === undefined
        ? sample
        : previous * (1 - CALIBRATION_WEIGHT) + sample * CALIBRATION_WEIGHT
    )
  }
}
