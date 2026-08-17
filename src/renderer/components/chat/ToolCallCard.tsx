/**
 * One card per tool call: collapsed to a single dense line, expandable to the
 * full arguments, result and artifacts.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Artifact, ToolCall } from '@shared/types'
import { basename, formatMs } from '@renderer/lib/format'
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
        <StatusBadge status={call.status} duration={duration} />
      </button>

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

/* ------------------------------------------------------------------ */

function StatusBadge({
  status,
  duration
}: {
  status: ToolCall['status']
  duration: string | null
}) {
  switch (status) {
    case 'awaiting_approval':
      return (
        <span className="tool-state tool-state-blocked">
          <span className="dot dot-warn" />
          needs approval
        </span>
      )
    case 'running':
      return (
        <span className="tool-state">
          <span className="dot dot-busy" />
          running
        </span>
      )
    case 'pending':
      return (
        <span className="tool-state">
          <span className="dot" />
          queued
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
