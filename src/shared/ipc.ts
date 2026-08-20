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
  ReasoningEffort,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  ConfigField,
  ControlState,
  DirEntry,
  EditJob,
  EditParams,
  Skill,
  FileActivity,
  TouchedFile,
  LiveAudioChunk,
  LiveExchange,
  LiveSessionStatus,
  LiveSettings,
  LoadOptions,
  LoadProgress,
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
  WorkflowId,
  Avatar,
  AvatarBuildSpec,
  AvatarBuildProgress,
  SamplingOverrides
} from './types'
import type {
  CredentialState,
  ModelReport,
  ProbeResult,
  ProvisionProgress,
  ProvisionResult,
  SetupState
} from './setup'

export interface IpcApi {
  /* ---- app ---- */
  'app:getBootstrap': () => Promise<BootstrapPayload>

  /* ---- settings ---- */
  'settings:get': () => Promise<Settings>
  'settings:update': (patch: Partial<Settings>) => Promise<Settings>
  'avatars:list': () => Promise<Avatar[]>
  'avatars:save': (avatar: Avatar) => Promise<Avatar>
  'avatars:delete': (id: string) => Promise<void>
  'avatars:build': (spec: AvatarBuildSpec) => Promise<Avatar | null>
  'avatars:cancelBuild': () => Promise<void>
  'avatars:finish': (id: string) => Promise<Avatar | null>
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
  /**
   * `accepted` says whether the user's message made it into the transcript.
   *
   * Distinct from `ok`, and the distinction is what the composer needs. A turn
   * that fails MID-flight is accepted: the message is on screen and the error
   * is rendered beside it. A send rejected BEFORE the turn starts — no model
   * loaded, a turn already running — is not, and the typed text exists nowhere
   * but the textarea the composer is about to clear.
   */
  'chat:send': (
    req: SendMessageRequest
  ) => Promise<{ ok: boolean; accepted: boolean; error?: string }>
  'chat:cancel': (conversationId: string) => Promise<void>
  'chat:continue': (
    conversationId: string
  ) => Promise<{ ok: boolean; accepted: boolean; error?: string }>
  'chat:contextUsage': (conversationId: string) => Promise<ContextUsage>
  'chat:attachFiles': () => Promise<import('./types').Attachment[]>

  /* ---- mcp ---- */
  'mcp:listSpecs': () => Promise<McpServerSpec[]>
  'mcp:listStates': () => Promise<McpServerState[]>
  /** Per-workflow reasoning effort. Returns the saved settings. */
  'settings:setReasoning': (workflowId: WorkflowId, effort: ReasoningEffort) => Promise<Settings>
  'settings:setSampling': (
    workflowId: WorkflowId,
    patch: Partial<SamplingOverrides>
  ) => Promise<Settings>
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
  /** Native right-click menu for a file on disk: reveal, open, copy path. */
  'files:contextMenu': (path: string) => Promise<void>
  'artifacts:open': (path: string) => Promise<void>
  'artifacts:readDataUrl': (path: string) => Promise<string | null>

  /* ---- telemetry ---- */
  'telemetry:health': () => Promise<ServerHealth>
  'telemetry:history': () => Promise<LabRecord[]>

  /* ---- remote model control (websocket to LM Studio) ---- */
  'control:state': () => Promise<ControlState>
  'control:refresh': () => Promise<ControlState>
  'control:load': (
    modelKey: string,
    options: LoadOptions
  ) => Promise<{ ok: boolean; error?: string }>
  'control:unload': (identifier: string) => Promise<{ ok: boolean; error?: string }>
  'control:cancelLoad': () => Promise<void>
  'control:getConfig': (identifier: string) => Promise<ConfigField[]>

  /* ---- image editing workflow ---- */
  'edit:list': () => Promise<EditJob[]>
  /** Opens a file picker; returns the created draft jobs (one per image). */
  'edit:pickSources': () => Promise<EditJob[]>
  /** Creates a draft from a path already on disk (drag-and-drop, or a previous
   *  job's output when iterating). */
  'edit:createFromPath': (path: string, parentId?: string) => Promise<EditJob | null>
  'edit:setInstruction': (jobId: string, instruction: string) => Promise<EditJob | null>
  'edit:setParams': (jobId: string, params: Partial<EditParams>) => Promise<EditJob | null>
  /** Stage 1: vision model turns the instruction into an edit prompt. */
  'edit:refine': (jobId: string) => Promise<EditJob | null>
  /** Hand-edit the refined prompt before rendering. */
  'edit:setPrompt': (jobId: string, prompt: string) => Promise<EditJob | null>
  /** Stage 2: render through comfy-image with confirm:true. */
  'edit:apply': (jobId: string) => Promise<EditJob | null>
  'edit:cancel': (jobId: string) => Promise<void>
  'edit:delete': (jobId: string) => Promise<void>

  /* ---- live code workspace ---- */
  'code:activity': (conversationId: string) => Promise<FileActivity[]>
  'code:touched': (conversationId: string) => Promise<TouchedFile[]>
  /** Read a file for the viewer, sandbox-checked like every other path. */
  'code:readFile': (path: string) => Promise<{ content: string; truncated: boolean } | null>

  /* ---- live voice/video conversation ---- */
  'live:start': (conversationId: string) => Promise<{ ok: boolean; error?: string }>
  'live:stop': () => Promise<void>
  'live:status': () => Promise<LiveSessionStatus>
  'live:settings': () => Promise<LiveSettings>
  'live:updateSettings': (patch: Partial<LiveSettings>) => Promise<LiveSettings>
  /**
   * A completed utterance from the renderer: 16kHz mono PCM16, plus the newest
   * camera frame as a data: URL when video is on. The renderer owns capture and
   * turn detection because that is where the audio graph lives; main owns
   * everything after the speech stops.
   */
  'live:utterance': (
    pcm: ArrayBuffer,
    sampleRate: number,
    frameDataUrl?: string
  ) => Promise<{ ok: boolean; error?: string }>
  /** Barge-in: abandon the reply in flight and go back to listening. */
  'live:interrupt': () => Promise<void>
  'live:exchanges': () => Promise<LiveExchange[]>
  'live:voices': () => Promise<string[]>

  /* ---- file tree ---- */
  /** One level, sandbox-checked. Directories first, then files, both by name. */
  'code:listDir': (path: string) => Promise<DirEntry[]>

  /* ---- skills ---- */
  /** Start/stop the live mirror. Reference counted: it runs only while the
   *  Browser tab is actually on screen. */
  'browser:watch': (on: boolean) => Promise<void>
  'skills:list': () => Promise<Skill[]>
  'skills:refresh': () => Promise<Skill[]>
  'skills:setEnabled': (path: string, enabled: boolean) => Promise<Skill[]>
  /** The full SKILL.md body, for the panel's preview. */
  'skills:read': (path: string) => Promise<string | null>
  'skills:reveal': (path: string) => Promise<void>

  /* ---- first-run setup ---- */
  /** Everything the wizard and the credentials panel render from. */
  'setup:state': () => Promise<SetupState>
  /**
   * Ask a host whether it is actually an inference server, before anything is
   * written. Both ports are tried; only the API one is required.
   */
  'setup:probe': (host: string) => Promise<ProbeResult>
  /** Build the chosen servers. Progress arrives on 'event:setupProgress'. */
  'setup:install': (ids: string[]) => Promise<ProvisionResult>
  /** Store one credential. Returns the new states, values still withheld. */
  'setup:setCredential': (serverId: string, key: string, value: string) => Promise<CredentialState[]>
  /** Does the ComfyUI at this host have the models the servers need? */
  'setup:checkComfyModels': (host: string) => Promise<ModelReport>
  /** Write the chosen server settings and mark setup done. */
  'setup:finish': (choice: {
    baseUrl: string
    nativeApiUrl: string
    modelId: string | null
    workspaceRoot: string | null
  }) => Promise<Settings>
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
  'event:avatarBuild': AvatarBuildProgress
  /** Per-server progress while the wizard is building environments. */
  'event:setupProgress': ProvisionProgress
  /**
   * Main asking the renderer to do something the user invoked from the native
   * menu or the tray.
   *
   * Needed because those live in the main process while the actions they name
   * are renderer state. Without it the File > New Conversation item had nothing
   * to call and silently logged instead — it looked wired and was not.
   */
  'event:menuCommand': { command: 'newConversation' }
  'event:controlState': ControlState
  'event:loadProgress': LoadProgress
  'event:editJob': EditJob
  'event:editJobDeleted': { jobId: string }
  'event:fileActivity': FileActivity
  'event:liveStatus': LiveSessionStatus
  'event:liveAudio': LiveAudioChunk
  'event:liveExchange': LiveExchange
  'event:skills': Skill[]
  /** A frame from the browser the model is driving, while someone is watching. */
  'event:browserFrame': { dataUrl: string; width: number; height: number; at: number }
  'event:browserMirror': { status: 'off' | 'connecting' | 'live' | 'unavailable' }
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
  /** Forces the starting workflow, from LH_START_WORKFLOW. Used by the
   *  screenshot driver so a given workflow can be photographed on demand;
   *  undefined in normal use, where the last conversation decides. */
  startWorkflow?: WorkflowId
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents

export const IPC_CHANNELS: IpcChannel[] = [
  'app:getBootstrap',
  'settings:get',
  'settings:update',
  'avatars:list',
  'avatars:save',
  'avatars:delete',
  'avatars:build',
  'avatars:cancelBuild',
  'avatars:finish',
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
  'chat:continue',
  'chat:contextUsage',
  'chat:attachFiles',
  'mcp:listSpecs',
  'mcp:listStates',
  'settings:setReasoning',
  'settings:setSampling',
  'mcp:setEnabled',
  'mcp:setToolEnabled',
  'mcp:restart',
  'mcp:applyWorkflow',
  'workflow:list',
  'approval:respond',
  'approval:pending',
  'artifacts:list',
  'artifacts:reveal',
  'files:contextMenu',
  'artifacts:open',
  'artifacts:readDataUrl',
  'telemetry:health',
  'telemetry:history',
  'control:state',
  'control:refresh',
  'control:load',
  'control:unload',
  'control:cancelLoad',
  'control:getConfig',
  'edit:list',
  'edit:pickSources',
  'edit:createFromPath',
  'edit:setInstruction',
  'edit:setParams',
  'edit:refine',
  'edit:setPrompt',
  'edit:apply',
  'edit:cancel',
  'edit:delete',
  'code:activity',
  'code:touched',
  'code:readFile',
  'live:start',
  'live:stop',
  'live:status',
  'live:settings',
  'live:updateSettings',
  'live:utterance',
  'live:interrupt',
  'live:exchanges',
  'live:voices',
  'code:listDir',
  'browser:watch',
  'skills:list',
  'skills:refresh',
  'skills:setEnabled',
  'skills:read',
  'skills:reveal'
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
  'event:log',
  'event:avatarBuild',
  'event:menuCommand',
  'event:controlState',
  'event:loadProgress',
  'event:editJob',
  'event:editJobDeleted',
  'event:fileActivity',
  'event:liveStatus',
  'event:liveAudio',
  'event:liveExchange',
  'event:skills',
  'event:browserFrame',
  'event:browserMirror'
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
