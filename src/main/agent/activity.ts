/**
 * Live filesystem-effect stream for the Code workspace.
 *
 * The chat transcript already shows tool CALLS. This is the other half: what
 * those calls did to the disk, emitted as it happens, so the workspace can jump
 * to the file being written and mark the lines that changed instead of
 * reporting after the fact.
 *
 * Deliberately separate from ToolCall — a ToolCall is a record of a request,
 * this is a stream of effects, and the two have different lifetimes (a single
 * `write_file` call is one ToolCall but a start/done activity pair).
 */

import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'

import type { FileActivity, FileOpKind, FileOpPhase, TouchedFile } from '@shared/types'

/** Per conversation. An agentic run generates a lot of these. */
const ACTIVITY_CAP = 500
/** Files above this are summarised rather than shipped to the viewer whole. */
const CONTENT_CAP_BYTES = 512 * 1024

export interface ActivityInput {
  conversationId: string
  kind: FileOpKind
  phase: FileOpPhase
  target: string
  diff?: string
  added?: number
  removed?: number
  changedLines?: number[]
  content?: string
  summary?: string
  error?: string
  durationMs?: number
  /** Reuse an id to continue an operation started earlier (start -> done). */
  id?: string
}

export class ActivityTracker {
  private readonly byConversation = new Map<string, FileActivity[]>()
  private readonly touched = new Map<string, Map<string, TouchedFile>>()
  private readonly onActivity: (a: FileActivity) => void
  private getRoots: () => string[]

  constructor(opts: {
    onActivity: (a: FileActivity) => void
    getRoots: () => string[]
  }) {
    this.onActivity = opts.onActivity
    this.getRoots = opts.getRoots
  }

  record(input: ActivityInput): FileActivity {
    const activity: FileActivity = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      kind: input.kind,
      phase: input.phase,
      target: input.target,
      displayPath: this.display(input.target),
      diff: input.diff,
      added: input.added,
      removed: input.removed,
      changedLines: input.changedLines,
      // A megabyte of file text per keystroke-sized edit would swamp the IPC
      // channel; the viewer re-reads large files on demand instead.
      content:
        input.content !== undefined && input.content.length <= CONTENT_CAP_BYTES
          ? input.content
          : undefined,
      summary: input.summary,
      error: input.error,
      at: Date.now(),
      durationMs: input.durationMs
    }

    const list = this.byConversation.get(input.conversationId) ?? []
    list.push(activity)
    if (list.length > ACTIVITY_CAP) list.splice(0, list.length - ACTIVITY_CAP)
    this.byConversation.set(input.conversationId, list)

    if (activity.phase === 'done' && isFileOp(activity.kind)) {
      this.noteTouched(activity)
    }

    this.onActivity(activity)
    return activity
  }

  activity(conversationId: string): FileActivity[] {
    return this.byConversation.get(conversationId) ?? []
  }

  touchedFiles(conversationId: string): TouchedFile[] {
    const map = this.touched.get(conversationId)
    if (!map) return []
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
  }

  clear(conversationId: string): void {
    this.byConversation.delete(conversationId)
    this.touched.delete(conversationId)
  }

  private noteTouched(a: FileActivity): void {
    const map = this.touched.get(a.conversationId) ?? new Map<string, TouchedFile>()
    const prev = map.get(a.target)
    map.set(a.target, {
      path: a.target,
      displayPath: a.displayPath,
      lastKind: a.kind,
      added: (prev?.added ?? 0) + (a.added ?? 0),
      removed: (prev?.removed ?? 0) + (a.removed ?? 0),
      touches: (prev?.touches ?? 0) + 1,
      lastAt: a.at
    })
    this.touched.set(a.conversationId, map)
  }

  /** Shortest path relative to any workspace root, so the tab strip is readable
   *  without losing which root a file came from. */
  private display(target: string): string {
    let best = target
    for (const root of this.getRoots()) {
      const rel = relative(root, target)
      if (rel && !rel.startsWith('..') && rel.length < best.length) best = rel
    }
    return best
  }
}

function isFileOp(kind: FileOpKind): boolean {
  return kind === 'read' || kind === 'write' || kind === 'edit'
}

/** Line numbers a unified diff touches on the new side, for the viewer's
 *  highlight-and-scroll. Parses the @@ headers rather than re-diffing. */
export function changedLinesFromDiff(diff: string): number[] {
  const lines: number[] = []
  let cursor = 0
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      cursor = Number(hunk[1])
      continue
    }
    if (cursor === 0) continue
    if (line.startsWith('+')) {
      lines.push(cursor)
      cursor += 1
    } else if (line.startsWith('-')) {
      // Removed lines do not advance the new-side cursor.
    } else if (line.startsWith(' ')) {
      cursor += 1
    }
  }
  return lines
}
