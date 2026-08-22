/**
 * Skill discovery.
 *
 * A skill is a FOLDER containing a `SKILL.md` whose YAML frontmatter carries
 * `name` and `description`. Adam keeps the same three skills replicated across
 * every harness he runs (~/.claude, ~/.lmstudio, ~/.config/opencode, ~/.copilot,
 * ~/.continue), so this scans all of them and de-duplicates by name: the first
 * root that declares a name wins and the copies are silently ignored. Showing
 * `photography` five times would be worse than useless.
 *
 * ## The cost model, which is the whole point
 *
 * Only `name` + `description` ever reach the prompt — `catalogue()` is a few
 * dozen tokens for the entire library, re-sent on every message. The BODY is
 * read only when the model calls `use_skill` (see ../agent/skilltool.ts). That
 * asymmetry is why a skill is nearly free while an MCP server is not: a server
 * re-sends its full tool schemas every single message (comfy-image alone costs
 * 3,007 tokens), whereas a skill costs its one-line catalogue entry until the
 * moment it is actually used.
 *
 * So: never inline a skill body into the prompt, and never let `catalogue()`
 * grow to include anything but the name and the description. Doing either would
 * destroy the property that makes skills worth having.
 *
 * ## Robustness
 *
 * Every root, every folder and every file is handled defensively — a malformed
 * or unreadable SKILL.md is logged and skipped, never thrown. A missing root is
 * not an error at all; four of the five normally do not exist on a fresh box.
 */

import { watch, type Dirent, type FSWatcher, mkdirSync} from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

import type { Settings, Skill } from '@shared/types'

import type { LogFn } from '../mcp/manager'
import { estimateTokens } from '../mcp/tokens'
import { expandTilde } from '../store/paths'

export interface SkillRegistryOptions {
  getSettings: () => Settings
  onSkills: (skills: Skill[]) => void
  onLog: LogFn
}

const LOG_SCOPE = 'skills'
const SKILL_FILE = 'SKILL.md'

/** A SKILL.md is markdown. Anything past this is not a skill and is skipped. */
const MAX_SKILL_BYTES = 1_048_576
/**
 * Descriptions are paid for on every message, so a runaway one is clamped.
 * 1024 matches the ceiling Claude's own skill format documents.
 */
const MAX_DESCRIPTION_CHARS = 1024
/** Editors write a file several times per save; coalesce the rescans. */
const WATCH_DEBOUNCE_MS = 400

/* ------------------------------------------------------------------ */
/* Roots                                                               */
/* ------------------------------------------------------------------ */

/**
 * Where skills live, in priority order. First hit wins on a name collision, so
 * ~/.claude/skills — the copy Adam actually edits — is deliberately first and
 * the replicas follow.
 */
function homeSkillRoots(): string[] {
  const home = homedir()
  const roots = [
    join(home, '.claude', 'skills'),
    join(home, '.lmstudio', 'skills'),
    join(home, '.config', 'opencode', 'skills')
  ]
  // opencode honours XDG_CONFIG_HOME; add that variant too when it is set to
  // somewhere other than the default, rather than assuming ~/.config.
  const xdg = process.env['XDG_CONFIG_HOME']
  if (typeof xdg === 'string' && xdg.trim().length > 0) {
    roots.push(join(expandTilde(xdg.trim()), 'opencode', 'skills'))
  }
  roots.push(join(home, '.copilot', 'skills'), join(home, '.continue', 'skills'))
  return roots
}

/** `<workspaceRoot>/.agents/skills` — the per-project convention Bionic uses. */
function projectSkillRoots(settings: Settings): string[] {
  const roots = settings.workspaceRoots
  if (!Array.isArray(roots)) return []
  const out: string[] = []
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    out.push(join(expandTilde(raw.trim()), '.agents', 'skills'))
  }
  return out
}

/** Home dir collapsed back to `~`, because `~/.claude/skills` is what Adam
 *  calls this directory and `/Users/adam/...` is not. */
function collapseHome(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`
  return path
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

export interface SkillFile {
  /** Frontmatter keys, lowercased. Empty when there is no valid block. */
  meta: Record<string, string>
  /** Everything after the closing fence — the instructions themselves. */
  body: string
  /** False when the file had no `---` block, or an unterminated one. */
  hasFrontmatter: boolean
}

/**
 * Splits a SKILL.md into frontmatter and body.
 *
 * Hand-written by design: this is a `---` fenced block of `key: value` pairs,
 * not general YAML, and pulling in a parser for it would be a dependency for
 * about forty lines of work. It handles what these files actually contain:
 * quoted values, values full of colons (every description here has one), folded
 * (`>`) and literal (`|`) block scalars, indented continuation lines, and `#`
 * comments. Anything it does not understand is ignored rather than fatal.
 */
export function splitFrontmatter(text: string): SkillFile {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r?\n/)

  let open = -1
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0) continue
    open = line === '---' ? i : -1
    break
  }
  if (open < 0) return { meta: {}, body: source, hasFrontmatter: false }

  let close = -1
  for (let i = open + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '---' || line === '...') {
      close = i
      break
    }
  }
  // An unterminated fence means the whole file would vanish into "frontmatter".
  // Treat it as a plain markdown file instead of losing the instructions.
  if (close < 0) return { meta: {}, body: source, hasFrontmatter: false }

  const meta = parseFrontmatter(lines.slice(open + 1, close))
  const body = lines.slice(close + 1).join('\n')
  return { meta, body, hasFrontmatter: true }
}

const KEY_RE = /^([A-Za-z0-9_.$-]+)\s*:\s*(.*)$/

function parseFrontmatter(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {}
  let key: string | null = null
  let blockStyle: 'folded' | 'literal' | null = null
  let blockLines: string[] = []

  const flushBlock = (): void => {
    if (key === null || blockStyle === null) return
    meta[key] =
      blockStyle === 'literal'
        ? blockLines.join('\n').replace(/\s+$/, '')
        : blockLines
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .join(' ')
    blockStyle = null
    blockLines = []
  }

  for (const raw of lines) {
    const line = raw ?? ''
    const trimmed = line.trim()

    if (blockStyle !== null) {
      // A blank or indented line continues the block; anything at column 0 ends it.
      if (trimmed.length === 0 || /^\s/.test(line)) {
        blockLines.push(line.replace(/^\s{1,4}/, ''))
        continue
      }
      flushBlock()
    }

    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    // Indented line under a plain scalar: YAML folds it onto the value.
    if (key !== null && /^\s/.test(line) && !KEY_RE.test(trimmed)) {
      meta[key] = `${meta[key] ?? ''} ${trimmed}`.trim()
      continue
    }

    const match = KEY_RE.exec(trimmed)
    if (match === null) continue

    key = (match[1] ?? '').toLowerCase()
    const rest = (match[2] ?? '').trim()
    if (rest === '|' || rest === '|-' || rest === '|+') {
      blockStyle = 'literal'
      blockLines = []
    } else if (rest === '>' || rest === '>-' || rest === '>+') {
      blockStyle = 'folded'
      blockLines = []
    } else {
      meta[key] = unquote(rest)
    }
  }

  flushBlock()
  return meta
}

function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if (first === '"' && last === '"') {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/**
 * Fallback description: the first line of real prose. Headings, horizontal
 * rules, HTML comments and list bullets are skipped, because "# Photography"
 * tells the model nothing it does not already have from the name.
 */
function firstProseLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('===')) continue
    if (line.startsWith('<!--') || line.startsWith('<')) continue
    line = line.replace(/^[>*\-+]\s*/, '').replace(/^\d+\.\s*/, '')
    line = line.replace(/[*_`]/g, '').trim()
    if (line.length > 0) return line
  }
  return ''
}

/** One line, one skill. The single formatter for everything the model sees. */
export function catalogueLine(skill: Pick<Skill, 'name' | 'description'>): string {
  return `- ${skill.name}: ${skill.description}`
}

/** The catalogue for a set of skills — enabled ones only, in list order. */
export function skillCatalogue(skills: Skill[]): string {
  return skills
    .filter((s) => s.enabled)
    .map((s) => catalogueLine(s))
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export class SkillRegistry {
  private readonly opts: SkillRegistryOptions
  private skills: Skill[] = []
  /**
   * Enablement, keyed by lowercased skill name rather than by path: the same
   * skill exists at five paths and which one wins can change when a root
   * appears or disappears. Keying by name keeps a toggle meaningful.
   *
   * NOTE FOR THE INTEGRATOR: this is in memory only and resets on restart.
   * Persisting it needs a new Settings key (something like
   * `disabledSkills: string[]`), which this module deliberately does not add —
   * Settings is owned elsewhere. Once the key exists, seed the map from it in
   * the constructor and write back in `setEnabled`.
   */
  private readonly enabledByName = new Map<string, boolean>()
  private running = false
  private watchers: FSWatcher[] = []
  private watchedRoots: string[] = []
  private debounce: NodeJS.Timeout | null = null
  /** Scans are serialised so a watcher storm cannot interleave two of them. */
  private queue: Promise<Skill[]> = Promise.resolve([])
  /** Last payload pushed to the renderer, so identical rescans stay silent. */
  private lastSignature: string | null = null

  constructor(opts: SkillRegistryOptions) {
    this.opts = opts
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.running) return
    this.running = true
    void this.refresh()
  }

  stop(): void {
    this.running = false
    if (this.debounce !== null) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    this.closeWatchers()
  }

  /* ---------------------------------------------------------------- */
  /* Introspection                                                    */
  /* ---------------------------------------------------------------- */

  /** Copies, so a caller cannot mutate the registry's own state. */
  list(): Skill[] {
    return this.skills.map((s) => ({ ...s }))
  }

  async refresh(): Promise<Skill[]> {
    const run = this.queue.catch(() => []).then(() => this.scan())
    this.queue = run
    return run
  }

  setEnabled(path: string, enabled: boolean): Skill[] {
    const skill = this.skills.find((s) => s.path === path)
    if (skill === undefined) {
      this.opts.onLog('warn', LOG_SCOPE, `setEnabled: no skill at ${path}`)
      return this.list()
    }
    if (skill.enabled === enabled) return this.list()

    this.enabledByName.set(nameKey(skill.name), enabled)
    skill.enabled = enabled
    this.opts.onLog(
      'info',
      LOG_SCOPE,
      `${enabled ? 'enabled' : 'disabled'} "${skill.name}" (catalogue now ${this.catalogueTokens()} tokens/message)`
    )
    this.publish()
    return this.list()
  }

  /**
   * The full SKILL.md text, exactly as it is on disk — frontmatter included, so
   * the panel's preview shows the real file.
   *
   * Only paths already in the index are readable. This handler is reachable from
   * the renderer, and "read any file the caller names" is not a capability the
   * skills panel needs.
   *
   * Read fresh every time rather than cached: Adam edits these files while the
   * app is running, and a stale body is worse than a slightly slower call.
   */
  async read(path: string): Promise<string | null> {
    const skill = this.skills.find((s) => s.path === path)
    if (skill === undefined) {
      this.opts.onLog('warn', LOG_SCOPE, `read refused: ${path} is not a known skill`)
      return null
    }
    try {
      return await readFile(skill.path, 'utf8')
    } catch (err) {
      this.opts.onLog('warn', LOG_SCOPE, `read failed for ${skill.path}: ${message(err)}`)
      return null
    }
  }

  /**
   * Catalogue lines for the system prompt: name + description only.
   *
   * This is the entire per-message cost of the skill system. Adding anything
   * else to this string — a path, a body, a token count — is paid for on every
   * message of every conversation forever.
   */
  catalogue(): string {
    return skillCatalogue(this.skills)
  }

  /** Total tokens the catalogue adds per message. */
  catalogueTokens(): number {
    return estimateTokens(this.catalogue())
  }

  /* ---------------------------------------------------------------- */
  /* Scanning                                                         */
  /* ---------------------------------------------------------------- */

  private roots(): string[] {
    let settings: Settings | null = null
    try {
      settings = this.opts.getSettings()
    } catch (err) {
      this.opts.onLog('warn', LOG_SCOPE, `settings unavailable: ${message(err)}`)
    }

    /* Ours first. A name defined in this app's own folder wins over the same
       name in any harness we merely read from — otherwise a skill written FOR
       this app could be shadowed by a stale copy in ~/.claude/skills, which is
       exactly the collision the de-duplication was built to hide. */
    const own = settings === null ? [] : [expandTilde(settings.skillsRoot.trim())]
    const candidates = [
      ...own,
      ...homeSkillRoots(),
      ...(settings === null ? [] : projectSkillRoots(settings))
    ]
    /* Created rather than merely scanned: a folder the user is told about in
       Settings, and can be asked to reveal in Finder, has to exist. */
    for (const dir of own) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (err) {
        this.opts.onLog('warn', LOG_SCOPE, `could not create ${collapseHome(dir)}: ${message(err)}`)
      }
    }

    // Two workspace roots can resolve to the same directory, and so can
    // XDG_CONFIG_HOME=~/.config. Scan each one once.
    const seen = new Set<string>()
    const out: string[] = []
    for (const candidate of candidates) {
      let full: string
      try {
        full = resolve(candidate)
      } catch {
        continue
      }
      if (seen.has(full)) continue
      seen.add(full)
      out.push(full)
    }
    return out
  }

  private async scan(): Promise<Skill[]> {
    const roots = this.roots()
    const byName = new Map<string, Skill>()
    let duplicates = 0

    for (const root of roots) {
      const found = await this.scanRoot(root)
      for (const skill of found) {
        const key = nameKey(skill.name)
        if (byName.has(key)) {
          // The same three skills live in four or five directories. First root
          // wins; the rest are noise.
          duplicates++
          continue
        }
        skill.enabled = this.enabledByName.get(key) ?? true
        byName.set(key, skill)
      }
    }

    this.skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.publish(roots, duplicates)
    if (this.running) this.armWatchers(roots)
    return this.list()
  }

  private async scanRoot(root: string): Promise<Skill[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (err) {
      // A root that does not exist is the normal case, not a problem.
      if (!isMissing(err)) {
        this.opts.onLog('warn', LOG_SCOPE, `cannot read ${collapseHome(root)}: ${message(err)}`)
      }
      return []
    }

    const names = entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))

    const out: Skill[] = []
    for (const name of names) {
      const dir = join(root, name)
      try {
        // stat, not entry.isDirectory(): several of these roots are populated
        // by symlinking the ~/.claude copies across, and a symlinked skill is
        // still a skill.
        const info = await stat(dir)
        if (!info.isDirectory()) continue
      } catch {
        continue
      }
      const skill = await this.loadSkill(dir, root)
      if (skill !== null) out.push(skill)
    }
    return out
  }

  /** One level deep: a subdirectory with a SKILL.md in it. Never throws. */
  private async loadSkill(dir: string, root: string): Promise<Skill | null> {
    const file = join(dir, SKILL_FILE)
    try {
      const info = await stat(file)
      if (!info.isFile()) return null
      if (info.size === 0) {
        this.opts.onLog('warn', LOG_SCOPE, `skipping ${collapseHome(file)}: empty file`)
        return null
      }
      if (info.size > MAX_SKILL_BYTES) {
        this.opts.onLog(
          'warn',
          LOG_SCOPE,
          `skipping ${collapseHome(file)}: ${info.size} bytes is too large for a SKILL.md`
        )
        return null
      }

      const text = await readFile(file, 'utf8')
      const parsed = splitFrontmatter(text)
      if (!parsed.hasFrontmatter) {
        this.opts.onLog(
          'warn',
          LOG_SCOPE,
          `${collapseHome(file)} has no --- frontmatter block; using the folder name and first line`
        )
      }

      const name = pickName(parsed.meta['name'], dir)
      const description = this.pickDescription(parsed, name, file)

      return {
        name,
        description,
        path: file,
        dir,
        source: collapseHome(root),
        bodyChars: parsed.body.trim().length,
        catalogTokens: estimateTokens(catalogueLine({ name, description })),
        enabled: true
      }
    } catch (err) {
      // Anything at all wrong with one skill leaves the other skills intact.
      if (!isMissing(err)) {
        this.opts.onLog('warn', LOG_SCOPE, `skipping ${collapseHome(dir)}: ${message(err)}`)
      }
      return null
    }
  }

  private pickDescription(parsed: SkillFile, name: string, file: string): string {
    const raw = parsed.meta['description']
    let description = typeof raw === 'string' ? raw.trim() : ''
    if (description.length === 0) description = firstProseLine(parsed.body)
    if (description.length === 0) {
      this.opts.onLog(
        'warn',
        LOG_SCOPE,
        `${collapseHome(file)} has no description; the model has nothing to choose it by`
      )
      description = `(no description in ${SKILL_FILE})`
    }

    // The catalogue is one line per skill, so a newline in a description would
    // break the format the model reads.
    description = description.replace(/\s+/g, ' ').trim()

    if (description.length > MAX_DESCRIPTION_CHARS) {
      this.opts.onLog(
        'warn',
        LOG_SCOPE,
        `description for "${name}" is ${description.length} chars; truncated to ${MAX_DESCRIPTION_CHARS} (it is re-sent every message)`
      )
      description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    }
    return description
  }

  /* ---------------------------------------------------------------- */
  /* Watching                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Watch the roots that exist so the panel tracks edits live. Best effort:
   * watching is a convenience, and a platform that refuses simply means the
   * user presses refresh.
   */
  private armWatchers(roots: string[]): void {
    if (sameList(roots, this.watchedRoots)) return
    this.closeWatchers()
    this.watchedRoots = roots.slice()

    for (const root of roots) {
      let watcher: FSWatcher
      try {
        watcher = watch(root, { recursive: true }, () => this.onFsEvent())
      } catch {
        try {
          // Recursive watching is not available everywhere; the top level still
          // catches a skill folder being added or removed.
          watcher = watch(root, () => this.onFsEvent())
        } catch {
          continue
        }
      }
      watcher.on('error', () => {
        /* a root deleted underneath us is not worth a log line */
      })
      this.watchers.push(watcher)
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
    this.watchers = []
    this.watchedRoots = []
  }

  private onFsEvent(): void {
    if (!this.running) return
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, WATCH_DEBOUNCE_MS)
  }

  /* ---------------------------------------------------------------- */
  /* Emission                                                         */
  /* ---------------------------------------------------------------- */

  /** Pushes to the renderer only when something actually changed — a rescan
   *  triggered by an unrelated file write should be invisible. */
  private publish(roots?: string[], duplicates?: number): void {
    const signature = JSON.stringify(
      this.skills.map((s) => [s.name, s.path, s.enabled, s.bodyChars, s.description.length])
    )
    if (signature === this.lastSignature) return
    this.lastSignature = signature

    if (roots !== undefined) {
      const dupNote = duplicates ? `, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} ignored` : ''
      this.opts.onLog(
        'info',
        LOG_SCOPE,
        `${this.skills.length} skill${this.skills.length === 1 ? '' : 's'} from ${roots.length} roots${dupNote}; catalogue ${this.catalogueTokens()} tokens/message`
      )
    }

    try {
      this.opts.onSkills(this.list())
    } catch (err) {
      this.opts.onLog('warn', LOG_SCOPE, `onSkills listener threw: ${message(err)}`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pickName(raw: string | undefined, dir: string): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return name.length > 0 ? name : basename(dir)
}

/** De-duplication key. Names are folder-ish, so case is not meaningful. */
function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, i) => value === b[i])
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
