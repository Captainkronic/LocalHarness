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
  acting: acting ?? L.isActing([{ name, arguments: args }]),
  target: L.targetKeyFor([{ name, arguments: args }])
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

console.log('\nCache busting — what defeated ALL THREE rules')
/* Live regression. A mini-golf run could not see its own change, started
   appending ?retry=N, and ran thirty iterations of page_eval + read_file
   reading `ball: null` every time. The varying query gave every call a fresh
   callKey AND shapeKey, and because page tools echo the URL back it gave every
   RESULT a fresh key too, so rules 1, 2 and 3 all stood down. */
const busted = (n) => JSON.stringify({ url: `http://127.0.0.1:57619/index.html?retry=${n}` })
check('cache-busted URLs collapse to one shape',
  L.shapeKeyFor([{ name: 'page_eval', arguments: busted(1) }]) ===
  L.shapeKeyFor([{ name: 'page_eval', arguments: busted(30) }]))
check('a different PATH still does not collapse',
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"http://h/a.html?x=1"}' }]) !==
  L.shapeKeyFor([{ name: 'view_page', arguments: '{"url":"http://h/b.html?x=1"}' }]),
  'only the query is dropped, never the path')
check('a query-free URL is left exactly as it was',
  L.collapseProse('{"url":"http://h/a.html"}') === '{"url":"http://h/a.html"}')
check('a non-URL string is left alone',
  L.collapseProse('{"path":"/tmp/a?b"}') === '{"path":"/tmp/a?b"}')

const retryLoop = []
for (let i = 1; i <= 12; i++) {
  retryLoop.push(entry('page_eval',
    JSON.stringify({ url: `http://127.0.0.1:57619/index.html?retry=${i}`, expression: 'probe()' }),
    `PAGE EVAL http://127.0.0.1:57619/index.html?retry=${i} { "ball": null }`))
  retryLoop.push(entry('read_file', '{"path":"game.js","offset":201}', 'line 201 ...'))
}
const tR = firstTrip(retryLoop)
check('the ?retry= loop is now stopped', tR !== null, JSON.stringify(tR))
check('it is caught by the shape rule', tR?.rule === 'shape', tR?.rule)
check('it is stopped inside twelve calls', (tR?.at ?? 99) <= 12, `at ${tR?.at}`)

/* The counterpart that must still be allowed: same shape after collapsing, but
   the model is writing files between looks. That is a build loop. */
const bustedButBuilding = []
for (let i = 1; i <= 12; i++) {
  bustedButBuilding.push(entry('page_eval', busted(i), `look ${i}`))
  bustedButBuilding.push(entry('write_file', `{"path":"game.js","content":"v${i}"}`, `Wrote game.js (${i})`))
}
check('cache busting while WRITING files is never stopped',
  firstTrip(bustedButBuilding) === null, JSON.stringify(firstTrip(bustedButBuilding)))

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
check("genuine varied work is never stopped (legacy)", firstTrip(
  Array.from({ length: 30 }, (_, i) => entry('read_file', `{"path":"f${i}.ts"}`, `contents ${i}`))
) === null)

console.log('\nRule 4 — looking without ever acting')
/* Live regression. Sixteen minutes on the mini-golf run went to reading one
   file at shifting offsets and probing one page. Every call was distinct, so
   rules 1-3 all stood down: there was no repetition to find, only paralysis. */
const paralysis = []
for (let i = 0; i < 8; i++) {
  paralysis.push(entry('read_file', `{"path":"game.js","offset":${100 + i * 7}}`, `lines ${i}`))
  paralysis.push(entry('page_eval', `{"url":"http://h/index.html","expression":"probe${i}()"}`, `null ${i}`))
}
const t4 = firstTrip(paralysis)
check('reading ONE file at shifting offsets is stopped', t4 !== null, JSON.stringify(t4))
check('it is caught by the observing rule', t4?.rule === 'observing', t4?.rule)
check('the reason says nothing was written',
  /nothing was written/.test(t4?.why ?? ''), t4?.why)

check('breadth is still never stopped — thirty DIFFERENT files', firstTrip(
  Array.from({ length: 30 }, (_, i) => entry('read_file', `{"path":"f${i}.ts"}`, `contents ${i}`))
) === null, 'exploring a codebase is work, not paralysis')

/* One edit anywhere in the stretch is enough to mean the model is building. */
const readingButEditing = []
for (let i = 0; i < 8; i++) {
  readingButEditing.push(entry('read_file', `{"path":"game.js","offset":${i * 9}}`, `lines ${i}`))
  readingButEditing.push(entry('edit_file', `{"path":"game.js","old_string":"a${i}"}`, `+1 -1`))
}
check('a read/edit cycle is never stopped by rule 4',
  firstTrip(readingButEditing) === null, JSON.stringify(firstTrip(readingButEditing)))

check('a target ignores the cache-busting query',
  L.targetKeyFor([{ name: 'page_eval', arguments: '{"url":"http://h/a?retry=1"}' }]) ===
  L.targetKeyFor([{ name: 'page_eval', arguments: '{"url":"http://h/a?retry=99"}' }]))

console.log('\nRule 5 — thinking far more than it is doing')
/* Live measurement, flight-sim build: consecutive steps in one turn spent
   1,955 / 385 / 6,421 reasoning tokens to produce one run_shell, one grep and
   two read_file calls. Six minutes at 18 tok/s to decide to read two files, and
   neither existing guard could see it — the runaway breaker stands down as soon
   as a tool call appears, and rule 4 counts calls without knowing their cost. */
const think = (name, args, result, reasoning) =>
  ({ ...entry(name, args, result), reasoning })
const pondering = [
  think('read_file', '{"path":"sim.js","offset":10}', 'lines', 5000),
  think('grep', '{"pattern":"lift","path":"sim.js"}', 'hits', 5000),
  think('read_file', '{"path":"sim.js","offset":200}', 'lines', 5000)
]
const t5 = firstTrip(pondering)
check('expensive thinking with nothing written is stopped', t5 !== null, JSON.stringify(t5))
check('it is caught by the pondering rule', t5?.rule === 'pondering', t5?.rule)
check('the reason quantifies the spend', /k tokens thinking/.test(t5?.why ?? ''), t5?.why)

check('ONE big thinking step is left alone', firstTrip([
  think('read_file', '{"path":"a.js"}', 'x', 20000)
]) === null, 'a hard problem thought about properly must not be interrupted')
check('two are still left alone', firstTrip([
  think('read_file', '{"path":"a.js"}', 'x', 9000),
  think('read_file', '{"path":"b.js"}', 'y', 9000)
]) === null, 'three in a row is the pattern; two is not')

check('cheap looking never trips rule 5', firstTrip([
  think('read_file', '{"path":"a.js"}', 'x', 50),
  think('read_file', '{"path":"b.js"}', 'y', 50),
  think('read_file', '{"path":"c.js"}', 'z', 50)
]) === null)
check('thinking hard while WRITING is never stopped', firstTrip([
  think('read_file', '{"path":"a.js"}', 'x', 9000),
  think('edit_file', '{"path":"a.js","old_string":"q"}', '+1 -1', 9000),
  think('read_file', '{"path":"a.js"}', 'y', 9000),
  think('edit_file', '{"path":"a.js","old_string":"r"}', '+1 -1', 9000)
]) === null, 'deliberating between edits is a model doing the job')
check('an entry with no reasoning reported cannot trip it', firstTrip([
  entry('read_file', '{"path":"a.js"}', 'x'),
  entry('read_file', '{"path":"b.js"}', 'y'),
  entry('read_file', '{"path":"c.js"}', 'z')
]) === null, 'absent must mean zero, never "unknown so assume the worst"')

console.log('\nResult digests — the other half of the ?retry= failure')
check('a cache-busted URL inside a RESULT collapses',
  L.collapseResultUrls('PAGE EVAL http://127.0.0.1:57619/index.html?retry=31 (0.55s) ball: null') ===
  L.collapseResultUrls('PAGE EVAL http://127.0.0.1:57619/index.html?retry=7 (0.55s) ball: null'))
check('a result with no URL is untouched',
  L.collapseResultUrls('exit 0 — done') === 'exit 0 — done')
check('two genuinely different paths stay different',
  L.collapseResultUrls('see http://h/a?x=1') !== L.collapseResultUrls('see http://h/b?x=1'))

/* Live regression, flight-sim run. Thirty page_eval calls with byte-identical
   arguments all answered {"vBefore":0,"dz":0}; the ONLY difference between
   results was the elapsed-time stamp the tool prints. Ten milliseconds of
   jitter broke rule 1's run and added a fourth "distinct outcome" for rule 2. */
const evalAt = (s) => `PAGE EVAL  http://127.0.0.1:62880/index.html   (${s})  {"vBefore":0,"dz":0}`
check('an elapsed-time stamp does not make two identical answers differ',
  L.collapseResultUrls(evalAt('0.02s')) === L.collapseResultUrls(evalAt('0.01s')))
check('a millisecond stamp collapses too',
  L.collapseResultUrls('ran (35ms)') === L.collapseResultUrls('ran (1200ms)'))
check('a bare number in the output is DATA and survives',
  L.collapseResultUrls('airspeed 34.2 kt') !== L.collapseResultUrls('airspeed 51.8 kt'),
  'collapsing measured values would blind the breaker to real progress')
check('a genuinely different answer still differs at the same elapsed time',
  L.collapseResultUrls(evalAt('0.02s')) !==
  L.collapseResultUrls('PAGE EVAL  http://127.0.0.1:62880/index.html   (0.02s)  {"vBefore":0,"dz":6.8}'))

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

console.log('\n\x1b[1mdriving a browser is acting, not looking\x1b[0m')
/* Measured on a design review whose prompt began "do not edit any files": nine
   browse_act calls in, the observing rule refused a click on the light-mode
   toggle and told the model "you have enough to act, make the change now". The
   advice was the opposite of the task, and the click it ate was the task.

   The same misclassification would make any play-testing run unworkable — a
   game is exercised with browse_act and page_eval and nothing else. */
{
  const act = (name) => L.isActing([{ name, arguments: '{}' }])
  check('browse_act counts as acting', act('browse_act'))
  check('and so does it via MCP, where the name arrives prefixed',
    act('playwright__browse_act'),
    'an exact-Set lookup misses every MCP tool, which is all of them here')
  check('serve_dir counts as acting', act('serve_dir'),
    'starting a server changes the world rather than asking about it')
  check('editing still counts', act('write_file') && act('edit_file') && act('run_shell'))
  check('but reading does not', !act('read_file') && !act('grep') && !act('list_dir'))
  check('nor does looking at a page',
    !act('playwright__view_page') && !act('playwright__page_eval'),
    'a screenshot and a DOM read are questions, not changes')
}

console.log(failed === 0 ? '\n\x1b[32mall loop-breaker checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
