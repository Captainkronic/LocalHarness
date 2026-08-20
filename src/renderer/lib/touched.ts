/**
 * Which files a conversation touched, derived from its own tool calls.
 *
 * Derived rather than tracked separately, so it can never disagree with the
 * transcript it sits beside.
 *
 * The change stat is the part worth being careful about. It is read out of the
 * result text, which is safe only because the executor writes that text and
 * only for writes and edits. Applying the same pattern to a read was a real
 * bug: a read's result is the file's own source, and a line of three-dimensional
 * golf code reading `wall(1.4, 26.4,+13, -3.5)` was reported in the panel as
 * "+13 -3" against a file nothing had written to in four hours — while the
 * header two inches away correctly said "+0 -0 across 2 files".
 */

import type { ChatMessage, ToolCall } from '@shared/types'

export type Op = 'read' | 'write' | 'edit'

const FILE_TOOLS: Record<string, Op> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit'
}

/**
 * The executor's own phrasing for a change: "Wrote golf.js (+12 -3, 4.1 kB)".
 *
 * The opening parenthesis is deliberate. Without it the pattern matches bare
 * arithmetic, which is everywhere in source code.
 */
const STAT_RE = /\(\+(\d+) -(\d+)/

export interface Touched {
  path: string
  ops: Op[]
  added: number
  removed: number
  at: number
  failed: boolean
}

function pathArg(call: ToolCall): string | null {
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    if (parsed && typeof parsed === 'object' && 'path' in parsed) {
      const p = (parsed as { path: unknown }).path
      if (typeof p === 'string' && p.trim() !== '') return p
    }
  } catch {
    // Arguments can still be a partial JSON fragment mid-stream. Nothing to show.
  }
  return null
}

/** Newest first: the file just touched is the one being looked for. */
export function deriveTouched(messages: ChatMessage[]): Touched[] {
  const byPath = new Map<string, Touched>()
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      if (call.origin !== 'native') continue
      const op = FILE_TOOLS[call.name]
      if (!op) continue
      const path = pathArg(call)
      if (!path) continue

      const existing = byPath.get(path) ?? {
        path,
        ops: [] as Op[],
        added: 0,
        removed: 0,
        at: 0,
        failed: false
      }
      if (!existing.ops.includes(op)) existing.ops.push(op)
      existing.at = Math.max(existing.at, call.finishedAt ?? call.startedAt ?? msg.createdAt)
      if (call.status === 'error' || call.status === 'denied') existing.failed = true

      /* Only a write or an edit has a diff to report. A read's result is
         arbitrary file content and can contain anything at all. */
      const stat = op === 'read' ? null : STAT_RE.exec(call.result ?? '')
      if (stat) {
        existing.added += Number(stat[1])
        existing.removed += Number(stat[2])
      }
      byPath.set(path, existing)
    }
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at)
}
