/**
 * Native tool execution.
 *
 * This is the only place in LocalHarness with filesystem and shell write
 * access, so the order of operations is load-bearing:
 *
 *   parse args -> resolve path -> sandbox check -> approval -> act
 *
 * The sandbox check happens before the approval prompt on purpose. A path that
 * escapes the workspace is refused outright; the user is never offered the
 * chance to wave it through, because a model that has been talked into reading
 * ~/.ssh should not get a dialog that looks like every other dialog.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as FS_CONSTANTS } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'

import type {
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  FileOpKind,
  NativeToolId,
  Settings
} from '@shared/types'

import { augmentedPath, isInsideAny } from '../store/paths'
import { changedLinesFromDiff, type ActivityInput } from './activity'
import { diffStat, unifiedDiff } from './diff'
import { nativeToolInfo } from './tools'

export type LogFn = (level: 'info' | 'warn' | 'error', scope: string, message: string) => void

export interface ToolResult {
  text: string
  artifacts: Artifact[]
  isError: boolean
}

export interface ToolExecutorOptions {
  getSettings: () => Settings
  requestApproval: (req: Omit<ApprovalRequest, 'id' | 'createdAt'>) => Promise<ApprovalDecision>
  onLog: LogFn
  /** Optional live effect stream for the Code workspace. Optional because the
   *  executor is fully usable without anyone watching. */
  onActivity?: (activity: ActivityInput) => void
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

const MAX_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_CHARS = 2000
const MAX_DIR_ENTRIES = 1000
const GLOB_CAP = 500
const GREP_CAP = 200
const GREP_LINE_CHARS = 300
const MAX_WALK_ENTRIES = 200_000

const SHELL_DEFAULT_TIMEOUT_MS = 120_000
const SHELL_MAX_TIMEOUT_MS = 600_000
const SHELL_OUTPUT_CAP = 1024 * 1024
/** Never buffer more than this per stream, whatever the cap says. */
const SHELL_STREAM_HARD_LIMIT = 8 * 1024 * 1024

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.venv',
  'venv',
  '__pycache__'
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tif', '.tiff', '.heic', '.avif',
  '.psd', '.ai', '.sketch', '.icns',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.aiff', '.opus',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.dmg', '.iso', '.pkg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a', '.node', '.wasm', '.class', '.jar',
  '.pyc', '.pyo', '.db', '.sqlite', '.sqlite3',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pack', '.idx'
])

/**
 * Anything that could chain, background, substitute — or REDIRECT.
 *
 * Redirection belongs here and its absence was a real escape: with `cat` on the
 * allowlist, `cat /etc/hosts > ~/.zshrc` matched the allowlisted prefix and was
 * auto-approved, writing outside every workspace root with no approval card and
 * no diff. `run_shell` sandboxes only its `cwd`, so the redirect target is never
 * path-checked. The prefix stops describing what the command does the moment any
 * of these appear, so the command must fall through to a human.
 */
const SHELL_CHAINING = /[;|&`\n\r<>]|\$\(/

/** Native tool -> the effect kind the Code workspace groups it under. */
const ACTIVITY_KIND: Record<NativeToolId, FileOpKind> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  list_dir: 'list',
  glob: 'glob',
  grep: 'grep',
  run_shell: 'shell'
}

/**
 * What the activity row points at: the path for file ops, the command for a
 * shell run, the pattern for a search. Best-effort — args are still unvalidated
 * here, so anything unreadable becomes an empty string rather than throwing
 * before the real argument narrowing gets a chance to report properly.
 */
function activityTarget(toolId: NativeToolId, args: unknown): string {
  const o = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  if (toolId === 'run_shell') return pick('command')
  if (toolId === 'glob' || toolId === 'grep') return pick('pattern') || pick('path')
  return pick('path')
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/* ------------------------------------------------------------------ */
/* Errors and argument narrowing                                       */
/* ------------------------------------------------------------------ */

/** A failure the model should see and can act on, not a crash. */
class ToolError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  let v = value
  // Small local models sometimes send the arguments object as a JSON string.
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return {}
    try {
      v = JSON.parse(trimmed) as unknown
    } catch {
      throw new ToolError('Arguments were not valid JSON.')
    }
  }
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ToolError('Arguments must be a JSON object.')
  }
  return v as Record<string, unknown>
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') {
    throw new ToolError(`Argument "${key}" is required and must be a string.`)
  }
  return v
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError(`Argument "${key}" must be a string.`)
  return v
}

function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v)
  throw new ToolError(`Argument "${key}" must be a number.`)
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  throw new ToolError(`Argument "${key}" must be a boolean.`)
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return nodePath.join(homedir(), p.slice(2))
  return p
}

/**
 * realpath, tolerating a path that does not exist yet: the deepest existing
 * ancestor is resolved and the missing tail is appended. Without this, symlink
 * resolution would be skipped entirely for files being created.
 */
async function realpathish(p: string): Promise<string> {
  try {
    return await fsp.realpath(p)
  } catch {
    const parent = nodePath.dirname(p)
    if (parent === p) return p
    return nodePath.join(await realpathish(parent), nodePath.basename(p))
  }
}

async function statOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

function isBinaryByName(p: string): boolean {
  return BINARY_EXTENSIONS.has(nodePath.extname(p).toLowerCase())
}

function hasSkippedSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function countLines(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.max(0, Math.floor(max * 0.6))
  const tail = Math.max(0, max - head)
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n… [${cut} characters of output truncated] …\n${text.slice(text.length - tail)}`
}

/* ------------------------------------------------------------------ */
/* Glob matching (used by the manual walk and by grep's glob filter)    */
/* ------------------------------------------------------------------ */

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

function globSource(glob: string): string {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]

    if (c === '*') {
      let stars = 0
      while (glob[i] === '*') {
        stars++
        i++
      }
      if (stars >= 2) {
        // `**/` also has to match zero directories, so it swallows the slash.
        if (glob[i] === '/') {
          re += '(?:.*/)?'
          i++
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
      continue
    }

    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }

    if (c === '[') {
      let j = i + 1
      let negated = false
      if (glob[j] === '!' || glob[j] === '^') {
        negated = true
        j++
      }
      let body = ''
      while (j < glob.length && glob[j] !== ']') {
        body += glob[j] === '\\' ? '\\\\' : glob[j]
        j++
      }
      if (j >= glob.length) {
        re += '\\['
        i++
        continue
      }
      re += `[${negated ? '^' : ''}${body}]`
      i = j + 1
      continue
    }

    if (c === '{') {
      let depth = 1
      let j = i + 1
      const parts: string[] = []
      let current = ''
      while (j < glob.length) {
        const d = glob[j]
        if (d === '{') {
          depth++
          current += d
        } else if (d === '}') {
          depth--
          if (depth === 0) break
          current += d
        } else if (d === ',' && depth === 1) {
          parts.push(current)
          current = ''
        } else {
          current += d
        }
        j++
      }
      if (depth !== 0) {
        re += '\\{'
        i++
        continue
      }
      parts.push(current)
      re += `(?:${parts.map(globSource).join('|')})`
      i = j + 1
      continue
    }

    re += escapeRegExpChar(c)
    i++
  }
  return re
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`)
}

/** Split a glob into its literal directory prefix and the magic remainder. */
function splitMagic(pattern: string): { base: string; rest: string } {
  const segments = pattern.split('/')
  const baseSegments: string[] = []
  let i = 0
  // Never consume the final segment — that is always part of the pattern.
  for (; i < segments.length - 1; i++) {
    if (/[*?[\]{}]/.test(segments[i])) break
    baseSegments.push(segments[i])
  }
  const rest = segments.slice(i).join('/')
  let base = baseSegments.join('/')
  if (pattern.startsWith('/') && base === '') base = '/'
  return { base, rest }
}

/* ------------------------------------------------------------------ */
/* Shell allowlist                                                     */
/* ------------------------------------------------------------------ */

/**
 * True when the command's leading token(s) exactly match an allowlist entry.
 * `git` must not authorise `gitleaks`, and nothing that chains a second command
 * is ever auto-allowed however innocent its prefix looks.
 */
export function isShellAllowlisted(command: string, allowlist: string[]): boolean {
  const cmd = command.trim()
  if (cmd === '') return false
  if (SHELL_CHAINING.test(cmd)) return false
  for (const raw of allowlist) {
    const entry = raw.trim()
    if (entry === '') continue
    if (cmd === entry) return true
    if (cmd.startsWith(entry) && /\s/.test(cmd.charAt(entry.length))) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* rg discovery                                                        */
/* ------------------------------------------------------------------ */

let cachedRgPath: string | null | undefined

async function resolveRipgrep(): Promise<string | null> {
  if (cachedRgPath !== undefined) return cachedRgPath
  // An Electron app launched from Finder inherits a minimal PATH, so the usual
  // Homebrew locations are checked explicitly as well.
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].filter((d) => d !== '')
  for (const dir of dirs) {
    const candidate = nodePath.join(dir, 'rg')
    try {
      await fsp.access(candidate, FS_CONSTANTS.X_OK)
      cachedRgPath = candidate
      return candidate
    } catch {
      // keep looking
    }
  }
  cachedRgPath = null
  return null
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

interface GateOptions {
  toolId: NativeToolId
  conversationId: string
  settings: Settings
  /** Identity for `allow_session`: tool plus resolved target, or the exact command. */
  key: string
  summary: string
  args: Record<string, unknown>
  diff?: string
  command?: string
}

export class ToolExecutor {
  /** `allow_session` grants, remembered for the lifetime of this process. */
  private readonly sessionAllowed = new Set<string>()
  private rootsCache: { key: string; roots: string[] } | null = null
  private readonly opts: ToolExecutorOptions

  constructor(opts: ToolExecutorOptions) {
    this.opts = opts
  }

  async execute(
    toolId: NativeToolId,
    args: unknown,
    conversationId: string
  ): Promise<ToolResult> {
    const settings = this.opts.getSettings()
    // One activity id spans start -> done so the ticker can replace the
    // in-progress row in place rather than stacking two.
    const activityId = randomUUID()
    const kind = ACTIVITY_KIND[toolId]
    const startedAt = Date.now()
    if (kind !== undefined) {
      this.opts.onActivity?.({
        id: activityId,
        conversationId,
        kind,
        phase: 'start',
        target: activityTarget(toolId, args)
      })
    }

    try {
      const record = asRecord(args)
      let result: ToolResult
      switch (toolId) {
        case 'read_file':
          result = await this.readFile(record, settings, conversationId)
          break
        case 'write_file':
          result = await this.writeFile(record, settings, conversationId)
          break
        case 'edit_file':
          result = await this.editFile(record, settings, conversationId)
          break
        case 'list_dir':
          result = await this.listDir(record, settings, conversationId)
          break
        case 'glob':
          result = await this.globFiles(record, settings, conversationId)
          break
        case 'grep':
          result = await this.grep(record, settings, conversationId)
          break
        case 'run_shell':
          result = await this.runShell(record, settings, conversationId)
          break
        default:
          return fail(`Unknown native tool "${String(toolId)}".`)
      }

      // write_file and edit_file emit their own 'done' with the diff, changed
      // lines and resulting content — richer than anything reconstructable here.
      if (kind !== undefined && toolId !== 'write_file' && toolId !== 'edit_file') {
        this.opts.onActivity?.({
          id: activityId,
          conversationId,
          kind,
          phase: result.isError ? 'error' : 'done',
          target: activityTarget(toolId, args),
          summary: firstLine(result.text),
          error: result.isError ? firstLine(result.text) : undefined,
          durationMs: Date.now() - startedAt
        })
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const level = err instanceof ToolError ? 'warn' : 'error'
      this.opts.onLog(level, 'agent', `${toolId}: ${message}`)
      if (kind !== undefined) {
        // A thrown tool must still close its 'start' row, or the ticker shows a
        // spinner that never resolves.
        this.opts.onActivity?.({
          id: activityId,
          conversationId,
          kind,
          phase: 'error',
          target: activityTarget(toolId, args),
          error: message,
          durationMs: Date.now() - startedAt
        })
      }
      return fail(message)
    }
  }

  /* ---------------- sandbox ---------------- */

  private async roots(settings: Settings): Promise<string[]> {
    const key = settings.workspaceRoots.join('\0')
    if (this.rootsCache && this.rootsCache.key === key) return this.rootsCache.roots
    const roots: string[] = []
    for (const raw of settings.workspaceRoots) {
      if (raw.trim() === '') continue
      roots.push(await realpathish(nodePath.resolve(expandTilde(raw))))
    }
    this.rootsCache = { key, roots }
    return roots
  }

  /**
   * Resolve a path argument and prove it is inside the workspace. Relative
   * paths are taken against the first root; `~` is expanded; symlinks are
   * followed before the check so a link cannot be used to step outside.
   */
  private async resolve(raw: string, settings: Settings, label = 'path'): Promise<string> {
    const roots = await this.roots(settings)
    if (roots.length === 0) {
      throw new ToolError(
        'Refused: no workspace roots are configured. Add a directory in Settings before using filesystem tools.'
      )
    }
    const expanded = expandTilde(raw)
    const absolute = nodePath.isAbsolute(expanded)
      ? nodePath.resolve(expanded)
      : nodePath.resolve(roots[0], expanded)
    const real = await realpathish(absolute)

    if (!isInsideAny(real, roots)) {
      const list = roots.map((r) => `  ${r}`).join('\n')
      throw new ToolError(
        `Refused: ${label} "${raw}" resolves to ${real}, which is outside every allowed workspace root.\n` +
          `Allowed roots:\n${list}`
      )
    }
    return real
  }

  private async display(absolute: string, settings: Settings): Promise<string> {
    const roots = await this.roots(settings)
    for (const root of roots) {
      if (absolute === root) return nodePath.basename(absolute) || absolute
      const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep
      if (absolute.startsWith(prefix)) return nodePath.relative(root, absolute)
    }
    return absolute
  }

  /* ---------------- approval ---------------- */

  /** Returns a denial result to short-circuit with, or null to proceed. */
  private async gate(gate: GateOptions): Promise<ToolResult | null> {
    const info = nativeToolInfo(gate.toolId)
    const mutating = info?.mutating ?? true
    const mode = gate.settings.approvalMode

    if (mode === 'auto_all') return null
    if (!mutating && mode === 'auto_read') return null
    if (this.sessionAllowed.has(gate.key)) return null
    if (
      gate.toolId === 'run_shell' &&
      gate.command !== undefined &&
      isShellAllowlisted(gate.command, gate.settings.shellAllowlist)
    ) {
      this.opts.onLog('info', 'agent', `run_shell auto-allowed by allowlist: ${gate.command}`)
      return null
    }

    const decision = await this.opts.requestApproval({
      conversationId: gate.conversationId,
      toolName: gate.toolId,
      summary: gate.summary,
      argsPreview: previewArgs(gate.args),
      diff: gate.diff,
      command: gate.command,
      mutating
    })

    if (decision === 'allow_session') {
      this.sessionAllowed.add(gate.key)
      return null
    }
    if (decision === 'allow_once') return null

    this.opts.onLog('warn', 'agent', `denied: ${gate.summary}`)
    return fail(
      `The user denied this action: ${gate.summary}. It was not performed. ` +
        'Do not retry the same call — ask what they would prefer, or take a different approach.'
    )
  }

  /* ---------------- read_file ---------------- */

  private async readFile(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const rawPath = reqString(args, 'path')
    const target = await this.resolve(rawPath, settings)
    const shown = await this.display(target, settings)

    if (isBinaryByName(target)) {
      return fail(
        `Refused: ${shown} has a binary extension (${nodePath.extname(target)}), so it was not read. ` +
          'read_file only handles text.'
      )
    }

    const st = await statOrNull(target)
    if (!st) return fail(`No such file: ${shown}.`)
    if (st.isDirectory()) return fail(`${shown} is a directory. Use list_dir to see what is in it.`)
    if (!st.isFile()) return fail(`${shown} is not a regular file.`)
    if (st.size > MAX_READ_BYTES) {
      return fail(
        `Refused: ${shown} is ${formatBytes(st.size)}, over the 2MB read limit. ` +
          'Use grep to find what you need, or run_shell with sed to pull a slice.'
      )
    }

    const denied = await this.gate({
      toolId: 'read_file',
      conversationId,
      settings,
      key: `read_file::${target}`,
      summary: `Read ${shown}`,
      args
    })
    if (denied) return denied

    const raw = await fsp.readFile(target, 'utf8')
    if (raw.length === 0) return ok(`${shown} is empty (0 bytes).`)
    if (raw.includes('\0')) {
      return fail(`Refused: ${shown} contains null bytes, so it is binary despite its extension.`)
    }

    const lines = raw.split('\n')
    if (raw.endsWith('\n')) lines.pop()

    const offset = Math.max(1, Math.trunc(optNumber(args, 'offset') ?? 1))
    const limit = Math.max(1, Math.trunc(optNumber(args, 'limit') ?? DEFAULT_READ_LIMIT))
    const slice = lines.slice(offset - 1, offset - 1 + limit)

    if (slice.length === 0) {
      return fail(`Offset ${offset} is past the end of ${shown}, which has ${lines.length} lines.`)
    }

    const body = slice
      .map((line, i) => {
        const text =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)} … [${line.length - MAX_LINE_CHARS} more characters on this line]`
            : line
        return `${String(offset + i).padStart(6)}\t${text}`
      })
      .join('\n')

    const end = offset + slice.length - 1
    const truncated = end < lines.length || offset > 1
    const note = truncated
      ? `\n\n… showing lines ${offset}-${end} of ${lines.length}.${
          end < lines.length ? ` Continue with offset=${end + 1}.` : ''
        }`
      : ''

    return ok(body + note)
  }

  /* ---------------- write_file ---------------- */

  private async writeFile(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const rawPath = reqString(args, 'path')
    const content = reqString(args, 'content')
    const target = await this.resolve(rawPath, settings)
    const shown = await this.display(target, settings)

    const st = await statOrNull(target)
    if (st && st.isDirectory()) return fail(`${shown} is a directory, not a file.`)

    let existing = ''
    let existingIsBinary = false
    if (st) {
      existing = await fsp.readFile(target, 'utf8')
      existingIsBinary = isBinaryByName(target) || existing.includes('\0')
    }

    if (st && !existingIsBinary && existing === content) {
      return ok(`No change: ${shown} already contains exactly this content.`)
    }

    const stat = existingIsBinary ? { added: countLines(content), removed: 0 } : diffStat(existing, content)
    const diff = existingIsBinary ? undefined : unifiedDiff(existing, content, shown) || undefined

    const summary = st
      ? existingIsBinary
        ? `Overwrite ${shown} (binary, ${formatBytes(st.size)})`
        : `Write ${shown} (+${stat.added} -${stat.removed})`
      : `Write ${shown} (new file, ${countLines(content)} lines)`

    const denied = await this.gate({
      toolId: 'write_file',
      conversationId,
      settings,
      key: `write_file::${target}`,
      summary,
      args,
      diff
    })
    if (denied) return denied

    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, 'utf8')
    this.opts.onLog('info', 'agent', summary)
    this.opts.onActivity?.({
      conversationId,
      kind: 'write',
      phase: 'done',
      target,
      diff,
      added: stat.added,
      removed: stat.removed,
      changedLines: diff ? changedLinesFromDiff(diff) : undefined,
      content: existingIsBinary ? undefined : content,
      summary
    })

    return ok(
      st
        ? `Wrote ${shown} (+${stat.added} -${stat.removed}, ${formatBytes(Buffer.byteLength(content))}).`
        : `Created ${shown} (${countLines(content)} lines, ${formatBytes(Buffer.byteLength(content))}).`
    )
  }

  /* ---------------- edit_file ---------------- */

  private async editFile(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const rawPath = reqString(args, 'path')
    const oldString = reqString(args, 'old_string')
    const newString = reqString(args, 'new_string')
    const replaceAll = optBool(args, 'replace_all') ?? false

    if (oldString === '') {
      return fail('old_string must not be empty. Use write_file to create or replace a whole file.')
    }
    if (oldString === newString) {
      return fail('old_string and new_string are identical — that edit would change nothing.')
    }

    const target = await this.resolve(rawPath, settings)
    const shown = await this.display(target, settings)

    const st = await statOrNull(target)
    if (!st) return fail(`No such file: ${shown}. Use write_file to create it.`)
    if (!st.isFile()) return fail(`${shown} is not a regular file.`)
    if (st.size > MAX_READ_BYTES) {
      return fail(`Refused: ${shown} is ${formatBytes(st.size)}, over the 2MB edit limit.`)
    }

    const existing = await fsp.readFile(target, 'utf8')

    let count = 0
    let from = existing.indexOf(oldString)
    while (from !== -1) {
      count++
      from = existing.indexOf(oldString, from + oldString.length)
    }

    if (count === 0) {
      return fail(
        `old_string was not found in ${shown}. The match is exact, including indentation and ` +
          'line endings — read the file and copy the text you want to replace verbatim.'
      )
    }
    if (count > 1 && !replaceAll) {
      return fail(
        `old_string occurs ${count} times in ${shown}, so the edit is ambiguous and nothing was changed. ` +
          'Include more surrounding lines to make it unique, or pass replace_all: true to change all ' +
          `${count} occurrences.`
      )
    }

    const next = replaceAll
      ? existing.split(oldString).join(newString)
      : existing.slice(0, existing.indexOf(oldString)) +
        newString +
        existing.slice(existing.indexOf(oldString) + oldString.length)

    const stat = diffStat(existing, next)
    const diff = unifiedDiff(existing, next, shown) || undefined
    const suffix = count > 1 ? ` ×${count}` : ''
    const summary = `Edit ${shown} (+${stat.added} -${stat.removed})${suffix}`

    const denied = await this.gate({
      toolId: 'edit_file',
      conversationId,
      settings,
      key: `edit_file::${target}`,
      summary,
      args,
      diff
    })
    if (denied) return denied

    await fsp.writeFile(target, next, 'utf8')
    this.opts.onLog('info', 'agent', summary)
    this.opts.onActivity?.({
      conversationId,
      kind: 'edit',
      phase: 'done',
      target,
      diff,
      added: stat.added,
      removed: stat.removed,
      changedLines: diff ? changedLinesFromDiff(diff) : undefined,
      content: next,
      summary
    })

    return ok(
      `Edited ${shown}: ${count > 1 ? `${count} occurrences replaced` : '1 occurrence replaced'} ` +
        `(+${stat.added} -${stat.removed}).`
    )
  }

  /* ---------------- list_dir ---------------- */

  private async listDir(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const rawPath = reqString(args, 'path')
    const target = await this.resolve(rawPath, settings)
    const shown = await this.display(target, settings)

    const st = await statOrNull(target)
    if (!st) return fail(`No such directory: ${shown}.`)
    if (!st.isDirectory()) return fail(`${shown} is a file, not a directory. Use read_file.`)

    const denied = await this.gate({
      toolId: 'list_dir',
      conversationId,
      settings,
      key: `list_dir::${target}`,
      summary: `List ${shown}`,
      args
    })
    if (denied) return denied

    const entries = await fsp.readdir(target, { withFileTypes: true })
    const dirs: string[] = []
    const files: string[] = []

    for (const entry of entries) {
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        const linked = await statOrNull(nodePath.join(target, entry.name))
        isDir = linked?.isDirectory() ?? false
      }
      if (isDir) dirs.push(`${entry.name}/`)
      else files.push(entry.name)
    }

    dirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    const all = [...dirs, ...files]
    if (all.length === 0) return ok(`${target} is empty.`)

    const listed = all.slice(0, MAX_DIR_ENTRIES)
    const lines = [`${target}`, ...listed.map((name) => `  ${name}`)]
    lines.push(
      `${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}, ${files.length} file${
        files.length === 1 ? '' : 's'
      }${all.length > listed.length ? ` (showing the first ${MAX_DIR_ENTRIES})` : ''}`
    )
    return ok(lines.join('\n'))
  }

  /* ---------------- glob ---------------- */

  private async globFiles(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const pattern = reqString(args, 'pattern')
    const pathArg = optString(args, 'path')

    const expandedPattern = expandTilde(pattern)
    const { base, rest } = splitMagic(expandedPattern)
    const rootRaw = nodePath.isAbsolute(base)
      ? base
      : nodePath.join(pathArg ? expandTilde(pathArg) : '.', base)

    const searchRoot = await this.resolve(rootRaw, settings, 'search root')
    const shownRoot = await this.display(searchRoot, settings)

    const st = await statOrNull(searchRoot)
    if (!st) return fail(`No such directory: ${shownRoot}.`)
    if (!st.isDirectory()) return fail(`${shownRoot} is not a directory.`)

    const denied = await this.gate({
      toolId: 'glob',
      conversationId,
      settings,
      key: `glob::${searchRoot}::${rest}`,
      summary: `Find "${pattern}" in ${shownRoot}`,
      args
    })
    if (denied) return denied

    const matches = await this.collectGlob(searchRoot, rest)
    matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    if (matches.length === 0) {
      return ok(`No files match "${pattern}" under ${searchRoot}.`)
    }

    const listed = matches.slice(0, GLOB_CAP)
    const lines = listed.map((rel) => nodePath.join(searchRoot, rel))
    if (matches.length > GLOB_CAP) {
      // Collection stops a little past the cap, so the real total is unknown —
      // say "more than", never a number we did not actually count to.
      lines.push(`… more than ${GLOB_CAP} matches; showing the first ${GLOB_CAP}. Narrow the pattern.`)
    }
    return ok(lines.join('\n'))
  }

  /** Relative paths matching `pattern` under `root`, skipping vendor dirs. */
  private async collectGlob(root: string, pattern: string): Promise<string[]> {
    const out: string[] = []

    // Node 22+ ships fs.glob; older runtimes fall back to a manual walk.
    if (typeof fsp.glob === 'function') {
      try {
        for await (const entry of fsp.glob(pattern, {
          cwd: root,
          exclude: (name: string) => hasSkippedSegment(name)
        })) {
          if (hasSkippedSegment(entry)) continue
          out.push(entry)
          // Keep collecting a little past the cap so the count is honest.
          if (out.length > GLOB_CAP * 4) break
        }
        return out
      } catch {
        // Fall through to the manual walk on an unsupported pattern.
        out.length = 0
      }
    }

    const re = globToRegExp(pattern)
    let seen = 0
    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (out.length > GLOB_CAP * 4 || seen > MAX_WALK_ENTRIES) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        seen++
        if (SKIP_DIRS.has(entry.name)) continue
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (re.test(rel)) out.push(rel)
        if (entry.isDirectory()) await walk(nodePath.join(dir, entry.name), rel)
        if (out.length > GLOB_CAP * 4) return
      }
    }
    await walk(root, '')
    return out
  }

  /* ---------------- grep ---------------- */

  private async grep(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const pattern = reqString(args, 'pattern')
    const pathArg = optString(args, 'path')
    const globArg = optString(args, 'glob')

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (err) {
      return fail(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`)
    }

    const target = await this.resolve(pathArg ?? '.', settings)
    const shown = await this.display(target, settings)

    const st = await statOrNull(target)
    if (!st) return fail(`No such file or directory: ${shown}.`)

    const denied = await this.gate({
      toolId: 'grep',
      conversationId,
      settings,
      key: `grep::${target}::${pattern}::${globArg ?? ''}`,
      summary: `Search "${pattern}" in ${shown}`,
      args
    })
    if (denied) return denied

    const rg = await resolveRipgrep()
    // rg is a fast path, not a requirement: anything that goes wrong with it
    // falls back to the manual scan rather than failing the tool call.
    const found =
      (rg ? await this.grepWithRipgrep(rg, pattern, target, st.isDirectory(), globArg) : null) ??
      (await this.grepManually(regex, target, st.isDirectory(), globArg))

    if (found.lines.length === 0) {
      return ok(`No matches for /${pattern}/ in ${shown}.`)
    }

    const truncated = found.lines.length > GREP_CAP
    const listed = found.lines.slice(0, GREP_CAP)
    const header = truncated
      ? `More than ${GREP_CAP} matches for /${pattern}/ in ${shown}; showing the first ${GREP_CAP}:`
      : `${listed.length} match${listed.length === 1 ? '' : 'es'} for /${pattern}/ in ${shown}:`
    return ok([header, ...listed].join('\n'))
  }

  /** Null when rg could not do the job, so the caller falls back to a manual scan. */
  private async grepWithRipgrep(
    rg: string,
    pattern: string,
    target: string,
    isDirectory: boolean,
    globArg: string | undefined
  ): Promise<{ lines: string[] } | null> {
    const argv = ['--line-number', '--no-heading', '--color', 'never', '--no-messages']
    if (globArg) argv.push('--glob', globArg)
    // Exclusions come last so they win over a user glob.
    for (const dir of SKIP_DIRS) argv.push('--glob', `!${dir}`)
    argv.push('-e', pattern, '--', target)

    const run = await spawnCollect(rg, argv, {
      cwd: isDirectory ? target : nodePath.dirname(target),
      timeoutMs: 60_000
    })
    // Exit 0 = matches, 1 = none, 2 = error. Anything else is rg misbehaving.
    if (run.spawnError || run.code === null || run.code > 1) {
      this.opts.onLog(
        'warn',
        'agent',
        `ripgrep unusable (${run.spawnError ?? (run.stderr.trim() || `exit ${run.code}`)}), scanning manually`
      )
      return null
    }
    const lines = run.stdout
      .split('\n')
      .filter((l) => l !== '')
      .map(clipGrepLine)
    return { lines }
  }

  private async grepManually(
    regex: RegExp,
    target: string,
    isDirectory: boolean,
    globArg: string | undefined
  ): Promise<{ lines: string[] }> {
    const globRe = globArg ? globToRegExp(globArg) : null
    const results: string[] = []
    let seen = 0

    const scanFile = async (file: string): Promise<void> => {
      if (results.length > GREP_CAP * 2) return
      if (isBinaryByName(file)) return
      const st = await statOrNull(file)
      if (!st || !st.isFile() || st.size > MAX_READ_BYTES) return
      let text: string
      try {
        text = await fsp.readFile(file, 'utf8')
      } catch {
        return
      }
      if (text.includes('\0')) return
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(clipGrepLine(`${file}:${i + 1}:${lines[i]}`))
          if (results.length > GREP_CAP * 2) return
        }
      }
    }

    const matchesGlob = (file: string): boolean => {
      if (!globRe) return true
      // A glob without a slash matches the basename, as ripgrep does.
      return globArg && globArg.includes('/')
        ? globRe.test(file)
        : globRe.test(nodePath.basename(file))
    }

    const walk = async (dir: string): Promise<void> => {
      if (results.length > GREP_CAP * 2 || seen > MAX_WALK_ENTRIES) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        seen++
        if (SKIP_DIRS.has(entry.name)) continue
        const full = nodePath.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && matchesGlob(full)) await scanFile(full)
        if (results.length > GREP_CAP * 2) return
      }
    }

    if (isDirectory) await walk(target)
    else if (matchesGlob(target)) await scanFile(target)

    return { lines: results }
  }

  /* ---------------- run_shell ---------------- */

  private async runShell(
    args: Record<string, unknown>,
    settings: Settings,
    conversationId: string
  ): Promise<ToolResult> {
    const command = reqString(args, 'command')
    if (command.trim() === '') return fail('command must not be empty.')

    const cwdArg = optString(args, 'cwd')
    const cwd = await this.resolve(cwdArg ?? '.', settings, 'cwd')
    const shownCwd = await this.display(cwd, settings)

    const cwdStat = await statOrNull(cwd)
    if (!cwdStat) return fail(`No such working directory: ${shownCwd}.`)
    if (!cwdStat.isDirectory()) return fail(`cwd ${shownCwd} is not a directory.`)

    const requested = optNumber(args, 'timeout_ms')
    const timeoutMs = Math.min(
      SHELL_MAX_TIMEOUT_MS,
      Math.max(1000, Math.trunc(requested ?? SHELL_DEFAULT_TIMEOUT_MS))
    )

    const oneLine = command.replace(/\s+/g, ' ').trim()
    const summary = `Run: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`

    const denied = await this.gate({
      toolId: 'run_shell',
      conversationId,
      settings,
      key: `run_shell::${command}`,
      summary,
      args,
      command
    })
    if (denied) return denied

    this.opts.onLog('info', 'agent', `${summary} (cwd ${shownCwd})`)
    const run = await spawnCollect('/bin/zsh', ['-lc', command], { cwd, timeoutMs })

    if (run.spawnError) {
      return fail(`Could not run the command: ${run.spawnError}`)
    }

    let stdout = run.stdout
    let stderr = run.stderr
    const total = stdout.length + stderr.length
    if (total > SHELL_OUTPUT_CAP) {
      const outMin = Math.min(stdout.length, 8192)
      const errMin = Math.min(stderr.length, 8192)
      const spare = SHELL_OUTPUT_CAP - outMin - errMin
      const spareTotal = stdout.length - outMin + (stderr.length - errMin)
      const outBudget =
        spareTotal > 0
          ? outMin + Math.floor((spare * (stdout.length - outMin)) / spareTotal)
          : outMin
      stdout = truncateMiddle(stdout, outBudget)
      stderr = truncateMiddle(stderr, SHELL_OUTPUT_CAP - outBudget)
    }

    const sections = [
      run.timedOut
        ? `Timed out after ${timeoutMs}ms — the process group was killed. Output captured so far:`
        : `Exit code: ${run.code ?? 'unknown'}`,
      '',
      '--- stdout ---',
      stdout.trimEnd() === '' ? '(empty)' : stdout.trimEnd(),
      '',
      '--- stderr ---',
      stderr.trimEnd() === '' ? '(empty)' : stderr.trimEnd()
    ]

    return {
      text: sections.join('\n'),
      artifacts: [],
      isError: run.timedOut || run.code !== 0
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function ok(text: string): ToolResult {
  return { text, artifacts: [] as Artifact[], isError: false }
}

function fail(text: string): ToolResult {
  return { text, artifacts: [] as Artifact[], isError: true }
}

function clipGrepLine(line: string): string {
  return line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)} …` : line
}

function previewArgs(args: Record<string, unknown>): string {
  const shallow: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    shallow[key] =
      typeof value === 'string' && value.length > 2000
        ? `${value.slice(0, 2000)}\n… [${value.length - 2000} more characters]`
        : value
  }
  try {
    return JSON.stringify(shallow, null, 2)
  } catch {
    return String(args)
  }
}

interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

/**
 * Spawn without a shell of our own, collect both streams, and kill the whole
 * process group on timeout — a plain child.kill() leaves the grandchildren of
 * `npm run dev` running forever.
 */
function spawnCollect(
  file: string,
  argv: string[],
  opts: { cwd: string; timeoutMs?: number }
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout can take the whole tree with it.
      detached: true,
      // Same reason the MCP client repairs PATH: launched from Finder this app
      // inherits launchd's minimal PATH, so `git`, `npm` and `rg` would all be
      // "command not found" while working fine under `npm run dev`.
      env: {
        ...process.env,
        PATH: augmentedPath(),
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    })

    const out: string[] = []
    const err: string[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let exitTimer: NodeJS.Timeout | undefined

    const kill = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          process.kill(pid, signal)
        } catch {
          // already gone
        }
      }
    }

    const settle = (code: number | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (exitTimer) clearTimeout(exitTimer)
      resolve({
        code,
        stdout: out.join(''),
        stderr: err.join(''),
        timedOut,
        spawnError
      })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (outLen >= SHELL_STREAM_HARD_LIMIT) return
      out.push(chunk)
      outLen += chunk.length
    })
    child.stderr?.on('data', (chunk: string) => {
      if (errLen >= SHELL_STREAM_HARD_LIMIT) return
      err.push(chunk)
      errLen += chunk.length
    })

    child.on('error', (e: Error) => settle(null, e.message))
    child.on('close', (code) => settle(code))
    child.on('exit', (code) => {
      if (settled) return
      // 'close' waits for the pipes; if a detached grandchild is holding them
      // open, do not hang the turn on it.
      exitTimer = setTimeout(() => settle(code), 500)
    })

    if (opts.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true
        kill('SIGTERM')
        graceTimer = setTimeout(() => kill('SIGKILL'), 2000)
      }, opts.timeoutMs)
    }
  })
}
