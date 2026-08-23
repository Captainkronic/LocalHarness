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
const lb = await readFile(join(ROOT, 'src/main/agent/loopbreak.ts'), 'utf8')

console.log('\n\x1b[1mauto-continue\x1b[0m')

const block = code.slice(code.indexOf('let left = Math'), code.indexOf('let left = Math') + 900)
check('the loop exists', block.length > 50)
/*
 * The three checks below this were all true of code that never ran. The guard
 * used to be `while (left > 0 && !this.active)`, and `this.active` is cleared by
 * endTurn() in the `finally` of the try block this loop lives inside — so it was
 * still set every time the condition was evaluated, and the body never executed
 * once. A source-text test cannot see that. This one imports the decision and
 * runs it, which is the only way the property survives.
 */
check('the guard does not test this.active',
  !/while\s*\([^)]*!this\.active/.test(block),
  'that condition is false at this point in the turn — the loop would be dead code')
check('it is driven by a setting', /autoContinueTurns/.test(block))
check('it is OFF by default',
  /autoContinueTurns: 0,/.test(settings),
  'a harness that keeps working after saying it stopped is a surprise')
check('the setting is clamped',
  /asClampedNumber\(src\.autoContinueTurns, 0, 50\)/.test(settings))

console.log('\n\x1b[1mIt continues only RECOVERABLE stops\x1b[0m')
/* These two now live in canAutoContinue and are PROVEN by executing it further
   down. Here we only confirm the orchestrator still defers to it rather than
   growing a second, divergent copy of the rule. */
check('the orchestrator asks canAutoContinue', /canAutoContinue\(/.test(block))
check('a truncated turn is marked, not silently accepted',
  /stoppedTruncated = true/.test(code),
  'finish_reason length with no tool calls is a failed turn')
check('and the marking does not require an empty reply',
  !/finishReason === 'length' && !assistant\.content\.trim\(\)/.test(code),
  'the expensive case writes 45KB into the reply first, then hits the cap')
check('and the model is told why, in the transcript',
  /Your last reply was cut off at the output cap/.test(src),
  'error is not forwarded to the model; a resumed turn that does not know why it stopped repeats it')
check('and does not re-implement the decision inline',
  !/const recoverable\s*=/.test(block),
  'two copies of this rule would drift, and the inline copy is the one that was dead')
/* The log line does still read the markers, to name which stop happened. That
   is reporting, not deciding, and it is why the check above targets the
   `recoverable` binding rather than any mention of the marker names. */
check('the log still names which stop it is recovering from',
  /loop breaker stopped the last turn/.test(block))
check('both are TYPED markers, not matched text',
  /stoppedLooping\?: boolean/.test(types) && /stoppedAtCap\?: boolean/.test(types),
  'deciding to spend another turn must not depend on a sentence that exists to be reworded')
check('the loop breaker actually sets its marker',
  /assistant\.stoppedLooping = true/.test(code),
  'the marker is read but never written, so it would never continue')
check('the marker rule is stated once, in loopbreak',
  /stoppedAtCap === true \|\| last\.stoppedLooping === true/.test(lb),
  'a real error, a cancel, or a finished model must all stay stopped')

console.log('\n\x1b[1mIt cannot run away\x1b[0m')
check('each continuation is counted off', /left -= 1/.test(block))
check('the loop is bounded by the counter', /left <= 0 \|\| aborted/.test(lb))
/* The old check here grepped for `!this.active`, calling it proof that a second
   turn could not start on top of a running one. It was never doing that job —
   at that point in the turn it was simply always false, which is what killed
   the feature. The real guarantees are elsewhere and are checked as such: a NEW
   turn is refused at the entry point, and continuations cannot interleave
   because the loop awaits each one. */
check('a new turn is still refused while one is running',
  /if \(this\.active\) \{[\s\S]{0,160}already running/.test(code),
  'that check belongs at the entry point, not in the continuation loop')
check('continuations are sequential, so they cannot interleave',
  /await this\.runTurn\(conv, model\)/.test(block))
check('an aborted turn is not continued', /aborted/.test(block),
  'cancel and shutdown both abort the controller')
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


console.log('\n\x1b[1mquit does not orphan a generation\x1b[0m')
/* Quitting tore down MCP, speech, polling and served folders but left the HTTP
   request to LM Studio open, so the server carried on generating a reply nobody
   would read. On a single-slot server the next request queued behind that
   orphan: a brand new run sat at "Reading 4.4k tokens of context" for NINE
   MINUTES before it started, with nothing about the app saying why. */
const main = await readFile(join(ROOT, 'src/main/index.ts'), 'utf8')
check('shutdown aborts the in-flight turn', /orchestrator\.abortActive\(\)/.test(main))
check('and does it BEFORE the slow teardown',
  main.indexOf('orchestrator.abortActive()') < main.indexOf('await mcp.shutdown()'),
  'aborting after several seconds of teardown leaves the server generating through all of it')
check('the orchestrator exposes an id-free abort', /abortActive\(\): void \{/.test(code),
  'cancel() needs a conversation id; shutdown has none and must not need one')
check('it aborts whatever is active', /this\.active\?\.controller\.abort\(\)/.test(code))

console.log(failures === 0 ? '\n\x1b[32mall auto-continue checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)

console.log('\n\x1b[1mthe decision, executed rather than grepped\x1b[0m')
{
  const { build } = await import('esbuild')
  const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { pathToFileURL } = await import('node:url')
  const dir = await mkdtemp(join(tmpdir(), 'lh-autocont-'))
  await wf(join(dir, 'e.ts'), `export { canAutoContinue } from '${ROOT}/src/main/agent/loopbreak'\n`)
  const out = join(dir, 'b.mjs')
  await build({
    entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
    platform: 'node', target: 'node22', logLevel: 'silent',
    alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main') }
  })
  const { canAutoContinue } = await import(pathToFileURL(out).href)

  const cap = { role: 'assistant', stoppedAtCap: true }
  const loop = { role: 'assistant', stoppedLooping: true }

  check('a step-cap stop continues', canAutoContinue(cap, 5, false) === true,
    'this is the exact case that was dead for a 132-minute unattended run')
  check('a loop-breaker stop continues', canAutoContinue(loop, 5, false) === true)
  /* Measured on an unattended overnight build: asked for a game, the model
     reasoned for 8,774 tokens and then wrote the whole program INTO the reply —
     44,948 characters, finish_reason "length", zero tool calls, nothing on
     disk. Nothing marked it, so nothing resumed it, and the server sat idle for
     three hours behind a UI showing a finished turn with a long answer in it. */
  const cut = { role: 'assistant', stoppedTruncated: true }
  check('a reply cut off at the output cap continues',
    canAutoContinue(cut, 5, false) === true,
    'without this the run just ends, and it ends looking successful')
  check('and it still stops when the budget is gone',
    canAutoContinue(cut, 0, false) === false)
  check('and when Stop was pressed', canAutoContinue(cut, 5, true) === false)
  check('a turn that just finished normally does NOT',
    canAutoContinue({ role: 'assistant' }, 5, false) === false)
  check('an errored turn does NOT',
    canAutoContinue({ role: 'assistant', error: 'boom' }, 5, false) === false)
  check('a user message does NOT', canAutoContinue({ role: 'user' }, 5, false) === false)
  check('nothing at all does NOT', canAutoContinue(undefined, 5, false) === false)

  console.log('\n\x1b[1mit still has to stop\x1b[0m')
  check('exhausted continuations stop', canAutoContinue(cap, 0, false) === false)
  check('a negative count stops', canAutoContinue(cap, -1, false) === false)
  check('Stop pressed mid-turn stops it', canAutoContinue(cap, 5, true) === false,
    'cancel and shutdown both abort the controller; neither may be followed by another turn')
  check('and abort beats a recoverable marker', canAutoContinue(loop, 99, true) === false)

  await rm(dir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
