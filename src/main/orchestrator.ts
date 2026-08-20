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
import type { ArtifactStore } from './store/artifacts'
import type { LmStudioControl } from './llm/control'
import { streamChat, type WireMessage } from './llm/client'
import { buildContextUsage, buildMessages, type TrimInfo } from './llm/prompt'
import { TurnMeter, RateCalibrator } from './telemetry/meter'
import { nativeWireTools, NATIVE_TOOLS } from './agent/tools'
import { runSkillTool, skillTools } from './agent/skilltool'
import { estimateTokens } from './mcp/tokens'

/**
 * Slice of the window held back from the history.
 *
 * Our token counts are estimates from character length, so they can be wrong in
 * either direction — and being wrong on the high side means a request the
 * server rejects, which is the exact failure trimming exists to prevent. Five
 * percent is cheap insurance against an estimate that ran under.
 */
const CONTEXT_SAFETY_FRACTION = 0.05

/**
 * How many model requests one turn may make before it stops and hands back.
 *
 * Was 25, which is far too few for the work this app is for, and it stopped
 * SILENTLY — the loop simply fell out of the `for` with nothing after it. A
 * measured example: "build a flight simulator and test it in the browser" ran
 * three turns that each stopped dead at the cap, mid-debug, immediately after a
 * tool result. Nothing in the transcript said so. The only reason that build
 * made any progress at all is that the user happened to type "are you stuck?"
 * twice, which started fresh turns that carried on from the history.
 *
 * A run that needs a hundred steps is not misbehaving — writing a file, opening
 * it, reading a console error, fixing it, re-checking is five steps per bug, and
 * a browser-tested build spends most of its steps looking rather than writing.
 *
 * This is not the only brake, which is why it can afford to be generous: the
 * context budget trims history as it fills, the user has Stop, and reaching the
 * cap now ends the turn with an explanation instead of a shrug.
 *
 * Raised again from 100 because continuing is not free. Every continuation
 * re-sends the entire conversation — measured at 52k prompt tokens on the run
 * that prompted this — so a cap that fires often converts into repeated
 * prefills that buy nothing. The step budget is a runaway guard, and a runaway
 * guard set below the length of ordinary work is just a tax on ordinary work.
 *
 * What 500 actually implies, since it is well past one context window: the
 * history trimmer will be doing real work long before the count is reached, so
 * a turn this long is one where the model has lost sight of its own opening
 * moves. That is a property of any long turn, not a new risk introduced here.
 */
const MAX_ITERATIONS = 500

/**
 * Identical call AND identical result, in a row, before the turn is stopped.
 *
 * A step budget does not catch a model that is stuck, only one that is slow.
 * Measured: a Tetris play-test issued the SAME call — browse_act
 * {"action":"press","value":"ArrowLeft"} — thirty consecutive times into a
 * game-over screen, and would have spent its remaining 300 steps doing it. The
 * turn before that spent ninety calls the same way. Nothing in the transcript
 * distinguished either from ordinary slow progress.
 *
 * Identical means the name, the arguments AND what came back. Arguments alone
 * is not enough, and a run caught that the hard way: a model polling a canvas
 * with getImageData to watch a game evolve issued the same expression over and
 * over, which is exactly right — a live page answers differently each time.
 * Stopping it for repeating itself would have stopped it for doing the job
 * properly. (That particular game happened to be frozen, so the readings really
 * were identical and stopping was correct, but it was correct by luck.)
 *
 * Comparing results makes the rule mean what it always should have: stop when
 * nothing is being LEARNED, not when nothing is being varied. Polling a moving
 * page never trips. Polling a dead one trips in six.
 */
const MAX_IDENTICAL_CALLS = 6

/**
 * A cycle is a loop that alternates, and the rule above cannot see one.
 *
 * "Six IDENTICAL in a row" needs two the same back to back. A model bouncing
 * between two calls — check the file, run the test, check the file, run the
 * test — never repeats consecutively, so it sails straight through and can do
 * it for hours.
 *
 * Measured: a golf build ran 124 shell calls over three hours in a perfect
 * two-call cycle, writing nothing to the workspace for the last two and a half.
 * The last twelve calls contained exactly TWO distinct outcomes: a directory
 * listing that had not changed since 05:55, and its own verification script
 * failing with the same AssertionError every time. The file it was verifying
 * was valid the whole time; the test was the broken thing.
 *
 * So: look at a window rather than at neighbours. Twelve outcomes carrying
 * three or fewer distinct results is a cycle whatever its period, and this
 * generalises the consecutive rule (six identical is one distinct outcome)
 * rather than replacing it. Real work does not revisit the same three outcomes
 * twelve times running; polling a live page does not either, because the page
 * keeps answering differently.
 */
const CYCLE_WINDOW = 12
const CYCLE_DISTINCT = 3

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
  /** Survives restarts, so the gallery is a growing record rather than a
   *  session scratchpad. */
  artifacts: ArtifactStore
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
    return this.d.artifacts.list(workflowId)
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

    return this.runAndReport(conv, model)
  }

  /**
   * Carry on where a turn left off, with no new user message.
   *
   * The step cap ends a turn mid-task, and the obvious workaround — sending the
   * word "continue" — puts a message in the transcript that the user did not
   * write and the model then has to interpret. The history is already complete,
   * so the loop can simply run again against it.
   */
  async continueTurn(
    conversationId: string
  ): Promise<{ ok: boolean; accepted: boolean; error?: string }> {
    if (this.active) {
      return { ok: false, accepted: false, error: 'A turn is already running in this window.' }
    }
    const conv = this.d.conversations.get(conversationId)
    if (!conv) return { ok: false, accepted: false, error: 'Conversation not found.' }
    const model = this.resolveModel(conv)
    if (!model) {
      return { ok: false, accepted: false, error: 'No model is loaded on the server.' }
    }
    this.log('info', 'turn', 'continuing past the step limit')
    return this.runAndReport(conv, model)
  }

  private async runAndReport(
    conv: Conversation,
    model: ModelInfo
  ): Promise<{ ok: boolean; accepted: boolean; error?: string }> {
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
        // Demote the calls that will now never run. Clearing `streaming` left a
        // pending call rendering a pulsing "composing…" dot underneath an error
        // saying the turn had stopped — the card and the message contradicting
        // each other, with the animation the more believable of the two.
        for (const call of last.toolCalls ?? []) {
          if (call.status === 'pending' || call.status === 'running') {
            call.status = 'error'
            call.error = message
            call.finishedAt = Date.now()
          }
        }
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
    /**
     * Replaced on retry, not reused.
     *
     * This was a `const` created once for the whole turn, and the runaway
     * breaker aborts it. The retry then re-entered the loop and called
     * streamChat with that same already-aborted signal, so the rescue request
     * died before it sent a byte and the turn ended with an empty reply. The
     * recovery path had therefore never once worked: every spiral it caught
     * produced nothing, which looks exactly like the model giving up and is
     * why it went unnoticed.
     *
     * `this.active.controller` is repointed with it, so Cancel still stops
     * whichever request is actually in flight.
     */
    let controller = new AbortController()
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
    // Resolved once so the request and the recorded metric cannot disagree
    // about what was actually sent.
    // `let`, because the circuit breaker below retries with thinking off — and
    // it does that WITHOUT touching the saved setting. Silently rewriting the
    // user's own choice because one turn misbehaved would be the app deciding
    // something it was not asked to decide.
    /**
     * The workflow's sampler, with the user's overrides on top.
     *
     * Spread in this order so an override wins and anything untouched still
     * tracks the workflow definition — a later change to a default reaches
     * everyone who has not deliberately moved that one knob.
     */
    const sampling = {
      ...wf.sampling,
      ...(this.d.settings.get().workflowSampling[conv.workflowId] ?? {})
    }

    let effort =
      this.d.settings.get().workflowReasoning[conv.workflowId] ?? wf.sampling.reasoningEffort

    /**
     * How much thinking counts as a spiral rather than deliberation.
     *
     * Was a flat half of the output budget, which was right for the `low`
     * default and wrong for everything else: raising the thinking level made
     * the model spend more, while the cap that stops it stayed put. Measured on
     * qwen3.8-27b at `high`, a first turn on a from-scratch build reached 8,192
     * tokens — the old cap exactly — and was aborted before it had written a
     * line, then retried with thinking OFF. Turning the dial up reliably turned
     * thinking off, which is worse than the dial doing nothing.
     *
     * So it scales. The ceiling is still the output budget, because reasoning
     * bills from the same allowance and past that no complete answer can follow
     * however soon it stops.
     */
    const REASONING_SHARE: Record<string, number> = {
      none: 0.05,
      // 0.2, not 0.5. Half the budget is 8,192 tokens on the Code workflow, and
      // measured on qwen3.8 a first turn will happily spend all of it building a
      // complete mental model before writing a line — eighteen minutes on a
      // one-sentence Tetris request, with nothing on disk. The breaker is not
      // there to allow deliberation, it is there to end a spiral, and a spiral
      // is recognisable long before 8k tokens. Tripping it costs one retry with
      // thinking off, which measurably DOES produce a file.
      low: 0.2,
      medium: 0.45,
      high: 0.75
    }
    const reasoningCap = Math.floor(sampling.maxTokens * (REASONING_SHARE[effort ?? 'low'] ?? 0.5))
    let reasoningSoFar = 0
    let reasoningTripped = false
    let reasoningRetried = false
    /** The last tool call's identity, and how many times it has repeated. */
    let lastCallKey = ''
    let lastResultKey = ''
    let repeatCount = 0
    /** Recent (call, result) outcomes, newest last, for cycle detection. */
    const recentOutcomes: string[] = []
    // Fixed for the whole turn: the tool schemas do not change between
    // iterations, and neither does the window.
    const budget = this.historyBudget(
      model,
      conv.workflowId,
      tools.length === 0 ? 0 : estimateTokens(JSON.stringify(tools))
    )

    /* Set when the loop ends because the model stopped calling tools, or was
       cancelled. If it is still false after the loop, the turn was cut off by
       MAX_ITERATIONS and the user has to be told — see below. */
    let finishedOnItsOwn = false

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (controller.signal.aborted) {
        finishedOnItsOwn = true
        break
      }

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
          temperature: sampling.temperature,
          topP: sampling.topP,
          topK: sampling.topK,
          minP: sampling.minP,
          frequencyPenalty: sampling.frequencyPenalty,
          presencePenalty: wf.sampling.presencePenalty,
          repetitionPenalty: wf.sampling.repetitionPenalty,
          maxTokens: sampling.maxTokens,
          // Reasoning is billed against maxTokens, so an unbounded default can
          // spend the entire answer budget thinking — qwen once used all 8,192
          // of Code's and returned nothing after eleven minutes. The user's
          // per-workflow choice wins over the profile's default.
          reasoningEffort: effort,
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
            reasoningSoFar += 1
            // The circuit breaker. Past this much thinking with nothing written
            // and no tool reached for, the turn is not deliberating, it is
            // spiralling — observed at sixteen minutes and 12.4k tokens,
            // re-deriving decisions it had already made. Aborting here costs
            // seconds; letting it run costs the whole budget and returns
            // nothing.
            if (
              !reasoningTripped &&
              reasoningSoFar > reasoningCap &&
              assistant.content === '' &&
              pendingCalls.size === 0
            ) {
              reasoningTripped = true
              this.log(
                'warn',
                'llm',
                `stopped a runaway: ${reasoningSoFar} reasoning tokens with no answer and no tool call ` +
                  `(cap ${reasoningCap}). Retrying once with thinking off.`
              )
              controller.abort()
            }
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
                status: 'pending',
                // Stamped here, not at execution: this backend names a call and
                // then goes silent for as long as the arguments take to compose.
                // This is the only honest clock for that stretch.
                openedAt: Date.now()
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

      // The other half of the circuit breaker. Aborting a runaway only helps if

      // something comes back — otherwise the user has waited and still has

      // nothing. One retry with thinking off, which is measured to answer this

      // model's questions completely, and only ever once per turn so a

      // genuinely hard request cannot ping-pong.

      if (reasoningTripped && !reasoningRetried) {
        reasoningRetried = true
        // Take the abandoned message OUT, rather than blanking it and moving on.
        //
        // The retry pushes its own assistant message on the next iteration, so
        // this one is superseded entirely — but it was left in the transcript
        // with streaming:true, no body, no tool calls and no error. `streaming`
        // is only stripped when a conversation is LOADED, so it survived every
        // switch away and back, and rendered as an indicator that animated for
        // the rest of the session above everything the retry produced.
        const ghost = conv.messages.indexOf(assistant)
        if (ghost !== -1) conv.messages.splice(ghost, 1)
        assistant.reasoning = undefined
        assistant.content = ''
        effort = 'none'

        // A fresh signal, or the retry inherits the abort that caused it.
        controller = new AbortController()
        if (this.active) this.active.controller = controller

        this.log('info', 'llm', 'retrying the turn with reasoning off')
        continue
      }


      assistant.streaming = false
      meter.setToolSchemaTokens(this.toolTokens(tools))
      meter.setReasoningEffort(effort)
      const turnMetrics = meter.finish(usage, finishReason)
      assistant.metrics = turnMetrics

      /**
       * A turn that produced nothing at all.
       *
       * Measured twice while benchmarking a Tetris build: once when the
       * conversation outgrew the window and the trimmer dropped tool_call
       * messages, and once when the model spent its whole budget reasoning and
       * stopped. Both times the reply came back with no content, no tool call
       * and no error, was saved as an ordinary assistant message, and rendered
       * as a blank turn. From the outside that is indistinguishable from the
       * app having lost the message — and from the inside there was nothing to
       * search the logs for.
       *
       * Named here rather than left blank. `finishReason` usually says why:
       * 'length' means it ran out of budget mid-thought, which is the case
       * worth telling someone about, since the fix is a setting rather than a
       * retry.
       */
      if (assistant.content.trim() === '' && (assistant.toolCalls ?? []).length === 0) {
        const why =
          finishReason === 'length'
            ? `it used all ${usage.completionTokens} tokens without finishing an answer` +
              (turnMetrics.reasoningTokens
                ? ` — ${turnMetrics.reasoningTokens} of them thinking. Lower the thinking level, or raise the reply cap.`
                : '. Raise the reply cap.')
            : `the model returned an empty reply (finish reason: ${finishReason || 'unknown'})`
        assistant.error = `No answer: ${why}`
        this.log('warn', 'llm', `empty turn — ${why}`)
      }
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
        finishedOnItsOwn = true
        break
      }

      /*
       * Stop a model that is learning nothing.
       *
       * Checked BEFORE the calls run, so the pointless call is not made again —
       * with a browser act that means not sending another keypress into a page
       * that has already given the same answer every time.
       */
      const callKey = calls.map((c) => `${c.name}:${c.arguments}`).join('|')
      const repeating = callKey === lastCallKey && repeatCount + 1 >= MAX_IDENTICAL_CALLS
      const cycling =
        recentOutcomes.length >= CYCLE_WINDOW &&
        new Set(recentOutcomes.slice(-CYCLE_WINDOW)).size <= CYCLE_DISTINCT
      if (repeating || cycling) {
        const name = calls[0]?.name ?? 'a tool'
        const why = repeating
          ? `${name} returned the same result ${repeatCount + 1} times in a row`
          : `the last ${CYCLE_WINDOW} tool calls produced only ` +
            `${new Set(recentOutcomes.slice(-CYCLE_WINDOW)).size} different outcomes between them`
        for (const call of calls) {
          call.status = 'error'
          call.error = 'Stopped: this was going in circles.'
          call.finishedAt = Date.now()
        }
        assistant.streaming = false
        assistant.error =
          `stopped because ${why}. Nothing is changing, so running it again cannot tell you ` +
          `anything new. Everything before this is intact. Try something different — and if a ` +
          `check keeps failing the same way, consider that the check itself may be wrong.`
        this.log('warn', 'turn', `loop breaker: ${why}`)
        this.persist(conv, true)
        finishedOnItsOwn = true
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

      /* Results are compared by a bounded digest: a screenshot result is
         hundreds of kilobytes of base64, and holding two of those per iteration
         to answer "was it the same?" is a lot of memory for one boolean. */
      const resultKey = calls
        .map((c) => `${c.status}:${(c.result ?? c.error ?? '').length}:${(c.result ?? c.error ?? '').slice(0, 200)}`)
        .join('|')
      repeatCount = callKey === lastCallKey && resultKey === lastResultKey ? repeatCount + 1 : 0
      lastCallKey = callKey
      lastResultKey = resultKey
      recentOutcomes.push(`${callKey}=>${resultKey}`)
      if (recentOutcomes.length > CYCLE_WINDOW * 2) recentOutcomes.shift()
    }

    /*
     * Running out of steps is a thing that HAPPENED, not a thing to hide.
     *
     * The loop used to end here with nothing at all: no message, no log, no
     * marker. A turn cut off mid-debug looked exactly like a turn that had
     * finished, and the transcript's last entry was a tool result with no reply
     * after it. Observed three times in one build, each time leaving the user to
     * guess whether the app had hung.
     *
     * Said in the transcript rather than only in the log, because the log is not
     * where anyone is looking, and phrased as what to do next: the history is
     * intact, so anything at all will carry on from here.
     *
     * Lower-case and verb-first because the turn strip prefixes it — it renders
     * as "The last turn stopped early — ran out of steps after 100 of them".
     */
    if (!finishedOnItsOwn) {
      const steps = MAX_ITERATIONS
      conv.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: '',
        // A typed marker, not a phrase to match on: the renderer offers to carry
        // on from this and must not start doing so because some other error
        // happened to contain the same words.
        stoppedAtCap: true,
        error:
          `ran out of steps after ${steps} of them. This is the harness's limit for a single ` +
          `turn, not the model giving up — everything it did is above and the work is saved. ` +
          `Send anything to carry on from here.`,
        createdAt: Date.now()
      })
      this.log('warn', 'turn', `hit the ${steps}-step limit without finishing`)
      this.persist(conv, true)
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
        // Kept alongside the prose, so a panel can draw the result rather than
        // parsing the sentence written for the model to read aloud.
        call.structured = result.structured
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

    /*
     * A model the user LOADED outranks a model this app merely prefers.
     *
     * This used to be the other way round, and the reasoning was that swapping
     * is the expected cost of changing the kind of work. That holds when the
     * app is choosing between models nobody has an opinion about. It does not
     * hold when someone has just deliberately loaded a particular build to try
     * it: the workflow's preference silently evicted it and spent twenty
     * seconds loading a different quantisation of the same model, which is not
     * a cost, it is the app overruling the person using it.
     *
     * Observed exactly that: a Q4_K_XL build loaded by hand, replaced on the
     * first message by the stock Q4_K_M named in this workflow's definition.
     *
     * Order now: what this conversation pins, then what the settings pin, then
     * WHATEVER IS ALREADY THERE, and only if the box is empty does the
     * workflow's preference decide what to load. Swapping still happens — it
     * just no longer happens over the top of a choice someone made.
     */
    if (residentId) {
      const resident = models.find((m) => m.id === residentId)
      if (resident) return resident
    }

    const preferred = this.workflow(conv.workflowId).preferredModel
    if (preferred) {
      const match = models.find((m) => m.id === preferred)
      if (match) return match
    }
    // Nothing resident: fall back to any tool-capable model so a first request
    // can JIT-load one rather than refusing outright.
    return models.find((m) => m.supportsTools) ?? models[0] ?? null
  }

  private recordArtifact(workflowId: WorkflowId, artifact: Artifact): void {
    this.d.artifacts.add(workflowId, artifact)
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
    const conversationId = this.active.conversationId
    this.active = null
    this.d.models.setActive(false)
    // Context usage is otherwise only recomputed at the TOP of a turn, so the
    // moment a turn finished the figure still excluded the reply that had just
    // landed — thousands of tokens short after a step that writes a file. That
    // number is read most carefully in the pause before sending the next
    // message, which was exactly when it was wrong.
    try {
      this.d.emit('event:contextUsage', {
        conversationId,
        usage: this.contextUsage(conversationId)
      })
    } catch {
      /* A conversation deleted mid-turn has no usage to report. */
    }
  }

  private log(level: 'info' | 'warn' | 'error', scope: string, message: string): void {
    this.d.emit('event:log', { level, scope, message })
  }
}
