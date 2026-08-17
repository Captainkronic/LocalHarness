/**
 * The turn loop.
 *
 * Everything else in the main process is a self-contained subsystem; this is the
 * only place they are composed. One conversation runs at a time per window,
 * tracked by `active`.
 *
 * The loop: build messages -> stream -> collect tool calls -> execute them
 * (native in-process, MCP over stdio) -> append results -> repeat until the model
 * stops calling tools or MAX_ITERATIONS is hit.
 */

import { randomUUID } from 'node:crypto'

import type {
  Artifact,
  ChatMessage,
  ContextUsage,
  Conversation,
  McpServerState,
  ModelInfo,
  NativeToolId,
  SendMessageRequest,
  ToolCall,
  WireTool,
  WorkflowDefinition,
  WorkflowId
} from '@shared/types'
import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import { DEFAULT_WORKFLOW, WORKFLOW_BY_ID } from '@shared/workflows'

import type { SettingsStore } from './store/settings'
import type { ConversationStore } from './store/conversations'
import type { McpManager } from './mcp/manager'
import type { ModelRegistry } from './llm/models'
import type { ToolExecutor } from './agent/executor'
import type { ApprovalBroker } from './agent/approval'
import type { SkillRegistry } from './skills/registry'
import type { LmStudioControl } from './llm/control'
import { streamChat, type WireMessage } from './llm/client'
import { buildContextUsage, buildMessages, type TrimInfo } from './llm/prompt'
import { TurnMeter, RateCalibrator } from './telemetry/meter'
import { nativeWireTools, NATIVE_TOOLS } from './agent/tools'
import { runSkillTool, skillTools } from './agent/skilltool'
import { estimateTokens } from './mcp/tokens'

/** Safety net against a model that calls tools forever. */
/**
 * Slice of the window held back from the history.
 *
 * Our token counts are estimates from character length, so they can be wrong in
 * either direction — and being wrong on the high side means a request the
 * server rejects, which is the exact failure trimming exists to prevent. Five
 * percent is cheap insurance against an estimate that ran under.
 */
const CONTEXT_SAFETY_FRACTION = 0.05

const MAX_ITERATIONS = 25

/** Conversation pushes are coalesced to this interval while streaming. */
const CONV_EMIT_MS = 60
/** Live metric pushes. Fast enough to feel live, slow enough not to churn React. */
const METRIC_EMIT_MS = 250

type Emit = <K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]) => void

export interface OrchestratorDeps {
  settings: SettingsStore
  conversations: ConversationStore
  mcp: McpManager
  models: ModelRegistry
  executor: ToolExecutor
  approvals: ApprovalBroker
  skills: SkillRegistry
  control: LmStudioControl
  emit: Emit
}

interface ActiveTurn {
  conversationId: string
  controller: AbortController
  meter: TurnMeter
  metricTimer: NodeJS.Timeout
}

/**
 * "bpm 96 -> 88 · seed held" — what turns two rows in a panel into a take and
 * its successor.
 *
 * Deliberately reports a held seed as well as a changed one, because with this
 * model a held seed does NOT preserve the song: every musical parameter feeds
 * the same autoregressive composer, so holding it removes one source of
 * variance rather than pinning the music. Saying "seed held" out loud is what
 * stops that being mistaken for a surgical edit.
 */
export function describeTakeDiff(
  before: Record<string, string | number>,
  after: Record<string, string | number>
): string | null {
  const parts: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  keys.delete('changed')
  for (const key of keys) {
    if (key === 'seed') continue
    const a = before[key]
    const b = after[key]
    if (a === b) continue
    if (a === undefined) parts.push(`${key} set to ${truncateValue(b)}`)
    else if (b === undefined) parts.push(`${key} dropped`)
    else parts.push(`${key} ${truncateValue(a)} -> ${truncateValue(b)}`)
  }
  if (parts.length === 0) return null
  parts.push(before['seed'] !== undefined && before['seed'] === after['seed'] ? 'seed held' : 'new seed')
  return parts.join(' · ')
}

function truncateValue(v: string | number | undefined): string {
  const text = String(v ?? '')
  return text.length > 42 ? `${text.slice(0, 41)}…` : text
}

export class Orchestrator {
  private readonly d: OrchestratorDeps
  private readonly calibrator = new RateCalibrator()
  private readonly artifactsByWorkflow = new Map<WorkflowId, Artifact[]>()
  private active: ActiveTurn | null = null
  private convEmitAt = 0

  constructor(deps: OrchestratorDeps) {
    this.d = deps
  }

  /* ---------------------------------------------------------------- */
  /* Public surface                                                    */
  /* ---------------------------------------------------------------- */

  isBusy(): boolean {
    return this.active !== null
  }

  async applyWorkflow(workflowId: WorkflowId): Promise<McpServerState[]> {
    const wf = this.workflow(workflowId)
    const override = this.d.settings.get().workflowMcpOverrides[workflowId]
    const ids = override ?? wf.mcpServers
    this.log(
      'info',
      'mcp',
      `applyWorkflow(${workflowId}) -> [${ids.join(', ') || 'none'}]${override ? ' (override)' : ''}`
    )
    return this.d.mcp.applySet(ids)
  }

  artifacts(workflowId: WorkflowId): Artifact[] {
    return this.artifactsByWorkflow.get(workflowId) ?? []
  }

  /**
   * Tokens the message history may occupy, or undefined for no limit.
   *
   * The window has to hold the reply and the tool schemas as well as the
   * history, so both are subtracted before the history gets what is left. The
   * margin covers the gap between our estimate and the server's real tokeniser:
   * we count roughly, and being roughly right ON THE HIGH SIDE means a rejected
   * request, which is the failure this exists to prevent.
   *
   * Returns undefined when the window is unknown — better to send the whole
   * conversation and let the server complain than to silently drop history on
   * the strength of a guess about a limit we cannot see.
   */
  historyBudget(model: ModelInfo | null, workflowId: WorkflowId, toolTokens: number): number | undefined {
    if (!model) return undefined
    const window = this.d.models.contextWindow(model.id)
    if (window === null || window <= 0) return undefined
    const reply = this.workflow(workflowId).sampling.maxTokens
    const budget = window - reply - toolTokens - Math.ceil(window * CONTEXT_SAFETY_FRACTION)
    return budget > 0 ? budget : undefined
  }

  /** Records a trim on the conversation and says so in the log. */
  private noteTrim(conv: Conversation, modelId: string, info: TrimInfo): void {
    conv.trimmedMessages = (conv.trimmedMessages ?? 0) + info.messages
    this.log(
      'warn',
      'context',
      `dropped ${info.messages} earlier message(s), about ${info.tokens} tokens, to fit ${modelId}'s window`
    )
  }

  contextUsage(conversationId: string): ContextUsage {
    const conv = this.d.conversations.get(conversationId)
    if (!conv) {
      return {
        used: 0,
        max: null,
        breakdown: { system: 0, tools: 0, messages: 0, attachments: 0 },
        fraction: null
      }
    }
    const wf = this.workflow(conv.workflowId)
    const model = this.resolveModel(conv)
    const tools = this.buildTools(conv.workflowId)
    const messages = buildMessages(conv, wf.systemPrompt, model?.supportsVision ?? false)
    const attachments = conv.messages.flatMap((m) => m.attachments ?? [])
    return buildContextUsage({
      system: wf.systemPrompt,
      tools,
      messages,
      attachments,
      max: model ? this.d.models.contextWindow(model.id) : null
    })
  }

  cancel(conversationId: string): void {
    if (this.active?.conversationId !== conversationId) return
    this.active.controller.abort()
    this.d.approvals.denyAll()
  }

  async send(
    req: SendMessageRequest
  ): Promise<{ ok: boolean; accepted: boolean; error?: string }> {
    // Everything before the message is persisted is a REJECTION: the text is
    // still only in the composer, so the renderer has to be told not to throw
    // it away. Everything after is accepted, error or not, because the message
    // is in the transcript and the failure renders next to it.
    if (this.active) {
      return { ok: false, accepted: false, error: 'A turn is already running in this window.' }
    }
    const conv = this.d.conversations.get(req.conversationId)
    if (!conv) return { ok: false, accepted: false, error: 'Conversation not found.' }

    const model = this.resolveModel(conv)
    if (!model) {
      return {
        ok: false,
        accepted: false,
        error:
          'No model is loaded on the server. Open Models (⌘M) to load one, or pin a model in Settings.'
      }
    }

    conv.messages.push({
      id: randomUUID(),
      role: 'user',
      content: req.content,
      attachments: req.attachments,
      createdAt: Date.now()
    })
    if (conv.title === 'New conversation' && req.content.trim()) {
      conv.title = req.content.trim().slice(0, 48)
    }
    this.persist(conv, true)

    try {
      await this.runTurn(conv, model)
      return { ok: true, accepted: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', 'turn', message)
      const last = conv.messages[conv.messages.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        last.streaming = false
        last.error = message
      } else {
        conv.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: '',
          error: message,
          createdAt: Date.now()
        })
      }
      this.persist(conv, true)
      return { ok: false, accepted: true, error: message }
    } finally {
      this.endTurn()
    }
  }

  /* ---------------------------------------------------------------- */
  /* The loop                                                          */
  /* ---------------------------------------------------------------- */

  private async runTurn(conv: Conversation, model: ModelInfo): Promise<void> {
    const wf = this.workflow(conv.workflowId)
    const settings = this.d.settings.get()
    const controller = new AbortController()
    const meter = new TurnMeter()

    this.active = {
      conversationId: conv.id,
      controller,
      meter,
      metricTimer: setInterval(() => {
        this.d.emit('event:liveMetrics', meter.snapshot())
      }, METRIC_EMIT_MS)
    }
    this.d.models.setActive(true)

    // Put the right model on the box before anything else. LM Studio does NOT
    // swap for you — asking for a second large model while one is resident fails
    // with "insufficient system resources" — so the old one is unloaded first.
    await this.ensurePreferredModel(conv, model)

    // Learn the model's real window before the first request against it, so the
    // context meter is right on the very first turn rather than two minutes later.
    await this.d.models.learn(model.id).catch(() => undefined)

    const tools = this.buildTools(conv.workflowId)
    // Fixed for the whole turn: the tool schemas do not change between
    // iterations, and neither does the window.
    const budget = this.historyBudget(
      model,
      conv.workflowId,
      tools.length === 0 ? 0 : estimateTokens(JSON.stringify(tools))
    )

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (controller.signal.aborted) break

      const messages = buildMessages(conv, wf.systemPrompt, model.supportsVision, {
        budget,
        onTrim: (info) => this.noteTrim(conv, model.id, info)
      })
      const promptTokens = this.estimatePromptTokens(messages, tools)

      meter.start(
        model.id,
        promptTokens,
        this.calibrator.prefillTps(model.id),
        this.calibrator.overheadMs(model.id)
      )
      this.pushUsage(conv, tools, messages, model)

      const assistant: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        streaming: true
      }
      conv.messages.push(assistant)
      this.persist(conv, true)

      const pendingCalls = new Map<number, ToolCall>()
      let finishReason = 'stop'
      let usage = { promptTokens, completionTokens: 0 }

      await streamChat(
        {
          // The model's OWN endpoint. Ids collide across servers — the same
          // qwen name exists on LM Studio and on the MLX server — so routing by
          // the default base URL would silently send a turn to the wrong build.
          baseUrl: model.baseUrl || settings.baseUrl,
          apiKey: settings.apiKey,
          model: model.id,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: wf.sampling.temperature,
          topP: wf.sampling.topP,
          maxTokens: wf.sampling.maxTokens,
          // Reasoning is billed against maxTokens, so an unbounded default can
          // spend the entire answer budget thinking — qwen once used all 8,192
          // of Code's and returned nothing after eleven minutes. The user's
          // per-workflow choice wins over the profile's default.
          reasoningEffort:
            this.d.settings.get().workflowReasoning[conv.workflowId] ??
            wf.sampling.reasoningEffort,
          signal: controller.signal
        },
        {
          onFirstToken: () => {
            meter.markFirstToken()
            this.d.emit('event:liveMetrics', meter.snapshot())
          },
          onContent: (delta) => {
            assistant.content += delta
            meter.countCompletionToken()
            this.persist(conv, false)
          },
          onReasoning: (delta) => {
            assistant.reasoning = (assistant.reasoning ?? '') + delta
            // Counts toward decode rate and the completion total, but tracked
            // separately so TurnMetrics.reasoningTokens is actually populated.
            meter.countReasoningToken()
            this.persist(conv, false)
          },
          onToolCallDelta: (index, id, name, argsDelta) => {
            let call = pendingCalls.get(index)
            if (!call) {
              call = {
                id: id ?? `call_${index}_${Date.now()}`,
                name: name ?? '',
                arguments: '',
                origin: 'native',
                status: 'pending'
              }
              pendingCalls.set(index, call)
            }
            if (id) call.id = id
            if (name) call.name = name
            call.arguments += argsDelta
            call.origin = this.originOf(call.name)
            // Tool-call arguments ARE generated tokens. Not counting them made
            // the decode rate read "—" for the entire time the model was writing
            // a tool call — and writing a whole file into a write_file argument
            // is the longest generation in the app. The UI looked frozen at
            // exactly the moment it most needed to show progress.
            meter.countCompletionToken()
            assistant.toolCalls = [...pendingCalls.values()]
            this.persist(conv, false)
          },
          onUsage: (u) => {
            usage = u
          },
          onDone: (reason) => {
            finishReason = reason
          }
        }
      )

      assistant.streaming = false
      meter.setToolSchemaTokens(this.toolTokens(tools))
      const turnMetrics = meter.finish(usage, finishReason)
      assistant.metrics = turnMetrics
      this.calibrator.observe(
        model.id,
        usage.promptTokens,
        turnMetrics.ttftMs,
        usage.completionTokens,
        Math.max(1, turnMetrics.totalMs - turnMetrics.ttftMs)
      )
      this.persist(conv, true)

      const calls = assistant.toolCalls ?? []
      if (!calls.length || controller.signal.aborted) {
        if (finishReason === 'length' && !assistant.content.trim()) {
          // Reasoning models can burn the entire budget on reasoning_content and
          // return nothing. Say so rather than showing an empty reply.
          assistant.error =
            'The model hit its output cap while still reasoning and produced no answer. Raise max tokens for this workflow, or ask something narrower.'
          this.persist(conv, true)
        }
        break
      }

      meter.markToolPhase()
      this.d.emit('event:liveMetrics', meter.snapshot())

      for (const call of calls) {
        if (controller.signal.aborted) {
          call.status = 'denied'
          call.error = 'Cancelled.'
          continue
        }
        await this.runToolCall(conv, call)
        this.persist(conv, true)
      }
    }
  }

  private async runToolCall(conv: Conversation, call: ToolCall): Promise<void> {
    call.status = 'running'
    call.startedAt = Date.now()
    this.persist(conv, true)

    let args: unknown = {}
    try {
      args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    } catch {
      call.status = 'error'
      call.error = `Could not parse the arguments the model produced: ${call.arguments.slice(0, 300)}`
      call.finishedAt = Date.now()
      this.appendToolResult(conv, call)
      return
    }

    try {
      if (call.name === 'use_skill') {
        const result = await runSkillTool(call.name, args, this.d.skills)
        call.result = result.text
        call.status = result.isError ? 'error' : 'ok'
        if (result.isError) call.error = result.text
      } else if (call.origin === 'native') {
        const result = await this.d.executor.execute(
          call.name as NativeToolId,
          args,
          conv.id
        )
        call.result = result.text
        call.artifacts = result.artifacts
        call.status = result.isError ? 'error' : 'ok'
        if (result.isError) call.error = result.text
      } else {
        const result = await this.d.mcp.callTool(call.name, args, (p) => {
          // Straight onto the call the card is already rendering, then a
          // throttled push: a render emits a tick every second or two, and the
          // whole point is that the user sees it move while it happens.
          call.progressFraction = p.fraction
          call.progressMessage = p.message
          this.persist(conv, false)
        })
        call.result = result.text
        call.artifacts = result.artifacts
        call.status = result.isError ? 'error' : 'ok'
        if (result.isError) call.error = result.text
      }
    } catch (err) {
      call.status = 'error'
      call.error = err instanceof Error ? err.message : String(err)
      call.result = call.error
    }

    call.finishedAt = Date.now()
    // Cleared, or the last reported step stays on the call forever. It is
    // invisible today because the bar only renders in the 'running' branch, but
    // it persists to disk with the conversation and would reappear if a call
    // ever went running -> error -> running again.
    call.progressFraction = undefined
    call.progressMessage = undefined
    this.stampAudioTake(conv, call, args)
    for (const artifact of call.artifacts ?? []) {
      this.recordArtifact(conv.workflowId, artifact)
    }
    this.appendToolResult(conv, call)
  }

  /**
   * Records what produced a rendered take, and what changed since the last one.
   *
   * A song cannot be edited — ACE-Step has no audio-to-audio path, so refining
   * means rendering again with one lever moved. That makes the parameter set
   * the only thing connecting take 2 to take 1, and it was being thrown away:
   * the seed comes back as prose inside the result text, and the artifact
   * carried no record of the tags, tempo or key that produced it. Without this
   * the panel is a pile of unrelated mp3s and "hold the seed" is unusable,
   * because nobody knows what the seed was.
   */
  private stampAudioTake(conv: Conversation, call: ToolCall, args: unknown): void {
    if (call.status === 'error') return
    if (!/generate_(music|sound)$/.test(call.name)) return
    const a = (args ?? {}) as Record<string, unknown>

    // The server reports the seed only in prose: "... · seed 1834729382 · ...".
    // Parsing it here beats asking a local model to retype ten digits.
    const seed = /\bseed (\d+)/.exec(call.result ?? '')?.[1]

    const recipe: Record<string, string | number> = {}
    for (const key of ['tags', 'bpm', 'key', 'timesignature', 'language', 'prompt'] as const) {
      const v = a[key]
      if (typeof v === 'string' && v.trim() !== '') recipe[key] = v
      else if (typeof v === 'number') recipe[key] = v
    }
    if (seed) recipe['seed'] = seed
    if (typeof a['seconds'] === 'number') {
      // NOT "duration": AudioPanel prefers meta over the length it measures off
      // the file, so the REQUESTED seconds would masquerade as the real one.
      recipe['requested'] = `${a['seconds']}s`
    }
    if (typeof a['lyrics'] === 'string') {
      recipe['voice'] = a['lyrics'].trim() === '' ? 'instrumental' : 'sung'
    }

    const prev = this.lastAudioTake.get(conv.id)
    const changed = prev ? describeTakeDiff(prev.recipe, recipe) : null
    if (changed !== null) recipe['changed'] = changed

    for (const artifact of call.artifacts ?? []) {
      if (artifact.kind !== 'audio') continue
      artifact.meta = { ...artifact.meta, ...recipe }
      // Chained unconditionally rather than guessed at. Any heuristic for "is
      // this the same song" would merge two different songs that share a tag or
      // split one whose tags were rewritten; the diff is what carries the
      // truth, and a brand-new song simply shows everything changed.
      if (prev) artifact.parentId = prev.artifactId
      this.lastAudioTake.set(conv.id, { recipe, artifactId: artifact.id })
    }
  }

  /** The last rendered take per conversation, so the next one can diff against
   *  it. In memory only — the durable record is `meta.changed` on the artifact,
   *  which rides along with the conversation. */
  private readonly lastAudioTake = new Map<string, { recipe: Record<string, string | number>; artifactId: string }>()

  private appendToolResult(conv: Conversation, call: ToolCall): void {
    conv.messages.push({
      id: randomUUID(),
      role: 'tool',
      toolCallId: call.id,
      content: call.result ?? call.error ?? '(no output)',
      createdAt: Date.now()
    })
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * `WORKFLOW_BY_ID` is typed as a total Record, so TypeScript sees no risk in
   * indexing it — but `conv:setWorkflow` assigns straight from an IPC argument,
   * so an unknown id really can reach here and would throw mid-turn. One lookup
   * helper, one fallback.
   */
  private workflow(id: WorkflowId): WorkflowDefinition {
    return WORKFLOW_BY_ID[id] ?? WORKFLOW_BY_ID[DEFAULT_WORKFLOW]
  }

  private buildTools(workflowId: WorkflowId): WireTool[] {
    const wf = this.workflow(workflowId)
    return [
      ...nativeWireTools(wf.nativeTools),
      // One tool carrying the catalogue of enabled skills. Only their names and
      // descriptions ride along on every message; a body is fetched only when
      // the model decides a skill applies. That is what keeps skills cheap.
      // Scoped to the workflow: a skill that does not belong to this function
      // is not merely wasted payload, it misinforms the model about its own
      // job. `undefined` still means "offer everything enabled".
      ...skillTools(
        wf.skills === undefined
          ? this.d.skills.list()
          : this.d.skills.list().filter((s) => wf.skills?.includes(s.name))
      ),
      // The workflow's tool allowlist applies here too. It was honoured only in
      // the Live session, so every other workflow silently offered whole
      // servers — including gmail's send and delete — wherever gmail was on.
      ...this.d.mcp.wireTools(wf.mcpTools)
    ]
  }

  private toolTokens(tools: WireTool[]): number {
    return tools.reduce(
      (sum, t) => sum + estimateTokens(JSON.stringify(t.function)) + 8,
      0
    )
  }

  /** Our own count, known before the server answers, so the meter has a
   *  numerator during prefill. Replaced by the server's figure on completion. */
  private estimatePromptTokens(messages: WireMessage[], tools: WireTool[]): number {
    const text = messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => ('text' in p ? p.text : '[image]')).join(' ')
      )
      .join('\n')
    return estimateTokens(text) + this.toolTokens(tools) + messages.length * 4
  }

  /**
   * Make the turn's model resident, evicting whatever is there.
   *
   * Best-effort: if the swap fails the turn still runs against whatever is
   * loaded rather than refusing, and the reason is logged. A failed swap is a
   * slower or dumber answer, not a dead conversation.
   */
  private async ensurePreferredModel(conv: Conversation, model: ModelInfo): Promise<void> {
    const resident = this.d.models.residentModelId()
    if (resident === model.id) return

    const control = this.d.control
    if (control.state().status !== 'connected') {
      // Without the control socket we cannot unload, and a bare load would hit
      // the memory ceiling. Leave the box alone and use what is there.
      this.log('info', 'model', `${model.id} is not resident and model control is not connected`)
      return
    }

    this.log('info', 'model', `switching to ${model.id}${resident ? ` (evicting ${resident})` : ''}`)
    try {
      if (resident) await control.unload(resident)
      const result = await control.load(model.id, {})
      if (!result.ok) {
        this.log('warn', 'model', `could not load ${model.id}: ${result.error ?? 'unknown error'}`)
        return
      }
      await this.d.models.refresh().catch(() => undefined)
    } catch (err) {
      this.log('warn', 'model', `model switch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private originOf(name: string): 'native' | 'mcp' {
    // use_skill is neither a native filesystem tool nor an MCP one, but it is
    // in-process, so 'native' is the honest badge for the UI.
    if (name === 'use_skill') return 'native'
    return NATIVE_TOOLS.some((t) => t.id === name) ? 'native' : 'mcp'
  }

  private resolveModel(conv: Conversation): ModelInfo | null {
    const models = this.d.models.list()
    const settings = this.d.settings.get()
    const wanted = conv.modelId ?? settings.defaultModelId
    if (wanted) {
      const pinned = models.find((m) => m.id === wanted)
      if (pinned) return pinned
    }
    const residentId = this.d.models.residentModelId()

    // The workflow's preferred model wins whether or not it is loaded —
    // `ensurePreferredModel` makes it resident first. Adam runs one model at a
    // time by necessity, so swapping is the expected cost of changing the kind
    // of work, not something to avoid.
    const preferred = this.workflow(conv.workflowId).preferredModel
    if (preferred) {
      const match = models.find((m) => m.id === preferred)
      if (match) return match
    }

    if (residentId) {
      const resident = models.find((m) => m.id === residentId)
      if (resident) return resident
    }
    // Nothing resident: fall back to any tool-capable model so a first request
    // can JIT-load one rather than refusing outright.
    return models.find((m) => m.supportsTools) ?? models[0] ?? null
  }

  private recordArtifact(workflowId: WorkflowId, artifact: Artifact): void {
    const list = this.artifactsByWorkflow.get(workflowId) ?? []
    list.unshift(artifact)
    this.artifactsByWorkflow.set(workflowId, list.slice(0, 200))
    this.d.emit('event:artifact', artifact)
  }

  private pushUsage(
    conv: Conversation,
    tools: WireTool[],
    messages: WireMessage[],
    model: ModelInfo
  ): void {
    const wf = this.workflow(conv.workflowId)
    const usage = buildContextUsage({
      system: wf.systemPrompt,
      tools,
      messages,
      attachments: conv.messages.flatMap((m) => m.attachments ?? []),
      max: this.d.models.contextWindow(model.id)
    })
    this.d.emit('event:contextUsage', { conversationId: conv.id, usage })
  }

  /** Coalesced conversation push. `force` bypasses the throttle for structural
   *  changes (a new message, a finished tool call) that must not be dropped. */
  private persist(conv: Conversation, force: boolean): void {
    conv.updatedAt = Date.now()
    const now = Date.now()
    if (!force && now - this.convEmitAt < CONV_EMIT_MS) return
    this.convEmitAt = now
    this.d.emit('event:conversationUpdated', conv)
    if (force) {
      this.d.conversations.save(conv)
      this.d.emit('event:conversationList', this.d.conversations.list())
    }
  }

  private endTurn(): void {
    if (!this.active) return
    clearInterval(this.active.metricTimer)
    this.active.meter.reset()
    this.d.emit('event:liveMetrics', this.active.meter.snapshot())
    this.active = null
    this.d.models.setActive(false)
  }

  private log(level: 'info' | 'warn' | 'error', scope: string, message: string): void {
    this.d.emit('event:log', { level, scope, message })
  }
}
