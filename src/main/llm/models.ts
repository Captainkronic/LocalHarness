/**
 * Model registry and server health.
 *
 * Backed by `GET {nativeApiUrl}/api/v0/models`, LM Studio's native endpoint,
 * which returns rather more than the OpenAI `/v1/models` list:
 *
 *   {data: [{id, publisher, type, arch, quantization, compatibility_type,
 *            state, max_context_length, loaded_context_length?, capabilities?}]}
 *
 * Two facts about that payload shape everything here:
 *
 *  1. `loaded_context_length` is present ONLY while the model is resident, and
 *     it is the only honest context denominator. `max_context_length` is the
 *     architectural ceiling (262144 on several of these models) and is never a
 *     substitute — when the real window is unknown the answer is `null` and the
 *     UI renders an em dash.
 *  2. The same model reports a DIFFERENT `loaded_context_length` depending on
 *     whether it was loaded by hand or JIT-loaded by an API request. A learned
 *     window therefore goes stale; anything older than 120s is re-observed.
 *
 * Polling is deliberately lazy. An earlier incarnation of this poller made
 * 5,760 requests a day against this endpoint. `setActive()` marks request
 * activity: at `settings.modelPollMs` while active, 120s while idle.
 */

import type {
  LlmEndpoint, LabStatus, ModelInfo, ServerHealth, Settings } from '@shared/types'

export interface ModelRegistryOptions {
  getSettings: () => Settings
  onModels: (models: ModelInfo[]) => void
  onHealth: (health: ServerHealth) => void
  /** Optional: an extra endpoint failing is worth a line, not a health change. */
  onLog?: (level: 'info' | 'warn' | 'error', scope: string, message: string) => void
}

/** Idle poll interval. Nothing is happening; once every two minutes is plenty. */
const IDLE_POLL_MS = 120_000
/** A learned context window older than this is re-observed before it is trusted. */
const WINDOW_TTL_MS = 120_000
/** Floor on the active poll interval, so a bad setting cannot hammer the box. */
const MIN_POLL_MS = 1_000
const LIST_TIMEOUT_MS = 8_000
/** A cold JIT load of a 27B can take a while; this is not a hung request. */
const LOAD_TIMEOUT_MS = 600_000

interface WindowObservation {
  contextLength: number
  observedAt: number
}

/**
 * One entry per model id, primary first.
 *
 * An extra endpoint fronting the same server as the primary — a proxy on
 * another port, a tunnel — returns the same catalogue, and these lists used to
 * be concatenated. Observed live: 22 entries for 11 models, every one doubled,
 * the primary's copy marked `loaded` and the extra's copy marked as nothing at
 * all, because plain OpenAI /v1 reports no state. Picking the wrong twin asks
 * the server to load a model it has already loaded, which is how a turn died
 * with "Model loading was stopped due to insufficient system resources" against
 * a model that was resident at the time.
 *
 * The primary wins every collision: it speaks LM Studio's /api/v0 and is the
 * only one of the two that knows state, quantization and the real loaded
 * window. An extra contributes only models the primary has never heard of.
 */
/**
 * The window a single request actually gets.
 *
 * Two independent corrections to what a server advertises, and they compose.
 *
 * `slots` divides because llama.cpp's --parallel genuinely splits n_ctx between
 * concurrent slots and says so nowhere in either models API; a meter reading the
 * whole n_ctx was four times too generous.
 *
 * `cap` is a ceiling the operator sets because a server can advertise a window
 * the machine cannot hold — oMLX reports max_model_len 262144 for a 27B on a
 * 36 GiB box whose KV stops fitting somewhere around 50-70k. That number is the
 * architecture's limit, not this machine's. Believing it means trimming never
 * fires and the prompt grows until the server refuses it, which on an
 * unattended overnight run is discovered hours later.
 */
export function effectiveWindow(raw: number, slots: number, cap: number): number {
  const n = Math.max(1, Math.round(slots || 1))
  const perRequest = Math.floor(raw / n)
  const ceiling = Math.max(0, Math.round(cap || 0))
  return ceiling > 0 ? Math.min(perRequest, ceiling) : perRequest
}

export function mergeModelLists(primary: ModelInfo[], extra: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>()
  for (const model of primary) byId.set(model.id, model)
  for (const model of extra) if (!byId.has(model.id)) byId.set(model.id, model)
  return [...byId.values()]
}

export class ModelRegistry {
  private readonly opts: ModelRegistryOptions
  private models: ModelInfo[] = []
  private readonly refusedWindows = new Map<string, number>()
  private readonly windows = new Map<string, WindowObservation>()
  private resident: string | null = null
  private running = false
  private active = false
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<ModelInfo[]> | null = null
  private lastPollAt = 0
  private labStatus: LabStatus = 'unavailable'
  private healthState: ServerHealth

  constructor(opts: ModelRegistryOptions) {
    this.opts = opts
    this.healthState = {
      endpoint: opts.getSettings().baseUrl,
      reachable: false,
      latencyMs: null,
      residentModelId: null,
      labStatus: 'unavailable',
      lastCheckedAt: 0
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.refresh().finally(() => this.schedule())
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * ADDITION TO THE SPEC. The orchestrator marks request activity with this so
   * the poller can back off when nothing is happening. `true` polls at
   * `settings.modelPollMs`, `false` at 120s. Calling it is what keeps this from
   * becoming the 5,760-requests-a-day poller it replaced.
   */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    // Reschedule so a switch to active does not wait out the idle interval.
    if (this.running) this.schedule()
  }

  list(): ModelInfo[] {
    return this.models.slice()
  }

  async refresh(): Promise<ModelInfo[]> {
    if (this.inFlight !== null) return this.inFlight
    const run = this.poll().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /**
   * Models from any additional servers.
   *
   * Best effort and deliberately quiet: an extra endpoint being down must not
   * make the primary look unreachable, so a failure here logs and yields
   * nothing rather than throwing into the health state.
   *
   * These are plain OpenAI `/v1/models`, which reports id and nothing else —
   * no state, no context length, no capabilities. So the fields LM Studio fills
   * in stay at their unknown defaults rather than being invented, and the
   * context meter will show a dash for them until a turn reveals more.
   */
  private async pollExtras(settings: Settings): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const endpoint of settings.extraEndpoints) {
      try {
        const url = `${trimTrailingSlash(endpoint.baseUrl)}/models`
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (settings.apiKey.trim().length > 0) {
          headers.Authorization = `Bearer ${settings.apiKey.trim()}`
        }
        const res = await this.timedFetch(url, { headers }, LIST_TIMEOUT_MS)
        if (!res.ok) continue
        const payload: unknown = await res.json()
        /* Best effort, and optional. oMLX publishes /v1/models/status with a
           `loaded` flag per model; a backend without it simply reports unknown
           rather than being described as unloaded on no evidence. */
        const loadedIds = await this.pollExtraState(endpoint, headers)
        out.push(...parseModels(payload, endpoint, 'unknown', loadedIds))
      } catch (err) {
        this.opts.onLog?.(
          'warn',
          'models',
          `extra endpoint "${endpoint.label}" (${endpoint.baseUrl}) did not answer: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    return out
  }

  /**
   * Which of an extra endpoint's models are actually resident, when it says.
   *
   * Deliberately quiet: no such endpoint is part of the OpenAI surface, so a
   * 404 is the normal case and must not look like a fault.
   */
  private async pollExtraState(
    endpoint: LlmEndpoint,
    headers: Record<string, string>
  ): Promise<ReadonlySet<string> | null> {
    try {
      const url = `${trimTrailingSlash(endpoint.baseUrl)}/models/status`
      const res = await this.timedFetch(url, { headers }, LIST_TIMEOUT_MS)
      if (!res.ok) return null
      const body = asRecord(await res.json())
      const rows = body === null ? null : body.models
      if (!Array.isArray(rows)) return null
      const loaded = new Set<string>()
      for (const row of rows) {
        const rec = asRecord(row)
        const id = rec === null ? null : asString(rec.id)
        if (id !== null && rec?.loaded === true) loaded.add(id)
      }
      return loaded
    } catch {
      return null
    }
  }

  residentModelId(): string | null {
    return this.resident
  }

  /** The real window for a model, or null when it has never been observed loaded. */
  /**
   * The window a SINGLE request actually gets, not the one the server advertises.
   *
   * Divided by `contextSlots` because llama.cpp splits `n_ctx` across parallel
   * slots and says so nowhere in either models API. Every caller — the trim
   * budget and the context meter alike — wants the effective number, so the
   * division belongs here rather than at each call site.
   */
  /**
   * Remember that the server refused a prompt of this size, and stay under it.
   *
   * A window the model advertises is not a window the machine can prefill. oMLX
   * refuses with "Prefill context too large for available memory (preflight
   * safety guard, kv_len=42322)" — it states the number it choked on, and until
   * this existed the harness had no answer: the turn surfaced a 400 and ended,
   * and a person had to lower contextCap by hand and restart. That happened on a
   * live run and cost the rest of it.
   *
   * Clamped BELOW the refused size rather than at it, because the refusal is the
   * first size known to fail and the true limit is somewhere under it. Kept for
   * the session only: it is a fact about current memory pressure, not about the
   * model, and it should not outlive the conditions that produced it.
   */
  noteWindowRefusal(modelId: string, refusedTokens: number): number | null {
    if (modelId === '' || !Number.isFinite(refusedTokens) || refusedTokens <= 0) return null
    const target = Math.max(4096, Math.floor(refusedTokens * 0.85))
    const current = this.refusedWindows.get(modelId)
    if (current !== undefined && current <= target) return current
    this.refusedWindows.set(modelId, target)
    this.opts.onLog?.(
      'warn',
      'models',
      `${modelId} refused a ${refusedTokens}-token prompt; holding its window at ${target} for this session`
    )
    return target
  }

  contextWindow(modelId: string): number | null {
    const raw = this.windows.get(modelId)?.contextLength ?? null
    if (raw === null || raw <= 0) return raw
    const settings = this.opts.getSettings()
    const win = effectiveWindow(raw, settings.contextSlots, settings.contextCap)
    /* A size the server has actually refused outranks anything configured. */
    const refused = this.refusedWindows.get(modelId)
    return refused !== undefined ? Math.min(win, refused) : win
  }

  health(): ServerHealth {
    return { ...this.healthState }
  }

  /**
   * ADDITION TO THE SPEC. `ServerHealth` carries `labStatus` but the Lab feed is
   * a separate subsystem, so the orchestrator forwards its status here and the
   * registry stays the single source of the health object.
   */
  setLabStatus(status: LabStatus): void {
    if (this.labStatus === status) return
    this.labStatus = status
    this.emitHealth({ ...this.healthState, labStatus: status })
  }

  /**
   * Called by the chat path the first time a model is used, to learn its window.
   * Re-observes when the last observation is stale, because an idle eviction
   * followed by a JIT reload silently changes the real window.
   */
  async learn(modelId: string): Promise<void> {
    const seen = this.windows.get(modelId)
    if (seen !== undefined && Date.now() - seen.observedAt < WINDOW_TTL_MS) return
    await this.refresh()
  }

  /**
   * ADDITION TO THE SPEC (named in the prose of docs/INTERNAL_API.md, absent
   * from its code block). There is no documented load endpoint, so this issues a
   * 1-token chat completion and lets LM Studio JIT-load the model. Failure text
   * is returned verbatim — "Failed to load model" is the box being out of
   * memory, not a fault here.
   */
  async load(modelId: string): Promise<{ ok: boolean; error?: string }> {
    const settings = this.opts.getSettings()
    const url = `${trimTrailingSlash(settings.baseUrl)}/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`
    }

    try {
      const res = await this.timedFetch(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            temperature: 0,
            stream: false
          })
        },
        LOAD_TIMEOUT_MS
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const detail = body.trim().length > 0 ? body.trim() : `${res.status} ${res.statusText}`
        return { ok: false, error: detail }
      }
      // Drain so the connection is reusable, then re-observe the new window.
      await res.text().catch(() => '')
      await this.refresh()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: messageOf(err) }
    }
  }

  /* ---------------------------------------------------------------- */

  private pollInterval(): number {
    if (!this.active) return IDLE_POLL_MS
    const configured = this.opts.getSettings().modelPollMs
    if (!Number.isFinite(configured)) return IDLE_POLL_MS
    return Math.max(MIN_POLL_MS, configured)
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.running) return

    const delay = Math.max(0, this.pollInterval() - (Date.now() - this.lastPollAt))
    const timer = setTimeout(() => {
      this.timer = null
      void this.refresh().finally(() => this.schedule())
    }, delay)
    timer.unref()
    this.timer = timer
  }

  private async poll(): Promise<ModelInfo[]> {
    const settings = this.opts.getSettings()
    const url = `${trimTrailingSlash(settings.nativeApiUrl)}/api/v0/models`
    const startedAt = Date.now()
    this.lastPollAt = startedAt

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (settings.apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`
    }

    try {
      const res = await this.timedFetch(url, { headers }, LIST_TIMEOUT_MS)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const detail = body.trim().length > 0 ? body.trim() : '(empty response body)'
        throw new Error(`${res.status} ${res.statusText}: ${detail}`)
      }
      const payload: unknown = await res.json()
      // The primary endpoint keeps LM Studio's richer /api/v0 shape — state,
      // quantization, the real loaded window. Extras are plain OpenAI /v1.
      const models = parseModels(payload, {
        id: 'lmstudio',
        label: 'LM Studio',
        baseUrl: settings.baseUrl
      })
      const extra = await this.pollExtras(settings)
      const now = Date.now()

      this.models = mergeModelLists(models, extra)
      /*
       * Windows are recorded for EXTRAS too, not just the primary.
       *
       * This iterated `models` alone, so a model served by a second backend
       * never got a window — and an unknown window does not just blank the
       * meter, it switches history trimming off. The failure is invisible until
       * a long run's prompt has grown past what the server will accept.
       */
      for (const model of this.models) {
        if (model.loadedContextLength !== null) {
          this.windows.set(model.id, {
            contextLength: model.loadedContextLength,
            observedAt: now
          })
        }
      }
      /* Every endpoint, not just the primary. A model resident on a second
         backend is still the resident model, and reporting null while one was
         answering is what made the picker read "none loaded". */
      this.resident = this.models.find((m) => m.state === 'loaded')?.id ?? null

      this.emitHealth({
        endpoint: settings.baseUrl,
        reachable: true,
        latencyMs: now - startedAt,
        residentModelId: this.resident,
        labStatus: this.labStatus,
        lastCheckedAt: now
      })
      this.opts.onModels(this.models)
      return this.models
    } catch (err) {
      // Keep the last known model list — it is still the best thing to show —
      // but stop claiming anything is resident on a box we cannot reach.
      this.resident = null
      this.emitHealth({
        endpoint: settings.baseUrl,
        reachable: false,
        latencyMs: null,
        residentModelId: null,
        labStatus: this.labStatus,
        lastCheckedAt: Date.now(),
        error: messageOf(err)
      })
      return this.models
    }
  }

  private async timedFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref()
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private emitHealth(next: ServerHealth): void {
    this.healthState = next
    this.opts.onHealth({ ...next })
  }
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param unknownState what to record when the payload carries no `state` field.
 *   LM Studio's /api/v0 always reports one. A plain OpenAI /v1 never does, and
 *   defaulting those to 'not-loaded' asserted something we had not been told —
 *   which is why every model on a second backend rendered with a dead grey dot
 *   and the picker said "none loaded" while one of them was resident and
 *   answering.
 * @param loadedIds ids a companion status endpoint says are resident, when the
 *   backend offers one.
 */
export function parseModels(
  payload: unknown,
  endpoint: LlmEndpoint,
  unknownState: string = 'not-loaded',
  loadedIds: ReadonlySet<string> | null = null
): ModelInfo[] {
  const root = asRecord(payload)
  if (root === null) return []
  const data = root.data
  if (!Array.isArray(data)) return []

  const models: ModelInfo[] = []
  for (const entry of data) {
    const rec = asRecord(entry)
    if (rec === null) continue
    const id = asString(rec.id)
    if (id === null) continue

    const type = asString(rec.type) ?? 'llm'
    const capabilities = asStringArray(rec.capabilities)

    models.push({
      id,
      endpointId: endpoint.id,
      endpointLabel: endpoint.label,
      baseUrl: endpoint.baseUrl,
      publisher: asString(rec.publisher) ?? '',
      type,
      arch: asString(rec.arch) ?? '',
      quantization: asString(rec.quantization) ?? '',
      compatibilityType: asString(rec.compatibility_type) ?? '',
      /*
       * `max_model_len` is oMLX's spelling of the same fact.
       *
       * A second backend on this box serves plain OpenAI /v1 and reports its
       * window under that name. Without reading it the window is unknown, and
       * an unknown window does not merely blank the meter — it switches history
       * trimming OFF, which on a long agentic run means the prompt grows until
       * the server refuses it.
       */
      maxContextLength: asNumber(rec.max_context_length) ?? asNumber(rec.max_model_len) ?? 0,
      // Present only while resident. Absent means unknown, never max_context_length.
      // A server that advertises `max_model_len` is stating what it will serve
      // right now, so that counts as observed rather than aspirational.
      loadedContextLength: asNumber(rec.loaded_context_length) ?? asNumber(rec.max_model_len),
      state:
        asString(rec.state) ??
        (loadedIds !== null ? (loadedIds.has(id) ? 'loaded' : 'not-loaded') : unknownState),
      capabilities,
      supportsVision: type === 'vlm',
      supportsTools: capabilities.includes('tool_use')
    })
  }
  return models
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'Request timed out'
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
