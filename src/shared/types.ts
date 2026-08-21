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
  | 'converse'
  | 'booker'
  | 'clinic'
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
  /** Everything the conversation produced, newest first — images, audio,
   *  documents, data. By recency rather than by type: what you want is almost
   *  always the thing just made, and sorting by kind buries it. */
  | 'outputs'
  | 'flights'
  | 'files'
  | 'gallery'
  | 'edits'
  | 'audio'
  | 'documents'
  | 'sources'
  | 'tables'
  | 'health'

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
  /**
   * What to do first, in one sentence, for someone looking at this workflow
   * with nothing in it yet.
   *
   * Required, not optional: the empty state used to repeat `label` and `blurb`,
   * both of which are already on screen in the sidebar a couple of hundred
   * pixels away, so the one moment a user is deciding what to ask was spent
   * telling them what they had already read. Making this mandatory means a new
   * workflow cannot ship without answering the question.
   */
  firstMove: string
  /**
   * Skills this workflow offers, by name. Omit to offer every enabled skill.
   *
   * Skills were global, so `web-game-dev` and `photography` were advertised in
   * Research and Data alongside everything else — and asked what it could do,
   * the model in Research answered that it could design interfaces and develop
   * games. It believed the catalogue over the workflow. Each workflow is
   * supposed to be one coherent function; the skills on offer have to say the
   * same thing as the tools.
   */
  skills?: string[]
  /**
   * Optional per-server tool allowlist: `{ gmail: ['read_email'] }` offers only
   * those tools from that server. Servers absent from this map are offered
   * whole.
   *
   * Two jobs, both load-bearing. Payload: gmail alone is 19 tools and 3,245
   * tokens, and a workflow that only ever reads mail should not pay for filter
   * management on every turn. Safety: a spoken turn cannot show an approval
   * dialog, so Live must not be handed `send_email` or `delete_email` at all —
   * withholding the schema is the gate.
   */
  mcpTools?: Record<string, string[]>
  /** Native (in-process) tool ids enabled by default in this workflow. */
  nativeTools: NativeToolId[]
  /**
   * Whether this workflow is SPOKEN — driven by LiveSession rather than by a
   * typed turn in the Orchestrator.
   *
   * Load-bearing rather than cosmetic. A spoken turn cannot show an approval
   * dialog and cannot run native tools, so `live:start` refuses a workflow
   * that is not marked here; and the renderer picks the workspace from this
   * rather than from a list of ids, which is what let Flight Booker fall back
   * into Live's chair.
   */
  voice?: boolean
  /**
   * This workflow's chat screen offers push-to-talk.
   *
   * Distinct from `voice`, and the difference is the whole point. `voice` means
   * the workflow IS spoken and gets the orb as its main pane. `talk` means an
   * ordinary typed workflow that can ALSO be spoken to, without leaving the
   * conversation: the same thread, the same panel, one extra control in the
   * composer.
   *
   * Opt-in per workflow, deliberately, because a spoken turn is not a typed one
   * with a microphone attached. Two things about it are load-bearing:
   *
   *   It cannot show an approval dialog. There is no way to ask "are you sure"
   *   to someone who is talking, so every MCP tool this workflow exposes will
   *   run unasked. Only set this where that is true of all of them.
   *
   *   It has no native tools at all. The spoken loop wires MCP tools only, so a
   *   workflow with `nativeTools` can do strictly less by voice than by typing.
   *   That is safe — it can only ever narrow — but the model is told so, or it
   *   offers to read a file it has no way to read.
   *
   * Which is why Code and Docs do not have it and should not: they write files
   * and run shells, and the approval gate is the reason that is acceptable.
   */
  talk?: boolean
  /**
   * A tool the app calls on this workflow's own MCP server when a session
   * opens, with `{ id: conversationId }`.
   *
   * Declared here rather than special-cased in the session, because "this
   * workflow keeps per-conversation state on its server" is a property of the
   * workflow. The tool is deliberately one the model is never offered.
   */
  sessionHook?: { server: string; tool: string }
  /** Which contextual panel to render alongside the conversation. */
  panel: PanelKind
  /** Workflow-specific system prompt appended to the base prompt. */
  systemPrompt: string
  /** Sampling defaults that suit this kind of work. */
  sampling: SamplingDefaults
  /** Quick-start prompts offered on an empty conversation. */
  /**
   * Fixed starters. Workflows wanting a generated set instead register one in
   * STARTER_GENERATORS — a function CANNOT live on this object, because the
   * whole definition crosses IPC by structured clone in `app:getBootstrap`, and
   * a function makes that throw "An object could not be cloned", which hangs
   * the renderer on its splash with no error on screen.
   */
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

/**
 * How much the model should think before answering.
 *
 * Ordered least to most. 'none' is the biggest single latency lever there is —
 * measured on gemma-4-e4b it takes the first spoken word from 3.9s to 0.3s.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** The sampler settings a user may override per workflow. Deliberately a
 *  subset of SamplingDefaults: reasoningEffort has its own control, and the
 *  system prompt is not a slider. */
export interface SamplingOverrides {
  temperature: number
  topP: number
  topK: number
  minP: number
  frequencyPenalty: number
  presencePenalty: number
  maxTokens: number
}

export interface SamplingDefaults {
  /** See ChatRequest — measured levers against runaway reasoning. */
  frequencyPenalty?: number
  presencePenalty?: number
  repetitionPenalty?: number
  temperature: number
  topP: number
  /**
   * Nucleus sampling's companion, and the one Qwen actually specify for
   * thinking mode (top_k 20). It was never plumbed through this app at all,
   * so the value in a workflow definition would have been silently ignored.
   */
  topK?: number
  /** Qwen specify min_p 0 for thinking mode. Never sent before either. */
  minP?: number
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
  reasoningEffort?: ReasoningEffort
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
  | 'serve_dir'

/**
 * What a shell run actually did, separate from how the result was worded.
 *
 * Carried on the tool call so a collapsed card can say "exit 1" without
 * scraping the text block written for the model. A shell-heavy run was
 * previously unreadable at a glance: sixteen identical grey rows, every one of
 * which had to be expanded to find out whether it worked.
 */
export interface ShellResultFacts {
  kind: 'shell'
  /** Null when the process was killed rather than exiting. */
  exitCode: number | null
  timedOut: boolean
  /** The most informative single line: an error if there was one, else output. */
  headline: string
  /** True when `headline` came from stderr, so the card can colour it. */
  headlineFromStderr: boolean
  stdoutLines: number
  stderrLines: number
}

/** What `serve_dir` started, for the card and the workspace panel. */
export interface ServeResultFacts {
  kind: 'serve'
  origin: string
  /** Directory being served, relative to the workspace root when possible. */
  displayPath: string
  /** Absolute URLs of the HTML pages found at the top level. */
  pages: string[]
  /** True when this directory was already being served. */
  reused: boolean
}

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
  /**
   * Live progress for a long-running tool, 0..1, or null when the server
   * reports steps without a total.
   *
   * A local ComfyUI render takes one to two minutes and used to show a static
   * dot for all of it, which is indistinguishable from a hang. The servers were
   * already emitting per-step progress; the app simply never asked for it.
   */
  progressFraction?: number | null
  /** The server's own phrase, e.g. "Composing - step 3 of 8". */
  progressMessage?: string
  id: string
  name: string
  /** Raw JSON arguments as emitted by the model (may be partial while streaming). */
  arguments: string
  /** Where this tool lives, for UI grouping and routing. */
  origin: 'native' | 'mcp'
  status: 'pending' | 'awaiting_approval' | 'running' | 'ok' | 'error' | 'denied'
  result?: string
  /**
   * The server's structured result, when it returned one alongside the prose.
   *
   * This is what a panel draws from. The `result` string is written for the
   * model to read aloud; parsing it in the UI would couple the display to a
   * sentence that exists to be reworded.
   */
  structured?: unknown
  /** Non-text results (images, audio, files) the tool produced. */
  artifacts?: Artifact[]
  error?: string
  /**
   * When the model first named this call — not when it started running.
   *
   * `startedAt` is stamped at execution, which on this backend can be minutes
   * after the call appears: LM Studio buffers a tool call's arguments and sends
   * them in one piece when they are finished, so a file-sized argument shows a
   * named call and then nothing at all. Without this there is no honest way to
   * say how long the model has been composing.
   */
  openedAt?: number
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
  /**
   * The artifact this one follows, for take-to-take lineage.
   *
   * Audio needs it because a song is refined by rendering again — there is no
   * audio-to-audio path — so the only thing connecting take 2 to take 1 is a
   * pointer and a recorded diff of the parameters. Mirrors EditJob.parentId.
   */
  parentId?: string
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
  /**
   * The turn ended because it used up its step budget, not because the model
   * was done. Set only by the orchestrator's cap exit; the UI offers to carry
   * on from it, so it must never be inferred from the error text.
   */
  stoppedAtCap?: boolean
  error?: string
}

/**
 * Image formats LM Studio's vision endpoint will actually accept.
 *
 * Measured against the server, not assumed: png, jpeg and gif are taken; webp,
 * bmp and svg are refused with
 *
 *   {"error":"'url' field must be a base64 encoded image."}
 *
 * which names the wrong thing — the URL is a perfectly well-formed base64 data
 * URL, and the objection is to the FORMAT inside it. Anything outside this set
 * is converted before it goes near the wire.
 */
export const WIRE_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif']

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
  /** Messages dropped from this conversation's history to fit the context
   *  window, cumulative. Shown in the UI so the loss is visible rather than
   *  silent; it does not change what is stored, only what is sent. */
  trimmedMessages?: number
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

/** One OpenAI-compatible server the app can send turns to. */
export interface LlmEndpoint {
  /** Stable key; also the prefix that disambiguates duplicate model ids. */
  id: string
  /** Shown in the picker so two builds of one model are tellable apart. */
  label: string
  /** Root including /v1. */
  baseUrl: string
}

export interface ModelInfo {
  id: string
  /**
   * Which server this model came from, and where to send its turns.
   *
   * Required because ids are NOT unique across endpoints — a Mac Studio running
   * LM Studio on one port and a separate MLX server on another will happily
   * offer `qwen/qwen3.8-27b` from both, and they are different builds with
   * different speeds. Everything that resolves or routes a model has to carry
   * the endpoint with it.
   */
  endpointId: string
  endpointLabel: string
  baseUrl: string
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
  /** Running an MCP tool mid-turn. Distinct from 'thinking' because it is the
   *  one pause the user cannot attribute to the model, and an unexplained
   *  silence in a conversation reads as a failure. */
  | 'tool'
  | 'speaking'
  | 'error'

export interface LiveSessionStatus {
  state: LiveSessionState
  /**
   * Always 0. Do NOT draw a meter from this.
   *
   * It reads like the mic level and is not: the level is measured in the
   * RENDERER by the audio worklet, and main never learns it, so this is set to
   * 0 when a session starts and never touched again. Two separate meters were
   * built against it — the panel orb and the composer's bars — and both sat
   * perfectly still through entire calls while looking like working code.
   *
   * The live value is `micLevel` in the renderer store, published from the
   * capture loop. Kept here rather than deleted because it is part of the
   * status wire shape, but named as the trap it is.
   */
  level: number
  /** True while speech is detected above the threshold. */
  userSpeaking: boolean
  micEnabled: boolean
  videoEnabled: boolean
  /** What the user last said, as transcribed. */
  lastUserText: string
  /** The assistant's text for the current or last turn. */
  assistantText: string
  /**
   * The model's reasoning for the current turn, as it arrives.
   *
   * Shown, never spoken. During a spoken turn the only signal that anything is
   * happening is silence, and silence reads as a crash — this is what turns a
   * dead pause into a visible one.
   */
  reasoningText: string
  /** Turns completed this session. */
  turns: number
  /** Names of the tools running right now; empty unless `state` is 'tool'. */
  toolLabel: string
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

/**
 * A named voice, so the picker reads as characters rather than Kokoro ids.
 * `id` is the actual Kokoro voice; everything else is presentation.
 */
export interface VoicePreset {
  id: string
  label: string
  /** One line on who this sounds like. */
  note: string
  /** Kokoro speaks a touch fast for some characters. */
  speed: number
}

export interface LiveSettings {
  /** Kokoro voice id. */
  voice: string
  speed: number
  /** RMS above which audio counts as speech, 0..1. */
  vadThreshold: number
  /** Silence, in ms, that ends a turn. */
  silenceMs: number
  /**
   * Extra silence tolerated AFTER `silenceMs` before the turn is sent.
   *
   * Separate from silenceMs rather than folded into it, because the two are
   * different decisions with different costs. silenceMs is "has he stopped
   * making sound"; this is "has he finished the sentence". Mid-sentence pauses
   * while someone thinks of a word run to about half a second, and cutting in
   * there sends half a question and answers it confidently.
   *
   * The grace is VISIBLE — the orb holds a distinct state through it — so a
   * long setting reads as the app waiting rather than as the app being slow.
   */
  pauseGraceMs: number
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
  | 'serve'

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

/**
 * The two genuinely different things the word "edit" can mean here.
 *
 * `instruction` hands the renderer the photo as latent conditioning and your
 * words as the change to make, so everything you did not mention is held by the
 * conditioning rather than by luck. `restyle` is img2img: the photo becomes a
 * partially-noised canvas and is re-rendered against a description, which is
 * the right tool for "make this a watercolour" and the wrong one for "change
 * the bowl and leave my dog alone".
 *
 * They are exposed as a choice rather than hidden because they need different
 * things from you -- a short instruction versus a full description -- and
 * seeing that is most of the lesson.
 */
export type EditMethod = 'instruction' | 'restyle'

export interface EditParams {
  /** Which kind of edit. Decides the renderer, and the brief stage 1 is given. */
  method: EditMethod
  /**
   * img2img strength, 0.1..1.0. `restyle` only: it is how much of the original
   * survives, and the instruction path has no equivalent knob because nothing
   * of the original is used as a canvas in the first place.
   */
  denoise: number
  /** Sampling steps. 4 suits the distilled edit model, 8 suits z-image. */
  steps: number
  /** Omit for a random seed. Kept when the user wants a reproducible re-run. */
  seed?: number
}

/** Per-method defaults, so switching method does not leave the other's numbers behind. */
export const EDIT_METHOD_DEFAULTS: Record<EditMethod, { steps: number; denoise: number }> = {
  instruction: { steps: 4, denoise: 0.6 },
  restyle: { steps: 8, denoise: 0.6 }
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
  /**
   * Which machine each stage is running on, as a label for the progress line.
   *
   * The two stages are not on the same box: refining goes to the chat endpoint
   * (often the Mac Studio), rendering goes to ComfyUI at comfy-image's
   * COMFY_HOST, which is loopback by default. Set when the stage starts, so the
   * UI states where the work is instead of assuming.
   */
  refineHost?: string
  renderHost?: string
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
  /**
   * The reasoning_effort actually sent for this turn.
   *
   * The footer showed how MANY reasoning tokens a turn spent but never the
   * setting that produced them, so the one number you would change to spend
   * fewer was the one number you could not see. It also makes a comparison
   * between two runs self-documenting rather than dependent on remembering
   * what the picker said at the time.
   */
  reasoningEffortUsed?: string
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
  /**
   * Per-workflow reasoning effort, overriding the workflow's own default.
   *
   * Exposed because reasoning tokens count against `max_tokens`: qwen once
   * spent all 8,192 of Code's output budget thinking and returned no answer at
   * all after eleven minutes. How hard a model should think is a judgement the
   * user makes per task, not something to bury in a profile.
   */
  /**
   * Extra OpenAI-compatible servers alongside `baseUrl`.
   *
   * `baseUrl` remains the primary — model control, the Lab feed and health all
   * point at it. These are additional sources of models to talk to, for a
   * separate MLX or llama.cpp server on another port.
   */
  extraEndpoints: LlmEndpoint[]
  workflowReasoning: Partial<Record<WorkflowId, ReasoningEffort>>
  /**
   * Per-workflow sampling overrides, on top of the workflow's own defaults.
   *
   * These were hardcoded and unreachable, which made the one class of problem
   * this app actually has — a model that thinks until its budget is gone —
   * impossible to work on from inside the app. Qwen publish a specific sampler
   * setup for thinking mode and it differs from what a workflow ships with;
   * without this, trying it meant editing source and rebuilding.
   *
   * Sparse on purpose: only what the user changed is stored, so a later change
   * to a workflow's defaults still reaches anyone who has not overridden it.
   */
  workflowSampling: Partial<Record<WorkflowId, Partial<SamplingOverrides>>>
  workflowMcpOverrides: Partial<Record<WorkflowId, string[]>>
  /**
   * Right-hand panel size, per KIND rather than per workflow.
   *
   * A gallery wants to be wide enough to show two thumbnails; a transcript rail
   * wants to be narrow. Those are properties of the panel, not of the workflow
   * that happens to be showing it — so Image and Edit, which both show pictures,
   * should not each need dragging to the same width.
   */
  panelLayout: Partial<Record<PanelKind, PanelLayout>>
  /**
   * The Live avatar shown instead of the orb, or null for the orb.
   *
   * Here rather than in LiveSettings, which reads like the natural home for it,
   * because LiveSettings is held in memory and never written to disk — voice
   * and speed already reset on every launch. A face you have to pick again
   * every time you open the app is worse than no face.
   */
  liveAvatarId: string | null
}

/* ------------------------------------------------------------------ */
/* Live avatar                                                         */
/* ------------------------------------------------------------------ */

/**
 * The frames an avatar is made of.
 *
 * Deliberately few. This is amplitude-driven lip sync, not phoneme-accurate
 * visemes: the audio gives a level, not a phoneme, so more mouth shapes than
 * the level can distinguish would be frames nobody ever sees. Four mouth
 * positions read as speech because the ear leads the eye — the mouth only has
 * to move plausibly IN TIME, not to form the right letter.
 *
 * `rest` is the only required one; everything else degrades to it, so a
 * half-built avatar still shows a face rather than nothing.
 */
export type AvatarFrame =
  | 'rest'
  | 'mouthSlight'
  | 'mouthMid'
  | 'mouthWide'
  | 'blink'
  | 'smile'
  | 'listening'

export const AVATAR_FRAMES: readonly AvatarFrame[] = [
  'rest',
  'mouthSlight',
  'mouthMid',
  'mouthWide',
  'blink',
  'smile',
  'listening'
]

/** What each frame is generated from, and what it is for at runtime. */
export interface AvatarFrameSpec {
  frame: AvatarFrame
  /** The edit instruction, applied to the base portrait. */
  instruction: string
  /** Shown in the builder while it renders. */
  label: string
}

/** One step of a build, as it happens. */
export interface AvatarBuildProgress {
  avatarId: string
  /** 0-based; `total` counts the base render too. */
  step: number
  total: number
  label: string
  status: 'working' | 'saved' | 'done' | 'error' | 'cancelled'
  error?: string
}

/** What the builder is asked for. */
export interface AvatarBuildSpec {
  name: string
  /** The look, in the user's own words. Style direction is added for them. */
  description: string
  /** Include smile and listening as well as the mouth set and a blink. */
  includeExtras: boolean
}

export interface Avatar {
  id: string
  name: string
  /** The prompt that produced the base portrait, kept so the look can be
   *  varied or the set rebuilt without starting from a blank field. */
  basePrompt: string
  /** Absolute paths, by frame. `rest` is always present on a usable avatar. */
  frames: Partial<Record<AvatarFrame, string>>
  createdAt: number
  updatedAt: number
}

/** A right-hand panel's remembered size and state. */
export interface PanelLayout {
  width: number
  collapsed: boolean
}

/** Bounds for a panel width. Narrower than MIN and the content is unreadable;
 *  wider than MAX and the centre column stops being the centre. */
export const PANEL_W_MIN = 240
export const PANEL_W_MAX = 720
export const PANEL_W_DEFAULT = 340
/** Width of the strip left behind when a panel is collapsed — enough for the
 *  button that brings it back, because a panel with no way back is just gone. */
export const PANEL_W_COLLAPSED = 34

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
