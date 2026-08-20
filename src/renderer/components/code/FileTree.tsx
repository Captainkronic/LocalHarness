/**
 * The workspace explorer.
 *
 * A real tree over the sandbox roots, because the Watch view previously had no
 * way to reach a file the agent had not already touched — you could only read
 * what it chose to show you.
 *
 * Four things shape the implementation:
 *
 *  - Lazy, cached listings. `code:listDir` is one level and sandbox-checked, so
 *    the tree is built one expansion at a time and every listing is kept. The
 *    cache lives at MODULE scope, not in component state: the Watch pane is
 *    mounted and unmounted every time the user flips between Chat and Watch, and
 *    a per-instance cache would re-walk the whole project on every flip and lose
 *    which folders were open. Expansion state lives there for the same reason.
 *
 *  - Flat rows. The tree is rendered as one flat, absolutely-positioned list
 *    with `aria-level` carrying the nesting. That is what makes both keyboard
 *    navigation (an index walk) and windowing (a slice) trivial — a nested DOM
 *    would need neither to be correct, but would need both to be fast.
 *
 *  - Bounded work. A directory is capped at 500 rendered children with an
 *    explicit "N more" row, and only the rows inside the viewport are mounted.
 *    An expanded node_modules must cost the same as an expanded src.
 *
 *  - Honest ignoring. node_modules, .git, dist and friends are dimmed and never
 *    auto-expanded, but they open like anything else. Hiding them outright is a
 *    lie the one time you need to read something in there.
 *
 * Directory listings can go stale — the agent creates files while you browse —
 * so a path appearing in `changed` invalidates its parent's listing, and
 * `clearFileTreeCache()` exists for an explicit reload.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'

import type { DirEntry } from '@shared/types'
import { basename, extname, formatBytes } from '@renderer/lib/format'
import './filetree.css'

export interface FileTreeProps {
  /** Sandbox roots, each rendered as a collapsible top-level node. */
  roots: string[]
  /** The file currently in the viewer, highlighted in the tree. */
  activePath: string | null
  /** A file row was activated (click, Enter, or double-click). */
  onOpen: (path: string) => void
  /** Absolute paths the agent has written or edited this session. */
  changed: ReadonlySet<string>
}

/** Children rendered per directory before the "N more" row takes over. */
const PAGE = 500
/** Row height in px. MUST match --ft-row in filetree.css — the windowing maths
 *  positions every row from it, so a mismatch shears the list. */
const ROW_H = 22
/** Rows mounted above and below the viewport, to cover fast scrolling. */
const OVERSCAN = 8
/** Cached directory listings kept before the oldest is dropped. */
const CACHE_CAP = 400

/**
 * Fallback ignore list. Main already marks `DirEntry.ignored`, and that is what
 * is trusted; this only covers a root whose own basename is one of these, which
 * main never sees because it marks entries, not the directory it listed.
 */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'build',
  'target',
  '.cache'
])

/* ------------------------------------------------------------------ */
/* Module-scope tree state                                             */
/* ------------------------------------------------------------------ */

interface DirState {
  status: 'loading' | 'ready' | 'error'
  entries: DirEntry[]
}

const dirCache = new Map<string, DirState>()
const expanded = new Set<string>()
/** Per-directory render cap, raised by the "N more" row. */
const caps = new Map<string, number>()
/** Roots already opened once, so a root the user closed stays closed. */
const autoExpanded = new Set<string>()
/** Path the tree should scroll to and focus on its next render. */
let revealPath: string | null = null

const listeners = new Set<() => void>()
let version = 0

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getVersion(): number {
  return version
}

function notify(): void {
  version += 1
  for (const fn of [...listeners]) fn()
}

function cachePut(path: string, state: DirState): void {
  if (!dirCache.has(path) && dirCache.size >= CACHE_CAP) {
    const oldest = dirCache.keys().next().value
    if (oldest !== undefined && !expanded.has(oldest)) dirCache.delete(oldest)
  }
  dirCache.set(path, state)
}

/** Drop every listing, so the next render re-reads the disk. Expansion survives. */
export function clearFileTreeCache(): void {
  dirCache.clear()
  notify()
}

/**
 * Open every folder on the way to `path` and scroll to it.
 *
 * `roots` is required rather than derived: expanding a bare ancestor chain would
 * happily walk up past the sandbox and fire a listDir for `/Users` and `/`.
 */
export function revealInTree(path: string, roots: readonly string[]): void {
  const root = rootOf(path, roots)
  if (root === null) return
  expanded.add(root)
  const rel = path.slice(root.length).split('/').filter(Boolean)
  let at = root
  for (const seg of rel) {
    at = `${at}/${seg}`
    expanded.add(at)
  }
  revealPath = path
  notify()
}

/** The longest root that contains `path`, or null when it is outside them all. */
export function rootOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const r of roots) {
    const root = r.endsWith('/') ? r.slice(0, -1) : r
    if (path === root || path.startsWith(`${root}/`)) {
      if (best === null || root.length > best.length) best = root
    }
  }
  return best
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

type RowKind = 'entry' | 'loading' | 'empty' | 'error' | 'more'

interface Row {
  /** Unique within the list; placeholder rows suffix their directory. */
  key: string
  kind: RowKind
  /** Absolute path for entries; the owning directory for placeholders. */
  path: string
  name: string
  depth: number
  isDirectory: boolean
  isRoot: boolean
  ignored: boolean
  open: boolean
  size: number
  /** Hidden children, on a 'more' row. */
  more: number
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) =>
    a.isDirectory === b.isDirectory
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.isDirectory
        ? -1
        : 1
  )
}

function placeholder(kind: RowKind, dir: string, depth: number, more = 0): Row {
  return {
    key: `${dir}::${kind}`,
    kind,
    path: dir,
    name: '',
    depth,
    isDirectory: false,
    isRoot: false,
    ignored: false,
    open: false,
    size: 0,
    more
  }
}

/** Depth-first walk of everything currently open. Reads the module cache, so it
 *  must be re-run whenever `version` moves. */
function buildRows(roots: string[]): Row[] {
  const rows: Row[] = []

  /** `dim` is inherited: everything inside node_modules is also noise, and 500
   *  bright rows under a dimmed parent would say otherwise. */
  const walk = (dir: string, depth: number, dim: boolean): void => {
    const state = dirCache.get(dir)
    if (state === undefined || state.status === 'loading') {
      rows.push(placeholder('loading', dir, depth))
      return
    }
    if (state.status === 'error') {
      rows.push(placeholder('error', dir, depth))
      return
    }
    if (state.entries.length === 0) {
      rows.push(placeholder('empty', dir, depth))
      return
    }
    const cap = caps.get(dir) ?? PAGE
    const shown = state.entries.length > cap ? state.entries.slice(0, cap) : state.entries
    for (const e of shown) {
      const open = e.isDirectory && expanded.has(e.path)
      const ignored = dim || e.ignored || IGNORED.has(e.name)
      rows.push({
        key: e.path,
        kind: 'entry',
        path: e.path,
        name: e.name,
        depth,
        isDirectory: e.isDirectory,
        isRoot: false,
        ignored,
        open,
        size: e.size,
        more: 0
      })
      if (open) walk(e.path, depth + 1, ignored)
    }
    if (state.entries.length > shown.length) {
      rows.push(placeholder('more', dir, depth, state.entries.length - shown.length))
    }
  }

  for (const raw of roots) {
    const root = raw.endsWith('/') ? raw.slice(0, -1) : raw
    const open = expanded.has(root)
    const ignored = IGNORED.has(basename(root))
    rows.push({
      key: root,
      kind: 'entry',
      path: root,
      name: basename(root) || root,
      depth: 0,
      isDirectory: true,
      isRoot: true,
      ignored,
      open,
      size: 0,
      more: 0
    })
    if (open) walk(root, 1, ignored)
  }

  return rows
}

/** Rows the keyboard can land on. Notes ('loading', 'empty', 'error') are not
 *  actionable, so stopping on them would be a dead end. */
function navigable(row: Row): boolean {
  return row.kind === 'entry' || row.kind === 'more'
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function FileTree({
  roots,
  activePath,
  onOpen,
  changed
}: FileTreeProps): JSX.Element {
  const version = useSyncExternalStore(subscribe, getVersion)
  const idBase = useId()
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(320)

  /* ---- open the roots, once each --------------------------------- */

  useEffect(() => {
    let opened = false
    for (const raw of roots) {
      const root = raw.endsWith('/') ? raw.slice(0, -1) : raw
      if (autoExpanded.has(root)) continue
      autoExpanded.add(root)
      expanded.add(root)
      opened = true
    }
    if (opened) notify()
  }, [roots])

  /* ---- load whatever is open and unread --------------------------- */

  useEffect(() => {
    const pending: string[] = []
    for (const dir of expanded) if (!dirCache.has(dir)) pending.push(dir)
    if (pending.length === 0) return
    for (const dir of pending) cachePut(dir, { status: 'loading', entries: [] })
    // The cache is module state, so a listing that lands after this component
    // unmounts is still worth keeping — there is deliberately no cancellation
    // here. `notify` on a listener set we have left is a no-op.
    void Promise.all(
      pending.map(async (dir) => {
        try {
          const entries = await window.harness.invoke('code:listDir', dir)
          cachePut(dir, { status: 'ready', entries: sortEntries(entries) })
        } catch {
          cachePut(dir, { status: 'error', entries: [] })
        }
      })
    ).then(notify)
    // Show the pending rows immediately. This re-runs the effect, which then
    // finds nothing pending and stops.
    notify()
  }, [version])

  /* ---- a written file may be a file we have never listed ---------- */

  useEffect(() => {
    let stale = false
    for (const path of changed) {
      const dir = dirOf(path)
      const state = dirCache.get(dir)
      if (state === undefined || state.status !== 'ready') continue
      if (state.entries.some((e) => e.path === path)) continue
      dirCache.delete(dir)
      stale = true
    }
    if (stale) notify()
  }, [changed])

  const rows = useMemo(() => buildRows(roots), [roots, version])
  const indexOfPath = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((r, i) => {
      if (r.kind === 'entry' && !map.has(r.path)) map.set(r.path, i)
    })
    return map
  }, [rows])

  /** Folders holding something the agent changed, so a collapsed branch still
   *  says there is work inside it. */
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>()
    for (const path of changed) {
      const root = rootOf(path, roots)
      let at = dirOf(path)
      // Bounded by the root, so an unexpected path cannot walk to /.
      while (at.length > 1 && (root === null || at.length >= root.length)) {
        if (dirs.has(at)) break
        dirs.add(at)
        const up = dirOf(at)
        if (up === at) break
        at = up
      }
    }
    return dirs
  }, [changed, roots])

  /* ---- viewport ---------------------------------------------------- */

  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    scrollerRef.current = node
    if (node === null) return
    setViewportH(node.clientHeight || 320)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = scrollerRef.current
      if (el) setViewportH(el.clientHeight)
    })
    ro.observe(node)
    observerRef.current = ro
  }, [])

  useEffect(
    () => () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    },
    []
  )

  const scrollToIndex = useCallback((index: number) => {
    const el = scrollerRef.current
    if (!el || index < 0) return
    const top = index * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight
    }
  }, [])

  /* ---- reveal ------------------------------------------------------ */

  useEffect(() => {
    if (revealPath === null) return
    const index = indexOfPath.get(revealPath)
    // Not there yet: an ancestor listing is still loading, and this effect runs
    // again when it lands.
    if (index === undefined) return
    setFocusPath(revealPath)
    scrollToIndex(index)
    revealPath = null
  }, [indexOfPath, scrollToIndex])

  /* Follow the viewer, but only where the file is already visible — auto-jump
     must never make the tree unfold branches on its own. */
  useEffect(() => {
    if (activePath === null) return
    const index = indexOfPath.get(activePath)
    if (index !== undefined) scrollToIndex(index)
  }, [activePath, indexOfPath, scrollToIndex])

  /* ---- actions ----------------------------------------------------- */

  const toggle = useCallback((path: string) => {
    if (expanded.has(path)) expanded.delete(path)
    else expanded.add(path)
    notify()
  }, [])

  const activate = useCallback(
    (row: Row) => {
      // Clicking a row must hand the tree the keyboard, or the arrow keys do
      // nothing until you happen to Tab into it. Chromium does not focus a
      // tabindex'd ancestor on its own, and the rows themselves are deliberately
      // not tab stops — the tree is one stop with an activedescendant caret.
      canvasRef.current?.focus({ preventScroll: true })
      if (row.kind === 'more') {
        caps.set(row.path, (caps.get(row.path) ?? PAGE) + PAGE)
        notify()
        return
      }
      if (row.kind !== 'entry') return
      setFocusPath(row.path)
      if (row.isDirectory) toggle(row.path)
      else onOpen(row.path)
    },
    [onOpen, toggle]
  )

  const move = useCallback(
    (from: number, step: number) => {
      for (let i = from + step; i >= 0 && i < rows.length; i += step) {
        if (!navigable(rows[i])) continue
        setFocusPath(rows[i].kind === 'more' ? rows[i].key : rows[i].path)
        scrollToIndex(i)
        return
      }
    },
    [rows, scrollToIndex]
  )

  const focusIndex = useMemo(() => {
    if (focusPath === null) return -1
    return rows.findIndex((r) => (r.kind === 'more' ? r.key : r.path) === focusPath)
  }, [rows, focusPath])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return
      const firstNav = rows.findIndex(navigable)
      const i = focusIndex >= 0 ? focusIndex : firstNav
      if (i < 0) return
      const row = rows[i]

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (focusIndex < 0) {
            setFocusPath(row.kind === 'more' ? row.key : row.path)
            scrollToIndex(i)
          } else move(i, 1)
          return
        case 'ArrowUp':
          e.preventDefault()
          move(i, -1)
          return
        case 'ArrowRight':
          e.preventDefault()
          if (row.kind === 'entry' && row.isDirectory && !row.open) toggle(row.path)
          else if (row.kind === 'entry' && row.isDirectory) move(i, 1)
          return
        case 'ArrowLeft': {
          e.preventDefault()
          if (row.kind === 'entry' && row.isDirectory && row.open) {
            toggle(row.path)
            return
          }
          // Up to the parent: the nearest row above with a smaller depth.
          for (let j = i - 1; j >= 0; j--) {
            if (rows[j].kind === 'entry' && rows[j].depth < row.depth) {
              setFocusPath(rows[j].path)
              scrollToIndex(j)
              return
            }
          }
          return
        }
        case 'Home':
          e.preventDefault()
          if (firstNav >= 0) {
            setFocusPath(rows[firstNav].path)
            scrollToIndex(firstNav)
          }
          return
        case 'End': {
          e.preventDefault()
          for (let j = rows.length - 1; j >= 0; j--) {
            if (!navigable(rows[j])) continue
            setFocusPath(rows[j].kind === 'more' ? rows[j].key : rows[j].path)
            scrollToIndex(j)
            return
          }
          return
        }
        case 'Enter':
        case ' ':
          e.preventDefault()
          activate(row)
          return
        default:
          return
      }
    },
    [rows, focusIndex, move, toggle, activate, scrollToIndex]
  )

  /* ---- windowing --------------------------------------------------- */

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)
  const slice = rows.slice(first, last)

  if (roots.length === 0) {
    return (
      <div className="ft">
        <div className="ft-empty">
          <FolderIcon open={false} />
          <p className="ft-empty-head">No workspace roots</p>
          <p>
            The tree can only show directories the agent is allowed to touch. Add a
            root in Settings and it appears here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ft">
      <div
        className="ft-scroll scroll-y"
        ref={attachScroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          className="ft-canvas"
          ref={canvasRef}
          role="tree"
          aria-label="Workspace files"
          tabIndex={0}
          aria-activedescendant={focusIndex >= 0 ? `${idBase}-r${focusIndex}` : undefined}
          onKeyDown={onKeyDown}
          style={{ height: rows.length * ROW_H }}
        >
          {slice.map((row, n) => {
            const index = first + n
            return (
              <TreeRow
                key={row.key}
                id={`${idBase}-r${index}`}
                row={row}
                top={index * ROW_H}
                active={row.kind === 'entry' && row.path === activePath}
                focused={index === focusIndex}
                changed={row.kind === 'entry' && !row.isDirectory && changed.has(row.path)}
                inside={row.kind === 'entry' && row.isDirectory && changedDirs.has(row.path)}
                onActivate={activate}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default FileTree

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

interface TreeRowProps {
  id: string
  row: Row
  top: number
  active: boolean
  focused: boolean
  /** This file was written or edited this session. */
  changed: boolean
  /** This folder contains something that was. */
  inside: boolean
  onActivate: (row: Row) => void
}

function TreeRow({
  id,
  row,
  top,
  active,
  focused,
  changed,
  inside,
  onActivate
}: TreeRowProps): JSX.Element {
  const style = {
    top: `${top}px`,
    paddingLeft: `calc(var(--s2) + ${row.depth} * var(--ft-indent))`
  } as CSSProperties

  if (row.kind === 'loading') {
    return (
      <div className="ft-row ft-note" style={style} role="none">
        <i className="dot dot-busy" aria-hidden="true" />
        <span>reading…</span>
      </div>
    )
  }
  if (row.kind === 'empty') {
    return (
      <div className="ft-row ft-note" style={style} role="none">
        <span>empty</span>
      </div>
    )
  }
  if (row.kind === 'error') {
    return (
      <div className="ft-row ft-note is-error" style={style} role="none">
        <span>cannot be read — outside the sandbox, or gone</span>
      </div>
    )
  }
  if (row.kind === 'more') {
    return (
      <div
        id={id}
        className={focused ? 'ft-row ft-more is-focus' : 'ft-row ft-more'}
        style={style}
        role="button"
        title={`${row.more} more entries in this directory. Click to show another ${PAGE}.`}
        onClick={() => onActivate(row)}
      >
        <span className="tnum">{row.more.toLocaleString()}</span>
        <span>more…</span>
      </div>
    )
  }

  const cls = [
    'ft-row',
    row.isRoot ? 'is-root' : '',
    active ? 'is-active' : '',
    focused ? 'is-focus' : '',
    row.ignored ? 'is-ignored' : '',
    changed ? 'is-changed' : ''
  ]
    .filter((c) => c !== '')
    .join(' ')

  return (
    <div
      id={id}
      className={cls}
      style={style}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.isDirectory ? row.open : undefined}
      aria-selected={active}
      title={tooltip(row, changed)}
      onClick={() => onActivate(row)}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.harness.invoke('files:contextMenu', row.path)
      }}
    >
      {row.isDirectory ? (
        <span className={row.open ? 'ft-twisty is-open' : 'ft-twisty'} aria-hidden="true">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6.5 4l4 4-4 4" />
          </svg>
        </span>
      ) : (
        <span className="ft-twisty" aria-hidden="true" />
      )}

      <span className={`ft-glyph fam-${row.isDirectory ? 'dir' : familyOf(row.name)}`}>
        {row.isDirectory ? <FolderIcon open={row.open} /> : <FileIcon name={row.name} />}
      </span>

      <span className="ft-name">{row.name}</span>

      {changed ? (
        <span className="ft-mark" title="Written or edited this session" />
      ) : inside ? (
        <span className="ft-mark is-inside" title="Contains changes from this session" />
      ) : null}
    </div>
  )
}

function tooltip(row: Row, changed: boolean): string {
  const lines = [row.path]
  if (!row.isDirectory && row.size > 0) lines.push(formatBytes(row.size))
  if (row.ignored) lines.push('Conventionally ignored — open it if you need to.')
  if (changed) lines.push('Written or edited this session.')
  return lines.join('\n')
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : p.slice(0, i)
}

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

export type FileFamily =
  | 'code'
  | 'script'
  | 'data'
  | 'style'
  | 'doc'
  | 'image'
  | 'config'
  | 'plain'

const FAMILY_BY_EXT: Record<string, FileFamily> = {
  ts: 'code',
  tsx: 'code',
  mts: 'code',
  cts: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'script',
  rb: 'script',
  go: 'script',
  rs: 'script',
  java: 'script',
  c: 'script',
  h: 'script',
  cpp: 'script',
  swift: 'script',
  sh: 'script',
  bash: 'script',
  zsh: 'script',
  fish: 'script',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  csv: 'data',
  tsv: 'data',
  parquet: 'data',
  sql: 'data',
  css: 'style',
  scss: 'style',
  less: 'style',
  html: 'style',
  svg: 'image',
  md: 'doc',
  markdown: 'doc',
  txt: 'doc',
  rst: 'doc',
  pdf: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  lock: 'config',
  env: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config'
}

export function familyOf(name: string): FileFamily {
  const ext = extname(name)
  if (ext === '') return name.startsWith('.') ? 'config' : 'plain'
  return FAMILY_BY_EXT[ext] ?? 'plain'
}

function Svg({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return open ? (
    <Svg>
      <path d="M2 12.4V4.2a1 1 0 011-1h3l1.4 1.8h5.2a1 1 0 011 1v1.3" />
      <path d="M3.3 13.2l1.6-4.2a1 1 0 01.94-.65h8.1a1 1 0 01.94 1.35l-1.4 3.7a1 1 0 01-.94.65H3.3z" />
    </Svg>
  ) : (
    <Svg>
      <path d="M2 4.2a1 1 0 011-1h3.1l1.4 1.8h6.5a1 1 0 011 1v6.8a1 1 0 01-1 1H3a1 1 0 01-1-1V4.2z" />
    </Svg>
  )
}

/** A page outline with one distinguishing mark per family — enough to tell a
 *  stylesheet from a script at a glance, with no icon font and no dependency. */
export function FileIcon({ name }: { name: string }): JSX.Element {
  const family = familyOf(name)

  if (family === 'image') {
    return (
      <Svg>
        <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
        <circle cx="5.8" cy="6.4" r="1" />
        <path d="M2.6 11.2l3-2.8 2.4 2.2 2-1.7 3.4 3" />
      </Svg>
    )
  }

  const page = (
    <>
      <path d="M9.2 1.8H4.6A1.6 1.6 0 003 3.4v9.2a1.6 1.6 0 001.6 1.6h6.8a1.6 1.6 0 001.6-1.6V5.6L9.2 1.8z" />
      <path d="M9.2 1.8v3.8H13" />
    </>
  )

  switch (family) {
    case 'code':
      return (
        <Svg>
          {page}
          <path d="M6.6 8.6L5.2 10l1.4 1.4M9.4 8.6L10.8 10l-1.4 1.4" />
        </Svg>
      )
    case 'script':
      return (
        <Svg>
          {page}
          <path d="M5.4 8.8L6.9 10l-1.5 1.2M8.6 11.4h2.4" />
        </Svg>
      )
    case 'data':
      return (
        <Svg>
          {page}
          <path d="M6.7 8.4c-.8 0-.8.7-.8 1.1s-.3.6-.7.6c.4 0 .7.2.7.6s0 1.1.8 1.1" />
          <path d="M9.5 8.4c.8 0 .8.7.8 1.1s.3.6.7.6c-.4 0-.7.2-.7.6s0 1.1-.8 1.1" />
        </Svg>
      )
    case 'style':
      return (
        <Svg>
          {page}
          <path d="M6.6 8.4l-.5 3.2M9.6 8.4l-.5 3.2M5.3 9.4h5M5 11h5" />
        </Svg>
      )
    case 'config':
      return (
        <Svg>
          {page}
          <circle cx="8" cy="10.2" r="1.5" />
          <path d="M8 7.6v.9M8 11.9v.9M5.8 10.2h.9M9.3 10.2h.9" />
        </Svg>
      )
    case 'doc':
      return (
        <Svg>
          {page}
          <path d="M5.4 9h5.2M5.4 11h3.4" />
        </Svg>
      )
    default:
      return <Svg>{page}</Svg>
  }
}
