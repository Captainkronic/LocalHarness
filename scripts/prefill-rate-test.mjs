#!/usr/bin/env node
/**
 * Prefill rates, and the cached readings that must never become one.
 *
 * prefillTps is promptTokens / ttft. When the server reuses a cached prefix it
 * never processed those tokens, so the figure is arithmetically correct and
 * physically meaningless — 47k tokens "in" 1.6s reads as 29,755 tok/s on a box
 * that really does about 250.
 *
 * Left in, it does damage in three places: the gauge quotes it, the sparkline
 * is flattened by it, and — worst — the payload budget divides by it and tells
 * you a 1.4k-token MCP payload is free. This file pins all three.
 *
 *   node scripts/prefill-rate-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'prefill-'))
await writeFile(join(dir, 'e.ts'),
  `export { prefillRate } from '${ROOT}/src/renderer/lib/rates'\n` +
  `export { formatPrefill, PREFILL_CEILING_TPS } from '${ROOT}/src/renderer/lib/format'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const { prefillRate, formatPrefill, PREFILL_CEILING_TPS } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

const rec = (prefillTps, model = 'qwen3.8-27b') => ({ prefillTps, tps: 17, model, ts: 1 })
const noLive = { tps: null, estimated: false }

console.log('\nFormatting')
check('a real rate is printed with its unit', formatPrefill(250) === '250 tok/s',
  `got ${JSON.stringify(formatPrefill(250))}`)
/* formatPrefill appends the unit; the HUD gauge renders the unit in its own
   slot, so it must NOT use this helper or it prints "250 tok/s tok/s". */
check('the cached case carries no unit to double up', formatPrefill(29755) === 'cached')
check('a cached reading says so', formatPrefill(29755) === 'cached')
check('the ceiling itself is still a rate', formatPrefill(PREFILL_CEILING_TPS) !== 'cached')
check('null is not invented', formatPrefill(null) !== 'cached')

console.log('\nThe estimator ignores cached readings')
/* The exact shape observed: a run whose prefix is cached from the second
   request onward, so all but one reading is absurd. */
const mostlyCached = [rec(250), rec(29755), rec(24262), rec(16440), rec(22185)]
const r = prefillRate(mostlyCached, 'qwen3.8-27b', noLive)
check('the median is a real rate, not a cached one', r.tps <= PREFILL_CEILING_TPS,
  `got ${r.tps} tok/s`)
check('and it is the one genuine reading', r.tps === 250, `got ${r.tps}`)

const allCached = [rec(29755), rec(24262), rec(22185)]
const r2 = prefillRate(allCached, 'qwen3.8-27b', noLive)
check('with nothing but cached readings it does NOT claim a measurement',
  r2.measured === false || r2.tps <= PREFILL_CEILING_TPS,
  `measured=${r2.measured} tps=${r2.tps}`)

console.log('\nThe cost it feeds must not read as free')
/* This is the number a person acts on: "your MCP payload adds N seconds to
   every turn". Divided by a cached rate it rounds to nothing. */
const payloadTokens = 1400
const honest = prefillRate([rec(250)], 'qwen3.8-27b', noLive)
const polluted = prefillRate(mostlyCached, 'qwen3.8-27b', noLive)
const msHonest = (payloadTokens / honest.tps) * 1000
const msActual = (payloadTokens / polluted.tps) * 1000
check('1.4k tokens costs seconds, not milliseconds', msActual > 1000,
  `${Math.round(msActual)}ms — a cached median would have said ~47ms`)
check('and it matches the honest rate', Math.abs(msActual - msHonest) < 1)

console.log('\nReal rates still work')
const real = prefillRate([rec(160), rec(250), rec(190)], 'qwen3.8-27b', noLive)
check('a normal spread is measured', real.measured === true)
check('and the median is the middle value', real.tps === 190, `got ${real.tps}`)
check('records for other models are not mixed in', (() => {
  const mixed = [rec(250, 'qwen3.8-27b'), rec(3000, 'tiny-1b'), rec(240, 'qwen3.8-27b')]
  return prefillRate(mixed, 'qwen3.8-27b', noLive).tps <= 250
})(), 'a 1B model rate leaked into a 27B estimate')

console.log(failed === 0 ? '\n\x1b[32mall prefill-rate checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
