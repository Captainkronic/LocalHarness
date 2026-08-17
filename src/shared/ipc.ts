/**
 * IPC contract.
 *
 * Two directions:
 *  - `IpcApi` — request/response calls the renderer invokes on main.
 *  - `IpcEvents` — pushes main sends to the renderer.
 *
 * Both are implemented in src/main/ipc.ts and exposed on `window.harness`
 * by src/preload/index.ts. Channel names are derived mechanically from the
 * key names, so adding a method here is the only place a channel is declared.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  ContextUsage,
  Conversation,
  ConversationSummary,
  LabRecord,
  LiveMetrics,
  McpServerSpec,
  McpServerState,
  ModelInfo,
  NativeToolInfo,
  SendMessageRequest,
  ServerHealth,
  Settings,
  WorkflowDefinition,
  WorkflowId
} from './types'

export interface IpcApi {
  /* ---- app ---- */
  'app:getBootstrap': () => Promise<BootstrapPayload>

  /* ---- settings ---- */
  'settings:get': () => Promise<Settings>
  'settings:update': (patch: Partial<Settings>) => Promise<Settings>
  'settings:pickDirectory': () => Promise<string | null>

  /* ---- models ---- */
  'models:list': () => Promise<ModelInfo[]>
  'models:refresh': () => Promise<ModelInfo[]>
  'models:load': (modelId: string) => Promise<{ ok: boolean; error?: string }>

  /* ---- conversations ---- */
  'conv:list': () => Promise<ConversationSummary[]>
  'conv:get': (id: string) => Promise<Conversation | null>
  'conv:create': (workflowId: WorkflowId) => Promise<Conversation>
  'conv:delete': (id: string) => Promise<void>
  'conv:rename': (id: string, title: string) => Promise<void>
  'conv:setModel': (id: string, modelId: string | null) => Promise<void>
  'conv:setWorkflow': (id: string, workflowId: WorkflowId) => Promise<Conversation>

  /* ---- chat ---- */
  'chat:send': (req: SendMessageRequest) => Promise<{ ok: boolean; error?: string }>
  'chat:cancel': (conversationId: string) => Promise<void>
  'chat:contextUsage': (conversationId: string) => Promise<ContextUsage>
  'chat:attachFiles': () => Promise<import('./types').Attachment[]>

  /* ---- mcp ---- */
  'mcp:listSpecs': () => Promise<McpServerSpec[]>
  'mcp:listStates': () => Promise<McpServerState[]>
  'mcp:setEnabled': (
    workflowId: WorkflowId,
    serverId: string,
    enabled: boolean
  ) => Promise<McpServerState[]>
  'mcp:setToolEnabled': (
    serverId: string,
    toolName: string,
    enabled: boolean
  ) => Promise<McpServerState[]>
  'mcp:restart': (serverId: string) => Promise<McpServerState | null>
  /** Applies a workflow's server set: starts what's needed, stops what isn't. */
  'mcp:applyWorkflow': (workflowId: WorkflowId) => Promise<McpServerState[]>

  /* ---- workflows ---- */
  'workflow:list': () => Promise<WorkflowDefinition[]>

  /* ---- approvals ---- */
  'approval:respond': (requestId: string, decision: ApprovalDecision) => Promise<void>
  'approval:pending': () => Promise<ApprovalRequest[]>

  /* ---- artifacts ---- */
  'artifacts:list': (workflowId: WorkflowId) => Promise<Artifact[]>
  'artifacts:reveal': (path: string) => Promise<void>
  'artifacts:open': (path: string) => Promise<void>
  'artifacts:readDataUrl': (path: string) => Promise<string | null>

  /* ---- telemetry ---- */
  'telemetry:health': () => Promise<ServerHealth>
  'telemetry:history': () => Promise<LabRecord[]>
}

export interface IpcEvents {
  'event:conversationUpdated': Conversation
  'event:conversationList': ConversationSummary[]
  'event:liveMetrics': LiveMetrics
  'event:contextUsage': { conversationId: string; usage: ContextUsage }
  'event:mcpStates': McpServerState[]
  'event:models': ModelInfo[]
  'event:health': ServerHealth
  'event:labRecord': LabRecord
  'event:approvalRequest': ApprovalRequest
  'event:approvalResolved': { requestId: string; decision: ApprovalDecision }
  'event:artifact': Artifact
  'event:log': { level: 'info' | 'warn' | 'error'; scope: string; message: string }
}

/** Everything the renderer needs on first paint, in one round trip. */
export interface BootstrapPayload {
  settings: Settings
  workflows: WorkflowDefinition[]
  mcpSpecs: McpServerSpec[]
  mcpStates: McpServerState[]
  nativeTools: NativeToolInfo[]
  models: ModelInfo[]
  conversations: ConversationSummary[]
  health: ServerHealth
  appVersion: string
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents

export const IPC_CHANNELS: IpcChannel[] = [
  'app:getBootstrap',
  'settings:get',
  'settings:update',
  'settings:pickDirectory',
  'models:list',
  'models:refresh',
  'models:load',
  'conv:list',
  'conv:get',
  'conv:create',
  'conv:delete',
  'conv:rename',
  'conv:setModel',
  'conv:setWorkflow',
  'chat:send',
  'chat:cancel',
  'chat:contextUsage',
  'chat:attachFiles',
  'mcp:listSpecs',
  'mcp:listStates',
  'mcp:setEnabled',
  'mcp:setToolEnabled',
  'mcp:restart',
  'mcp:applyWorkflow',
  'workflow:list',
  'approval:respond',
  'approval:pending',
  'artifacts:list',
  'artifacts:reveal',
  'artifacts:open',
  'artifacts:readDataUrl',
  'telemetry:health',
  'telemetry:history'
]

export const IPC_EVENT_CHANNELS: IpcEventChannel[] = [
  'event:conversationUpdated',
  'event:conversationList',
  'event:liveMetrics',
  'event:contextUsage',
  'event:mcpStates',
  'event:models',
  'event:health',
  'event:labRecord',
  'event:approvalRequest',
  'event:approvalResolved',
  'event:artifact',
  'event:log'
]

/** The surface the preload script exposes as `window.harness`. */
export interface HarnessBridge {
  invoke<K extends IpcChannel>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]>
  on<K extends IpcEventChannel>(
    channel: K,
    listener: (payload: IpcEvents[K]) => void
  ): () => void
  platform: string
}
