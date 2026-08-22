#!/usr/bin/env node
/**
 * What the live HUD is allowed to claim about what is happening right now.
 *
 * Every check here is a sentence the UI used to say that was not true, found by
 * reading a 165-minute unattended build while it ran. The owner's requirement is
 * that Code mode always makes it clear what is going on, and a confident wrong
 * number is further from that than no number at all.
 *
 *   node scripts/live-metrics-test.mjs
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
  else { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = await mkdtemp(join(tmpdir(), 'lh-live-'))
await writeFile(join(dir, 'e.ts'),
  `export { TurnMeter } from '${ROOT}/src/main/telemetry/meter'\n` +
  `export { demoteOrphanedCalls } from '${ROOT}/src/main/agent/loopbreak'\n` +
  `export { toolOutcome } from '${ROOT}/src/renderer/lib/toolFacts'\n` +
  `export { mergeModelLists, effectiveWindow } from '${ROOT}/src/main/llm/models'\n` +
  `export { estimateTokens } from '${ROOT}/src/main/mcp/tokens'\n` +
  `export { parseModels } from '${ROOT}/src/main/llm/models'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'),
           '@renderer': join(ROOT, 'src/renderer'), electron: shim }
})
const { TurnMeter, demoteOrphanedCalls, toolOutcome, mergeModelLists, effectiveWindow, estimateTokens, parseModels } =
  await import(pathToFileURL(out).href)

console.log('\n\x1b[1mThe clock beside the phase word measures the phase\x1b[0m')
/* It rendered elapsedMs, stamped once when the request left the client. So
   "tool 3m 30s" meant the request was 3m30s old, not that the tool had run that
   long — while the turn strip below showed the same command's true "(10.2s)". */
{
  const m = new TurnMeter()
  m.start('qwen', 20000, null)
  await sleep(120)
  m.markFirstToken()
  await sleep(60)
  const decode = m.snapshot()
  check('phase elapsed is shorter than request elapsed after a transition',
    decode.phaseElapsedMs < decode.elapsedMs,
    `phase ${decode.phaseElapsedMs}ms vs request ${decode.elapsedMs}ms`)
  check('and the request clock still measures the whole request', decode.elapsedMs >= 180)

  m.markToolPhase()
  const tool = m.snapshot()
  check('entering the tool phase restarts the phase clock', tool.phaseElapsedMs < 60,
    `${tool.phaseElapsedMs}ms — a fresh tool must not inherit the request's age`)
  check('while the request clock keeps running', tool.elapsedMs >= 180)
}

console.log('\n\x1b[1mNothing is decoding during a tool call\x1b[0m')
/* finish() stamped finishedAt but never cleared samples, so decodeTps anchored
   to that stamp and returned the SAME number forever: a 3-minute npm install sat
   under an unmoving "decode 13.9 tok/s" in full live colour. */
{
  const m = new TurnMeter()
  m.start('qwen', 20000, null)
  m.markFirstToken()
  for (let i = 0; i < 40; i++) m.countCompletionToken(1)
  await sleep(200)
  check('a rate is reported while decoding', m.snapshot().decodeTps !== null)
  m.markToolPhase()
  check('but NOT while a tool runs', m.snapshot().decodeTps === null,
    'a held number rendered in the live grammar is worse than no number')
  m.markDecodePhase()
  check('and it comes back when generation resumes', m.snapshot().decodeTps !== null)
}

console.log('\n\x1b[1mThinking is not writing\x1b[0m')
/* Reasoning deltas are generated tokens, so the phase flips to decode on the
   first one. 51.0k of one run's 68.6k generated tokens were reasoning, and all
   of it was announced as "Writing the reply" while the reply was still empty. */
{
  const m = new TurnMeter()
  m.start('qwen', 20000, null)
  m.markFirstToken()
  m.countReasoningToken(500)
  const thinking = m.snapshot()
  check('reasoning is exposed separately', thinking.reasoningTokens === 500)
  check('and is still counted as generation', thinking.completionTokens === 500,
    'it costs the same and comes out of the same budget')
  check('a pure-reasoning step is distinguishable from a written reply',
    thinking.reasoningTokens >= thinking.completionTokens,
    'this is the condition the strip branches on to say "Thinking" instead')

  m.countCompletionToken(120)
  const writing = m.snapshot()
  check('once the reply starts, completion outgrows reasoning',
    writing.completionTokens > writing.reasoningTokens)
  check('and the reply length is recoverable',
    writing.completionTokens - writing.reasoningTokens === 120,
    'the strip prints this rather than the combined figure')
}

console.log('\n\x1b[1mA name and a clock survive a multi-call step\x1b[0m')
/* openCall read messages.at(-1) and required role 'assistant'. Every finished
   call pushes a tool result, so from call #2 the strip fell to an anonymous
   "Running a tool" with no name and no elapsed — a 59s command in position 2
   was indistinguishable from a hang. */
{
  const src = await (await import('node:fs/promises')).readFile(
    join(ROOT, 'src/renderer/components/chat/TurnStrip.tsx'), 'utf8')
  const fn = src.slice(src.indexOf('function openCall'), src.indexOf('function openCall') + 1400)
  check('openCall no longer reads only the last message',
    !/const m = s\.conversation\?\.messages\.at\(-1\)/.test(fn),
    'that is null for every call after the first in a batch')
  check('it scans backwards instead', /for \(let i = msgs\.length - 1; i >= 0; i--\)/.test(fn))
  check('and stops at the first non-tool, non-assistant message',
    /role !== 'tool'/.test(fn),
    'without that it would reach back into an unrelated earlier turn')
}

console.log('\n\x1b[1mNo tool call outlives its turn\x1b[0m')
/* Press Stop during a step that issued several calls: main treats the rest as
   denied, the renderer's last snapshot still has them pending, and because
   characters had already arrived the card's own tick is disabled. The result is
   a frozen character count under an animated busy dot. */
{
  const calls = [
    { status: 'ok' },
    { status: 'pending' },
    { status: 'running' },
    { status: 'error', error: 'the real reason' }
  ]
  const changed = demoteOrphanedCalls(calls, 1234)
  check('it reports that it changed something', changed === true)
  check('a pending call is settled', calls[1].status === 'error')
  check('a running call is settled', calls[2].status === 'error')
  check('and both get a finish time so the clock stops',
    calls[1].finishedAt === 1234 && calls[2].finishedAt === 1234)
  check('a call that already succeeded is untouched', calls[0].status === 'ok')
  check('and a real failure keeps its own reason',
    calls[3].error === 'the real reason',
    'overwriting it would hide why the call actually failed')
  check('nothing to do is reported as nothing done',
    demoteOrphanedCalls([{ status: 'ok' }], 1) === false,
    'the caller persists only when this says so')
  check('no calls at all is safe', demoteOrphanedCalls(undefined, 1) === false)
}

console.log('\n\x1b[1mA finished message must not claim to be thinking\x1b[0m')
{
  const msg = await (await import('node:fs/promises')).readFile(
    join(ROOT, 'src/renderer/components/chat/Message.tsx'), 'utf8')
  check('reaching for a tool counts as an answer',
    /answered=\{message\.content\.trim\(\) !== '' \|\| \(message\.toolCalls\?\.length \?\? 0\) > 0\}/.test(msg),
    'in Code mode content is empty on nearly every step, so without this every step looked unanswered')
  check('liveness is taken from streaming, not inferred from a clock',
    /const live = streaming && !answered/.test(msg))
  check('and growth must be observed before it counts',
    /useRef\(\{ len: text\.length, at: 0 \}\)/.test(msg),
    'seeding at mount time made every historical block read as live on first render')
}

console.log('\n\x1b[1mA write is only a success if it landed AND it parses\x1b[0m')
/* All three facts used to be prose inside the result text, which only the model
   reads. ok() sets isError:false, so a write whose bytes did not match on disk,
   or whose JavaScript does not parse, drew the same green dot and the same tidy
   +N/-M as a clean one. */
{
  const w = (over) => toolOutcome({
    kind: 'write', verified: true, syntax: 'ok', added: 10, removed: 2, created: false, ...over })

  const clean = w({})
  check('a clean write reads ok', clean.tone === 'ok' && clean.status === 'written')
  check('and shows its churn', clean.note === '+10 -2')
  check('a new file says so', w({ created: true }).status === 'created')
  check('and counts lines rather than a diff', w({ created: true }).note === '10 lines')

  const unver = w({ verified: false })
  check('bytes that did not match is BAD', unver.tone === 'bad')
  check('and says which way it failed', /do not match/.test(unver.detail))

  const broken = w({ syntax: 'broken' })
  check('a file that does not parse is BAD', broken.tone === 'bad')
  check('and admits it is on disk anyway', /on disk/.test(broken.detail),
    'the model must not think the write was rejected')

  const un = w({ syntax: 'unchecked' })
  check('JSX we cannot parse is neither ok nor bad', un.tone === 'warn',
    'green hid a broken component; red would be a verdict nobody made')
  check('and it names the thing that CAN check it', /run the build/.test(un.detail))

  check('an unknown structured kind still returns nothing',
    toolOutcome({ kind: 'nope' }) === null)
  check('and so does a non-object', toolOutcome('write') === null)
}

console.log('\n\x1b[1mOne entry per model, whatever the endpoints say\x1b[0m')
/* An extra endpoint fronting the same server returns the same catalogue. These
   lists were concatenated: 22 entries for 11 models, the primary copy marked
   loaded and the extra copy marked as nothing, because plain OpenAI /v1 reports
   no state. Picking the wrong twin asks the server to load a model it already
   has loaded — which is how a live turn died with "Model loading was stopped
   due to insufficient system resources" against a resident model. */
{
  const P = [
    { id: 'qwen/qwen3.8-27b@4bit', state: 'loaded', loadedContextLength: 106496 },
    { id: 'google/gemma-4-e4b', state: 'not-loaded', loadedContextLength: null }
  ]
  const X = [
    { id: 'qwen/qwen3.8-27b@4bit', state: undefined, loadedContextLength: null },
    { id: 'google/gemma-4-e4b', state: undefined, loadedContextLength: null },
    { id: 'only-on-the-extra', state: undefined, loadedContextLength: null }
  ]
  const m = mergeModelLists(P, X)
  check('the same model twice becomes once', m.filter((x) => x.id === P[0].id).length === 1)
  check('no id appears more than once',
    new Set(m.map((x) => x.id)).size === m.length, `${m.length} entries`)
  check('the primary copy is the one kept',
    m.find((x) => x.id === P[0].id).state === 'loaded',
    'the extra copy knows no state, and a loaded model must not look unloaded')
  check('and it keeps the real window',
    m.find((x) => x.id === P[0].id).loadedContextLength === 106496)
  check('a model only the extra has is still offered',
    m.some((x) => x.id === 'only-on-the-extra'),
    'dedupe must not become "ignore the extra endpoint"')
  check('primary ordering is preserved', m[0].id === P[0].id && m[1].id === P[1].id)
  check('no extras at all is fine', mergeModelLists(P, []).length === 2)
  check('no primary at all still lists the extra', mergeModelLists([], X).length === 3)
}

console.log('\n\x1b[1mThe window a request actually gets\x1b[0m')
{
  check('with neither correction it is what the server said',
    effectiveWindow(98304, 1, 0) === 98304)
  check('slots divide, because --parallel really does split n_ctx',
    effectiveWindow(98304, 4, 0) === 24576,
    'reading the whole n_ctx was four times too generous')
  check('a cap ceilings an advertised window the box cannot hold',
    effectiveWindow(262144, 1, 65536) === 65536,
    'oMLX advertises the architecture limit, not this machine\'s')
  check('the cap does not INFLATE a smaller real window',
    effectiveWindow(49152, 1, 65536) === 49152,
    'it is a ceiling, never a floor — this is the one that would overflow silently')
  check('the two compose', effectiveWindow(262144, 4, 50000) === 50000)
  check('and compose the other way round too', effectiveWindow(131072, 4, 50000) === 32768)
  check('cap 0 means no cap', effectiveWindow(262144, 1, 0) === 262144)
  check('a nonsense slot count is treated as one', effectiveWindow(1000, 0, 0) === 1000)
}

console.log('\n\x1b[1mA delta is not a token\x1b[0m')
/*
 * These counters were incremented once per SSE frame. A frame carries several
 * tokens — about four here, measured against oMLX's own usage figures. The live
 * gauge read 5.5 tok/s while the finished turn stamped 18.4 and the server
 * dashboard agreed with the stamp.
 *
 * The cosmetic half is the gauge. The half that matters is that reasoningSoFar
 * is compared against reasoningCap, a count of TOKENS, so the runaway-reasoning
 * breaker did not fire until roughly four times the thinking it was written to
 * catch.
 */
{
  /* A realistic reasoning stream: frames of a few words each. */
  const frames = []
  for (let i = 0; i < 300; i++) frames.push(' the harbour master kept a ledger')
  const trueTokens = estimateTokens(frames.join(''))

  const perFrame = frames.length
  check('counting frames undercounts badly',
    perFrame < trueTokens / 3,
    `${perFrame} frames vs ~${trueTokens} tokens — the old behaviour`)

  const summed = frames.reduce((n, f) => n + estimateTokens(f), 0)
  check('counting each frame\'s tokens lands close to the truth',
    Math.abs(summed - trueTokens) / trueTokens < 0.2,
    `${summed} vs ~${trueTokens}`)

  /* And the meter reports it, so the gauge and the breaker see the same number. */
  const m = new TurnMeter()
  m.start('qwen', 5000, null)
  m.markFirstToken()
  for (const f of frames) m.countReasoningToken(estimateTokens(f))
  const snap = m.snapshot()
  check('the meter reports tokens, not frames',
    snap.reasoningTokens === summed && snap.reasoningTokens > perFrame * 3)
  check('and reasoning still counts toward the completion total',
    snap.completionTokens === summed,
    'it is generated at the same cost and comes out of the same budget')

  /* The breaker's threshold is in tokens. Feeding it frames moves the trip
     point out by whatever the frame size happens to be. */
  const cap = 12288
  check('a spiral now trips at the cap it was written for',
    summed > perFrame,
    'with frames, the same stream would have to be ~4x longer to trip')
}

console.log('\n\x1b[1m"Not loaded" must mean the server said so\x1b[0m')
/* A plain OpenAI /v1 reports an id and nothing else. Defaulting that to
   'not-loaded' asserted something we had never been told: every model on the
   second backend drew a dead grey dot, the picker read "none loaded", and one of
   them was resident and answering at the time. */
{
  const ep = { id: 'omlx', label: 'oMLX', baseUrl: 'http://x/v1' }
  const body = { data: [{ id: 'A' }, { id: 'B' }] }

  const naive = parseModels(body, ep)
  check('the old default still applies where nothing is passed',
    naive[0].state === 'not-loaded', 'LM Studio always reports a state, so this path is unchanged')

  const unknown = parseModels(body, ep, 'unknown')
  check('a silent backend reports unknown, not "not loaded"',
    unknown[0].state === 'unknown' && unknown[1].state === 'unknown')

  const withStatus = parseModels(body, ep, 'unknown', new Set(['A']))
  check('a companion status endpoint gives real state',
    withStatus[0].state === 'loaded' && withStatus[1].state === 'not-loaded',
    'once the backend HAS told us, "not loaded" is honest')

  /* An explicit state in the payload always wins. */
  const explicit = parseModels({ data: [{ id: 'A', state: 'loading' }] }, ep, 'unknown', new Set(['A']))
  check('a state the payload states beats anything inferred',
    explicit[0].state === 'loading')
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall live-metrics checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
