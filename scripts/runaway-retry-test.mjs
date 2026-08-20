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
  code.indexOf('reasoningTripped && !reasoningRetried'),
  code.indexOf('reasoningTripped && !reasoningRetried') + 700
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
  /const requestEffort = effortThisRequest \?\? effort\s*\n\s*effortThisRequest = undefined/.test(code),
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
check('and retries at most once', /reasoningRetried = true/.test(retryBlock))

/* The breaker only fires with nothing written and no tool pending — otherwise
   it would abort turns that are making progress. */
const trip = code.slice(code.indexOf('!reasoningTripped &&'), code.indexOf('!reasoningTripped &&') + 260)
check('the breaker requires an empty answer', /assistant\.content === ''/.test(trip))
check('and no tool call in flight', /pendingCalls\.size === 0/.test(trip))

console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
