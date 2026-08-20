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

/**
 * Mirrors the orchestrator: takes [call, result] pairs, returns the 1-based
 * index of the call that gets stopped, or null.
 */
function firstTrip(sequence) {
  let lastCall = null
  let lastResult = null
  let repeats = 0
  for (let i = 0; i < sequence.length; i++) {
    const [call, result] = sequence[i]
    if (call === lastCall && repeats + 1 >= MAX_IDENTICAL_CALLS) return i + 1
    repeats = call === lastCall && result === lastResult ? repeats + 1 : 0
    lastCall = call
    lastResult = result
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

check('an empty turn does not trip', firstTrip([]) === null)
check('a single call does not trip', firstTrip([['a', '1']]) === null)

console.log(failures === 0 ? '\x1b[32mall loop-breaker checks passed\x1b[0m'
                           : `\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
