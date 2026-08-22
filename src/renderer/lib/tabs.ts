/**
 * One tab per file the agent touched, with what it did to each.
 *
 * A pure function, and in its own module for that reason: it lived inside
 * CodeWorkspace.tsx, which pulls in the store, the chat view and a stylesheet,
 * so nothing could test it without standing up the whole renderer. The counting
 * rules here are exactly the kind that go quietly wrong.
 */
import type { FileActivity, FileOpKind } from '@shared/types'
import { basename } from '@renderer/lib/format'

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
  /**
   * This file was actually MODIFIED, not merely opened.
   *
   * The "+N -M across K files" readout used the tab count, and the strip holds
   * a tab for every file touched — including ones only read, and including
   * writes the user denied at the approval gate. Two of ten files in one run
   * were never written to, and a denied write still added its file to the
   * count, unmarked. A change summary must count changes.
   */
  changed: boolean
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
      failed: false,
      changed: false
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
      if (a.kind === 'write' || a.kind === 'edit') {
        tab.latest = a
        tab.changed = true
      }
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
