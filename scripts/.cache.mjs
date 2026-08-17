// Is the prefix cache being hit between turns? Two requests sharing a long
// prefix: if the cache works, the second prefills only the new tail and its
// ttft collapses. If not, the agentic loop re-reads everything every round.
const BASE = 'http://127.0.0.1:1235/v1'
const MODEL = 'qwen/qwen3.8-27b'
const PREFIX = 'You are a terse assistant.\n' + 'Reference note. '.repeat(400)

async function turn(tail, label) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: PREFIX }, { role: 'user', content: tail }],
      max_tokens: 8, temperature: 0, reasoning_effort: 'none'
    })
  })
  const j = await r.json()
  const ms = Date.now() - t0
  const pt = j.usage?.prompt_tokens ?? 0
  console.log(`  ${label.padEnd(22)} prompt ${String(pt).padStart(5)} tok   ${String(ms).padStart(6)}ms   ${(pt / (ms / 1000)).toFixed(0)} tok/s apparent`)
  return ms
}

console.log('\n  cold vs warm prefix (identical 6k-token system prompt)\n')
const a = await turn('Say A.', 'first (cold)')
const b = await turn('Say B.', 'second (same prefix)')
const c = await turn('Say C.', 'third (same prefix)')
const best = Math.min(b, c)
console.log(
  `\n  ${a}ms -> ${best}ms  =  ${a > 0 ? Math.round((1 - best / a) * 100) : 0}% faster on a repeat prefix`
)
console.log(
  best < a * 0.5
    ? '  CACHE IS WORKING — a repeat prefix is much cheaper.\n'
    : '  NO MEANINGFUL CACHE REUSE — every turn re-reads the whole prompt.\n'
)
