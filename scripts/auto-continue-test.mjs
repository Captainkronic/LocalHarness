#!/usr/bin/env node
/**
 * Carrying on after a recoverable stop, without a human.
 *
 * Two things end a turn with the work intact and an invitation to continue: the
 * step cap and the loop breaker giving up. That invitation is fine when someone
 * is watching and useless when nobody is — measured across a three-hour agentic
 * build, 4% of wall clock was the app idle waiting for a person to accept it,
 * and that was WITH someone watching.
 *
 * Source-level, like runaway-retry-test.mjs, because standing up a real turn
 * needs a live model. The properties worth protecting are structural: which
 * stops continue, which must not, and that it cannot run away.
 *
 *   node scripts/auto-continue-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`) }
}

const src = await readFile(join(ROOT, 'src/main/orchestrator.ts'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const types = await readFile(join(ROOT, 'src/shared/types.ts'), 'utf8')
const settings = await readFile(join(ROOT, 'src/main/store/settings.ts'), 'utf8')

console.log('\n\x1b[1mauto-continue\x1b[0m')

const block = code.slice(code.indexOf('let left = Math'), code.indexOf('let left = Math') + 900)
check('the loop exists', block.length > 50)
check('it is driven by a setting', /autoContinueTurns/.test(block))
check('it is OFF by default',
  /autoContinueTurns: 0,/.test(settings),
  'a harness that keeps working after saying it stopped is a surprise')
check('the setting is clamped',
  /asClampedNumber\(src\.autoContinueTurns, 0, 50\)/.test(settings))

console.log('\n\x1b[1mIt continues only RECOVERABLE stops\x1b[0m')
check('the step cap continues', /stoppedAtCap === true/.test(block))
check('a loop-breaker stop continues', /stoppedLooping === true/.test(block))
check('both are TYPED markers, not matched text',
  /stoppedLooping\?: boolean/.test(types) && /stoppedAtCap\?: boolean/.test(types),
  'deciding to spend another turn must not depend on a sentence that exists to be reworded')
check('the loop breaker actually sets its marker',
  /assistant\.stoppedLooping = true/.test(code),
  'the marker is read but never written, so it would never continue')
check('it stops when the last message is anything else',
  /if \(!recoverable\) break/.test(block),
  'a real error, a cancel, or a finished model must all stay stopped')

console.log('\n\x1b[1mIt cannot run away\x1b[0m')
check('each continuation is counted off', /left -= 1/.test(block))
check('the loop is bounded by the counter', /while \(left > 0/.test(block))
check('it refuses to start on top of a running turn', /!this\.active/.test(block),
  'two turns in one conversation would interleave their tool calls')
check('the counter is per user message, not global',
  /let left = Math\.max\(0, Math\.round\(this\.d\.settings\.get\(\)\.autoContinueTurns/.test(block),
  'read fresh inside runAndReport, so each thing asked for gets its own allowance')
check('it says so in the log rather than continuing silently',
  /continuing on its own/.test(code))


console.log('\n\x1b[1mthe window is re-learned per request\x1b[0m')
/* A turn here can run for hours, and the model's real context window can change
   under it — an idle eviction plus a JIT reload, or someone reloading the server
   with a different context length. Observed: the meter read 131k against a real
   slot of 98,304 for the whole life of a running turn, and the history budget is
   derived from the same number, so the trimmer worked to a ceiling a third
   higher than the one that existed. */
const loop = code.slice(code.indexOf('for (let iteration = 0'), code.indexOf('for (let iteration = 0') + 4000)
check('learn() is called inside the request loop',
  /await this\.d\.models\.learn\(model\.id\)/.test(loop),
  'learning once per turn cannot notice a window that changes mid-turn')
check('the history budget is recomputed inside the loop too',
  /const budget = this\.historyBudget\(model, conv\.workflowId, toolTokensForBudget\)/.test(loop),
  'a budget derived from a window that later changed trims confidently to the wrong ceiling')
check('the tool-token term is still computed once, outside',
  /const toolTokensForBudget = /.test(code) &&
  !/const toolTokensForBudget = /.test(loop),
  'the tool list does not change within a turn; re-stringifying it every request is waste')

console.log(failures === 0 ? '\n\x1b[32mall auto-continue checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
