/**
 * LocalHarness shared contract.
 *
 * This file is the single source of truth for every type that crosses the
 * main <-> preload <-> renderer boundary. Main-process subsystems and renderer
 * components both import from here; nothing else is shared between them.
 *
 * Keep it dependency-free (no electron, no node builtins) so both the Node and
 * the DOM tsconfig can include it.
 */

/* ------------------------------------------------------------------ */
/* Workflows / profiles                                                */
/* ------------------------------------------------------------------ */

/** The workflow the user is currently in. Drives UI layout, system prompt,
 *  native tool availability and which MCP servers are spawned. */
export type WorkflowId =
  | 'chat'
  | 'code'
  | 'image'
  | 'audio'
  | 'docs'
  | 'research'
  | 'data'

/** Which optional right-hand panel a workflow shows. */
export type PanelKind =
  | 'none'
  | 'files'
  | 'gallery'
  | 'audio'
  | 'documents'
  | 'sources'
  | 'tables'

export interface WorkflowDefinition {
  id: WorkflowId
  /** Human label shown in the switcher. */
  label: string
  /** One-line description shown under the label. */
  blurb: string
  /** Single emoji or short glyph used as the switcher icon. */
  glyph: string
  /** Accent colour (CSS colour string) used to tint the workflow chrome. */
  accent: string
  /** MCP server ids enabled by default in this workflow. */
  mcpServers: string[]
  /** Native (in-process) tool ids enabled by default in this workflow. */
  nativeTools: NativeToolId[]
  /** Which contextual panel to render alongside the conversation. */
  panel: PanelKind
  /** Workflow-specific system prompt appended to the base prompt. */
  systemPrompt: string
  /** Sampling defaults that suit this kind of work. */
  sampling: SamplingDefaults
  /** Quick-start prompts offered on an empty conversation. */
  suggestions: string[]
}

export interface SamplingDefaults {
  temperature: number
  topP: number
  /** Cap on generated tokens. Reasoning models burn budget on reasoning_content,
   *  so this is deliberately generous — see maxTokens notes in ARCHITECTURE.md. */
  maxTokens: number
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export type McpServerStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopping'

/** Static description of an MCP server LocalHarness knows how to run. */
export interface McpServerSpec {
  id: string
  label: string
  /** What the server is for, shown in the MCP panel. */
  blurb: string
  command: string
  args: string[]
  env: Record<string, string>
  /** Milliseconds to allow a single tools/call. Image and audio generation
   *  need minutes, not the MCP SDK's 60s default. */
  callTimeoutMs: number
  /** Measured token cost of this server's tools/list output, used to show the
   *  prefill budget. Refreshed at runtime once tools are actually discovered. */
  estimatedTokens: number
  /** If false the server is never auto-started, only started on demand. */
  autoStart: boolean
}

export interface McpToolInfo {
  /** Unique across all servers: `${serverId}__${name}`. */
  qualifiedName: string
  serverId: string
  name: string
  description: string
  inputSchema: JsonSchema
  /** Measured token cost of this single tool's schema. */
  tokens: number
  /** User can disable individual tools to trim payload further. */
  enabled: boolean
}

export interface McpServerState {
  id: string
  status: McpServerStatus
  /** Populated once the server has completed initialize + tools/list. */
  tools: McpToolInfo[]
  /** Sum of `tokens` over enabled tools, plus protocol overhead. */
  tokenCost: number
  error?: string
  pid?: number
  startedAt?: number
  /** ms taken by the last successful initialize + tools/list. */
  handshakeMs?: number
}

/* ------------------------------------------------------------------ */
/* Native tools                                                        */
/* ------------------------------------------------------------------ */

export type NativeToolId =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'run_shell'

export type ApprovalMode = 'always_ask' | 'auto_read' | 'auto_all'

export interface NativeToolInfo {
  id: NativeToolId
  name: string
  description: string
  inputSchema: JsonSchema
  /** True for tools that modify the filesystem or run commands. */
  mutating: boolean
  tokens: number
}

/** A pending permission request surfaced to the renderer. */
export interface ApprovalRequest {
  id: string
  conversationId: string
  toolName: string
  /** Short human summary, e.g. "Write src/index.ts (+42 -0)". */
  summary: string
  /** Arguments, pretty-printed for review. */
  argsPreview: string
  /** Unified diff when the tool would change a file. */
  diff?: string
  /** Shell command when the tool would run one. */
  command?: string
  mutating: boolean
  createdAt: number
}

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny'

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON arguments as emitted by the model (may be partial while streaming). */
  arguments: string
  /** Where this tool lives, for UI grouping and routing. */
  origin: 'native' | 'mcp'
  status: 'pending' | 'awaiting_approval' | 'running' | 'ok' | 'error' | 'denied'
  result?: string
  /** Non-text results (images, audio, files) the tool produced. */
  artifacts?: Artifact[]
  error?: string
  startedAt?: number
  finishedAt?: number
}

export type ArtifactKind = 'image' | 'audio' | 'document' | 'data' | 'link'

export interface Artifact {
  id: string
  kind: ArtifactKind
  /** Absolute path on disk, when the artifact is a file. */
  path?: string
  /** file:// or http(s):// URL the renderer can load. */
  url?: string
  mimeType?: string
  label: string
  /** Free-form details shown in the panel (dimensions, duration, row count...). */
  meta?: Record<string, string | number>
  createdAt: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  /** Separate channel for models that emit reasoning_content. */
  reasoning?: string
  toolCalls?: ToolCall[]
  /** For role === 'tool', which call this responds to. */
  toolCallId?: string
  attachments?: Attachment[]
  createdAt: number
  /** Per-message telemetry, filled in when the turn completes. */
  metrics?: TurnMetrics
  /** True while tokens are still arriving. */
  streaming?: boolean
  error?: string
}

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  path: string
  name: string
  mimeType: string
  /** data: URL for images so the renderer can preview without disk access. */
  dataUrl?: string
  /** Estimated token cost of including this attachment. */
  tokens: number
}

export interface Conversation {
  id: string
  title: string
  workflowId: WorkflowId
  messages: ChatMessage[]
  /** Model id this conversation is pinned to, or null to follow the resident model. */
  modelId: string | null
  createdAt: number
  updatedAt: number
  /** Per-conversation overrides of the workflow's MCP selection. */
  mcpOverrides?: Record<string, boolean>
}

export interface ConversationSummary {
  id: string
  title: string
  workflowId: WorkflowId
  messageCount: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string
  publisher: string
  /** 'llm' | 'vlm' | 'embeddings' as reported by LM Studio. */
  type: string
  arch: string
  quantization: string
  /** 'gguf' | 'mlx' */
  compatibilityType: string
  /** Architectural ceiling. Do NOT use as the context denominator. */
  maxContextLength: number
  /**
   * The real window, reported only while the model is resident. Null when the
   * model is not loaded — in that case the UI must not invent a number.
   */
  loadedContextLength: number | null
  state: 'loaded' | 'not-loaded' | 'loading' | string
  capabilities: string[]
  supportsVision: boolean
  supportsTools: boolean
}

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

/** Phase of the current in-flight request. */
export type InferencePhase = 'idle' | 'queued' | 'prefill' | 'decode' | 'tool'

/** Live, per-request telemetry pushed to the renderer at ~4Hz. */
export interface LiveMetrics {
  phase: InferencePhase
  /** Model the in-flight request was sent to. */
  modelId: string | null
  /** ms since the request left the client. */
  elapsedMs: number
  /** Prompt tokens we sent (our own count, known before the reply). */
  promptTokens: number
  /** Tokens generated so far this turn. */
  completionTokens: number
  /** Measured time to first token, ms. Null until the first token lands. */
  ttftMs: number | null
  /**
   * Prefill throughput, tokens/sec. Derived as promptTokens / ttft once the
   * first token arrives; before that it is the calibrated estimate.
   */
  prefillTps: number | null
  /** True while prefillTps is an estimate rather than a measurement. */
  prefillEstimated: boolean
  /** Estimated fraction of prefill complete, 0..1. Estimate only — the OpenAI
   *  wire protocol carries no prefill progress. Null when not estimable. */
  prefillProgress: number | null
  /** Estimated seconds remaining in prefill. */
  prefillEtaMs: number | null
  /** Decode throughput, tokens/sec, over a rolling window. */
  decodeTps: number | null
}

/** Metrics attached to a completed assistant message. */
export interface TurnMetrics {
  modelId: string
  promptTokens: number
  completionTokens: number
  /** reasoning_content tokens, when the model reports or we can infer them. */
  reasoningTokens?: number
  ttftMs: number
  totalMs: number
  prefillTps: number
  decodeTps: number
  /** How many of the prompt tokens were tool schemas. */
  toolSchemaTokens: number
  /** Whether the numbers came from the Lab feed or our own measurement. */
  source: 'client' | 'lab'
  finishReason?: string
}

/** Rolling context accounting for the active conversation. */
export interface ContextUsage {
  /** Tokens currently in the conversation window (messages + tools + system). */
  used: number
  /** The real loaded window, or null when unknown — render "—", never a guess. */
  max: number | null
  /** Breakdown so the user can see what is eating the window. */
  breakdown: {
    system: number
    tools: number
    messages: number
    attachments: number
  }
  /** used / max, or null when max is unknown. */
  fraction: number | null
}

/** A completed request as reported by the Mac Studio's LM Studio Lab feed. */
export interface LabRecord {
  ts: number
  source: string
  model: string
  tps: number
  ttft: number
  prefillTps: number
  inTokens: number
  outTokens: number
  ctxMax: number
  streamed: boolean
}

export type LabStatus = 'disconnected' | 'connecting' | 'connected' | 'unavailable'

/** Aggregate health of everything the app talks to. */
export interface ServerHealth {
  /** OpenAI-compatible endpoint currently in use. */
  endpoint: string
  reachable: boolean
  /** Round-trip of the last /api/v0/models poll, ms. */
  latencyMs: number | null
  /** The model LM Studio currently has resident, if any. */
  residentModelId: string | null
  labStatus: LabStatus
  lastCheckedAt: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export interface Settings {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:1235/v1 */
  baseUrl: string
  /** LM Studio native API root for /api/v0/models, e.g. http://host:1234 */
  nativeApiUrl: string
  /** LM Studio Lab root that serves /lab/events, or '' to disable. */
  labUrl: string
  apiKey: string
  /** Pinned model, or null to follow whatever is resident. */
  defaultModelId: string | null
  approvalMode: ApprovalMode
  /** Directories the agent tools are allowed to touch. */
  workspaceRoots: string[]
  /** Shell commands that never need approval (exact prefix match). */
  shellAllowlist: string[]
  /** Warn when the assembled prompt exceeds this fraction of the window. */
  contextWarnFraction: number
  theme: 'dark' | 'light' | 'system'
  /** Poll interval floor for /api/v0/models, ms. Backs off when idle. */
  modelPollMs: number
  /** Per-workflow MCP server overrides that survive restarts. */
  workflowMcpOverrides: Partial<Record<WorkflowId, string[]>>
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/** Minimal JSON Schema shape. Deliberately loose — we relay server schemas
 *  verbatim and only walk them for token counting and sanitising. */
export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  required?: string[]
  description?: string
  enum?: unknown[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  [key: string]: unknown
}

/** Wire shape for a tool as sent to the model. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface SendMessageRequest {
  conversationId: string
  content: string
  attachments?: Attachment[]
}

export interface AppError {
  code: string
  message: string
  detail?: string
}
