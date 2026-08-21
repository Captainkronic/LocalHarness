/**
 * The spoken turn pipeline.
 *
 * A turn arrives as PCM from the renderer (which owns the microphone, the VAD
 * and therefore the decision that an utterance ended) and leaves as audio
 * chunks the renderer plays. In between: whisper locally, the model on the Mac
 * Studio, Kokoro locally.
 *
 * The single design decision everything else follows from is SENTENCE-WISE TTS.
 * Waiting for the whole reply before speaking any of it turns a conversation
 * into a kiosk: the model's own generation is several seconds, and none of that
 * time needs to be silent. So completed sentences are handed to Kokoro as they
 * stream, the first one eagerly however short it is, and the user hears the
 * beginning of an answer while the end of it is still being written.
 *
 * `firstAudioMs` is the number that decides whether this feels like a
 * conversation, and it is measured from the moment the utterance arrived to the
 * moment the first chunk goes out — not summed from the stages, which would
 * quietly hide anything that happens between them.
 *
 * Ordering and interruption are handled with one generation counter. Every turn
 * takes the next value; `interrupt()` bumps it. Synthesis already in flight
 * cannot be cancelled (voice-mcp has no cancel), so it completes and is
 * discarded on the way out rather than being played over the next turn.
 *
 * One wart worth knowing about: `LiveAudioChunk.last` can only be set honestly
 * once the model has stopped streaming, and a chunk is emitted the instant its
 * audio exists. When the final sentence's audio is ready BEFORE the stream ends
 * — uncommon, but possible — no chunk can carry the flag, so a terminal chunk
 * with an empty `dataUrl` follows to close the turn. A player must skip an empty
 * dataUrl rather than try to play it.
 */

import { randomUUID } from 'node:crypto'

import type {
  Artifact,
  ChatMessage,
  Conversation,
  LiveAudioChunk,
  LiveExchange,
  LiveSessionState,
  LiveSessionStatus,
  LiveSettings,
  LiveTurnTimings,
  LiveMetrics,
  ModelInfo,
  Settings,
  ToolCall,
  TurnMetrics,
  WorkflowDefinition,
  WorkflowId
} from '@shared/types'
import { WORKFLOW_BY_ID, isVoiceWorkflow } from '@shared/workflows'

import { streamChat, type WireMessage } from '../llm/client'
import type { ModelRegistry } from '../llm/models'
import { buildMessages } from '../llm/prompt'
import type { LogFn, McpManager } from '../mcp/manager'
import { estimateTokens } from '../mcp/tokens'
import { RateCalibrator, TurnMeter } from '../telemetry/meter'
import type { ConversationStore } from '../store/conversations'

import type { SpeechServices } from './speech'
import { decodeWavToDataUrl, encodeWav } from './wav'

const SCOPE = 'live'

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  // Jarvis. See VOICE_PRESETS in shared/workflows.ts.
  voice: 'bm_daniel',
  speed: 0.95,
  vadThreshold: 0.02,
  silenceMs: 700,
  // 700 + 700. Measured against the failure it exists to stop: a pause to think
  // of a word, which runs to roughly half a second, was landing inside the old
  // 700ms window and sending half a sentence. Together they cost about 1.4s of
  // wall clock before the reply starts, which is the honest price of not being
  // interrupted, and both halves are adjustable.
  pauseGraceMs: 700,
  minUtteranceMs: 350,
  video: false,
  // OFF by default. With speakers, barge-in is an audio feedback loop: the
  // microphone hears the assistant, scores it as speech, interrupts, starts a
  // new turn, and that turn speaks again. Observed doing exactly that. It is
  // genuinely useful on headphones, so it stays available — just not assumed.
  bargeIn: false,
  speak: true
}

/** Live captions would otherwise push a status object per token. */
const STATUS_PUSH_MS = 120

/* Same 60ms the Orchestrator coalesces conversation pushes at, so a streaming
   spoken reply arrives on screen at the same cadence as a typed one. */
const CONV_EMIT_MS = 60

/** Telemetry cadence. Fast enough that the elapsed clock does not visibly
 *  stutter, slow enough that it is not a render per token. */
const METRIC_EMIT_MS = 250

/** Exchanges kept for the transcript rail. */
const MAX_EXCHANGES = 100
/** Frames are hundreds of KB each and every `live:exchanges` call copies them,
 *  so only the newest few keep theirs. */
const MAX_FRAMES_KEPT = 8

/**
 * A frame larger than this is a renderer bug (it should be downscaling before
 * it sends), and putting it on the wire would cost more prefill than the whole
 * conversation. Dropped with a warning rather than sent.
 */
const MAX_FRAME_CHARS = 6 * 1024 * 1024

/**
 * RMS below which an utterance is silence or room tone, whatever whisper claims
 * to hear in it.
 *
 * This exists because whisper does NOT return an empty string for silence — it
 * hallucinates, and measured on this machine one second of digital silence comes
 * back as "Thank you." An unguarded pipeline answers that, so the user gets a
 * reply to something they never said. The floor is roughly -54 dBFS, far below
 * any usable VAD threshold, so a quiet but real sentence is never dropped here;
 * deciding what counts as speech remains the renderer's job.
 */
const SILENCE_RMS = 0.002

/** Sentences below this are merged with the next one, EXCEPT the first of a
 *  turn: the first chunk sets the perceived latency, so it goes out at any
 *  length. After that, staccato one-word chunks sound worse than waiting. */
const MIN_CHUNK_CHARS = 60
/** A model that never punctuates would otherwise stay silent until the stream
 *  ended. Past this, break at a word boundary. */
const MAX_CHUNK_CHARS = 320

/**
 * How many times a single spoken turn may go out to tools before it must
 * answer with what it has.
 *
 * Deliberately small. Every round is another full prefill of a conversation
 * that already carries a system prompt and tool schemas, and the user is
 * WAITING OUT LOUD — silence past a few seconds reads as the assistant having
 * died, not as diligence. Two rounds covers "check the weather", and
 * "search the mail, then read that one message", which is the real ceiling of
 * what anyone asks for by voice.
 */
const MAX_TOOL_ROUNDS = 2

/**
 * Tool output is truncated to this before it enters the conversation.
 *
 * A mail search returns headers, snippets and quoted threads; unclipped, one
 * call can outweigh the entire spoken conversation and every later turn pays
 * that prefill again. The model only needs enough to say a sentence about it.
 */
const MAX_TOOL_RESULT_CHARS = 4_000

const SPEECH_UNAVAILABLE =
  'Speech is unavailable — voice-mcp did not start, so nothing can be heard or spoken.'

export interface LiveSessionOptions {
  speech: SpeechServices
  models: ModelRegistry
  mcp: McpManager
  conversations: ConversationStore
  getSettings: () => Settings
  onStatus: (s: LiveSessionStatus) => void
  onAudio: (c: LiveAudioChunk) => void
  onExchange: (e: LiveExchange) => void
  /**
   * The conversation changed — push it to the window.
   *
   * Without this a spoken turn is invisible. session.ts writes straight into
   * `conv.messages` and calls `conversations.save`, which persists it to disk
   * and tells nobody: the renderer keeps its OWN copy of the conversation and
   * only ever learns about a change from `event:conversationUpdated`, which
   * until now only the Orchestrator emitted. So typed turns appeared and
   * spoken ones did not — the answer had been generated, spoken aloud and
   * saved, and the transcript on screen simply did not have it. Measured on a
   * real call: 32 messages on disk, 29 on screen, the missing three being the
   * spoken exchange.
   */
  onConversation: (c: Conversation, structural: boolean) => void
  /**
   * A file a spoken turn produced.
   *
   * Same store and same channel the Orchestrator uses, so the panel does not
   * care which kind of turn wrote the file.
   */
  onArtifact: (workflowId: WorkflowId, artifact: Artifact) => void
  /**
   * Per-request telemetry, at ~4Hz.
   *
   * The instrument strip at the top of the window has always been able to draw
   * this — phase, prefill bar, both speed gauges — and during a spoken turn it
   * sat at idle, because only the Orchestrator fed it. So the one mode where
   * you cannot see the text arriving was also the one mode with no telemetry.
   */
  onMetrics: (m: LiveMetrics) => void
  onLog: LogFn
}

/** Per-turn audio bookkeeping. Lives only as long as the turn does. */
interface AudioTurn {
  turnId: string
  generation: number
  /** Sentences handed to TTS so far. */
  queued: number
  /** Next `seq` to go out. */
  seq: number
  emitted: number
  /** True once the model has stopped and the tail fragment has been queued. */
  streamFinished: boolean
  markedLast: boolean
  firstSentenceAt: number | null
  firstAudioAt: number | null
  /** Synthesis runs one at a time so `seq` is emission order. */
  chain: Promise<void>
}

export class LiveSession {
  private readonly o: LiveSessionOptions

  private live: LiveSettings = { ...DEFAULT_LIVE_SETTINGS }
  private state: LiveSessionState = 'off'
  private conversationId: string | null = null

  /**
   * The workflow this session is running as, taken from the conversation.
   *
   * This was a module constant pinned to `live`, which meant Flight Booker
   * spoke with Live's persona and was offered Live's tools instead of its own —
   * so asked for a fare it apologised as Jarvis, having never been given a
   * flight tool to call. A spoken workflow is not the Live workflow; it is
   * whichever one the conversation belongs to.
   *
   * Null while stopped, rather than defaulting to Live. A default is how the
   * original bug would come back: it would be silently correct for the one
   * workflow it names and silently wrong for every other, which is exactly the
   * failure that is hard to see from the outside.
   */
  private wf: WorkflowDefinition | null = null

  private get workflow(): WorkflowDefinition {
    if (this.wf === null) {
      throw new Error('live session has no workflow — start() has not run')
    }
    return this.wf
  }

  /** Tools running right now, comma-joined for the HUD. */
  private toolLabel = ''
  private lastUserText = ''
  private assistantText = ''
  private turnCount = 0
  private lastTimings: LiveTurnTimings | null = null
  private errorText: string | undefined

  private readonly exchangeLog: LiveExchange[] = []
  private knownVoices: string[] = []

  /** Bumped by every turn and by every interrupt; work tagged with an old value
   *  is discarded rather than applied. */
  private generation = 0
  private turnActive = false
  private abort: AbortController | null = null
  private lastStatusAt = 0
  private lastConvEmitAt = 0
  /**
   * The id the in-flight reply will be committed under.
   *
   * Minted before the model starts and reused when the message is finally
   * pushed, so the streaming bubble and the saved message are the same message
   * to the renderer rather than one replacing the other. Without it React sees
   * the key change at the end of every turn and remounts the bubble, which
   * reads as a flicker exactly when the answer settles.
   */
  private draftId = randomUUID()
  /** So a text-only model is complained about once per session, not per turn. */
  private warnedNoVision = false

  /** What the model is thinking, this turn, as it arrives. Never spoken and
   *  never recorded as the answer — see onReasoning. */
  private reasoningText = ''

  /** Its own, rather than the Orchestrator's: this one learns from spoken turns
   *  on whatever model the voice workflows use, which is usually not the model
   *  the typed ones run on. */
  private readonly calibrator = new RateCalibrator()
  private meter: TurnMeter | null = null
  private metricTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: LiveSessionOptions) {
    this.o = opts
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async start(conversationId: string): Promise<{ ok: boolean; error?: string }> {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return { ok: false, error: 'A conversation id is required to start a live session' }
    }
    const conv = this.o.conversations.get(conversationId)
    if (conv === null) {
      return { ok: false, error: `Conversation ${conversationId} no longer exists` }
    }
    // Refused rather than coerced. A workflow that is not spoken has native
    // tools and approval gates this loop cannot run, and starting it here would
    // half-work: it would talk, and quietly fail to do anything it offered.
    if (!isVoiceWorkflow(conv.workflowId)) {
      return { ok: false, error: `${conv.workflowId} is not a spoken workflow` }
    }
    // AFTER the stop below, not before: stop() clears the workflow, so setting
    // it here would leave a restarted session with no workflow — and the
    // sessionHook that depends on it would silently never fire.
    if (this.state !== 'off') await this.stop()
    this.wf = WORKFLOW_BY_ID[conv.workflowId]

    this.conversationId = conversationId
    this.errorText = undefined
    this.lastUserText = ''
    this.assistantText = ''
    this.reasoningText = ''
    this.turnCount = 0
    this.lastTimings = null
    this.exchangeLog.length = 0
    this.warnedNoVision = false
    this.setState('starting')

    // Never fatal: without voice-mcp the session still runs, it just cannot hear
    // or speak, and the status carries the reason.
    await this.o.speech.start()
    if (this.o.speech.available()) {
      this.knownVoices = await this.o.speech.voices()
      if (this.knownVoices.length > 0 && !this.knownVoices.includes(this.live.voice)) {
        const fallback = this.knownVoices[0]
        this.o.onLog('warn', SCOPE, `voice "${this.live.voice}" is unknown; using ${fallback}`)
        this.live.voice = fallback
      }
    } else {
      this.knownVoices = []
      this.errorText = SPEECH_UNAVAILABLE
    }

    // Before the first turn, so the case file the panel draws and the case the
    // model is told about are the same one from the very first word. Failure is
    // logged and swallowed: a session that cannot bind a case is still a usable
    // conversation, and dying here would take the call down over bookkeeping.
    const hook = this.wf?.sessionHook
    if (hook) {
      try {
        const result = await this.o.mcp.callDirect(hook.server, hook.tool, {
          id: conversationId
        })
        if (result === null) {
          this.o.onLog('warn', SCOPE, `${hook.server} is not running; no case was opened`)
        }
      } catch (err) {
        this.o.onLog('warn', SCOPE, `${hook.server}.${hook.tool} failed: ${messageOf(err)}`)
      }
    }

    this.warmModel()
    // Kokoro and Whisper load lazily on first use; together that is ~7.5s of
    // dead air on the first sentence. Warm them alongside the model.
    void this.o.speech.prewarm(this.live.voice)
    this.setState('listening')
    return { ok: true }
  }

  async stop(): Promise<void> {
    this.cancelTurn()
    this.conversationId = null
    this.wf = null
    this.setState('off')
  }

  /**
   * Barge-in. Abandons the reply in flight and returns to listening at once;
   * audio already handed to Kokoro is left to finish and then dropped, because
   * there is nothing to cancel it with.
   */
  async interrupt(): Promise<void> {
    if (this.state === 'off') return
    this.cancelTurn()
    this.setState('listening')
  }

  status(): LiveSessionStatus {
    return {
      state: this.state,
      // The renderer owns the audio graph and paints its own meter from it.
      // Main only ever sees one finished utterance at a time, which is not a
      // live level, so anything but zero here would be a lie.
      level: 0,
      userSpeaking: false,
      micEnabled: this.state !== 'off',
      videoEnabled: this.state !== 'off' && this.live.video,
      lastUserText: this.lastUserText,
      assistantText: this.assistantText,
      reasoningText: this.reasoningText,
      turns: this.turnCount,
      toolLabel: this.toolLabel,
      error: this.errorText,
      timings: this.lastTimings
    }
  }

  settings(): LiveSettings {
    return { ...this.live }
  }

  updateSettings(patch: Partial<LiveSettings>): LiveSettings {
    const next: LiveSettings = { ...this.live }

    if (typeof patch.voice === 'string' && patch.voice.trim().length > 0) {
      const wanted = patch.voice.trim()
      if (this.knownVoices.length === 0 || this.knownVoices.includes(wanted)) {
        next.voice = wanted
      } else {
        // voice-mcp silently substitutes its default for a name it does not
        // know, so an unchecked value here would speak in the wrong voice with
        // no indication of why.
        this.o.onLog('warn', SCOPE, `voice "${wanted}" is not one of the ${this.knownVoices.length} available; keeping ${next.voice}`)
      }
    }
    if (isNumber(patch.speed)) next.speed = clamp(patch.speed, 0.5, 2)
    if (isNumber(patch.vadThreshold)) next.vadThreshold = clamp(patch.vadThreshold, 0, 1)
    if (isNumber(patch.silenceMs)) next.silenceMs = clamp(Math.round(patch.silenceMs), 100, 5_000)
    // 0 is a legitimate value here — it means "send as soon as the silence
    // threshold is met", which is the behaviour this setting was added to make
    // optional rather than mandatory.
    if (isNumber(patch.pauseGraceMs)) {
      next.pauseGraceMs = clamp(Math.round(patch.pauseGraceMs), 0, 5_000)
    }
    if (isNumber(patch.minUtteranceMs)) {
      next.minUtteranceMs = clamp(Math.round(patch.minUtteranceMs), 0, 5_000)
    }
    if (typeof patch.video === 'boolean') next.video = patch.video
    if (typeof patch.bargeIn === 'boolean') next.bargeIn = patch.bargeIn
    if (typeof patch.speak === 'boolean') next.speak = patch.speak

    this.live = next
    this.pushStatus()
    return { ...next }
  }

  exchanges(): LiveExchange[] {
    return this.exchangeLog.slice()
  }

  /**
   * ADDITION TO THE SPEC. `live:voices` is routed through the session rather
   * than straight to SpeechServices, so the list the picker shows and the list
   * `updateSettings` validates against are the same one, refreshed here.
   */
  async voices(): Promise<string[]> {
    this.knownVoices = await this.o.speech.voices()
    return this.knownVoices.slice()
  }

  /* ---------------------------------------------------------------- */
  /* The turn                                                         */
  /* ---------------------------------------------------------------- */

  async utterance(
    pcm: ArrayBuffer,
    sampleRate: number,
    frameDataUrl?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const arrivedAt = Date.now()

    if (this.state === 'off' || this.conversationId === null) {
      return { ok: false, error: 'The live session is not running' }
    }
    if (!this.o.speech.available()) {
      return { ok: false, error: SPEECH_UNAVAILABLE }
    }

    if (this.turnActive) {
      if (!this.live.bargeIn) {
        this.o.onLog('info', SCOPE, 'ignored an utterance that arrived mid-turn (barge-in is off)')
        return { ok: false, error: 'A reply is already in flight' }
      }
      this.o.onLog('info', SCOPE, 'barge-in: abandoning the reply in flight')
      await this.interrupt()
    }

    const samples = toSamples(pcm)
    const rate = Math.round(sampleRate)
    if (samples === null || !Number.isFinite(rate) || rate <= 0) {
      return { ok: false, error: 'The utterance carried no usable audio' }
    }

    const durationMs = (samples.length / rate) * 1000
    if (durationMs < this.live.minUtteranceMs) {
      // A cough, a chair, a door. Not a turn, and not worth waking whisper for.
      this.o.onLog(
        'info',
        SCOPE,
        `ignored a ${Math.round(durationMs)}ms burst (shorter than minUtteranceMs ${this.live.minUtteranceMs})`
      )
      return { ok: true }
    }

    const level = rmsOf(samples)
    if (level < SILENCE_RMS) {
      this.o.onLog(
        'info',
        SCOPE,
        `ignored ${Math.round(durationMs)}ms of silence (level ${level.toFixed(4)}); whisper would have invented words for it`
      )
      return { ok: true }
    }

    const generation = ++this.generation
    this.turnActive = true

    try {
      return await this.runTurn(generation, samples, rate, frameDataUrl, arrivedAt)
    } catch (err) {
      const message = messageOf(err)
      if (this.isStale(generation)) return { ok: false, error: message }
      this.errorText = message
      this.o.onLog('error', SCOPE, `turn failed: ${message}`)
      this.setState('error')
      return { ok: false, error: message }
    } finally {
      // A stale generation means an interrupt already tidied up and may have
      // started another turn; touching shared state here would clobber it.
      if (!this.isStale(generation)) {
        this.turnActive = false
        this.abort = null
        // stop() and interrupt() both bump the generation, so a live generation
        // means the session is still up; only a turn that failed keeps its state.
        if (this.state !== 'error') this.setState('listening')
      }
    }
  }

  private async runTurn(
    generation: number,
    samples: Int16Array,
    sampleRate: number,
    frameDataUrl: string | undefined,
    arrivedAt: number
  ): Promise<{ ok: boolean; error?: string }> {
    this.errorText = undefined

    /* ---- 1. transcribe ---- */
    this.setState('transcribing')
    const transcript = await this.o.speech.transcribe(encodeWav(samples, sampleRate))
    if (this.isStale(generation)) return { ok: true }

    const sttMs = Date.now() - arrivedAt
    const userText = transcript.trim()
    if (userText.length === 0) {
      // Whisper heard no words. This happens constantly and must not leave an
      // empty exchange behind — just go back to listening, silently.
      return { ok: true }
    }

    /* ---- 2. think ---- */
    this.lastUserText = userText
    this.assistantText = ''
    this.reasoningText = ''
    this.setState('thinking')

    const conversationId = this.conversationId
    const conv = conversationId === null ? null : this.o.conversations.get(conversationId)
    if (conv === null) throw new Error('The conversation this session was started on is gone')

    const model = this.resolveModel(conv)
    if (model === null) {
      throw new Error('No model is available on the server to answer with')
    }

    /* What was heard, in the thread, before the model has said anything. This
       is the first thing that proves the utterance landed. */
    conv.messages.push(chatMessage('user', userText))
    this.draftId = randomUUID()
    this.persist(conv, true)

    const frame = this.frameFor(frameDataUrl, model)
    // Hoisted above the message build: the schemas are part of what the window
    // must hold, so the history's budget cannot be worked out without them.
    const tools = this.o.mcp.wireTools(this.workflow.mcpTools)
    const toolSchemaCost = tools.length === 0 ? 0 : estimateTokens(JSON.stringify(tools))

    const messages = this.composeMessages(conv, model, toolSchemaCost)
    if (frame !== undefined) attachFrame(messages, frame)

    const controller = new AbortController()
    this.abort = controller

    const turn: AudioTurn = {
      turnId: randomUUID(),
      generation,
      queued: 0,
      seq: 0,
      emitted: 0,
      streamFinished: false,
      markedLast: false,
      firstSentenceAt: null,
      firstAudioAt: null,
      chain: Promise.resolve()
    }

    const splitter = new SentenceSplitter()
    let content = ''
    let reasoning = ''
    let finishReason = ''
    let usage = { promptTokens: 0, completionTokens: 0 }
    /** 0 until the first token lands. */
    let firstTokenAt = 0

    const settings = this.o.getSettings()

    /**
     * The spoken turn's own tool loop.
     *
     * The Orchestrator has one already, but its shape is wrong here: it
     * finalises a text message per round and knows nothing about the speech
     * queue, so routing a spoken turn through it would break sentence-wise TTS
     * — the thing that makes the reply start in 300ms instead of at the end.
     * So Live runs its own, smaller loop, with a hard round cap and truncated
     * results, because the cost of a round is paid in silence.
     */
    let streamDoneAt = 0
    let roundRequestAt = Date.now()
    /** Everything said across every round. `content` is cleared per round so a
     *  preamble is not repeated in the next round's message, which means the
     *  final transcript entry would otherwise lose it. */
    let spokenAll = ''

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      firstTokenAt = 0
      finishReason = ''
      /** Accumulated by index, exactly as the OpenAI streaming shape delivers. */
      const pendingCalls = new Map<number, ToolCall>()
      roundRequestAt = Date.now()

      // Per ROUND, not per turn. A tool round is a second full prefill of a
      // conversation that has grown by the tool's output, and showing the
      // first round's numbers through it would hide the part of the wait that
      // is actually the expensive one.
      const meter = this.beginMeter(
        model.id,
        estimateTokens(JSON.stringify(messages)) + toolSchemaCost
      )
      meter.setToolSchemaTokens(toolSchemaCost)
      meter.setReasoningEffort(this.workflow.sampling.reasoningEffort)

      await streamChat(
        {
          // The model's OWN endpoint. Ids collide across servers — the same
          // qwen name exists on LM Studio and on the MLX server — so routing by
          // the default base URL would silently send a turn to the wrong build.
          baseUrl: model.baseUrl || settings.baseUrl,
          apiKey: settings.apiKey,
          model: model.id,
          messages,
          temperature: this.workflow.sampling.temperature,
          topP: this.workflow.sampling.topP,
          topK: this.workflow.sampling.topK,
          maxTokens: this.workflow.sampling.maxTokens,
          // The single biggest lever on perceived latency here. Measured on
          // gemma-4-e4b: without it the first speakable word is ~3.9s away
          // because the model reasons first; with it, ~0.3s.
          reasoningEffort: this.workflow.sampling.reasoningEffort,
          // Withheld on the last permitted round: offering tools the loop will
          // refuse to run invites a call that can only be answered with an
          // apology, and the user hears the silence either way.
          tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
          signal: controller.signal
        },
        {
          onFirstToken: () => {
            firstTokenAt = Date.now()
            meter.markFirstToken()
            this.o.onMetrics(meter.snapshot())
          },
          onContent: (delta) => {
            content += delta
            this.assistantText = content
            meter.countCompletionToken()
            this.pushStatusThrottled()
            this.emitDraft(conv, content, reasoning)
            /* ---- 3. speak each sentence as it completes ---- */
            for (const sentence of splitter.push(delta)) this.enqueueSpeech(turn, sentence)
          },
          // Reasoning is not part of the answer and must never be spoken or
          // recorded as one. It IS shown on screen as it arrives, which is a
          // different thing: during a spoken turn the only signal that anything
          // is happening is silence, and silence reads as a crash. Seeing the
          // thinking is the difference between waiting and wondering.
          onReasoning: (delta) => {
            reasoning += delta
            this.reasoningText = reasoning
            meter.countReasoningToken()
            this.pushStatusThrottled()
            this.emitDraft(conv, content, reasoning)
          },
          onToolCallDelta: (index, id, name, argsDelta) => {
            let call = pendingCalls.get(index)
            if (!call) {
              call = {
                id: id ?? `call_${index}_${Date.now()}`,
                name: name ?? '',
                arguments: '',
                origin: 'mcp',
                status: 'pending'
              }
              pendingCalls.set(index, call)
            }
            if (id) call.id = id
            if (name) call.name = name
            call.arguments += argsDelta
          },
          onUsage: (u) => {
            usage = u
          },
          onDone: (reason) => {
            finishReason = reason
          }
        }
      )
      streamDoneAt = Date.now()
      if (this.isStale(generation)) return { ok: true }

      const calls = [...pendingCalls.values()].filter((c) => c.name.length > 0)
      if (calls.length === 0) break

      // The cap, actually enforced. Withholding the schemas above only asks the
      // model to stop; a model that keeps emitting calls anyway had them run,
      // round after round, with the user hearing nothing and the conversation
      // growing on disk each time. The only way out was End call.
      if (round >= MAX_TOOL_ROUNDS) {
        this.o.onLog(
          'warn',
          SCOPE,
          `ignored ${calls.length} tool call(s) past the round cap: ${calls.map((c) => c.name).join(', ')}`
        )
        break
      }

      /* ---- 3b. run the tools, out loud ---- */
      // Anything the model said before reaching for a tool is a natural "one
      // moment" and covers the wait, so it is spoken now rather than held
      // until the answer arrives.
      const preamble = splitter.flush()
      if (preamble !== null) this.enqueueSpeech(turn, preamble)

      const assistantCall = chatMessage('assistant', content)
      /* Takes over the draft's id: whatever has been streaming into the thread
         IS this message, now committed. The next round gets a fresh draft. */
      assistantCall.id = this.draftId
      assistantCall.toolCalls = calls
      conv.messages.push(assistantCall)
      this.draftId = randomUUID()
      this.persist(conv, true)
      // Committed to a message of its own, so it must not accumulate into the
      // next round — but it still belongs in the turn's record.
      if (content.trim() !== '') spokenAll += (spokenAll === '' ? '' : ' ') + content.trim()
      content = ''
      this.setState('tool')
      this.toolLabel = calls.map((c) => c.name).join(', ')
      this.pushStatus()
      meter.markToolPhase()
      this.o.onMetrics(meter.snapshot())

      for (const call of calls) {
        if (this.isStale(generation)) break
        await this.runTool(conv, call, generation)
      }

      // Staleness FIRST, before any state is written. An MCP call cannot be
      // cancelled (gmail's timeout is 120s and callTool takes no signal), so a
      // turn abandoned mid-call resumes here long after the user moved on —
      // and writing 'thinking' over the 'listening' that interrupt() set left
      // the session deaf, or over the 'off' that stop() set, which reopened
      // the microphone after the user had ended the call.
      if (this.isStale(generation)) return { ok: true }
      this.toolLabel = ''
      this.setState('thinking')

      messages.length = 0
      messages.push(...this.composeMessages(conv, model, toolSchemaCost))
      if (frame !== undefined) attachFrame(messages, frame)
    }

    // Measured from the round that actually spoke, not from the top of the
    // turn: a tool round's wall clock is not prefill, and folding it in here
    // would feed the rate calibrator a rate the server never achieved. The
    // waiting the user really did is in `timings.firstAudioMs` below, which is
    // measured end to end and includes every round.
    const ttftMs = firstTokenAt === 0 ? 0 : firstTokenAt - roundRequestAt

    // The strip goes idle here rather than at the end of the turn: everything
    // after this point is speech, and holding a decode rate on screen while the
    // GPU is done would be a rate nobody is measuring.
    if (this.meter !== null && usage.completionTokens > 0 && ttftMs > 0) {
      this.calibrator.observe(
        model.id,
        usage.promptTokens,
        ttftMs,
        usage.completionTokens,
        Math.max(1, Date.now() - firstTokenAt)
      )
    }
    this.endMeter()
    if (this.isStale(generation)) return { ok: true }

    // If the ENTIRE reply was a tool call typed as prose, every chunk of it was
    // dropped on the way to the speech queue and the turn would end in total
    // silence — a question asked and nothing at all said back, which reads as a
    // crash rather than as a failure. Replaced with something honest, and done
    // here while the audio turn is still open: after closeAudioTurn the last
    // chunk has been marked and anything further is discarded.
    if (content.trim() !== '' && this.isTypedToolCall(content)) {
      content = 'I could not look that up just now, sir. Ask me again and I will try properly.'
      splitter.push(content)
    }

    const tail = splitter.flush()
    if (tail !== null) this.enqueueSpeech(turn, tail)
    turn.streamFinished = true

    /* ---- 4. drain the speech queue ---- */
    await turn.chain
    if (this.isStale(generation)) return { ok: true }
    this.closeAudioTurn(turn)

    /* ---- 5. record the turn ---- */
    const finishedAt = Date.now()
    const timings: LiveTurnTimings = {
      sttMs,
      ttftMs,
      ttsMs:
        turn.firstAudioAt !== null && turn.firstSentenceAt !== null
          ? turn.firstAudioAt - turn.firstSentenceAt
          : 0,
      // Measured end to end, not summed from the stages above.
      firstAudioMs: turn.firstAudioAt === null ? 0 : turn.firstAudioAt - arrivedAt,
      totalMs: finishedAt - arrivedAt
    }

    const spoken = [spokenAll, content.trim()].filter((p) => p !== '').join(' ')
    this.assistantText = spoken
    this.lastTimings = timings
    this.turnCount += 1

    const assistant = chatMessage('assistant', spoken)
    assistant.id = this.draftId
    if (reasoning.length > 0) assistant.reasoning = reasoning
    assistant.metrics = this.metricsFor({
      model,
      usage,
      reasoning,
      ttftMs,
      decodeMs: firstTokenAt === 0 ? 0 : streamDoneAt - firstTokenAt,
      totalMs: timings.totalMs,
      finishReason,
      toolSchemaTokens: toolSchemaCost
    })
    conv.messages.push(assistant)
    this.persist(conv, true)

    const exchange: LiveExchange = {
      id: turn.turnId,
      userText,
      assistantText: spoken,
      frameDataUrl: frame,
      timings,
      at: finishedAt
    }
    this.remember(exchange)
    this.o.onExchange(exchange)

    this.o.onLog(
      'info',
      SCOPE,
      `turn ${this.turnCount}: stt ${timings.sttMs}ms, ttft ${timings.ttftMs}ms, first audio ${timings.firstAudioMs}ms, total ${timings.totalMs}ms`
    )

    return { ok: true }
  }

  /* ---------------------------------------------------------------- */
  /* Speech queue                                                     */
  /* ---------------------------------------------------------------- */

  private enqueueSpeech(turn: AudioTurn, sentence: string): void {
    if (!this.live.speak) return
    const text = speakable(sentence)
    if (text.length === 0) return
    // A tool call the model typed as prose runs nothing and is unlistenable
    // read aloud. Dropped rather than spoken; the turn's own fallback covers
    // the silence, and the text is still logged so the cause is visible.
    if (this.isTypedToolCall(text)) {
      this.o.onLog('warn', SCOPE, `model typed a tool call instead of calling it: ${text}`)
      return
    }

    const index = turn.queued++
    if (turn.firstSentenceAt === null) turn.firstSentenceAt = Date.now()
    turn.chain = turn.chain.then(() => this.speakOne(turn, index, text))
  }

  private async speakOne(turn: AudioTurn, index: number, text: string): Promise<void> {
    if (this.isStale(turn.generation)) return

    let wav: Buffer
    try {
      wav = await this.o.speech.synthesize(text, this.live.voice, this.live.speed)
    } catch (err) {
      // One sentence failing to synthesise is not worth killing a turn over —
      // the text is already on screen and the rest of the reply still speaks.
      this.o.onLog('warn', SCOPE, `could not speak a sentence: ${messageOf(err)}`)
      return
    }
    // Kokoro cannot be cancelled, so the interrupt check that matters is this
    // one: the audio exists, and it must not be played over the next turn.
    if (this.isStale(turn.generation)) return

    const last = turn.streamFinished && index === turn.queued - 1
    if (last) turn.markedLast = true
    if (turn.firstAudioAt === null) {
      turn.firstAudioAt = Date.now()
      this.setState('speaking')
    }
    turn.emitted += 1

    this.o.onAudio({
      turnId: turn.turnId,
      seq: turn.seq++,
      dataUrl: decodeWavToDataUrl(wav, 'audio/wav'),
      text,
      last
    })
  }

  /** Guarantees exactly one chunk per spoken turn carries `last`. See the note
   *  in the file header for when this fires. */
  private closeAudioTurn(turn: AudioTurn): void {
    if (turn.emitted === 0 || turn.markedLast) return
    this.o.onAudio({ turnId: turn.turnId, seq: turn.seq++, dataUrl: '', text: '', last: true })
    turn.markedLast = true
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private cancelTurn(): void {
    // Barge-in and stop both land here. Without this the 4Hz push outlives the
    // request and the HUD keeps counting elapsed time for a turn that was
    // abandoned.
    this.endMeter()
    this.reasoningText = ''
    this.generation += 1
    this.turnActive = false
    // Otherwise an interrupt during a tool call leaves the tool's name in the
    // status that gets pushed, naming work that is no longer happening.
    this.toolLabel = ''
    const controller = this.abort
    this.abort = null
    controller?.abort()
  }

  private isStale(generation: number): boolean {
    return generation !== this.generation
  }

  /** Starts the 4Hz push and returns the meter for the turn. */
  private beginMeter(modelId: string, promptTokens: number): TurnMeter {
    this.endMeter(false)
    const meter = new TurnMeter()
    meter.start(
      modelId,
      promptTokens,
      this.calibrator.prefillTps(modelId),
      this.calibrator.overheadMs(modelId)
    )
    this.meter = meter
    this.metricTimer = setInterval(() => this.o.onMetrics(meter.snapshot()), METRIC_EMIT_MS)
    this.o.onMetrics(meter.snapshot())
    return meter
  }

  /**
   * Stops the push and, unless the turn is continuing into another round,
   * leaves the strip reading idle.
   *
   * The idle emit is not cosmetic: without it the HUD holds the last live
   * numbers after the turn ends, and a rate that is not currently being
   * measured is exactly the lie this app keeps having to design against.
   */
  private endMeter(goIdle = true): void {
    if (this.metricTimer !== null) {
      clearInterval(this.metricTimer)
      this.metricTimer = null
    }
    if (goIdle && this.meter !== null) {
      this.meter.reset()
      this.o.onMetrics(this.meter.snapshot())
    }
    if (goIdle) this.meter = null
  }

  private setState(next: LiveSessionState): void {
    if (this.state === next) return
    this.state = next
    this.pushStatus()
  }

  private pushStatus(): void {
    this.lastStatusAt = Date.now()
    this.o.onStatus(this.status())
  }

  private pushStatusThrottled(): void {
    if (Date.now() - this.lastStatusAt < STATUS_PUSH_MS) return
    this.pushStatus()
  }

  /**
   * Save the conversation AND put it on screen.
   *
   * Mirrors Orchestrator.persist: `structural` marks a change that must not be
   * dropped — a new message, a finished tool call — and bypasses the coalescing
   * that keeps mid-stream updates from flooding the bridge.
   *
   * Every mutation of `conv.messages` in this file goes through here. Calling
   * `conversations.save` on its own is what made spoken turns invisible, so the
   * two are deliberately no longer separable.
   */
  private persist(conv: Conversation, structural: boolean): void {
    conv.updatedAt = Date.now()
    const now = Date.now()
    if (!structural && now - this.lastConvEmitAt < CONV_EMIT_MS) return
    this.lastConvEmitAt = now
    this.o.onConversation(conv, structural)
    if (structural) this.o.conversations.save(conv)
  }

  /**
   * Show the reply as it is being spoken, not after.
   *
   * Adam's requirement for this workflow was that a spoken turn and a typed one
   * look the same, and a typed one streams. The assistant message is not pushed
   * until the turn finishes — it cannot be, since a tool round may still split
   * it — so what goes out here is a DERIVED conversation: the real one plus a
   * draft message. It is emitted and never saved, so nothing partial can reach
   * disk, and no channel exists for the renderer to hand it back.
   *
   * The draft carries the same id the committed message will take, so the
   * bubble is updated rather than replaced when the turn lands.
   */
  private emitDraft(conv: Conversation, content: string, reasoning: string): void {
    if (content === '' && reasoning === '') return
    const now = Date.now()
    if (now - this.lastConvEmitAt < CONV_EMIT_MS) return
    this.lastConvEmitAt = now
    const draft: ChatMessage = {
      id: this.draftId,
      role: 'assistant',
      content,
      createdAt: now
    }
    if (reasoning.length > 0) draft.reasoning = reasoning
    this.o.onConversation({ ...conv, messages: [...conv.messages, draft] }, false)
  }

  private remember(exchange: LiveExchange): void {
    this.exchangeLog.push(exchange)
    if (this.exchangeLog.length > MAX_EXCHANGES) {
      this.exchangeLog.splice(0, this.exchangeLog.length - MAX_EXCHANGES)
    }
    // Frames are large and every read of the log copies them; keep only the
    // newest few, which is all a transcript rail shows anyway.
    for (let i = 0; i < this.exchangeLog.length - MAX_FRAMES_KEPT; i++) {
      delete this.exchangeLog[i].frameDataUrl
    }
  }

  private resolveModel(conv: Conversation): ModelInfo | null {
    const models = this.o.models.list()
    const wanted = conv.modelId ?? this.o.getSettings().defaultModelId
    if (wanted !== null) {
      const pinned = models.find((m) => m.id === wanted)
      if (pinned !== undefined) return pinned
    }
    const residentId = this.o.models.residentModelId()
    if (residentId !== null) {
      const resident = models.find((m) => m.id === residentId)
      if (resident !== undefined) return resident
    }
    // Nothing pinned and nothing resident. With the camera on, a text-only model
    // would silently drop every frame, so prefer one that can actually see.
    if (this.live.video) {
      const vlm = models.find((m) => m.supportsVision)
      if (vlm !== undefined) return vlm
    }
    return models[0] ?? null
  }

  /**
   * A cold load of a 27B is nineteen seconds. Doing it now, while the user is
   * still putting the headset on, is the difference between a first turn that
   * works and one that looks broken.
   */
  private warmModel(): void {
    const conversationId = this.conversationId
    const conv = conversationId === null ? null : this.o.conversations.get(conversationId)
    if (conv === null) return

    const model = this.resolveModel(conv)
    if (model === null) {
      this.o.onLog('warn', SCOPE, 'no models are visible on the server; a turn cannot be answered')
      return
    }
    if (model.state === 'loaded') return

    this.o.onLog('info', SCOPE, `warming ${model.id} — a cold load takes about 20 seconds`)
    void this.o.models
      .load(model.id)
      .then((result) => {
        if (!result.ok) {
          this.o.onLog('warn', SCOPE, `could not warm ${model.id}: ${result.error ?? 'unknown error'}`)
        }
      })
      .catch((err: unknown) => {
        this.o.onLog('warn', SCOPE, `could not warm ${model.id}: ${messageOf(err)}`)
      })
  }

  /** The frame to send with this turn, or undefined with the reason logged. */
  private frameFor(frameDataUrl: string | undefined, model: ModelInfo): string | undefined {
    if (frameDataUrl === undefined || frameDataUrl.length === 0) return undefined
    if (!this.live.video) return undefined

    if (!model.supportsVision) {
      if (!this.warnedNoVision) {
        this.warnedNoVision = true
        this.o.onLog(
          'warn',
          SCOPE,
          `${model.id} has no vision capability, so camera frames are being dropped rather than sent`
        )
      }
      return undefined
    }
    if (!frameDataUrl.startsWith('data:image/')) {
      this.o.onLog('warn', SCOPE, 'dropped a camera frame that was not an image data URL')
      return undefined
    }
    if (frameDataUrl.length > MAX_FRAME_CHARS) {
      this.o.onLog(
        'warn',
        SCOPE,
        `dropped a ${Math.round(frameDataUrl.length / 1024)}KB camera frame; downscale it before sending`
      )
      return undefined
    }
    return frameDataUrl
  }

  /**
   * The turn's message list, trimmed to fit the model's window.
   *
   * A spoken conversation grows faster than it looks: every turn adds the
   * transcript, the reply, and up to MAX_TOOL_RESULT_CHARS of tool output —
   * 4,000 characters of mail on its own. Without this, a long call eventually
   * sends more than the window holds and the turn fails outright, mid-
   * conversation, out loud, with nothing on screen to explain it.
   */
  private composeMessages(conv: Conversation, model: ModelInfo, toolTokens: number): WireMessage[] {
    const window = this.o.models.contextWindow(model.id)
    // No window figure means no trimming: dropping history on a guess about a
    // limit we cannot see is worse than letting the server object.
    const raw =
      window === null || window <= 0
        ? 0
        : window - this.workflow.sampling.maxTokens - toolTokens - Math.ceil(window * 0.05)

    return buildMessages(conv, this.workflow.systemPrompt, model.supportsVision, {
      budget: raw > 0 ? raw : undefined,
      onTrim: (info) =>
        this.o.onLog(
          'warn',
          SCOPE,
          `dropped ${info.messages} earlier message(s) from the call to fit ${model.id}'s window`
        )
    })
  }

  /**
   * Whether a spoken chunk is a tool call the model typed out as prose.
   *
   * Measured on gemma-4-e4b: asked for the weather it sometimes replies with
   * the literal text `get_weather{}` instead of calling anything. Nothing runs,
   * and the sentence goes to the speech queue, so the user hears their
   * assistant read a function signature aloud — name, underscores and brackets.
   * Prompt wording did not reliably stop it and no wording can be relied on to,
   * so it is caught here where the consequence actually happens.
   *
   * Kept deliberately narrow: the whole chunk must be one call-shaped token and
   * nothing else. A sentence that merely mentions a tool by name is left alone.
   */
  private isTypedToolCall(text: string): boolean {
    // No whitespace allowed before the bracket, and the brackets may nest.
    // Both matter: `search_emails({"query": "is:unread"})` has nested braces
    // and would otherwise slip through, while allowing a space would silence
    // ordinary speech like "Right (as you say), sir."
    return /^[a-z][a-z0-9_]*(__[a-z][a-z0-9_]*)?[({[][\s\S]*[)}\]]$/i.test(text.trim())
  }

  /**
   * Whether a tool name is one this workflow is allowed to call.
   *
   * Mirrors the filter in `McpManager.wireTools`, deliberately: exposure and
   * execution are separate decisions, and only one of them is the safety
   * boundary.
   */
  private toolPermitted(name: string): boolean {
    const allow = this.workflow.mcpTools
    if (!allow) return true
    return this.o.mcp.wireTools(allow).some((t) => t.function.name === name)
  }

  /**
   * Runs one MCP tool for a spoken turn and appends its result.
   *
   * Deliberately unlike the Orchestrator's version: no approval gate, and the
   * output is clipped hard. Live only ever offers read-only servers (weather,
   * news, mail), so there is nothing here worth stopping to ask about — and a
   * spoken turn cannot show a dialog anyway.
   *
   * Artifacts ARE recorded, which they were not. The comment here used to say
   * they were skipped, and that was right for Live: nothing it could reach
   * wrote a file. Converse broke the premise — it carries docgen, comfy-image
   * and comfy-audio — so asking out loud for a PDF produced the PDF, said so,
   * and recorded nothing, leaving the file on disk and absent from every panel
   * that lists what was made.
   * A failure is appended as text rather than thrown, so the model can say
   * what went wrong in its own voice instead of the turn dying silently.
   */
  private async runTool(conv: Conversation, call: ToolCall, generation: number): Promise<void> {
    const startedAt = Date.now()
    let text: string
    try {
      // Withholding a schema stops an honest model, not a confused one: the
      // routing map still resolves every tool on every running server, so a
      // hallucinated `send_email` would otherwise go through. The allowlist is
      // re-checked here, where the call actually happens.
      if (!this.toolPermitted(call.name)) {
        throw new Error(
          `"${call.name}" is not available in a spoken conversation. Tell the user what you cannot do here.`
        )
      }
      let args: unknown = {}
      if (call.arguments.trim().length > 0) args = dropEmptyArgs(JSON.parse(call.arguments))
      const result = await this.o.mcp.callTool(call.name, args)
      text = result.text
      // The panel's whole supply. Without this line a spoken workflow could
      // never draw anything: the Orchestrator records it for typed turns, this
      // path did not, and the Flights panel — built for a SPOKEN workflow —
      // sat on its empty state no matter how many searches came back. Note it
      // does not enter the model's context and so costs no prefill; only
      // `text` does, and that is what MAX_TOOL_RESULT_CHARS clips.
      call.structured = result.structured
      call.artifacts = result.artifacts
      for (const artifact of result.artifacts) {
        this.o.onArtifact(this.workflow.id, artifact)
      }
      call.status = result.isError ? 'error' : 'ok'
      if (result.isError) call.error = result.text
    } catch (err) {
      text = `The tool failed: ${messageOf(err)}`
      call.status = 'error'
      call.error = messageOf(err)
    }

    if (text.length > MAX_TOOL_RESULT_CHARS) {
      // Said plainly, because a model handed a silently truncated list will
      // confidently tell the user it is the whole list.
      const dropped = text.length - MAX_TOOL_RESULT_CHARS
      text =
        text.slice(0, MAX_TOOL_RESULT_CHARS) +
        `\n\n[truncated — ${dropped} more characters. Summarise what is here and say there is more.]`
    }
    call.result = text
    call.finishedAt = Date.now()

    // An MCP call cannot be cancelled, so this can return long after the turn
    // was abandoned — and by then the user may have spoken again, meaning a new
    // user message is already on the conversation. Appending here would put the
    // tool result AFTER it, and buildMessages faithfully reproduces that order:
    // every later request in this conversation would carry a user message
    // between an assistant tool_calls message and its reply, which the chat
    // template rejects. conversations.save would then make it permanent.
    if (this.isStale(generation)) {
      this.o.onLog(
        'info',
        SCOPE,
        `discarded a late ${call.name} result (${text.length} chars) — its turn was abandoned`
      )
      return
    }

    conv.messages.push({
      id: randomUUID(),
      role: 'tool',
      toolCallId: call.id,
      content: text.length > 0 ? text : '(no output)',
      createdAt: Date.now()
    })
    this.persist(conv, true)
    this.o.onLog(
      call.status === 'error' ? 'warn' : 'info',
      SCOPE,
      `tool ${call.name} ${call.status} in ${Date.now() - startedAt}ms (${text.length} chars)`
    )
  }

  private metricsFor(args: {
    model: ModelInfo
    usage: { promptTokens: number; completionTokens: number }
    reasoning: string
    ttftMs: number
    decodeMs: number
    totalMs: number
    finishReason: string
    toolSchemaTokens: number
  }): TurnMetrics {
    const metrics: TurnMetrics = {
      modelId: args.model.id,
      promptTokens: args.usage.promptTokens,
      completionTokens: args.usage.completionTokens,
      ttftMs: args.ttftMs,
      totalMs: args.totalMs,
      prefillTps: rate(args.usage.promptTokens, args.ttftMs),
      decodeTps: rate(args.usage.completionTokens, args.decodeMs),
      toolSchemaTokens: args.toolSchemaTokens,
      source: 'client',
      finishReason: args.finishReason
    }
    if (args.reasoning.length > 0) metrics.reasoningTokens = estimateTokens(args.reasoning)
    return metrics
  }
}

/* ------------------------------------------------------------------ */
/* Sentence splitting                                                 */
/* ------------------------------------------------------------------ */

/** Abbreviations whose full stop is not the end of a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx',
  'fig', 'no', 'inc', 'ltd', 'co', 'dept', 'est', 'al', 'ca', 'cf',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun'
])

const TERMINATORS = '.!?'
/** Quotes and brackets belong to the sentence they close. */
const CLOSERS = '"\'`)]}»”’'

/**
 * Streaming sentence splitter.
 *
 * `push` returns whatever is ready to speak; anything incomplete is held until
 * more text arrives or `flush` closes the turn. The held fragment is the point:
 * a terminator at the very end of the buffer is ambiguous — "the value is 1."
 * may still become "1.5" — so a boundary is only accepted once the next
 * character has been seen.
 */
class SentenceSplitter {
  private buffer = ''
  /** Completed sentences too short to send on their own. */
  private pending = ''
  private emittedAny = false

  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []

    for (;;) {
      let end = boundaryOf(this.buffer)
      if (end < 0) {
        if (this.buffer.length <= MAX_CHUNK_CHARS) break
        end = this.buffer.lastIndexOf(' ', MAX_CHUNK_CHARS)
        if (end <= 0) end = MAX_CHUNK_CHARS
      }

      const sentence = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end)
      if (sentence.length === 0) continue

      this.pending = this.pending.length > 0 ? `${this.pending} ${sentence}` : sentence
      if (!this.emittedAny || this.pending.length >= MIN_CHUNK_CHARS) {
        out.push(this.pending)
        this.pending = ''
        this.emittedAny = true
      }
    }

    return out
  }

  /** Everything still held, or null when there is nothing left to say. */
  flush(): string | null {
    const rest = `${this.pending} ${this.buffer}`.replace(/\s+/g, ' ').trim()
    this.pending = ''
    this.buffer = ''
    if (rest.length === 0) return null
    this.emittedAny = true
    return rest
  }
}

/** Index one past the end of the first complete sentence in `buf`, or -1. */
function boundaryOf(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    if (ch === '\n') return i + 1
    if (!TERMINATORS.includes(ch)) continue

    // "?!", "!!", "..." are one terminator, not several.
    let end = i + 1
    while (end < buf.length && TERMINATORS.includes(buf[end])) end++
    const run = buf.slice(i, end)

    // An ellipsis is a pause inside a thought, not the end of one.
    if (/^\.{2,}$/.test(run)) {
      i = end - 1
      continue
    }
    if (run === '.' && !isFullStop(buf, i)) {
      i = end - 1
      continue
    }

    let after = end
    while (after < buf.length && CLOSERS.includes(buf[after])) after++

    // Nothing after it yet: wait for the next character rather than guess.
    if (after >= buf.length) return -1
    if (!/\s/.test(buf[after])) {
      i = after - 1
      continue
    }
    return after
  }
  return -1
}

/** False when the period belongs to a number or an abbreviation. */
function isFullStop(buf: string, dot: number): boolean {
  const previous = dot > 0 ? buf[dot - 1] : ''
  const next = dot + 1 < buf.length ? buf[dot + 1] : ''
  // 1.5 — the decimal point, the one that most often ruins a spoken number.
  if (/[0-9]/.test(previous) && /[0-9]/.test(next)) return false

  let start = dot
  while (start > 0 && /[A-Za-z]/.test(buf[start - 1])) start--
  const word = buf.slice(start, dot)

  if (word.length === 0) return true
  // A lone letter is an initial or part of e.g. / i.e. / U.S., never a full stop.
  if (word.length === 1) return false
  return !ABBREVIATIONS.has(word.toLowerCase())
}

/**
 * What Kokoro should actually say. The Live prompt forbids markdown, but models
 * emit it anyway, and a read-aloud asterisk is worse than a missing one. Only
 * the spoken text and its caption are cleaned — the recorded reply keeps
 * whatever the model wrote.
 */
function speakable(text: string): string {
  return text
    .replace(/`+/g, ' ')
    .replace(/\*+/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-–—•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * Hangs the frame off the newest user message — the one just spoken.
 *
 * The frame rides on the wire message rather than being stored as an attachment
 * on the conversation, for two reasons: a frame per turn would multiply the size
 * of the conversation file on disk by a hundred, and a frame from four turns ago
 * is actively misleading to a model that has been told it is seeing the room in
 * real time.
 */
function attachFrame(messages: WireMessage[], frameDataUrl: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const parts: ContentPart[] =
      typeof msg.content === 'string'
        ? msg.content.length > 0
          ? [{ type: 'text', text: msg.content }]
          : []
        : [...msg.content]
    parts.push({ type: 'image_url', image_url: { url: frameDataUrl } })
    messages[i] = { ...msg, content: parts }
    return
  }
}

function chatMessage(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: randomUUID(), role, content, createdAt: Date.now() }
}

/**
 * Removes empty-string arguments before a call.
 *
 * Models are very bad at leaving an optional parameter out. Asked for the
 * weather with no city named, this one tried `"Austin, Texas"` (a confident
 * forecast for the wrong side of the country), then the literal placeholder
 * `"current_location"`, and only then `""`. An empty string is never a
 * meaningful value for an optional parameter, and a server that treats it as
 * one rather than as absent will fail or, worse, answer about nothing. Dropping
 * the key is what the model meant.
 *
 * Only the top level, and only empty strings: a nested object may legitimately
 * carry one, and `0`, `false` and `null` all mean something.
 */
function dropEmptyArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length === 0) continue
    out[key] = value
  }
  return out
}

/** The renderer sends 16-bit PCM; an odd byte count means a truncated frame. */
function toSamples(pcm: ArrayBuffer): Int16Array | null {
  if (!(pcm instanceof ArrayBuffer) || pcm.byteLength < 2) return null
  const usable = pcm.byteLength - (pcm.byteLength % 2)
  return new Int16Array(pcm, 0, usable / 2)
}

/** Loudness of the whole utterance, 0..1 on the same scale as `vadThreshold`. */
function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

function rate(tokens: number, ms: number): number {
  if (tokens <= 0 || ms <= 0) return 0
  return Math.round((tokens / (ms / 1000)) * 10) / 10
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause
    if (cause instanceof Error && cause.message !== err.message) {
      return `${err.message} (${cause.message})`
    }
    return err.message
  }
  return String(err)
}
