#!/usr/bin/env node
/**
 * Cutting a conversation into runs.
 *
 * The arithmetic is easy to get subtly wrong in ways that look plausible on
 * screen: a mean of per-request rates instead of a real total, tool time folded
 * into model time, or a still-running turn reported with a duration. Each of
 * those reads fine and is a lie, which is the failure mode this whole app keeps
 * running into.
 *
 *   node scripts/runs-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'runs-'))
await writeFile(join(dir, 'e.ts'), `export { summariseRuns } from '${ROOT}/src/renderer/lib/runs'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const { summariseRuns } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}

const met = (o = {}) => ({
  modelId: 'm', promptTokens: 1000, completionTokens: 100, ttftMs: 1000,
  totalMs: 3000, prefillTps: 0, decodeTps: 0, toolSchemaTokens: 0, source: 'client', ...o
})
const user = (id, at, content = 'do a thing') => ({ id, role: 'user', content, createdAt: at })
const asst = (id, at, metrics, extra = {}) =>
  ({ id, role: 'assistant', content: '', createdAt: at, ...(metrics ? { metrics } : {}), ...extra })

console.log('runs')

/* one prompt, one reply: wall clock is send -> end of that reply */
let r = summariseRuns([user('u1', 0), asst('a1', 500, met({ totalMs: 3000 }))])
check('one run per prompt', r.length === 1)
check('wall clock spans send to last token', r[0].wallMs === 3500, `${r[0].wallMs}ms`)
check('model time is the request only', r[0].modelMs === 3000)
check('tool time is the difference', r[0].toolMs === 500, 'the 500ms before the request began')

/* two prompts */
r = summariseRuns([
  user('u1', 0), asst('a1', 100, met()),
  user('u2', 10_000), asst('a2', 10_100, met())
])
check('a second prompt starts a second run', r.length === 2)
check('runs keep their own prompts', r[0].id === 'u1' && r[1].id === 'u2')

/* agentic: three requests with tool gaps between them */
r = summariseRuns([
  user('u1', 0),
  asst('a1', 0, met({ totalMs: 2000, completionTokens: 50, ttftMs: 500 })),
  { id: 't1', role: 'tool', content: 'result', createdAt: 2000 },
  asst('a2', 8000, met({ totalMs: 2000, completionTokens: 50, ttftMs: 500 })),
  { id: 't2', role: 'tool', content: 'result', createdAt: 10_000 },
  asst('a3', 16_000, met({ totalMs: 2000, completionTokens: 50, ttftMs: 500 }))
])
check('steps counts model requests', r[0].steps === 3)
check('wall clock covers the whole agentic turn', r[0].wallMs === 18_000, `${r[0].wallMs}ms`)
check('model time excludes the tool gaps', r[0].modelMs === 6000)
check('tool time is what the model was not doing', r[0].toolMs === 12_000,
  'the number that says "the wait was tools, not the GPU"')
check('completion tokens are summed', r[0].completionTokens === 150)

/* rates are totals, never a mean of per-request rates */
r = summariseRuns([
  user('u1', 0),
  asst('a1', 0, met({ completionTokens: 10, ttftMs: 1000, totalMs: 2000 })),
  asst('a2', 0, met({ completionTokens: 990, ttftMs: 1000, totalMs: 100_000 }))
])
const expected = 1000 / ((102_000 - 2000) / 1000)
check('decode rate is total tokens over total decode time',
  Math.abs(r[0].decodeTps - expected) < 0.001,
  'a mean of the two rates would read ~10x too fast')

/* a run still in flight must not claim a duration */
r = summariseRuns([user('u1', 0), asst('a1', 100, undefined, { streaming: true })])
check('a running turn reports no wall clock', r[0].wallMs === null && r[0].running === true)
check('a running turn reports no tool time', r[0].toolMs === null)

/* errors are carried so a fast run is not mistaken for a good one */
r = summariseRuns([user('u1', 0), asst('a1', 100, met(), { error: 'terminated' })])
check('an error is surfaced on the run', r[0].error === 'terminated')

/* messages before any prompt belong to nothing */
r = summariseRuns([asst('a0', 0, met()), user('u1', 10), asst('a1', 20, met())])
check('content before the first prompt is not attributed', r.length === 1 && r[0].steps === 1)
check('an empty conversation yields no runs', summariseRuns([]).length === 0)

console.log(fail === 0 ? '\x1b[32mall run-summary checks passed\x1b[0m' : `\x1b[31m${fail} failed\x1b[0m`)
process.exit(fail === 0 ? 0 : 1)
