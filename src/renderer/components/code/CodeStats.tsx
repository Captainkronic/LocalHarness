/**
 * Session totals for the Code workspace, read the way the metrics HUD is read:
 * a fixed strip of label + number, every number tabular, nothing moving except
 * the digits.
 *
 * Counts are derived from the activity stream rather than tracked separately,
 * so they can never disagree with the ticker sitting next to them. Two rules
 * make the arithmetic honest:
 *
 *  - one operation, one count. The tracker reuses an id across phases, so the
 *    stream is folded by id first; otherwise every finished op would be counted
 *    twice, once for its 'start' and once for its 'done'.
 *  - failed work is not work. An op that errored didn't read the file or change
 *    the lines, so it is left out entirely instead of inflating the totals.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { FileActivity } from '@shared/types'
import './ticker.css'

export interface CodeStatsProps {
  activities: FileActivity[]
}

const KEYS = ['files', 'added', 'removed', 'reads', 'searches', 'shell'] as const
type StatKey = (typeof KEYS)[number]
type Totals = Record<StatKey, number>

const ZERO: Totals = { files: 0, added: 0, removed: 0, reads: 0, searches: 0, shell: 0 }

/** Long enough to read as motion, short enough that the number is never stale. */
const COUNT_MS = 300

export function CodeStats({ activities }: CodeStatsProps): ReactElement {
  const totals = useTotals(activities)
  const shown = useCountUp(totals, COUNT_MS)

  return (
    <div className="cs" role="group" aria-label="Session totals">
      <Stat
        label="files"
        value={shown.files}
        title="Distinct files read, written or edited in this conversation."
      />

      <span className="cs-sep" aria-hidden="true" />

      <div className="cs-group">
        <Stat
          label="added"
          value={shown.added}
          tone="add"
          prefix="+"
          title="Lines added across every write and edit."
        />
        <Stat
          label="removed"
          value={shown.removed}
          tone="del"
          prefix="-"
          title="Lines removed across every write and edit."
        />
        <RatioBar added={shown.added} removed={shown.removed} />
      </div>

      <span className="cs-sep" aria-hidden="true" />

      <Stat label="reads" value={shown.reads} tone="read" title="Files read." />
      <Stat
        label="searches"
        value={shown.searches}
        tone="search"
        title="Globs, greps and directory listings."
      />
      <Stat
        label="shell"
        value={shown.shell}
        tone="shell"
        title="Shell commands run."
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

interface StatProps {
  label: string
  value: number
  tone?: 'add' | 'del' | 'read' | 'search' | 'shell'
  prefix?: string
  title: string
}

function Stat({ label, value, tone, prefix, title }: StatProps): ReactElement {
  return (
    <div className="cs-stat" title={title}>
      <span className="cs-label">{label}</span>
      <span className={tone ? `cs-val tnum is-${tone}` : 'cs-val tnum'}>
        {prefix !== undefined && value !== 0 ? prefix : ''}
        {value.toLocaleString()}
      </span>
    </div>
  )
}

/**
 * Added against removed, as one 32px bar. It answers "was this session mostly
 * writing or mostly deleting" at a glance, which the two numbers alone don't.
 */
function RatioBar({ added, removed }: { added: number; removed: number }): ReactElement {
  const total = added + removed
  const addPct = total === 0 ? 0 : (added / total) * 100

  return (
    <span
      className={total === 0 ? 'cs-bar is-empty' : 'cs-bar'}
      aria-hidden="true"
      title={total === 0 ? 'No lines changed yet.' : `+${added} / -${removed}`}
    >
      <span className="cs-bar-add" style={{ width: `${addPct}%` }} />
      <span className="cs-bar-del" style={{ width: `${100 - addPct}%` }} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

function useTotals(activities: FileActivity[]): Totals {
  return useMemo(() => {
    // Fold phases into one entry per operation, keeping whichever phase carried
    // the numbers — 'done' reports added/removed, 'start' cannot.
    const latest = new Map<string, FileActivity>()
    for (const a of activities) {
      const prev = latest.get(a.id)
      latest.set(
        a.id,
        prev === undefined
          ? a
          : { ...prev, ...a, added: a.added ?? prev.added, removed: a.removed ?? prev.removed }
      )
    }

    const files = new Set<string>()
    const totals: Totals = { ...ZERO }

    for (const a of latest.values()) {
      if (a.phase === 'error') continue
      switch (a.kind) {
        case 'read':
          files.add(a.target)
          totals.reads += 1
          break
        case 'write':
        case 'edit':
          files.add(a.target)
          totals.added += a.added ?? 0
          totals.removed += a.removed ?? 0
          break
        case 'glob':
        case 'grep':
        case 'list':
          totals.searches += 1
          break
        case 'shell':
          totals.shell += 1
          break
      }
    }

    totals.files = files.size
    return totals
  }, [activities])
}

/* ------------------------------------------------------------------ */
/* Count-up                                                            */
/* ------------------------------------------------------------------ */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Ease every readout to its new value on one shared frame loop.
 *
 * One loop, not one per number: six independent rAF callbacks would each
 * schedule their own render and repaint the strip six times a frame for the
 * sake of six spans.
 *
 * The first value is adopted outright — an opening session total counting up
 * from zero would be theatre, not feedback. Interrupted runs continue from the
 * digits currently on screen rather than snapping back to where they started.
 */
function useCountUp(target: Totals, durationMs: number): Totals {
  const [shown, setShown] = useState<Totals>(target)
  const shownRef = useRef<Totals>(target)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const from = shownRef.current
    if (KEYS.every((k) => from[k] === target[k])) return

    if (durationMs <= 0 || prefersReducedMotion()) {
      shownRef.current = target
      setShown(target)
      return
    }

    const startedAt = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / durationMs)
      const eased = 1 - (1 - t) ** 3
      const next = { ...ZERO }
      for (const k of KEYS) {
        next[k] = t >= 1 ? target[k] : Math.round(from[k] + (target[k] - from[k]) * eased)
      }
      shownRef.current = next
      setShown(next)
      frameRef.current = t < 1 ? requestAnimationFrame(tick) : null
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    // Depend on the values, not the object: the activity array gets a new
    // identity on every push, and re-running this for a total that did not move
    // would restart an animation already in flight.
  }, [
    target.files,
    target.added,
    target.removed,
    target.reads,
    target.searches,
    target.shell,
    durationMs
  ])

  return shown
}

export default CodeStats
