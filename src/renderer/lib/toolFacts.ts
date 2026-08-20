/**
 * Turning a tool's structured result into the one line a collapsed card shows.
 *
 * The gap this fills: a coding run is mostly shell calls, and every one of them
 * used to render as an identical grey row whose only visible content was the
 * command. Whether it worked was one click away, sixteen times over, so nobody
 * clicked and nobody could read the transcript.
 *
 * This reads `structured`, never the result text. The text is written for the
 * model and gets reworded; the facts do not.
 */

import type { ServeResultFacts, ShellResultFacts } from '@shared/types'

export interface ToolOutcome {
  /** Terse status, e.g. "exit 0", "timed out", "serving". */
  status: string
  tone: 'ok' | 'bad'
  /** The most informative single line the tool produced. May be empty. */
  detail: string
  /** True when `detail` is an error, so it can be coloured as one. */
  detailIsError: boolean
  /** Dim trailing context, e.g. "47 lines". */
  note: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function toolOutcome(structured: unknown): ToolOutcome | null {
  if (!isRecord(structured)) return null
  if (structured.kind === 'shell') return shellOutcome(structured as unknown as ShellResultFacts)
  if (structured.kind === 'serve') return serveOutcome(structured as unknown as ServeResultFacts)
  return null
}

function shellOutcome(f: ShellResultFacts): ToolOutcome {
  const failed = f.timedOut || f.exitCode !== 0
  const status = f.timedOut
    ? 'timed out'
    : f.exitCode === null
      ? 'killed'
      : `exit ${f.exitCode}`

  /* Line counts are the cue for "there is more here than this one line". One
     line of output needs no annotation — saying "1 line" beside the line
     itself is noise. */
  const parts: string[] = []
  if (f.stdoutLines > 1) parts.push(`${f.stdoutLines} lines`)
  if (f.stderrLines > 0 && !f.headlineFromStderr) {
    parts.push(`${f.stderrLines} on stderr`)
  }

  return {
    status,
    tone: failed ? 'bad' : 'ok',
    detail: f.headline,
    /* Silence with a zero exit is a success, and the commonest one: mv, mkdir,
       a passing check. Say so rather than leaving the row looking unfinished. */
    detailIsError: f.headlineFromStderr,
    note: parts.join(' · ')
  }
}

function serveOutcome(f: ServeResultFacts): ToolOutcome {
  return {
    status: f.reused ? 'already up' : 'serving',
    tone: 'ok',
    detail: f.origin,
    detailIsError: false,
    note: f.pages.length > 0 ? `${f.pages.length} page${f.pages.length === 1 ? '' : 's'}` : ''
  }
}

/** Empty output with a clean exit still deserves a word. */
export function outcomeDetail(o: ToolOutcome): string {
  if (o.detail !== '') return o.detail
  return o.tone === 'ok' ? 'no output' : ''
}
