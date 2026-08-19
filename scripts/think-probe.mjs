#!/usr/bin/env node
/**
 * How much does this model think, and which knobs actually change it?
 *
 * Written after a Tetris build spent nine minutes and ~8,000 tokens reasoning
 * without writing a line. The advice online is specific — Qwen's own docs give
 * thinking-mode sampling as temp 0.6 / top_p 0.95 / top_k 20 / min_p 0, and
 * describe a `thinking_budget` that caps thinking tokens outright — but none of
 * it is worth anything if the server in front of the model drops the parameter.
 * So every setting here is measured against Adam's actual endpoint rather than
 * quoted.
 *
 * Reports reasoning tokens, answer tokens and wall clock per trial.
 *
 *   node scripts/think-probe.mjs
 */
const BASE = 'http://adams-mac-studio.tailc7bb1e.ts.net:1235/v1'
const MODEL = process.env.PROBE_MODEL || 'qwen/qwen3.8-27b'

/* Small enough to run many times, hard enough to invite deliberation. The real
   Tetris prompt takes ten minutes a trial, which is not a probe. */
const TASK =
  'Write a complete playable Tetris in one self-contained HTML file. ' +
  'Canvas, arrow keys, line clears, score, game over. Reply with the file only.'

/*
 * Four settings, repeated.
 *
 * The first run of this used one sample per setting and I read differences
 * straight off them. Two of the trials set parameters this server provably
 * DROPS -- thinking_budget and chat_template_kwargs -- and they came back at
 * -18% and -30%. Since those cannot have done anything, that IS the noise
 * floor: run-to-run variance here is at least +/-30%, and every "effect"
 * smaller than that in the first pass was me reading tea leaves.
 *
 * So: repeats, and medians. The dropped-parameter trials are kept as a control
 * for exactly that reason -- if they ever separate from baseline again, the
 * repeat count is still too low.
 */
const TRIALS = [
  { name: 'baseline (harness)', body: { temperature: 0.6, top_p: 0.9, frequency_penalty: 0.5 } },
  { name: 'harness + effort low', body: { temperature: 0.6, top_p: 0.9, frequency_penalty: 0.5, reasoning_effort: 'low' } },
  { name: 'qwen sampling', body: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 } },
  { name: 'qwen sampling + low', body: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, reasoning_effort: 'low' } },
  { name: 'CONTROL (dropped param)', body: { temperature: 0.6, top_p: 0.9, frequency_penalty: 0.5, thinking_budget: 1500 } }
]

const REPEATS = Number(process.env.PROBE_REPEATS || 3)

const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS || 2500)

async function trial(t) {
  const started = Date.now()
  let res, data
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: TASK }],
        max_tokens: MAX_TOKENS,
        ...t.body
      })
    })
    data = await res.json()
  } catch (err) {
    return { ...t, error: String(err).slice(0, 90) }
  }
  if (data?.error) return { ...t, error: String(data.error.message ?? data.error).slice(0, 110) }

  const msg = data.choices?.[0]?.message ?? {}
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? ''
  const content = msg.content ?? ''
  const usage = data.usage ?? {}
  return {
    ...t,
    ms: Date.now() - started,
    reasoningChars: reasoning.length,
    contentChars: content.length,
    completionTokens: usage.completion_tokens ?? null,
    finish: data.choices?.[0]?.finish_reason ?? '?',
    wroteHtml: /<canvas|<!DOCTYPE|<html/i.test(content)
  }
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y)
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2)
}

console.log(`\n\x1b[1mthinking probe\x1b[0m  ${MODEL}   ${REPEATS} runs per setting\n`)
const summary = []
for (const t of TRIALS) {
  const runs = []
  for (let i = 0; i < REPEATS; i++) {
    const r = await trial(t)
    if (r.error) {
      console.log(`  ${t.name.padEnd(24)} run ${i + 1}  \x1b[31mREJECTED\x1b[0m ${r.error}`)
      continue
    }
    runs.push(r)
    console.log(
      `  ${t.name.padEnd(24)} run ${i + 1}  ` +
        `${String((r.ms / 1000).toFixed(0) + 's').padStart(5)}  ` +
        `reason ${String(r.reasoningChars).padStart(6)}  ` +
        `answer ${String(r.contentChars).padStart(6)}  ${r.finish}${r.wroteHtml ? ' · html' : ''}`
    )
  }
  if (runs.length === 0) continue
  summary.push({
    name: t.name,
    reason: median(runs.map((r) => r.reasoningChars)),
    answer: median(runs.map((r) => r.contentChars)),
    spread: Math.max(...runs.map((r) => r.reasoningChars)) - Math.min(...runs.map((r) => r.reasoningChars)),
    wrote: runs.filter((r) => r.wroteHtml).length,
    n: runs.length
  })
}

console.log('\n\x1b[1mmedians\x1b[0m')
console.log('  ' + 'setting'.padEnd(24) + 'reason'.padStart(8) + 'answer'.padStart(8) + 'spread'.padStart(8) + '  wrote html')
for (const s2 of summary) {
  console.log(
    '  ' + s2.name.padEnd(24) + String(s2.reason).padStart(8) + String(s2.answer).padStart(8) +
      String(s2.spread).padStart(8) + `  ${s2.wrote}/${s2.n}`
  )
}

const base = summary.find((s2) => s2.name.startsWith('baseline'))
const control = summary.find((s2) => s2.name.startsWith('CONTROL'))
if (base && control) {
  const noise = Math.round(Math.abs((control.reason - base.reason) / base.reason) * 100)
  console.log(`\n  noise floor from the control: ${noise}% — treat anything smaller as nothing.`)
  console.log('\n\x1b[1mvs baseline\x1b[0m')
  for (const s2 of summary) {
    if (s2 === base) continue
    const pct = Math.round(((s2.reason - base.reason) / base.reason) * 100)
    const real = Math.abs(pct) > noise ? '  \x1b[32mREAL\x1b[0m' : '  (within noise)'
    console.log(`  ${s2.name.padEnd(24)} ${pct >= 0 ? '+' : ''}${pct}%${real}`)
  }
}
console.log()
