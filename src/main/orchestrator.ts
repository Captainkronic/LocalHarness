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
  WorkflowId
} from '@shared/types'
import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import { WORKFLOW_BY_ID } from '@shared/workflows'

import type { SettingsStore } from './store/settings'
import type { ConversationStore } from './store/conversations'
import type { McpManager } from './mcp/manager'
import type { ModelRegistry } from './llm/models'
import type { ToolExecutor } from './agent/executor'
import type { ApprovalBroker } from './agent/approval'
import { streamChat, type WireMessage } from './llm/client'
import { buildContextUsage, buildMessages } from './llm/prompt'
import { TurnMeter, RateCalibrator } from './telemetry/meter'
import { nativeWireTools, NATIVE_TOOLS } from './agent/tools'
import { estimateTokens } from './mcp/tokens'

/** Safety net against a model that calls tools forever. */
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
  emit: Emit
}

interface ActiveTurn {
  conversationId: string
  controller: AbortController
  meter: TurnMeter
  metricTimer: NodeJS.Timeout
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
    const wf = WORKFLOW_BY_ID[workflowId]
    if (!wf) return this.d.mcp.states()
    const override = this.d.settings.get().workflowMcpOverrides[workflowId]
    const ids = override ?? wf.mcpServers
    return this.d.mcp.applySet(ids)
  }

  artifacts(workflowId: WorkflowId): Artifact[] {
    return this.artifactsByWorkflow.get(workflowId) ?? []
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
    const wf = WORKFLOW_BY_ID[conv.workflowId]
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

  async send(req: SendMessageRequest): Promise<{ ok: boolean; error?: string }> {
    if (this.active) {
      return { ok: false, error: 'A turn is already running in this window.' }
    }
    const conv = this.d.conversations.get(req.conversationId)
    if (!conv) return { ok: false, error: 'Conversation not found.' }

    const model = this.resolveModel(conv)
    if (!model) {
      return {
        ok: false,
        error:
          'No model available. Load one in LM Studio, or pin a model in Settings.'
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
      return { ok: true }
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
      return { ok: false, error: message }
    } finally {
      this.endTurn()
    }
  }

  /* ---------------------------------------------------------------- */
  /* The loop                                                          */
  /* ---------------------------------------------------------------- */

  private async runTurn(conv: Conversation, model: ModelInfo): Promise<void> {
    const wf = WORKFLOW_BY_ID[conv.workflowId]
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

    // Learn the model's real window before the first request against it, so the
    // context meter is right on the very first turn rather than two minutes later.
    await this.d.models.learn(model.id).catch(() => undefined)

    const tools = this.buildTools(conv.workflowId)

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (controller.signal.aborted) break

      const messages = buildMessages(conv, wf.systemPrompt, model.supportsVision)
      const promptTokens = this.estimatePromptTokens(messages, tools)

      meter.start(model.id, promptTokens, this.calibrator.prefillTps(model.id))
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
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: model.id,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: wf.sampling.temperature,
          topP: wf.sampling.topP,
          maxTokens: wf.sampling.maxTokens,
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
            meter.countCompletionToken()
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
      const turnMetrics = meter.finish(usage, finishReason)
      turnMetrics.toolSchemaTokens = this.toolTokens(tools)
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
      if (call.origin === 'native') {
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
        const result = await this.d.mcp.callTool(call.name, args)
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
    for (const artifact of call.artifacts ?? []) {
      this.recordArtifact(conv.workflowId, artifact)
    }
    this.appendToolResult(conv, call)
  }

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

  private buildTools(workflowId: WorkflowId): WireTool[] {
    const wf = WORKFLOW_BY_ID[workflowId]
    if (!wf) return []
    return [...nativeWireTools(wf.nativeTools), ...this.d.mcp.wireTools()]
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

  private originOf(name: string): 'native' | 'mcp' {
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
    const wf = WORKFLOW_BY_ID[conv.workflowId]
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
