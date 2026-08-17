#!/usr/bin/env node
/**
 * Proves the approval gate actually asks — and, just as importantly, that it
 * always answers. A tool that requests approval and never resolves hangs the
 * whole turn with no way out, which is the worst failure this app can have.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (n, ok, d) => {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'lh-appr-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { ToolExecutor } from '${ROOT}/src/main/agent/executor'
   export { ApprovalBroker } from '${ROOT}/src/main/agent/approval'
  `
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') },
  external: ['electron']
})
const { ToolExecutor, ApprovalBroker } = await import(pathToFileURL(outfile).href)

const settings = (approvalMode) => ({
  workspaceRoots: [dir], approvalMode, shellAllowlist: [],
  baseUrl: '', nativeApiUrl: '', labUrl: '', apiKey: '', defaultModelId: null,
  contextWarnFraction: 0.75, theme: 'dark', modelPollMs: 15000, workflowMcpOverrides: {}
})

console.log('\n\x1b[1mApproval gate\x1b[0m\n')

/* --- always_ask: a write MUST ask, and the answer must be honoured --- */
{
  const asked = []
  const ex = new ToolExecutor({
    getSettings: () => settings('always_ask'),
    requestApproval: async (req) => { asked.push(req); return 'allow_once' },
    onLog: () => {}
  })
  const r = await ex.execute('write_file', { path: join(dir, 'a.txt'), content: 'hi\n' }, 'c1')
  check('always_ask asks before writing', asked.length === 1, asked[0]?.summary)
  check('the write proceeds once allowed', !r.isError, r.text.split('\n')[0])
  check('the request carries a diff to review', typeof asked[0]?.diff === 'string')
  check('the request is marked mutating', asked[0]?.mutating === true)
}

/* --- a denial must stop the write and say so --- */
{
  const ex = new ToolExecutor({
    getSettings: () => settings('always_ask'),
    requestApproval: async () => 'deny',
    onLog: () => {}
  })
  const r = await ex.execute('write_file', { path: join(dir, 'denied.txt'), content: 'x' }, 'c1')
  check('a denial blocks the write', r.isError, r.text.split('\n')[0])
}

/* --- auto_all: nothing is asked --- */
{
  const asked = []
  const ex = new ToolExecutor({
    getSettings: () => settings('auto_all'),
    requestApproval: async (req) => { asked.push(req); return 'allow_once' },
    onLog: () => {}
  })
  const r = await ex.execute('write_file', { path: join(dir, 'auto.txt'), content: 'y\n' }, 'c1')
  check('auto_all writes without asking', asked.length === 0 && !r.isError, r.text.split('\n')[0])
  const rs = await ex.execute('run_shell', { command: 'echo hello', cwd: dir }, 'c1')
  check('auto_all runs shell without asking', asked.length === 0 && !rs.isError, rs.text.split('\n')[0].slice(0, 50))
}

/* --- auto_read: reads are silent, writes still ask --- */
{
  const asked = []
  const ex = new ToolExecutor({
    getSettings: () => settings('auto_read'),
    requestApproval: async (req) => { asked.push(req); return 'allow_once' },
    onLog: () => {}
  })
  await ex.execute('list_dir', { path: dir }, 'c1')
  check('auto_read does not ask for a read', asked.length === 0)
  await ex.execute('write_file', { path: join(dir, 'b.txt'), content: 'z' }, 'c1')
  check('auto_read still asks for a write', asked.length === 1, asked[0]?.summary)
}

/* --- the broker must always settle, including on denyAll --- */
{
  const seen = []
  const broker = new ApprovalBroker((r) => seen.push(r), () => {})
  const p = broker.request({
    conversationId: 'c1', toolName: 'write_file', summary: 'Write x',
    argsPreview: '{}', mutating: true
  })
  check('broker publishes the request', seen.length === 1, seen[0]?.id)
  broker.respond(seen[0].id, 'allow_once')
  check('broker resolves on respond', (await p) === 'allow_once')

  const seen2 = []
  const b2 = new ApprovalBroker((r) => seen2.push(r), () => {})
  const p2 = b2.request({
    conversationId: 'c1', toolName: 'run_shell', summary: 'Run x',
    argsPreview: '{}', mutating: true
  })
  b2.denyAll()
  check('denyAll settles pending requests', (await p2) === 'deny')

  // A renderer that is gone must not strand the tool call forever.
  const b3 = new ApprovalBroker(() => { throw new Error('renderer gone') }, () => {})
  const p3 = b3.request({
    conversationId: 'c1', toolName: 'write_file', summary: 'Write y',
    argsPreview: '{}', mutating: true
  })
  check('a dead renderer denies rather than hangs', (await p3) === 'deny')
}

await rm(dir, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '\x1b[32mall approval checks passed\x1b[0m\n' : `\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
