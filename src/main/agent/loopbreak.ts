/**
 * Deciding when a turn has stopped learning anything.
 *
 * Three rules, each added after a real run got past the ones before it. They
 * are cheap to get wrong in both directions: too eager stops a model doing the
 * job properly, too slow spends an entire budget going in circles.
 *
 * 1. IDENTICAL — same call, same result, six times running. Comparing results
 *    and not just arguments is what makes this mean "nothing is being learned"
 *    rather than "nothing is being varied": polling a live page with one
 *    expression is correct behaviour and answers differently each time.
 *
 * 2. NARROW — twelve calls carrying three or fewer distinct outcomes between
 *    them. Catches an alternating loop, which rule 1 cannot see because it
 *    never repeats consecutively. Measured on a run that spent three hours in a
 *    two-call cycle.
 *
 * 3. SHAPE — the same PROCEDURE repeating with nothing acted on. This one
 *    exists because rules 1 and 2 both sailed past a golf run that spent thirty
 *    browser calls in a three-call cycle: take a shot, read the score, ask a
 *    vision model where the ball is. Every outcome was distinct, so rule 2 saw
 *    twelve different things and shrugged — and it was right that they differed:
 *    the stroke count really was climbing.
 *
 *    What was actually wrong is that the loop was pure observation. It had
 *    already diagnosed the bug it was there to fix and never edited a file. So
 *    rule 3 keys on the SHAPE of the calls with prose arguments collapsed —
 *    the vision question was reworded every pass, which is what defeated rule 2
 *    — and only fires when nothing in the span wrote a file or ran a command.
 *    A loop that is touching the workspace is left alone, whatever it looks
 *    like, because that is a model doing something.
 */

/** Identical call AND identical result, consecutively. */
export const MAX_IDENTICAL_CALLS = 6

export const CYCLE_WINDOW = 12
export const CYCLE_DISTINCT = 3

/**
 * Shape cycles start at period 2. Period 1 — the same call over and over — is
 * rule 1's business, and rule 1 is right to demand identical RESULTS before it
 * fires. Claiming a period-1 shape cycle here would stop a model watching an
 * animation evolve.
 */
export const SHAPE_MIN_PERIOD = 2
export const SHAPE_MAX_PERIOD = 4
export const SHAPE_MIN_REPEATS = 3
/** Whatever the period, a cycle has to be this long before it counts. */
export const SHAPE_MIN_SPAN = 8

/**
 * Tools that DO something, as opposed to look at something.
 *
 * run_shell is on this list deliberately. A watcher written for these same runs
 * counted only write_file and edit_file as progress, and stopped a run for
 * "nothing written" at the exact moment the model was fixing the build by
 * copying a file into place with the shell. Tool names are a poor proxy for
 * work, and the honest direction to be wrong in is to assume a shell command
 * did something.
 */
const ACTING_TOOLS = new Set(['write_file', 'edit_file', 'run_shell'])

/**
 * Argument names whose value is prose: reworded freely without changing what
 * the call does.
 *
 * "Where is the ball now?" and "Where is the ball relative to the cup?" are the
 * same step of the same loop. Treating them as different calls is what let a
 * three-call cycle present itself as seven distinct ones.
 */
const PROSE_ARG_KEYS = new Set([
  'ask', 'prompt', 'question', 'instruction', 'hint',
  'description', 'reason', 'note', 'summary', 'goal', 'context'
])

export interface LoopEntry {
  /** Name and arguments verbatim. */
  callKey: string
  /** Name and arguments with prose values collapsed. */
  shapeKey: string
  /** A bounded digest of what came back. */
  resultKey: string
  /** True when this step wrote a file or ran a command. */
  acting: boolean
}

export interface LoopCall {
  name: string
  arguments: string
}

/** Replace prose values with a marker and sort keys, so only shape survives. */
export function collapseProse(argsJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return argsJson // still streaming, or not JSON at all
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return argsJson
  const rec = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec).sort()) {
    const value = rec[key]
    out[key] = PROSE_ARG_KEYS.has(key.toLowerCase()) && typeof value === 'string' ? '<prose>' : value
  }
  return JSON.stringify(out)
}

export function shapeKeyFor(calls: LoopCall[]): string {
  return calls.map((c) => `${c.name}:${collapseProse(c.arguments)}`).join('|')
}

export function callKeyFor(calls: LoopCall[]): string {
  return calls.map((c) => `${c.name}:${c.arguments}`).join('|')
}

export function isActing(calls: LoopCall[]): boolean {
  return calls.some((c) => ACTING_TOOLS.has(c.name))
}

/**
 * The shortest period whose repetition explains the tail of `history`, or null.
 *
 * Only considers spans in which nothing acted — see rule 3 above.
 */
export function shapeCyclePeriod(history: LoopEntry[]): number | null {
  for (let period = SHAPE_MIN_PERIOD; period <= SHAPE_MAX_PERIOD; period++) {
    const repeats = Math.max(SHAPE_MIN_REPEATS, Math.ceil(SHAPE_MIN_SPAN / period))
    const need = period * repeats
    if (history.length < need) continue
    const tail = history.slice(-need)
    if (tail.some((e) => e.acting)) continue
    if (!periodic(tail, period)) continue
    /*
     * The period has to be the SMALLEST one that explains the tail, and this is
     * not a nicety. A run of identical shapes satisfies every period there is,
     * so without this a model polling one expression down a live page — the
     * textbook thing this breaker must never stop — reads as a tidy two-step
     * cycle. A constant tail has period 1, which is rule 1's business, and rule
     * 1 is right to demand identical RESULTS before it fires.
     */
    let minimal = true
    for (let shorter = 1; shorter < period && minimal; shorter++) {
      if (periodic(tail, shorter)) minimal = false
    }
    if (minimal) return period
  }
  return null
}

function periodic(tail: LoopEntry[], period: number): boolean {
  for (let i = period; i < tail.length; i++) {
    if (tail[i]!.shapeKey !== tail[i - period]!.shapeKey) return false
  }
  return true
}

export interface LoopVerdict {
  rule: 'identical' | 'narrow' | 'shape'
  /** Reads after "stopped because ...". */
  why: string
}

/**
 * Whether the NEXT call should be refused, given everything so far.
 *
 * `history` is oldest-first and may be trimmed; only the tail is ever read.
 */
export function loopVerdict(history: LoopEntry[], next: LoopEntry): LoopVerdict | null {
  /* Rule 1: identical call and result, consecutively, ending at `next`.
     `next` has not run yet, so its result is unknown — what is asserted is that
     the five before it made the same call and got the same answer every time,
     which is what makes a sixth pointless. */
  const runLength = MAX_IDENTICAL_CALLS - 1
  if (history.length >= runLength) {
    const tail = history.slice(-runLength)
    const first = tail[0]!
    const stuck =
      first.callKey === next.callKey &&
      tail.every((e) => e.callKey === first.callKey && e.resultKey === first.resultKey)
    if (stuck) {
      return {
        rule: 'identical',
        why: `${nameOf(next)} returned the same result ${MAX_IDENTICAL_CALLS} times in a row`
      }
    }
  }

  /* Rule 2: a narrow window of outcomes. */
  if (history.length >= CYCLE_WINDOW) {
    const window = history.slice(-CYCLE_WINDOW)
    const distinct = new Set(window.map((e) => `${e.callKey}=>${e.resultKey}`)).size
    if (distinct <= CYCLE_DISTINCT) {
      return {
        rule: 'narrow',
        why:
          `the last ${CYCLE_WINDOW} tool calls produced only ${distinct} different ` +
          `outcomes between them`
      }
    }
  }

  /* Rule 3: the same procedure, repeating, acting on nothing. */
  const full = [...history, next]
  const period = shapeCyclePeriod(full)
  if (period !== null) {
    return {
      rule: 'shape',
      why:
        `the same ${period}-step sequence has now run ${countRepeats(full, period)} times ` +
        `without writing a file or running a command`
    }
  }

  return null
}

/** How many consecutive periods actually match at the tail, for the message. */
function countRepeats(history: LoopEntry[], period: number): number {
  let repeats = 1
  let i = history.length - period
  while (i - period >= 0) {
    let same = true
    for (let k = 0; k < period && same; k++) {
      if (history[i + k]!.shapeKey !== history[i - period + k]!.shapeKey) same = false
    }
    if (!same || history[i - period]!.acting) break
    repeats++
    i -= period
  }
  return repeats
}

function nameOf(entry: LoopEntry): string {
  const first = entry.callKey.split(':', 1)[0]
  return first !== undefined && first !== '' ? first : 'a tool'
}

/**
 * What to tell the MODEL when a rule fires.
 *
 * This is separate from the sentence shown to the user, and the distinction was
 * earned. The user-facing text said "Try something different — and if a check
 * keeps failing the same way, consider that the check itself may be wrong",
 * which was exactly right: a run stopped here after reading one function five
 * times because its edit "had not landed", when the edit had landed and the
 * browser was simply still running the module it loaded before the edit.
 *
 * The model never saw a word of it. Only `content` is forwarded from an
 * assistant message, and that advice lived on `assistant.error`. What the model
 * got was "Stopped: this was going in circles." — the verdict without the
 * diagnosis. So this text goes on the tool call's `error`, which IS forwarded,
 * and it is written to be acted on rather than read.
 */
export function loopAdvice(verdict: LoopVerdict, toolName: string): string {
  const head =
    verdict.rule === 'identical'
      ? `You have now called ${toolName} with the same arguments ${MAX_IDENTICAL_CALLS} times ` +
        `and had the same answer every time. It will keep being the same answer.`
      : verdict.rule === 'narrow'
        ? `Your last ${CYCLE_WINDOW} calls produced only a handful of distinct outcomes between ` +
          `them. You are circling.`
        : `You have repeated the same short sequence of calls several times without writing a ` +
          `file or running a command. Looking again is not going to change it.`

  return [
    head,
    'Nothing before this was lost — every earlier result still stands.',
    '',
    'Do not repeat that call. Consider that what you are CHECKING may be the wrong thing:',
    '- If you edited a file and a page still behaves the old way, RELOAD the page. An already-loaded',
    '  script does not pick up edits to the file it came from, so the source can be correct and the',
    '  running page still wrong.',
    '- If a test keeps failing identically, suspect the test before the code.',
    '- If you are reading a file to confirm an edit landed, the edit result already told you. Read',
    '  something you have not read, or measure the behaviour instead of the source.'
  ].join('\n')
}
