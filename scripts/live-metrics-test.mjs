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
await writeFile(join(dir, 'e.ts'), `export { TurnMeter } from '${ROOT}/src/main/telemetry/meter'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim }
})
const { TurnMeter } = await import(pathToFileURL(out).href)

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

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall live-metrics checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
