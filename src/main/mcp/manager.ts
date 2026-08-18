/**
 * Owns the set of running MCP servers.
 *
 * The manager is what makes workflow switching cheap: `applySet` diffs the
 * wanted server ids against what is running, starts the missing ones
 * concurrently and stops the rest. One server that hangs on startup (a ComfyUI
 * autostart waiting on a cold model load, say) must never stop the others from
 * coming up, so every start is isolated behind Promise.allSettled and a failure
 * lands in that server's state rather than propagating.
 */

import { MCP_BY_ID, MCP_REGISTRY } from '@shared/mcp-registry'
import type {
  McpServerSpec,
  McpServerState,
  McpToolInfo,
  WireTool
} from '@shared/types'
import { McpClient, type McpCallResult, type McpProgress } from './client'
import { sanitizeSchema } from './tokens'

/**
 * Matches the `event:log` payload in the IPC contract. Defined here because the
 * main process has no other home for it; re-export from wherever the integrator
 * prefers if another subsystem needs the same shape.
 */
export type LogFn = (level: 'info' | 'warn' | 'error', scope: string, message: string) => void

export interface McpManagerOptions {
  onStates: (states: McpServerState[]) => void
  onLog: LogFn
}

/** OpenAI tool-name grammar. Anything outside this is rejected by the API. */
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_NAME_LENGTH = 64
const NAME_SEPARATOR = '__'

interface Route {
  serverId: string
  toolName: string
}

const KNOWN_IDS = new Set(MCP_REGISTRY.map((spec) => spec.id))

export class McpManager {
  private readonly opts: McpManagerOptions
  private readonly stateById = new Map<string, McpServerState>()
  private readonly clients = new Map<string, McpClient>()
  /** In-flight start/stop work per server, so overlapping applySet calls queue. */
  private readonly transitions = new Map<string, Promise<void>>()
  /** Wire name -> (server, original tool name). Rebuilt whenever tools change. */
  private routes = new Map<string, Route>()
  /** Tools the user has switched off, kept across restarts. */
  private readonly disabledTools = new Map<string, Set<string>>()

  constructor(opts: McpManagerOptions) {
    this.opts = opts
    for (const spec of MCP_REGISTRY) {
      this.stateById.set(spec.id, {
        id: spec.id,
        status: 'stopped',
        tools: [],
        tokenCost: 0
      })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Introspection                                                    */
  /* ---------------------------------------------------------------- */

  /** Registry copies, with `estimatedTokens` refreshed from any live discovery. */
  specs(): McpServerSpec[] {
    return MCP_REGISTRY.map((spec) => {
      const state = this.stateById.get(spec.id)
      const measured = state && state.tools.length > 0 ? sumTools(state.tools, null) : null
      return measured === null ? { ...spec } : { ...spec, estimatedTokens: measured }
    })
  }

  states(): McpServerState[] {
    return MCP_REGISTRY.map((spec) => cloneState(this.requireState(spec.id)))
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async applySet(ids: string[]): Promise<McpServerState[]> {
    const wanted = new Set(ids.filter((id) => KNOWN_IDS.has(id)))
    for (const id of ids) {
      if (!KNOWN_IDS.has(id)) {
        this.opts.onLog('warn', 'mcp', `ignoring unknown server id "${id}"`)
      }
    }

    const running = new Set<string>([...this.clients.keys()])
    for (const [id, state] of this.stateById) {
      if (state.status === 'starting') running.add(id)
    }

    const work: Promise<void>[] = []
    for (const id of wanted) {
      if (!running.has(id)) work.push(this.startServer(id))
    }
    for (const id of running) {
      if (!wanted.has(id)) work.push(this.stopServer(id))
    }

    // allSettled, not all: a broken server must not take the others down with it.
    await Promise.allSettled(work)
    return this.states()
  }

  async restart(id: string): Promise<McpServerState | null> {
    if (!KNOWN_IDS.has(id)) return null
    await this.stopServer(id)
    await this.startServer(id)
    return cloneState(this.requireState(id))
  }

  async shutdown(): Promise<void> {
    const ids = [...this.clients.keys()]
    await Promise.allSettled(ids.map((id) => this.stopServer(id)))
  }

  private startServer(id: string): Promise<void> {
    return this.enqueue(id, () => this.doStart(id))
  }

  private stopServer(id: string): Promise<void> {
    return this.enqueue(id, () => this.doStop(id))
  }

  /** Serialises work per server so overlapping applySet/restart calls cannot
   *  interleave a start and a stop on the same child. */
  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const queued = this.transitions.get(id) ?? Promise.resolve()
    const tracked: Promise<void> = queued.then(work, work).then(() => {
      if (this.transitions.get(id) === tracked) this.transitions.delete(id)
    })
    this.transitions.set(id, tracked)
    return tracked
  }

  private async doStart(id: string): Promise<void> {
    const spec = MCP_BY_ID[id]
    if (!spec || this.clients.has(id)) return

    const state = this.requireState(id)
    state.status = 'starting'
    state.error = undefined
    state.tools = []
    state.tokenCost = 0
    state.pid = undefined
    this.emit()

    const client = new McpClient({
      id: spec.id,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      callTimeoutMs: spec.callTimeoutMs,
      onLog: (level, msg) => this.opts.onLog(level, `mcp:${spec.id}`, msg)
    })
    this.clients.set(id, client)

    try {
      const tools = await client.start()
      const disabled = this.disabledTools.get(id)
      state.tools = tools.map((tool) =>
        disabled?.has(tool.name) ? { ...tool, enabled: false } : tool
      )
      state.tokenCost = sumTools(state.tools, true)
      state.status = 'ready'
      state.pid = client.pid
      state.startedAt = Date.now()
      state.handshakeMs = client.handshakeMs
      state.error = undefined
    } catch (err) {
      this.clients.delete(id)
      state.status = 'error'
      state.error = errText(err)
      state.tools = []
      state.tokenCost = 0
      state.pid = undefined
      state.handshakeMs = undefined
      this.opts.onLog('error', `mcp:${id}`, `start failed: ${state.error}`)
    }

    this.rebuildRoutes()
    this.emit()
  }

  private async doStop(id: string): Promise<void> {
    const client = this.clients.get(id)
    const state = this.requireState(id)
    if (!client) {
      if (state.status !== 'stopped') {
        state.status = 'stopped'
        state.tools = []
        state.tokenCost = 0
        state.pid = undefined
        this.emit()
      }
      return
    }

    this.clients.delete(id)
    state.status = 'stopping'
    this.emit()

    try {
      await client.stop()
    } catch (err) {
      this.opts.onLog('warn', `mcp:${id}`, `stop error: ${errText(err)}`)
    }

    state.status = 'stopped'
    state.tools = []
    state.tokenCost = 0
    state.pid = undefined
    state.startedAt = undefined
    state.error = undefined
    this.rebuildRoutes()
    this.emit()
  }

  /* ---------------------------------------------------------------- */
  /* Tool surface                                                     */
  /* ---------------------------------------------------------------- */

  setToolEnabled(serverId: string, toolName: string, enabled: boolean): McpServerState[] {
    const state = this.stateById.get(serverId)
    if (!state) return this.states()

    let disabled = this.disabledTools.get(serverId)
    if (!disabled) {
      disabled = new Set<string>()
      this.disabledTools.set(serverId, disabled)
    }
    if (enabled) disabled.delete(toolName)
    else disabled.add(toolName)

    state.tools = state.tools.map((tool) =>
      tool.name === toolName ? { ...tool, enabled } : tool
    )
    state.tokenCost = sumTools(state.tools, true)

    this.rebuildRoutes()
    this.emit()
    return this.states()
  }

  /**
   * Tools to put on the wire, optionally narrowed per server.
   *
   * The routing map is always rebuilt from the FULL set, never the narrowed
   * one: routing answers "what does this name mean", which does not change
   * with who is asking. Narrowing the routes here would mean a Live turn
   * rebuilding them could break a Chat call already in flight.
   */
  wireTools(allow?: Record<string, string[]>): WireTool[] {
    const { tools, routes } = this.buildWire()
    // Keep the routing map in step with what the model was actually shown.
    this.routes = routes
    if (!allow) return tools
    return tools.filter((tool) => {
      const route = routes.get(tool.function.name)
      if (!route) return false
      const permitted = allow[route.serverId]
      return permitted === undefined || permitted.includes(route.toolName)
    })
  }

  tokenCost(): number {
    let total = 0
    for (const state of this.stateById.values()) {
      if (state.status === 'ready') total += state.tokenCost
    }
    return total
  }

  async callTool(
    qualifiedName: string,
    args: unknown,
    onProgress?: (p: McpProgress) => void
  ): Promise<McpCallResult> {
    const route = this.resolve(qualifiedName)
    if (!route) {
      throw new Error(`Unknown MCP tool "${qualifiedName}"`)
    }
    const client = this.clients.get(route.serverId)
    const state = this.stateById.get(route.serverId)
    if (!client || state?.status !== 'ready') {
      throw new Error(`MCP server "${route.serverId}" is not running`)
    }
    return client.callTool(route.toolName, args, onProgress)
  }

  /**
   * Calls a tool the MODEL was never offered.
   *
   * `callTool` routes through the map built from tools/list, which is correct
   * for anything the model asks for — a name that was never advertised must not
   * be reachable by guessing it. This is the other case: the APP calling its own
   * server for housekeeping the model has no business deciding. The health
   * server's `open_case` is the example. Binding a conversation to a case file
   * is a fact about which window is open, not a judgement, and advertising it
   * would both cost prefill on every spoken turn and invite the model to start a
   * fresh case mid-consultation.
   *
   * Resolves to nothing and returns null when the server is not running, rather
   * than throwing: it is called on a path where failing is not worth breaking
   * the session over.
   */
  async callDirect(serverId: string, toolName: string, args: unknown): Promise<McpCallResult | null> {
    const client = this.clients.get(serverId)
    const state = this.stateById.get(serverId)
    if (!client || state?.status !== 'ready') return null
    return client.callTool(toolName, args)
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Builds the wire tools and the reverse routing map in one pass so the two can
   * never disagree about a sanitised name.
   */
  private buildWire(): { tools: WireTool[]; routes: Map<string, Route> } {
    const tools: WireTool[] = []
    const routes = new Map<string, Route>()

    for (const spec of MCP_REGISTRY) {
      const state = this.stateById.get(spec.id)
      if (!state || state.status !== 'ready') continue

      for (const tool of state.tools) {
        if (!tool.enabled) continue
        const wireName = uniqueWireName(spec.id, tool.name, routes)
        routes.set(wireName, { serverId: spec.id, toolName: tool.name })
        tools.push({
          type: 'function',
          function: {
            name: wireName,
            description: tool.description,
            parameters: sanitizeSchema(tool.inputSchema)
          }
        })
      }
    }

    return { tools, routes }
  }

  private rebuildRoutes(): void {
    this.routes = this.buildWire().routes
  }

  /**
   * Maps a name the model emitted back to a server and tool. Falls back to a
   * rebuild and then to splitting on the separator, because a model will
   * occasionally echo a name from an earlier turn.
   */
  private resolve(qualifiedName: string): Route | null {
    const direct = this.routes.get(qualifiedName)
    if (direct) return direct

    this.rebuildRoutes()
    const rebuilt = this.routes.get(qualifiedName)
    if (rebuilt) return rebuilt

    const cut = qualifiedName.indexOf(NAME_SEPARATOR)
    if (cut > 0) {
      const serverPrefix = qualifiedName.slice(0, cut)
      const toolPart = qualifiedName.slice(cut + NAME_SEPARATOR.length)
      for (const spec of MCP_REGISTRY) {
        if (sanitizeNamePart(spec.id) !== serverPrefix) continue
        const state = this.stateById.get(spec.id)
        const match = state?.tools.find(
          (t) => t.name === toolPart || sanitizeNamePart(t.name) === toolPart
        )
        if (match) return { serverId: spec.id, toolName: match.name }
      }
    }

    return null
  }

  private requireState(id: string): McpServerState {
    const state = this.stateById.get(id)
    if (state) return state
    const created: McpServerState = { id, status: 'stopped', tools: [], tokenCost: 0 }
    this.stateById.set(id, created)
    return created
  }

  private emit(): void {
    this.opts.onStates(this.states())
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** `onlyEnabled === null` counts every tool; `true` counts only enabled ones. */
function sumTools(tools: McpToolInfo[], onlyEnabled: boolean | null): number {
  let total = 0
  for (const tool of tools) {
    if (onlyEnabled === true && !tool.enabled) continue
    // Each tool's count already carries its share of protocol overhead.
    total += tool.tokens
  }
  return total
}

function sanitizeNamePart(part: string): string {
  const cleaned = part.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'tool'
}

/**
 * `${serverId}__${toolName}`, forced into the OpenAI name grammar: illegal
 * characters become `_`, the tool half is truncated if the pair is over 64
 * chars, and a numeric suffix breaks any collision truncation created.
 */
function uniqueWireName(
  serverId: string,
  toolName: string,
  taken: ReadonlyMap<string, Route>
): string {
  const server = sanitizeNamePart(serverId)
  const tool = sanitizeNamePart(toolName)

  let base = `${server}${NAME_SEPARATOR}${tool}`
  if (base.length > MAX_NAME_LENGTH) {
    const room = MAX_NAME_LENGTH - server.length - NAME_SEPARATOR.length
    base =
      room > 0
        ? `${server}${NAME_SEPARATOR}${tool.slice(0, room)}`
        : base.slice(0, MAX_NAME_LENGTH)
  }
  if (!NAME_RE.test(base)) base = base.slice(0, MAX_NAME_LENGTH) || 'mcp_tool'

  if (!taken.has(base)) return base

  for (let n = 2; n < 1000; n += 1) {
    const suffix = String(n)
    const trimmed = base.slice(0, MAX_NAME_LENGTH - suffix.length)
    const candidate = `${trimmed}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}

function cloneState(state: McpServerState): McpServerState {
  return { ...state, tools: state.tools.map((tool) => ({ ...tool })) }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}
