/**
 * The live activity log.
 *
 * This is the "what is it doing right now" surface: one dense row per filesystem
 * effect, newest at the bottom, the way a terminal log reads.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 *  1. Follow-the-tail. The log pins to the newest row, but the instant the user
 *     scrolls up it stops moving under them and offers a way back. Stickiness is
 *     decided from geometry on every scroll event, never from a flag we set when
 *     we scrolled — that way our own programmatic scrolls can't desync it.
 *
 *  2. Position stability. Rows are capped, so while the user reads, the cap
 *     would ordinarily consume the log from the head and walk the text up the
 *     screen. Scrolling cannot compensate for that — a reader parked at the top
 *     has no room left to give — so the rendered window is frozen where they
 *     stopped instead, and the arrivals they are missing are counted rather
 *     than rendered. What is still uncompensable by freezing is a row already on
 *     screen growing taller when its result lands, so we also anchor on the row
 *     holding the fold and correct scrollTop by however far it moved. Chromium's
 *     own scroll anchoring is off in the stylesheet so the two can't fight.
 *
 *  3. One row per operation. The tracker reuses an id across phases, so a
 *     'start' row is updated in place when its 'done' arrives rather than the
 *     log growing a second entry for work that happened once.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { FileActivity, FileOpKind } from '@shared/types'
import { formatMs, shortenPath } from '@renderer/lib/format'
import './ticker.css'

export interface ActivityTickerProps {
  activities: FileActivity[]
  /** Given the absolute path (`activity.target`) of a clicked file row. */
  onSelect: (path: string) => void
  /** Hard cap on rendered rows. The store keeps more than the eye can use. */
  max?: number
}

/** Kinds whose target is a file the viewer can actually open. */
const FILE_KINDS: ReadonlySet<FileOpKind> = new Set<FileOpKind>(['read', 'write', 'edit'])

/** Slack, in px, still counted as "at the bottom". Fractional scroll positions
 *  on a HiDPI display never land exactly on zero. */
const STICK_PX = 24

/** Where a row sat in the scroll content at the last measurement. */
interface Anchor {
  id: string
  top: number
}

export function ActivityTicker({
  activities,
  onSelect,
  max = 200
}: ActivityTickerProps): ReactElement {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  /** Where every row sat before the last DOM change, in order. */
  const anchorsRef = useRef<Anchor[]>([])
  /** Index into anchorsRef of the first row that was on screen. */
  const visibleRef = useRef(0)
  /** rAF handle throttling anchor measurement during a scroll. */
  const frameRef = useRef<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const liveRef = useRef(true)
  /** What is on screen right now, for the scroll handler to freeze against. */
  const rowsRef = useRef<FileActivity[]>([])
  /** Rows already present when the ticker mounted are backlog, not news, and
   *  must not all flash at once on first paint. */
  const mountedAtRef = useRef(Date.now())

  const [live, setLive] = useState(true)
  /** Id of the row pinned to the top of the window while the user is parked;
   *  null means "follow the tail". */
  const [frozenHead, setFrozenHead] = useState<string | null>(null)

  const merged = useMemo(() => mergeRuns(activities), [activities])

  // Live, this is the newest `max` rows. Parked, it is the same `max` rows the
  // user stopped on — held still, so the cap eats into what they have not read
  // yet instead of what they are reading.
  const { rows, start } = useMemo(() => {
    const tail = Math.max(0, merged.length - max)
    if (frozenHead === null) return { rows: merged.slice(tail), start: tail }
    const i = merged.findIndex((r) => r.id === frozenHead)
    // A frozen head that has aged out of the store entirely leaves nothing to
    // hold on to; snapping to the tail is the honest outcome.
    const from = i >= 0 ? Math.min(i, tail) : tail
    return { rows: merged.slice(from, from + max), start: from }
  }, [merged, max, frozenHead])

  /** Arrivals that exist but are deliberately not rendered. Derived, so it
   *  cannot drift from what is on screen the way a counter would. */
  const pending = merged.length - (start + rows.length)

  useEffect(() => {
    liveRef.current = live
  }, [live])

  /**
   * Photograph where every row sits, and note which one held the top of the
   * viewport. offsetTop is measured against the scroll content rather than the
   * viewport, so a reading survives any amount of scrolling — only a change in
   * the rows above it can invalidate it, which is the thing we are here to fix.
   *
   * The whole list is kept, not just the row at the fold, so there is something
   * left to measure against in the one case freezing cannot cover: a reader
   * parked so long that the row they froze on has aged out of the store, taking
   * the window with it.
   */
  const measureAnchor = useCallback(() => {
    const el = scrollerRef.current
    if (!el) {
      anchorsRef.current = []
      visibleRef.current = 0
      return
    }
    const fold = el.scrollTop
    const list: Anchor[] = []
    let visible = -1
    for (const node of el.querySelectorAll<HTMLElement>('.tk-row')) {
      const id = node.dataset.aid
      if (id === undefined) continue
      if (visible < 0 && node.offsetTop + node.offsetHeight > fold) visible = list.length
      list.push({ id, top: node.offsetTop })
    }
    anchorsRef.current = list
    visibleRef.current = visible < 0 ? 0 : visible
  }, [])

  /** How far the content under the viewport moved, in px. Prefers the row that
   *  held the fold; falls back to the oldest survivor when that row is one of
   *  the ones that just fell off the head. */
  const shift = useCallback((el: HTMLElement): number => {
    const list = anchorsRef.current
    const moved = (i: number): number | null => {
      const entry = list[i]
      if (entry === undefined) return null
      const node = findRow(el, entry.id)
      return node === null ? null : node.offsetTop - entry.top
    }
    const atFold = moved(visibleRef.current)
    if (atFold !== null) return atFold
    for (let i = 0; i < list.length; i++) {
      const d = moved(i)
      if (d !== null) return d
    }
    return 0
  }, [])

  useLayoutEffect(() => {
    rowsRef.current = rows
    const el = scrollerRef.current
    if (!el) return

    if (live) {
      el.scrollTop = el.scrollHeight
    } else {
      // A row on screen growing as its result lands moves everything below it.
      // Put it back.
      const moved = shift(el)
      if (moved !== 0) el.scrollTop += moved
    }

    measureAnchor()
  }, [rows, live, measureAnchor, shift])

  /**
   * A resize while pinned must keep the newest row in view.
   *
   * Attached as a ref callback rather than in an effect: the scroller does not
   * exist on the first render — an empty ticker renders no log at all — so a
   * mount effect would look for it once, find nothing, and never run again.
   */
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    scrollerRef.current = node
    if (node === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = scrollerRef.current
      if (el && liveRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(node)
    observerRef.current = ro
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
    setLive((prev) => (prev === bottom ? prev : bottom))
    // Freeze on the way up, at whatever row is currently oldest on screen; let
    // go the moment they are back at the bottom.
    setFrozenHead((prev) => {
      if (bottom) return null
      if (prev !== null) return prev
      const first = rowsRef.current[0]
      return first === undefined ? null : first.id
    })

    // Re-anchor as they move. Measuring only when rows change would leave the
    // anchor one gesture behind, and a stale anchor corrects for height changes
    // that happened below the fold — a jump, in the name of preventing one.
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        measureAnchor()
      })
    }
  }, [measureAnchor])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  const goLive = useCallback(() => {
    const el = scrollerRef.current
    // Instant, not smooth: a smooth scroll fires intermediate scroll events that
    // read as "not at the bottom", which would immediately unstick us again.
    if (el) el.scrollTop = el.scrollHeight
    setLive(true)
    setFrozenHead(null)
  }, [])

  if (rows.length === 0) {
    return (
      <div className="tk">
        <div className="tk-empty">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 4.5h12M2 8h8M2 11.5h5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <p className="tk-empty-head">Nothing has happened yet.</p>
          <p>
            This fills in as the agent works — every file it reads, every glob and
            grep it runs, every write and edit with its line counts, and every
            shell command with its result.
          </p>
          <p className="tk-empty-hint">Rows for files open them in the viewer.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="tk">
      <div
        ref={attachScroller}
        className="tk-log scroll-y"
        onScroll={handleScroll}
        role="log"
        aria-label="File activity"
      >
        {rows.map((act) => (
          <Row
            key={act.id}
            act={act}
            isNew={act.at > mountedAtRef.current}
            onSelect={onSelect}
          />
        ))}
      </div>

      {!live && pending > 0 ? (
        <button type="button" className="tk-jump" onClick={goLive}>
          <span className="tnum">{pending > 99 ? '99+' : pending}</span>
          <span>new</span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v9m0 0L4.5 8.5M8 12l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

interface RowProps {
  act: FileActivity
  isNew: boolean
  onSelect: (path: string) => void
}

function Row({ act, isNew, onSelect }: RowProps): ReactElement {
  const running = act.phase === 'start' || act.phase === 'progress'
  const failed = act.phase === 'error' || (act.error !== undefined && act.error !== '')
  const openable = FILE_KINDS.has(act.kind) && act.target !== ''

  const className = [
    'tk-row',
    `is-${act.kind}`,
    isNew ? 'is-new' : '',
    running ? 'is-running' : '',
    failed ? 'is-failed' : '',
    openable ? 'is-openable' : ''
  ]
    .filter((c) => c !== '')
    .join(' ')

  const body = (
    <>
      <span className="tk-time tnum">{hms(act.at)}</span>
      <span className={`tk-kind is-${act.kind}`}>{act.kind}</span>
      <span className="tk-target">{label(act)}</span>
      <span className="tk-dur tnum">
        {act.durationMs !== undefined ? formatMs(act.durationMs) : ''}
      </span>
      <span className="tk-res">{result(act, running, failed)}</span>
      {/* Errors get the whole width and wrap. A truncated error is a bug report
          with the useful half missing. */}
      {failed && act.error ? <span className="tk-err">{act.error}</span> : null}
    </>
  )

  if (openable) {
    return (
      <button
        type="button"
        className={className}
        data-aid={act.id}
        title={tooltip(act, true)}
        onClick={() => onSelect(act.target)}
      >
        {body}
      </button>
    )
  }

  return (
    <div className={className} data-aid={act.id} title={tooltip(act, false)}>
      {body}
    </div>
  )
}

/** The right-hand column: what came of the operation. */
function result(act: FileActivity, running: boolean, failed: boolean): ReactNode {
  if (running) {
    return (
      <span className="tk-running">
        <i className="dot dot-busy" aria-hidden="true" />
        <span>working</span>
      </span>
    )
  }
  if (failed) return <span className="tk-failed">failed</span>
  if (act.added !== undefined || act.removed !== undefined) {
    return (
      <span className="tk-stat tnum">
        <span className="tk-add">+{act.added ?? 0}</span>
        <span className="tk-del">-{act.removed ?? 0}</span>
      </span>
    )
  }
  if (act.summary !== undefined && act.summary !== '') {
    return <span className="tk-summary">{act.summary}</span>
  }
  return null
}

/** What the middle column says: the path, or for shell the command itself. */
function label(act: FileActivity): string {
  if (act.kind === 'shell') return act.target
  if (act.displayPath !== undefined && act.displayPath.trim() !== '') return act.displayPath
  return shortenPath(act.target, 3)
}

function tooltip(act: FileActivity, openable: boolean): string {
  const lines = [`${act.kind} · ${act.phase}`, act.target]
  if (act.durationMs !== undefined) lines.push(`took ${formatMs(act.durationMs)}`)
  if (act.added !== undefined || act.removed !== undefined) {
    lines.push(`+${act.added ?? 0} / -${act.removed ?? 0} lines`)
  }
  if (act.summary) lines.push(act.summary)
  if (act.error) lines.push(act.error)
  if (openable) lines.push('Click to open in the viewer.')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Wall clock, fixed 24h HH:MM:SS. Deliberately not locale-formatted: a log
 *  column has to be one width, and seconds are the point of it. */
function hms(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function findRow(scroller: HTMLElement, id: string): HTMLElement | null {
  for (const node of scroller.querySelectorAll<HTMLElement>('.tk-row')) {
    if (node.dataset.aid === id) return node
  }
  return null
}

/**
 * Collapse the phases of one operation into a single row, kept at the position
 * its 'start' claimed so a finishing row never jumps down the log.
 *
 * A later phase omitting a field must not erase what an earlier one already
 * told us, hence the field-by-field carry rather than a plain spread.
 */
export function mergeRuns(activities: FileActivity[]): FileActivity[] {
  const order: string[] = []
  const byId = new Map<string, FileActivity>()

  for (const a of activities) {
    const prev = byId.get(a.id)
    if (prev === undefined) {
      order.push(a.id)
      byId.set(a.id, a)
      continue
    }
    byId.set(a.id, {
      ...prev,
      ...a,
      // The row's clock is when the work began; a time that changes on
      // completion reads as a second, separate event.
      at: Math.min(prev.at, a.at),
      diff: a.diff ?? prev.diff,
      added: a.added ?? prev.added,
      removed: a.removed ?? prev.removed,
      changedLines: a.changedLines ?? prev.changedLines,
      content: a.content ?? prev.content,
      summary: a.summary ?? prev.summary,
      error: a.error ?? prev.error,
      durationMs: a.durationMs ?? prev.durationMs
    })
  }

  return order.map((id) => byId.get(id) as FileActivity)
}

export default ActivityTicker
