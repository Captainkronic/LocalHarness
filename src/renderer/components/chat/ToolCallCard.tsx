/**
 * One card per tool call: collapsed to a single dense line, expandable to the
 * full arguments, result and artifacts.
 */

import { useEffect, useMemo, useReducer, useState } from 'react'
import type { Artifact, ToolCall } from '@shared/types'
import { basename, formatChars, formatMs } from '@renderer/lib/format'
import { outcomeDetail, toolOutcome } from '@renderer/lib/toolFacts'
import './chat.css'

export interface ToolCallCardProps {
  call: ToolCall
  /** Result recorded on a separate role:'tool' message, when the call itself
   *  does not carry one. */
  fallbackResult?: string
}

export default function ToolCallCard({ call, fallbackResult }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const [tall, setTall] = useState(false)

  const parsed = useMemo<unknown>(() => {
    try {
      return JSON.parse(call.arguments) as unknown
    } catch {
      return undefined // still streaming, or the model emitted junk
    }
  }, [call.arguments])

  const pretty = useMemo(
    () => (parsed === undefined ? call.arguments.trim() : JSON.stringify(parsed, null, 2)),
    [parsed, call.arguments]
  )

  const result = call.result ?? fallbackResult
  const artifacts = call.artifacts ?? []
  const [server, bare] = splitQualified(call.name, call.origin)
  const blocked = call.status === 'awaiting_approval'
  const failed = call.status === 'error' || call.status === 'denied'

  const duration =
    call.startedAt !== undefined && call.finishedAt !== undefined
      ? formatMs(call.finishedAt - call.startedAt)
      : null

  /* What the run actually did, when the tool reported it in a form worth
     trusting. Collapsed only: once the card is open the full result is right
     there and a summary of it is just a duplicate. */
  const outcome = useMemo(() => toolOutcome(call.structured), [call.structured])

  const cls = ['tool', blocked ? 'tool-blocked' : '', failed ? 'tool-failed' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span
          className={call.origin === 'native' ? 'tool-origin tool-origin-native' : 'tool-origin'}
          title={call.origin === 'native' ? 'Native tool' : `MCP server: ${server}`}
        >
          {call.origin === 'native' ? 'native' : server}
        </span>
        <span className="tool-name">{bare}</span>
        <span className="tool-precis">{precis(parsed, call.arguments)}</span>
        <StatusBadge
          status={call.status}
          duration={duration}
          writtenChars={call.arguments.length}
          openedAt={call.openedAt}
          progressFraction={call.progressFraction}
          progressMessage={call.progressMessage}
        />
      </button>

      {!open && outcome !== null ? (
        <button
          type="button"
          className="tool-outcome"
          onClick={() => setOpen(true)}
          title="Show the full result"
        >
          <span className={outcome.tone === 'bad' ? 'tool-oc-stat is-bad' : 'tool-oc-stat'}>
            {outcome.status}
          </span>
          <span
            className={outcome.detailIsError ? 'tool-oc-detail is-err' : 'tool-oc-detail'}
          >
            {outcomeDetail(outcome)}
          </span>
          {outcome.note !== '' ? <span className="tool-oc-note">{outcome.note}</span> : null}
        </button>
      ) : null}

      {open ? (
        <div className="tool-body">
          <div>
            <div className="tool-block-label">
              <span className="section-label">Arguments</span>
            </div>
            <pre className="tool-pre">{pretty === '' ? '(none)' : pretty}</pre>
          </div>

          {call.error !== undefined && call.error !== '' ? (
            <div>
              <div className="tool-block-label">
                <span className="section-label">Error</span>
              </div>
              <div className="tool-err">{call.error}</div>
            </div>
          ) : null}

          {result !== undefined && result !== '' ? (
            <div>
              <div className="tool-block-label">
                <span className="section-label">Result</span>
              </div>
              <pre className={tall ? 'tool-pre tool-pre-tall' : 'tool-pre'}>{result}</pre>
              {result.length > 600 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm tool-more"
                  onClick={() => setTall((v) => !v)}
                >
                  {tall ? 'Collapse' : 'Expand'}
                </button>
              ) : null}
            </div>
          ) : null}

          {artifacts.length > 0 ? <ArtifactList artifacts={artifacts} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A 1Hz tick, only while a call is composing.
 *
 * The card re-renders when main pushes an update, and while this backend
 * composes a tool call main has nothing to push — which is precisely the
 * stretch the clock is there to measure. Without its own tick the duration
 * would freeze at whatever it read when the call was named, and a frozen
 * clock that looks live is the failure this whole change is about.
 */
function useTick(active: boolean): void {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [active])
}

const PENDING_TIP =
  'This server sends a tool call\u2019s arguments in one piece rather than streaming them, so ' +
  'there is nothing to show until the whole call lands. On a file-sized argument that is minutes ' +
  'of apparent silence.'

/* ------------------------------------------------------------------ */

function StatusBadge({
  status,
  duration,
  writtenChars,
  openedAt,
  progressFraction,
  progressMessage
}: {
  status: ToolCall['status']
  duration: string | null
  /** Argument characters received so far, while the model is still composing
   *  the call. A write_file argument can be a whole file, so this is the only
   *  progress there is during the longest generation the app does. */
  writtenChars: number
  /** When the model first named the call — the only clock that moves while it
   *  composes arguments this backend does not stream. */
  openedAt?: number
  /** Live render progress, 0..1, when the server reports a real total. */
  progressFraction?: number | null
  /** The server's own phrase for what it is doing right now. */
  progressMessage?: string
}) {
  useTick(status === 'pending' && writtenChars === 0)

  switch (status) {
    case 'awaiting_approval':
      return (
        <span className="tool-state tool-state-blocked">
          <span className="dot dot-warn" />
          needs approval
        </span>
      )
    case 'running':
      // A local render takes one to two minutes. A bare dot for all of it is
      // indistinguishable from a hang, so when the server tells us where it has
      // got to, say so — and show the bar only when there is a real fraction
      // behind it rather than animating an invented one.
      return (
        <span className="tool-state tool-state-progress">
          <span className="dot dot-busy" />
          <span className="tool-progress-label">{progressMessage ?? 'running'}</span>
          {typeof progressFraction === 'number' ? (
            <>
              <span
                className="tool-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progressFraction * 100)}
              >
                <span
                  className="tool-progress-fill"
                  style={{ width: `${Math.round(progressFraction * 100)}%` }}
                />
              </span>
              <span className="tool-progress-pct tnum">
                {Math.round(progressFraction * 100)}%
              </span>
            </>
          ) : null}
        </span>
      )
    case 'pending':
      // "queued" was a lie: the model is writing this call RIGHT NOW, and for a
      // file-sized argument that is minutes of apparent nothing.
      //
      // The byte counter alone was structurally sizeless on this backend — the
      // arguments arrive in one piece, so `writtenChars` goes from 0 to the
      // whole file at the same instant the call stops being pending. A clock is
      // the only thing that actually moves during the wait.
      return (
        <span className="tool-state" title={PENDING_TIP}>
          <span className="dot dot-busy" />
          {writtenChars > 0
            ? `composing… ${formatChars(writtenChars)}`
            : openedAt !== undefined
              ? `composing… ${formatMs(Date.now() - openedAt)}`
              : 'composing…'}
        </span>
      )
    case 'error':
      return (
        <span className="tool-state tool-state-error">
          <span className="dot dot-error" />
          {duration ?? 'failed'}
        </span>
      )
    case 'denied':
      return (
        <span className="tool-state tool-state-error">
          <span className="dot dot-error" />
          denied
        </span>
      )
    default:
      return (
        <span className="tool-state tnum">
          <span className="dot dot-ok" />
          {duration ?? 'done'}
        </span>
      )
  }
}

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const images = artifacts.filter((a) => a.kind === 'image')
  const rest = artifacts.filter((a) => a.kind !== 'image')
  return (
    <div>
      <div className="tool-block-label">
        <span className="section-label">
          {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="tool-artifacts">
        {images.length > 0 ? (
          <div className="tool-thumbs">
            {images.map((a) => (
              <ImageThumb key={a.id} artifact={a} />
            ))}
          </div>
        ) : null}
        {rest.map((a) => (
          <FileRow key={a.id} artifact={a} />
        ))}
      </div>
    </div>
  )
}

function ImageThumb({ artifact }: { artifact: Artifact }) {
  const [src, setSrc] = useState<string | null>(artifact.url ?? null)

  // An artifact that is only a path needs the main process to read it — the
  // renderer has no disk access.
  useEffect(() => {
    if (src !== null || artifact.path === undefined) return
    let cancelled = false
    void window.harness
      .invoke('artifacts:readDataUrl', artifact.path)
      .then((data) => {
        if (!cancelled && data) setSrc(data)
      })
    return () => {
      cancelled = true
    }
  }, [artifact.path, src])

  const target = artifact.path ?? artifact.url
  return (
    <button
      type="button"
      className="tool-thumb"
      title={artifact.label}
      onClick={() => {
        if (target) void window.harness.invoke('artifacts:open', target)
      }}
    >
      {src !== null ? (
        <img src={src} alt={artifact.label} />
      ) : (
        <span className="tool-thumb-pending">no preview</span>
      )}
    </button>
  )
}

function FileRow({ artifact }: { artifact: Artifact }) {
  const name = artifact.path !== undefined ? basename(artifact.path) : artifact.label
  const meta = artifact.meta
    ? Object.entries(artifact.meta)
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`)
        .join('  ')
    : ''
  return (
    <div className="tool-file">
      <span className="tool-file-name" title={artifact.path ?? artifact.url ?? artifact.label}>
        {name}
      </span>
      {meta !== '' ? <span className="tool-file-meta tnum">{meta}</span> : null}
      {artifact.path !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (artifact.path !== undefined) {
              void window.harness.invoke('artifacts:reveal', artifact.path)
            }
          }}
        >
          Reveal
        </button>
      ) : null}
      {artifact.path !== undefined || artifact.url !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const target = artifact.path ?? artifact.url
            if (target !== undefined) void window.harness.invoke('artifacts:open', target)
          }}
        >
          Open
        </button>
      ) : null}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'tool-chev tool-chev-open' : 'tool-chev'}
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

/* ------------------------------------------------------------------ */
/* Summarising                                                         */
/* ------------------------------------------------------------------ */

/** Wire names are `${serverId}__${tool}`; show the two halves separately. */
function splitQualified(name: string, origin: ToolCall['origin']): [string, string] {
  if (origin === 'native') return ['native', name]
  const i = name.indexOf('__')
  if (i <= 0) return ['mcp', name]
  return [name.slice(0, i), name.slice(i + 2)]
}

/** Keys worth showing first, in the order a human would want them. */
const PRECIS_KEYS = [
  'path',
  'file_path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'text',
  'sql',
  'name'
]

function oneLine(s: string, max = 96): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function shortValue(v: unknown): string {
  if (typeof v === 'string') return oneLine(v, 32)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.length}]`
  return '{…}'
}

function precis(parsed: unknown, raw: string): string {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>
    for (const k of PRECIS_KEYS) {
      const v = rec[k]
      if (typeof v === 'string' && v.trim() !== '') return oneLine(v)
    }
    const entries = Object.entries(rec)
    if (entries.length > 0) {
      return oneLine(
        entries
          .slice(0, 3)
          .map(([k, v]) => `${k}=${shortValue(v)}`)
          .join('  ')
      )
    }
    return 'no arguments'
  }
  return raw.trim() === '' ? 'no arguments' : oneLine(raw)
}
