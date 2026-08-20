#!/usr/bin/env node
/**
 * The loop breaker's arithmetic.
 *
 * Written because both halves are easy to get wrong in opposite directions: a
 * guard that fires on a legitimate repeat is worse than no guard, and one that
 * counts from the wrong end lets the loop run forever. The real failure it
 * models is measured — thirty consecutive browse_act calls with byte-identical
 * arguments pressed into a game-over screen.
 *
 *   node scripts/loop-breaker-test.mjs
 */
const MAX_IDENTICAL_CALLS = 6

/** Mirrors the orchestrator: returns the 1-based index of the call that trips it. */
function firstTrip(sequence) {
  let lastKey = ''
  let repeats = 0
  for (let i = 0; i < sequence.length; i++) {
    const key = sequence[i]
    repeats = key === lastKey ? repeats + 1 : 0
    lastKey = key
    if (repeats + 1 >= MAX_IDENTICAL_CALLS) return i + 1
  }
  return null
}

let failures = 0
const check = (name, ok, note = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}

const rep = (k, n) => Array.from({ length: n }, () => k)

console.log('loop breaker')

check('five identical calls are allowed', firstTrip(rep('a', 5)) === null,
  'a real sequence can legitimately repeat a few times')
check('the sixth identical call trips it', firstTrip(rep('a', 6)) === 6)
check('thirty identical calls trip at six, not thirty', firstTrip(rep('a', 30)) === 6,
  'the measured failure ran to thirty')

check('alternating calls never trip', firstTrip(['a','b','a','b','a','b','a','b','a','b']) === null,
  'pressing left, right, left is not a loop')
check('a repeat broken by one different call resets', firstTrip([...rep('a',5),'b',...rep('a',5)]) === null)
check('same tool with different arguments never trips',
  firstTrip(['press:Left','press:Right','press:Up','press:Down','press:Left','press:Right']) === null,
  'identity is name AND arguments')

check('the run that motivated this trips', firstTrip(rep('browse_act:{"action":"press","value":"ArrowLeft"}', 30)) === 6)
check('an empty turn does not trip', firstTrip([]) === null)
check('a single call does not trip', firstTrip(['a']) === null)

console.log(failures === 0 ? '\x1b[32mall loop-breaker checks passed\x1b[0m'
                           : `\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
