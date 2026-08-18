#!/usr/bin/env node
/**
 * Does the local proxy survive a long stream, or does it drop it?
 *
 * The app points at 127.0.0.1:1235 — a single-threaded Python HTTPServer that
 * relays to LM Studio — not at the Studio directly. Turns have been dying with
 * undici's "terminated", which is what a client throws when a streaming body
 * ends unexpectedly. This runs the same long generation through both paths and
 * reports which one finishes.
 *
 * Same prompt, same parameters, same model, one at a time.
 */
const PROXY = 'http://127.0.0.1:1235/v1'
const DIRECT = 'http://adams-mac-studio.tailc7bb1e.ts.net:1234/v1'
const MODEL = 'qwen/qwen3.8-27b'

// Long enough to keep a stream open for minutes — that is the condition under test.
const ASK =
  'Write a complete single-file HTML Space Invaders clone with inline CSS and JS. ' +
  'Include the full game loop, alien grid, bullets, collision, lives and score. ' +
  'Output only the file contents.'

async function run(base, label) {
  const t0 = Date.now()
  let chunks = 0
  let chars = 0
  let firstByteMs = null
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: ASK }],
        max_tokens: 6000,
        temperature: 0.6,
        top_p: 0.9,
        frequency_penalty: 0.5,
        reasoning_effort: 'none',
        stream: true
      })
    })
    if (!r.ok) return { label, ok: false, why: `HTTP ${r.status}`, secs: 0 }
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstByteMs === null) firstByteMs = Date.now() - t0
      chunks += 1
      chars += value.length
    }
    return {
      label,
      ok: true,
      secs: Math.round((Date.now() - t0) / 1000),
      chunks,
      kb: (chars / 1024).toFixed(0),
      ttfbMs: firstByteMs
    }
  } catch (err) {
    return {
      label,
      ok: false,
      why: String(err?.cause?.message ?? err?.message ?? err),
      secs: Math.round((Date.now() - t0) / 1000),
      chunks,
      kb: (chars / 1024).toFixed(0)
    }
  }
}

console.log('\n\x1b[1mProxy vs direct — one long stream each\x1b[0m\n')
const results = []
for (const [base, label] of [
  [PROXY, 'proxy :1235'],
  [DIRECT, 'direct :1234']
]) {
  process.stdout.write(`  ${label.padEnd(14)} streaming… `)
  const r = await run(base, label)
  results.push(r)
  console.log(
    r.ok
      ? `\x1b[32mcompleted\x1b[0m  ${r.secs}s · ${r.chunks} chunks · ${r.kb}KB · ttfb ${r.ttfbMs}ms`
      : `\x1b[31mDIED\x1b[0m  after ${r.secs}s · ${r.chunks} chunks · ${r.kb}KB · ${r.why}`
  )
}

const [p, d] = results
console.log()
if (p.ok && d.ok) console.log('  Both survived — the proxy is not the cause on this sample.\n')
else if (!p.ok && d.ok) console.log('  \x1b[31mThe proxy dropped it and the direct connection did not.\x1b[0m\n')
else if (p.ok && !d.ok) console.log('  Direct dropped but the proxy held — the network to the Studio is suspect.\n')
else console.log('  Both died — the cause is upstream of both, in LM Studio itself.\n')
