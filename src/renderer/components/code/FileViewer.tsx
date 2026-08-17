/**
 * The file surface of the Code workspace.
 *
 * Shows the *after* state of whatever the agent just touched, with the lines it
 * changed marked in the gutter, tinted, and briefly lit so the eye is pulled to
 * them and then let go. A unified-diff view sits behind a toggle for when the
 * before-state matters.
 *
 * Three rules shape it:
 *  - Content comes from the activity when the executor shipped it, and only
 *    falls back to a sandboxed read when it did not. A write of a 2MB file
 *    arrives without `content`, so that case must re-read rather than blank.
 *  - Removed lines have no home in an after-state. They get a gutter wedge
 *    between the surviving lines instead of being invented back in.
 *  - Motion is information. A line animates because it was just written; if the
 *    file was not already on screen there is nothing to animate, so it doesn't.
 *
 * There is no syntax-highlighting dependency in this app and there will not be
 * one. The tokeniser at the bottom of this file covers the languages this repo
 * is written in and falls back to plain text for everything else — a wrong
 * colour is worse than no colour.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX
} from 'react'

import type { FileActivity } from '@shared/types'
import DiffView from '@renderer/components/chat/DiffView'
import { basename, extname, formatMs, shortenPath } from '@renderer/lib/format'
import './code.css'

export interface FileViewerProps {
  /** Absolute path of the file on screen, or null when nothing is open. */
  path: string | null
  /** Newest write/edit that produced it, when there is one. */
  activity: FileActivity | null
  /** False when the user has pinned this tab to read it — the viewer then stops
   *  scrolling itself to each new change. Defaults to following. */
  following?: boolean
}

/** Rows rendered at once. Beyond this the viewer windows around the change
 *  rather than handing the compositor a 20,000-node list. */
const MAX_ROWS = 2400
/** Whole sequenced reveal, however many lines changed. */
const SEQ_TOTAL_MS = 640
const SEQ_MAX_STEP_MS = 26
/**
 * Width limits. A single line wider than this is truncated for display, and its
 * presence drops the whole window to the plain path — one enormous line costs
 * far more than many ordinary ones, and no one reads column 40,000 anyway.
 */
const MAX_LINE_CHARS = 2000
/** Total characters in the rendered window before highlighting is abandoned. */
const MAX_WINDOW_CHARS = 200_000

function clampLine(raw: string | undefined): string {
  const s = raw ?? ''
  if (s === '') return ' '
  if (s.length <= MAX_LINE_CHARS) return s
  return `${s.slice(0, MAX_LINE_CHARS)}  … ${s.length - MAX_LINE_CHARS} more characters`
}

function charsIn(lines: string[], start: number, end: number): number {
  let n = 0
  for (let i = start; i < end; i++) {
    n += lines[i]?.length ?? 0
    // Stop counting once the answer cannot change the decision.
    if (n > MAX_WINDOW_CHARS) return n
  }
  return n
}

function anyLineExceeds(lines: string[], start: number, end: number, width: number): boolean {
  for (let i = start; i < end; i++) {
    if ((lines[i]?.length ?? 0) > width) return true
  }
  return false
}

/** Past this the file is rendered as plain text — see tokenizeRange. */
const MAX_TOKENIZE_LINES = 20_000
/** Per-path text cache, kept across mounts so tab-flipping is instant. */
const CACHE_CAP = 24
const textCache = new Map<string, FileText>()

interface FileText {
  content: string
  truncated: boolean
}

type ViewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'unreadable' }

interface Flash {
  gen: number
  /** Lines the activity changed. These stay marked for as long as the file is
   *  open — they are the record, not the animation. */
  lines: Set<number>
  /** True only for a change that landed while this view was mounted, and only
   *  the first time it is shown. Opening an old file must not claim its lines
   *  just changed. */
  animate: boolean
  /** Lowest changed line, kept rather than derived — `Math.min(...set)` on a
   *  5,000-line change is an argument-list overflow waiting to happen. */
  first: number
  /** Reveal order, so line 400 doesn't animate before line 12. */
  rank: Map<number, number>
  stepMs: number
  /** False when the file was not already on screen — mark it, don't perform it. */
  sequenced: boolean
}

export function FileViewer({
  path,
  activity,
  following = true
}: FileViewerProps): JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: 'idle' })
  const [mode, setMode] = useState<'after' | 'diff'>('after')
  const [flash, setFlash] = useState<Flash | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const genRef = useRef(0)
  const shownPathRef = useRef<string | null>(null)
  const pendingScrollRef = useRef<number | null>(null)
  const mountedAt = useRef(Date.now())
  /** Ids already animated, so flipping back to a file does not replay it. */
  const animated = useRef(new Set<string>())

  const activityId = activity?.id ?? null
  /** A write with neither diff nor content is the executor's binary path. */
  const opaqueWrite =
    activity !== null &&
    (activity.kind === 'write' || activity.kind === 'edit') &&
    activity.diff === undefined &&
    activity.content === undefined

  /* ---- content ------------------------------------------------------ */

  useEffect(() => {
    if (!path) {
      setState({ kind: 'idle' })
      return
    }
    if (activity?.content !== undefined) {
      const next = { content: activity.content, truncated: false }
      cachePut(path, next)
      setState({ kind: 'text', ...next })
      return
    }
    if (opaqueWrite) {
      setState({ kind: 'binary' })
      return
    }

    // A write we were not given the text of has invalidated whatever we cached.
    const stale =
      activity !== null && (activity.kind === 'write' || activity.kind === 'edit')
    const hit = stale ? undefined : textCache.get(path)
    if (hit) {
      setState({ kind: 'text', ...hit })
      return
    }

    let cancelled = false
    setState({ kind: 'loading' })
    void window.harness
      .invoke('code:readFile', path)
      .then((res) => {
        if (cancelled) return
        if (!res) {
          setState({ kind: 'unreadable' })
          return
        }
        if (res.content.includes('\u0000')) {
          setState({ kind: 'binary' })
          return
        }
        cachePut(path, res)
        setState({ kind: 'text', content: res.content, truncated: res.truncated })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'unreadable' })
      })
    return () => {
      cancelled = true
    }
  }, [path, activityId, opaqueWrite, activity])

  /* ---- what just changed -------------------------------------------- */

  useEffect(() => {
    const changed = activity?.changedLines
    if (!activity || !changed || changed.length === 0) {
      setFlash(null)
      return
    }
    const ordered = [...changed].sort((a, b) => a - b)
    const rank = new Map<number, number>()
    ordered.forEach((ln, i) => rank.set(ln, i))
    // An activity from before this view existed is history: mark it, never
    // perform it. Anything else animates exactly once.
    const isNew = activity.at >= mountedAt.current && !animated.current.has(activity.id)
    if (isNew) animated.current.add(activity.id)
    genRef.current += 1
    setFlash({
      gen: genRef.current,
      lines: new Set(ordered),
      animate: isNew,
      first: ordered[0],
      rank,
      stepMs: Math.min(SEQ_MAX_STEP_MS, SEQ_TOTAL_MS / Math.max(ordered.length, 1)),
      // Nothing to reveal on a file the user has not been looking at.
      sequenced: isNew && shownPathRef.current === path
    })
    pendingScrollRef.current = ordered[0] ?? null
  }, [activityId, path, activity])

  // Runs after the flash effect on the same commit, so that one still sees the
  // previously shown path.
  useEffect(() => {
    shownPathRef.current = path
  }, [path])

  /* ---- lines --------------------------------------------------------- */

  const lines = useMemo(
    () => (state.kind === 'text' ? state.content.replace(/\r\n/g, '\n').split('\n') : []),
    [state]
  )

  const firstChanged = flash?.first ?? null

  const window0 = useMemo(() => {
    if (lines.length <= MAX_ROWS) return { start: 0, end: lines.length }
    const focus = (firstChanged ?? 1) - 1
    const start = Math.max(0, Math.min(focus - Math.floor(MAX_ROWS / 2), lines.length - MAX_ROWS))
    return { start, end: start + MAX_ROWS }
  }, [lines.length, firstChanged])

  const lang = useMemo(() => langFor(path), [path])
  const tokens = useMemo(
    () => tokenizeRange(lines, window0.start, window0.end, lang),
    [lines, window0.start, window0.end, lang]
  )
  const cuts = useMemo(() => removalsFromDiff(activity?.diff), [activity?.diff])

  /* ---- scroll the change into view ----------------------------------- */

  useLayoutEffect(() => {
    const line = pendingScrollRef.current
    if (line === null || state.kind !== 'text' || mode !== 'after') return
    // Pinning a tab means "let me read this". Freezing which tab is shown but
    // still yanking the reader to the newest hunk on every edit defeats it.
    if (!following) {
      pendingScrollRef.current = null
      return
    }
    const box = scrollRef.current
    if (!box) return
    const el = box.querySelector<HTMLElement>(`[data-ln="${line}"]`)
    // Cleared BEFORE the missing-element bail-out: a target that cannot be
    // resolved is discarded, not left armed to fire on an unrelated re-render.
    pendingScrollRef.current = null
    if (!el) return
    box.scrollTo({
      top: Math.max(0, el.offsetTop - box.clientHeight / 3),
      behavior: reducedMotion() ? 'auto' : 'smooth'
    })
  }, [state, mode, flash, following])

  /* ---- chrome -------------------------------------------------------- */

  const stat =
    activity && (activity.added !== undefined || activity.removed !== undefined)
      ? { added: activity.added ?? 0, removed: activity.removed ?? 0 }
      : null

  const gutterCh = Math.max(2, String(window0.end).length)
  const style = { '--cw-gut': `${gutterCh}ch` } as CSSProperties

  return (
    <section className="cw-view" aria-label="File viewer">
      <header className="cw-view-head">
        <div className="cw-view-id">
          {path ? (
            <>
              <span className="cw-view-name" title={path}>
                {basename(path)}
              </span>
              <span className="cw-view-dir">{shortenPath(dirOf(path), 3)}</span>
            </>
          ) : (
            <span className="cw-view-name cw-view-name-none">No file open</span>
          )}
        </div>

        <div className="cw-view-facts">
          {activity ? (
            <span className={`cw-op is-${activity.kind}`}>{activity.kind}</span>
          ) : null}
          {stat ? (
            <span className="cw-stat tnum">
              <span className="cw-stat-add">+{stat.added}</span>
              <span className="cw-stat-del">-{stat.removed}</span>
            </span>
          ) : null}
          {activity?.durationMs !== undefined ? (
            <span className="cw-view-dim tnum">{formatMs(activity.durationMs)}</span>
          ) : null}
          {state.kind === 'text' ? (
            <span className="cw-view-dim tnum">
              {lines.length > MAX_TOKENIZE_LINES ? 'plain' : lang.label} · {lines.length}{' '}
              lines
            </span>
          ) : null}
        </div>

        <div className="cw-seg" role="group" aria-label="View mode">
          <button
            type="button"
            className="cw-seg-btn"
            aria-pressed={mode === 'after'}
            onClick={() => setMode('after')}
          >
            After
          </button>
          <button
            type="button"
            className="cw-seg-btn"
            aria-pressed={mode === 'diff'}
            disabled={!activity?.diff}
            title={activity?.diff ? 'Unified diff' : 'This activity carries no diff'}
            onClick={() => setMode('diff')}
          >
            Diff
          </button>
        </div>
      </header>

      {activity?.error ? (
        <p className="cw-banner is-error">{activity.error}</p>
      ) : null}

      {mode === 'diff' ? (
        activity?.diff ? (
          <div className="cw-diff-wrap">
            <DiffView diff={activity.diff} className="cw-diff" />
          </div>
        ) : (
          <Placeholder
            title="No diff for this change"
            body="The executor emits a diff for text writes and edits. A new binary file, or a read, has nothing to compare against."
          />
        )
      ) : (
        <AfterView
          state={state}
          path={path}
          lines={lines}
          tokens={tokens}
          window0={window0}
          flash={flash}
          cuts={cuts}
          style={style}
          scrollRef={scrollRef}
        />
      )}
    </section>
  )
}

export default FileViewer

/* ------------------------------------------------------------------ */
/* After-state body                                                    */
/* ------------------------------------------------------------------ */

function AfterView(props: {
  state: ViewState
  path: string | null
  lines: string[]
  tokens: Tok[][]
  window0: { start: number; end: number }
  flash: Flash | null
  cuts: Map<number, number>
  style: CSSProperties
  scrollRef: { current: HTMLDivElement | null }
}): JSX.Element {
  const { state, path, lines, tokens, window0, flash, cuts, style, scrollRef } = props

  if (state.kind === 'idle') {
    return (
      <Placeholder
        title="Nothing open"
        body="Files the agent reads, writes or edits open here automatically. Shell commands and searches have no file to show — they run past in the ticker below."
      />
    )
  }
  if (state.kind === 'loading') {
    return (
      <div className="cw-place">
        <span className="dot dot-busy" />
        <p className="cw-place-title">Reading {path ? basename(path) : 'file'}…</p>
      </div>
    )
  }
  if (state.kind === 'unreadable') {
    return (
      <Placeholder
        title="Cannot read this file"
        body="It is outside the workspace roots, has been deleted, or is not a regular file. The viewer goes through the same sandbox as the agent's own tools — it will not read around it."
      />
    )
  }
  if (state.kind === 'binary') {
    return (
      <Placeholder
        title="Binary file"
        body="The change was written, but there is no text to show and no line diff to draw. The ticker below records the write."
      />
    )
  }

  const clipped = window0.end - window0.start < lines.length

  return (
    <>
      {state.truncated ? (
        <p className="cw-banner">
          File truncated at 2MB for viewing. What is on screen is the head of the
          file, not all of it.
        </p>
      ) : null}
      {clipped ? (
        <p className="cw-banner">
          Showing lines <span className="tnum">{window0.start + 1}</span>–
          <span className="tnum">{window0.end}</span> of{' '}
          <span className="tnum">{lines.length}</span>, centred on the change.
        </p>
      ) : null}

      <div
        className={
          flash?.sequenced ? 'cw-code scroll-y is-seq' : 'cw-code scroll-y'
        }
        style={style}
        ref={scrollRef}
      >
        <div className="cw-lines">
          {tokens.map((toks, i) => {
            const n = window0.start + i + 1
            const changed = flash?.lines.has(n) ?? false
            // Only a line that changed *just now* animates; the rest are marked.
            const fresh = changed && (flash?.animate ?? false)
            const cut = cuts.get(n)
            const delay = fresh && flash ? (flash.rank.get(n) ?? 0) * flash.stepMs : 0
            return (
              <div
                key={fresh && flash ? `${flash.gen}:${n}` : n}
                data-ln={n}
                className={
                  'cw-ln' +
                  (changed ? ' is-changed' : '') +
                  (fresh ? ' is-fresh' : '') +
                  (cut ? ' has-cut' : '')
                }
                style={fresh ? ({ '--cw-d': `${Math.round(delay)}ms` } as CSSProperties) : undefined}
              >
                <span className="cw-ln-no tnum">{n}</span>
                <span className="cw-ln-mark" aria-hidden="true" />
                {cut ? (
                  <span
                    className="cw-ln-cut"
                    title={`${cut} line${cut === 1 ? '' : 's'} removed here`}
                    aria-label={`${cut} lines removed`}
                  />
                ) : null}
                <span className="cw-ln-txt">
                  {toks.map((t, j) =>
                    t.k === null ? (
                      <span key={j}>{t.s}</span>
                    ) : (
                      <span key={j} className={`t-${t.k}`}>
                        {t.s}
                      </span>
                    )
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function Placeholder({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="cw-place">
      <p className="cw-place-title">{title}</p>
      <p className="cw-place-body">{body}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function cachePut(path: string, text: FileText): void {
  if (textCache.size >= CACHE_CAP) {
    const oldest = textCache.keys().next().value
    if (oldest !== undefined) textCache.delete(oldest)
  }
  textCache.delete(path)
  textCache.set(path, text)
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : p.slice(0, i)
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Where the deletions sit on the new side of the file, keyed by the line that
 * survived them. A run of `-` lines does not advance the new-side cursor, so
 * they all belong to the same marker.
 */
export function removalsFromDiff(diff: string | undefined): Map<number, number> {
  const out = new Map<number, number>()
  if (!diff) return out
  let cursor = 0
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      cursor = Number(hunk[1])
      continue
    }
    if (cursor === 0) continue
    if (line.startsWith('-')) out.set(cursor, (out.get(cursor) ?? 0) + 1)
    else if (line.startsWith('+') || line.startsWith(' ')) cursor += 1
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Tokeniser                                                           */
/* ------------------------------------------------------------------ */

/**
 * Small, deliberately shallow scanner. It knows strings, comments, numbers,
 * keywords and a couple of safe identifier heuristics — no parser, no grammar,
 * no attempt at regex literals or JSX semantics. Anything it is not sure about
 * stays plain.
 */
export type TokKind =
  | 'c' // comment
  | 's' // string
  | 'n' // number
  | 'k' // keyword
  | 't' // type / variable-like
  | 'f' // function call
  | 'd' // property / key
  | 'u' // punctuation

export interface Tok {
  k: TokKind | null
  s: string
}

interface Lang {
  id: string
  label: string
  line: string[]
  block: [string, string] | null
  quotes: string[]
  multi: { open: string; close: string }[]
  kw: Set<string>
  types: Set<string>
  /** ident immediately before `(` reads as a call. */
  fnCall: boolean
  /** Capitalised identifiers read as types. True only where that holds up. */
  upperType: boolean
  /** ident at the head of a declaration, before `:`. */
  propColon: boolean
  /** `"key":` in JSON. */
  stringKeys: boolean
  /** `$VAR` and `${VAR}`. */
  dollarVar: boolean
  /** `@media`, `@decorator`. */
  atWord: boolean
  /** `#a1b2c3`. */
  hexNum: boolean
  /** `-` is an identifier character (CSS). */
  dashIdent: boolean
}

const NONE: Set<string> = new Set()

function lang(spec: Partial<Lang> & { id: string; label: string }): Lang {
  return {
    line: [],
    block: null,
    quotes: [],
    multi: [],
    kw: NONE,
    types: NONE,
    fnCall: false,
    upperType: false,
    propColon: false,
    stringKeys: false,
    dollarVar: false,
    atWord: false,
    hexNum: false,
    dashIdent: false,
    ...spec
  }
}

const TS_KW = new Set(
  ('abstract as async await break case catch class const constructor continue declare default ' +
    'delete do else enum export extends false finally for from function get if implements import ' +
    'in infer instanceof interface is keyof let new null of override private protected public ' +
    'readonly return satisfies set static super switch this throw true try type typeof undefined ' +
    'var void while yield namespace module asserts await').split(' ')
)
const TS_TYPES = new Set(
  ('string number boolean object symbol bigint unknown never any void null undefined').split(' ')
)

const PY_KW = new Set(
  ('and as assert async await break class continue def del elif else except False finally for ' +
    'from global if import in is lambda None nonlocal not or pass raise return True try while ' +
    'with yield self match case').split(' ')
)

const SH_KW = new Set(
  ('if then else elif fi for while until do done case esac function in return local export ' +
    'readonly declare shift set unset source trap exit break continue').split(' ')
)

const CSS_KW = new Set(
  ('important inherit initial unset revert none auto').split(' ')
)

const LANGS: Record<string, Lang> = {
  ts: lang({
    id: 'ts',
    label: 'TS',
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
    multi: [{ open: '`', close: '`' }],
    kw: TS_KW,
    types: TS_TYPES,
    fnCall: true,
    upperType: true
  }),
  json: lang({
    id: 'json',
    label: 'JSON',
    quotes: ['"'],
    kw: new Set(['true', 'false', 'null']),
    stringKeys: true
  }),
  css: lang({
    id: 'css',
    label: 'CSS',
    line: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
    kw: CSS_KW,
    fnCall: true,
    propColon: true,
    atWord: true,
    hexNum: true,
    dashIdent: true
  }),
  py: lang({
    id: 'py',
    label: 'Python',
    line: ['#'],
    quotes: ['"', "'"],
    multi: [
      { open: '"""', close: '"""' },
      { open: "'''", close: "'''" }
    ],
    kw: PY_KW,
    fnCall: true,
    upperType: true,
    atWord: true
  }),
  sh: lang({
    id: 'sh',
    label: 'Shell',
    line: ['#'],
    quotes: ['"', "'"],
    kw: SH_KW,
    dollarVar: true
  }),
  md: lang({ id: 'md', label: 'Markdown' }),
  txt: lang({ id: 'txt', label: 'Text' })
}

const BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  md: 'md',
  markdown: 'md',
  py: 'py',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh'
}

export function langFor(path: string | null): Lang {
  if (!path) return LANGS['txt']
  return LANGS[BY_EXT[extname(path)] ?? 'txt'] ?? LANGS['txt']
}

interface ScanState {
  block: boolean
  /** Index into lang.multi, or -1. */
  multi: number
  /** Markdown fenced code. */
  fence: boolean
}

/**
 * Scans from the top of the file but only materialises tokens for the rendered
 * window — block comments and template literals carry state across lines, so
 * starting at the window would colour a long comment as code.
 */
export function tokenizeRange(
  lines: string[],
  start: number,
  end: number,
  spec: Lang
): Tok[][] {
  const out: Tok[][] = []
  // Carrying comment/template state means scanning from the top of the file. On
  // something enormous that is real work on the render path, and a generated
  // 40,000-line file is exactly where a scanner is least likely to be right —
  // so it goes out plain rather than slow and wrong.
  //
  // The LINE COUNT is not sufficient on its own. A minified bundle, a one-line
  // JSON, a lockfile or a base64 blob is a handful of enormous lines: it passes
  // both the row cap and the line cap, then emits one span per token into a
  // single flex row. Measured on a 2MB single-line file — the exact worst case
  // code:readFile can produce, since it truncates at 2MB and not at line width —
  // that is 1,125,000 spans mounted synchronously and the renderer hangs. So the
  // real gate is characters.
  const windowChars = charsIn(lines, start, end)
  const tooWide = anyLineExceeds(lines, start, end, MAX_LINE_CHARS)
  if (
    spec.id === 'txt' ||
    lines.length > MAX_TOKENIZE_LINES ||
    windowChars > MAX_WINDOW_CHARS ||
    tooWide
  ) {
    for (let i = start; i < end; i++) out.push([{ k: null, s: clampLine(lines[i]) }])
    return out
  }
  const st: ScanState = { block: false, multi: -1, fence: false }
  for (let i = 0; i < end; i++) {
    const collect = i >= start
    const toks =
      spec.id === 'md' ? scanMarkdown(lines[i], st, collect) : scanLine(lines[i], spec, st, collect)
    // Belt and braces: even inside the width gate, never let one row emit more
    // spans than a person could read. A row that hits this renders the rest of
    // itself as one plain span rather than thousands.
    if (collect) out.push(toks.length === 0 ? [{ k: null, s: ' ' }] : capTokens(toks))
  }
  return out
}

/** Maximum spans in a single rendered row. */
const MAX_TOKENS_PER_LINE = 1200

function capTokens(toks: Tok[]): Tok[] {
  if (toks.length <= MAX_TOKENS_PER_LINE) return toks
  const head = toks.slice(0, MAX_TOKENS_PER_LINE)
  const restChars = toks.slice(MAX_TOKENS_PER_LINE).reduce((n, t) => n + t.s.length, 0)
  head.push({ k: null, s: `  … ${restChars} more characters` })
  return head
}

function scanLine(line: string, spec: Lang, st: ScanState, collect: boolean): Tok[] {
  const out: Tok[] = []
  let plain = ''

  const push = (k: TokKind | null, s: string): void => {
    if (!collect || s === '') return
    const last = out[out.length - 1]
    if (last && last.k === k) last.s += s
    else out.push({ k, s })
  }
  const flush = (): void => {
    if (plain !== '') {
      push(null, plain)
      plain = ''
    }
  }

  const n = line.length
  let i = 0

  // Carry-over from the previous line.
  if (st.block && spec.block) {
    const close = spec.block[1]
    const at = line.indexOf(close)
    if (at === -1) {
      push('c', line)
      return out
    }
    push('c', line.slice(0, at + close.length))
    i = at + close.length
    st.block = false
  } else if (st.multi >= 0 && spec.multi[st.multi]) {
    const close = spec.multi[st.multi].close
    const at = findClose(line, 0, close)
    if (at === -1) {
      push('s', line)
      return out
    }
    push('s', line.slice(0, at + close.length))
    i = at + close.length
    st.multi = -1
  }

  while (i < n) {
    const c = line[i]

    if (spec.line.some((p) => line.startsWith(p, i))) {
      flush()
      push('c', line.slice(i))
      i = n
      break
    }

    if (spec.block && line.startsWith(spec.block[0], i)) {
      flush()
      const at = line.indexOf(spec.block[1], i + spec.block[0].length)
      if (at === -1) {
        push('c', line.slice(i))
        st.block = true
        i = n
        break
      }
      push('c', line.slice(i, at + spec.block[1].length))
      i = at + spec.block[1].length
      continue
    }

    if (spec.multi.length > 0) {
      const mi = spec.multi.findIndex((m) => line.startsWith(m.open, i))
      if (mi >= 0) {
        flush()
        const m = spec.multi[mi]
        const at = findClose(line, i + m.open.length, m.close)
        if (at === -1) {
          push('s', line.slice(i))
          st.multi = mi
          i = n
          break
        }
        push('s', line.slice(i, at + m.close.length))
        i = at + m.close.length
        continue
      }
    }

    if (spec.quotes.includes(c)) {
      flush()
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === c) {
          j += 1
          break
        }
        j += 1
      }
      j = Math.min(j, n)
      const text = line.slice(i, j)
      push(spec.stringKeys && colonFollows(line, j) ? 'd' : 's', text)
      i = j
      continue
    }

    if (spec.hexNum && c === '#' && /^[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/.test(line.slice(i + 1))) {
      flush()
      let j = i + 1
      while (j < n && /[0-9a-fA-F]/.test(line[j])) j += 1
      push('n', line.slice(i, j))
      i = j
      continue
    }

    if (spec.dollarVar && c === '$') {
      flush()
      let j = i + 1
      if (line[j] === '{') {
        const close = line.indexOf('}', j)
        j = close === -1 ? n : close + 1
      } else {
        while (j < n && /[A-Za-z0-9_]/.test(line[j])) j += 1
        if (j === i + 1) j = Math.min(i + 2, n) // $?, $#, $1 …
      }
      push('t', line.slice(i, j))
      i = j
      continue
    }

    if (spec.atWord && c === '@' && /[A-Za-z]/.test(line[i + 1] ?? '')) {
      flush()
      let j = i + 1
      while (j < n && /[A-Za-z0-9_.-]/.test(line[j])) j += 1
      push('k', line.slice(i, j))
      i = j
      continue
    }

    if (isDigit(c) || (c === '.' && isDigit(line[i + 1] ?? ''))) {
      flush()
      let j = i
      while (j < n && /[0-9a-zA-Z_.]/.test(line[j])) j += 1
      push('n', line.slice(i, j))
      i = j
      continue
    }

    if (isIdentStart(c, spec)) {
      let j = i
      while (j < n && isIdentPart(line[j], spec)) j += 1
      const word = line.slice(i, j)
      let kind: TokKind | null = null
      if (spec.kw.has(word)) kind = 'k'
      else if (spec.types.has(word)) kind = 't'
      else if (spec.propColon && declarationHead(line, i) && colonFollows(line, j)) kind = 'd'
      else if (spec.fnCall && parenFollows(line, j)) kind = 'f'
      else if (spec.upperType && word.length > 1 && /^[A-Z]/.test(word)) kind = 't'
      if (kind === null) plain += word
      else {
        flush()
        push(kind, word)
      }
      i = j
      continue
    }

    if (isPunct(c)) {
      flush()
      push('u', c)
      i += 1
      continue
    }

    plain += c
    i += 1
  }

  flush()
  return out
}

/** Markdown is structural rather than lexical, so it gets its own pass. */
const MD_INLINE =
  /(`[^`]*`)|(!?\[[^\]\n]*\]\([^)\s]*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(https?:\/\/\S+)/g

function scanMarkdown(line: string, st: ScanState, collect: boolean): Tok[] {
  const out: Tok[] = []
  const push = (k: TokKind | null, s: string): void => {
    if (!collect || s === '') return
    const last = out[out.length - 1]
    if (last && last.k === k) last.s += s
    else out.push({ k, s })
  }

  if (/^\s*(```|~~~)/.test(line)) {
    st.fence = !st.fence
    push('u', line)
    return out
  }
  if (st.fence) {
    push('s', line)
    return out
  }
  if (/^\s{0,3}#{1,6}\s/.test(line)) {
    push('k', line)
    return out
  }
  if (/^\s{0,3}>/.test(line)) {
    push('c', line)
    return out
  }
  if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
    push('u', line)
    return out
  }

  let rest = line
  const bullet = /^(\s*(?:[-*+]|\d+\.)\s)/.exec(line)
  if (bullet) {
    push('u', bullet[1])
    rest = line.slice(bullet[1].length)
  }

  let last = 0
  MD_INLINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MD_INLINE.exec(rest)) !== null) {
    if (m.index > last) push(null, rest.slice(last, m.index))
    if (m[1]) push('s', m[1])
    else if (m[2]) push('f', m[2])
    else if (m[3] || m[4]) push('t', m[3] ?? m[4])
    else push('f', m[5])
    last = m.index + m[0].length
  }
  if (last < rest.length) push(null, rest.slice(last))
  return out
}

function findClose(line: string, from: number, close: string): number {
  let i = from
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line.startsWith(close, i)) return i
    i += 1
  }
  return -1
}

function colonFollows(line: string, from: number): boolean {
  let i = from
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1
  return line[i] === ':'
}

function parenFollows(line: string, from: number): boolean {
  return line[from] === '('
}

/** CSS: only an identifier opening a declaration is a property name, so
 *  `a:hover` in a selector does not get painted like one. */
function declarationHead(line: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i -= 1
  return i < 0 || line[i] === '{' || line[i] === ';'
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function isIdentStart(c: string, spec: Lang): boolean {
  return /[A-Za-z_$]/.test(c) || (spec.dashIdent && c === '-')
}

function isIdentPart(c: string, spec: Lang): boolean {
  return /[A-Za-z0-9_$]/.test(c) || (spec.dashIdent && c === '-')
}

function isPunct(c: string): boolean {
  return '{}()[]<>;,.:=+-*/%!&|?^~'.includes(c)
}
