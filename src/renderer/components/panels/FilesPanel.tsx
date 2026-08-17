import { useMemo, type JSX } from 'react'
import type { ToolCall } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename, relativeTime, shortenPath } from '@renderer/lib/format'
import './panels.css'

/**
 * The code workflow's panel: what the agent is allowed to touch, and what it
 * actually touched.
 *
 * The touched-file list is derived from the conversation's own tool calls rather
 * than tracked separately, so it can never disagree with the transcript.
 */

type Op = 'read' | 'write' | 'edit'

const FILE_TOOLS: Record<string, Op> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit'
}

/** Executors report changes as "(+12 -3)"; pick that up when it is there. */
const STAT_RE = /\+(\d+)\s*[,/]?\s*-(\d+)/

interface Touched {
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

export function FilesPanel(): JSX.Element {
  const roots = useStore((s) => s.settings.workspaceRoots)
  const conversation = useStore((s) => s.conversation)

  const touched = useMemo(() => {
    const byPath = new Map<string, Touched>()
    for (const msg of conversation?.messages ?? []) {
      for (const call of msg.toolCalls ?? []) {
        if (call.origin !== 'native') continue
        const op = FILE_TOOLS[call.name]
        if (!op) continue
        const path = pathArg(call)
        if (!path) continue

        const existing = byPath.get(path) ?? {
          path,
          ops: [],
          added: 0,
          removed: 0,
          at: 0,
          failed: false
        }
        if (!existing.ops.includes(op)) existing.ops.push(op)
        existing.at = Math.max(existing.at, call.finishedAt ?? call.startedAt ?? msg.createdAt)
        if (call.status === 'error' || call.status === 'denied') existing.failed = true

        const stat = STAT_RE.exec(call.result ?? '')
        if (stat) {
          existing.added += Number(stat[1])
          existing.removed += Number(stat[2])
        }
        byPath.set(path, existing)
      }
    }
    return [...byPath.values()].sort((a, b) => b.at - a.at)
  }, [conversation])

  return (
    <div className="fil-wrap">
      <section className="fil-block">
        <div className="fil-block-head">
          <span className="section-label">Sandbox</span>
          <span className="fil-count tnum">{roots.length}</span>
        </div>
        {roots.length === 0 ? (
          <p className="pnl-empty pnl-empty-tight">
            No workspace roots. Every file tool and every shell command will be refused
            before it is even offered for approval. Add a root in Settings.
          </p>
        ) : (
          <ul className="fil-roots">
            {roots.map((root) => (
              <li key={root} className="fil-root" title={root}>
                <span className="fil-root-name">{basename(root)}</span>
                <span className="fil-root-path">{shortenPath(root, 3)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fil-block">
        <div className="fil-block-head">
          <span className="section-label">Touched this session</span>
          <span className="fil-count tnum">{touched.length}</span>
        </div>
        {touched.length === 0 ? (
          <p className="pnl-empty pnl-empty-tight">
            Nothing touched yet. Files the agent reads, writes or edits in this
            conversation are listed here with their change stat.
          </p>
        ) : (
          <ul className="fil-list">
            {touched.map((f) => {
              const dir = f.path.split('/').slice(0, -1).join('/')
              return (
                <li key={f.path} className={f.failed ? 'fil-row is-failed' : 'fil-row'}>
                  <button
                    type="button"
                    className="fil-main"
                    title={`${f.path}\n${relativeTime(f.at)}`}
                    onClick={() => void window.harness.invoke('artifacts:reveal', f.path)}
                  >
                    <span className="fil-name">{basename(f.path)}</span>
                    <span className="fil-path">{shortenPath(dir, 2)}</span>
                  </button>
                  <span className="fil-ops">
                    {f.ops.map((op) => (
                      <span key={op} className={`fil-op is-${op}`}>
                        {op}
                      </span>
                    ))}
                  </span>
                  {f.added > 0 || f.removed > 0 ? (
                    <span className="fil-stat tnum">
                      <span className="fil-add">+{f.added}</span>
                      <span className="fil-del">-{f.removed}</span>
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

export default FilesPanel
