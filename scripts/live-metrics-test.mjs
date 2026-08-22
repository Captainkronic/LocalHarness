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
  `export { toolOutcome } from '${ROOT}/src/renderer/lib/toolFacts'\n`)
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
const { TurnMeter, demoteOrphanedCalls, toolOutcome } = await import(pathToFileURL(out).href)

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

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall live-metrics checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
