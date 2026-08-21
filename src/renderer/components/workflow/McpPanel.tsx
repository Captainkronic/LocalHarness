import { useCallback, useMemo, useState, type JSX } from 'react'
import type { McpServerSpec, McpServerState, McpToolInfo } from '@shared/types'
import { serverPayload } from '@renderer/lib/payload'
import { useStore } from '@renderer/state/store'
import { formatMs, formatTokens, formatTps } from '@renderer/lib/format'
import { prefillRate } from '@renderer/lib/rates'
import './workflow.css'

/**
 * The payload-control surface.
 *
 * Every token of tool schema in this list is paid for on every single request,
 * as wall-clock prefill time. So the panel is built around one question: what is
 * loaded, what does it cost, and what does that cost in seconds.
 */

function statusDot(status: McpServerState['status']): string {
  switch (status) {
    case 'ready':
      return 'dot dot-ok'
    case 'starting':
    case 'stopping':
      return 'dot dot-busy'
    case 'error':
      return 'dot dot-error'
    default:
      return 'dot'
  }
}

function statusWord(status: McpServerState['status']): string {
  switch (status) {
    case 'ready':
      return 'ready'
    case 'starting':
      return 'starting…'
    case 'stopping':
      return 'stopping…'
    case 'error':
      return 'failed'
    default:
      return 'not running'
  }
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={open ? 'mcp-chev is-open' : 'mcp-chev'}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

function RestartIcon(): JSX.Element {
  return (
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
    >
      <path d="M13 8a5 5 0 1 1-1.6-3.66" />
      <path d="M13 2.5V5.5h-3" />
    </svg>
  )
}

export function McpPanel(): JSX.Element {
  const specs = useStore((s) => s.mcpSpecs)
  const states = useStore((s) => s.mcpStates)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const mcpOverrides = useStore((s) => s.settings.workflowMcpOverrides)
  const setMcpEnabled = useStore((s) => s.setMcpEnabled)
  const labHistory = useStore((s) => s.labHistory)
  const residentModelId = useStore((s) => s.health.residentModelId)
  const livePrefillTps = useStore((s) => s.live.prefillTps)
  const livePrefillEstimated = useStore((s) => s.live.prefillEstimated)

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** Optimistic per-tool enablement, keyed `${serverId}__${toolName}`. Reconciled
   *  from the authoritative state array the IPC call returns. */
  const [toolFlags, setToolFlags] = useState<Record<string, boolean>>({})

  const definition = useMemo(
    () => workflows.find((w) => w.id === activeWorkflow) ?? null,
    [workflows, activeWorkflow]
  )
  const defaultIds = useMemo(
    () => new Set(definition?.mcpServers ?? []),
    [definition]
  )
  const enabledIds = useMemo(
    () => new Set(mcpOverrides[activeWorkflow] ?? definition?.mcpServers ?? []),
    [mcpOverrides, activeWorkflow, definition]
  )
  const stateById = useMemo(
    () => new Map(states.map((s) => [s.id, s] as const)),
    [states]
  )

  // Workflow defaults first, then anything the user added, then the rest.
  const naturalOrder = useMemo(() => {
    const rank = (s: McpServerSpec): number =>
      defaultIds.has(s.id) ? 0 : enabledIds.has(s.id) ? 1 : 2
    return [...specs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  }, [specs, defaultIds, enabledIds])

  /**
   * The order the rows were in when the pointer arrived, held until it leaves.
   *
   * The sort keys on `enabledIds`, so toggling a server re-sorts the list
   * instantly — out from under the cursor that just clicked it. The natural
   * follow-up gesture, clicking the same spot again to undo, then lands on
   * whichever row slid into the vacancy. That is not a harmless mis-click: it
   * changes the tool list and the per-message token payload, and nothing
   * announces it. Observed turning `playwright` off and `comfy-audio` on.
   *
   * Null whenever the pointer is elsewhere, so the list still sorts itself the
   * moment nobody is aiming at it.
   */
  const [frozenIds, setFrozenIds] = useState<string[] | null>(null)

  const ordered = useMemo(() => {
    if (frozenIds === null) return naturalOrder
    const byId = new Map(naturalOrder.map((s) => [s.id, s] as const))
    const held = new Set(frozenIds)
    const out = frozenIds
      .map((id) => byId.get(id))
      .filter((s): s is McpServerSpec => s !== undefined)
    // A server that appeared since the freeze goes on the end rather than
    // being hidden until the pointer leaves.
    for (const s of naturalOrder) if (!held.has(s.id)) out.push(s)
    return out
  }, [naturalOrder, frozenIds])

  const isToolOn = useCallback(
    (serverId: string, tool: McpToolInfo): boolean =>
      toolFlags[`${serverId}__${tool.name}`] ?? tool.enabled,
    [toolFlags]
  )

  /** Measured cost once a server is ready, registry estimate before that. */
  const costOf = useCallback(
    (spec: McpServerSpec): { tokens: number; estimated: boolean } => {
      const st = stateById.get(spec.id)
      // A server that FAILED sends nothing, so it costs nothing — it used to be
      // billed its registry estimate into the payload total, inflating the very
      // figure the user steers by on the strength of a server that is not there.
      //
      // Only 'error', though. A merely stopped server still shows its estimate,
      // because that estimate is the answer to "what would switching this on
      // cost me", which is the whole reason the column exists. An earlier
      // version zeroed those too and blanked the entire list.
      if (st?.status === 'error') {
        return { tokens: 0, estimated: false }
      }
      if (!st || st.status !== 'ready' || st.tools.length === 0) {
        return { tokens: spec.estimatedTokens, estimated: true }
      }
      // Narrowed to what THIS workflow may call: showing gmail's full 3.2k in
      // Live, which is handed two of its nineteen tools, overstates the turn
      // by a factor of four.
      const { tokens } = serverPayload(st, definition ?? undefined, isToolOn)
      return { tokens, estimated: false }
    },
    [stateById, isToolOn, definition]
  )

  const total = useMemo(() => {
    let tokens = 0
    let estimated = false
    let on = 0
    for (const spec of specs) {
      if (!enabledIds.has(spec.id)) continue
      on += 1
      const c = costOf(spec)
      tokens += c.tokens
      if (c.estimated) estimated = true
    }
    return { tokens, estimated, on }
  }, [specs, enabledIds, costOf])

  // Shared with the HUD's PayloadBudget. These were two separate calculations
  // and disagreed by 15x on identical data — see lib/rates.ts.
  const rate = useMemo(
    () =>
      prefillRate(labHistory, residentModelId, {
        tps: livePrefillTps,
        estimated: livePrefillEstimated
      }),
    [labHistory, residentModelId, livePrefillTps, livePrefillEstimated]
  )

  const mark = useCallback((id: string, on: boolean): void => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleServer = useCallback(
    async (id: string, next: boolean): Promise<void> => {
      mark(id, true)
      try {
        await setMcpEnabled(id, next)
      } finally {
        mark(id, false)
      }
    },
    [mark, setMcpEnabled]
  )

  const restartServer = useCallback(
    async (id: string): Promise<void> => {
      mark(id, true)
      // A restart re-discovers tools, so any optimistic per-tool flags are void.
      setToolFlags((prev) => {
        const next: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(prev)) {
          if (!k.startsWith(`${id}__`)) next[k] = v
        }
        return next
      })
      try {
        await window.harness.invoke('mcp:restart', id)
      } finally {
        mark(id, false)
      }
    },
    [mark]
  )

  const toggleTool = useCallback(
    async (serverId: string, toolName: string, next: boolean): Promise<void> => {
      const key = `${serverId}__${toolName}`
      setToolFlags((prev) => ({ ...prev, [key]: next }))
      try {
        const updated = await window.harness.invoke(
          'mcp:setToolEnabled',
          serverId,
          toolName,
          next
        )
        const st = updated.find((s) => s.id === serverId)
        if (!st) return
        setToolFlags((prev) => {
          const merged = { ...prev }
          for (const t of st.tools) merged[`${serverId}__${t.name}`] = t.enabled
          return merged
        })
      } catch {
        setToolFlags((prev) => {
          const merged = { ...prev }
          delete merged[key]
          return merged
        })
      }
    },
    []
  )

  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const prefillMs = rate.tps > 0 ? (total.tokens / rate.tps) * 1000 : null

  return (
    <section className="mcp" aria-label="MCP servers">
      <div className="mcp-head">
        <span className="section-label">MCP servers</span>
        <span className="mcp-head-n tnum">{total.on} on</span>
      </div>

      {ordered.length === 0 ? (
        <p className="mcp-empty">
          No servers in the registry. Nothing can be loaded until one is added to
          <code> mcp-registry.ts</code>.
        </p>
      ) : (
        <div
          className="mcp-list scroll-y"
          onPointerEnter={() => setFrozenIds(naturalOrder.map((s) => s.id))}
          onPointerLeave={() => setFrozenIds(null)}
        >
          {ordered.map((spec) => {
            const st = stateById.get(spec.id)
            const status: McpServerState['status'] = st?.status ?? 'stopped'
            const on = enabledIds.has(spec.id)
            const isDefault = defaultIds.has(spec.id)
            const tools = st?.tools ?? []
            const ready = status === 'ready' && tools.length > 0
            const open = expanded.has(spec.id)
            const cost = costOf(spec)
            const onCount = tools.reduce((n, t) => n + (isToolOn(spec.id, t) ? 1 : 0), 0)
            const working = busy.has(spec.id)

            return (
              <div
                key={spec.id}
                className={cx('mcp-item', isDefault && 'is-default', on && 'is-on')}
              >
                <div className="mcp-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${spec.id} (${spec.label}): ${on ? 'enabled' : 'disabled'}`}
                    className={cx('sw', on && 'is-on')}
                    disabled={working}
                    onClick={() => void toggleServer(spec.id, !on)}
                  >
                    <span className="sw-knob" />
                  </button>

                  <button
                    type="button"
                    className="mcp-name"
                    disabled={!ready}
                    aria-expanded={ready ? open : undefined}
                    title={
                      status === 'error'
                        ? `${spec.label} — ${spec.blurb}\n\n${st?.error ?? 'Failed to start'}`
                        : `${spec.label} — ${spec.blurb}\n${statusWord(status)}${
                            ready ? ` — click to list ${tools.length} tools` : ''
                          }${on && !isDefault ? '\nAdded to this workflow, not one of its defaults.' : ''}`
                    }
                    onClick={() => toggleExpanded(spec.id)}
                  >
                    <span className={statusDot(status)} />
                    {/* The SERVER ID is the name, not my invented label. These
                        are Adam's own servers, configured by him under these
                        ids; "playwright" shown as "Browser" meant he could not
                        find it. The friendly label lives in the tooltip, where
                        it explains without hiding anything. */}
                    <span className="mcp-label">{spec.id}</span>
                    {/* A glyph, not the word. `added` is fixed-width and never
                        shrinks, so it was winning space from the server NAME and
                        leaving "play…" and "ui-r…" — the exact illegibility that
                        showing ids instead of labels was meant to end. The
                        meaning moves to the tooltip, which has room for it. */}
                    {on && !isDefault ? (
                      <span className="mcp-tag" aria-label="added to this workflow">
                        +
                      </span>
                    ) : null}
                    {ready ? <Chevron open={open} /> : null}
                  </button>

                  <span className="mcp-meta">
                    {tools.length > 0 ? (
                      <span
                        className="mcp-tools-n tnum"
                        title={`${onCount} of ${tools.length} tools enabled`}
                      >
                        {onCount === tools.length ? tools.length : `${onCount}/${tools.length}`}t
                      </span>
                    ) : null}
                    <span
                      className={cx('mcp-cost', 'tnum', cost.estimated && 'is-est')}
                      title={
                        cost.estimated
                          ? 'Registry estimate — the server has not reported its tools yet'
                          : 'Measured from the schemas this server actually returned'
                      }
                    >
                      {cost.estimated ? '~' : ''}
                      {formatTokens(cost.tokens)}
                    </span>
                  </span>
                </div>

                {status === 'error' ? (
                  <div className="mcp-error" title={st?.error ?? 'Failed to start'}>
                    <span className="mcp-error-msg">{st?.error ?? 'Failed to start'}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost mcp-restart"
                      disabled={working}
                      onClick={() => void restartServer(spec.id)}
                    >
                      <RestartIcon />
                      Restart
                    </button>
                  </div>
                ) : null}

                {ready && open ? (
                  <div className="mcp-tools">
                    {tools.map((t) => {
                      const toolOn = isToolOn(spec.id, t)
                      return (
                        <div
                          key={t.qualifiedName}
                          className={cx('mcp-tool', toolOn && 'is-on')}
                        >
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolOn}
                            aria-label={`${t.name}: ${toolOn ? 'enabled' : 'disabled'}`}
                            className={cx('sw sw-xs', toolOn && 'is-on')}
                            onClick={() => void toggleTool(spec.id, t.name, !toolOn)}
                          >
                            <span className="sw-knob" />
                          </button>
                          <span className="mcp-tool-name" title={t.description}>
                            {t.name}
                          </span>
                          <span className="mcp-tool-cost tnum">{formatTokens(t.tokens)}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <div className="mcp-foot">
        {/* Explicitly "MCP payload": this footer counts servers only, while the
            HUD's PAYLOAD counts native tools too. Both said "Payload" and the
            two numbers looked like a contradiction. */}
        <span className="section-label">MCP payload</span>
        <span className="mcp-foot-nums">
          <span
            className="mcp-foot-tokens tnum"
            title={
              total.estimated
                ? 'Includes registry estimates for servers that are not running yet'
                : 'Measured from live tool schemas'
            }
          >
            {total.estimated ? '~' : ''}
            {formatTokens(total.tokens)} tok
          </span>
          <span className="mcp-foot-sep">·</span>
          <span
            className="mcp-foot-prefill tnum"
            title={`≈${formatTps(rate.tps)} tok/s prefill (${
              rate.measured ? 'measured on this box' : 'assumed until a turn is measured'
            })`}
          >
            {formatMs(prefillMs)} prefill
          </span>
        </span>
      </div>
    </section>
  )
}

export default McpPanel
