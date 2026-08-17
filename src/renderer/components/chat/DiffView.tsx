/**
 * Unified diff renderer.
 *
 * Line numbers come from the hunk headers, so a diff with several hunks stays
 * anchored to the real file. The body is the only thing that scrolls
 * horizontally — long lines must never widen the page — and the gutters stay
 * pinned while it does.
 */

import { useMemo, type CSSProperties } from 'react'
import './chat.css'

export interface DiffViewProps {
  diff: string
  /** Very large diffs are truncated rather than rendered in full. */
  maxLines?: number
  className?: string
}

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

const HUNK_RE = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/
const META_RE = /^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity |rename |Binary files)/

export default function DiffView({ diff, maxLines = 400, className }: DiffViewProps) {
  const lines = useMemo(() => parseDiff(diff), [diff])

  if (lines.length === 0) {
    return (
      <div className={className ? `diff ${className}` : 'diff'}>
        <div className="diff-empty">No changes.</div>
      </div>
    )
  }

  const shown = lines.slice(0, maxLines)
  const widest = shown.reduce(
    (w, l) => Math.max(w, String(l.oldNo ?? '').length, String(l.newNo ?? '').length),
    2
  )
  // Gutter width is shared by the sticky offsets, so it lives in a custom prop.
  const style = { '--gut-w': `calc(${widest}ch + 12px)` } as CSSProperties

  return (
    <div className={className ? `diff ${className}` : 'diff'}>
      <div className="diff-body scroll-y" style={style}>
        {shown.map((l, i) => (
          <DiffRow key={i} line={l} />
        ))}
      </div>
      {lines.length > shown.length ? (
        <div className="diff-trunc tnum">
          {lines.length - shown.length} more lines not shown
        </div>
      ) : null}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return (
      <div className={`diff-row diff-${line.kind}`}>
        <span className="diff-txt">{line.text}</span>
      </div>
    )
  }
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  return (
    <div className={`diff-row diff-${line.kind}`}>
      <span className="diff-gut tnum">{line.oldNo ?? ''}</span>
      <span className="diff-gut tnum">{line.newNo ?? ''}</span>
      <span className="diff-sign">{sign}</span>
      <span className="diff-txt">{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  if (diff.trim() === '') return out

  let oldNo = 0
  let newNo = 0

  for (const raw of diff.replace(/\n$/, '').split('\n')) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      oldNo = Number.parseInt(hunk[1], 10)
      newNo = Number.parseInt(hunk[3], 10)
      out.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (META_RE.test(raw)) {
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — carries no line number.
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ })
      continue
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null })
      continue
    }
    // Context. Some producers emit a bare empty line instead of a single space.
    out.push({
      kind: 'ctx',
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
      oldNo: oldNo++,
      newNo: newNo++
    })
  }

  return out
}
