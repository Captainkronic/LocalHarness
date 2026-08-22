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
import { basename } from '@renderer/lib/format'
import { buildTabs, type Tab } from '@renderer/lib/tabs'
import ChatView from '@renderer/components/chat/ChatView'
import WatchPane from './WatchPane'
import BrowserPane from './BrowserPane'
import './code.css'
import './ticker.css'

const MODE_KEY = 'captainllama.code.mode'

/** LH_CODE_MODE lets the screenshot driver photograph either half. */
function readStoredMode(): 'chat' | 'watch' | 'browser' {
  const forced = document.documentElement.dataset.codeMode
  if (forced === 'watch' || forced === 'chat') return forced
  try {
    const v = window.localStorage.getItem(MODE_KEY)
    return v === 'watch' ? 'watch' : 'chat'
  } catch {
    return 'chat'
  }
}

/** How long a burst of cross-file edits has to settle before the viewer moves. */
const JUMP_DEBOUNCE_MS = 260
/** How long the sweep stays on a newly focused tab. */
const SWEEP_MS = 900


export function CodeWorkspace(): JSX.Element {
  const activityAll = useStore((s) => s.fileActivity)
  const conversation = useStore((s) => s.conversation)
  const mirrorLive = useStore((s) => s.browserMirror) === 'live'
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
  const [mode, setMode] = useState<'chat' | 'watch' | 'browser'>(() => readStoredMode())

  // Remember which half you were last in. Being dropped back into Chat every
  // launch is the sort of small forgetfulness that makes a tool feel careless.
  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, mode)
    } catch {
      // Private mode or a full quota: the preference is not worth an error.
    }
  }, [mode])
  const [pinnedPath, setPinnedPath] = useState<string | null>(null)
  const [autoPath, setAutoPath] = useState<string | null>(null)
  const [sweep, setSweep] = useState<{ path: string; gen: number } | null>(null)
  const sweepGen = useRef(0)
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
  /* Files actually modified. The strip holds a tab for everything touched,
     including reads and denied writes; a change summary must count changes. */
  const changedFileCount = useMemo(() => tabs.filter((t) => t.changed).length, [tabs])
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

  /* Deliberately no auto-switch to Watch.
     It used to flip the first time the agent touched a file, on the theory that
     the work should be visible without being asked for. In practice it moves
     you off the conversation mid-turn — and the conversation is where the model
     explains itself, where reasoning progress shows, and where you type the
     next thing. The Watch tab carries a file count, which is enough of an
     invitation; the choice stays the user's. */

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

  /* Frames the model was shown this conversation. Counted here rather than in
     BrowserPane so the tab can carry the number without mounting the pane. */
  const frameCount = useMemo(() => {
    let n = 0
    for (const m of conversation?.messages ?? []) {
      for (const call of m.toolCalls ?? []) {
        const sc = call.structured as { screenshot?: unknown } | undefined
        if (call.status === 'ok' && sc && typeof sc.screenshot === 'string') n += 1
      }
    }
    return n
  }, [conversation])

  /**
   * Is a browser tool running RIGHT NOW.
   *
   * Phase plus the most recent tool, rather than a per-call `pending` status.
   * Status was the obvious signal and proved unreliable to observe: a call that
   * finishes quickly can be created and completed between two renders, so the
   * tab never learned it had been busy. `phase` stays 'tool' for as long as the
   * tool is actually running, which is the thing being asked about.
   */
  const lastToolName = useMemo(() => {
    const messages = conversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const calls = messages[i].toolCalls ?? []
      if (calls.length > 0) return calls[calls.length - 1].name
    }
    return ''
  }, [conversation])

  const browserBusy =
    phase === 'tool' && /playwright__|browse_act|view_page|page_snapshot/.test(lastToolName)

  /**
   * NOTHING here switches the view.
   *
   * There was an auto-switch to Browser while a page was being driven and back
   * to Chat afterwards. It worked, and it was wrong: it took the transcript
   * away at the exact moment the model was explaining what it was about to do,
   * so you could watch it click or read why it clicked, never both.
   *
   * The live view moved to the workspace sidebar instead, where it sits beside
   * the conversation. See LiveBrowserStrip. The tab is still here and still
   * holds every captured frame; it is now somewhere you go, not somewhere you
   * are sent.
   */

  /**
   * Deliberately NO auto-switch to Browser, for the same reason there is none
   * to Watch: the composer lives in ChatView, so switching this column away
   * from Chat leaves the workflow with no way to type. Doing it automatically
   * mid-run takes the keyboard away from someone in the middle of a sentence.
   *
   * The floating window covers the case this would have served — something is
   * happening in a page and you want to see it — without moving anything the
   * user is using.
   */

  if (mode === 'browser') {
    return (
      <div className="cw cw-chat">
        <ModeBar
          mode={mode}
          onMode={setMode}
          files={tabs.length}
          changedFiles={changedFileCount}
          frames={frameCount}
          mirrorLive={mirrorLive}
          busy={browserBusy}
          writing={liveRow !== null}
          added={totals.added}
          removed={totals.removed}
        />
        <div className="cw-chat-body">
          <BrowserPane />
        </div>
      </div>
    )
  }

  if (mode === 'chat') {
    return (
      <div className="cw cw-chat">
        <ModeBar
          mode={mode}
          onMode={setMode}
          files={tabs.length}
          changedFiles={changedFileCount}
          frames={frameCount}
          mirrorLive={mirrorLive}
          busy={browserBusy}
          writing={liveRow !== null}
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
        changedFiles={changedFileCount}
        frames={frameCount}
        mirrorLive={mirrorLive}
        busy={browserBusy}
        writing={liveRow !== null}
        added={totals.added}
        removed={totals.removed}
      />
      {/* The editor-shaped Watch view: file tree, tabs, viewer and the
          activity dock. It replaces the tab-strip-over-viewer layout, which
          left no room to actually read a file — Adam's report was that the
          preview pane was impossible to use. */}
      <WatchPane
        activities={activities}
        tabs={tabs}
        activePath={activePath}
        onSelect={setPinnedPath}
        pinned={pinnedPath !== null}
        // Un-pinning hands control back to the agent; it must not blank the
        // screen. Clearing pinnedPath alone left activePath null whenever the
        // agent had not touched a file yet, so browsing the tree and then
        // clicking "Following" made the open file vanish behind "No file open".
        // Seed autoPath from what is on screen FIRST, while pinnedPath still
        // resolves it, then release the pin.
        onPinnedChange={(p) => {
          if (p) {
            if (activePath) setPinnedPath(activePath)
            return
          }
          setAutoPath((prev) => activePath ?? prev)
          setPinnedPath(null)
        }}
      />
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
  mode: 'chat' | 'watch' | 'browser'
  onMode: (m: 'chat' | 'watch' | 'browser') => void
  /** Every file touched, including ones only read — the Watch tab badge. */
  files: number
  /** Only files actually modified — what the "+N -M across K" line counts. */
  changedFiles: number
  frames: number
  mirrorLive: boolean
  busy: boolean
  writing: boolean
  added: number
  removed: number
}): JSX.Element {
  const { mode, onMode, files, changedFiles, frames, mirrorLive, busy, writing, added, removed } =
    props
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
          className={
            (mode === 'watch' ? 'cw-seg is-on' : 'cw-seg') + (writing ? ' is-busy' : '')
          }
          onClick={() => onMode('watch')}
          title={writing ? 'A file is being written right now' : undefined}
        >
          Watch
          {files > 0 ? <span className="cw-seg-badge tnum">{files}</span> : null}
        </button>
        {/* Only once there is something to see. An empty tab that never lights
            up is furniture. */}
        {/* Shown once there is anything to see — a capture, or a live browser.
            Without the live case the tab stays hidden through exactly the part
            worth watching: the model playing with a page it has not yet
            screenshotted. */}
        {frames > 0 || mirrorLive ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'browser'}
            className={
              (mode === 'browser' ? 'cw-seg is-on' : 'cw-seg') + (busy ? ' is-busy' : '')
            }
            onClick={() => onMode('browser')}
            title={
              busy
                ? 'The model is driving a page right now'
                : 'The frames the model was shown by the browser tools'
            }
          >
            Browser
            {frames > 0 ? <span className="cw-seg-badge tnum">{frames}</span> : null}
          </button>
        ) : null}
      </div>
      <AutoApprove />
      {changedFiles > 0 ? (
        <span className="cw-modebar-stat tnum">
          {/* cw-add / cw-del were defined in no stylesheet, so the only change
              readout visible while typing rendered in inherited grey. Fourth
              instance of this exact bug; these are the canonical pair. */}
          <span className="cw-stat-add">+{added}</span>{' '}
          <span className="cw-stat-del">-{removed}</span>{' '}
          across {changedFiles} file{changedFiles === 1 ? '' : 's'}
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
    case 'serve':
      return (
        <Svg>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.8z" />
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
