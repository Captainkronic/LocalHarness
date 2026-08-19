#!/usr/bin/env node
/**
 * Measures what giving the Live workflow tools actually costs.
 *
 * Live is the one workflow where payload is latency the user hears, so this
 * starts exactly the servers the `live` profile declares, prints the real
 * tools/list cost per server, and converts it to seconds of prefill at the
 * measured rate of the model Live runs on.
 *
 *   node scripts/live-tools-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-livetools-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { McpManager } from '${ROOT}/src/main/mcp/manager'
   export { estimateTokens } from '${ROOT}/src/main/mcp/tokens'
   export { WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`
)
const shim = join(dir, 'electron-shim.mjs')
await writeFile(
  shim,
  `import { tmpdir } from 'node:os'
   export const app = { getPath: () => tmpdir(), getVersion: () => '0.1.0' }
   export default { app }\n`
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, 
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim }
})
const { McpManager, estimateTokens, WORKFLOW_BY_ID } = await import(pathToFileURL(outfile).href)

/** Measured on gemma-4-e4b, the model the Live workflow runs on. */
const PREFILL_TPS = 250

const wanted = WORKFLOW_BY_ID.live.mcpServers
console.log(`\n\x1b[1mLive workflow servers:\x1b[0m ${wanted.join(', ') || '(none)'}\n`)

const mcp = new McpManager({
  onLog: (level, scope, msg) => {
    console.log(`  \x1b[2m${level} ${scope}: ${msg}\x1b[0m`)
  },
  onStates: () => {}
})

const t0 = Date.now()
await mcp.applySet(wanted)
// applySet queues the transitions and returns; readiness is what we are timing.
const deadline = Date.now() + 60_000
while (Date.now() < deadline) {
  const live = mcp.states().filter((s) => wanted.includes(s.id))
  if (live.every((s) => s.status !== 'starting')) break
  await new Promise((r) => setTimeout(r, 200))
}
const startMs = Date.now() - t0

let fail = 0
for (const state of mcp.states()) {
  if (!wanted.includes(state.id)) continue
  const allow = WORKFLOW_BY_ID.live.mcpTools?.[state.id]
  if (state.status === 'ready') {
    console.log(
      `  \x1b[32mready\x1b[0m ${state.id.padEnd(12)} ${String(state.tools.length).padStart(2)} tools  ${String(state.tokenCost).padStart(5)} tok`
    )
    for (const t of state.tools) {
      const on = allow === undefined || allow.includes(t.name)
      console.log(`         ${on ? '\x1b[32m+\x1b[0m' : '\x1b[2m-'} ${t.name}\x1b[0m`)
    }
  } else {
    fail++
    console.log(`  \x1b[31m${state.status}\x1b[0m ${state.id.padEnd(12)} ${state.error ?? ''}`)
  }
}

const tools = mcp.wireTools(WORKFLOW_BY_ID.live.mcpTools)
const wireTokens = estimateTokens(JSON.stringify(tools))
console.log(
  `\n  ${tools.length} tools on the wire, \x1b[1m${wireTokens} tokens\x1b[0m ` +
    `= \x1b[1m${(wireTokens / PREFILL_TPS).toFixed(1)}s\x1b[0m of prefill per spoken turn at ${PREFILL_TPS} tok/s`
)
console.log(`  servers started in ${startMs}ms\n`)

/* ------------------------------------------------------------------ */
/* A real spoken turn, end to end                                     */
/* ------------------------------------------------------------------ */

// The loop is only worth anything if the model actually reaches for a tool
// under the Live workflow's own settings — small, terse, and with reasoning
// switched OFF, which is exactly the configuration most likely to skip the
// call and answer from memory instead. That is the thing to test.
const BASE = process.env.LH_BASE_URL ?? 'http://127.0.0.1:1235/v1'
const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [WORKFLOW_BY_ID.live.preferredModel]
const ASKS = [
  "what's the weather like?",
  'do I have any new email?'
]

async function turn(model, ask) {
  const messages = [
    { role: 'system', content: WORKFLOW_BY_ID.live.systemPrompt },
    { role: 'user', content: ask }
  ]
  const rounds = []
  for (let round = 0; round < 3; round++) {
    const t0 = Date.now()
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: WORKFLOW_BY_ID.live.sampling.temperature,
        top_p: WORKFLOW_BY_ID.live.sampling.topP,
        max_tokens: WORKFLOW_BY_ID.live.sampling.maxTokens,
        reasoning_effort: WORKFLOW_BY_ID.live.sampling.reasoningEffort,
        tools: round < 2 ? tools.map((t) => ({ type: 'function', function: t.function })) : undefined
      })
    })
    if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` }
    const body = await res.json()
    const msg = body.choices?.[0]?.message ?? {}
    const ms = Date.now() - t0
    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      return { rounds, text: (msg.content ?? '').trim(), ms, tokens: body.usage?.prompt_tokens }
    }
    messages.push(msg)
    for (const c of calls) {
      let out
      try {
        const raw = JSON.parse(c.function.arguments || '{}')
        // Mirrors dropEmptyArgs() in live/session.ts.
        const clean = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => !(typeof v === 'string' && v.trim() === ''))
        )
        const r = await mcp.callTool(c.function.name, clean)
        out = r.text
      } catch (err) {
        out = `The tool failed: ${err.message}`
      }
      rounds.push({ name: c.function.name, args: c.function.arguments, chars: out.length })
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, 4000) })
    }
  }
  return { rounds, text: '(never stopped calling tools)' }
}

for (const model of MODELS) {
  console.log(`
[1m${model}[0m`)
  for (const ask of ASKS) {
    console.log(`
  [36m"${ask}"[0m`)
    const r = await turn(model, ask)
    if (r.error) {
      fail++
      console.log(`  [31merror[0m ${r.error}`)
      continue
    }
    if (!r.rounds || r.rounds.length === 0) {
      fail++
      console.log(`  [31mno tool call[0m — answered from memory, which is a hallucination risk`)
    }
    for (const c of r.rounds ?? []) {
      console.log(`  [32mcalled[0m ${c.name} ${c.args} [2m-> ${c.chars} chars[0m`)
    }
    console.log(`  [1mspoke[0m ${r.ms ?? '?'}ms: ${r.text}`)
  }
}

await mcp.shutdown()
await rm(dir, { recursive: true, force: true })
process.exit(fail > 0 ? 1 : 0)
