#!/usr/bin/env node
/**
 * How far through the probe matrix we are, at a glance.
 *
 * Each run takes about three minutes, so a full matrix is over half an hour of
 * nothing to look at. This turns the log into a bar and a running table.
 *
 *   node scripts/probe-progress.mjs <log> [total] [--watch <seconds>]
 */
import { readFile } from 'node:fs/promises'

const [log, totalArg] = process.argv.slice(2)
const TOTAL = Number(totalArg) || 15
const watchIdx = process.argv.indexOf('--watch')
const everyMs = watchIdx > 0 ? Number(process.argv[watchIdx + 1] || 120) * 1000 : 0

const bar = (frac, w = 30) => {
  const n = Math.max(0, Math.min(w, Math.round(frac * w)))
  return '█'.repeat(n) + '░'.repeat(w - n)
}

async function render() {
  const raw = await readFile(log, 'utf8').catch(() => '')
  const lines = raw.split('\n')
  const runs = lines
    .map((l) => l.match(/^\s+(.+?)\s+run (\d)\s+(\d+)s\s+reason\s+(\d+)\s+answer\s+(\d+)\s+(\S+)(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      name: m[1].trim(), rep: +m[2], secs: +m[3],
      reason: +m[4], answer: +m[5], finish: m[6], html: /html/.test(m[7])
    }))

  const done = runs.length
  const model = (raw.match(/thinking probe\S*\s+(\S+)/) ?? [])[1] ?? '?'
  const secs = runs.reduce((a, r) => a + r.secs, 0)
  const avg = done ? secs / done : 0
  const left = Math.max(0, TOTAL - done)

  const out = []
  out.push(`  ${model}`)
  out.push(`  ${bar(done / TOTAL)}  ${done}/${TOTAL} runs`)
  out.push(
    `  elapsed ${Math.round(secs / 60)}m · avg ${avg.toFixed(0)}s/run · ~${Math.round((left * avg) / 60)}m left`
  )

  // Group by setting, so a finished setting reads as one row.
  const groups = new Map()
  for (const r of runs) {
    if (!groups.has(r.name)) groups.set(r.name, [])
    groups.get(r.name).push(r)
  }
  out.push('')
  out.push('  ' + 'setting'.padEnd(24) + 'runs'.padStart(5) + 'median'.padStart(9) + 'answer'.padStart(8) + '  ')
  for (const [name, rs] of groups) {
    const med = [...rs.map((r) => r.reason)].sort((a, b) => a - b)[Math.floor(rs.length / 2)]
    const ans = rs.filter((r) => r.answer > 0).length
    out.push(
      '  ' + name.padEnd(24) + `${rs.length}/3`.padStart(5) + String(med).padStart(9) +
        `${ans}/${rs.length}`.padStart(8) + (rs.length < 3 ? '  running' : '')
    )
  }
  return out.join('\n')
}

if (everyMs === 0) console.log(await render())
else
  for (;;) {
    console.log('\n' + (await render()))
    const raw = await readFile(log, 'utf8').catch(() => '')
    if (raw.includes('noise floor from the control')) break
    await new Promise((r) => setTimeout(r, everyMs))
  }
