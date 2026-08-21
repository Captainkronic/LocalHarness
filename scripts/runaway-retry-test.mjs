#!/usr/bin/env node
/**
 * The runaway breaker's rescue attempt must actually be sent.
 *
 * The breaker aborts the in-flight request when a turn has spent its reasoning
 * budget with nothing written, then retries once with thinking off. That retry
 * reused the SAME AbortController — already aborted — so the rescue request
 * died before it sent a byte and the turn ended empty. It had therefore never
 * worked, and the failure is invisible from outside: an empty reply looks like
 * the model giving up, not like the harness cancelling itself.
 *
 * Source-level, because standing up a real turn needs a live model, and the
 * property worth protecting is structural: the signal handed to the retry must
 * not be the one the breaker aborted.
 *
 *   node scripts/runaway-retry-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`)
  }
}

const src = await readFile(join(ROOT, 'src/main/orchestrator.ts'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('\n\x1b[1mrunaway retry\x1b[0m')

/* A const controller cannot be replaced, so the retry is guaranteed to inherit
   the abort. This is the exact shape of the bug. */
check(
  'the controller can be replaced',
  /\blet controller = new AbortController\(\)/.test(code),
  'controller is const — a retry must reuse the aborted signal'
)

const retryBlock = code.slice(
  code.indexOf('if (trippedThisRequest) {'),
  code.indexOf('if (trippedThisRequest) {') + 900
)
check('the retry block exists', retryBlock.length > 50)
check(
  'it makes a fresh AbortController before continuing',
  /controller = new AbortController\(\)/.test(retryBlock),
  'no new controller in the retry path'
)
check(
  'and repoints the active turn at it, so Cancel still works',
  /this\.active.*controller = controller/.test(retryBlock),
  'this.active.controller left pointing at the dead one'
)
check(
  'it turns thinking off for the retry',
  /effortThisRequest = 'none'/.test(retryBlock),
  'the retry must lower thinking somehow'
)

/*
 * The scope of that downgrade is the whole point, and getting it wrong is
 * invisible: the sidebar goes on saying "Med" while every request after the
 * spiral is sent with thinking off. Measured on a real run — one spiral at
 * request 13 of 90 silenced the remaining 77 and every turn after it.
 */
check(
  'the turn-level effort is a const, so nothing can reassign it',
  /\n\s*const effort =\s*\n/.test(code),
  'effort is `let` again — a retry can now silence the rest of the turn'
)
check(
  'the retry does NOT touch the turn-level effort',
  !/[^a-zA-Z]effort = '/.test(code),
  'something assigns to `effort` directly'
)
check(
  'the override is consumed and cleared in the same breath',
  /const requestEffort = .*effortThisRequest \?\? effort.*\n\s*effortThisRequest = undefined/.test(code),
  'the per-request override is not cleared where it is read, so it can leak'
)
check(
  'what is SENT is the per-request value',
  /reasoningEffort: requestEffort/.test(code)
)
check(
  'and what is REPORTED is the same value, not the setting',
  /setReasoningEffort\(requestEffort\)/.test(code),
  'metrics would claim an effort the request never used'
)
/*
 * The brake must be able to fire more than once in a turn, and this is the
 * assertion that would have caught the eighteen-minute spiral. The one-shot
 * version handed thinking back and could never fire again; it looked correct
 * only because a second bug left thinking off for the rest of the turn anyway,
 * so no second spiral was reachable. Fixing that exposed this one immediately.
 */
check(
  'the brake is not one-shot',
  !/reasoningRetried/.test(code),
  'a one-shot retry flag is back — the second spiral in a turn runs unchecked'
)
check(
  'it counts spirals rather than latching on the first',
  /reasoningTrips \+= 1/.test(code),
  'no spiral counter'
)
check(
  'and stops handing thinking back after too many',
  /reasoningTrips >= MAX_REASONING_TRIPS/.test(code) && /effortLatchedOff = true/.test(code),
  'nothing escalates — a turn could ping-pong between spiral and retry forever'
)
check(
  'the latch actually suppresses the effort',
  /effortLatchedOff \? 'none' :/.test(code),
  'the latch is set but never read'
)

/*
 * Per REQUEST, not per turn. Counting across a turn conflates one request
 * spiralling with a long turn that has legitimately thought across thirty
 * steps; only the first is a fault.
 */
check(
  'the reasoning counter resets each request',
  /reasoningSoFar = 0\n\s*let trippedThisRequest = false/.test(code),
  'reasoningSoFar accumulates across the turn, so a long turn trips on its own history'
)

/* The breaker only fires with nothing written and no tool pending — otherwise
   it would abort turns that are making progress. */
const trip = code.slice(code.indexOf('!trippedThisRequest &&'), code.indexOf('!trippedThisRequest &&') + 260)
check('the breaker requires an empty answer', /assistant\.content === ''/.test(trip))
check('and no tool call in flight', /pendingCalls\.size === 0/.test(trip))

console.log('\n\x1b[1mempty-reply retry\x1b[0m')

/*
 * A turn that came back with nothing used to end there and wait for a human.
 * That is fine when someone is watching and fatal when nobody is: a model
 * reload on the serving machine ended an overnight build turn with "the model
 * returned an empty reply (finish reason: unknown)" and the run stopped dead
 * for the rest of the night. The same request sent again would have worked.
 */
const emptyBlock = code.slice(
  code.indexOf("if (assistant.content.trim() === '' &&"),
  code.indexOf("if (assistant.content.trim() === '' &&") + 1400
)
check('the empty-reply branch exists', emptyBlock.length > 100)
check(
  'an empty reply is re-sent rather than ending the turn',
  /emptyRetries \+= 1/.test(emptyBlock) && /continue/.test(emptyBlock),
  'the turn still stops dead on a dropped request'
)
check(
  'the retry is bounded',
  /emptyRetries < MAX_EMPTY_RETRIES/.test(emptyBlock),
  'a server that is down would be retried forever'
)
check(
  'a budget exhaustion is NOT retried',
  /finishReason !== 'length'/.test(emptyBlock),
  "'length' means the cap was really hit — re-sending burns another whole budget"
)
check(
  'a user abort is NOT retried',
  /!controller\.signal\.aborted/.test(emptyBlock),
  'pressing Stop would re-send the request it just cancelled'
)
check(
  'the retry gets a fresh signal',
  /controller = new AbortController\(\)/.test(emptyBlock),
  'the retry inherits whatever killed the previous request — the runaway bug, again'
)
check(
  'the abandoned message is removed',
  /conv\.messages\.splice\(ghost, 1\)/.test(emptyBlock),
  'a left-behind assistant message renders as a streaming indicator forever'
)
check(
  'the counter spans the turn, so a flapping server cannot loop',
  /let emptyRetries = 0/.test(code) && !/emptyRetries = 0\n\s*let tripped/.test(code)
)


console.log('\n\x1b[1mbudget spent thinking, nothing produced\x1b[0m')
/* The reasoning breaker watches a request WHILE it streams and stands down the
   moment any content or tool call appears, so a request that reasons quietly all
   the way to its cap reaches the end untouched. That ended the turn with advice
   addressed to a human, which is no use overnight. Watched one die exactly so:
   63.7k prompt, 1.8k reasoning, finish_reason 'length', nothing produced. */
const lenBlock = code.slice(code.indexOf('const spentItAllThinking'), code.indexOf('const spentItAllThinking') + 1100)
check('the length-exhaustion branch exists', lenBlock.length > 100)
check('it only fires on finish_reason length', /finishReason === 'length'/.test(lenBlock))
check('it requires that reasoning actually consumed the budget',
  /turnMetrics\.reasoningTokens \?\? 0\) > 0/.test(lenBlock),
  'a plain long answer that hit the cap is not a spiral and must not be retried blind')
check('a user abort is NOT retried', /!controller\.signal\.aborted/.test(lenBlock))
check('the retry turns thinking off', /effortThisRequest = 'none'/.test(lenBlock),
  'the same remedy the mid-stream breaker applies')
check('it shares the spiral budget rather than inventing a new one',
  /reasoningTrips < MAX_REASONING_TRIPS/.test(lenBlock) && /reasoningTrips \+= 1/.test(lenBlock))
check('and latches thinking off once the budget is spent',
  /reasoningTrips >= MAX_REASONING_TRIPS\) effortLatchedOff = true/.test(lenBlock))
check('the abandoned message is removed', /conv\.messages\.splice\(ghost, 1\)/.test(lenBlock))
check('the retry gets a fresh signal', /controller = new AbortController\(\)/.test(lenBlock))

console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
