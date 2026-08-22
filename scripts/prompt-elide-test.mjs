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
import { readFileSync } from 'node:fs'
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
  `export { elideBulkArguments, buildMessages, trimToBudget, writtenFilesLine, ELIDED_MARK } from '${ROOT}/src/main/llm/prompt'\n`
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
const { elideBulkArguments, buildMessages, trimToBudget, writtenFilesLine, ELIDED_MARK } =
  await import(pathToFileURL(outfile).href)

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

console.log('\n\x1b[1mthe brief is never trimmed away\x1b[0m')
/* Measured on a live 32-request build: one user message, and at 79% of the
   window the trimmer dropped it walking backwards. The server refused outright
   — "Chat template error: No user query found in messages" — and every retry
   re-trimmed and re-dropped it, so the turn could not recover. An hour of work
   ended by losing the sentence that started it. */
{
  const big = (n) => 'y'.repeat(n)
  const history = [
    { role: 'user', content: 'Build me a website for Luminary Glassworks.' }
  ]
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'assistant', content: `step ${i} ${big(4000)}` })
    history.push({ role: 'tool', tool_call_id: `c${i}`, content: big(4000) })
  }

  const trimmed = trimToBudget(history, 4000)
  const users = trimmed.filter((m) => m.role === 'user')
  check('the brief survives a trim that drops most of the history',
    users.length === 1 && /Luminary Glassworks/.test(users[0].content),
    `${users.length} user messages survived`)
  check('and it really did trim', trimmed.length < history.length)
  check('the brief comes FIRST, before the dropped-messages note',
    trimmed.findIndex((m) => m.role === 'user') <
      trimmed.findIndex((m) => /were dropped/.test(String(m.content ?? ''))),
    'the model should read the task before the apology')
  check('the note is still there', trimmed.some((m) => /were dropped/.test(String(m.content ?? ''))))

  /* Nothing to trim must stay untouched. */
  const small = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ]
  check('a conversation under budget is returned unchanged',
    trimToBudget(small, 100000) === small)
}

console.log('\n\x1b[1mthe model is told what it has written\x1b[0m')
/* Measured across 33 reasoning blocks of one agentic build: 21% went on
   re-reading its own work, 18% on uncertainty about its own state. Verbatim:
   "I'm not sure what I wrote in index.html. The transcript was truncated." That
   one produced a real defect — index.html said one town name, data.js another. */
{
  const call = (name, path, result, status = 'ok') => ({
    id: `c${path}`, name, status, result, arguments: JSON.stringify({ path })
  })
  const msgs = [
    { id: 'u', role: 'user', content: 'build it', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', createdAt: 2, toolCalls: [
      call('write_file', 'src/data.js', 'Created src/data.js (189 lines). 8.0 KB on disk, verified.'),
      call('write_file', 'index.html', 'Created index.html (27 lines). 1.2 KB on disk, verified.')
    ] },
    { id: 'a2', role: 'assistant', content: '', createdAt: 3, toolCalls: [
      call('edit_file', 'src/data.js', 'Edited src/data.js: 1 occurrence replaced (+11 -5).'),
      call('write_file', 'src/nope.js', 'refused', 'denied')
    ] }
  ]
  const line = writtenFilesLine(msgs)
  check('every written file is listed', /src\/data\.js/.test(line) && /index\.html/.test(line))
  check('with its size, so "did it work" is answerable without a read',
    /8\.0 kB/i.test(line) && /1\.2 kB/i.test(line))
  check('a file written twice appears once',
    (line.match(/src\/data\.js/g) ?? []).length === 1)
  check('a DENIED write is not claimed as written',
    !/nope\.js/.test(line),
    'listing a file that was refused would be worse than listing nothing')
  check('it says the list is the app\'s record, not the model\'s memory',
    /app's own record/.test(line))
  check('and tells it not to read back merely to check success',
    /do not read it back to find out whether it worked/.test(line))
  check('nothing written yields nothing at all', writtenFilesLine([
    { id: 'u', role: 'user', content: 'hi', createdAt: 1 }
  ]) === '')

  /* It has to reach the wire. */
  const conv = { id: 'c', workflowId: 'code', messages: msgs }
  const wire = JSON.stringify(buildMessages(conv, 'You are an engineer.', false, {}))
  check('and it reaches the system prompt', wire.includes('index.html'))
}

console.log('\n\x1b[1mthe marker must never reach a file\x1b[0m')
/* Live, Run 2: the model read the elision note in its own replayed history and
   sent it back as the `content` of a write_file call. src/pages/Gallery.jsx
   became 323 bytes containing nothing but the note. What made it expensive is
   that the model was then RIGHT — the file really did hold a placeholder — so it
   reasoned toward "the compactor replaced my content before the tool received
   it" and could not escape, because every fact it could check agreed. 5.5k
   tokens before a human stopped it. */
{
  check('the marker prefix is exported so the writer can recognise it',
    typeof ELIDED_MARK === 'string' && ELIDED_MARK.length > 10)
  const produced = elideBulkArguments(JSON.stringify({ path: 'a.js', content: BIG }))
  check('and it is genuinely what elision emits',
    produced.includes(ELIDED_MARK),
    'if these two drift, the guard stops matching and the bug returns silently')

  const exec = readFileSync(join(ROOT, 'src/main/agent/executor.ts'), 'utf8')
  check('write_file refuses content containing it',
    /content\.includes\(ELIDED_MARK\)/.test(exec))
  check('and refuses rather than writing something wrong',
    /Refused: the content for/.test(exec))
  check('the refusal names the recovery',
    /call read_file/.test(exec),
    'the file on disk is untouched, and that is the fact that ends the confusion')
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
