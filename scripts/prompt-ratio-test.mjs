#!/usr/bin/env node
/**
 * Learning how badly the character-based token estimate undercounts.
 *
 * `estimateTokens` is characters/4 — right for English prose, wrong for what an
 * agentic coding turn is made of: source, JSON tool arguments, diffs, stack
 * traces. Measured live on a flight-sim build, the meter read 42.3k while the
 * server reported 63.7k prompt tokens for the same request. An effective 2.66
 * characters per token.
 *
 * That is not cosmetic. The history budget is derived from the same estimate,
 * so the trimmer believed it had ~20k of headroom that did not exist, never
 * fired, and the turn died with finish_reason 'length' having spent its whole
 * output budget reasoning and produced nothing at all.
 *
 * No guessing at a better constant is needed: the server reports real
 * prompt_tokens on every request, so the ratio is measured rather than assumed.
 * What these checks protect is that it stays measured — and that a model with
 * no measurements yet behaves exactly as it did before.
 *
 *   node scripts/prompt-ratio-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-ratio-'))
await writeFile(join(dir, 'e.ts'),
  `export { RateCalibrator } from '${ROOT}/src/main/telemetry/meter'\n` +
  `export { buildContextUsage } from '${ROOT}/src/main/llm/prompt'\n`)
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
const { RateCalibrator, buildContextUsage } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n\x1b[1mUnmeasured models are untouched\x1b[0m')
const fresh = new RateCalibrator()
check('an unseen model has a ratio of exactly 1', fresh.promptTokenRatio('qwen') === 1,
  'anything else would trim a conversation on the strength of a guess')
check('an unknown id is also 1', fresh.promptTokenRatio('') === 1)

console.log('\n\x1b[1mIt learns the real ratio\x1b[0m')
const c = new RateCalibrator()
/* The live measurement that prompted this. */
for (let i = 0; i < 40; i++) c.observePromptEstimate('qwen', 42300, 63700)
const learned = c.promptTokenRatio('qwen')
check('it converges on the measured 1.5x', learned > 1.4 && learned < 1.6, String(learned))
check('one sample already moves it off 1', (() => {
  const one = new RateCalibrator()
  one.observePromptEstimate('qwen', 42300, 63700)
  return one.promptTokenRatio('qwen') > 1
})())
check('it is per model', c.promptTokenRatio('other') === 1,
  'one model\'s tokeniser says nothing about another\'s')

console.log('\n\x1b[1mIt refuses nonsense\x1b[0m')
const g = new RateCalibrator()
g.observePromptEstimate('m', 0, 1000);      check('zero estimate ignored', g.promptTokenRatio('m') === 1)
g.observePromptEstimate('m', 1000, 0);      check('zero actual ignored', g.promptTokenRatio('m') === 1)
g.observePromptEstimate('m', 1000, 100);    check('an absurdly LOW ratio is ignored', g.promptTokenRatio('m') === 1,
  '0.1x would hand the trimmer ten times the real budget')
g.observePromptEstimate('m', 1000, 900000); check('an absurdly HIGH ratio is ignored', g.promptTokenRatio('m') === 1,
  'scaling by 900 would trim every conversation to nothing')
g.observePromptEstimate('', 1000, 1500);    check('an empty model id is ignored', g.promptTokenRatio('') === 1)

console.log('\n\x1b[1mWhat it means for the budget\x1b[0m')
/* budget/ratio is the arithmetic the orchestrator does. With the measured 1.5x,
   a 44,475-token real budget must be spent as ~29.5k of ESTIMATE, which is the
   difference between trimming in time and dying at the output cap. */
const real = 44475
const spendable = Math.floor(real / learned)
check('a 1.5x undercount roughly two-thirds the spendable estimate',
  spendable > 28000 && spendable < 31000, String(spendable))
check('and it is strictly less than the raw budget', spendable < real)

console.log('\n\x1b[1mThe ratio must reach the METER, not just the budget\x1b[0m')
/*
 * Caught live, 126 minutes into an autonomous React build. The header read
 * "CTX 22.7k / 98.3k  23%" while the run rail, which prints the server's own
 * prompt_tokens for the last completed request, read 29.3k for that same
 * conversation at that same moment. The ratio was being learned and was being
 * applied to the history budget; it had simply never been applied to the number
 * on screen. The meter is what a user reads to decide whether there is room
 * left, and it was understating by 29% -- in the direction that looks safe.
 */
const usageArgs = (ratio) => ({
  system: 'x'.repeat(4000),
  tools: [],
  messages: [{ role: 'user', content: 'y'.repeat(80000) }],
  attachments: [{ tokens: 1500 }],
  max: 98300,
  ratio
})
const raw = buildContextUsage(usageArgs(undefined))
const cal = buildContextUsage(usageArgs(1.29))

check('an uncalibrated meter is unchanged', raw.used === buildContextUsage(usageArgs(1)).used)
check('and says so', raw.calibrated === false,
  'a raw guess and a measured figure must not render identically')
check('a measured ratio raises the reading', cal.used > raw.used)
check('and says so', cal.calibrated === true)
check('the breakdown still sums to the total',
  cal.breakdown.system + cal.breakdown.tools + cal.breakdown.messages +
    cal.breakdown.attachments === cal.used,
  'the segmented bar would otherwise not fill to the number beside it')
check('attachments are NOT scaled',
  cal.breakdown.attachments === raw.breakdown.attachments,
  'image tokens are exact counts, not character estimates -- a text correction would corrupt them')
check('text IS scaled', cal.breakdown.messages > raw.breakdown.messages)
check('the percentage moves with it', cal.fraction > raw.fraction,
  'the fraction is what colours the bar and fires the warning threshold')

/* The live numbers, end to end. */
const under = buildContextUsage({ ...usageArgs(1), messages: [{ role: 'user', content: 'z'.repeat(88000) }] })
const fixed = buildContextUsage({ ...usageArgs(1.29), messages: [{ role: 'user', content: 'z'.repeat(88000) }] })
check('a 23%-looking reading becomes a ~30% one',
  Math.round(fixed.fraction * 100) - Math.round(under.fraction * 100) >= 5,
  `${Math.round(under.fraction * 100)}% -> ${Math.round(fixed.fraction * 100)}%`)

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mall prompt-ratio checks passed\x1b[0m\n' : `\n\x1b[31m${failed} failed\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
