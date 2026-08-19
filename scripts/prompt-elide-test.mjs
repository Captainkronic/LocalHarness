#!/usr/bin/env node
/**
 * A file written once must not be re-sent on every later turn.
 *
 * Measured on a real Tetris build through the Code workflow: the model wrote a
 * complete 12.8KB index.html on turn 2, and every turn after that carried those
 * 12.8KB again inside the assistant message that made the call. Turn 3 waited
 * 24.9s for a first token and 5.7 minutes in total; turn 11 spent 381 seconds
 * and produced nothing. The file was on disk the entire time.
 *
 *   node scripts/prompt-elide-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'lh-elide-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { elideBulkArguments, buildMessages } from '${ROOT}/src/main/llm/prompt'\n`
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, 
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main') }
})
const { elideBulkArguments, buildMessages } = await import(pathToFileURL(outfile).href)

const BIG = 'x'.repeat(12867)

console.log('\n\x1b[1meliding a written file\x1b[0m')
const written = elideBulkArguments(JSON.stringify({ path: 'index.html', content: BIG }))
check('the payload is gone', !written.includes(BIG))
check('it is far smaller', written.length < 300, `${written.length} chars`)
check('the path survives', JSON.parse(written).path === 'index.html')
check('and it is still valid JSON', typeof JSON.parse(written) === 'object')
/* A silent truncation would teach the model it had written a short file. */
check('it says how much was there', written.includes('12867'))
check('and that the write already happened', /already applied/i.test(written))
check('and where to get it', /read the file/i.test(written))

console.log('\n\x1b[1mwhat must NOT be touched\x1b[0m')
check('a short argument is returned unchanged', elideBulkArguments('{"path":"a.ts"}') === '{"path":"a.ts"}')
const longPath = JSON.stringify({ path: 'a/'.repeat(400) + 'b.ts' })
check(
  'a long NON-payload field survives',
  JSON.parse(elideBulkArguments(longPath)).path.length > 600,
  'a path was elided'
)
const shellCmd = JSON.stringify({ command: 'echo ' + 'y'.repeat(900) })
check(
  'a shell command survives',
  JSON.parse(elideBulkArguments(shellCmd)).command.length > 900,
  'a command was elided — the model could not tell what it ran'
)
/* A turn cut off mid-stream leaves a JSON fragment. Rewriting it blind makes it
   less recoverable, not more. */
const fragment = '{"path":"index.html","content":"' + BIG
check('an unparseable fragment is left alone', elideBulkArguments(fragment) === fragment)
check('an array argument is left alone', elideBulkArguments(JSON.stringify(['a'.repeat(900)])).length > 900)

console.log('\n\x1b[1min a real history\x1b[0m')
const conv = {
  id: 'c1',
  workflowId: 'code',
  messages: [
    { id: 'u', role: 'user', content: 'build tetris', createdAt: 1 },
    {
      id: 'a',
      role: 'assistant',
      content: '',
      createdAt: 2,
      toolCalls: [
        {
          id: 'call_1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'index.html', content: BIG }),
          status: 'ok',
          result: 'Wrote index.html'
        }
      ]
    },
    { id: 'u2', role: 'user', content: 'now add a score', createdAt: 3 }
  ]
}
const wire = buildMessages(conv, 'You are an engineer.', false, {})
const serialised = JSON.stringify(wire)
check('the second request does not carry the file', !serialised.includes(BIG))
check('but still carries the tool call', serialised.includes('write_file'))
check('and its id, so the reply is answerable', serialised.includes('call_1'))
check('and the tool result', serialised.includes('Wrote index.html'))

const before = JSON.stringify({ path: 'index.html', content: BIG }).length
const after = JSON.parse(serialised.match(/"arguments":("(?:[^"\\]|\\.)*")/)[1]).length
console.log(
  `\n  one write_file in history: ${before} chars -> ${after} ` +
    `(~${Math.round((before - after) / 4)} tokens saved per later turn)`
)

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
