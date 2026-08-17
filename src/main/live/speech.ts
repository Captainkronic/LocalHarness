/**
 * Local speech, both directions, wrapped around voice-mcp.
 *
 * The model on the Mac Studio cannot hear. LM Studio rejects audio content parts
 * outright ("must be either 'text' or 'image_url'"), so a spoken turn is only
 * possible if the speech never reaches it as audio: whisper turns the microphone
 * into text HERE, on this Mac, and Kokoro turns the reply back into audio HERE.
 * The Studio only ever sees text (and, when the model is a VLM, camera frames as
 * image parts — those it does accept).
 *
 * voice-mcp is file-based in both directions and there is no streaming interface:
 * `transcribe` takes a path, `speak` writes a file and reports where. So this
 * module writes short-lived wavs into the OS temp directory, hands over the path,
 * reads the answer back and deletes both. `VOICE_FORMAT=wav` because a wav
 * decodes faster in the renderer than an mp3 and these files live for one
 * sentence.
 *
 * Two properties of the server shape the callers:
 *  - It serialises tool calls behind one model lock. A `speak` in flight delays a
 *    `transcribe` behind it, which is what a barge-in does — the wait is the
 *    remainder of one sentence's synthesis, a few hundred ms.
 *  - A failed tool call comes back as `isError: true` with the reason in the
 *    text, not as a JSON-RPC error. Both are checked.
 *
 * Nothing here throws on a server that will not start. `available()` goes false,
 * the reason goes through onLog, and the Live workflow degrades to text.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import { MCP_BY_ID } from '@shared/mcp-registry'
import type { McpToolInfo } from '@shared/types'

import { McpClient, type McpCallResult } from '../mcp/client'
import type { LogFn } from '../mcp/manager'

const SERVER_ID = 'voice'
const SCOPE = 'live:speech'

/**
 * Tighter than the registry's 300s. In a conversation a synthesis that has not
 * come back in a minute and a half is never going to be useful — but the first
 * call of a session also pays for loading Kokoro or whisper-large-v3-turbo, so
 * this cannot be as tight as the per-turn budget suggests.
 */
const CALL_TIMEOUT_MS = 90_000

/** A server that failed to start is not retried until this has passed, so a
 *  broken venv cannot turn every utterance into a spawn attempt. */
const RETRY_COOLDOWN_MS = 30_000

/** Temp files are deleted after use; anything older than this is debris from a
 *  crash and is swept on the next start. */
const STALE_FILE_MS = 60 * 60 * 1000

const TEMP_DIR_NAME = 'localharness-live'
const UTTERANCE_PREFIX = 'utterance-'
const SPEECH_PREFIX = 'speech-'

const REQUIRED_TOOLS = ['speak', 'transcribe'] as const

/**
 * Kokoro's catalogue, mirroring voice-mcp's own `VOICES` list.
 *
 * The server exposes no listing tool — the names live in a constant and in the
 * `speak` description — so this is a copy, and copies drift. The failure mode is
 * mild by design: voice-mcp resolves an unrecognised name to its default rather
 * than erroring, so drift costs the wrong voice, never a broken turn.
 */
const KOKORO_VOICES: readonly string[] = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'em_santa', 'ff_siwis',
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola',
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  'pf_dora', 'pm_alex', 'pm_santa',
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'
]

/** Fallback location, used only if the shared registry ever loses the entry. */
const FALLBACK_COMMAND = '~/.config/voice-mcp/venv/bin/python'
const FALLBACK_ARGS = ['~/.config/voice-mcp/server.py']

export interface SpeechServicesOptions {
  onLog: LogFn
}

export class SpeechServices {
  private readonly onLog: LogFn
  private client: McpClient | null = null
  /** Shared by concurrent start() callers so one spawn serves them all. */
  private starting: Promise<void> | null = null
  private ready = false
  private lastFailure: { at: number; reason: string } | null = null
  private tempDir: string | null = null
  /** Cached at handshake; the catalogue does not change at runtime. */
  private voiceList: string[] = []

  constructor(opts: SpeechServicesOptions) {
    this.onLog = opts.onLog
  }

  available(): boolean {
    return this.ready
  }

  /** Spawns voice-mcp. Idempotent, concurrency-safe, and never rejects. */
  async start(): Promise<void> {
    if (this.ready) return
    if (this.starting !== null) return this.starting

    const failure = this.lastFailure
    if (failure !== null && Date.now() - failure.at < RETRY_COOLDOWN_MS) return

    const run = this.spawn().finally(() => {
      this.starting = null
    })
    this.starting = run
    return run
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.ready = false
    this.voiceList = []
    if (client === null) return
    await client.stop().catch((err: unknown) => {
      this.onLog('warn', SCOPE, `voice-mcp did not stop cleanly: ${messageOf(err)}`)
    })
  }

  /**
   * Kokoro voices, most-preferred first — the server's own default voice leads,
   * so a caller falling back to the first entry gets what voice-mcp would have
   * chosen anyway. Empty when the server is unavailable.
   */
  async voices(): Promise<string[]> {
    await this.start()
    return this.voiceList.slice()
  }

  /**
   * Mono 16-bit wav in, transcript out. An empty string means whisper found no
   * speech — which is a normal outcome for a door closing, not an error.
   */
  async transcribe(wav: Buffer): Promise<string> {
    const client = await this.require()
    const dir = await this.ensureTempDir()
    const audio = join(dir, `${UTTERANCE_PREFIX}${randomUUID()}.wav`)
    // whisper writes the full transcript beside the audio; this is where.
    const sidecar = `${audio.slice(0, -'.wav'.length)}.txt`

    await writeFile(audio, wav)
    try {
      const result = await client.callTool('transcribe', { path: audio })
      return parseTranscript(this.textOf(result, 'transcribe'))
    } finally {
      await this.discard(audio)
      await this.discard(sidecar)
    }
  }

  /** One sentence in, wav bytes out. The file voice-mcp wrote is deleted here. */
  async synthesize(text: string, voice: string, speed: number): Promise<Buffer> {
    const client = await this.require()
    const dir = await this.ensureTempDir()
    // A uuid stem keeps the server from having to de-duplicate names, and keeps
    // the sweep able to recognise its own debris.
    const stem = `${SPEECH_PREFIX}${randomUUID()}`

    const result = await client.callTool('speak', {
      text,
      voice,
      speed,
      format: 'wav',
      filename: stem,
      output_dir: dir
    })

    const path = parseCreatedPath(this.textOf(result, 'speak'))
    if (path === null) {
      throw new Error('voice-mcp did not report where it wrote the audio')
    }
    try {
      const bytes = await readFile(path)
      if (bytes.length === 0) throw new Error(`voice-mcp wrote an empty file at ${path}`)
      return bytes
    } finally {
      await this.discard(path)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Load Kokoro and Whisper before the first turn needs them.
   *
   * Measured on this Mac: the first synthesize costs 4,378ms against 394ms warm
   * (11x), and the first transcribe 3,116ms against 1,322ms (2.4x). Paying both
   * lazily puts ~7.5 seconds into the user's very first sentence, which reads as
   * the feature being broken. Doing it while they are still deciding what to say
   * costs nothing they notice.
   *
   * Never throws: a failed warm-up is a slower first turn, not a broken session.
   */
  async prewarm(voice: string): Promise<void> {
    if (!this.available()) return
    try {
      const audio = await this.synthesize('Ready.', voice, 1)
      // Transcribing what we just synthesised warms Whisper without needing a
      // fixture on disk, and proves the pair round-trips before the user speaks.
      await this.transcribe(audio)
      this.onLog('info', SCOPE, 'speech models warmed')
    } catch (err) {
      this.onLog('warn', SCOPE, `speech warm-up skipped: ${messageOf(err)}`)
    }
  }

  private async spawn(): Promise<void> {
    const spec = MCP_BY_ID[SERVER_ID]
    let dir: string
    try {
      dir = await this.ensureTempDir()
    } catch (err) {
      this.fail(`no writable temp directory: ${messageOf(err)}`)
      return
    }
    await this.sweep(dir)

    const client = new McpClient({
      id: SERVER_ID,
      command: spec?.command ?? FALLBACK_COMMAND,
      args: spec?.args ?? [...FALLBACK_ARGS],
      env: {
        ...(spec?.env ?? {}),
        // Only a fallback — every call passes output_dir explicitly — but it
        // keeps a stray file out of the user's audio folder.
        VOICE_OUTPUT_DIR: dir,
        VOICE_FORMAT: 'wav'
      },
      callTimeoutMs: CALL_TIMEOUT_MS,
      onLog: (level, msg) => this.onLog(level, SCOPE, msg)
    })

    try {
      const tools = await client.start()
      const names = new Set(tools.map((t) => t.name))
      const missing = REQUIRED_TOOLS.filter((name) => !names.has(name))
      if (missing.length > 0) {
        await client.stop().catch(() => undefined)
        this.fail(`voice-mcp is missing ${missing.join(' and ')}`)
        return
      }

      this.client = client
      this.ready = true
      this.lastFailure = null
      this.voiceList = orderVoices(defaultVoiceOf(tools))
      this.onLog('info', SCOPE, `speech ready — ${this.voiceList.length} voices, temp dir ${dir}`)
    } catch (err) {
      this.fail(messageOf(err))
    }
  }

  private fail(reason: string): void {
    this.client = null
    this.ready = false
    this.voiceList = []
    this.lastFailure = { at: Date.now(), reason }
    this.onLog(
      'warn',
      SCOPE,
      `voice-mcp is unavailable (${reason}) — the Live workflow will not hear or speak; everything else still works`
    )
  }

  private async require(): Promise<McpClient> {
    await this.start()
    const client = this.client
    if (client === null || !this.ready) {
      throw new Error(this.lastFailure?.reason ?? 'voice-mcp is not running')
    }
    return client
  }

  /** Text of a successful call, or a throw carrying the server's own words. */
  private textOf(result: McpCallResult, tool: string): string {
    if (result.isError) {
      throw new Error(`voice-mcp ${tool} failed: ${firstLine(result.text) || 'no detail given'}`)
    }
    return result.text
  }

  /* ---------------------------------------------------------------- */
  /* Temp files                                                       */
  /* ---------------------------------------------------------------- */

  private async ensureTempDir(): Promise<string> {
    if (this.tempDir !== null) return this.tempDir
    const dir = join(app.getPath('temp'), TEMP_DIR_NAME)
    await mkdir(dir, { recursive: true })
    this.tempDir = dir
    return dir
  }

  private async discard(path: string): Promise<void> {
    await unlink(path).catch(() => undefined)
  }

  /** Clears debris a crash left behind. Only files this module names, only old
   *  ones — the directory is shared with whatever else the OS puts in temp. */
  private async sweep(dir: string): Promise<void> {
    const entries = await readdir(dir).catch(() => [] as string[])
    const cutoff = Date.now() - STALE_FILE_MS
    for (const entry of entries) {
      if (!entry.startsWith(UTTERANCE_PREFIX) && !entry.startsWith(SPEECH_PREFIX)) continue
      const path = join(dir, entry)
      const info = await stat(path).catch(() => null)
      if (info === null || info.mtimeMs > cutoff) continue
      await this.discard(path)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Result parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * `speak` answers with "Created <path>\n<details>". The path is taken from the
 * first line rather than by scanning, so a details line that happens to mention
 * another file cannot win.
 */
function parseCreatedPath(text: string): string | null {
  const match = /^Created\s+(\/.+?)\s*$/m.exec(text)
  return match === null ? null : match[1]
}

/**
 * `transcribe` answers with a header block, a blank line, then the words:
 *
 *   Transcribed utterance-x.wav, 0:03 in 0:01 (3.0x realtime) — 7 words, ...
 *   Full transcript: /var/folders/.../utterance-x.txt
 *
 *   what the user actually said
 *
 * No blank line means no speech was found ("No speech was found in ..."), which
 * is an empty transcript, not a failure.
 */
function parseTranscript(text: string): string {
  const split = text.indexOf('\n\n')
  if (split === -1) return ''
  return text.slice(split + 2).trim()
}

/** The `voice` parameter's declared default, i.e. what the server uses when
 *  asked for a name it does not know. */
function defaultVoiceOf(tools: McpToolInfo[]): string | null {
  const voice = tools.find((t) => t.name === 'speak')?.inputSchema.properties?.voice
  const fallback = voice?.default
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null
}

function orderVoices(preferred: string | null): string[] {
  const all = [...KOKORO_VOICES]
  if (preferred === null) return all
  return [preferred, ...all.filter((v) => v !== preferred)]
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0].trim()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
