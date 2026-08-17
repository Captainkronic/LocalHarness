#!/usr/bin/env node
/**
 * Finds which part of the Live system prompt suppresses tool calling.
 *
 * A minimal system prompt gets 5/5 tool calls out of this model; the full
 * JARVIS prompt gets 0/3 on the same question. Something in between is the
 * cause, and guessing at it has already made things worse twice. So: build the
 * prompt up a section at a time and measure each, changing exactly one thing
 * per step.
 *
 *   node scripts/prompt-bisect.mjs [model] [repeats]
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = process.argv[2] ?? 'google/gemma-4-e4b'
const N = Number(process.argv[3] ?? 4)
const BASE = process.env.LH_BASE_URL ?? 'http://127.0.0.1:1235/v1'

const dir = await mkdtemp(join(tmpdir(), 'lh-bisect-'))
await writeFile(join(dir, 'e.ts'), `export { WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim } })
const { WORKFLOW_BY_ID } = await import(pathToFileURL(out).href)
const FULL = WORKFLOW_BY_ID.live.systemPrompt

/* Split the real prompt on blank lines so the variants are made of its ACTUAL
   text, not a paraphrase of it. */
const BLOCKS = FULL.split('\n\n').map((b) => b.trim()).filter(Boolean)
BLOCKS.forEach((b, i) => console.log(`  \x1b[2m[${i}] ${b.split('\n')[0].slice(0, 72)}\x1b[0m`))

/** Two zero-argument tools — the shape that fails. */
const TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: "Current weather and forecast for any city, instantly. Use this for any weather question instead of searching the web.",
    parameters: { type: 'object', properties: {
      location: { type: 'string', description: "City name, e.g. 'Austin' or 'Paris, France'. Omit to use the configured home location." },
      days: { type: 'integer', default: 1, minimum: 1, maximum: 7 } } } } },
  { type: 'function', function: { name: 'get_news', description: 'Current news headlines.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, count: { type: 'integer', default: 6 } } } } }
]

const ASKS = ["what's the weather like?", "what's in the news?", 'do I need a coat?']

async function rate(sys) {
  let calls = 0, total = 0
  const seen = new Set()
  for (const ask of ASKS) {
    for (let i = 0; i < N; i++) {
      total++
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.6, top_p: 0.95, max_tokens: 512,
          reasoning_effort: 'none', messages: [{ role: 'system', content: sys }, { role: 'user', content: ask }], tools: TOOLS })
      })
      if (!r.ok) { seen.add(`HTTP ${r.status}`); continue }
      const m = (await r.json()).choices?.[0]?.message ?? {}
      if ((m.tool_calls ?? []).length > 0) calls++
      else seen.add((m.content ?? '').trim().slice(0, 46))
    }
  }
  return { calls, total, seen: [...seen].slice(0, 2) }
}

const VARIANTS = [
  { id: 'minimal', sys: 'You are a voice assistant. Use tools to answer.' },
  ...BLOCKS.map((_, i) => ({ id: `blocks 0..${i}`, sys: BLOCKS.slice(0, i + 1).join('\n\n') })),
  { id: 'FULL', sys: FULL }
]

console.log(`\n\x1b[1m${MODEL}\x1b[0m — ${ASKS.length} asks x ${N}\n`)
for (const v of VARIANTS) {
  const { calls, total, seen } = await rate(v.sys)
  const pct = calls / total
  const colour = pct === 1 ? '\x1b[32m' : pct === 0 ? '\x1b[31m' : '\x1b[33m'
  console.log(`${colour}${String(calls).padStart(2)}/${total}\x1b[0m  ${v.id.padEnd(14)} \x1b[2m${seen.join(' | ').slice(0, 96)}\x1b[0m`)
}
await rm(dir, { recursive: true, force: true })
