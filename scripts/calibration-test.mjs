#!/usr/bin/env node
/**
 * Regression test for the prefill rate calibrator.
 *
 * The numbers here are real measurements taken against qwen3.8-27b on the Mac
 * Studio, not invented fixtures:
 *   cold JIT load, 15 prompt tokens  -> 19,071ms TTFT
 *   warm,          15 prompt tokens  ->  1,372ms TTFT
 * The box's true prefill rate is ~170 tok/s, so any fit that lands near 10 or
 * near 0.8 tok/s is broken.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

function check(name, ok, detail) {
  console.log(`${ok ? '[32m  ok  [0m' : '[31m FAIL [0m'} ${name}${detail ? `  [2m${detail}[0m` : ''}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'lh-calib-'))
const entry = join(dir, 'e.ts')
await writeFile(entry, `export { RateCalibrator, TurnMeter } from '${ROOT}/src/main/telemetry/meter'\n`)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, 
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const { RateCalibrator, TurnMeter } = await import(pathToFileURL(outfile).href)

console.log('\n[1mPrefill calibration[0m\n')

/* --- a cold load must not teach the calibrator anything --- */
{
  const c = new RateCalibrator()
  c.observe('qwen', 15, 19_071, 36, 1_600)
  check('cold JIT load is discarded', c.prefillTps('qwen') === null, `got ${c.prefillTps('qwen')}`)
  check('decode still learned from the same turn', c.decodeTps('qwen') !== null, `${c.decodeTps('qwen')?.toFixed(1)} tok/s`)
}

/* --- a short warm prompt must not teach it either --- */
{
  const c = new RateCalibrator()
  c.observe('qwen', 15, 1_372, 36, 1_600)
  check(
    'short warm prompt does not set a rate',
    c.prefillTps('qwen') === null,
    'naive division would have said 10.9 tok/s'
  )
}

/* --- two depths must recover the true slope and the overhead --- */
{
  // Synthesised from overhead 1,300ms + 170 tok/s, the shape the box actually has.
  const overhead = 1_300
  const rate = 170
  const ttft = (tok) => overhead + (tok / rate) * 1000
  const c = new RateCalibrator()
  c.observe('qwen', 1_000, ttft(1_000), 40, 2_000)
  c.observe('qwen', 20_000, ttft(20_000), 40, 2_000)

  const fitted = c.prefillTps('qwen')
  const fittedOverhead = c.overheadMs('qwen')
  check(
    'two-point fit recovers the true rate',
    fitted !== null && Math.abs(fitted - rate) / rate < 0.05,
    `${fitted?.toFixed(1)} tok/s vs true ${rate}`
  )
  check(
    'fit separates the fixed overhead',
    Math.abs(fittedOverhead - overhead) < 250,
    `${Math.round(fittedOverhead)}ms vs true ${overhead}ms`
  )
}

/* --- a cold load mixed into good samples must not poison the fit --- */
{
  const overhead = 1_300
  const rate = 170
  const ttft = (tok) => overhead + (tok / rate) * 1000
  const c = new RateCalibrator()
  c.observe('qwen', 1_000, ttft(1_000), 40, 2_000)
  c.observe('qwen', 20_000, ttft(20_000), 40, 2_000)
  const before = c.prefillTps('qwen')
  c.observe('qwen', 15, 19_071, 36, 1_600) // eviction, then JIT reload
  const after = c.prefillTps('qwen')
  check('a later cold load leaves the fit intact', before === after, `${after?.toFixed(1)} tok/s`)
}

/* --- the meter must show nothing rather than a fabricated bar --- */
{
  const m = new TurnMeter()
  m.start('qwen', 5_000, null, 0)
  const s = m.snapshot()
  check('uncalibrated model shows no prefill progress', s.prefillProgress === null)
  check('uncalibrated model shows no ETA', s.prefillEtaMs === null)
  check('phase is prefill', s.phase === 'prefill', s.phase)
}

/* --- with calibration, the ETA includes the overhead --- */
{
  const m = new TurnMeter()
  m.start('qwen', 17_000, 170, 1_300)
  const s = m.snapshot()
  const expected = 1_300 + (17_000 / 170) * 1000 // 101.3s
  check(
    'ETA accounts for fixed overhead',
    s.prefillEtaMs !== null && Math.abs(s.prefillEtaMs - expected) < 500,
    `${((s.prefillEtaMs ?? 0) / 1000).toFixed(1)}s expected ${(expected / 1000).toFixed(1)}s`
  )
  check('progress is flagged as an estimate', s.prefillEstimated === true)
}

await rm(dir, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '[32mall calibration checks passed[0m\n' : `[31m${failures} failed[0m\n`)
process.exit(failures === 0 ? 0 : 1)
