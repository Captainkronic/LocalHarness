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
  ReasoningEffort,
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
import { fetchServerProgress } from './llm/activity'
import { buildContextUsage, buildMessages, type TrimInfo } from './llm/prompt'
import { TurnMeter, RateCalibrator } from './telemetry/meter'
import {
  callKeyFor,
  canAutoContinue,
  collapseResultUrls,
  demoteOrphanedCalls,
  isActing,
  loopAdvice,
  loopVerdict,
  shapeKeyFor,
  targetKeyFor,
  type LoopEntry
} from './agent/loopbreak'
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

/* The loop breaker lives in agent/loopbreak.ts: three rules, each added
   after a real run got past the ones before it. */

/** Enough tail for the widest rule (a period-4 cycle needs twelve). */
const LOOP_HISTORY = 32

/**
 * Spirals a single turn is allowed before thinking is taken away for good.
 *
 * One is a stumble and deserves the thinking back. Three is a turn that cannot
 * deliberate on this particular problem, and handing it back a fourth time
 * costs another eighteen minutes to learn the same thing.
 */
const MAX_REASONING_TRIPS = 3

/**
 * Spirals in one turn before thinking is taken away for GOOD.
 *
 * MAX_REASONING_TRIPS counts spirals in a row and is right to be small. This
 * counts them across the whole turn and exists because the small counter used
 * to latch permanently: three spirals set `effortLatchedOff` and nothing ever
 * cleared it, so a turn that stumbled on its opening plan ran the next several
 * HOURS with thinking off.
 *
 * Measured on a website build: the model spent its first minutes planning an
 * open-ended brief, tripped the breaker three times doing it, and then wrote
 * seventeen steps and twenty-two files with `reasoningEffortUsed: none` — while
 * the picker in the sidebar said Med the entire time. Every one of those steps
 * was work the setting was chosen for.
 *
 * A turn that goes on to call tools has demonstrated it is not spiralling, so
 * progress now gives thinking back. This is the backstop for the turn where it
 * really is hopeless.
 */
const HARD_REASONING_TRIPS = 8

/**
 * How many times a turn will re-issue a request that came back completely empty.
 *
 * An empty reply — no content, no tool calls, no error — is almost never the
 * model having nothing to say. It is what the app sees when the server dropped
 * the request underneath it: LM Studio being restarted, a model reloaded with
 * different settings, a socket replaced mid-flight. The stream closes tidily
 * and reports `finish_reason` of nothing at all.
 *
 * Until this existed the turn simply ended there and waited for a human. That
 * is fine when someone is watching and fatal when nobody is: an overnight run
 * would sit finished-but-unfinished for hours because the server had blinked
 * for two seconds. Observed exactly that way — a reload of the model on the
 * serving machine ended a build turn with "the model returned an empty reply
 * (finish reason: unknown)" and the run stopped for good.
 *
 * Two, not more: if a third identical request also comes back empty, the server
 * is not blinking, it is down, and retrying forever would hide that.
 */
/** How often to ask the server what it is doing. See progressTimer. */
const SERVER_PROGRESS_MS = 2_000

const MAX_EMPTY_RETRIES = 2

/**
 * Loop trips answered with advice before the turn is actually ended.
 *
 * A model that is told why it is circling can usually get out of it; one that
 * is told twice and circles anyway is not going to.
 */
const MAX_LOOP_NUDGES = 2

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
  progressTimer: NodeJS.Timeout
  /** Where to ask about progress — the model's own endpoint, not the default. */
  progressBaseUrl: string
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

/**
 * The prompt size a server refused, or null if this error is about something
 * else.
 *
 * Deliberately narrow. Retrying a smaller prompt against an out-of-memory model
 * load, or a template complaint, would be a guess dressed as a recovery — this
 * only fires when the message is specifically about prefill or context size AND
 * carries a number to clamp against.
 */
export function windowRefusal(message: string): number | null {
  if (!/prefill|context too large|context length|kv_len/i.test(message)) return null
  const m = /kv_len[=:\s]+(\d+)/i.exec(message) ?? /(\d{4,})\s*tokens?/i.exec(message)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
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
    if (budget <= 0) return undefined
    /*
     * Expressed back in ESTIMATE units, because that is what trimToBudget counts in.
     *
     * `window`, `reply` and the margin are all real server-side token counts,
     * but the trimmer measures the history with the same character-based
     * estimate that undercounts code by about a third. Handing it a real-token
     * budget therefore let it keep roughly 1.5x what would fit. Measured: a
     * meter reading 42.3k against a prompt the server counted as 63.7k, and a
     * turn that died with finish_reason 'length' having produced nothing.
     *
     * The ratio is learned per model from previous requests and is 1 until
     * something has been measured, so this is a no-op on a fresh model.
     */
    const ratio = this.calibrator.promptTokenRatio(model.id)
    const inEstimateUnits = Math.floor(budget / (ratio > 0 ? ratio : 1))
    return inEstimateUnits > 0 ? inEstimateUnits : undefined
  }

  /**
   * Records a trim on the conversation and says so in the log.
   *
   * ASSIGNS rather than accumulates. Trimming is recomputed from scratch on
   * every request, so the same old messages are dropped again each time; adding
   * them up counted one lost message once per request for the rest of the
   * conversation. The banner grew without bound — "147 earlier messages are no
   * longer being sent" on a conversation that had lost three — and since it only
   * ever went up, it also went on asserting a present-tense fact long after a
   * larger model had made it false. What the reader needs is how much the model
   * cannot see RIGHT NOW, which is exactly this request's figure.
   */
  private noteTrim(conv: Conversation, modelId: string, info: TrimInfo): void {
    conv.trimmedMessages = info.messages
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
        calibrated: false,
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
      max: model ? this.d.models.contextWindow(model.id) : null,
      ratio: model ? this.calibrator.promptTokenRatio(model.id) : 1
    })
  }

  /**
   * Abort whatever request is in flight, whichever conversation owns it.
   *
   * For quit. `cancel()` needs a conversation id because it is the user
   * pressing Stop on a particular chat; shutdown has no such id and must not
   * need one — it just has to make sure nothing is left generating.
   *
   * Skipping this was measured as a nine-minute stall. Quitting the app tore
   * down MCP, speech, polling and the served folders but left the HTTP request
   * to LM Studio open, so the server carried on generating a reply nobody would
   * ever read. With `--parallel 1` the next request — a brand new run, after a
   * rebuild — queued behind that orphan and sat at "Reading 4.4k tokens of
   * context" for nine minutes before it started. Nothing was wrong with it, and
   * nothing about the app said so.
   */
  abortActive(): void {
    this.active?.controller.abort()
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
      /*
       * Carry on by itself, when the stop was one designed to be continued.
       *
       * The step cap and the loop breaker both end a turn with the work intact
       * and a message inviting a human to continue. That invitation is the
       * whole problem for an unattended run — measured across a three-hour
       * build, 4% of wall clock was the app idle waiting for someone to accept
       * it, and that was with someone watching.
       *
       * Only these two reasons, both carried on typed markers rather than
       * matched out of the error text. An empty reply has its own retry; a real
       * error, a cancel, or a model that simply finished must all stay stopped.
       */
      let left = Math.max(0, Math.round(this.d.settings.get().autoContinueTurns ?? 0))
      while (
        canAutoContinue(
          conv.messages[conv.messages.length - 1],
          left,
          this.active?.controller.signal.aborted === true
        )
      ) {
        const last = conv.messages[conv.messages.length - 1]
        left -= 1
        this.log(
          'info',
          'turn',
          `continuing on its own — ${last.stoppedLooping === true ? 'the loop breaker stopped the last turn' : 'the last turn ran out of steps'}, ${left} continuation(s) left`
        )
        await this.runTurn(conv, model)
      }
      return { ok: true, accepted: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', 'turn', message)

      /*
       * A server refusing the prompt for size is recoverable, and says so.
       *
       * oMLX answers an over-large prompt with "Prefill context too large for
       * available memory (preflight safety guard, kv_len=42322)". The number it
       * choked on is right there. Until now the harness had no answer: the turn
       * surfaced a 400 and ended, and a person had to lower contextCap by hand
       * and restart — which is what happened on a live run and cost the rest of
       * it.
       *
       * Recording the refusal clamps the window for the session, and marking the
       * turn recoverable hands it to the auto-continue path, which rebuilds the
       * prompt against the smaller window and carries on. Reusing that machinery
       * rather than adding a second retry keeps one answer to "how does a turn
       * resume", and it inherits its counter so this cannot loop.
       */
      const refused = windowRefusal(message)
      if (refused !== null) {
        const model = this.resolveModel(conv)
        if (model) this.d.models.noteWindowRefusal(model.id, refused)
        const failing = conv.messages[conv.messages.length - 1]
        if (failing?.role === 'assistant') failing.stoppedAtCap = true
      }

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
      progressBaseUrl: settings.baseUrl,
      metricTimer: setInterval(() => {
        this.d.emit('event:liveMetrics', meter.snapshot())
      }, METRIC_EMIT_MS),
      /*
       * Ask the server what it is doing, on a slower beat than the UI tick.
       *
       * The streaming protocol reports nothing through prefill, and nothing
       * through a tool call that this backend only sends once finished — so the
       * app spent eight minutes showing a silence while the machine was flat
       * out. The server publishes the real figures; nobody was asking.
       *
       * Every 2s rather than every 250ms: this is an HTTP round trip to another
       * machine, the underlying number only advances one prefill chunk at a
       * time, and polling it faster would cost more than it tells anyone.
       */
      progressTimer: setInterval(() => {
        const a = this.active
        if (!a) return
        void fetchServerProgress(a.progressBaseUrl, a.controller.signal).then(
          (p) => {
            /* Still the same request? A late answer about a finished one would
               paint progress over an idle turn. */
            if (this.active === a) a.meter.setServerProgress(p)
          },
          () => undefined
        )
      }, SERVER_PROGRESS_MS)
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

    /**
     * What the user has selected, read fresh on every request.
     *
     * Read once per turn before, which meant changing the picker mid-run did
     * nothing until the next message — on a turn that runs for hours, that is
     * indistinguishable from the control being broken. The selection is the
     * intent; the loop should follow it as it stands now, not as it stood when
     * the turn began.
     */
    const selectedEffort = (): ReasoningEffort | undefined =>
      this.d.settings.get().workflowReasoning[conv.workflowId] ?? wf.sampling.reasoningEffort
    /** Set only by the runaway retry, and cleared the moment that request ends. */
    let effortThisRequest: ReasoningEffort | undefined

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
    /* Per request, because the effort can now change between requests — the
       user may move the picker mid-turn, and a rescue sends one request at
       'none'. A cap left over from a different effort would police the wrong
       budget. */
    const reasoningCapFor = (e: ReasoningEffort | undefined): number =>
      Math.floor(sampling.maxTokens * (REASONING_SHARE[e ?? 'low'] ?? 0.5))
    /**
     * Reset per REQUEST, not per turn.
     *
     * Counting across a whole turn conflates two different things: a single
     * request spiralling, and a long turn that has legitimately thought a lot
     * across thirty steps. Only the first is a fault, and only the first should
     * be stopped.
     */
    let reasoningSoFar = 0
    /**
     * How many requests in this turn have spiralled.
     *
     * Was a one-shot boolean, and the hole that left was measured the moment
     * the retry stopped poisoning the rest of the run: request 5 spiralled and
     * was retried, request 6 came back with thinking restored, spiralled again
     * — and sailed straight through, because `tripped` was already true. It
     * spent all 16,384 tokens and EIGHTEEN MINUTES reasoning, and returned
     * nothing.
     *
     * The old bug hid this. With thinking stuck off for the rest of the turn no
     * second spiral was possible, so a broken brake looked like a working one.
     */
    let reasoningTrips = 0
    /** Never reset. The backstop behind the resettable counter. */
    let reasoningTripsTotal = 0
    /** Counts across the whole turn, so a flapping server cannot loop forever. */
    let emptyRetries = 0
    /** Set once a turn has spiralled too often to be trusted with thinking. */
    /*
     * There is no permanent override any more.
     *
     * A spiral is rescued by re-sending THAT request with thinking off, which
     * is self-clearing and lasts exactly one request. What used to happen
     * instead was a latch: three spirals and thinking was gone for the rest of
     * the turn, which on a multi-hour turn meant hours of work done blind while
     * the picker in the sidebar still read Med.
     *
     * Once the rescue allowance is spent the breaker stops INTERVENING — it
     * lets the request run at whatever the user has selected. A request that
     * then burns its budget is recoverable and, importantly, visible: it
     * reports finish_reason 'length' and says so. Silently changing a setting
     * the user can see is worse than an honest failure they can act on.
     */
    /** The last tool call's identity, and how many times it has repeated. */
    /* Everything the breaker needs, oldest first; only the tail is read. */
    const loopHistory: LoopEntry[] = []
    /** Loop trips so far this turn. The first few are corrections, not endings. */
    let loopNudges = 0
    // Fixed for the whole turn: the tool schemas do not change between
    // iterations, and neither does the window.
    /* Recomputed per request inside the loop — see the learn() call there. A
       budget derived once from a window that later changed is worse than no
       budget, because it trims confidently to the wrong ceiling. */
    const toolTokensForBudget = tools.length === 0 ? 0 : estimateTokens(JSON.stringify(tools))

    /* Set when the loop ends because the model stopped calling tools, or was
       cancelled. If it is still false after the loop, the turn was cut off by
       MAX_ITERATIONS and the user has to be told — see below. */
    let finishedOnItsOwn = false

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (controller.signal.aborted) {
        finishedOnItsOwn = true
        break
      }

      /* Consumed here, once. The retry sets it and continues; taking it at the
         top of the next iteration and clearing it in the same breath is what
         stops one spiral from silencing the rest of the run. */
      /*
       * Re-learn the window on every request, not once per turn.
       *
       * `learn()` early-returns unless its observation is older than its own
       * TTL, so this is a no-op on all but roughly one request in two minutes.
       * What it buys is that a window which CHANGES under a running turn is
       * noticed — and a turn here can run for hours.
       *
       * Not hypothetical: reloading the server with a different context length
       * mid-run left the meter reading 131k against a real slot of 98,304, and
       * the history budget is computed from the same number, so the trimmer was
       * working to a ceiling a third higher than the one that existed. An idle
       * eviction followed by a JIT reload does the same thing without anyone
       * touching it.
       */
      await this.d.models.learn(model.id).catch(() => undefined)

      const requestEffort = effortThisRequest ?? selectedEffort()
      effortThisRequest = undefined
      /*
       * The opening request gets more room, because "nothing written yet" is
       * not evidence there.
       *
       * The breaker fires on reasoning past the cap AND nothing written AND no
       * tool call pending. On the FIRST request of a turn the second clause is
       * true by definition, so the test collapses to the cap alone — and the
       * opening plan is precisely where a model is supposed to think hardest.
       * The result was that an open-ended brief tripped the breaker on step one
       * every time and was re-sent with thinking off, so `medium` never got
       * used for the one step it was chosen for. Measured on a website build:
       * both recorded requests came back `reasoningEffortUsed: none` while the
       * picker read Med.
       *
       * A spiral across LATER steps is caught by the pondering rule, which
       * looks at reasoning spent over several steps that acted on nothing —
       * evidence this per-request cap cannot see. That is what makes it safe to
       * be generous here.
       */
      const reasoningCap =
        iteration === 0 ? reasoningCapFor(requestEffort) * 2 : reasoningCapFor(requestEffort)
      /* Both per-REQUEST: the spiral counter measures this request, and the cap
         applies to it alone. */
      reasoningSoFar = 0
      let trippedThisRequest = false

      const budget = this.historyBudget(model, conv.workflowId, toolTokensForBudget)
      /* onTrim only fires when something IS dropped, so the count has to be
         cleared here or it could never fall back to zero. */
      conv.trimmedMessages = 0
      const messages = buildMessages(conv, wf.systemPrompt, model.supportsVision, {
        budget,
        onTrim: (info) => this.noteTrim(conv, model.id, info),
        workspaceRoots: settings.workspaceRoots
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

      /* Ask for progress at the endpoint this turn is actually using. A model
         served by a second backend is the whole reason progress was invisible. */
      if (this.active) this.active.progressBaseUrl = model.baseUrl || settings.baseUrl

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
          reasoningEffort: requestEffort,
          signal: controller.signal
        },
        {
          onFirstToken: () => {
            meter.markFirstToken()
            this.d.emit('event:liveMetrics', meter.snapshot())
          },
          onContent: (delta) => {
            assistant.content += delta
            meter.countCompletionToken(estimateTokens(delta))
            this.persist(conv, false)
          },
          onReasoning: (delta) => {
            assistant.reasoning = (assistant.reasoning ?? '') + delta
            // Counts toward decode rate and the completion total, but tracked
            // separately so TurnMetrics.reasoningTokens is actually populated.
            /*
             * Tokens in this delta, not "one delta".
             *
             * These counted 1 per SSE frame, and a frame carries several tokens
             * — measured against oMLX and the server's own usage figures, about
             * four. Two things were wrong as a result, and only one of them was
             * cosmetic.
             *
             * The live decode gauge read 5.5 tok/s while the finished turn
             * stamped 18.4, and the server's dashboard agreed with the stamp.
             * Every live token readout in the app was low by the same factor.
             *
             * The one that matters: `reasoningSoFar` is compared against
             * `reasoningCap`, which is a count of TOKENS. Feeding it a frame
             * count meant the runaway-reasoning breaker — the thing that exists
             * to stop a spiral at ~12k tokens — did not fire until roughly 49k.
             * It was letting through four times the thinking it was written to
             * catch, while logging the frame count as "reasoning tokens".
             *
             * estimateTokens is chars/4 and imperfect, but it is wrong by a few
             * percent where counting frames was wrong by 4x.
             */
            const reasoningTokens = estimateTokens(delta)
            meter.countReasoningToken(reasoningTokens)
            reasoningSoFar += reasoningTokens
            // The circuit breaker. Past this much thinking with nothing written
            // and no tool reached for, the turn is not deliberating, it is
            // spiralling — observed at sixteen minutes and 12.4k tokens,
            // re-deriving decisions it had already made. Aborting here costs
            // seconds; letting it run costs the whole budget and returns
            // nothing.
            if (
              !trippedThisRequest &&
              reasoningSoFar > reasoningCap &&
              assistant.content === '' &&
              pendingCalls.size === 0
            ) {
              trippedThisRequest = true
              reasoningTrips += 1
              reasoningTripsTotal += 1
              /* Past this many spirals the turn has shown it cannot deliberate
                 on this problem, so thinking stays off for the rest of it
                 rather than being handed back to spiral again. An escalation
                 on repeated evidence, not a verdict on the first stumble. */
              const giveUp = reasoningTrips >= MAX_REASONING_TRIPS
              this.log(
                'warn',
                'llm',
                `stopped a runaway: ${reasoningSoFar} reasoning tokens with no answer and no tool call ` +
                  `(cap ${reasoningCap}, spiral ${reasoningTrips}). ` +
                  (giveUp
                    ? 'Thinking stays off for the rest of this turn.'
                    : 'Retrying that request with thinking off.')
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
            meter.countCompletionToken(estimateTokens(argsDelta))
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

      /*
       * The other half of the circuit breaker. Aborting a runaway only helps if
       * something comes back — otherwise the user has waited and still has
       * nothing. So the aborted request is resent with thinking off, which is
       * measured to answer this model's questions completely.
       *
       * Re-armable, unlike the one-shot this replaces. That version handed
       * thinking back and could never fire again, which was survivable only
       * while a second bug left thinking off for the rest of the turn anyway.
       * With that fixed, request 6 of a real run spiralled a second time and
       * ran unchecked for eighteen minutes on a budget of 16,384 tokens,
       * returning nothing. After MAX_REASONING_TRIPS spirals the turn stops
       * getting thinking back at all.
       */
      if (trippedThisRequest) {
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
        /*
         * ONE request without thinking, not the rest of the turn.
         *
         * This used to assign to `effort` itself, which is declared for the
         * whole turn — so a single spiral at request 13 of a 90-request run
         * turned thinking off for the other 77 AND every turn that followed,
         * while the sidebar went on saying "Med". The model spent the rest of
         * that session doing exactly what this workflow's own notes say
         * thinking-off does: working blind, re-reading the same page and never
         * reasoning about what it saw.
         *
         * The retry is a way out of one spiral, not a verdict on the setting.
         */
        /* Off for the retry. Once the turn has spiralled MAX_REASONING_TRIPS
           times, `effortForRest` latches so it stays off — see the counter. */
        effortThisRequest = 'none'

        // A fresh signal, or the retry inherits the abort that caused it.
        controller = new AbortController()
        if (this.active) this.active.controller = controller

        this.log('info', 'llm', 'retrying the turn with reasoning off')
        continue
      }


      assistant.streaming = false
      meter.setToolSchemaTokens(this.toolTokens(tools))
      meter.setReasoningEffort(requestEffort)
      meter.setReasoningCap(reasoningCap)
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
        /*
         * A dropped request is worth one more try; an exhausted budget is not.
         *
         * 'length' means the model really did run to its cap and is a setting
         * to change, so re-sending it would burn another whole budget to reach
         * the same place. Everything else — and in practice that means the
         * server going away mid-request — is transient, and the same prompt
         * usually succeeds immediately on a fresh connection.
         *
         * An aborted turn is the user pressing Stop and must never be retried.
         */
        const transient = finishReason !== 'length' && !controller.signal.aborted
        if (transient && emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries += 1
          /* Same removal the reasoning retry does: an abandoned assistant
             message left in place renders as a streaming indicator forever. */
          const ghost = conv.messages.indexOf(assistant)
          if (ghost !== -1) conv.messages.splice(ghost, 1)
          this.persist(conv, true)
          // A fresh signal, or the retry inherits whatever killed the last one.
          controller = new AbortController()
          if (this.active) this.active.controller = controller
          this.log(
            'warn',
            'llm',
            `empty reply with no tool calls (finish reason: ${finishReason || 'unknown'}) — ` +
              `re-sending that request (${emptyRetries}/${MAX_EMPTY_RETRIES}). ` +
              `The usual cause is the server being restarted underneath the run.`
          )
          continue
        }
        /*
         * The whole budget went on thinking and nothing came out. Retry ONCE
         * with thinking off, exactly as the runaway breaker does mid-stream.
         *
         * This is the same fault the reasoning breaker exists for, arriving by
         * a route it cannot see: the breaker watches a request while it streams
         * and stands down the moment any content or tool call appears, so a
         * request that reasons quietly all the way to its cap reaches the end
         * untouched. Until now that ended the turn with advice addressed to a
         * human — "lower the thinking level, or raise the reply cap" — which is
         * no use at 3am. Watched one turn die exactly this way: 63.7k prompt,
         * 1.8k of reasoning, `finish_reason: length`, nothing produced.
         *
         * Thinking off is the same remedy the breaker applies, and this file's
         * own measurements say it works: the setting that spent every token
         * reasoning produced a complete file once thinking was disabled.
         */
        const spentItAllThinking =
          finishReason === 'length' &&
          !controller.signal.aborted &&
          (turnMetrics.reasoningTokens ?? 0) > 0
        if (spentItAllThinking && reasoningTrips < MAX_REASONING_TRIPS) {
          reasoningTrips += 1
          reasoningTripsTotal += 1
          const ghost = conv.messages.indexOf(assistant)
          if (ghost !== -1) conv.messages.splice(ghost, 1)
          this.persist(conv, true)
          effortThisRequest = 'none'
          controller = new AbortController()
          if (this.active) this.active.controller = controller
          this.log(
            'warn',
            'llm',
            `the request used all ${usage.completionTokens} tokens without answering — ` +
              `${turnMetrics.reasoningTokens} of them thinking. Retrying it with thinking off ` +
              `(spiral ${reasoningTrips}/${MAX_REASONING_TRIPS}).`
          )
          continue
        }

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
      /* What the prompt REALLY cost against what we guessed, so the next
         history budget is computed from a measured ratio rather than from
         four-characters-per-token. `promptTokens` above is our estimate for
         this same request. */
      this.calibrator.observePromptEstimate(model.id, promptTokens, usage.promptTokens)
      this.persist(conv, true)

      const calls = assistant.toolCalls ?? []
      if (!calls.length || controller.signal.aborted) {
        /*
         * A reply cut off at the output cap is a FAILED turn, whether or not it
         * managed to say anything first.
         *
         * This used to check `!assistant.content.trim()`, so it only caught the
         * model that spent everything on reasoning and returned nothing. The
         * commoner and more expensive case walked straight through: asked to
         * build a game, the model reasoned for 8,774 tokens and then wrote the
         * entire program INTO THE REPLY — 44,948 characters, `finish_reason:
         * length`, zero tool calls, nothing on disk. Because content was not
         * empty, none of this fired, `error` stayed null, and the run simply
         * ended. The server sat idle for three hours and the UI showed a
         * finished turn with a long answer in it.
         *
         * So: mark it, say what happened, and tell the model the one thing it
         * needs to do differently. The marker is what lets auto-continue pick
         * the turn back up rather than leaving the run dead.
         */
        if (finishReason === 'length' && !controller.signal.aborted) {
          const thinking = turnMetrics.reasoningTokens ?? 0
          assistant.stoppedTruncated = true
          assistant.error = assistant.content.trim()
            ? `Cut off: the reply hit the ${usage.completionTokens}-token cap` +
              (thinking ? ` after ${thinking} tokens of thinking` : '') +
              ` and made no tool calls, so nothing was written.`
            : 'The model hit its output cap while still reasoning and produced no answer. Raise max tokens for this workflow, or ask something narrower.'
          /* Said in the transcript, not just on the message: `error` is not
             forwarded to the model, and a turn that resumes without knowing why
             it stopped repeats exactly what stopped it. */
          conv.messages.push({
            id: randomUUID(),
            role: 'system',
            content:
              'Your last reply was cut off at the output cap before you finished, and it made no ' +
              'tool calls, so nothing was saved.\n\n' +
              'You were writing file contents into the reply. Do not do that — the reply has a ' +
              'hard limit and anything in it is thrown away. Call write_file, one file per call, ' +
              'and keep each call small enough to complete. Start with the smallest thing that ' +
              'runs, save it, and build up from there.',
            createdAt: Date.now()
          })
          this.persist(conv, true)
        }
        finishedOnItsOwn = true
        break
      }

      /*
       * Progress gives thinking back.
       *
       * A request that reached for a tool is not spiralling, whatever it did
       * before, so the consecutive-spiral counter resets and the latch lifts.
       * Without this a stumble on the opening plan — the hardest part of any
       * task and the likeliest place to overthink — silenced the rest of a
       * multi-hour turn, and the sidebar went on reporting the setting the user
       * had chosen rather than the one being sent.
       *
       * `reasoningTripsTotal` is deliberately NOT reset: a turn that keeps
       * spiralling between tool calls still latches for good once it has spent
       * the whole allowance, which is the ping-pong this file has warned about
       * since the one-shot flag was removed.
       */
      if (reasoningTripsTotal < HARD_REASONING_TRIPS) reasoningTrips = 0

      /*
       * Stop a model that is learning nothing.
       *
       * Checked BEFORE the calls run, so the pointless call is not made again —
       * with a browser act that means not sending another keypress into a page
       * that has already given the same answer every time.
       */
      const pending: LoopEntry = {
        callKey: callKeyFor(calls),
        shapeKey: shapeKeyFor(calls),
        resultKey: '',
        acting: isActing(calls),
        target: targetKeyFor(calls),
        reasoning: turnMetrics.reasoningTokens ?? 0
      }
      const verdict = loopVerdict(loopHistory, pending)
      if (verdict) {
        const why = verdict.why
        loopNudges += 1
        /*
         * First trips are a NUDGE, not an ending.
         *
         * Ending the turn made the app's best advice unreachable: it was
         * written to `assistant.error`, and only `content` is forwarded, so the
         * model got the verdict without the diagnosis and a person had to type
         * "continue" to restart something that then had no idea why it had
         * stopped. Refusing the call and handing back the reason lets the turn
         * recover on its own, which is what the advice was for.
         */
        const spent = loopNudges > MAX_LOOP_NUDGES
        const advice = loopAdvice(verdict, calls[0]?.name ?? 'that tool')
        for (const call of calls) {
          /* 'denied', not 'error'. The call was never executed — nowhere else
             in this codebase does 'error' mean that, and the card painted the
             danger border and the word "failed" over a tool that had simply
             been refused. */
          call.status = 'denied'
          call.error = spent ? 'Stopped: this was going in circles.' : advice
          call.finishedAt = Date.now()
          // The model asked for these; it needs a result for each or the next
          // request is malformed.
          this.appendToolResult(conv, call)
        }
        this.log('warn', 'turn', `loop breaker (${verdict.rule}): ${why}`)

        if (spent) {
          assistant.streaming = false
          assistant.stoppedLooping = true
          assistant.error =
            `stopped because ${why}. It was told twice and kept going, so the turn ends here. ` +
            `Everything before this is intact.`
          this.persist(conv, true)
          finishedOnItsOwn = true
          break
        }

        /* A clean slate, or the very next iteration trips on the same tail and
           the model never gets to act on what it was just told. */
        loopHistory.length = 0
        assistant.streaming = false
        this.persist(conv, true)
        continue
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
        .map((c) => {
          /* Normalised BEFORE the length is taken: a ?retry=9 -> ?retry=10 goes
             one character longer, which on its own is enough to make two
             identical answers look like two different ones. */
          const digest = collapseResultUrls(c.result ?? c.error ?? '')
          return `${c.status}:${digest.length}:${digest.slice(0, 200)}`
        })
        .join('|')
      loopHistory.push({ ...pending, resultKey })
      if (loopHistory.length > LOOP_HISTORY) loopHistory.shift()
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
        // Same contract as MCP below: facts for the card, prose for the model.
        call.structured = result.structured
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
      max: this.d.models.contextWindow(model.id),
      ratio: this.calibrator.promptTokenRatio(model.id)
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
    clearInterval(this.active.progressTimer)
    this.active.meter.reset()
    this.d.emit('event:liveMetrics', this.active.meter.snapshot())
    const conversationId = this.active.conversationId
    this.active = null
    this.d.models.setActive(false)

    /*
     * No tool call may outlive the turn that issued it.
     *
     * The throw path already demoted pending calls (see the catch in
     * runAndReport, which explains why: a pulsing "composing…" dot underneath a
     * message saying the turn had stopped, with the animation the more
     * believable of the two). The CANCEL path was missed. Press Stop during a
     * message that issued more than one call and the main process treats the
     * rest as denied while the renderer's last snapshot still has them pending
     * — and because characters had already arrived, the card's own tick is
     * disabled, so it settles into a frozen character count under an animated
     * busy dot. A stopped clock wearing a live indicator.
     *
     * Doing it here covers every way a turn can end, including ones added later.
     */
    try {
      const conv = this.d.conversations.get(conversationId)
      const last = conv?.messages[conv.messages.length - 1]
      const changed =
        last?.role === 'assistant' ? demoteOrphanedCalls(last.toolCalls, Date.now()) : false
      if (changed && conv) this.persist(conv, true)
    } catch {
      /* A conversation deleted mid-turn has nothing left to tidy. */
    }
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
