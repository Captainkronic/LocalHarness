/**
 * What the active workflow actually puts on the wire.
 *
 * There is one rule here and everything else follows from it: a workflow may
 * narrow a server to named tools (`WorkflowDefinition.mcpTools`), so the cost
 * of a server is NOT the cost of the server — it is the cost of the tools this
 * workflow was given. Live is the case that forced it: gmail's full 19 tools
 * are 3.2k tokens, Live is handed 2 of them, and a panel summing whole servers
 * told the user 3.8k tokens and 15 seconds of prefill against a real 758 and
 * three.
 *
 * This lives in one file for the same reason `lib/rates.ts` does. The prefill
 * readout once disagreed with itself by 15x because two components each did
 * their own arithmetic, and a number the UI contradicts is worse than no
 * number.
 */

import type { McpServerState, McpToolInfo, WorkflowDefinition } from '@shared/types'

export interface ServerPayload {
  id: string
  /** Tools this workflow can actually call on this server. */
  tools: McpToolInfo[]
  /** Tool schema tokens plus this server's share of protocol overhead. */
  tokens: number
  /** True when the workflow is seeing less than the server offers. */
  narrowed: boolean
  /** Tools the server has but this workflow is not given. */
  withheld: number
}

/**
 * Whether a workflow may call a tool on a server.
 *
 * A server absent from the allowlist map is offered whole — the map narrows,
 * it does not enumerate.
 */
export function toolAllowed(
  workflow: WorkflowDefinition | undefined,
  serverId: string,
  toolName: string
): boolean {
  const allow = workflow?.mcpTools?.[serverId]
  return allow === undefined || allow.includes(toolName)
}

/**
 * Per-server cost for one workflow.
 *
 * `tokenCost` covers the server's enabled tools plus protocol overhead, so the
 * overhead is recovered by subtraction and kept whole: it is paid per server,
 * not per tool, and does not shrink because a workflow asked for fewer tools.
 */
export function serverPayload(
  state: McpServerState,
  workflow: WorkflowDefinition | undefined,
  isToolOn: (serverId: string, tool: McpToolInfo) => boolean = (_, t) => t.enabled
): ServerPayload {
  const asStored = state.tools.reduce((n, t) => n + (t.enabled ? t.tokens : 0), 0)
  const overhead = Math.max(0, state.tokenCost - asStored)

  const tools: McpToolInfo[] = []
  let tokens = 0
  let withheld = 0
  for (const tool of state.tools) {
    if (!toolAllowed(workflow, state.id, tool.name)) {
      withheld += 1
      continue
    }
    if (!isToolOn(state.id, tool)) continue
    tools.push(tool)
    tokens += tool.tokens
  }

  return {
    id: state.id,
    tools,
    tokens: tools.length === 0 ? 0 : tokens + overhead,
    narrowed: withheld > 0,
    withheld
  }
}

export interface WorkflowPayload {
  /** Ready servers only, in the order given. */
  servers: ServerPayload[]
  mcpTokens: number
  mcpToolCount: number
  /** Servers still starting; they cost nothing yet. */
  pending: number
}

/** Rolls `serverPayload` up over every ready server. */
export function workflowPayload(
  states: McpServerState[],
  workflow: WorkflowDefinition | undefined,
  isToolOn?: (serverId: string, tool: McpToolInfo) => boolean
): WorkflowPayload {
  const servers = states
    .filter((s) => s.status === 'ready')
    .map((s) => serverPayload(s, workflow, isToolOn))

  return {
    servers,
    mcpTokens: servers.reduce((n, s) => n + s.tokens, 0),
    mcpToolCount: servers.reduce((n, s) => n + s.tools.length, 0),
    pending: states.filter((s) => s.status === 'starting').length
  }
}
