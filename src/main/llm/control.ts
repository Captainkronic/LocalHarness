/**
 * Remote model control over LM Studio's websocket API.
 *
 * LM Studio's REST surfaces (`/api/v0`, `/api/v1`) are read-only — there is no
 * load or unload over HTTP. Everything that changes what is resident goes over
 * `ws://<host>:1235/llm`, and that must be LM Studio's own port addressed
 * DIRECTLY: the relay on :1234 is a Python BaseHTTP server, which answers 200 to
 * a websocket upgrade instead of 101 and can never carry this protocol.
 *
 * Protocol, as verified against the Mac Studio:
 *
 *  - On open, send `{authVersion, clientIdentifier, clientPasskey}` and wait for
 *    `{success:true}`. Nothing else may be sent before that reply.
 *  - RPC is `{type:'rpcCall', endpoint, callId, parameter?}` answered by
 *    `{type:'rpcResult', callId, result}`. `listLoaded` takes NO parameter at
 *    all — sending `parameter:{}` is rejected with "Expected undefined,
 *    received object", so the key must be absent rather than empty.
 *  - Loading is a channel, not an RPC: `channelCreate` opens it, the server
 *    streams `channelSend` frames, and it ends with `channelClose` or
 *    `channelError`.
 *  - `communicationWarning` frames carry a validation message and no callId, so
 *    they cannot be correlated to a call — they are logged, and attached to an
 *    in-flight load whose failure they most likely explain.
 *
 * The whole feature is optional. If the socket cannot be reached the screen
 * degrades to a read-only view built from the REST catalog, and nothing else in
 * the app is affected.
 */

import type {
  CatalogModel,
  ConfigField,
  ControlState,
  ControlStatus,
  LoadOptions,
  LoadProgress,
  LoadedInstance,
  Settings
} from '@shared/types'

export type ControlLogFn = (
  level: 'info' | 'warn' | 'error',
  scope: string,
  message: string
) => void

export interface LmStudioControlOptions {
  getSettings: () => Settings
  onState: (state: ControlState) => void
  onProgress: (progress: LoadProgress) => void
  onLog: ControlLogFn
}

const LOG_SCOPE = 'control'
/** LM Studio's own port. The :1234 relay cannot carry a websocket upgrade. */
const CONTROL_PORT = 1235

const BACKOFF_START_MS = 1_000
const BACKOFF_CAP_MS = 60_000
/** After this many consecutive failures the feature reports itself unavailable. */
const UNAVAILABLE_AFTER_FAILURES = 3
const HANDSHAKE_TIMEOUT_MS = 8_000
const RPC_TIMEOUT_MS = 20_000
const CATALOG_TIMEOUT_MS = 8_000
/** Resident-set poll floor. This project has a history of hammering the box. */
const LOADED_POLL_MS = 30_000
/** How long a user-initiated action waits for a socket before giving up. */
const CONNECT_WAIT_MS = 6_000
/** A cold 27B off disk is minutes. This is a stuck-channel guard, not a budget. */
const LOAD_TIMEOUT_MS = 900_000
/** How long cancelLoad() waits for the server to close the channel. */
const CANCEL_GRACE_MS = 5_000

const WS_OPEN = 1

/**
 * Config keys whose value is an object rather than a scalar. Verified: sending
 * `{"key":"llm.load.llama.kCacheQuantizationType","value":"q8_0"}` fails with
 * "Expected object, received string". These wrap as `{checked, value}`.
 */
const OBJECT_VALUED_KEYS = new Set([
  'llm.load.llama.kCacheQuantizationType',
  'llm.load.llama.vCacheQuantizationType',
  'llm.load.llama.acceleration.offloadRatio'
])

interface PendingRpc {
  endpoint: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ChannelHandler {
  onMessage: (message: Record<string, unknown>) => void
  onError: (message: string) => void
  onClose: () => void
}

interface PendingLoad {
  modelKey: string
  channelId: number
  settled: boolean
  settle: (result: { ok: boolean; error?: string }) => void
  /** Text of a communicationWarning seen while this load was in flight. */
  warning: string | null
  timer: NodeJS.Timeout
  onSettled: (() => void) | null
}

export class LmStudioControl {
  private readonly opts: LmStudioControlOptions

  private socket: WebSocket | null = null
  private authed = false
  private running = false
  /** Polling only runs while the app is active; see setActive(). */
  private active = true

  private status: ControlStatus = 'disconnected'
  private url: string
  private loaded: LoadedInstance[] = []
  private catalog: CatalogModel[] = []
  private inFlight: LoadProgress | null = null
  /** Why the socket is not up. Kept apart from dataError so a refresh that
   *  succeeds over REST cannot erase the reason model control is down. */
  private connectionError: string | undefined
  /** Why the last data fetch failed, if it did. */
  private dataError: string | undefined
  private lastRefreshedAt = 0

  private callId = 0
  private channelSeq = 0
  private readonly pending = new Map<number, PendingRpc>()
  private readonly channels = new Map<number, ChannelHandler>()
  private pendingLoad: PendingLoad | null = null
  /** Held across load()'s connect await, so two calls cannot both get through
   *  the in-flight guard before either has registered its channel. */
  private loadStarting = false

  private retryTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private backoffMs = BACKOFF_START_MS
  private failures = 0
  /** One log line per outage, not one per retry. */
  private outageLogged = false
  private refreshInFlight: Promise<ControlState> | null = null
  private connectionWaiters: Array<(ok: boolean) => void> = []
  /** The `error` event fires before `close` and carries the only real reason. */
  private lastSocketError: string | null = null

  constructor(opts: LmStudioControlOptions) {
    this.opts = opts
    this.url = this.controlUrl() ?? ''
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.backoffMs = BACKOFF_START_MS
    this.failures = 0
    this.outageLogged = false
    this.connect()
    this.schedulePoll()
  }

  stop(): void {
    this.running = false
    this.clearTimer('retryTimer')
    this.clearTimer('pollTimer')
    this.teardownSocket('control stopped')
    this.setStatus('disconnected')
  }

  /**
   * ADDITION TO THE SPEC, mirroring ModelRegistry.setActive. The resident-set
   * poll runs only while the app is active; an unfocused window has no reason to
   * keep asking the Studio what is loaded.
   */
  setActive(active: boolean): void {
    this.active = active
  }

  state(): ControlState {
    return this.snapshot()
  }

  async refresh(): Promise<ControlState> {
    if (this.refreshInFlight !== null) return this.refreshInFlight
    const run = this.doRefresh().finally(() => {
      this.refreshInFlight = null
    })
    this.refreshInFlight = run
    return run
  }

  /**
   * Opens a `loadModel` channel and reports progress until it settles.
   *
   * Options the caller did not set are omitted entirely rather than filled with
   * a default — "unset" and "the value that happens to be the default" are
   * different requests, and only the first lets the server decide.
   */
  async load(modelKey: string, options: LoadOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.pendingLoad !== null || this.loadStarting) {
      const busy = this.pendingLoad?.modelKey ?? 'another model'
      return {
        ok: false,
        error: `A load is already in flight (${busy}). Cancel it before starting another.`
      }
    }
    this.loadStarting = true

    const ready = await this.waitForConnection()
    if (!ready) {
      this.loadStarting = false
      return { ok: false, error: this.notConnectedMessage() }
    }

    const fields = buildLoadFields(options)

    // A quantized V cache will not load without flash attention. Say so rather
    // than switching it on behind the user's back — the request is theirs.
    if (
      options.vCacheQuantization !== undefined &&
      options.vCacheQuantization !== 'f16' &&
      options.flashAttention !== true
    ) {
      this.opts.onLog(
        'warn',
        LOG_SCOPE,
        `${modelKey}: a quantized V cache (${options.vCacheQuantization}) requires flash attention; the server will likely refuse this load`
      )
    }

    const channelId = ++this.channelSeq
    const creationParameter: Record<string, unknown> = {
      modelKey,
      loadConfigStack: {
        // `apiOverride` is the layer a client is allowed to write. The rest of
        // the enum belongs to the app's own UI, presets and defaults.
        layers: [{ layerName: 'apiOverride', config: { fields } }]
      }
    }
    // TTL rides on the creation parameter, not the config stack (this is where
    // lmstudio-js puts it). Only sent when the caller actually asked for one.
    if (options.ttlMs !== undefined) creationParameter.ttlMs = options.ttlMs

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const pending: PendingLoad = {
        modelKey,
        channelId,
        settled: false,
        warning: null,
        onSettled: null,
        timer: setTimeout(() => {
          pending.settle({
            ok: false,
            error: `Load timed out after ${Math.round(LOAD_TIMEOUT_MS / 60_000)} minutes with no result from the server`
          })
        }, LOAD_TIMEOUT_MS),
        settle: (result) => {
          if (pending.settled) return
          pending.settled = true
          clearTimeout(pending.timer)
          this.channels.delete(channelId)
          if (this.pendingLoad === pending) this.pendingLoad = null

          this.emitProgress({
            modelKey,
            progress: result.ok ? 1 : 0,
            phase: result.ok ? 'done' : 'error',
            message: result.error
          })

          if (result.ok) {
            this.opts.onLog('info', LOG_SCOPE, `loaded ${modelKey}`)
            // Requirement: the resident set must never be stale after a load.
            void this.refresh()
          } else {
            this.opts.onLog('error', LOG_SCOPE, `load failed for ${modelKey}: ${result.error ?? ''}`)
          }

          pending.onSettled?.()
          resolve(result)
        }
      }
      pending.timer.unref()
      this.pendingLoad = pending
      this.loadStarting = false

      this.channels.set(channelId, {
        onMessage: (message) => this.handleLoadMessage(pending, message),
        onError: (text) => pending.settle({ ok: false, error: this.loadErrorText(pending, text) }),
        onClose: () => this.handleLoadChannelClose(pending)
      })

      const sent = this.sendJson({
        type: 'channelCreate',
        endpoint: 'loadModel',
        channelId,
        creationParameter
      })
      if (!sent) {
        pending.settle({ ok: false, error: this.notConnectedMessage() })
        return
      }

      this.emitProgress({ modelKey, progress: 0, phase: 'resolving' })
    })
  }

  async unload(identifier: string): Promise<{ ok: boolean; error?: string }> {
    const ready = await this.waitForConnection()
    if (!ready) return { ok: false, error: this.notConnectedMessage() }

    try {
      await this.rpc('unloadModel', { identifier })
      this.opts.onLog('info', LOG_SCOPE, `unloaded ${identifier}`)
      await this.refresh()
      return { ok: true }
    } catch (err) {
      // Verbatim: an unload that fails says something real about the server.
      return { ok: false, error: messageOf(err) }
    }
  }

  async cancelLoad(): Promise<void> {
    const pending = this.pendingLoad
    if (pending === null) return

    this.sendJson({
      type: 'channelSend',
      channelId: pending.channelId,
      message: { type: 'cancel' }
    })

    // The server normally answers with channelClose. If it does not, stop
    // waiting so the UI is not pinned to a load that will never report.
    await new Promise<void>((resolve) => {
      if (pending.settled) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        pending.settle({ ok: false, error: 'Load cancelled' })
        resolve()
      }, CANCEL_GRACE_MS)
      timer.unref()
      pending.onSettled = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  async getConfig(identifier: string): Promise<ConfigField[]> {
    const ready = await this.waitForConnection()
    if (!ready) throw new Error(this.notConnectedMessage())

    const result = await this.rpc('getLoadConfig', {
      specifier: { type: 'query', query: { identifier } }
    })
    const fields = asRecord(result)?.fields
    if (!Array.isArray(fields)) return []

    const out: ConfigField[] = []
    for (const entry of fields) {
      const rec = asRecord(entry)
      const key = rec === null ? null : asString(rec.key)
      if (rec === null || key === null) continue
      out.push({ key, value: rec.value })
    }
    return out
  }

  /* ---------------------------------------------------------------- */
  /* connection                                                        */
  /* ---------------------------------------------------------------- */

  private connect(): void {
    if (!this.running || this.socket !== null) return

    const url = this.controlUrl()
    if (url === null) {
      // An unparseable endpoint is a RECOVERABLE failure — the user can fix the
      // setting. Returning bare here abandoned the retry chain for the process
      // lifetime, so `nativeApiUrl` typed without a scheme killed model control
      // until restart even after it was corrected. Route it through the normal
      // backoff path so a later tick picks up the fixed value.
      this.onConnectionLost(
        `Cannot derive a control URL from "${this.opts.getSettings().nativeApiUrl}"`
      )
      return
    }
    this.url = url
    this.setStatus('connecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      this.onConnectionLost(messageOf(err))
      return
    }
    this.socket = socket
    this.authed = false
    this.lastSocketError = null

    const handshakeTimer = setTimeout(() => {
      if (this.socket !== socket || this.authed) return
      this.teardownSocket('handshake timed out')
      this.onConnectionLost('handshake timed out')
    }, HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref()
    this.handshakeTimer = handshakeTimer

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      // The passkey is not validated by a local server, but the field is
      // required and the frame must be the first thing on the wire.
      this.sendJson({
        authVersion: 1,
        clientIdentifier: 'LocalHarness',
        clientPasskey: 'LocalHarness'
      })
    })

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      this.handleFrame((event as unknown as { data: unknown }).data)
    })

    socket.addEventListener('error', (event) => {
      if (this.socket !== socket) return
      // A refused connection often arrives with an empty `message`; the useful
      // text is then on the nested cause, and sometimes nowhere at all.
      const rec = event as unknown as Record<string, unknown>
      const cause = rec.error
      this.lastSocketError =
        nonEmpty(asString(rec.message)) ??
        (cause instanceof Error ? nonEmpty(messageOf(cause)) : null)
    })

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      const closeEvent = event as unknown as { code?: number; reason?: string }
      const reason =
        this.lastSocketError ??
        nonEmpty(closeEvent.reason ?? null) ??
        `socket closed (code ${closeEvent.code ?? 0})`
      this.teardownSocket(reason)
      this.onConnectionLost(reason)
    })
  }

  private onAuthenticated(): void {
    this.authed = true
    this.clearTimer('handshakeTimer')
    this.failures = 0
    this.backoffMs = BACKOFF_START_MS
    this.outageLogged = false
    this.setStatus('connected')
    this.opts.onLog('info', LOG_SCOPE, `connected to ${this.url}`)
    this.notifyWaiters(true)
    void this.refresh()
  }

  private onConnectionLost(reason: string): void {
    this.notifyWaiters(false)
    if (!this.running) return

    this.failures += 1
    if (this.failures >= UNAVAILABLE_AFTER_FAILURES) {
      this.setStatus('unavailable', reason)
    } else {
      this.setStatus('disconnected', reason)
    }

    if (!this.outageLogged) {
      this.outageLogged = true
      // Once per outage. The Studio being off is normal, not a log storm.
      this.opts.onLog(
        'warn',
        LOG_SCOPE,
        `model control unavailable at ${this.url} (${reason}); retrying in the background`
      )
    }

    const delay = this.backoffMs
    this.backoffMs = Math.min(BACKOFF_CAP_MS, this.backoffMs * 2)
    this.clearTimer('retryTimer')
    const timer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
    timer.unref()
    this.retryTimer = timer
  }

  /** Drops the socket and fails everything that was riding on it. */
  private teardownSocket(reason: string): void {
    this.clearTimer('handshakeTimer')

    const socket = this.socket
    this.socket = null
    this.authed = false
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // Already closing or closed; nothing to do.
      }
    }

    for (const [callId, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`${entry.endpoint} failed: ${reason}`))
      this.pending.delete(callId)
    }

    const channels = [...this.channels.values()]
    this.channels.clear()
    for (const handler of channels) handler.onError(reason)
  }

  private async waitForConnection(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    if (this.canRpc()) return true
    if (!this.running) return false

    // A user pressing Load is a better reason to connect than the backoff
    // timer's schedule, so jump the queue. connect() reschedules its own retry
    // on failure, so clearing the timer first cannot strand the loop — but only
    // clear it when we are actually about to replace it.
    if (this.socket === null) {
      this.clearTimer('retryTimer')
      this.connect()
    }
    if (this.socket === null) return false

    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.connectionWaiters = this.connectionWaiters.filter((w) => w !== waiter)
        resolve(ok)
      }
      const waiter = (ok: boolean): void => finish(ok)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
      this.connectionWaiters.push(waiter)
    })
  }

  private notifyWaiters(ok: boolean): void {
    if (this.connectionWaiters.length === 0) return
    const waiters = this.connectionWaiters
    this.connectionWaiters = []
    for (const waiter of waiters) waiter(ok)
  }

  private canRpc(): boolean {
    return this.socket !== null && this.authed && this.socket.readyState === WS_OPEN
  }

  private notConnectedMessage(): string {
    return `Model control is not connected (${this.url || 'no control URL'}). LM Studio's websocket API must be reachable on port ${CONTROL_PORT}.`
  }

  /* ---------------------------------------------------------------- */
  /* framing                                                           */
  /* ---------------------------------------------------------------- */

  private handleFrame(data: unknown): void {
    // LM Studio speaks text frames; anything else is not ours to parse.
    if (typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const frame = asRecord(parsed)
    if (frame === null) return

    if (!this.authed) {
      if (frame.success === true) {
        this.onAuthenticated()
      } else if (frame.success === false || frame.error !== undefined) {
        const reason = extractErrorText(frame) || 'handshake rejected'
        this.teardownSocket(reason)
        this.onConnectionLost(reason)
      }
      // Anything else before the auth reply is ignored; the handshake timer is
      // the backstop for a server that never answers.
      return
    }

    switch (asString(frame.type)) {
      case 'rpcResult':
        this.resolveRpc(frame)
        return
      case 'rpcError':
      case 'rpcFailure':
        this.rejectRpc(frame)
        return
      case 'channelSend': {
        const handler = this.channelFor(frame)
        const message = asRecord(frame.message)
        if (handler !== null && message !== null) handler.onMessage(message)
        return
      }
      case 'channelError': {
        const handler = this.channelFor(frame)
        const text = extractErrorText(frame) || 'the server reported a channel error'
        if (handler !== null) handler.onError(text)
        else this.opts.onLog('error', LOG_SCOPE, text)
        return
      }
      case 'channelClose': {
        const channelId = asNumber(frame.channelId)
        if (channelId === null) return
        const handler = this.channels.get(channelId)
        this.channels.delete(channelId)
        handler?.onClose()
        return
      }
      case 'communicationWarning': {
        // No callId, so this cannot be correlated. Surface it, and hand it to an
        // in-flight load, whose failure it most likely explains.
        const text = asString(frame.warning) ?? (extractErrorText(frame) || 'unspecified')
        const kind = asString(frame.kind)
        this.opts.onLog('warn', LOG_SCOPE, `server warning${kind === null ? '' : ` (${kind})`}: ${text}`)
        if (this.pendingLoad !== null) this.pendingLoad.warning = text
        return
      }
      default:
        // Keepalives and frames for endpoints this client does not use.
        return
    }
  }

  /**
   * channelError frames have been seen without a channelId. When only one
   * channel can be open — a load — attributing it there is better than dropping
   * the only explanation the server gave.
   */
  private channelFor(frame: Record<string, unknown>): ChannelHandler | null {
    const channelId = asNumber(frame.channelId)
    if (channelId !== null) return this.channels.get(channelId) ?? null
    if (this.pendingLoad !== null) return this.channels.get(this.pendingLoad.channelId) ?? null
    return null
  }

  private resolveRpc(frame: Record<string, unknown>): void {
    const callId = asNumber(frame.callId)
    if (callId === null) return
    const entry = this.pending.get(callId)
    if (entry === undefined) return
    this.pending.delete(callId)
    clearTimeout(entry.timer)
    entry.resolve(frame.result)
  }

  private rejectRpc(frame: Record<string, unknown>): void {
    const callId = asNumber(frame.callId)
    const text = extractErrorText(frame) || 'the server rejected the call'
    if (callId === null) {
      this.opts.onLog('error', LOG_SCOPE, text)
      return
    }
    const entry = this.pending.get(callId)
    if (entry === undefined) return
    this.pending.delete(callId)
    clearTimeout(entry.timer)
    entry.reject(new Error(text))
  }

  private rpc(endpoint: string, parameter?: unknown): Promise<unknown> {
    if (!this.canRpc()) return Promise.reject(new Error(this.notConnectedMessage()))

    const callId = ++this.callId
    const frame: Record<string, unknown> = { type: 'rpcCall', endpoint, callId }
    // The key must be ABSENT for parameterless endpoints. `parameter:{}` on
    // listLoaded fails with "Expected undefined, received object".
    if (parameter !== undefined) frame.parameter = parameter

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`${endpoint} timed out after ${RPC_TIMEOUT_MS}ms`))
      }, RPC_TIMEOUT_MS)
      timer.unref()
      this.pending.set(callId, { endpoint, resolve, reject, timer })

      if (!this.sendJson(frame)) {
        this.pending.delete(callId)
        clearTimeout(timer)
        reject(new Error(this.notConnectedMessage()))
      }
    })
  }

  private sendJson(payload: unknown): boolean {
    const socket = this.socket
    if (socket === null || socket.readyState !== WS_OPEN) return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (err) {
      this.opts.onLog('error', LOG_SCOPE, `send failed: ${messageOf(err)}`)
      return false
    }
  }

  /* ---------------------------------------------------------------- */
  /* load channel                                                      */
  /* ---------------------------------------------------------------- */

  private handleLoadMessage(pending: PendingLoad, message: Record<string, unknown>): void {
    if (pending.settled) return
    const type = asString(message.type)

    if (type === 'resolved') {
      this.emitProgress({ modelKey: pending.modelKey, progress: 0, phase: 'loading' })
      return
    }
    if (type === 'success' || type === 'loadSuccess' || type === 'loaded') {
      pending.settle({ ok: true })
      return
    }
    if (type === 'error' || type === 'loadError' || type === 'failure') {
      const text = extractErrorText(message) || 'the server reported a load failure'
      pending.settle({ ok: false, error: this.loadErrorText(pending, text) })
      return
    }

    // The progress message's exact name is not something to depend on: any frame
    // carrying a numeric `progress` is progress.
    const progress = asNumber(message.progress)
    if (progress !== null) {
      this.emitProgress({
        modelKey: pending.modelKey,
        progress: clamp01(progress),
        phase: 'loading',
        message: asString(message.message) ?? undefined
      })
    }
  }

  /**
   * A channel that closes without an explicit outcome is ambiguous. Ask the
   * server what is resident rather than guessing which way it went.
   */
  private handleLoadChannelClose(pending: PendingLoad): void {
    if (pending.settled) return
    const fallback = 'the load channel closed before reporting a result'

    void this.listLoaded()
      .then((instances) => {
        const resident = instances.some((instance) => instance.modelKey === pending.modelKey)
        if (resident) pending.settle({ ok: true })
        else pending.settle({ ok: false, error: this.loadErrorText(pending, fallback) })
      })
      .catch(() => {
        pending.settle({ ok: false, error: this.loadErrorText(pending, fallback) })
      })
  }

  /**
   * The server's own words, with any validation warning seen during the load
   * appended. An "insufficient system resources" message is the box being full —
   * rewording it would hide that.
   */
  private loadErrorText(pending: PendingLoad, base: string): string {
    const text = base.trim()
    if (pending.warning === null) return text.length > 0 ? text : 'load failed'
    if (text.length === 0) return pending.warning
    return `${text} (server warning: ${pending.warning})`
  }

  private emitProgress(progress: LoadProgress): void {
    const terminal = progress.phase === 'done' || progress.phase === 'error'
    this.inFlight = terminal ? null : progress
    this.opts.onProgress(progress)
    this.emitState()
  }

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  private async doRefresh(): Promise<ControlState> {
    // A settings edit can move the box; do not keep talking to the old one.
    this.reconnectIfUrlChanged()

    // An explicit refresh is a user asking us to try again, so it must be able
    // to re-establish the socket. Without this the Refresh button was inert
    // exactly when it mattered — the screen even tells the user to press it
    // after correcting the address.
    if (this.running && this.socket === null) {
      this.backoffMs = BACKOFF_START_MS
      this.failures = 0
      this.clearTimer('retryTimer')
      this.connect()
    }

    const [loadedResult, catalogResult] = await Promise.allSettled([
      this.canRpc() ? this.listLoaded() : Promise.reject(new Error('not connected')),
      this.fetchCatalog()
    ])

    const errors: string[] = []

    let restLoaded: LoadedInstance[] | null = null
    if (catalogResult.status === 'fulfilled') {
      this.catalog = catalogResult.value.models
      restLoaded = catalogResult.value.loaded
    } else {
      errors.push(`catalog: ${messageOf(catalogResult.reason)}`)
    }

    if (loadedResult.status === 'fulfilled') {
      // The socket is authoritative when it answered.
      this.applyLoaded(loadedResult.value)
    } else if (restLoaded !== null) {
      // No socket, but the REST catalog reports resident instances too, so the
      // screen stays honest (and read-only useful) without model control.
      this.applyLoaded(restLoaded)
    } else if (this.canRpc()) {
      errors.push(`listLoaded: ${messageOf(loadedResult.reason)}`)
    }

    if (errors.length > 0) {
      this.dataError = errors.join('; ')
    } else {
      this.dataError = undefined
      this.lastRefreshedAt = Date.now()
    }

    this.emitState()
    return this.snapshot()
  }

  private async listLoaded(): Promise<LoadedInstance[]> {
    // No parameter — see the note on rpc().
    const result = await this.rpc('listLoaded')
    return parseLoadedList(result)
  }

  /** Stores the resident set and re-derives every catalog entry's identifiers. */
  private applyLoaded(loaded: LoadedInstance[]): void {
    this.loaded = loaded
    this.catalog = this.catalog.map((model) => ({
      ...model,
      loadedIdentifiers: loaded
        .filter((instance) => instance.modelKey === model.modelKey)
        .map((instance) => instance.identifier)
    }))
  }

  private schedulePoll(): void {
    this.clearTimer('pollTimer')
    if (!this.running) return
    const timer = setTimeout(() => {
      this.pollTimer = null
      void this.pollLoaded().finally(() => this.schedulePoll())
    }, LOADED_POLL_MS)
    timer.unref()
    this.pollTimer = timer
  }

  /**
   * The periodic tick asks only for the resident set — one cheap websocket call.
   * The catalog (which models exist on disk) changes rarely and is refetched on
   * connect, on an explicit refresh, and after a load or unload, so this does not
   * add an HTTP poll on a box with a history of being hammered by them.
   */
  private async pollLoaded(): Promise<void> {
    if (!this.running || !this.active) return
    // A load streams its own progress and refreshes when it lands.
    if (this.pendingLoad !== null) return
    if (this.reconnectIfUrlChanged()) return
    if (!this.canRpc()) return

    try {
      this.applyLoaded(await this.listLoaded())
      this.lastRefreshedAt = Date.now()
      this.dataError = undefined
      this.emitState()
    } catch (err) {
      this.opts.onLog('warn', LOG_SCOPE, `resident-set poll failed: ${messageOf(err)}`)
    }
  }

  private reconnectIfUrlChanged(): boolean {
    const next = this.controlUrl()
    if (next === null || next === this.url) return false
    this.opts.onLog('info', LOG_SCOPE, `control URL changed to ${next}; reconnecting`)
    this.url = next
    if (this.socket === null) {
      // Previously this returned false having ALREADY overwritten this.url, so
      // the corrected address was swallowed: the next comparison matched and no
      // reconnect was ever attempted. Take the corrected URL and try it now.
      this.backoffMs = BACKOFF_START_MS
      this.failures = 0
      this.clearTimer('retryTimer')
      this.connect()
      return true
    }
    this.teardownSocket('control URL changed')
    this.backoffMs = BACKOFF_START_MS
    this.failures = 0
    this.connect()
    return true
  }

  private setStatus(status: ControlStatus, error?: string): void {
    const nextError = status === 'connected' ? undefined : error
    if (this.status === status && this.connectionError === nextError) return
    this.status = status
    this.connectionError = nextError
    this.emitState()
  }

  private emitState(): void {
    this.opts.onState(this.snapshot())
  }

  private snapshot(): ControlState {
    return {
      status: this.status,
      url: this.url,
      loaded: this.loaded.map((instance) => ({ ...instance })),
      catalog: this.catalog.map((model) => ({
        ...model,
        variants: model.variants.slice(),
        loadedIdentifiers: model.loadedIdentifiers.slice()
      })),
      inFlight: this.inFlight === null ? null : { ...this.inFlight },
      // The socket being down is the more important of the two.
      error: this.connectionError ?? this.dataError,
      lastRefreshedAt: this.lastRefreshedAt
    }
  }

  private clearTimer(name: 'retryTimer' | 'pollTimer' | 'handshakeTimer'): void {
    const timer = this[name]
    if (timer === null) return
    clearTimeout(timer)
    this[name] = null
  }

  /* ---------------------------------------------------------------- */
  /* catalog (plain HTTP — the socket does not serve the model list)   */
  /* ---------------------------------------------------------------- */

  private async fetchCatalog(): Promise<{ models: CatalogModel[]; loaded: LoadedInstance[] }> {
    const settings = this.opts.getSettings()
    const root = trimTrailingSlash(settings.nativeApiUrl)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (settings.apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`
    }

    const v1 = await timedFetch(`${root}/api/v1/models`, headers, CATALOG_TIMEOUT_MS)
    if (v1.ok) return parseV1Catalog(await v1.json())

    // Older servers have no /api/v1. Fall back and fill in what v0 carries.
    if (v1.status === 404 || v1.status === 501) {
      const v0 = await timedFetch(`${root}/api/v0/models`, headers, CATALOG_TIMEOUT_MS)
      if (!v0.ok) throw new Error(await describeHttpError(v0))
      return parseV0Catalog(await v0.json())
    }

    throw new Error(await describeHttpError(v1))
  }

  /**
   * Settings carries no `controlUrl` field today, so the URL is derived from
   * `nativeApiUrl`'s host with the port forced to LM Studio's own. The override
   * is read defensively so it starts working the moment the shared type grows
   * one, without this module reaching into the contract.
   */
  private controlUrl(): string | null {
    const settings = this.opts.getSettings()
    const override = asString((settings as unknown as Record<string, unknown>).controlUrl)
    if (override !== null && override.trim().length > 0) {
      const normalised = normaliseWsUrl(override.trim())
      if (normalised !== null) return normalised
    }

    try {
      const parsed = new URL(settings.nativeApiUrl)
      const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${scheme}//${bracketHost(parsed.hostname)}:${CONTROL_PORT}/llm`
    } catch {
      return null
    }
  }
}

/* ------------------------------------------------------------------ */
/* load config                                                         */
/* ------------------------------------------------------------------ */

function buildLoadFields(options: LoadOptions): ConfigField[] {
  const fields: ConfigField[] = []
  const put = (key: string, value: unknown): void => {
    fields.push({
      key,
      value: OBJECT_VALUED_KEYS.has(key) ? { checked: true, value } : value
    })
  }

  if (options.contextLength !== undefined) put('llm.load.contextLength', options.contextLength)
  if (options.flashAttention !== undefined) {
    put('llm.load.llama.flashAttention', options.flashAttention)
  }
  if (options.kCacheQuantization !== undefined) {
    put('llm.load.llama.kCacheQuantizationType', options.kCacheQuantization)
  }
  if (options.vCacheQuantization !== undefined) {
    put('llm.load.llama.vCacheQuantizationType', options.vCacheQuantization)
  }
  if (options.cpuThreadPoolSize !== undefined) {
    put('llm.load.llama.cpuThreadPoolSize', options.cpuThreadPoolSize)
  }
  if (options.gpuOffloadRatio !== undefined) {
    put('llm.load.llama.acceleration.offloadRatio', options.gpuOffloadRatio)
  }
  if (options.autoFit !== undefined) {
    // autoFit is per engine and a live gguf model reports both keys, so set both
    // and let the engine that is not loading ignore its own.
    put('llm.load.llama.autoFit', options.autoFit)
    put('llm.load.mlx.autoFit', options.autoFit)
  }

  return fields
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/** `listLoaded` answers with a bare array of instances. */
function parseLoadedList(result: unknown): LoadedInstance[] {
  const entries = Array.isArray(result) ? result : asRecord(result)?.instances
  if (!Array.isArray(entries)) return []

  const out: LoadedInstance[] = []
  for (const entry of entries) {
    const rec = asRecord(entry)
    if (rec === null) continue
    const identifier = asString(rec.identifier)
    if (identifier === null) continue
    const quant = asRecord(rec.quantization)

    out.push({
      identifier,
      instanceReference: asString(rec.instanceReference) ?? '',
      modelKey: asString(rec.modelKey) ?? identifier,
      displayName: asString(rec.displayName) ?? identifier,
      publisher: asString(rec.publisher) ?? '',
      architecture: asString(rec.architecture) ?? '',
      format: asString(rec.format) ?? '',
      quantization: quant === null ? '' : (asString(quant.name) ?? ''),
      quantBits: quant === null ? null : asNumber(quant.bits),
      sizeBytes: asNumber(rec.sizeBytes) ?? 0,
      paramsString: asString(rec.paramsString) ?? '',
      contextLength: asNumber(rec.contextLength) ?? 0,
      maxContextLength: asNumber(rec.maxContextLength) ?? 0,
      vision: rec.vision === true,
      trainedForToolUse: rec.trainedForToolUse === true,
      ttlMs: asNumber(rec.ttlMs),
      lastUsedTime: asNumber(rec.lastUsedTime)
    })
  }
  return out
}

/**
 * `/api/v1/models` is snake_case and nests the quantization and capabilities:
 * {models:[{key, display_name, publisher, architecture, quantization:{name,
 * bits_per_weight}, size_bytes, params_string, loaded_instances, format,
 * max_context_length, capabilities:{vision, trained_for_tool_use}, variants,
 * selected_variant}]}
 */
function parseV1Catalog(payload: unknown): { models: CatalogModel[]; loaded: LoadedInstance[] } {
  const entries = asRecord(payload)?.models
  if (!Array.isArray(entries)) return { models: [], loaded: [] }

  const models: CatalogModel[] = []
  const loaded: LoadedInstance[] = []

  for (const entry of entries) {
    const rec = asRecord(entry)
    if (rec === null) continue
    const key = asString(rec.key)
    if (key === null) continue

    // The /llm control endpoint cannot load an embedding model; listing one
    // would only offer the user a button that cannot work.
    const type = asString(rec.type) ?? 'llm'
    if (type !== 'llm' && type !== 'vlm') continue

    const quant = asRecord(rec.quantization)
    const caps = asRecord(rec.capabilities)
    const model: CatalogModel = {
      modelKey: key,
      displayName: asString(rec.display_name) ?? key,
      publisher: asString(rec.publisher) ?? '',
      architecture: asString(rec.architecture) ?? '',
      format: asString(rec.format) ?? '',
      quantization: quant === null ? '' : (asString(quant.name) ?? ''),
      sizeBytes: asNumber(rec.size_bytes) ?? 0,
      paramsString: asString(rec.params_string) ?? '',
      maxContextLength: asNumber(rec.max_context_length) ?? 0,
      vision: caps?.vision === true,
      trainedForToolUse: caps?.trained_for_tool_use === true,
      variants: asStringArray(rec.variants),
      selectedVariant: asString(rec.selected_variant),
      loadedIdentifiers: []
    }

    const instances = Array.isArray(rec.loaded_instances) ? rec.loaded_instances : []
    for (const raw of instances) {
      const inst = asRecord(raw)
      const id = inst === null ? null : asString(inst.id)
      if (inst === null || id === null) continue
      model.loadedIdentifiers.push(id)

      const config = asRecord(inst.config)
      const remainingTtlSeconds = asNumber(inst.remaining_ttl_seconds)
      loaded.push({
        identifier: id,
        // Only the websocket exposes an instance reference.
        instanceReference: '',
        modelKey: key,
        displayName: model.displayName,
        publisher: model.publisher,
        architecture: model.architecture,
        format: model.format,
        quantization: model.quantization,
        quantBits: quant === null ? null : asNumber(quant.bits_per_weight),
        sizeBytes: model.sizeBytes,
        paramsString: model.paramsString,
        contextLength: config === null ? 0 : (asNumber(config.context_length) ?? 0),
        maxContextLength: model.maxContextLength,
        vision: model.vision,
        trainedForToolUse: model.trainedForToolUse,
        // REST reports the TTL still to run, not the one it was loaded with.
        ttlMs: remainingTtlSeconds === null ? null : Math.round(remainingTtlSeconds * 1000),
        lastUsedTime: null
      })
    }

    models.push(model)
  }

  return { models, loaded }
}

/**
 * `/api/v0/models` fallback for a server without /api/v1. It carries no size,
 * parameter count or variants, so those stay empty rather than being invented.
 */
function parseV0Catalog(payload: unknown): { models: CatalogModel[]; loaded: LoadedInstance[] } {
  const entries = asRecord(payload)?.data
  if (!Array.isArray(entries)) return { models: [], loaded: [] }

  const models: CatalogModel[] = []
  const loaded: LoadedInstance[] = []

  for (const entry of entries) {
    const rec = asRecord(entry)
    if (rec === null) continue
    const id = asString(rec.id)
    if (id === null) continue

    const type = asString(rec.type) ?? 'llm'
    if (type !== 'llm' && type !== 'vlm') continue

    const capabilities = asStringArray(rec.capabilities)
    const isLoaded = asString(rec.state) === 'loaded'
    const model: CatalogModel = {
      modelKey: id,
      displayName: id,
      publisher: asString(rec.publisher) ?? '',
      architecture: asString(rec.arch) ?? '',
      format: asString(rec.compatibility_type) ?? '',
      quantization: asString(rec.quantization) ?? '',
      sizeBytes: 0,
      paramsString: '',
      maxContextLength: asNumber(rec.max_context_length) ?? 0,
      vision: type === 'vlm',
      trainedForToolUse: capabilities.includes('tool_use'),
      variants: [],
      selectedVariant: null,
      loadedIdentifiers: isLoaded ? [id] : []
    }
    models.push(model)

    if (isLoaded) {
      loaded.push({
        identifier: id,
        instanceReference: '',
        modelKey: id,
        displayName: id,
        publisher: model.publisher,
        architecture: model.architecture,
        format: model.format,
        quantization: model.quantization,
        quantBits: null,
        sizeBytes: 0,
        paramsString: '',
        contextLength: asNumber(rec.loaded_context_length) ?? 0,
        maxContextLength: model.maxContextLength,
        vision: model.vision,
        trainedForToolUse: model.trainedForToolUse,
        ttlMs: null,
        lastUsedTime: null
      })
    }
  }

  return { models, loaded }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function timedFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    return await fetch(url, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function describeHttpError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  const detail = body.trim()
  return detail.length > 0
    ? `${res.status} ${res.statusText}: ${detail}`
    : `${res.status} ${res.statusText}`
}

/** Accepts ws://, wss://, http:// or https://, with or without a path. */
function normaliseWsUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
    const port = parsed.port.length > 0 ? parsed.port : String(CONTROL_PORT)
    const path = parsed.pathname === '' || parsed.pathname === '/' ? '/llm' : parsed.pathname
    return `${secure ? 'wss:' : 'ws:'}//${bracketHost(parsed.hostname)}:${port}${path}`
  } catch {
    return null
  }
}

/** URL.hostname strips the brackets an IPv6 literal needs to go back in. */
function bracketHost(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname
}

function extractErrorText(frame: Record<string, unknown>): string {
  const direct = asString(frame.title) ?? asString(frame.message) ?? asString(frame.warning)
  if (direct !== null && direct.trim().length > 0) return direct.trim()

  const error = frame.error
  if (typeof error === 'string' && error.trim().length > 0) return error.trim()
  const rec = asRecord(error)
  if (rec !== null) {
    const nested = asString(rec.title) ?? asString(rec.message)
    if (nested !== null && nested.trim().length > 0) return nested.trim()
  }
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Empty and whitespace-only strings are absent, not values. */
function nonEmpty(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
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
