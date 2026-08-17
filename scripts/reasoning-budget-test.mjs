#!/usr/bin/env node
/**
 * Does reasoning_effort actually constrain this model?
 *
 * The Code workflow already sends effort 'low' with a 16,384 token ceiling, and
 * a real request still spent every one of those tokens reasoning and returned
 * no answer — twenty minutes, finish_reason 'length'. Before adding another
 * guess, measure whether the knob does anything at all on this model.
 *
 *   node scripts/reasoning-budget-test.mjs [model]
 */
const BASE = process.env.LH_BASE_URL ?? 'http://127.0.0.1:1235/v1'
const MODEL = process.argv[2] ?? 'qwen/qwen3.8-27b'

/** Representative of what makes it think hard: a design question with tradeoffs. */
const ASK =
  'I need a fixed-timestep game loop in JavaScript that stays stable when the ' +
  'tab is backgrounded. Give me the code and say why the accumulator is clamped.'

const VARIANTS = ['none', 'low', 'medium', 'high', undefined]

console.log(`\n\x1b[1m${MODEL}\x1b[0m — does reasoning_effort bind?\n`)
console.log('  effort   reasoning   content   finish      elapsed')

for (const effort of VARIANTS) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: ASK }],
    temperature: 0.2,
    max_tokens: 2048
  }
  if (effort !== undefined) body.reasoning_effort = effort

  const t0 = Date.now()
  let r
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err) {
    console.log(`  ${String(effort ?? '(unset)').padEnd(8)} request failed: ${err.message}`)
    continue
  }
  if (!r.ok) {
    console.log(`  ${String(effort ?? '(unset)').padEnd(8)} HTTP ${r.status} ${(await r.text()).slice(0, 90)}`)
    continue
  }
  const j = await r.json()
  const choice = j.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  // LM Studio reports reasoning either as a field or inside completion tokens.
  const reasoningText = msg.reasoning ?? msg.reasoning_content ?? ''
  const reasoningTok =
    j.usage?.completion_tokens_details?.reasoning_tokens ??
    (reasoningText ? Math.ceil(reasoningText.length / 4) : 0)
  const contentTok = Math.ceil((msg.content ?? '').length / 4)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const flag = choice.finish_reason === 'length' ? '\x1b[31m' : '\x1b[32m'
  console.log(
    `  ${String(effort ?? '(unset)').padEnd(8)} ${String(reasoningTok).padStart(9)} ` +
      `${String(contentTok).padStart(9)}   ${flag}${String(choice.finish_reason).padEnd(10)}\x1b[0m` +
      `  ${secs}s`
  )
}
console.log(
  '\n  If reasoning is flat across every effort level, the knob is not bound on\n' +
    '  this model and the fix has to be a budget guard, not a setting.\n'
)
