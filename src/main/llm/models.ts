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

export class ModelRegistry {
  private readonly opts: ModelRegistryOptions
  private models: ModelInfo[] = []
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
        out.push(...parseModels(await res.json(), endpoint))
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
  contextWindow(modelId: string): number | null {
    const raw = this.windows.get(modelId)?.contextLength ?? null
    if (raw === null || raw <= 0) return raw
    const slots = Math.max(1, Math.round(this.opts.getSettings().contextSlots || 1))
    return Math.floor(raw / slots)
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

      this.models = [...models, ...extra]
      for (const model of models) {
        if (model.loadedContextLength !== null) {
          this.windows.set(model.id, {
            contextLength: model.loadedContextLength,
            observedAt: now
          })
        }
      }
      this.resident = models.find((m) => m.state === 'loaded')?.id ?? null

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

function parseModels(payload: unknown, endpoint: LlmEndpoint): ModelInfo[] {
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
      maxContextLength: asNumber(rec.max_context_length) ?? 0,
      // Present only while resident. Absent means unknown, never max_context_length.
      loadedContextLength: asNumber(rec.loaded_context_length),
      state: asString(rec.state) ?? 'not-loaded',
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
