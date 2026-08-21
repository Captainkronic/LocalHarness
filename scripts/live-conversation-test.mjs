#!/usr/bin/env node
/**
 * A spoken turn must reach the SCREEN, not just the disk.
 *
 * The renderer keeps its own copy of the conversation and learns about changes
 * from exactly one place: `event:conversationUpdated`. session.ts wrote
 * straight into `conv.messages` and called `conversations.save`, which persists
 * and tells nobody — so a spoken turn was generated, spoken aloud, saved, and
 * never appeared. Measured on a real call before the fix: 32 messages on disk,
 * 29 rendered, the missing three being the whole spoken exchange.
 *
 * The trap is that saving and showing were separable, and every individual line
 * looked correct. So this asserts they can no longer be pulled apart: every
 * mutation of conv.messages is followed by persist(), and persist() is the only
 * thing allowed to call conversations.save.
 *
 *   node scripts/live-conversation-test.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const session = readFileSync(resolve(ROOT, 'src/main/live/session.ts'), 'utf8')
const index = readFileSync(resolve(ROOT, 'src/main/index.ts'), 'utf8')
const store = readFileSync(resolve(ROOT, 'src/renderer/state/store.ts'), 'utf8')
const lines = session.split('\n')

/* ---- 1. the dependency exists and is wired to the channel the chat reads -- */

check(
  'the session declares an onConversation dependency',
  /onConversation:\s*\(/.test(session)
)
check(
  'main wires it to event:conversationUpdated',
  /onConversation:\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,400}?emit\('event:conversationUpdated'/.test(index),
  'the chat view reads no other channel'
)
check(
  'the renderer adopts that channel into the rendered conversation',
  /'event:conversationUpdated':[\s\S]{0,300}?set\(\{\s*conversation:/.test(store)
)
check(
  'the sidebar list is refreshed too, but only on structural changes',
  /if\s*\(structural\)\s*emit\('event:conversationList'/.test(index),
  'a mid-stream draft must not rewrite every row'
)

/* ---- 2. saving and showing can no longer be separated ------------------- */

const bareSaves = lines
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /conversations\.save\(/.test(l))
check(
  'conversations.save is called from exactly one place',
  bareSaves.length === 1,
  `found ${bareSaves.length} at lines ${bareSaves.map(([n]) => n).join(', ')}`
)

const persistBody = session.slice(session.indexOf('private persist('))
check(
  'and that place is persist()',
  persistBody.slice(0, 600).includes('conversations.save(conv)'),
  'a save outside persist is a message that never reaches the screen'
)

/* ---- 3. every push is followed by a persist ----------------------------- */

const pushes = []
for (let i = 0; i < lines.length; i++) {
  if (/conv\.messages\.push\(/.test(lines[i])) pushes.push(i)
}
check('every mutation site is accounted for', pushes.length === 4, `found ${pushes.length}, expected 4`)

for (const at of pushes) {
  /* The push may span several lines (the tool result is an object literal), so
     look ahead far enough to clear it and no further. */
  const window = lines.slice(at, at + 12).join('\n')
  const what = lines[at].trim().slice(0, 46)
  check(`persisted after: ${what}`, /this\.persist\(conv,\s*true\)/.test(window))
}

/* ---- 4. the reply streams, like a typed one does ------------------------ */

check(
  'content deltas emit a draft',
  /onContent:[\s\S]{0,400}?this\.emitDraft\(/.test(session),
  'without this the answer appears all at once when the turn ends'
)
check(
  'reasoning deltas do too',
  /onReasoning:[\s\S]{0,400}?this\.emitDraft\(/.test(session)
)
check(
  'the draft is emitted but never saved',
  /private emitDraft\([\s\S]{0,900}?onConversation\(/.test(session) &&
    !/private emitDraft\([\s\S]{0,900}?conversations\.save/.test(session),
  'a partial reply must not reach disk'
)
check(
  'the committed message reuses the draft id',
  (session.match(/\.id = this\.draftId/g) ?? []).length === 2,
  'both the tool-call message and the final one, or the bubble remounts'
)
check(
  'a fresh draft id is minted per streaming segment',
  (session.match(/this\.draftId = randomUUID\(\)/g) ?? []).length >= 2,
  'reusing one id across a tool round would collide two messages'
)

console.log(
  failures === 0
    ? '\n\x1b[32mall live-conversation checks passed\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m`
)
process.exit(failures === 0 ? 0 : 1)
