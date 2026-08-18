#!/usr/bin/env node
/**
 * Which sampling knobs actually shorten qwen's reasoning?
 *
 * The app sends only temperature and top_p. A reasoning model that spirals —
 * restating the problem, re-deriving what it just decided — is exhibiting
 * repetition, and repetition penalties are the standard tool for it, so it is
 * worth knowing whether they bind here before adding controls nobody needs.
 *
 * Measured on a deliberately open-ended prompt, because that is what triggers
 * the loop in practice: an under-specified design task with room to deliberate.
 *
 * One request at a time — the Studio serves one at a time regardless, and
 * overlapping them would measure queueing rather than sampling.
 *
 *   node scripts/thinking-levers.mjs [model]
 */
const BASE = process.env.LH_BASE_URL ?? 'http://127.0.0.1:1235/v1'
const MODEL = process.argv[2] ?? 'qwen/qwen3.8-27b'

/** Open-ended on purpose: this is the shape that makes it deliberate. */
const ASK =
  'Design and write a small browser game in one HTML file. Decide the genre, ' +
  'the mechanics, the controls and the visual style yourself, then write it.'

const BASELINE = { temperature: 0.2, top_p: 0.9 }

const TRIALS = [
  { label: 'baseline', extra: {} },
  { label: 'temp 0.0', extra: { temperature: 0 } },
  { label: 'temp 0.6', extra: { temperature: 0.6 } },
  { label: 'top_p 0.5', extra: { top_p: 0.5 } },
  { label: 'top_k 20', extra: { top_k: 20 } },
  { label: 'top_k 1', extra: { top_k: 1 } },
  { label: 'min_p 0.1', extra: { min_p: 0.1 } },
  { label: 'rep 1.15', extra: { repetition_penalty: 1.15 } },
  { label: 'freq 0.5', extra: { frequency_penalty: 0.5 } },
  { label: 'pres 0.5', extra: { presence_penalty: 0.5 } },
  { label: 'effort none', extra: { reasoning_effort: 'none' } }
]

/** Enough room that a trial fails by finishing, not by hitting the wall —
 *  except where hitting the wall IS the finding. */
const MAX_TOKENS = 3000

console.log(`\n\x1b[1m${MODEL}\x1b[0m — what actually shortens the thinking?`)
console.log(`  baseline temp ${BASELINE.temperature} · top_p ${BASELINE.top_p} · max_tokens ${MAX_TOKENS}\n`)
console.log('  trial          reasoning   answer   finish     elapsed   verdict')

const rows = []
for (const t of TRIALS) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: ASK }],
    max_tokens: MAX_TOKENS,
    ...BASELINE,
    ...t.extra
  }
  const t0 = Date.now()
  let r
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err) {
    console.log(`  ${t.label.padEnd(13)} request failed: ${err.message}`)
    continue
  }
  if (!r.ok) {
    // A rejected parameter is itself a result: it means the knob is not
    // available on this stack and should not be exposed in the UI.
    const text = (await r.text()).slice(0, 70).replace(/\s+/g, ' ')
    console.log(`  ${t.label.padEnd(13)} \x1b[33mrejected\x1b[0m  ${text}`)
    rows.push({ ...t, rejected: true })
    continue
  }
  const j = await r.json()
  const msg = j.choices?.[0]?.message ?? {}
  const finish = j.choices?.[0]?.finish_reason ?? '?'
  const reasoning =
    j.usage?.completion_tokens_details?.reasoning_tokens ??
    Math.ceil((msg.reasoning ?? msg.reasoning_content ?? '').length / 4)
  const answer = Math.ceil((msg.content ?? '').length / 4)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const ok = finish !== 'length' && answer > 0
  rows.push({ ...t, reasoning, answer, finish, secs: Number(secs), ok })
  console.log(
    `  ${t.label.padEnd(13)} ${String(reasoning).padStart(9)} ${String(answer).padStart(8)}   ` +
      `${(ok ? '\x1b[32m' : '\x1b[31m') + finish.padEnd(9) + '\x1b[0m'} ${String(secs).padStart(6)}s   ` +
      `${ok ? 'answered' : 'NO ANSWER'}`
  )
}

const base = rows.find((r) => r.label === 'baseline')
const usable = rows.filter((r) => r.ok && !r.rejected && r.label !== 'baseline')
console.log('\n\x1b[1m  ranked by reasoning spent, answered runs only\x1b[0m')
for (const r of usable.sort((a, b) => a.reasoning - b.reasoning)) {
  const delta = base?.reasoning ? Math.round((1 - r.reasoning / base.reasoning) * 100) : 0
  console.log(
    `  ${r.label.padEnd(13)} ${String(r.reasoning).padStart(6)} tok  ` +
      `${delta > 0 ? `\x1b[32m${delta}% less\x1b[0m` : `${-delta}% more`} than baseline`
  )
}
const rejected = rows.filter((r) => r.rejected).map((r) => r.label)
if (rejected.length) console.log(`\n  not supported by this server: ${rejected.join(', ')}`)
console.log()
