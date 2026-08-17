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
  | 'live'
  | 'code'
  | 'image'
  | 'edit'
  | 'audio'
  | 'docs'
  | 'research'
  | 'data'

/** Which optional right-hand panel a workflow shows. */
export type PanelKind =
  | 'none'
  | 'transcript'
  | 'files'
  | 'gallery'
  | 'edits'
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
  /**
   * The model this kind of work actually wants, from Adam's own assessment of
   * his models. Advisory only: used when that model is already resident, and
   * otherwise surfaced as a one-click suggestion. Switching workflows must never
   * silently evict a 17GB model — this box holds one large model at a time, so
   * an automatic load is a decision with a real cost.
   */
  preferredModel?: string
}

export interface SamplingDefaults {
  temperature: number
  topP: number
  /** Cap on generated tokens. Reasoning models burn budget on reasoning_content,
   *  so this is deliberately generous — see maxTokens notes in ARCHITECTURE.md. */
  maxTokens: number
  /**
   * Passed through as OpenAI `reasoning_effort`. Omit to leave the model's own
   * default alone.
   *
   * `'none'` matters enormously for anything latency-sensitive. Measured on
   * gemma-4-e4b: with reasoning at its default the first SPEAKABLE word arrives
   * at 3,946ms; with `reasoning_effort: 'none'` it arrives at 312ms — the same
   * answer, 12.6x sooner. In a spoken conversation the difference is between
   * natural and unusable. (`chat_template_kwargs: {reasoning: 'off'}` does NOT
   * work — it still reasoned. Only `reasoning_effort` took effect.)
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
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
/* Live voice/video conversation (Live workflow)                       */
/* ------------------------------------------------------------------ */

/**
 * A spoken turn is a pipeline, not a chat message: capture -> transcribe ->
 * generate -> speak. Each stage is local except generation, which runs on the
 * Studio.
 *
 * Audio is transcribed here rather than sent to the model, because LM Studio's
 * API rejects audio content parts outright ("must be either 'text' or
 * 'image_url'"). Video is different — image parts ARE accepted — so camera
 * frames go to the model directly when it is a VLM.
 */
export type LiveSessionState =
  | 'off'
  | 'starting'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error'

export interface LiveSessionStatus {
  state: LiveSessionState
  /** Mic level 0..1, for the meter. */
  level: number
  /** True while speech is detected above the threshold. */
  userSpeaking: boolean
  micEnabled: boolean
  videoEnabled: boolean
  /** What the user last said, as transcribed. */
  lastUserText: string
  /** The assistant's text for the current or last turn. */
  assistantText: string
  /** Turns completed this session. */
  turns: number
  error?: string
  timings: LiveTurnTimings | null
}

/** Where the wall-clock actually goes in a spoken turn. The number that decides
 *  whether it feels like a conversation is `firstAudioMs`. */
export interface LiveTurnTimings {
  /** Speech end to transcript. */
  sttMs: number
  /** Request sent to first token. */
  ttftMs: number
  /** First sentence handed to TTS to audio ready. */
  ttsMs: number
  /** Speech end to the first audio the user hears. */
  firstAudioMs: number
  totalMs: number
}

export interface LiveSettings {
  /** Kokoro voice id. */
  voice: string
  speed: number
  /** RMS above which audio counts as speech, 0..1. */
  vadThreshold: number
  /** Silence, in ms, that ends a turn. */
  silenceMs: number
  /** Ignore bursts shorter than this — a cough is not a turn. */
  minUtteranceMs: number
  /** Send a camera frame with each turn. */
  video: boolean
  /** Stop speaking as soon as the user starts. */
  bargeIn: boolean
  /** Speak replies at all. Off makes it a dictation loop. */
  speak: boolean
}

/** One completed exchange, for the transcript rail. */
export interface LiveExchange {
  id: string
  userText: string
  assistantText: string
  /** data: URL of the frame sent with this turn, when video was on. */
  frameDataUrl?: string
  timings: LiveTurnTimings | null
  at: number
}

/** A chunk of synthesised speech for the renderer to play, in order. */
export interface LiveAudioChunk {
  turnId: string
  seq: number
  /** data: URL — the renderer cannot read the filesystem. */
  dataUrl: string
  /** The sentence this chunk speaks, for the caption. */
  text: string
  /** True on the final chunk of a turn. */
  last: boolean
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

/**
 * A Claude-style skill: a folder with a SKILL.md carrying `name` and
 * `description` frontmatter.
 *
 * The cost model is the whole point. Only name + description reach the prompt,
 * which is a few dozen tokens for the whole catalogue; the body is read only
 * when the model calls `use_skill`. That is why a skill is nearly free and an
 * MCP server is not — a server's schemas are re-sent on every message.
 */
export interface Skill {
  /** Frontmatter name, falling back to the folder name. */
  name: string
  description: string
  /** Absolute path of the SKILL.md. */
  path: string
  /** Directory holding it, so relative references in the body resolve. */
  dir: string
  /** Which root it was found under, for display and de-duplication. */
  source: string
  /** Body length, as a rough guide to what invoking it will cost. */
  bodyChars: number
  /** Tokens the catalogue entry adds to every message (name + description). */
  catalogTokens: number
  enabled: boolean
}

/* ------------------------------------------------------------------ */
/* File tree (Code workflow)                                           */
/* ------------------------------------------------------------------ */

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  /** Bytes, for files. */
  size: number
  modifiedAt: number
  /** True when the name matches a conventionally ignored directory. */
  ignored: boolean
}

/* ------------------------------------------------------------------ */
/* Live file activity (Code workflow)                                  */
/* ------------------------------------------------------------------ */

/**
 * Emitted by the tool executor as work happens, so the Code workspace can show
 * the agent operating rather than reporting afterwards. Separate from ToolCall
 * on purpose: a ToolCall is a record of a request, this is a stream of effects
 * on the filesystem, and the UI wants the second one.
 */
export type FileOpKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'list'
  | 'glob'
  | 'grep'
  | 'shell'

export type FileOpPhase = 'start' | 'progress' | 'done' | 'error'

export interface FileActivity {
  id: string
  conversationId: string
  kind: FileOpKind
  phase: FileOpPhase
  /** Absolute path for file ops; the command for shell; the pattern for search. */
  target: string
  /** Path relative to the nearest workspace root, for display. */
  displayPath: string
  /** Unified diff, on write/edit once the change is known. */
  diff?: string
  added?: number
  removed?: number
  /** 1-based line numbers touched, so the viewer can scroll to and mark them. */
  changedLines?: number[]
  /** Full file text after the change, for the viewer. Omitted for large files. */
  content?: string
  /** Result summary for non-file ops (match count, exit code). */
  summary?: string
  error?: string
  at: number
  durationMs?: number
}

/** A file the agent has touched this session, for the workspace's tab strip. */
export interface TouchedFile {
  path: string
  displayPath: string
  lastKind: FileOpKind
  added: number
  removed: number
  touches: number
  lastAt: number
}

/* ------------------------------------------------------------------ */
/* Image editing workflow                                              */
/* ------------------------------------------------------------------ */

/**
 * The Edit workflow is a deterministic two-stage pipeline, not a tool-calling
 * chat turn: refine, then render. That is deliberate — the output is a fixed
 * triptych (source, prompt, result) and a model deciding for itself whether to
 * call a tool cannot guarantee one.
 *
 * Stage 1 sends the actual image to a vision model on the Studio and asks it to
 * turn the user's words into a proper edit prompt. Stage 2 hands that prompt to
 * comfy-image's `edit_image` with `confirm: true`, which makes the server use it
 * VERBATIM instead of running its own local-VLM rewrite over it again.
 */
/**
 * The single source of truth for what counts as an editable source image.
 *
 * Three separate lists used to disagree — the drop zone, the file dialog and the
 * pipeline — so a file could pass one gate and be rejected silently by another.
 * Dropping an iPhone .heic did nothing at all on screen. Everything derives from
 * here now.
 */
export const EDIT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

export const EDIT_IMAGE_EXTENSIONS = Object.keys(EDIT_IMAGE_MIME)

export type EditJobStatus =
  | 'draft'
  | 'refining'
  | 'ready'
  | 'rendering'
  | 'done'
  | 'error'

export interface EditParams {
  /**
   * img2img strength, 0.1..1.0. The only control over how much of the original
   * survives; comfy-image defaults to 0.6.
   */
  denoise: number
  /** Sampling steps; comfy-image defaults to 8. */
  steps: number
  /** Omit for a random seed. Kept when the user wants a reproducible re-run. */
  seed?: number
}

export interface EditJob {
  id: string
  /** Absolute path of the source image on disk — comfy-image needs a path,
   *  image bytes cannot travel through a tool call. */
  sourcePath: string
  sourceName: string
  /** data: URL so the renderer can show the source without disk access. */
  sourceDataUrl?: string
  /** What the user actually typed. Never overwritten. */
  userInstruction: string
  /** What the vision model produced from it. Editable before rendering. */
  refinedPrompt: string | null
  /** True once the user has hand-edited the refined prompt. */
  promptEdited: boolean
  outputPath?: string
  outputDataUrl?: string
  status: EditJobStatus
  error?: string
  params: EditParams
  timings?: { refineMs?: number; renderMs?: number }
  /** Set when this job was started from another job's output, so the UI can
   *  show an iteration chain. */
  parentId?: string
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Remote model control                                                */
/* ------------------------------------------------------------------ */

/**
 * Model management talks to LM Studio's websocket API, not the REST one.
 * `/api/v0` and `/api/v1` are read-only — there is no load/unload over HTTP.
 * The websocket must address the Studio's real LM Studio port DIRECTLY: the
 * relay in front of it is a Python BaseHTTP server, which answers 200 to a
 * websocket upgrade instead of 101.
 */
export type ControlStatus = 'disconnected' | 'connecting' | 'connected' | 'unavailable'

/** One model currently resident on the server. */
export interface LoadedInstance {
  /** The handle unload takes. */
  identifier: string
  instanceReference: string
  modelKey: string
  displayName: string
  publisher: string
  architecture: string
  format: string
  quantization: string
  quantBits: number | null
  sizeBytes: number
  paramsString: string
  /** The window it was actually loaded with. */
  contextLength: number
  /** Architectural ceiling. */
  maxContextLength: number
  vision: boolean
  trainedForToolUse: boolean
  /** Idle eviction, ms. Null means it stays until unloaded. */
  ttlMs: number | null
  lastUsedTime: number | null
}

/** A model available on the server, loaded or not. */
export interface CatalogModel {
  modelKey: string
  displayName: string
  publisher: string
  architecture: string
  /** 'gguf' | 'mlx' */
  format: string
  quantization: string
  sizeBytes: number
  paramsString: string
  maxContextLength: number
  vision: boolean
  trainedForToolUse: boolean
  /** Quant variants, e.g. ["qwen/qwen3.6-27b@q4_k_xl", "...@q5_k_xl"]. */
  variants: string[]
  selectedVariant: string | null
  /** Identifiers of any resident instances of this model. */
  loadedIdentifiers: string[]
}

/** The knobs the load screen exposes. Everything is optional — an omitted
 *  field means "let the server decide", which is not the same as a default. */
export interface LoadOptions {
  contextLength?: number
  /** llama.cpp only. Required before a quantized V cache will load. */
  flashAttention?: boolean
  /** llama.cpp K/V cache quantization, e.g. 'q8_0' | 'q4_0' | 'f16'. */
  kCacheQuantization?: string
  vCacheQuantization?: string
  cpuThreadPoolSize?: number
  /** 0..1 fraction of layers on GPU. */
  gpuOffloadRatio?: number
  /** Idle eviction in ms; null/omitted keeps it resident. */
  ttlMs?: number
  /**
   * Let the engine pick the context length. On MLX this historically overrode
   * whatever was asked for, so the screen surfaces it explicitly rather than
   * leaving the user to wonder why their number was ignored.
   */
  autoFit?: boolean
}

/** Progress while a load is in flight. */
export interface LoadProgress {
  modelKey: string
  /** 0..1, from the server's own load progress. */
  progress: number
  phase: 'resolving' | 'loading' | 'done' | 'error'
  message?: string
}

export interface ControlState {
  status: ControlStatus
  /** ws:// URL in use, for display and troubleshooting. */
  url: string
  loaded: LoadedInstance[]
  catalog: CatalogModel[]
  /** Non-null while a load is running. */
  inFlight: LoadProgress | null
  error?: string
  lastRefreshedAt: number
}

/** A raw config field as LM Studio reports it, for the advanced readout. */
export interface ConfigField {
  key: string
  value: unknown
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
