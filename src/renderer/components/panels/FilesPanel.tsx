import { useMemo, useState, type JSX } from 'react'
import { useStore } from '@renderer/state/store'
import { basename, relativeTime, shortenPath } from '@renderer/lib/format'
import { deriveTouched } from '@renderer/lib/touched'
import LiveBrowserStrip from './LiveBrowserStrip'
import './panels.css'
import { RunLog } from './RunLog'

/**
 * The code workflow's panel: what the agent is allowed to touch, and what it
 * actually touched.
 *
 * The touched-file list is derived from the conversation's own tool calls rather
 * than tracked separately, so it can never disagree with the transcript.
 */

export function FilesPanel(): JSX.Element {
  const roots = useStore((s) => s.settings.workspaceRoots)
  const addWorkspaceRoot = useStore((s) => s.addWorkspaceRoot)
  const removeWorkspaceRoot = useStore((s) => s.removeWorkspaceRoot)
  const [adding, setAdding] = useState(false)
  const conversation = useStore((s) => s.conversation)

  const touched = useMemo(() => deriveTouched(conversation?.messages ?? []), [conversation])

  return (
    <div className="fil-wrap">
      {/* Above the workspace, because while it is there it is the thing you
          are watching — and it is only there while the model is driving. */}
      <LiveBrowserStrip />
      <RunLog />
      <section className="fil-block">
        <div className="fil-block-head">
          <span className="section-label">Sandbox</span>
          {/* The picker belongs HERE, where the sandbox is shown. It used to
              exist only in Settings, so "choose the folder I want to work in"
              had no answer anywhere in the Code workflow. */}
          <button
            type="button"
            className="btn btn-sm fil-add"
            disabled={adding}
            onClick={() => {
              setAdding(true)
              void addWorkspaceRoot().finally(() => setAdding(false))
            }}
            title="Choose a folder the agent may read, write and run commands in"
          >
            {adding ? 'Choosing…' : 'Add folder'}
          </button>
        </div>
        {roots.length === 0 ? (
          <p className="pnl-empty pnl-empty-tight">
            No workspace roots yet. Until one is added, every file tool and every shell
            command is refused before it is even offered for approval. Add the folder
            you want to work in.
          </p>
        ) : (
          <ul className="fil-roots">
            {roots.map((root) => (
              <li key={root} className="fil-root" title={root}>
                <span className="fil-root-name">{basename(root)}</span>
                <span className="fil-root-path">{shortenPath(root, 3)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm fil-root-x"
                  title={`Remove ${root} from the sandbox`}
                  aria-label={`Remove ${basename(root)}`}
                  onClick={() => void removeWorkspaceRoot(root)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fil-block">
        <div className="fil-block-head">
          {/* NOT "this session". This list is derived from the conversation's own
              tool calls, so it survives a restart and describes the thread, not
              the app run — which put it in flat contradiction with the activity
              ticker's "Nothing has happened yet" on a freshly launched app
              showing an old conversation. */}
          <span className="section-label">Touched in this chat</span>
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
                    title={`${f.path}\n${relativeTime(f.at)}\nRight-click for more`}
                    onClick={() => void window.harness.invoke('artifacts:reveal', f.path)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      void window.harness.invoke('files:contextMenu', f.path)
                    }}
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
