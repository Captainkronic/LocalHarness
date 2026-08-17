# Internal module contracts

This is the wiring spec for the main process. Every subsystem is a class with an
explicit public surface; `src/main/orchestrator.ts` is the only place they are
composed. Nothing imports across subsystem boundaries except through these
exports and `src/shared/*`.

All modules are ESM TypeScript targeting Node 22+ inside Electron's main process.
Import shared types with the `@shared/*` alias (e.g. `import type { ModelInfo } from '@shared/types'`).

---

## `src/main/store/settings.ts`

```ts
export class SettingsStore {
  constructor(dir: string)          // app.getPath('userData')
  get(): Settings
  update(patch: Partial<Settings>): Settings
  onChange(cb: (s: Settings) => void): () => void
}
export const DEFAULT_SETTINGS: Settings
```

Persists to `<dir>/settings.json`. Atomic write (tmp + rename). Missing or
corrupt file falls back to defaults rather than throwing.

## `src/main/store/conversations.ts`

```ts
export class ConversationStore {
  constructor(dir: string)
  list(): ConversationSummary[]
  get(id: string): Conversation | null
  create(workflowId: WorkflowId): Conversation
  save(c: Conversation): void
  delete(id: string): void
  rename(id: string, title: string): void
}
```

One JSON file per conversation under `<dir>/conversations/`. `save` is debounced
by the caller, not here. Titles are auto-derived from the first user message
(first 48 chars) when still `"New conversation"`.

---

## `src/main/mcp/client.ts`

```ts
export interface McpClientOptions {
  id: string
  command: string
  args: string[]
  env: Record<string, string>
  callTimeoutMs: number
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export class McpClient {
  constructor(opts: McpClientOptions)
  readonly id: string
  get pid(): number | undefined
  start(): Promise<McpToolInfo[]>     // spawn + initialize + tools/list
  callTool(name: string, args: unknown): Promise<McpCallResult>
  stop(): Promise<void>
  get handshakeMs(): number | undefined
}

export interface McpCallResult {
  text: string                 // concatenated text content blocks
  artifacts: Artifact[]        // image/audio/resource blocks turned into artifacts
  isError: boolean
}
```

Implements MCP over stdio directly — newline-delimited JSON-RPC 2.0 on stdin/stdout,
stderr to the log callback. No SDK dependency.

Handshake: `initialize` with
`{protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'LocalHarness', version}}`,
then the `notifications/initialized` notification, then `tools/list`.

Requirements:
- Tilde in `command` and every `args` entry must be expanded to the real home dir
  before spawn, and so must `~` inside env values.
- A `tools/call` that exceeds `callTimeoutMs` rejects with a clear message naming
  the server and the timeout; it must not leave a dangling pending-request entry.
- Content blocks: `type: 'text'` concatenates into `text`; `type: 'image'` becomes
  an `Artifact` with a `data:` URL built from the base64 payload; `type: 'resource'`
  with a `file://` uri becomes an artifact with `path` set.
- Many of these servers print to stderr on startup without it being an error —
  log stderr at `info`, never treat it as a failure.
- `stop()` sends SIGTERM, then SIGKILL after 3s.

## `src/main/mcp/tokens.ts`

```ts
export function estimateTokens(text: string): number
export function toolSchemaTokens(name: string, description: string, schema: JsonSchema): number
export function sanitizeSchema(schema: JsonSchema): JsonSchema
```

`estimateTokens` is chars/4 rounded up — it is an estimate and the UI labels it
as one. `sanitizeSchema` strips `enum` (appending "Allowed values: …" to the
description), collapses `anyOf`/`oneOf`/`allOf` to the first branch that declares
a `type`, and gives any type-less node a `type`. This mirrors the sanitising proxy
and exists because several Gemma chat templates fail to render otherwise.

## `src/main/mcp/manager.ts`

```ts
export class McpManager {
  constructor(opts: { onStates: (s: McpServerState[]) => void; onLog: LogFn })
  specs(): McpServerSpec[]
  states(): McpServerState[]
  /** Starts servers in `ids`, stops any running server not in `ids`. */
  applySet(ids: string[]): Promise<McpServerState[]>
  restart(id: string): Promise<McpServerState | null>
  setToolEnabled(serverId: string, toolName: string, enabled: boolean): McpServerState[]
  /** Enabled tools across all ready servers, as wire tools for the model. */
  wireTools(): WireTool[]
  /** Sum of enabled tool schema tokens across ready servers. */
  tokenCost(): number
  callTool(qualifiedName: string, args: unknown): Promise<McpCallResult>
  shutdown(): Promise<void>
}
```

`applySet` starts servers concurrently and never lets one failure block the
others — a server that fails to start goes to `status: 'error'` with the message
and the rest still come up. States are pushed through `onStates` on every
transition so the UI shows starting/ready/error live.

Wire tool names are `${serverId}__${toolName}` (double underscore), because the
model needs one flat namespace and `/` is not legal in OpenAI tool names.

---

## `src/main/llm/models.ts`

```ts
export class ModelRegistry {
  constructor(opts: { getSettings: () => Settings; onModels: (m: ModelInfo[]) => void; onHealth: (h: ServerHealth) => void })
  start(): void
  stop(): void
  list(): ModelInfo[]
  refresh(): Promise<ModelInfo[]>
  residentModelId(): string | null
  /** The real window for a model, or null when it has never been observed loaded. */
  contextWindow(modelId: string): number | null
  health(): ServerHealth
  /** Called by the chat path the first time a model is used, to learn its window. */
  learn(modelId: string): Promise<void>
}
```

Polls `GET {nativeApiUrl}/api/v0/models`. **Adaptive backoff is required**: poll at
`settings.modelPollMs` while a request is in flight or the window has focus, and
back off to 120s when idle. A previous incarnation of this poller made 5,760
requests a day against this same endpoint; do not repeat that.

`loadedContextLength` is only reported while a model is resident. Never fall back
to `maxContextLength` as the context denominator — return `null` and let the UI
render an em dash. Learned windows are cached in memory keyed by model id and
re-checked when more than 120s has passed since the last observation, because an
idle eviction followed by a JIT reload silently changes the real window.

`models:load` support: `POST {nativeApiUrl}/api/v0/models/load` is not a documented
endpoint — implement `load()` by issuing a 1-token chat completion against the
model, which triggers LM Studio's JIT load, and report failure text verbatim
(a "Failed to load model" is the box being out of memory, not a bug here).

## `src/main/llm/client.ts`

```ts
export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  temperature: number
  topP: number
  maxTokens: number
  signal: AbortSignal
}

export interface StreamEvents {
  onFirstToken(): void
  onContent(delta: string): void
  onReasoning(delta: string): void
  onToolCallDelta(index: number, id: string | undefined, name: string | undefined, argsDelta: string): void
  onUsage(u: { promptTokens: number; completionTokens: number }): void
  onDone(finishReason: string): void
}

export async function streamChat(req: ChatRequest, ev: StreamEvents): Promise<void>

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}
```

Uses `fetch` with SSE parsing. Notes that matter:
- LM Studio returns `usage` in the final SSE chunk **without** requesting
  `stream_options.include_usage`, but send `stream_options: {include_usage: true}`
  anyway for other backends.
- `reasoning_content` arrives as a sibling of `content` in the delta. Route it to
  `onReasoning`, never concatenate it into the answer.
- A non-2xx response body carries the real error text — read and surface it rather
  than throwing the status code alone.
- Abort must terminate the read loop promptly and not reject as an unhandled error.

## `src/main/llm/prompt.ts`

```ts
export function buildMessages(conv: Conversation, systemPrompt: string): WireMessage[]
export function countConversationTokens(msgs: WireMessage[]): number
export function buildContextUsage(args: {
  system: string; tools: WireTool[]; messages: WireMessage[];
  attachments: Attachment[]; max: number | null
}): ContextUsage
```

Vision: image attachments become `image_url` parts with the data URL, and only for
models whose `supportsVision` is true — otherwise they are replaced by a text note
naming the file, so a text-only model does not receive an unusable payload.

---

## `src/main/telemetry/lab.ts`

```ts
export class LabFeed {
  constructor(opts: { getUrl: () => string; onRecord: (r: LabRecord) => void; onStatus: (s: LabStatus) => void })
  start(): void
  stop(): void
  history(): LabRecord[]
  status(): LabStatus
}
```

Consumes `GET {labUrl}/lab/events` as SSE. This is Adam's own `lmstudio-lab.py` on
the Mac Studio; it emits `kind: "final"` records per completed request and
`kind: "progress"` during one. It is optional — if `labUrl` is empty or the
connection fails, report `'unavailable'` and keep the app fully functional. Retry
with exponential backoff capped at 60s. Keep the last 200 finals in memory.

## `src/main/telemetry/meter.ts`

```ts
export class TurnMeter {
  start(modelId: string, promptTokens: number, estimatedPrefillTps: number | null): void
  markQueued(): void
  markFirstToken(): void
  countCompletionToken(n?: number): void
  markToolPhase(): void
  markDecodePhase(): void
  snapshot(): LiveMetrics
  finish(usage: { promptTokens: number; completionTokens: number }, finishReason: string): TurnMetrics
  reset(): void
}

export class RateCalibrator {
  observe(modelId: string, promptTokens: number, ttftMs: number, completionTokens: number, decodeMs: number): void
  prefillTps(modelId: string): number | null
  decodeTps(modelId: string): number | null
}
```

`TurnMeter` is the client-side measurement. **Prefill progress is an estimate and
must be labelled as one** — the OpenAI wire protocol carries no prefill progress
at all, so between request send and first token there is literal silence. The
estimate is `elapsed / (promptTokens / calibratedPrefillTps)`, clamped to 0.99
until the first token actually arrives. `RateCalibrator` learns the real rate per
model from completed turns (exponential moving average, weight 0.3) and persists
nothing — a cold start simply shows no estimate until the first turn completes.

Decode rate is measured over a rolling 2s window, not cumulatively, so it reflects
the current rate rather than being dragged by TTFT.

---

## `src/main/agent/tools.ts`

```ts
export const NATIVE_TOOLS: NativeToolInfo[]
export function nativeWireTools(enabled: NativeToolId[]): WireTool[]
```

## `src/main/agent/executor.ts`

```ts
export class ToolExecutor {
  constructor(opts: {
    getSettings: () => Settings
    requestApproval: (req: Omit<ApprovalRequest,'id'|'createdAt'>) => Promise<ApprovalDecision>
    onLog: LogFn
  })
  execute(toolId: NativeToolId, args: unknown, conversationId: string): Promise<{ text: string; artifacts: Artifact[]; isError: boolean }>
}
```

Tool semantics:
- `read_file(path, offset?, limit?)` — returns content with `cat -n` style line
  numbers. Refuses files over 2MB with a clear message. Binary files are rejected
  by name, not by reading them.
- `write_file(path, content)` — creates parent dirs; produces a unified diff
  against the existing content for the approval card.
- `edit_file(path, old_string, new_string, replace_all?)` — exact string
  replacement; fails if `old_string` is absent or ambiguous, naming which.
- `list_dir(path)` — one level, dirs first, marked with a trailing `/`.
- `glob(pattern, path?)` — uses Node's `fs.glob` when available, else a manual
  walk. Skips `node_modules`, `.git`, `out`, `dist`. Caps at 500 results and says
  so when it truncates.
- `grep(pattern, path?, glob?)` — prefers `rg` if on PATH, falls back to a manual
  scan. Caps at 200 matches.
- `run_shell(command, cwd?, timeout_ms?)` — `/bin/zsh -lc`, default 120s timeout,
  1MB output cap. Returns exit code, stdout and stderr distinctly.

**Sandboxing is mandatory.** Every path argument resolves through
`settings.workspaceRoots`; a path that escapes every root is refused before any
approval prompt is shown. Symlinks are resolved before the check. `run_shell`'s
`cwd` is subject to the same rule.

**Approval gating.** `mutating` tools always go through `requestApproval` unless
`approvalMode === 'auto_all'`. Read-only tools skip approval when mode is
`auto_read` or `auto_all`. A shell command whose first token matches an entry in
`settings.shellAllowlist` skips approval. `allow_session` is remembered per
`(toolId, resolved target)` for the process lifetime.

## `src/main/agent/approval.ts`

```ts
export class ApprovalBroker {
  constructor(onRequest: (req: ApprovalRequest) => void)
  request(partial: Omit<ApprovalRequest,'id'|'createdAt'>): Promise<ApprovalDecision>
  respond(id: string, decision: ApprovalDecision): void
  pending(): ApprovalRequest[]
  denyAll(): void
}
```

## `src/main/agent/diff.ts`

```ts
export function unifiedDiff(oldText: string, newText: string, path: string): string
export function diffStat(oldText: string, newText: string): { added: number; removed: number }
```

Plain LCS-based diff, 3 lines of context. No dependency.

---

## `src/main/orchestrator.ts` (owned by the integrator, do not write)

Composes everything and runs the turn loop: build messages → stream → collect
tool calls → execute (native via `ToolExecutor`, MCP via `McpManager`) → append
results → loop until the model stops calling tools or the cap of 25 iterations is
reached.

---

## Renderer contracts

`window.harness` is typed as `HarnessBridge` from `@shared/ipc`. The global is
declared in `src/renderer/env.d.ts`.

State lives in one zustand store at `src/renderer/state/store.ts`:

```ts
export interface AppState {
  ready: boolean
  settings: Settings
  workflows: WorkflowDefinition[]
  activeWorkflow: WorkflowId
  conversations: ConversationSummary[]
  activeConversationId: string | null
  conversation: Conversation | null
  models: ModelInfo[]
  mcpSpecs: McpServerSpec[]
  mcpStates: McpServerState[]
  nativeTools: NativeToolInfo[]
  live: LiveMetrics
  usage: ContextUsage
  health: ServerHealth
  labHistory: LabRecord[]
  approvals: ApprovalRequest[]
  artifacts: Artifact[]
  logs: Array<{ level: string; scope: string; message: string; at: number }>
  // actions
  bootstrap(): Promise<void>
  send(text: string, attachments?: Attachment[]): Promise<void>
  cancel(): void
  selectWorkflow(id: WorkflowId): Promise<void>
  selectConversation(id: string): Promise<void>
  newConversation(): Promise<void>
  setMcpEnabled(serverId: string, enabled: boolean): Promise<void>
  respondApproval(id: string, decision: ApprovalDecision): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
}
```

Styling is plain CSS with custom properties in
`src/renderer/styles/theme.css`, imported once from `main.tsx`. No CSS framework,
no CSS-in-JS. Component styles live next to the component as `.css` files.
The workflow accent colour is applied by setting `--accent` on a wrapper element,
so components reference `var(--accent)` and never hardcode a workflow colour.
