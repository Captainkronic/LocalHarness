#!/usr/bin/env node
/**
 * The loop breaker.
 *
 * Two ways to get this wrong, in opposite directions, and both look fine on
 * screen. Too eager and it stops a model doing the job properly — polling a
 * live page returns a different answer every time and is exactly right. Too
 * slow and a stuck turn spends its whole budget.
 *
 * This file used to MIRROR the orchestrator's arithmetic rather than import it,
 * which meant it could pass while the shipped rule differed. It now drives the
 * real module.
 *
 *   node scripts/loop-breaker-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'loop-'))
await writeFile(join(dir, 'e.ts'), `export * from '${ROOT}/src/main/agent/loopbreak'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const L = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

/** Build an entry the way the orchestrator does. */
const entry = (name, args, result, acting) => ({
  callKey: L.callKeyFor([{ name, arguments: args }]),
  shapeKey: L.shapeKeyFor([{ name, arguments: args }]),
  resultKey: result,
  acting: acting ?? L.isActing([{ name, arguments: args }])
})

/** Feed a sequence; return the 1-based index of the call that gets stopped. */
const firstTrip = (seq) => {
  const history = []
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i]
    const v = L.loopVerdict(history, { ...e, resultKey: '' })
    if (v) return { at: i + 1, rule: v.rule, why: v.why }
    history.push(e)
  }
  return null
}

console.log('\nRule 1 — identical call and identical result')
const same = () => entry('browse_act', '{"action":"press","value":"ArrowLeft"}', 'game over')
check('six identical calls are stopped at the sixth',
  firstTrip(Array.from({ length: 10 }, same))?.at === 6,
  JSON.stringify(firstTrip(Array.from({ length: 10 }, same))))
check('five are allowed through', firstTrip(Array.from({ length: 5 }, same)) === null)
check('the rule names itself', firstTrip(Array.from({ length: 8 }, same))?.rule === 'identical')

console.log('\nRule 1 does not fire on a page that keeps answering differently')
const polling = Array.from({ length: 12 }, (_, i) =>
  entry('page_eval', '{"expression":"score"}', `score ${i}`))
check('polling a LIVE page is never stopped', firstTrip(polling) === null,
  JSON.stringify(firstTrip(polling)))
const dead = Array.from({ length: 12 }, () =>
  entry('page_eval', '{"expression":"score"}', 'score 0'))
check('polling a DEAD page is stopped', firstTrip(dead)?.at === 6)

console.log('\nRule 2 — a narrow window of outcomes')
/* The three-hour golf run: two calls alternating, two outcomes between them. */
const twoCycle = []
for (let i = 0; i < 20; i++) {
  twoCycle.push(i % 2 === 0
    ? entry('run_shell', '{"command":"ls -la"}', 'unchanged since 05:55')
    : entry('run_shell', '{"command":"node verify.js"}', 'AssertionError'))
}
const t2 = firstTrip(twoCycle)
check('an alternating two-call cycle is stopped', t2 !== null, JSON.stringify(t2))
check('it is caught by the narrow-window rule', t2?.rule === 'narrow', t2?.rule)

console.log('\nRule 3 — the same procedure, acting on nothing')
/* The run that motivated this: shoot, read the score, ask vision where the ball
   is. Every outcome distinct — the stroke count really was climbing — and the
   vision question reworded every pass, which is what defeated rule 2. */
const golf = []
for (let i = 0; i < 12; i++) {
  golf.push(entry('page_eval', '{"expression":"dispatch(keydown)"}', `charge ${i}`))
  golf.push(entry('page_eval', '{"expression":"readScore()"}', `strokes ${i}`))
  golf.push(entry('view_page', JSON.stringify({
    url: 'http://127.0.0.1:59017/golf.html',
    ask: `Where is the white ball relative to the cup now? Attempt ${i}.`
  }), `the ball is somewhere ${i}`))
}
const t3 = firstTrip(golf)
check('the three-step observation cycle is stopped', t3 !== null, JSON.stringify(t3))
check('it is caught by the shape rule', t3?.rule === 'shape', t3?.rule)
check('it is stopped inside twelve calls', (t3?.at ?? 99) <= 12, `at ${t3?.at}`)
check('the reason names the period', /3-step sequence/.test(t3?.why ?? ''), t3?.why)

console.log('\nRule 3 leaves work alone')
/* Identical shape, but the model is writing files. That is a build loop, not a
   stuck one, and it must survive. */
const building = []
for (let i = 0; i < 12; i++) {
  building.push(entry('page_eval', '{"expression":"readScore()"}', `strokes ${i}`))
  building.push(entry('edit_file', `{"path":"golf.js","old_string":"a${i}","new_string":"b${i}"}`, `+1 -1 (${i})`))
  building.push(entry('view_page', JSON.stringify({ url: 'x', ask: `look ${i}` }), `looks better ${i}`))
}
check('a cycle that EDITS files is never stopped', firstTrip(building) === null,
  JSON.stringify(firstTrip(building)))
const shelling = []
for (let i = 0; i < 12; i++) {
  shelling.push(entry('page_eval', '{"expression":"x"}', `a${i}`))
  shelling.push(entry('run_shell', `{"command":"cp build/three.js vendor/ # ${i}"}`, `ok ${i}`))
}
check('a cycle that runs SHELL commands is never stopped', firstTrip(shelling) === null,
  'the keeper that counted only write_file stopped a run mid-fix for exactly this')

console.log('\nProse collapsing — what defeated the old rule')
check('a reworded ask collapses to one shape',
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"u","ask":"Where is it?"}' }]) ===
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"u","ask":"How far is it, roughly?"}' }]))
check('a different URL does NOT collapse',
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"a","ask":"q"}' }]) !==
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"b","ask":"q"}' }]))
check('key order does not change the shape',
  L.shapeKeyFor([{ name: 't', arguments: '{"a":1,"b":2}' }]) ===
  L.shapeKeyFor([{ name: 't', arguments: '{"b":2,"a":1}' }]))
check('an expression is NOT treated as prose',
  L.shapeKeyFor([{ name: 'page_eval', arguments: '{"expression":"a()"}' }]) !==
  L.shapeKeyFor([{ name: 'page_eval', arguments: '{"expression":"b()"}' }]),
  'collapsing it would merge genuinely different probes')
check('a command is NOT treated as prose',
  L.shapeKeyFor([{ name: 'run_shell', arguments: '{"command":"ls"}' }]) !==
  L.shapeKeyFor([{ name: 'run_shell', arguments: '{"command":"rm -rf x"}' }]))
check('malformed JSON is passed through rather than thrown on',
  typeof L.collapseProse('{"pa') === 'string')
check('a non-object argument survives', L.collapseProse('"just a string"') === '"just a string"')

console.log('\nShape rule does not fire too early')
const shortCycle = []
for (let i = 0; i < 3; i++) {
  shortCycle.push(entry('page_eval', '{"expression":"a"}', `a${i}`))
  shortCycle.push(entry('page_eval', '{"expression":"b"}', `b${i}`))
}
check('a two-step cycle survives three repeats (six calls)', firstTrip(shortCycle) === null,
  'eight calls is the floor, whatever the period')
const longerTwo = []
for (let i = 0; i < 6; i++) {
  longerTwo.push(entry('page_eval', '{"expression":"a"}', `a${i}`))
  longerTwo.push(entry('page_eval', '{"expression":"b"}', `b${i}`))
}
check('a two-step cycle is stopped by the eighth call', firstTrip(longerTwo)?.at === 8,
  `at ${firstTrip(longerTwo)?.at}`)
check('genuine varied work is never stopped', firstTrip(
  Array.from({ length: 30 }, (_, i) => entry('read_file', `{"path":"f${i}.ts"}`, `contents ${i}`))
) === null)

console.log('\nAdvice the MODEL actually receives')
/*
 * The user-facing sentence was good and unreachable: it lived on
 * assistant.error, and only `content` is forwarded from an assistant message.
 * A run died after reading one function five times convinced its edit had not
 * landed — it had; the browser was still running the module it loaded before
 * the edit. The advice said "the check itself may be wrong" and the model
 * never saw a word of it.
 */
const adv = (rule) => L.loopAdvice({ rule, why: 'x' }, 'read_file')
for (const rule of ['identical', 'narrow', 'shape']) {
  check(`${rule}: names the tool or the pattern`, adv(rule).length > 80)
  check(`${rule}: says earlier work survived`, /still stands|not lost/i.test(adv(rule)))
  check(`${rule}: tells it to RELOAD when a page looks stale`, /reload/i.test(adv(rule)),
    'the one fix that would have unstuck the measured case')
  check(`${rule}: suggests the check may be wrong`, /suspect the test|wrong thing/i.test(adv(rule)))
  check(`${rule}: does not just say it stopped`, !/^Stopped/.test(adv(rule)))
}
check('identical advice names the offending tool', /read_file/.test(adv('identical')))

console.log('\nThe orchestrator nudges before it gives up')
const orch = readFileSync(join(ROOT, 'src/main/orchestrator.ts'), 'utf8')
check('a trip is counted, not latched',
  /loopNudges \+= 1/.test(orch), 'no nudge counter — the first trip still ends the turn')
check('the advice goes on the tool call, which IS forwarded',
  /call\.error = spent \? .* : advice/.test(orch) || /call\.error = spent/.test(orch),
  'advice must reach the model through call.error')
check('a result is appended for every refused call',
  /this\.appendToolResult\(conv, call\)/.test(orch),
  'a call with no result leaves the next request malformed')
check('history is cleared after a nudge',
  /loopHistory\.length = 0/.test(orch),
  'without this the next iteration trips on the same tail and the advice is never acted on')
check('the turn continues rather than breaking',
  /loopHistory\.length = 0[\s\S]{0,200}continue/.test(orch),
  'still ending the turn on the first trip')
check('and it does eventually stop',
  /const spent = loopNudges > MAX_LOOP_NUDGES/.test(orch) && /if \(spent\)[\s\S]{0,400}break/.test(orch),
  'nothing ends the turn — a stuck model would nudge forever')

console.log(failed === 0 ? '\n\x1b[32mall loop-breaker checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
