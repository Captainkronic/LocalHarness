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
check('it is far smaller', written.length < BIG.length / 10, `${written.length} chars`)
check('the path survives', JSON.parse(written).path === 'index.html')
check('and it is still valid JSON', typeof JSON.parse(written) === 'object')
check('it says how much was there', written.includes('12867'))

/*
 * The marker is read by a model that is looking at its OWN message and trying to
 * work out whether its file survived. The first wording lost that argument: on a
 * live React build the model read it, decided the harness was corrupting writes,
 * and spent fifty messages capping itself at "keep each write under about 2KB"
 * and splitting finished stylesheets to fit a limit that did not exist. Every
 * one of those writes had verified clean on disk.
 *
 * So these are not wording preferences. Each one is a sentence that had to be
 * there for the model to reach the right conclusion unaided.
 */
console.log('\n\x1b[1mit must not read as a truncation\x1b[0m')
check('it does not use the angle-bracket placeholder form',
  !/<\d+ characters/.test(written),
  'that shape reads as the truncation itself rather than a note about one')
check('the harness names itself as the actor',
  /CaptainLlama/.test(written),
  '"already applied" never says applied by what, which leaves the transport as the suspect')
check('it states outright that nothing was truncated', /nothing was truncated/i.test(written))
check('and that the file on disk is complete',
  /on disk is complete/i.test(written),
  'the one fact that ends the theory before it starts')
check('it scopes the change to the transcript',
  /transcript/i.test(written),
  'otherwise the model cannot tell whether the file or the record was changed')
check('and it names the tool that shows the truth', /read_file/.test(written))

/* The marker replaces the value, so below some size eliding costs more than it
   saves. BULK_LIMIT has to clear it. */
console.log('\n\x1b[1mthe saving is real at the threshold\x1b[0m')
const atLimit = 'y'.repeat(1201)
const elidedAtLimit = elideBulkArguments(JSON.stringify({ path: 'a.ts', content: atLimit }))
check('a value just over the limit still shrinks',
  elidedAtLimit.length < JSON.stringify({ path: 'a.ts', content: atLimit }).length,
  `marker is longer than the payload it replaced — raise BULK_LIMIT`)
check('a value under the limit is kept whole',
  JSON.parse(elideBulkArguments(JSON.stringify({ path: 'a.ts', content: 'z'.repeat(900) }))).content.length === 900,
  'small edits stay legible in the transcript')

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

console.log('\n\x1b[1mthe newest write survives one step\x1b[0m')
/* Watched live: the model wrote index.html and on its very next step reasoned
   "let me check what's in it (it was truncated in the transcript), I'll read it
   back" — spending a full re-prefill of a 22k conversation, about a minute, to
   recover text this app had thrown away one step earlier. */
{
  const call = (id, content) => ({
    id, name: 'write_file', status: 'ok', result: 'Wrote it',
    arguments: JSON.stringify({ path: `${id}.html`, content })
  })
  const two = {
    id: 'c2', workflowId: 'code',
    messages: [
      { id: 'u', role: 'user', content: 'build it', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '', createdAt: 2, toolCalls: [call('older', BIG)] },
      { id: 'a2', role: 'assistant', content: '', createdAt: 3, toolCalls: [call('newest', BIG)] }
    ]
  }
  const wire = JSON.stringify(buildMessages(two, 'You are an engineer.', false, {}))
  check('the newest write is still readable in full',
    (wire.match(/x{2000,}/g) ?? []).length === 1,
    'exactly one full payload should survive')
  check('and the older one is still elided',
    wire.includes('CaptainLlama removed'))

  /* The property that matters most: one step of grace, never two. */
  const three = {
    ...two,
    messages: [
      ...two.messages,
      { id: 'a3', role: 'assistant', content: '', createdAt: 4, toolCalls: [call('latest', BIG)] }
    ]
  }
  const wire3 = JSON.stringify(buildMessages(three, 'You are an engineer.', false, {}))
  check('a write ages out as soon as another one lands',
    (wire3.match(/x{2000,}/g) ?? []).length === 1,
    'otherwise this is the 12.8KB-resent-every-turn bug all over again')
  check('and it is the LATEST one that survives',
    wire3.indexOf('x'.repeat(2000)) > wire3.indexOf('CaptainLlama removed'),
    'the surviving payload must sit after the elided one')

  /* The boundary is the turn, not the call. Without that, a conversation that
     ends with a big write and carries on in chat re-sends it forever. */
  const answered = {
    ...two,
    messages: [...two.messages, { id: 'u2', role: 'user', content: 'now add a page', createdAt: 5 }]
  }
  const wireA = JSON.stringify(buildMessages(answered, 'You are an engineer.', false, {}))
  check('a new user message ends the grace',
    (wireA.match(/x{2000,}/g) ?? []).length === 0,
    'this is the 12.8KB-resent-every-turn bug, and it must not come back')
}

const before = JSON.stringify({ path: 'index.html', content: BIG }).length
const after = JSON.parse(serialised.match(/"arguments":("(?:[^"\\]|\\.)*")/)[1]).length
console.log(
  `\n  one write_file in history: ${before} chars -> ${after} ` +
    `(~${Math.round((before - after) / 4)} tokens saved per later turn)`
)

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
