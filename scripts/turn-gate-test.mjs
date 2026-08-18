#!/usr/bin/env node
/**
 * When a spoken turn ends.
 *
 * Written because the failure it guards is silent: a pause mid-sentence sends
 * half a question, and the model answers the half confidently. Nothing about
 * that looks like a bug from either end — the user hears a reasonable answer to
 * something they did not finish asking.
 *
 *   node scripts/turn-gate-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'lh-gate-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { TurnGate } from '${ROOT}/src/renderer/components/live/turn-gate'\n`
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent'
})
const { TurnGate } = await import(pathToFileURL(outfile).href)

const FRAME = 32
const OPTS = { silenceMs: 700, pauseGraceMs: 700, maxUtteranceMs: 30_000 }

/** Runs a script of [speaking, ms] and returns every state it passed through. */
function run(script, opts = OPTS) {
  const gate = new TurnGate()
  const seen = []
  for (const [speaking, ms] of script) {
    for (let t = 0; t < ms; t += FRAME) {
      const state = gate.frame(speaking, FRAME, opts)
      seen.push(state)
      if (state === 'end') return { seen, endedAfter: seen.length * FRAME }
    }
  }
  return { seen, endedAfter: null }
}

console.log('\n\x1b[1msilence before anything is said\x1b[0m')
const quiet = run([[false, 5000]])
check('stays idle', quiet.seen.every((s) => s === 'idle'))
check('and never ends a turn that never started', quiet.endedAfter === null)

console.log('\n\x1b[1ma finished sentence\x1b[0m')
const done = run([
  [true, 1500],
  [false, 2000]
])
check('ends', done.endedAfter !== null)
check(
  'after silenceMs + pauseGraceMs of quiet, not before',
  done.endedAfter >= 1500 + 1400 && done.endedAfter <= 1500 + 1400 + FRAME * 2,
  `${done.endedAfter}ms`
)
check('and reports pausing on the way', done.seen.includes('pausing'))

console.log('\n\x1b[1mthe case this exists for\x1b[0m')
/* Half a second of hesitation mid-sentence — long enough to have been sent
   under the old single 700ms threshold. */
const hesitation = run([
  [true, 900],
  [false, 500],
  [true, 900],
  [false, 2000]
])
check('a mid-sentence pause does NOT end the turn early', hesitation.endedAfter > 900 + 500 + 900)
check(
  'it ends only after the second half finishes',
  hesitation.endedAfter >= 900 + 500 + 900 + 1400,
  `${hesitation.endedAfter}ms`
)

/* Several hesitations, each individually inside the grace. */
const rambling = run([
  [true, 600],
  [false, 900],
  [true, 600],
  [false, 900],
  [true, 600],
  [false, 2000]
])
check('and repeated pauses are still one turn', rambling.endedAfter >= 600 * 3 + 900 * 2 + 1400)

/* The boundary: a pause just short of the total window survives, one just past
   it does not. This is the pair that matters — an off-by-one here is either a
   turn that never ends or a grace that never applies. */
const justInside = run([
  [true, 500],
  [false, OPTS.silenceMs + OPTS.pauseGraceMs - FRAME * 2],
  [true, 500],
  [false, 2000]
])
check('a pause just inside the window holds the turn', justInside.endedAfter > 500 + 1400)

console.log('\n\x1b[1mthe settings actually apply\x1b[0m')
const noGrace = run([[true, 500], [false, 2000]], { ...OPTS, pauseGraceMs: 0 })
check(
  'a grace of 0 is the old behaviour, not a broken one',
  noGrace.endedAfter >= 500 + 700 && noGrace.endedAfter <= 500 + 700 + FRAME * 2,
  `${noGrace.endedAfter}ms`
)
check(
  'and it never reports pausing, because there is no hold',
  !noGrace.seen.includes('pausing')
)
const negative = run([[true, 500], [false, 2000]], { ...OPTS, pauseGraceMs: -500 })
check(
  'a negative grace cannot shorten the silence threshold',
  negative.endedAfter >= 500 + 700,
  `${negative.endedAfter}ms`
)
const long = run([[true, 500], [false, 5000]], { ...OPTS, pauseGraceMs: 2000 })
check(
  'a longer grace waits longer',
  long.endedAfter >= 500 + 2700,
  `${long.endedAfter}ms`
)

console.log('\n\x1b[1mthe ceiling still holds\x1b[0m')
const forever = run([[true, 60_000]], { ...OPTS, maxUtteranceMs: 3000 })
check('someone who never stops is cut off eventually', forever.endedAfter !== null)
check('at the ceiling', forever.endedAfter <= 3000 + FRAME, `${forever.endedAfter}ms`)

console.log('\n\x1b[1mreset\x1b[0m')
const gate = new TurnGate()
for (let i = 0; i < 40; i++) gate.frame(true, FRAME, OPTS)
gate.reset()
check('a reset gate is idle again', gate.frame(false, FRAME, OPTS) === 'idle')
check('and a fresh turn starts clean', gate.frame(true, FRAME, OPTS) === 'listening')

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
