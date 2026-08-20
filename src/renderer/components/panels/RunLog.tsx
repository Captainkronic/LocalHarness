/**
 * What each prompt cost, in the workspace panel.
 *
 * The transcript already carries per-REQUEST metrics under every reply. This is
 * the other unit: one prompt and everything it caused, which is what a person
 * actually waits on and the only span they can compare between runs.
 *
 * The number this exists for is the model/tool split. A run that took twenty
 * minutes reads completely differently depending on whether the model was
 * generating for eighteen of them or waiting on a browser for sixteen — and
 * before this there was nowhere to find out. Both are printed, always, rather
 * than a single duration that quietly averages the two.
 */

import { useMemo, type JSX } from 'react'

import { formatMs, formatTokens, formatTps } from '@renderer/lib/format'
import { summariseRuns, type RunSummary } from '@renderer/lib/runs'
import { useStore } from '@renderer/state/store'
import './panels.css'

export function RunLog(): JSX.Element | null {
  const messages = useStore((s) => s.conversation?.messages)
  const runs = useMemo(() => summariseRuns(messages ?? []), [messages])
  if (runs.length === 0) return null

  /* Newest first: the run you just watched is the one you want to read. */
  const ordered = [...runs].reverse()

  return (
    <section className="rl">
      <div className="rl-head">
        <span className="section-label">Runs</span>
        <span className="rl-count tnum">{runs.length}</span>
      </div>
      <div className="rl-list">
        {ordered.map((r) => (
          <Run key={r.id} run={r} />
        ))}
      </div>
    </section>
  )
}

function Run({ run }: { run: RunSummary }): JSX.Element {
  const when = new Date(run.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <article className={run.error ? 'rl-run is-error' : 'rl-run'}>
      <header className="rl-run-head">
        <span className="rl-time tnum">{when}</span>
        {run.running ? (
          <span className="rl-live">running</span>
        ) : (
          <span className="rl-wall tnum" title="From sending to the last token, tools included">
            {formatMs(run.wallMs)}
          </span>
        )}
      </header>

      <p className="rl-prompt" title={run.prompt}>
        {run.prompt.trim() || '(no text)'}
      </p>

      {/* Split first, because it is the line that changes what you do next. */}
      {run.wallMs !== null ? (
        <p className="rl-split tnum">
          <span title="Time inside model requests">model {formatMs(run.modelMs)}</span>
          <span className="rl-sep">·</span>
          <span title="Everything that was not the model: tools, browser, shell">
            tools {formatMs(run.toolMs)}
          </span>
        </p>
      ) : null}

      <p className="rl-facts tnum">
        <span>
          {run.steps} step{run.steps === 1 ? '' : 's'}
        </span>
        {run.toolCalls > 0 ? (
          <>
            <span className="rl-sep">·</span>
            <span>{run.toolCalls} calls</span>
          </>
        ) : null}
        <span className="rl-sep">·</span>
        <span title="Tokens generated across the whole run">
          {formatTokens(run.completionTokens)} out
        </span>
        {run.reasoningTokens > 0 ? (
          <>
            <span className="rl-sep">·</span>
            <span title="Of which reasoning">{formatTokens(run.reasoningTokens)} thinking</span>
          </>
        ) : null}
        {/* Rates only when there is something behind them — a run with no
            generated tokens has no rate, and an em dash would imply one exists
            that we failed to read. */}
        {run.decodeTps !== null ? (
          <>
            <span className="rl-sep">·</span>
            <span title="Total tokens over total decode time, not an average of per-request rates">
              {formatTps(run.decodeTps)} tok/s
            </span>
          </>
        ) : null}
        <span className="rl-sep">·</span>
        <span title="Prompt size of the last request in the run">
          ctx {formatTokens(run.contextTokens)}
        </span>
      </p>

      {run.error ? <p className="rl-error">{firstLine(run.error)}</p> : null}
    </article>
  )
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]!.trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

export default RunLog
