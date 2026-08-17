/**
 * MCP client over stdio, implemented directly — newline-delimited JSON-RPC 2.0
 * on the child's stdin/stdout, no SDK.
 *
 * Two behaviours here are load-bearing and easy to get wrong:
 *
 *  - stdout arrives in arbitrary chunks. One 'data' event can carry half a
 *    message, or five whole ones. Everything is buffered until a newline.
 *  - stderr is *normal*. Most of these Python servers print startup banners,
 *    deprecation warnings and progress there. It goes to the log at info and is
 *    never a failure signal; only a non-zero exit before the handshake finishes
 *    (or a spawn error, or a handshake timeout) fails start().
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname } from 'node:path'
import type { Artifact, ArtifactKind, JsonSchema, McpToolInfo } from '@shared/types'
import { augmentedPath, expandEnv, expandTilde } from '../store/paths'
import { sanitizeSchema, toolSchemaTokens } from './tokens'

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_NAME = 'LocalHarness'
const CLIENT_VERSION = '0.1.0'

/** initialize and tools/list each get this long; the whole handshake is timed. */
const HANDSHAKE_TIMEOUT_MS = 30_000
/** How long SIGTERM gets before SIGKILL. */
const TERM_GRACE_MS = 3_000
/** Safety valve on the line buffer — big enough for a multi-megabyte base64 image. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
/** tools/list pages to follow before we assume the server is looping. */
const MAX_TOOL_PAGES = 50
/** stderr lines retained to enrich a start failure message. */
const STDERR_TAIL_LINES = 20

export interface McpClientOptions {
  id: string
  command: string
  args: string[]
  env: Record<string, string>
  callTimeoutMs: number
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface McpCallResult {
  text: string
  artifacts: Artifact[]
  isError: boolean
}

type McpChild = ChildProcessWithoutNullStreams

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class McpClient {
  readonly id: string

  private readonly opts: McpClientOptions
  private child: McpChild | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stderrBuffer = ''
  /**
   * Streaming decoders, NOT `chunk.toString('utf8')`.
   *
   * Lines are already buffered across chunks, but the bytes were being decoded
   * per chunk — so a multi-byte character split across a pipe boundary became
   * U+FFFD before it ever reached the line buffer. The JSON still parses (a
   * replacement char is a legal string char), so results were silently mangled
   * rather than failing loudly. These servers routinely emit em dashes, ✓ and
   * accented filenames.
   */
  private stdoutDecoder = new TextDecoder()
  private stderrDecoder = new TextDecoder()
  private readonly stderrTail: string[] = []
  private handshakeDone = false
  private handshakeDuration: number | undefined
  private stopping = false
  /** Set while start() is in flight so a spawn error / early exit can fail it. */
  private failStartup: ((err: Error) => void) | undefined

  constructor(opts: McpClientOptions) {
    this.opts = opts
    this.id = opts.id
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get handshakeMs(): number | undefined {
    return this.handshakeDuration
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async start(): Promise<McpToolInfo[]> {
    if (this.child) throw new Error(`MCP server "${this.id}" is already running`)

    const startedAt = Date.now()
    const command = expandTilde(this.opts.command)
    const args = this.opts.args.map((a) => expandTilde(a))
    const env = expandEnv(this.opts.env)

    this.stopping = false
    this.handshakeDone = false
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    // Fresh decoders: a restart must not inherit a half-character from the
    // previous process's last chunk.
    this.stdoutDecoder = new TextDecoder()
    this.stderrDecoder = new TextDecoder()
    this.stderrTail.length = 0

    let child: McpChild
    try {
      child = spawn(command, args, {
        cwd: homedir(),
        // PATH is repaired for every server, not just the one that needed it:
        // these are Python processes that shell out (ffmpeg, rg, sips, git), and
        // a Finder-launched app hands them launchd's minimal PATH. An explicit
        // PATH in a server's own env still wins, since `env` is spread last.
        env: { ...process.env, PATH: augmentedPath(), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      })
    } catch (err) {
      throw new Error(`MCP server "${this.id}" could not be spawned: ${errText(err)}`)
    }
    this.child = child

    // A spawn error or an early exit has to be able to reject start(), which is
    // otherwise just sitting on the initialize response.
    const startupFailure = new Promise<never>((_, reject) => {
      this.failStartup = reject
    })

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    // Without this an EPIPE on a dead child becomes an unhandled 'error' event
    // and takes the whole main process down.
    child.stdin.on('error', (err: Error) => {
      this.log('warn', `stdin error: ${err.message}`)
    })
    child.on('error', (err: Error) => {
      this.log('error', `process error: ${err.message}`)
      if (!this.handshakeDone) {
        this.failStartup?.(new Error(`MCP server "${this.id}" failed to start: ${err.message}`))
      }
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))

    this.log('info', `spawned ${command} ${args.join(' ')} (pid ${child.pid ?? '?'})`)

    try {
      const tools = await Promise.race([this.handshake(), startupFailure])
      this.handshakeDone = true
      this.handshakeDuration = Date.now() - startedAt
      this.failStartup = undefined
      this.log('info', `ready in ${this.handshakeDuration}ms with ${tools.length} tools`)
      return tools
    } catch (err) {
      this.failStartup = undefined
      // Never leave a half-initialised child behind.
      await this.stop().catch(() => undefined)
      throw err instanceof Error ? err : new Error(errText(err))
    }
  }

  private async handshake(): Promise<McpToolInfo[]> {
    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
      },
      HANDSHAKE_TIMEOUT_MS,
      `MCP server "${this.id}" did not complete initialize within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
      true
    )

    this.notify('notifications/initialized')

    return this.listTools()
  }

  private async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    let page = 0

    do {
      const raw = await this.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        HANDSHAKE_TIMEOUT_MS,
        `MCP server "${this.id}" did not answer tools/list within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
        true
      )
      const result = asRecord(raw)
      const list: unknown[] = result && Array.isArray(result.tools) ? result.tools : []
      for (const entry of list) {
        const info = this.toToolInfo(entry)
        if (info) tools.push(info)
      }

      const next = result && typeof result.nextCursor === 'string' ? result.nextCursor : undefined
      // A server that hands back the same cursor forever would spin here.
      cursor = next && next !== cursor ? next : undefined
      page += 1
    } while (cursor !== undefined && page < MAX_TOOL_PAGES)

    return tools
  }

  private toToolInfo(entry: unknown): McpToolInfo | null {
    const tool = asRecord(entry)
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) return null

    const rawSchema = asRecord(tool.inputSchema) ?? asRecord(tool.input_schema)
    const inputSchema: JsonSchema = rawSchema
      ? (rawSchema as JsonSchema)
      : { type: 'object', properties: {} }
    const description = typeof tool.description === 'string' ? tool.description : ''

    return {
      qualifiedName: `${this.id}__${tool.name}`,
      serverId: this.id,
      name: tool.name,
      description,
      inputSchema,
      // Count what actually goes on the wire: the sanitised schema, not the raw one.
      tokens: toolSchemaTokens(tool.name, description, sanitizeSchema(inputSchema)),
      enabled: true
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    if (!child) {
      this.rejectAllPending(`MCP server "${this.id}" stopped`)
      return
    }

    this.rejectAllPending(`MCP server "${this.id}" stopped`)

    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      let killTimer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (killTimer) clearTimeout(killTimer)
        resolve()
      }

      child.once('exit', finish)

      killTimer = setTimeout(() => {
        this.log('warn', 'did not exit on SIGTERM, sending SIGKILL')
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        // Resolve either way — a process we cannot reap must not wedge shutdown.
        setTimeout(finish, 250)
      }, TERM_GRACE_MS)

      try {
        child.kill('SIGTERM')
      } catch (err) {
        this.log('warn', `SIGTERM failed: ${errText(err)}`)
        finish()
      }
    })

    this.child = undefined
  }

  /* ---------------------------------------------------------------- */
  /* Tool calls                                                       */
  /* ---------------------------------------------------------------- */

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const seconds = Math.round(this.opts.callTimeoutMs / 1000)
    const raw = await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      this.opts.callTimeoutMs,
      `MCP server "${this.id}" did not respond to ${name} within ${seconds}s`,
      false
    )
    return parseCallResult(raw, name)
  }

  /* ---------------------------------------------------------------- */
  /* JSON-RPC plumbing                                                */
  /* ---------------------------------------------------------------- */

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutMessage: string,
    killOnTimeout: boolean
  ): Promise<unknown> {
    const child = this.child
    if (!child) {
      return Promise.reject(new Error(`MCP server "${this.id}" is not running`))
    }

    const id = this.nextId++

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the entry first: a late reply must not resolve a promise whose
        // caller has already been told the call timed out.
        this.pending.delete(id)
        if (killOnTimeout) {
          this.log('error', `${method} timed out after ${timeoutMs}ms, killing child`)
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
        reject(new Error(timeoutMessage))
      }, timeoutMs)
      // A pending MCP call must never hold the app open.
      timer.unref?.()

      this.pending.set(id, { method, resolve, reject, timer })

      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`MCP server "${this.id}" write failed: ${errText(err)}`))
      }
    })
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child) return
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (err) {
      this.log('warn', `notification ${method} failed: ${errText(err)}`)
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.decode(chunk, { stream: true })

    if (this.stdoutBuffer.length > MAX_BUFFER_BYTES) {
      this.log('error', 'stdout buffer overflowed without a newline, discarding')
      this.stdoutBuffer = ''
      return
    }

    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.trim().length > 0) this.handleLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Servers that print to stdout instead of stderr land here. Log, continue.
      this.log('warn', `non-JSON stdout: ${truncate(line, 300)}`)
      return
    }

    const message = asRecord(parsed)
    if (!message) {
      this.log('warn', `unexpected stdout payload: ${truncate(line, 300)}`)
      return
    }

    const hasId = typeof message.id === 'number' || typeof message.id === 'string'

    if (hasId && typeof message.method === 'string') {
      // Server -> client request (sampling, roots, elicitation). We advertise no
      // capabilities, so decline rather than leaving the server waiting.
      this.respondUnsupported(message.id, message.method)
      return
    }

    if (typeof message.method === 'string') {
      this.log('info', `notification ${message.method}`)
      return
    }

    if (!hasId) {
      this.log('warn', `response without id: ${truncate(line, 200)}`)
      return
    }

    const numericId = typeof message.id === 'number' ? message.id : Number(message.id)
    const entry = this.pending.get(numericId)
    if (!entry) {
      // Late reply to something we already timed out on, or a duplicate.
      this.log('info', `ignoring reply to unknown request id ${String(message.id)}`)
      return
    }

    this.pending.delete(numericId)
    clearTimeout(entry.timer)

    const rpcError = asRecord(message.error)
    if (rpcError) {
      const reason =
        typeof rpcError.message === 'string' ? rpcError.message : 'unknown JSON-RPC error'
      const detail = rpcError.data === undefined ? '' : ` (${truncate(safeJson(rpcError.data), 200)})`
      entry.reject(new Error(`MCP server "${this.id}" ${entry.method} failed: ${reason}${detail}`))
      return
    }

    entry.resolve(message.result)
  }

  private respondUnsupported(id: unknown, method: string): void {
    const child = this.child
    if (!child) return
    this.log('info', `declining unsupported server request ${method}`)
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `LocalHarness does not implement ${method}` }
        })}\n`
      )
    } catch {
      /* the child is going away; nothing useful to do */
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.decode(chunk, { stream: true })
    let newline = this.stderrBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, '')
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
      if (line.trim().length > 0) {
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
        // Startup chatter on stderr is normal for these servers — info, never error.
        this.log('info', line)
      }
      newline = this.stderrBuffer.indexOf('\n')
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const how = signal ? `signal ${signal}` : `code ${code ?? 'null'}`
    this.child = undefined
    this.log(this.stopping ? 'info' : 'warn', `exited (${how})`)

    if (!this.handshakeDone && !this.stopping && code !== null && code !== 0) {
      const tail = this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' / ')}` : ''
      this.failStartup?.(
        new Error(`MCP server "${this.id}" exited with ${how} before it was ready${tail}`)
      )
    }

    this.rejectAllPending(`MCP server "${this.id}" stopped (${how})`)
  }

  private rejectAllPending(message: string): void {
    if (this.pending.size === 0) return
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.onLog?.(level, msg)
  }
}

/* ------------------------------------------------------------------ */
/* Result parsing                                                     */
/* ------------------------------------------------------------------ */

const EXTENSION_KINDS: Record<string, ArtifactKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.svg': 'image',
  '.avif': 'image',
  '.heic': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.aiff': 'audio',
  '.pdf': 'document',
  '.docx': 'document',
  '.doc': 'document',
  '.pptx': 'document',
  '.ppt': 'document',
  '.rtf': 'document',
  '.md': 'document',
  '.html': 'document',
  // No video kind exists in ArtifactKind; video files are surfaced as documents
  // so the path still reaches the panel rather than being dropped.
  '.mp4': 'document',
  '.mov': 'document',
  '.webm': 'document',
  '.csv': 'data',
  '.tsv': 'data',
  '.parquet': 'data',
  '.xlsx': 'data',
  '.xls': 'data',
  '.json': 'data',
  '.duckdb': 'data',
  '.sqlite': 'data',
  '.db': 'data'
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json'
}

/**
 * Absolute POSIX paths that carry a file extension.
 *
 * The leading boundary class keeps `https://host/a.png` from matching — a URL's
 * slashes are preceded by `:` or `/`, neither of which is a legal prefix here.
 * The body tolerates single spaces (these servers name files from the prompt,
 * so "take 1.mp3" is common) and the match is lazy so two paths on one line do
 * not merge; the ambiguity a space introduces is settled against the disk in
 * findPathsInText.
 */
const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'`(\[<,;=])(\/(?:[^\s"'`<>|:*?]| (?! ))+?\.[A-Za-z0-9]{1,8})(?=[\s"'`)\]},;:.!?]|$)/g

function parseCallResult(raw: unknown, toolName: string): McpCallResult {
  const result = asRecord(raw)
  if (!result) {
    return { text: typeof raw === 'string' ? raw : safeJson(raw), artifacts: [], isError: false }
  }

  const isError = result.isError === true
  const chunks: string[] = []
  const artifacts: Artifact[] = []
  const seenPaths = new Set<string>()

  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  for (const entry of content) {
    const block = asRecord(entry)
    if (!block) continue
    const type = typeof block.type === 'string' ? block.type : ''

    switch (type) {
      case 'text': {
        if (typeof block.text === 'string') chunks.push(block.text)
        break
      }
      case 'image':
      case 'audio': {
        const artifact = dataArtifact(block, type === 'image' ? 'image' : 'audio', toolName)
        if (artifact) artifacts.push(artifact)
        break
      }
      case 'resource': {
        const artifact = resourceArtifact(block, toolName, chunks)
        if (artifact) {
          if (artifact.path) seenPaths.add(artifact.path)
          artifacts.push(artifact)
        }
        break
      }
      case 'resource_link': {
        const artifact = linkArtifact(block, toolName)
        if (artifact) {
          if (artifact.path) seenPaths.add(artifact.path)
          artifacts.push(artifact)
        }
        break
      }
      default: {
        if (typeof block.text === 'string') chunks.push(block.text)
        break
      }
    }
  }

  if (chunks.length === 0 && result.structuredContent !== undefined) {
    chunks.push(safeJson(result.structuredContent))
  }

  const text = chunks.join('\n')

  // Several of these servers only report the file they wrote in prose
  // ("Saved to /Users/adam/Documents/llm-audio/foo.mp3"), so mine the text too.
  for (const path of findPathsInText(text)) {
    if (seenPaths.has(path)) continue
    seenPaths.add(path)
    artifacts.push(fileArtifact(path))
  }

  return { text, artifacts, isError }
}

function dataArtifact(
  block: Record<string, unknown>,
  kind: 'image' | 'audio',
  toolName: string
): Artifact | null {
  const data = typeof block.data === 'string' ? block.data : null
  if (!data) return null
  const mimeType =
    typeof block.mimeType === 'string' && block.mimeType.length > 0
      ? block.mimeType
      : kind === 'image'
        ? 'image/png'
        : 'audio/mpeg'
  return {
    id: randomUUID(),
    kind,
    url: `data:${mimeType};base64,${data}`,
    mimeType,
    label: `${toolName} ${kind}`,
    createdAt: Date.now()
  }
}

function resourceArtifact(
  block: Record<string, unknown>,
  toolName: string,
  chunks: string[]
): Artifact | null {
  const resource = asRecord(block.resource)
  if (!resource) return null

  // An embedded text resource is content, not an attachment.
  if (typeof resource.text === 'string' && resource.text.length > 0) {
    chunks.push(resource.text)
  }

  const uri = typeof resource.uri === 'string' ? resource.uri : ''
  if (uri.length === 0) return null
  const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : undefined

  if (uri.startsWith('file://')) {
    const path = fileUriToPath(uri)
    return fileArtifact(path, mimeType)
  }

  // A base64 blob with no file backing is still worth surfacing.
  const blob = typeof resource.blob === 'string' ? resource.blob : null
  if (blob && mimeType) {
    const kind: ArtifactKind = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('audio/')
        ? 'audio'
        : 'document'
    return {
      id: randomUUID(),
      kind,
      url: `data:${mimeType};base64,${blob}`,
      mimeType,
      label: `${toolName} ${kind}`,
      createdAt: Date.now()
    }
  }

  return {
    id: randomUUID(),
    kind: 'link',
    url: uri,
    mimeType,
    label: uri,
    createdAt: Date.now()
  }
}

function linkArtifact(block: Record<string, unknown>, toolName: string): Artifact | null {
  const uri = typeof block.uri === 'string' ? block.uri : ''
  if (uri.length === 0) return null
  const mimeType = typeof block.mimeType === 'string' ? block.mimeType : undefined
  if (uri.startsWith('file://')) return fileArtifact(fileUriToPath(uri), mimeType)
  return {
    id: randomUUID(),
    kind: 'link',
    url: uri,
    mimeType,
    label: typeof block.name === 'string' ? block.name : `${toolName} link`,
    createdAt: Date.now()
  }
}

function fileArtifact(path: string, mimeType?: string): Artifact {
  const ext = extname(path).toLowerCase()
  return {
    id: randomUUID(),
    kind: EXTENSION_KINDS[ext] ?? 'document',
    path,
    url: `file://${encodeURI(path)}`,
    mimeType: mimeType ?? MIME_BY_EXTENSION[ext],
    label: basename(path) || path,
    createdAt: Date.now()
  }
}

function fileUriToPath(uri: string): string {
  // Deliberately not fileURLToPath: these servers emit `file:///path with space`
  // unencoded often enough that the strict parser throws.
  const withoutScheme = uri.replace(/^file:\/\/(localhost)?/i, '')
  try {
    return decodeURIComponent(withoutScheme)
  } catch {
    return withoutScheme
  }
}

function findPathsInText(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const seen = new Set<string>()
  ABSOLUTE_PATH_RE.lastIndex = 0
  let match = ABSOLUTE_PATH_RE.exec(text)
  while (match !== null) {
    const candidate = match[1]
    if (candidate) {
      const trimmed = candidate.replace(/[.,;:)\]}'"`]+$/, '')
      const ext = extname(trimmed).toLowerCase()
      if (EXTENSION_KINDS[ext] && !seen.has(trimmed) && isCrediblePath(trimmed)) {
        seen.add(trimmed)
        found.push(trimmed)
      }
    }
    match = ABSOLUTE_PATH_RE.exec(text)
  }
  return found
}

/**
 * A path with a space in it is genuinely ambiguous in prose — "wrote it to
 * /tmp and then log.txt" parses as one filename — so those are only accepted
 * when they exist on disk. Space-free paths are unambiguous and taken as read,
 * which keeps a file the server wrote to a location we cannot stat from
 * silently vanishing.
 */
function isCrediblePath(path: string): boolean {
  if (!path.includes(' ')) return true
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : safeJson(err)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
