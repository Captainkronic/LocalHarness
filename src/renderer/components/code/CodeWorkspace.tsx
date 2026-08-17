/**
 * The Code workflow's centre column.
 *
 * The transcript tells you what the agent said it would do. This tells you what
 * it is doing to the disk, while it does it: a strip of every file touched this
 * session, the file currently under the cursor, and a ticker of every effect
 * underneath.
 *
 * Two behaviours carry the whole thing:
 *
 *  - Auto-jump. A new write or edit pulls the viewer to that file and scrolls
 *    to the first changed line. It is debounced, so a burst of edits across
 *    several files resolves to one switch rather than a slideshow, and the tab
 *    it lands on takes a short sweep so the move is explained rather than
 *    merely happening.
 *  - Pinning. Clicking a tab stops the jumping so the user can read. Following
 *    and pinned are never ambiguous — the toggle at the end of the strip always
 *    says which one is in force, and clicking it resumes following.
 *
 * The activity stream carries operations with no file behind them — shell
 * commands, greps, globs. Those live in the ticker, which is the only place
 * they can honestly be shown.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { FileActivity, FileOpKind } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename, clockTime, formatMs, shortenPath } from '@renderer/lib/format'
import ChatView from '@renderer/components/chat/ChatView'
import FileViewer from './FileViewer'
import ActivityTicker from './ActivityTicker'
import CodeStats from './CodeStats'
import './code.css'
import './ticker.css'

/** How long a burst of cross-file edits has to settle before the viewer moves. */
const JUMP_DEBOUNCE_MS = 260
/** How long the sweep stays on a newly focused tab. */
const SWEEP_MS = 900

export interface Tab {
  path: string
  displayPath: string
  name: string
  lastKind: FileOpKind
  added: number
  removed: number
  touches: number
  lastAt: number
  /** Newest write/edit that produced content the viewer can show. */
  latest: FileActivity | null
  failed: boolean
}

export function CodeWorkspace(): JSX.Element {
  const activityAll = useStore((s) => s.fileActivity)
  const conversationId = useStore((s) => s.activeConversationId)
  const phase = useStore((s) => s.live.phase)
  const roots = useStore((s) => s.settings.workspaceRoots)

  /**
   * Chat or Watch.
   *
   * This started as Watch-only, which shipped a Code workflow with NO WAY TO
   * TYPE — the composer lives in ChatView, and this column replaced it instead
   * of complementing it. Chat is the default because a conversation is how work
   * starts; the first file activity flips to Watch once, and after that the
   * choice is the user's.
   */
  const [mode, setMode] = useState<'chat' | 'watch'>('chat')
  const autoSwitched = useRef(false)
  const [pinnedPath, setPinnedPath] = useState<string | null>(null)
  const [autoPath, setAutoPath] = useState<string | null>(null)
  const [sweep, setSweep] = useState<{ path: string; gen: number } | null>(null)
  const [tickerOpen, setTickerOpen] = useState(true)
  const sweepGen = useRef(0)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const mountedAt = useRef(Date.now())

  /* The store is app-wide; the workspace is per conversation. */
  const activities = useMemo(
    () =>
      conversationId
        ? activityAll.filter((a) => a.conversationId === conversationId)
        : activityAll,
    [activityAll, conversationId]
  )

  /* One row per operation: a 'done' replaces the 'start' it belongs to rather
     than stacking a second row underneath it. */
  const rows = useMemo(() => reconcile(activities), [activities])

  /* Tools run one at a time, so only the last row can still be in flight — and
     only while the turn is actually running. Anything else claiming to be
     'start' was abandoned (a denied write never emits its 'done'). */
  const liveRow =
    phase !== 'idle' && rows.length > 0 && rows[rows.length - 1].phase === 'start'
      ? rows[rows.length - 1]
      : null

  const tabs = useMemo(() => buildTabs(rows), [rows])
  const tabIndex = useMemo(() => new Map(tabs.map((t) => [t.path, t])), [tabs])
  /** Identity of the strip's order, for effects that must re-run when it moves. */
  const tabOrder = useMemo(() => tabs.map((t) => t.path).join('\0'), [tabs])

  /* What auto-jump follows: the newest change with a file behind it. A write
     that has only started still counts — being taken to the file as it opens is
     the point — but only when there is already something to render there, so
     the viewer never lands on "cannot read" for a file about to be created. */
  const jump = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const a = rows[i]
      if (a.kind !== 'write' && a.kind !== 'edit') continue
      if (a.phase === 'done') return a
      if (a.phase === 'start') return tabIndex.get(a.target)?.latest ? a : null
      return null
    }
    return null
  }, [rows, tabIndex])
  const jumpId = jump?.id ?? null

  const activePath = pinnedPath ?? autoPath ?? tabs[0]?.path ?? null
  const activeTab = activePath ? (tabIndex.get(activePath) ?? null) : null

  /* Flip to Watch the first time the agent actually touches a file, so the work
     is visible without being asked for — but only once. After that, whichever
     view the user chose is the one they keep. */
  useEffect(() => {
    if (autoSwitched.current || tabs.length === 0) return
    autoSwitched.current = true
    setMode('watch')
  }, [tabs.length])

  /* ---- auto-jump ----------------------------------------------------- */

  useEffect(() => {
    if (!jump || pinnedPath) return
    // Work that predates this view is history. Opening the workspace on an old
    // conversation shows the last file touched — it does not jump to it.
    if (jump.at < mountedAt.current) return
    if (jump.target === autoPath) return
    const target = jump.target
    const timer = window.setTimeout(() => setAutoPath(target), JUMP_DEBOUNCE_MS)
    // A newer activity re-runs this effect and cancels the pending move, so a
    // burst coalesces into a single switch.
    return () => window.clearTimeout(timer)
  }, [jumpId, jump, pinnedPath, autoPath])

  /* The sweep marks a move the user did not ask for. Clicking a tab needs no
     explanation, so it gets none. */
  useEffect(() => {
    if (!autoPath || pinnedPath) return
    sweepGen.current += 1
    setSweep({ path: autoPath, gen: sweepGen.current })
    const timer = window.setTimeout(() => setSweep(null), SWEEP_MS)
    return () => window.clearTimeout(timer)
  }, [autoPath, pinnedPath])

  /* A tab strip long enough to scroll can leave the file you were just moved to
     off-screen, sweep and all. Keep the active tab in view. */
  useEffect(() => {
    const strip = stripRef.current
    if (!strip || !activePath) return
    const el = strip.querySelector<HTMLElement>('[data-active="true"]')
    if (!el) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches
      ? 'auto'
      : 'smooth'
    if (left < strip.scrollLeft) strip.scrollTo({ left: Math.max(0, left - 8), behavior })
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollTo({ left: right - strip.clientWidth + 8, behavior })
    // Keyed on the ORDER, not the count. Tabs are stable now, but a count-only
    // dependency would still miss a new file arriving after one was replaced.
  }, [activePath, tabOrder])

  const totals = useMemo(
    () =>
      tabs.reduce(
        (acc, t) => ({ added: acc.added + t.added, removed: acc.removed + t.removed }),
        { added: 0, removed: 0 }
      ),
    [tabs]
  )

  const pinTab = (path: string): void => {
    // Clicking the pinned tab again hands control back to the agent.
    setPinnedPath((prev) => (prev === path ? null : path))
    if (pinnedPath === path) setAutoPath(path)
  }

  const resumeFollowing = (): void => {
    setPinnedPath(null)
    setAutoPath(jump?.target ?? tabs[0]?.path ?? null)
  }

  if (mode === 'chat') {
    return (
      <div className="cw cw-chat">
        <ModeBar
          mode={mode}
          onMode={setMode}
          files={tabs.length}
          added={totals.added}
          removed={totals.removed}
        />
        <div className="cw-chat-body">
          <ChatView />
        </div>
      </div>
    )
  }

  return (
    <div className="cw">
      <ModeBar
        mode={mode}
        onMode={setMode}
        files={tabs.length}
        added={totals.added}
        removed={totals.removed}
      />
      {tabs.length > 0 ? (
        <div className="cw-tabs">
          <div
            className="cw-tabstrip"
            role="tablist"
            aria-label="Touched files"
            ref={stripRef}
          >
            {tabs.map((t) => {
              const isActive = t.path === activePath
              // Narrowed here rather than inline, so the glyph can follow the
              // in-flight operation without a non-null assertion.
              const liveKind = liveRow && liveRow.target === t.path ? liveRow.kind : null
              const isLive = liveKind !== null
              return (
                <button
                  key={t.path}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-active={isActive}
                  className={
                    'cw-tab' +
                    (isActive ? ' is-active' : '') +
                    (isLive ? ' is-live' : '') +
                    (t.failed ? ' is-failed' : '') +
                    (pinnedPath === t.path ? ' is-pinned' : '')
                  }
                  title={`${t.path}\n${t.touches} touch${t.touches === 1 ? '' : 'es'} · ${
                    pinnedPath === t.path ? 'click to unpin' : 'click to pin'
                  }`}
                  onClick={() => pinTab(t.path)}
                >
                  <KindIcon kind={liveKind ?? t.lastKind} />
                  <span className="cw-tab-name">{t.name}</span>
                  {t.added > 0 || t.removed > 0 ? (
                    <span className="cw-tab-stat tnum">
                      <span className="cw-stat-add">+{t.added}</span>
                      <span className="cw-stat-del">-{t.removed}</span>
                    </span>
                  ) : null}
                  {pinnedPath === t.path ? <PinIcon /> : null}
                  {sweep && sweep.path === t.path ? (
                    <span key={sweep.gen} className="cw-tab-sweep" aria-hidden="true" />
                  ) : null}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className={pinnedPath ? 'cw-follow is-pinned' : 'cw-follow'}
            onClick={
              pinnedPath
                ? resumeFollowing
                : activePath
                  ? () => setPinnedPath(activePath)
                  : undefined
            }
            aria-pressed={pinnedPath !== null}
            title={
              pinnedPath
                ? `Pinned to ${basename(pinnedPath)}. The viewer stays here while the agent works elsewhere. Click to follow again.`
                : 'Following the agent: the viewer jumps to each file as it is written. Click to pin this one.'
            }
          >
            {pinnedPath ? <PinIcon /> : <FollowIcon />}
            <span>{pinnedPath ? 'Pinned' : 'Following'}</span>
          </button>
        </div>
      ) : null}

      <div className="cw-main">
        {activities.length === 0 ? (
          <div className="cw-idle">
            <p className="cw-idle-title">
              Standing by<span className="cw-caret" aria-hidden="true" />
            </p>
            <p className="cw-idle-body">
              Every file the agent reads, writes or edits opens here as it happens,
              with the changed lines marked. Shell commands and searches run past in
              the ticker below.
            </p>
            {roots.length === 0 ? (
              <p className="cw-idle-warn">
                No workspace roots are configured, so every file tool and every shell
                command will be refused before it is offered for approval. Add a root
                in Settings.
              </p>
            ) : (
              <p className="cw-idle-roots tnum">
                {roots.length} sandbox root{roots.length === 1 ? '' : 's'} ·{' '}
                {roots.map((r) => basename(r)).join(' · ')}
              </p>
            )}
          </div>
        ) : (
          <FileViewer
            path={activePath}
            activity={activeTab?.latest ?? null}
            following={pinnedPath === null}
          />
        )}
      </div>

      {/* The real ActivityTicker, not the inline one this file used to carry:
          it freezes its window when the reader scrolls up and counts arrivals
          instead of letting the rows they are reading fall off the head, and
          its file rows open in the viewer. */}
      <section className="cw-ticker-dock" data-open={tickerOpen}>
        <header className="cw-tick-head">
          <button
            type="button"
            className="cw-tick-toggle"
            onClick={() => setTickerOpen((v) => !v)}
            aria-expanded={tickerOpen}
          >
            <span className={tickerOpen ? 'cw-chev is-open' : 'cw-chev'} aria-hidden="true">
              ›
            </span>
            <span className="section-label">Activity</span>
          </button>
          <CodeStats activities={activities} />
        </header>
        {tickerOpen ? (
          <ActivityTicker activities={activities} onSelect={setPinnedPath} max={200} />
        ) : null}
      </section>
    </div>
  )
}

export default CodeWorkspace

/**
 * Approval mode, where the approving happens. Buried in Settings it was
 * effectively undiscoverable mid-task, which is exactly when it is wanted.
 */
function AutoApprove(): JSX.Element {
  const mode = useStore((s) => s.settings.approvalMode)
  const updateSettings = useStore((s) => s.updateSettings)
  const auto = mode === 'auto_all'
  return (
    <button
      type="button"
      className={auto ? 'cw-auto is-on' : 'cw-auto'}
      role="switch"
      aria-checked={auto}
      title={
        auto
          ? 'Auto: every file write and shell command runs without asking. Click to require approval again.'
          : 'Ask: every write and shell command needs your approval first. Click to run them automatically.'
      }
      onClick={() => {
        void updateSettings({ approvalMode: auto ? 'always_ask' : 'auto_all' })
      }}
    >
      <span className={auto ? 'dot dot-warn' : 'dot dot-ok'} />
      {auto ? 'Auto-approve' : 'Ask first'}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Mode bar                                                            */
/* ------------------------------------------------------------------ */

/** Chat is where you talk to the agent; Watch is where you see what it did.
 *  Always visible, so neither half of the workflow can be lost. */
function ModeBar(props: {
  mode: 'chat' | 'watch'
  onMode: (m: 'chat' | 'watch') => void
  files: number
  added: number
  removed: number
}): JSX.Element {
  const { mode, onMode, files, added, removed } = props
  return (
    <div className="cw-modebar">
      <div className="cw-segmented" role="tablist" aria-label="Code view">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'chat'}
          className={mode === 'chat' ? 'cw-seg is-on' : 'cw-seg'}
          onClick={() => onMode('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'watch'}
          className={mode === 'watch' ? 'cw-seg is-on' : 'cw-seg'}
          onClick={() => onMode('watch')}
        >
          Watch
          {files > 0 ? <span className="cw-seg-badge tnum">{files}</span> : null}
        </button>
      </div>
      <AutoApprove />
      {files > 0 ? (
        <span className="cw-modebar-stat tnum">
          <span className="cw-add">+{added}</span> <span className="cw-del">−{removed}</span>{' '}
          across {files} file{files === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  )
}


/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Collapse the raw stream into one row per operation.
 *
 * Most tools emit start and done under the same id. write_file and edit_file do
 * not — their rich 'done' is emitted from inside the tool with a fresh id — so
 * a done is also matched back to a pending start by kind and target.
 */
export function reconcile(activities: FileActivity[]): FileActivity[] {
  const rows: FileActivity[] = []
  const byId = new Map<string, number>()
  const pending = new Map<string, number>()

  for (const a of activities) {
    const key = `${a.kind}|${a.target}`
    if (a.phase === 'start') {
      byId.set(a.id, rows.length)
      pending.set(key, rows.length)
      rows.push(a)
      continue
    }
    const at = byId.get(a.id) ?? pending.get(key)
    if (at === undefined) {
      rows.push(a)
      continue
    }
    rows[at] = a
    byId.delete(a.id)
    pending.delete(key)
  }
  return rows
}

function isFileKind(kind: FileOpKind): boolean {
  return kind === 'read' || kind === 'write' || kind === 'edit'
}

/** One tab per file, newest touch first, with the change stat accumulated. */
export function buildTabs(rows: FileActivity[]): Tab[] {
  const byPath = new Map<string, Tab>()

  for (const a of rows) {
    if (!isFileKind(a.kind)) continue
    const prev = byPath.get(a.target)
    const tab: Tab = prev ?? {
      path: a.target,
      displayPath: a.displayPath,
      name: basename(a.target),
      lastKind: a.kind,
      added: 0,
      removed: 0,
      touches: 0,
      lastAt: 0,
      latest: null,
      failed: false
    }
    tab.displayPath = a.displayPath
    tab.lastKind = a.kind
    tab.lastAt = Math.max(tab.lastAt, a.at)
    if (a.phase === 'done') {
      tab.touches += 1
      tab.added += a.added ?? 0
      tab.removed += a.removed ?? 0
      tab.failed = false
      // A read has no diff and no content; it must not displace the last write,
      // or opening the file would lose the change markers.
      if (a.kind === 'write' || a.kind === 'edit') tab.latest = a
      else if (tab.latest === null) tab.latest = a
    } else if (a.phase === 'error') {
      tab.failed = true
    }
    byPath.set(a.target, tab)
  }

  // FIRST-TOUCH order, deliberately not recency. Re-sorting on every activity
  // made each tab a moving target: the one you were reaching for slid sideways
  // whenever the agent touched a different file. Recency is already carried by
  // the sweep and the is-live styling, which do not move anything.
  return [...byPath.values()]
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

function Svg({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      className="cw-icon"
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

function KindIcon({ kind }: { kind: FileOpKind }): JSX.Element {
  switch (kind) {
    case 'read':
      return (
        <Svg>
          <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="1.7" />
        </Svg>
      )
    case 'write':
      return (
        <Svg>
          <path d="M9 1.8H4.6A1.6 1.6 0 003 3.4v9.2a1.6 1.6 0 001.6 1.6h6.8a1.6 1.6 0 001.6-1.6V5.8L9 1.8z" />
          <path d="M9 1.8v4h4" />
        </Svg>
      )
    case 'edit':
      return (
        <Svg>
          <path d="M11.4 2.3l2.3 2.3-7.4 7.4-3 .7.7-3 7.4-7.4z" />
          <path d="M2.5 14h11" />
        </Svg>
      )
    case 'list':
      return (
        <Svg>
          <path d="M1.8 4.2a1 1 0 011-1h3.1l1.4 1.9h5.9a1 1 0 011 1v5.7a1 1 0 01-1 1h-10.4a1 1 0 01-1-1V4.2z" />
        </Svg>
      )
    case 'glob':
      return (
        <Svg>
          <path d="M8 2.2v11.6M3 5.1l10 5.8M13 5.1L3 10.9" />
        </Svg>
      )
    case 'grep':
      return (
        <Svg>
          <circle cx="7" cy="7" r="4.3" />
          <path d="M10.2 10.2L14 14" />
        </Svg>
      )
    case 'shell':
    default:
      return (
        <Svg>
          <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.4" />
          <path d="M4.6 6.2L6.9 8l-2.3 1.8M8.6 10.2h3" />
        </Svg>
      )
  }
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

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={open ? 'cw-chev is-open' : 'cw-chev'}
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
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}
