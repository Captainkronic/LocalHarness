#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = '/Users/adam/LocalHarness'
const dir = await mkdtemp(join(tmpdir(), 'lh-cache-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { buildMessages, writtenFilesLine, trimToBudget } from '${ROOT}/src/main/llm/prompt'\n`
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true,
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main') }
})
const { buildMessages } = await import(pathToFileURL(outfile).href)

const SYS = 'You are a coding assistant.\n'.repeat(40)
const render = (msgs) =>
  msgs
    .map(
      (m) =>
        `<|${m.role}|>` +
        (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) +
        (m.tool_calls ? JSON.stringify(m.tool_calls) : '') +
        (m.tool_call_id ?? '')
    )
    .join('\n')
const cp = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i }

let id = 0
const conv = { id: 'c', workflowId: 'code', messages: [{ id: 'u', role: 'user', content: 'Build me a small site.', createdAt: 0 }] }
const files = ['index.html', 'styles.css', 'data.js']

const snaps = []
const sysMsgs = []
for (let step = 0; step < 10; step++) {
  const msgs = buildMessages(conv, SYS, false, { workspaceRoots: ['/Users/adam/w'] })
  snaps.push(render(msgs))
  sysMsgs.push(msgs[0].content); if(step<3) console.error("DBG step",step,"nmsgs",conv.messages.length,"roles",conv.messages.map(m=>m.role).join(","),"syslen",msgs[0].content.length)

  const isWrite = step % 2 === 0
  const callId = `call_${++id}`
  const path = files[step % files.length]
  const content = isWrite
    ? (path.endsWith('.css') ? `.hero{}\n.card{}\n.s${step}{}\n` : `export const v${step} = 1\n`) + 'a'.repeat(3000)
    : ''
  conv.messages.push({
    id: `a${step}`, role: 'assistant', content: 'Working on it.', createdAt: 0,
    toolCalls: [{
      id: callId, name: isWrite ? 'write_file' : 'read_file',
      arguments: JSON.stringify(isWrite ? { path, content } : { path }),
      status: 'ok',
      result: isWrite ? `Wrote ${path} (${120 + step} lines) ${(3.1 + step * 0.1).toFixed(1)} kB on disk, verified.` : 'file contents…'
    }]
  })
  conv.messages.push({ id: `t${step}`, role: 'tool', toolCallId: callId, content: 'ok', createdAt: 0 })
}

console.log('step | write? | sysLen | prefix reuse | first divergence lands in')
for (let i = 1; i < snaps.length; i++) {
  const p = cp(snaps[i - 1], snaps[i])
  const sysLen = sysMsgs[i].length + 10
  const where = p <= sysLen ? 'SYSTEM MESSAGE  <-- whole prompt lost' : 'transcript tail'
  console.log(
    `${String(i).padStart(4)} | ${(i % 2 === 0 ? 'yes' : 'no ').padStart(6)} | ${String(sysLen).padStart(6)} | ` +
    `${((p / snaps[i].length) * 100).toFixed(1).padStart(6)}% (${p}/${snaps[i].length}) | ${where}`
  )
}

console.log('\n--- system message, step 0 vs 1 vs 3 (tail 400 chars) ---')
for (const i of [0, 1, 3]) {
  console.log(`\n[step ${i}]`, JSON.stringify(sysMsgs[i].slice(-400)))
}

console.log('\n--- system-message-only prefix reuse across steps ---')
for (let i = 1; i < sysMsgs.length; i++) {
  const p = cp(sysMsgs[i - 1], sysMsgs[i])
  console.log(`  step ${i}: identical for first ${p} of ${sysMsgs[i].length} chars` + (p === sysMsgs[i].length && sysMsgs[i] === sysMsgs[i-1] ? '  (UNCHANGED)' : '  (CHANGED)'))
}
