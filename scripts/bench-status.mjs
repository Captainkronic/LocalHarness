#!/usr/bin/env node
/**
 * A live read-out of a code-bench run, for watching from somewhere else.
 *
 * The bench prints a spinner and a line per completed turn, which is fine when
 * you are looking at the terminal and useless when you are not. This turns the
 * same log into a periodic block: what phase it is in, how full the context is,
 * how close the reasoning is to the circuit breaker, and whether anything has
 * actually been written to disk yet.
 *
 * The reasoning-cap line is the point. On high effort a turn can spend
 * thousands of tokens thinking with nothing to show, and the only question
 * worth asking while it does is "is this deliberating, or is it spiralling".
 *
 *   node scripts/bench-status.mjs <log> <workspace> [--watch <seconds>]
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const [log, workspace] = process.argv.slice(2)
const watchIdx = process.argv.indexOf('--watch')
const everyMs = watchIdx > 0 ? Number(process.argv[watchIdx + 1] || 60) * 1000 : 0

/** From the Code workflow: maxTokens 16384, cap is half of it. */
const REASONING_CAP = 8192

const bar = (frac, width = 22) => {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)))
  return '█'.repeat(n) + '·'.repeat(width - n)
}

async function snapshot() {
  const raw = await readFile(log, 'utf8').catch(() => '')
  const lines = raw.replace(/\r/g, '\n').split('\n')

  const header = Object.fromEntries(
    lines
      .filter((l) => /^ {2}(model|effort|window|workspace)\s/.test(l))
      .map((l) => l.trim().split(/\s+(.+)/).slice(0, 2))
  )
  // `window` arrives as "61440 tokens", so a bare Number() is NaN.
  const windowTokens = Number(String(header.window ?? '').replace(/[^0-9]/g, '')) || null
  const turns = lines.filter((l) => l.startsWith('  turn '))
  const spinner = [...lines].reverse().find((l) => /^\s+\d+s\s+(idle|queued|prefill|decode|tool)/.test(l))
  const done = lines.some((l) => l.includes('run saved to'))

  const out = []
  out.push(`model ${header.model ?? '?'}   effort ${header.effort ?? '?'}   window ${windowTokens ?? '?'}`)

  if (spinner) {
    const [, secs, phase, tok] = spinner.match(/(\d+)s\s+(\w+)\s+(\d+) tok/) ?? []
    const t = Number(tok || 0)
    out.push('')
    out.push(`  ${done ? 'FINISHED' : 'RUNNING'}   ${secs}s elapsed   phase ${phase}`)
    if (!done) {
      out.push(`  generated ${t} tokens this turn`)
      // The breaker only counts reasoning with nothing written and no tool
      // pending, so this is an upper bound, not a verdict.
      out.push(`  vs runaway cap  ${bar(t / REASONING_CAP)} ${t}/${REASONING_CAP}`)
    }
  }

  if (turns.length) {
    out.push('')
    out.push('  turns completed')
    for (const t of turns.slice(-8)) out.push('  ' + t.trim())
  } else {
    out.push('')
    out.push('  no turn has completed yet')
  }

  const files = await readdir(workspace).catch(() => [])
  out.push('')
  if (files.length === 0) {
    out.push('  workspace  empty — nothing written yet')
  } else {
    for (const f of files) {
      const s = await stat(join(workspace, f)).catch(() => null)
      out.push(`  workspace  ${f}  ${s ? s.size : '?'} bytes`)
    }
  }
  return out.join('\n')
}

if (everyMs === 0) {
  console.log(await snapshot())
} else {
  for (;;) {
    console.log('\n' + (await snapshot()))
    const raw = await readFile(log, 'utf8').catch(() => '')
    if (raw.includes('run saved to')) break
    await new Promise((r) => setTimeout(r, everyMs))
  }
}
