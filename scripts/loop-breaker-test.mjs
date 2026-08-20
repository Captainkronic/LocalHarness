#!/usr/bin/env node
/**
 * The loop breaker's arithmetic.
 *
 * Two ways to get this wrong, in opposite directions, and both look fine on
 * screen. Too eager and it stops a model doing the job properly — polling a
 * live page returns a different answer every time and is exactly right. Too
 * slow and a stuck turn spends its whole budget: the run that prompted this
 * issued the same call THIRTY times into a game-over screen.
 *
 * The rule is therefore about what is LEARNED, not what is varied: identical
 * call and identical result.
 *
 *   node scripts/loop-breaker-test.mjs
 */
const MAX_IDENTICAL_CALLS = 6
const CYCLE_WINDOW = 12
const CYCLE_DISTINCT = 3

/**
 * Mirrors the orchestrator: takes [call, result] pairs, returns the 1-based
 * index of the call that gets stopped, or null.
 */
function firstTrip(sequence) {
  let lastCall = null
  let lastResult = null
  let repeats = 0
  const recent = []
  for (let i = 0; i < sequence.length; i++) {
    const [call, result] = sequence[i]
    const repeating = call === lastCall && repeats + 1 >= MAX_IDENTICAL_CALLS
    const cycling =
      recent.length >= CYCLE_WINDOW &&
      new Set(recent.slice(-CYCLE_WINDOW)).size <= CYCLE_DISTINCT
    if (repeating || cycling) return i + 1
    repeats = call === lastCall && result === lastResult ? repeats + 1 : 0
    lastCall = call
    lastResult = result
    recent.push(`${call}=>${result}`)
    if (recent.length > CYCLE_WINDOW * 2) recent.shift()
  }
  return null
}

let failures = 0
const check = (name, ok, note = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}
const same = (n) => Array.from({ length: n }, () => ['poll', 'unchanged'])
const moving = (n) => Array.from({ length: n }, (_, i) => ['poll', `frame-${i}`])

console.log('loop breaker')

check('a few identical outcomes are allowed', firstTrip(same(5)) === null)
check('the seventh identical outcome is stopped', firstTrip(same(7)) === 7)
check('thirty identical outcomes stop early, not at thirty', firstTrip(same(30)) === 7,
  'the measured failure ran to thirty')

/* The case that made this rule change. */
check('POLLING A LIVE PAGE NEVER TRIPS', firstTrip(moving(50)) === null,
  'same call, different answer each time — that is the job, not a loop')
check('polling that goes dead still trips',
  firstTrip([...moving(10), ...same(10)]) === 17,
  'it only stops once the answers stop changing')

check('alternating calls never trip',
  firstTrip([['a','1'],['b','2'],['a','1'],['b','2'],['a','1'],['b','2'],['a','1'],['b','2']]) === null,
  'left, right, left is not a loop')
check('one different call resets the count',
  firstTrip([...same(5), ['other', 'x'], ...same(5)]) === null)
check('same result from a DIFFERENT call does not count',
  firstTrip(Array.from({ length: 10 }, (_, i) => [`call-${i}`, 'same'])) === null,
  'progress can legitimately keep returning the same value')

/* The three-hour golf run: two calls, two outcomes, forever. Consecutive
   checking is blind to it because neither ever repeats back to back. */
const cycle = (pairs, n) =>
  Array.from({ length: n }, (_, i) => pairs[i % pairs.length])
check('A TWO-CALL CYCLE IS CAUGHT', firstTrip(cycle([['ls', 'unchanged'], ['test', 'AssertionError']], 40)) === 13,
  'ran 124 calls over three hours before this existed')
check('a three-call cycle is caught',
  firstTrip(cycle([['a', '1'], ['b', '2'], ['c', '3']], 40)) === 13)
check('a four-call cycle is allowed',
  firstTrip(cycle([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']], 40)) === null,
  'four distinct outcomes is work, not a circle')
check('varied work never trips',
  firstTrip(Array.from({ length: 60 }, (_, i) => [`call-${i % 9}`, `r-${i}`])) === null)
check('a short alternation is allowed to finish',
  firstTrip(cycle([['a', '1'], ['b', '2']], 11)) === null,
  'the window has to fill before it can judge')

check('an empty turn does not trip', firstTrip([]) === null)
check('a single call does not trip', firstTrip([['a', '1']]) === null)

console.log(failures === 0 ? '\x1b[32mall loop-breaker checks passed\x1b[0m'
                           : `\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
