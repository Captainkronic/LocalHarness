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
 * Rule 4's threshold: consecutive calls that looked without touching anything.
 *
 * Rules 1-3 all need REPETITION. Paralysis does not repeat — a model can read a
 * different region of the file, grep a different pattern and probe a different
 * expression every single time and still be no closer to writing a line. On a
 * mini-golf run this cost sixteen minutes and produced no edit; on another pass
 * it cost ten. Every call was distinct, so nothing fired.
 *
 * Fourteen is deliberately generous. Orientation at the start of a task is real
 * work and a model landing in an unfamiliar file should be allowed to look
 * around properly. What this catches is looking around INSTEAD of deciding, and
 * because it arrives as a nudge rather than a stop, a genuinely read-only task
 * — reviewing a diff, explaining a codebase — is told once and carries on.
 */
export const MAX_OBSERVING_CALLS = 14

/**
 * …and how few things it may have been looking AT for rule 4 to mean anything.
 *
 * Breadth is work. A model reading thirty different files is exploring a
 * codebase and must never be interrupted for it. What went wrong on the golf
 * run was narrow: fourteen reads of ONE file at shifting offsets, and page
 * probes against ONE url. Same tools, same absence of edits — but circling a
 * single artifact rather than covering ground.
 *
 * So rule 4 needs both halves: a long stretch that acted on nothing AND barely
 * any distinct targets in it.
 */
export const OBSERVING_MAX_TARGETS = 3

/**
 * Reasoning tokens a turn may spend across steps that changed nothing.
 *
 * The gap between the two guards that already exist. The runaway breaker counts
 * reasoning that produced NO output and is right to stand down the moment a
 * tool call appears; rule 4 counts calls that acted on nothing and cannot see
 * how expensive they were. Neither notices deliberation wildly out of
 * proportion to what it yielded.
 *
 * Measured on a flight-sim build, consecutive steps in one turn:
 *
 *     1,955 reasoning tokens  ->  one run_shell
 *       385 reasoning tokens  ->  one grep
 *     6,421 reasoning tokens  ->  two read_file calls
 *
 * That last step is about six minutes at 18 tok/s to decide to read two files,
 * and nothing anywhere was in a position to say so. Reasoning is billed against
 * the same budget as the reply, so this is not merely slow — it is the budget
 * being spent on deciding rather than doing.
 *
 * 12,000 is roughly eleven minutes of pure thinking on this hardware. Below
 * that a model is working; above it, with nothing written, it is circling in a
 * way the other rules cannot see.
 */
export const MAX_REASONING_WITHOUT_ACTING = 12_000

/**
 * …spread over at least this many steps.
 *
 * One enormous step is a hard problem being thought about properly, and
 * stopping that would be exactly the over-eager failure the file warns about.
 * Three in a row, all costly, none of them acting, is a pattern.
 */
export const PONDERING_MIN_STEPS = 3

/**
 * Argument keys that name the thing a call is aimed at, in priority order.
 *
 * `path` before `url` because an edit-and-check cycle names a file on one side
 * and a page on the other, and the file is the thing being circled.
 */
const TARGET_ARG_KEYS = ['path', 'file', 'filename', 'url', 'pattern']

/** What a call was aimed at: a path or url if it names one, else the tool. */
export function targetKeyFor(calls: LoopCall[]): string {
  return calls
    .map((c) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(c.arguments)
      } catch {
        return c.name
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return c.name
      const rec = parsed as Record<string, unknown>
      for (const key of TARGET_ARG_KEYS) {
        const v = rec[key]
        /* Collapsed, so ?retry=N does not make each look like a fresh target —
           that would defeat rule 4 the same way it defeated rules 1 to 3. */
        if (typeof v === 'string' && v !== '') return `${c.name}@${collapseUrl(v)}`
      }
      return c.name
    })
    .join('|')
}

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
  /**
   * What the call was aimed at — a path or url where one is named.
   *
   * Optional because rule 4 is the only reader: an entry without it counts as
   * its own target, which makes a caller that does not set it simply never
   * trip rule 4 rather than trip it wrongly.
   */
  target?: string
  /**
   * Reasoning tokens the request that produced this call spent.
   *
   * Optional, and absent means zero: a caller that does not report it simply
   * never trips rule 5 rather than tripping it wrongly.
   */
  reasoning?: number
}

export interface LoopCall {
  name: string
  arguments: string
}

/**
 * Collapse the query string of a URL value, keeping origin and path.
 *
 * A model that cannot see a change it expects will reach for cache busting —
 * `?retry=1`, `?retry=2`, `?t=<now>` — and that single varying token defeats
 * all three rules at once. It changes the callKey, so rule 1 never sees a
 * repeat; it changes the shapeKey, so rule 3 never sees a cycle; and because
 * page tools echo the URL back in their output it changes the resultKey too,
 * so rule 2 counts twelve distinct outcomes and shrugs.
 *
 * Observed live on a mini-golf run: thirty iterations of
 * `page_eval` + `read_file` at `?retry=1..30`, reading `ball: null` every time
 * because the page exposed no debug hook. Nothing stopped it, and the turn was
 * heading for a full context window.
 *
 * The query is dropped for SHAPE only. Two loads of the same path are the same
 * step of the same procedure, which is precisely what shape is meant to
 * capture. Rule 3 still fires only when nothing in the span wrote a file or ran
 * a command, so a model genuinely walking `?hole=1..9` while building is left
 * alone — and a constant tail collapses to period 1, which is rule 1's
 * business and needs identical RESULTS before it acts.
 */
function collapseUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value
  try {
    const u = new URL(value)
    return u.search ? `${u.origin}${u.pathname}?<query>` : value
  } catch {
    return value // not parseable; leave it verbatim rather than guess
  }
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
    out[key] =
      typeof value !== 'string'
        ? value
        : PROSE_ARG_KEYS.has(key.toLowerCase())
          ? '<prose>'
          : collapseUrl(value)
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
  rule: 'identical' | 'narrow' | 'shape' | 'observing' | 'pondering'
  /** Reads after "stopped because ...". */
  why: string
}

/**
 * Collapse cache-busting query strings inside a RESULT digest.
 *
 * The mirror of `collapseUrl()`, and needed for the same live failure. Rule 2
 * compares OUTCOMES, and the page tools echo the requested URL back into their
 * output — "PAGE EVAL http://127.0.0.1:57619/index.html?retry=31 …". A model
 * varying ?retry=N therefore produced a distinct result string on every pass
 * even though the answer never changed, so twelve identical readings of
 * `ball: null` counted as twelve different outcomes and rule 2 stood down.
 *
 * Normalising here rather than in the tool keeps the model's own view of the
 * result honest — it still sees the URL it asked for.
 */
export function collapseResultUrls(text: string): string {
  return (
    text
      .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?<query>')
      /*
       * Elapsed-time stamps, for the same reason as the query string.
       *
       * The page tools head their output with how long the call took —
       * "PAGE EVAL http://…/index.html   (0.02s)". That is tool chrome, not an
       * answer, and it jitters. Caught live on a flight-sim run: thirty
       * page_eval calls with BYTE-IDENTICAL arguments all returning
       * {"vBefore":0,"dz":0}, where the only difference between results was
       * (0.02s) versus (0.01s). Ten milliseconds of noise was enough to break
       * rule 1's run of identical results and to inflate rule 2's outcome
       * count from three to four.
       *
       * Only a parenthesised duration is collapsed. A bare number in the
       * output is data — a measured airspeed, a token count — and must survive.
       */
      .replace(/\((\d+(?:\.\d+)?)\s*(ms|s)\)/gi, '(<elapsed>)')
  )
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

  /* Rule 5: thinking far more than it is doing.
     Before rule 4 because it names the sharper fault when both apply — the
     problem is not that fourteen calls looked, it is that the looking cost a
     budget. Walks back over the trailing non-acting steps only. */
  {
    let spent = 0
    let steps = 0
    for (let i = full.length - 1; i >= 0; i--) {
      const e = full[i]!
      if (e.acting) break
      spent += e.reasoning ?? 0
      steps++
    }
    if (steps >= PONDERING_MIN_STEPS && spent > MAX_REASONING_WITHOUT_ACTING) {
      return {
        rule: 'pondering',
        why:
          `the last ${steps} steps spent about ${Math.round(spent / 1000)}k tokens thinking ` +
          `and did not write a file or run a command`
      }
    }
  }

  /* Rule 4: looking, repeatedly, without ever touching anything.
     Last, because rules 1-3 name a sharper fault when they apply. This one
     needs no repetition at all — only that nothing in a long stretch acted. */
  if (full.length >= MAX_OBSERVING_CALLS) {
    const tail = full.slice(-MAX_OBSERVING_CALLS)
    /* An entry with no target counts as unique, so a caller that never sets one
       accumulates MAX_OBSERVING_CALLS distinct targets and this stays quiet. */
    const targets = new Set(tail.map((e, i) => e.target ?? `#${i}`))
    if (tail.every((e) => !e.acting) && targets.size <= OBSERVING_MAX_TARGETS) {
      return {
        rule: 'observing',
        why:
          `the last ${MAX_OBSERVING_CALLS} tool calls only looked at ${targets.size} ` +
          `thing(s) — nothing was written and no command was run`
      }
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
        : verdict.rule === 'pondering'
          ? `You have spent thousands of tokens thinking across your last few steps and have ` +
            `not written a file or run a command in any of them.`
          : verdict.rule === 'observing'
            ? `Your last ${MAX_OBSERVING_CALLS} calls all looked at things — reading, grepping, ` +
              `probing — and not one of them changed anything.`
            : `You have repeated the same short sequence of calls several times without writing a ` +
              `file or running a command. Looking again is not going to change it.`

  /* Paralysis needs different advice from repetition. Telling a model that has
     never acted "do not repeat that call" is answering a question it did not
     ask; what it needs is permission to commit to an imperfect first version. */
  if (verdict.rule === 'observing' || verdict.rule === 'pondering') {
    return [
      head,
      'Nothing before this was lost — every earlier result still stands.',
      '',
      'You have enough to act. Make the change now, then judge it by what happens:',
      '- Write the simplest version that could work. It does not have to be right first time —',
      '  a wrong edit you can see the result of teaches you more than another read.',
      '- If you are weighing exact values (a radius, a timeout, a coefficient), pick a reasonable',
      '  one, write it, look at the result, and adjust. Deciding it in your head is slower and',
      '  less reliable than measuring it.',
      '- If you are re-reading to remind yourself what the code looks like, you already read it.',
      '  Act on what you have; read again only when an edit fails.'
    ].join('\n')
  }

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

/**
 * Whether an unattended run may take another turn by itself.
 *
 * This lived inline in the orchestrator as `while (left > 0 && !this.active)`,
 * and in that position the guard could never be true. `this.active` is cleared
 * by `endTurn()`, which runs in the `finally` of the same try block the loop
 * sits inside — so at the moment the condition was evaluated the turn that had
 * just ended was still, correctly, marked active. The loop body never executed
 * once. `autoContinueTurns` was set to 5 for a 132-minute unattended build and
 * every step-cap and loop-breaker stop still ended the run for good.
 *
 * The old test asserted the loop existed, was driven by the setting, and was
 * off by default. All three were true of dead code. That is the argument for
 * this being a function: a condition that can be executed in a test can be
 * proven reachable, and an inline one cannot.
 *
 * `aborted` is the thing that guard was reaching for. Cancel and shutdown both
 * abort the controller, and neither should be followed by another turn. A model
 * that simply finished, or errored, never sets the two markers and stops here
 * regardless.
 */
export function canAutoContinue(
  last: { role?: string; stoppedAtCap?: boolean; stoppedLooping?: boolean } | undefined,
  left: number,
  aborted: boolean
): boolean {
  if (left <= 0 || aborted) return false
  if (last === undefined || last.role !== 'assistant') return false
  return last.stoppedAtCap === true || last.stoppedLooping === true
}
