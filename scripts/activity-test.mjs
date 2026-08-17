#!/usr/bin/env node
/**
 * Proves the live file-activity stream actually fires, end to end, through the
 * real ToolExecutor and ActivityTracker — the data the Code workspace renders.
 *
 * Runs entirely in a temp directory that is added as the only workspace root,
 * so it exercises the real sandbox rather than bypassing it.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'lh-activity-'))
const bundleDir = await mkdtemp(join(tmpdir(), 'lh-activity-b-'))
const entry = join(bundleDir, 'e.ts')
await writeFile(
  entry,
  `export { ToolExecutor } from '${ROOT}/src/main/agent/executor'
   export { ActivityTracker, changedLinesFromDiff } from '${ROOT}/src/main/agent/activity'
  `
)
const outfile = join(bundleDir, 'b.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') },
  external: ['electron']
})
const { ToolExecutor, ActivityTracker, changedLinesFromDiff } = await import(
  pathToFileURL(outfile).href
)

console.log('\n\x1b[1mLive file activity\x1b[0m\n')

const seen = []
const tracker = new ActivityTracker({
  onActivity: (a) => seen.push(a),
  getRoots: () => [dir]
})

const executor = new ToolExecutor({
  getSettings: () => ({
    workspaceRoots: [dir],
    // auto_all so the test exercises the effect path, not the approval UI.
    approvalMode: 'auto_all',
    shellAllowlist: [],
    baseUrl: '',
    nativeApiUrl: '',
    labUrl: '',
    apiKey: '',
    defaultModelId: null,
    contextWarnFraction: 0.75,
    theme: 'dark',
    modelPollMs: 15000,
    workflowMcpOverrides: {}
  }),
  requestApproval: async () => 'allow_once',
  onLog: () => {},
  onActivity: (input) => tracker.record(input)
})

const CONV = 'conv-test'
await mkdir(join(dir, 'src'), { recursive: true })

/* --- write a new file --- */
const target = join(dir, 'src', 'demo.ts')
const w = await executor.execute(
  'write_file',
  { path: target, content: 'const a = 1\nconst b = 2\nconst c = 3\n' },
  CONV
)
check('write_file succeeds', !w.isError, w.text.split('\n')[0])
const writeDone = seen.filter((a) => a.kind === 'write' && a.phase === 'done')
check('write emits a done activity', writeDone.length === 1)
check(
  'write activity carries added/removed counts',
  writeDone[0]?.added === 3 && writeDone[0]?.removed === 0,
  `+${writeDone[0]?.added} -${writeDone[0]?.removed}`
)
check('write activity carries file content', typeof writeDone[0]?.content === 'string')
check(
  'display path is relative to the workspace root',
  writeDone[0]?.displayPath === 'src/demo.ts',
  writeDone[0]?.displayPath
)

/* --- edit it --- */
seen.length = 0
const e = await executor.execute(
  'edit_file',
  { path: target, old_string: 'const b = 2', new_string: 'const b = 22' },
  CONV
)
check('edit_file succeeds', !e.isError, e.text.split('\n')[0])
const editDone = seen.find((a) => a.kind === 'edit' && a.phase === 'done')
check('edit emits a done activity', editDone !== undefined)
check(
  'edit activity carries a unified diff',
  typeof editDone?.diff === 'string' && editDone.diff.includes('@@'),
  editDone?.diff?.split('\n').find((l) => l.startsWith('+const'))
)
check(
  'changed line numbers point at the edited line',
  Array.isArray(editDone?.changedLines) && editDone.changedLines.includes(2),
  `lines ${JSON.stringify(editDone?.changedLines)}`
)

/* --- start/done pairing for a non-file op --- */
seen.length = 0
await executor.execute('grep', { pattern: 'const', path: dir }, CONV)
const starts = seen.filter((a) => a.phase === 'start')
const dones = seen.filter((a) => a.phase === 'done' || a.phase === 'error')
check('grep emits a start row', starts.length === 1, starts[0]?.kind)
check('grep emits a terminal row', dones.length === 1, dones[0]?.summary?.slice(0, 60))
check(
  'start and done share one id so the ticker can replace in place',
  starts[0]?.id === dones[0]?.id
)

/* --- a refused path must still close its row --- */
seen.length = 0
const denied = await executor.execute('read_file', { path: '/etc/passwd' }, CONV)
check('reading outside the sandbox is refused', denied.isError, denied.text.slice(0, 60))
check(
  'a refused op still emits a terminal row',
  seen.some((a) => a.phase === 'done' || a.phase === 'error'),
  'no orphaned spinner in the ticker'
)

/* --- touched-file rollup --- */
const touched = tracker.touchedFiles(CONV)
check('touched files are tracked', touched.length >= 1, `${touched.length} file(s)`)
// Activity paths are canonical realpaths, so compare against the realpath —
// on macOS the temp dir is reached through a /var -> /private/var symlink.
const realTarget = realpathSync(target)
check(
  'touched rollup accumulates across operations',
  (touched.find((t) => t.path === realTarget)?.touches ?? 0) >= 2,
  `${touched.find((t) => t.path === realTarget)?.touches} touches`
)

/* --- diff line parsing in isolation --- */
const parsed = changedLinesFromDiff(
  '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line one\n-old\n+new\n line three\n'
)
check('changedLinesFromDiff finds the new-side line', parsed.includes(2), JSON.stringify(parsed))

await rm(dir, { recursive: true, force: true })
await rm(bundleDir, { recursive: true, force: true })
console.log('')
console.log(
  failures === 0
    ? '\x1b[32mall activity checks passed\x1b[0m\n'
    : `\x1b[31m${failures} failed\x1b[0m\n`
)
process.exit(failures === 0 ? 0 : 1)
