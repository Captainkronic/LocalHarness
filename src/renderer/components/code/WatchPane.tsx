/**
 * Watch, shaped like an editor.
 *
 * The old Watch view was a tab strip over a viewer: you could read a file only
 * if the agent had touched it, and the viewer got whatever height was left after
 * the chrome — which, as Adam put it, made the preview pane impossible to use.
 *
 * So this is the editor layout, and the priorities are the ones an editor has:
 *
 *   ┌──────────┬───────────────────────────────────────────┐
 *   │          │ tabs                                      │
 *   │   tree   │ breadcrumb                                │
 *   │          │ FileViewer  ← everything left over        │
 *   ├──────────┴───────────────────────────────────────────┤
 *   │ stats + activity ticker (collapsible, resizable)     │
 *   └──────────────────────────────────────────────────────┘
 *
 * Load-bearing decisions:
 *
 *  - The tree is a sidebar, not a column. It starts narrow, it can be dragged,
 *    it collapses to nothing, and the viewer takes every pixel it gives up. Both
 *    splits persist in localStorage and reset on a double-click, because a
 *    layout you have to rebuild every launch is one you stop adjusting.
 *
 *  - Tabs are capped and evicted least-recently-used. The strip is fed from two
 *    places — files the agent touches, and files opened from the tree — and an
 *    uncapped strip in a long session becomes a horizontal scrollbar with the
 *    file you want somewhere inside it.
 *
 *  - Tabs are appended, never re-sorted. Recency reordering makes the tab you
 *    are reaching for slide out from under the cursor whenever the agent touches
 *    something else; the same rule already governs CodeWorkspace's strip.
 *
 *  - Which file is on screen is still CodeWorkspace's decision (`activePath`),
 *    so auto-jump keeps working. This pane only holds a local override for the
 *    instant between clicking a file and the parent agreeing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'

import type { FileActivity } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename } from '@renderer/lib/format'
import type { Tab } from './CodeWorkspace'
import FileViewer from './FileViewer'
import ActivityTicker from './ActivityTicker'
import CodeStats from './CodeStats'
import FileTree, { FileIcon, clearFileTreeCache, familyOf, revealInTree, rootOf } from './FileTree'
import './filetree.css'

export interface WatchPaneProps {
  activities: FileActivity[]
  /** Files the agent has touched this session, newest touch last. */
  tabs: Tab[]
  /** The file the workspace wants on screen. */
  activePath: string | null
  /** Ask the workspace to show a file. */
  onSelect: (p: string) => void
  /** True when the viewer is pinned and no longer follows the agent. */
  pinned: boolean
  onPinnedChange: (p: boolean) => void
}

const K_TREE_W = 'lh.watch.treeWidth'
const K_TREE_OPEN = 'lh.watch.treeOpen'
const K_PANEL_H = 'lh.watch.panelHeight'
const K_PANEL_OPEN = 'lh.watch.panelOpen'

const DEFAULT_TREE_W = 264
const MIN_TREE_W = 168
/** The viewer is the point of this pane; it never gets squeezed below this. */
const MIN_EDITOR_W = 360
const DEFAULT_PANEL_H = 196
const MIN_PANEL_H = 96
const MIN_VIEWER_H = 220
/** Open tabs before the least-recently-used one is closed. */
const MAX_TABS = 12
/** Keyboard nudge for either splitter: one --s4. */
const SPLIT_STEP = 16

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function readNum(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const n = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* A renderer with storage disabled still gets a working layout. */
  }
}

/**
 * Close least-recently-used tabs until the strip fits.
 *
 * `keep` is never a candidate: closing the file the user is looking at because
 * the agent opened a twelfth one would be indefensible.
 */
function evictTabs(
  list: string[],
  keep: string | null,
  usedAt: Map<string, number>
): string[] {
  let next = list
  while (next.length > MAX_TABS) {
    let victim: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const p of next) {
      if (p === keep) continue
      const at = usedAt.get(p) ?? 0
      if (at < oldest) {
        oldest = at
        victim = p
      }
    }
    if (victim === null) break
    next = next.filter((p) => p !== victim)
  }
  return next
}

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

export function WatchPane({
  activities,
  tabs,
  activePath,
  onSelect,
  pinned,
  onPinnedChange
}: WatchPaneProps): JSX.Element {
  const roots = useStore((s) => s.settings.workspaceRoots)
  const phase = useStore((s) => s.live.phase)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const [treeOpen, setTreeOpen] = useState(() => readBool(K_TREE_OPEN, true))
  const [treeW, setTreeW] = useState(() => readNum(K_TREE_W, DEFAULT_TREE_W))
  const [panelOpen, setPanelOpen] = useState(() => readBool(K_PANEL_OPEN, true))
  const [panelH, setPanelH] = useState(() => readNum(K_PANEL_H, DEFAULT_PANEL_H))
  const [dragging, setDragging] = useState<'v' | 'h' | null>(null)
  const [bodyW, setBodyW] = useState(0)
  const [rootH, setRootH] = useState(0)

  /* ---- which file is on screen ------------------------------------ */

  /**
   * The parent owns this. `local` covers exactly one case: the click that opens
   * a file has landed here but the parent's state has not come back yet. Any
   * move by the parent — an auto-jump, a pin — clears it immediately.
   */
  const [local, setLocal] = useState<string | null>(null)
  const lastActive = useRef(activePath)
  useEffect(() => {
    if (activePath !== lastActive.current) {
      lastActive.current = activePath
      setLocal(null)
    }
  }, [activePath])

  /**
   * Files the user has closed.
   *
   * Closing the last tab has to actually empty the pane, and `activePath` is the
   * parent's — there is no way to ask it to point at nothing. So a closed path
   * is ignored here until something re-opens it: a new touch by the agent, or
   * the user picking it out of the tree.
   */
  const closed = useRef(new Set<string>())
  const shownPath =
    local ?? (activePath !== null && closed.current.has(activePath) ? null : activePath)

  const tabIndex = useMemo(() => new Map(tabs.map((t) => [t.path, t])), [tabs])

  /* ---- open tabs --------------------------------------------------- */

  const [order, setOrder] = useState<string[]>([])
  /** path -> the `lastAt` we have already ingested, so a tab the user closed
   *  does not come straight back on the next unrelated render. */
  const ingested = useRef(new Map<string, number>())
  /** path -> when it was last shown, for eviction only. Never for ordering. */
  const usedAt = useRef(new Map<string, number>())

  useEffect(() => {
    // Everything that mutates a ref happens here, never inside the updater —
    // React may invoke an updater more than once, and a second pass over this
    // bookkeeping would decide there was nothing new and discard the first.
    const add: string[] = []
    for (const t of tabs) {
      const seen = ingested.current.get(t.path)
      if (seen !== undefined && t.lastAt <= seen) continue
      ingested.current.set(t.path, t.lastAt)
      usedAt.current.set(t.path, t.lastAt)
      // A fresh touch overrides an earlier close: the agent working in a file is
      // exactly when it should come back.
      closed.current.delete(t.path)
      add.push(t.path)
    }
    if (shownPath !== null) {
      usedAt.current.set(shownPath, Date.now())
      add.push(shownPath)
    }
    if (add.length === 0) return
    setOrder((prev) => {
      let next = prev
      for (const p of add) if (!next.includes(p)) next = [...next, p]
      return next === prev ? prev : evictTabs(next, shownPath, usedAt.current)
    })
  }, [tabs, shownPath])

  const slots = useMemo(
    () => order.map((p) => ({ path: p, name: basename(p), tab: tabIndex.get(p) ?? null })),
    [order, tabIndex]
  )

  /** The file being written right now, if it is one of ours. Tools run one at a
   *  time, so only a trailing 'start' can still be in flight. */
  const liveTarget = useMemo(() => {
    if (phase === 'idle' || activities.length === 0) return null
    const last = activities[activities.length - 1]
    return last.phase === 'start' ? last.target : null
  }, [activities, phase])

  const changedSet = useMemo(() => {
    const out = new Set<string>()
    for (const t of tabs) {
      if (t.lastKind === 'write' || t.lastKind === 'edit' || t.added > 0 || t.removed > 0) {
        out.add(t.path)
      }
    }
    return out
  }, [tabs])

  const openFile = useCallback(
    (path: string) => {
      usedAt.current.set(path, Date.now())
      closed.current.delete(path)
      setOrder((prev) =>
        prev.includes(path) ? prev : evictTabs([...prev, path], path, usedAt.current)
      )
      if (path === shownPath) return
      setLocal(path)
      onSelect(path)
    },
    [onSelect, shownPath]
  )

  /* The heir is the tab to the left, the way an editor does it — closing the
     last one you opened puts you back where you came from. */
  const closeTab = useCallback(
    (path: string) => {
      const at = order.indexOf(path)
      if (at < 0) return
      const next = order.filter((p) => p !== path)
      usedAt.current.delete(path)
      closed.current.add(path)
      setOrder(next)
      if (path !== shownPath) return
      const heir = next[at - 1] ?? next[at] ?? null
      setLocal(heir)
      if (heir !== null) onSelect(heir)
    },
    [order, onSelect, shownPath]
  )

  /* Keep the selected tab reachable — the strip scrolls once it is full. */
  useEffect(() => {
    const strip = stripRef.current
    if (!strip || shownPath === null) return
    const el = strip.querySelector<HTMLElement>('[data-active="true"]')
    if (!el) return
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches
      ? 'auto'
      : 'smooth'
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < strip.scrollLeft) strip.scrollTo({ left: Math.max(0, left - 8), behavior })
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: right - strip.clientWidth + 8, behavior })
    }
  }, [shownPath, order.length])

  /* ---- layout ------------------------------------------------------ */

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setRootH(el.clientHeight)
      setBodyW(bodyRef.current?.clientWidth ?? 0)
    })
    ro.observe(el)
    setRootH(el.clientHeight)
    setBodyW(bodyRef.current?.clientWidth ?? 0)
    return () => ro.disconnect()
  }, [])

  /* Stored width is the preference; this is what the current window allows. The
     two are kept apart so shrinking the window does not overwrite the choice. */
  const maxTreeW =
    bodyW > 0 ? Math.max(MIN_TREE_W, bodyW - MIN_EDITOR_W) : Math.max(MIN_TREE_W, treeW)
  const treeWidth = Math.min(Math.max(treeW, MIN_TREE_W), maxTreeW)
  const maxPanelH =
    rootH > 0 ? Math.max(MIN_PANEL_H, rootH - MIN_VIEWER_H) : Math.max(MIN_PANEL_H, panelH)
  const panelHeight = Math.min(Math.max(panelH, MIN_PANEL_H), maxPanelH)

  useEffect(() => {
    const t = window.setTimeout(() => write(K_TREE_W, String(Math.round(treeW))), 200)
    return () => window.clearTimeout(t)
  }, [treeW])

  useEffect(() => {
    const t = window.setTimeout(() => write(K_PANEL_H, String(Math.round(panelH))), 200)
    return () => window.clearTimeout(t)
  }, [panelH])

  useEffect(() => {
    write(K_TREE_OPEN, String(treeOpen))
  }, [treeOpen])

  useEffect(() => {
    write(K_PANEL_OPEN, String(panelOpen))
  }, [panelOpen])

  const startDrag =
    (axis: 'v' | 'h') =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      setDragging(axis)
    }

  /**
   * The drag lives on the window, not on the splitter.
   *
   * Pointer capture on the handle looks equivalent and is not: lose the pointer
   * — released off-window, cancelled by the OS, capture dropped when the element
   * re-renders — and the `pointerup` never arrives, `dragging` stays set, and
   * `.is-dragging` leaves the entire pane with `pointer-events: none`. The pane
   * is then dead to the mouse with nothing on screen to say why. Window
   * listeners plus a `blur` guard cannot get stuck that way.
   */
  useEffect(() => {
    if (dragging === null) return
    const onMove = (e: PointerEvent): void => {
      if (dragging === 'v') {
        const box = bodyRef.current?.getBoundingClientRect()
        if (box) {
          setTreeW(Math.round(Math.min(Math.max(e.clientX - box.left, MIN_TREE_W), maxTreeW)))
        }
      } else {
        const box = rootRef.current?.getBoundingClientRect()
        if (box) {
          setPanelH(
            Math.round(Math.min(Math.max(box.bottom - e.clientY, MIN_PANEL_H), maxPanelH))
          )
        }
      }
    }
    const stop = (): void => setDragging(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
  }, [dragging, maxTreeW, maxPanelH])

  const splitKeys =
    (axis: 'v' | 'h') =>
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const set = axis === 'v' ? setTreeW : setPanelH
      const lo = axis === 'v' ? MIN_TREE_W : MIN_PANEL_H
      const hi = axis === 'v' ? maxTreeW : maxPanelH
      const dec = axis === 'v' ? 'ArrowLeft' : 'ArrowDown'
      const inc = axis === 'v' ? 'ArrowRight' : 'ArrowUp'
      if (e.key === dec || e.key === inc) {
        e.preventDefault()
        const step = e.key === inc ? SPLIT_STEP : -SPLIT_STEP
        set((prev) => Math.min(Math.max(prev + step, lo), hi))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        set(axis === 'v' ? DEFAULT_TREE_W : DEFAULT_PANEL_H)
      }
    }

  /* ---- render ------------------------------------------------------ */

  const shownTab = shownPath === null ? null : (tabIndex.get(shownPath) ?? null)
  const crumbs = useMemo(
    () => (shownPath === null ? [] : crumbsFor(shownPath, roots)),
    [shownPath, roots]
  )

  const revealCrumb = (path: string): void => {
    setTreeOpen(true)
    revealInTree(path, roots)
  }

  return (
    <div className={dragging ? `wp is-dragging is-${dragging}` : 'wp'} ref={rootRef}>
      <div className="wp-body" ref={bodyRef}>
        {treeOpen ? (
          <>
            <aside className="wp-side" style={{ width: `${treeWidth}px` }}>
              <header className="wp-side-head">
                <span className="section-label">Explorer</span>
                <button
                  type="button"
                  className="wp-icon"
                  title="Re-read every open folder from disk"
                  onClick={() => clearFileTreeCache()}
                >
                  <RefreshIcon />
                </button>
                <button
                  type="button"
                  className="wp-icon"
                  title="Hide the tree and give the whole width to the file"
                  onClick={() => setTreeOpen(false)}
                >
                  <SidebarIcon open />
                </button>
              </header>
              <FileTree
                roots={roots}
                activePath={shownPath}
                onOpen={openFile}
                changed={changedSet}
              />
            </aside>

            <div
              className="wp-split wp-split-v"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file tree"
              aria-valuenow={Math.round(treeWidth)}
              aria-valuemin={MIN_TREE_W}
              aria-valuemax={Math.round(maxTreeW)}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={startDrag('v')}
              onDoubleClick={() => setTreeW(DEFAULT_TREE_W)}
              onKeyDown={splitKeys('v')}
            />
          </>
        ) : null}

        <section className="wp-editor">
          {slots.length > 0 ? (
            <div className="wp-tabs" role="tablist" aria-label="Open files" ref={stripRef}>
              {slots.map((slot) => {
                const isActive = slot.path === shownPath
                const t = slot.tab
                return (
                  <div
                    key={slot.path}
                    className={
                      'wp-tab' +
                      (isActive ? ' is-active' : '') +
                      (slot.path === liveTarget ? ' is-live' : '') +
                      (t?.failed ? ' is-failed' : '')
                    }
                    data-active={isActive}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className="wp-tab-btn"
                      title={`${slot.path}${
                        t ? `\n${t.touches} touch${t.touches === 1 ? '' : 'es'}` : ''
                      }`}
                      onClick={() => openFile(slot.path)}
                    >
                      <span className={`wp-tab-glyph fam-${familyOf(slot.name)}`}>
                        <FileIcon name={slot.name} />
                      </span>
                      <span className="wp-tab-name">{slot.name}</span>
                      {t && (t.added > 0 || t.removed > 0) ? (
                        <span className="wp-tab-stat tnum">
                          <span className="wp-add">+{t.added}</span>
                          <span className="wp-del">-{t.removed}</span>
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="wp-tab-close"
                      aria-label={`Close ${slot.name}`}
                      title={`Close ${slot.name}`}
                      onClick={() => closeTab(slot.path)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : null}

          <div className="wp-crumbs">
            {treeOpen ? null : (
              <button
                type="button"
                className="wp-icon"
                title="Show the file tree"
                onClick={() => setTreeOpen(true)}
              >
                <SidebarIcon open={false} />
              </button>
            )}

            {crumbs.length > 0 ? (
              <nav className="wp-crumb-list" aria-label="File path">
                {crumbs.map((c, i) => (
                  <span className="wp-crumb-seg" key={c.path}>
                    {i > 0 ? (
                      <span className="wp-crumb-sep" aria-hidden="true">
                        ›
                      </span>
                    ) : null}
                    {c.isDir ? (
                      <button
                        type="button"
                        className="wp-crumb"
                        title={`Reveal ${c.path} in the tree`}
                        onClick={() => revealCrumb(c.path)}
                      >
                        {c.name}
                      </button>
                    ) : (
                      <span className="wp-crumb is-file">{c.name}</span>
                    )}
                  </span>
                ))}
              </nav>
            ) : (
              <span className="wp-crumb-none">No file open</span>
            )}

            <button
              type="button"
              className={pinned ? 'wp-follow is-pinned' : 'wp-follow'}
              aria-pressed={pinned}
              title={
                pinned
                  ? 'Pinned: the viewer stays on this file while the agent works elsewhere. Click to follow again.'
                  : 'Following the agent: the viewer jumps to each file as it is written. Click to pin this one.'
              }
              onClick={() => onPinnedChange(!pinned)}
            >
              {pinned ? <PinIcon /> : <FollowIcon />}
              <span>{pinned ? 'Pinned' : 'Following'}</span>
            </button>
          </div>

          <div className="wp-view">
            {shownPath === null ? (
              <Idle roots={roots} treeOpen={treeOpen} onShowTree={() => setTreeOpen(true)} />
            ) : (
              <FileViewer
                path={shownPath}
                activity={shownTab?.latest ?? null}
                following={!pinned}
              />
            )}
          </div>
        </section>
      </div>

      {panelOpen ? (
        <div
          className="wp-split wp-split-h"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the activity panel"
          aria-valuenow={Math.round(panelHeight)}
          aria-valuemin={MIN_PANEL_H}
          aria-valuemax={Math.round(maxPanelH)}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startDrag('h')}
          onDoubleClick={() => setPanelH(DEFAULT_PANEL_H)}
          onKeyDown={splitKeys('h')}
        />
      ) : null}

      <section
        className="wp-panel"
        data-open={panelOpen}
        style={panelOpen ? { height: `${panelHeight}px` } : undefined}
      >
        <header className="wp-panel-head">
          <button
            type="button"
            className="wp-panel-toggle"
            aria-expanded={panelOpen}
            title={panelOpen ? 'Collapse the activity panel' : 'Expand the activity panel'}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <span className={panelOpen ? 'wp-chev is-open' : 'wp-chev'} aria-hidden="true">
              <ChevronIcon />
            </span>
            <span className="section-label">Activity</span>
          </button>
          <CodeStats activities={activities} />
        </header>
        {panelOpen ? (
          <div className="wp-panel-body">
            <ActivityTicker activities={activities} onSelect={openFile} max={200} />
          </div>
        ) : null}
      </section>
    </div>
  )
}

export default WatchPane

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Idle({
  roots,
  treeOpen,
  onShowTree
}: {
  roots: string[]
  treeOpen: boolean
  onShowTree: () => void
}): JSX.Element {
  return (
    <div className="wp-idle">
      <p className="wp-idle-title">
        Standing by<span className="wp-caret" aria-hidden="true" />
      </p>
      <p className="wp-idle-body">
        Every file the agent reads, writes or edits opens here as it happens, with the
        changed lines marked. Pick anything from the tree to read it yourself.
      </p>
      {roots.length === 0 ? (
        <p className="wp-idle-warn">
          No workspace roots are configured, so every file tool and every shell command
          will be refused before it is offered for approval. Add a root in Settings.
        </p>
      ) : (
        <p className="wp-idle-roots tnum">
          {roots.length} sandbox root{roots.length === 1 ? '' : 's'} ·{' '}
          {roots.map((r) => basename(r)).join(' · ')}
        </p>
      )}
      {treeOpen ? null : (
        <button type="button" className="btn btn-sm" onClick={onShowTree}>
          Show the file tree
        </button>
      )}
    </div>
  )
}

interface Crumb {
  name: string
  path: string
  isDir: boolean
}

/** The path relative to its root, root first. A path outside every root — which
 *  the viewer can still be pointed at by an activity — degrades to its own
 *  segments rather than pretending it belongs somewhere. */
export function crumbsFor(path: string, roots: readonly string[]): Crumb[] {
  const root = rootOf(path, roots)
  if (root === null) {
    const segs = path.split('/').filter(Boolean)
    return segs.map((name, i) => ({
      name,
      path: `/${segs.slice(0, i + 1).join('/')}`,
      isDir: i < segs.length - 1
    }))
  }
  const rel = path.slice(root.length).split('/').filter(Boolean)
  const out: Crumb[] = [{ name: basename(root) || root, path: root, isDir: true }]
  let at = root
  rel.forEach((name, i) => {
    at = `${at}/${name}`
    out.push({ name, path: at, isDir: i < rel.length - 1 })
  })
  return out
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

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

function SidebarIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M6.4 3v10" />
      {open ? <path d="M11.6 6.6L10 8l1.6 1.4" /> : <path d="M8.6 6.6L10.2 8l-1.6 1.4" />}
    </Svg>
  )
}

function RefreshIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13.4 2.4v2.9h-2.9" />
    </Svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" />
    </Svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  )
}

function PinIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M6.2 1.8h3.6v4l1.8 2.4h-7.2l1.8-2.4v-4z" />
      <path d="M8 8.2v6" />
    </Svg>
  )
}

function FollowIcon(): JSX.Element {
  return (
    <Svg>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2" />
    </Svg>
  )
}
