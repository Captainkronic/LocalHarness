#!/usr/bin/env node
/**
 * Checks the context trimmer.
 *
 * The invariants matter more than the arithmetic. A trimmer that frees tokens
 * but splits an assistant tool_calls message from its tool replies produces a
 * request the server rejects outright — so a "working" trim would break every
 * later turn in that conversation. These assertions are that rule, plus the two
 * others that make a trimmed conversation still make sense: the system prompt
 * survives, and the newest exchange survives.
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-trim-'))
await writeFile(join(dir, 'e.ts'),
  `export { trimToBudget, countConversationTokens } from '${ROOT}/src/main/llm/prompt'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { trimToBudget, countConversationTokens } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}

const pad = (n) => 'x'.repeat(n * 4)

/** A conversation with tool calls in the middle of it. */
const convo = () => [
  { role: 'system', content: 'You are JARVIS.' },
  { role: 'user', content: `first question ${pad(200)}` },
  { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_emails', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: `mail results ${pad(200)}` },
  { role: 'assistant', content: `answer one ${pad(200)}` },
  { role: 'user', content: `second question ${pad(200)}` },
  { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c2', content: `weather ${pad(200)}` },
  { role: 'assistant', content: `answer two ${pad(200)}` },
  { role: 'user', content: 'newest question' }
]

/** Every tool message must be preceded by the assistant that called it. */
const pairsIntact = (msgs) => {
  const open = new Set()
  for (const m of msgs) {
    if (m.role === 'assistant') {
      open.clear()
      for (const c of m.tool_calls ?? []) open.add(c.id)
    } else if (m.role === 'tool') {
      if (!open.has(m.tool_call_id)) return false
    } else {
      open.clear()
    }
  }
  return true
}

const full = convo()
const fullCost = countConversationTokens(full)
check('untouched when it already fits', trimToBudget(full, fullCost + 100) === full, `${fullCost} tok`)
check('untouched when budget is 0 (disabled)', trimToBudget(full, 0) === full)

for (const budget of [200, 400, 600, 900, 1200, fullCost - 1]) {
  const t = trimToBudget(full, budget)
  const cost = countConversationTokens(t)
  const sys = t.filter((m) => m.role === 'system')
  const marked = sys.some((m) => m.content.includes('dropped'))
  check(`budget ${budget}: system prompt survives`, t[0].content === 'You are JARVIS.')
  check(`budget ${budget}: tool pairs intact`, pairsIntact(t))
  check(`budget ${budget}: newest question survives`,
    t[t.length - 1].content === 'newest question')
  check(`budget ${budget}: marker present`, marked)
  check(`budget ${budget}: got smaller`, cost < fullCost, `${fullCost} -> ${cost}`)
}

// A very small budget must still be coherent rather than empty.
const tiny = trimToBudget(full, 10)
check('tiny budget keeps system + newest exchange', tiny[0].role === 'system' && tiny[tiny.length - 1].content === 'newest question', `${tiny.length} messages`)
check('tiny budget keeps pairs intact', pairsIntact(tiny))

// onTrim reports what really went.
let info = null
const t2 = trimToBudget(full, 600, (i) => { info = i })
check('onTrim fires with counts', info !== null && info.messages > 0 && info.tokens > 0,
  info ? `${info.messages} msgs / ${info.tokens} tok dropped, ${info.kept} kept` : '')
check('onTrim kept count matches output', info !== null && info.kept === t2.length - 2,
  info ? `${info.kept} vs ${t2.length - 2}` : '')

// Nothing to drop: a single exchange cannot be trimmed further.
const one = [{ role: 'system', content: 'sys' }, { role: 'user', content: pad(500) }]
check('single exchange is never dropped', trimToBudget(one, 5) === one)

await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall trim checks passed\x1b[0m\n' : `\n\x1b[31m${fail} failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
