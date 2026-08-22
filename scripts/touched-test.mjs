#!/usr/bin/env node
/**
 * The touched-file list, and specifically its change stat.
 *
 * The stat is read out of the tool's result text. That is safe for a write,
 * whose result the executor writes, and unsafe for a read, whose result is the
 * file's own source. The bug this pins down shipped and was visible on screen:
 * a line of game code reading `wall(1.4, 26.4,+13, -3.5)` was reported as
 * "+13 -3" against a file that had only been read.
 *
 *   node scripts/touched-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'touched-'))
await writeFile(join(dir, 'e.ts'),
  `export { deriveTouched } from '${ROOT}/src/renderer/lib/touched'\n` +
  `export { buildTabs } from '${ROOT}/src/renderer/lib/tabs'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared'), '@renderer': join(ROOT, 'src/renderer') }
})
const { deriveTouched, buildTabs } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

let t = 1000
const call = (name, path, result, over = {}) => ({
  id: `c${t}`, name, origin: 'native', status: 'ok',
  arguments: JSON.stringify({ path }), result, finishedAt: (t += 10), ...over
})
const msg = (...calls) => [{ id: `m${t}`, role: 'assistant', content: '', createdAt: t, toolCalls: calls }]

console.log('\nThe read-result false positive')
/* The exact line from golf.js that produced the bug on screen. */
const golfSource =
  '   114\t// wall height z +9..-16 (tee at x=-7 sits inside it)\n' +
  '   115\twall(1.4, 26.4,+13, -3.5);    // east wall: right of green\n'
const readOnly = deriveTouched(msg(call('read_file', 'golf.js', golfSource)))
check('a read reports no change at all', readOnly[0].added === 0 && readOnly[0].removed === 0,
  `got +${readOnly[0].added} -${readOnly[0].removed}`)
check('a read is still listed', readOnly.length === 1 && readOnly[0].ops.includes('read'))

/* Other shapes of arithmetic that the old pattern also swallowed. */
for (const [label, src] of [
  ['comma-separated args', 'f(+13, -3)'],
  ['bare spaced arithmetic', 'const d = a +42 -7'],
  ['slash-separated', 'ratio +5/-2'],
  ['newline between', 'x = 1\n+9\n-4']
]) {
  const r = deriveTouched(msg(call('read_file', 'a.js', src)))
  check(`read: ${label} contributes nothing`, r[0].added === 0 && r[0].removed === 0,
    `got +${r[0].added} -${r[0].removed}`)
}

console.log('\nReal write stats still land')
check('write result parses', (() => {
  const r = deriveTouched(msg(call('write_file', 'a.js', 'Wrote a.js (+42 -0, 1.2 kB).')))
  return r[0].added === 42 && r[0].removed === 0
})())
check('edit result parses', (() => {
  const r = deriveTouched(msg(call('edit_file', 'a.js', 'Edited a.js (+3 -7).')))
  return r[0].added === 3 && r[0].removed === 7
})())
check('repeated writes accumulate', (() => {
  const r = deriveTouched(msg(
    call('write_file', 'a.js', 'Wrote a.js (+10 -0, 1 kB).'),
    call('edit_file', 'a.js', 'Edited a.js (+5 -2).')
  ))
  return r[0].added === 15 && r[0].removed === 2
})())
check('a write whose CONTENT looks like a stat is not double-counted', (() => {
  /* The result text is the executor's, so the file's own contents never reach
     this — but a write that reports no stat must contribute none. */
  const r = deriveTouched(msg(call('write_file', 'a.js', 'No change: a.js already contains exactly this content.')))
  return r[0].added === 0 && r[0].removed === 0
})())

console.log('\nEverything else about the list')
check('a file read then written carries both ops', (() => {
  const r = deriveTouched(msg(
    call('read_file', 'a.js', 'x'),
    call('write_file', 'a.js', 'Wrote a.js (+1 -0, 2 B).')
  ))
  return r[0].ops.join(',') === 'read,write'
})())
check('an op is not repeated', (() => {
  const r = deriveTouched(msg(call('read_file', 'a.js', 'x'), call('read_file', 'a.js', 'y')))
  return r[0].ops.length === 1
})())
check('a failed call marks the row', (() => {
  const r = deriveTouched(msg(call('write_file', 'a.js', 'refused', { status: 'error' })))
  return r[0].failed === true
})())
check('a denied call marks the row', (() => {
  const r = deriveTouched(msg(call('write_file', 'a.js', 'no', { status: 'denied' })))
  return r[0].failed === true
})())
check('newest file sorts first', (() => {
  const r = deriveTouched(msg(call('read_file', 'old.js', 'x'), call('read_file', 'new.js', 'y')))
  return r[0].path === 'new.js'
})())
check('non-file tools are ignored', deriveTouched(msg(call('run_shell', 'x', 'Exit code: 0'))).length === 0)
check('serve_dir is not a file op', deriveTouched(msg(call('serve_dir', '.', 'Serving'))).length === 0)
check('mcp calls are ignored', deriveTouched(msg(call('read_file', 'a.js', 'x', { origin: 'mcp' }))).length === 0)
check('partial streaming arguments are skipped', (() => {
  const c = { id: 'x', name: 'read_file', origin: 'native', status: 'pending', arguments: '{"pa', finishedAt: 1 }
  return deriveTouched(msg(c)).length === 0
})())
check('an empty path is skipped', (() => {
  const c = { id: 'x', name: 'read_file', origin: 'native', status: 'ok', arguments: '{"path":"  "}', finishedAt: 1 }
  return deriveTouched(msg(c)).length === 0
})())
check('no messages yields no rows', deriveTouched([]).length === 0)

console.log('\nA created file is a change, not a zero')
/* STAT_RE matches "(+12 -3)". A new file's result reads "Created src/data.js
   (189 lines)" and has no such pair, so every file the run CREATED scored zero.
   This panel and the workspace header disagreed by 444 lines on one run while
   both claimed to describe the same edits. */
{
  const created = deriveTouched(msg(
    call('write_file', 'src/data.js', 'Created src/data.js (189 lines). 8.0 KB on disk, verified.')))
  check('a created file counts its lines as additions', created[0].added === 189,
    `got +${created[0].added}`)
  check('and removes nothing', created[0].removed === 0)

  const edited = deriveTouched(msg(
    call('write_file', 'src/App.jsx', 'Wrote src/App.jsx (+97 -3). 4.4 KB on disk, verified.')))
  check('an overwrite still reads its diff', edited[0].added === 97 && edited[0].removed === 3)

  /* Structured facts win over the prose, which exists to be reworded. */
  const structured = deriveTouched(msg(
    call('write_file', 'src/x.js', 'Wrote src/x.js (+1 -1).',
      { structured: { kind: 'write', added: 40, removed: 5, verified: true, syntax: 'ok', created: false } })))
  check('structured facts beat the sentence',
    structured[0].added === 40 && structured[0].removed === 5,
    `got +${structured[0].added} -${structured[0].removed}`)

  /* The original bug this file was written for must stay fixed. */
  const readWithLines = deriveTouched(msg(
    call('read_file', 'notes.md', 'the file says (12 lines) somewhere in its body')))
  check('a READ is still never counted, even saying "(12 lines)"',
    readWithLines[0].added === 0,
    'reads carry arbitrary file content and can contain anything')
}

console.log('\n"across N files" must count files that CHANGED')
/* It used the tab count, and the strip holds a tab for everything touched. Two
   of ten files in one run were never written to, and a write the user DENIED at
   the approval gate still added its file to the total, unmarked. */
{
  const act = (kind, target, over = {}) =>
    ({ kind, target, displayPath: target, phase: 'done', at: 1, added: 0, removed: 0, ...over })

  const tabs = buildTabs([
    act('write', '/w/a.js', { added: 10, removed: 1 }),
    act('read', '/w/b.js'),
    act('edit', '/w/c.js', { added: 2, removed: 2 }),
    act('write', '/w/denied.js', { phase: 'error' })
  ])
  check('every touched file still gets a tab', tabs.length === 4,
    'the Watch strip is how you open a file you only read')
  const changed = tabs.filter((t) => t.changed)
  check('but only written and edited files count as changed', changed.length === 2,
    changed.map((t) => t.name).join(','))
  check('a file that was only read is not a change',
    tabs.find((t) => t.name === 'b.js').changed === false)
  check('a denied write is not a change',
    tabs.find((t) => t.name === 'denied.js').changed === false,
    'it never reached the disk')
  check('and the denied one is marked failed',
    tabs.find((t) => t.name === 'denied.js').failed === true)
}

console.log(failed === 0 ? '\n\x1b[32mall touched-file checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
