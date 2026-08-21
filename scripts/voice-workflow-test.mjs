#!/usr/bin/env node
/**
 * A spoken session must run as the workflow the CONVERSATION belongs to.
 *
 * Written after Flight Booker shipped and ran as Live. Three places each
 * decided independently what "a spoken workflow" meant — a module constant in
 * the session, a literal 'live' in startLive, and an id comparison in App —
 * and adding a second spoken workflow updated only one of them. The visible
 * symptom was the app jumping to the Live tab on Start call; the invisible one
 * was worse: Live's persona and Live's tool list, so the travel agent had no
 * way to look up a flight and apologised for it in Jarvis's voice.
 *
 *   node scripts/voice-workflow-test.mjs
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/* Read as text: the spoken-mode preamble is a template built at request time,
   so the assertion is that the session still builds one, not that a particular
   sentence came out. */
const sessionSource = readFileSync(resolve(ROOT, 'src/main/live/session.ts'), 'utf8')
let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'lh-voicewf-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { LiveSession } from '${ROOT}/src/main/live/session'
   export { WORKFLOWS, WORKFLOW_BY_ID, isVoiceWorkflow, isTalkWorkflow, canSpeak } from '${ROOT}/src/shared/workflows'\n`
)
const shim = join(dir, 'electron-shim.mjs')
await writeFile(
  shim,
  `import { tmpdir } from 'node:os'
   export const app = { getPath: () => tmpdir(), getVersion: () => '0.1.0' }
   export default { app }\n`
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
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim }
})
const { LiveSession, WORKFLOWS, WORKFLOW_BY_ID, isVoiceWorkflow, isTalkWorkflow, canSpeak } = await import(
  pathToFileURL(outfile).href
)

/* ---- 1. the flag, and what it implies -------------------------------- */
console.log('\n\x1b[1mvoice workflows\x1b[0m')

/*
 * Two tiers, and the distinction is load-bearing.
 *
 *   `voice`  — spoken FIRST. The orb is the screen.
 *   `talk`   — typed first, spoken as well: the same thread with a microphone
 *              in the composer.
 *
 * Converse moved from the first to the second, which is what it always
 * actually was: it renders a composer and a thread, not an orb. Keeping it
 * under `voice` is what forced the router to special-case it by id, and that
 * special case is why adding a second one of these needed a router edit.
 */
const voice = WORKFLOWS.filter((w) => w.voice === true).map((w) => w.id)
const talk = WORKFLOWS.filter((w) => w.talk === true).map((w) => w.id)

check('the voice-first workflows are exactly these', voice.join(',') === 'live,booker,clinic', voice.join(','))
check('the talk-capable workflows are exactly these', talk.join(',') === 'converse,image,audio', talk.join(','))
check('nothing claims to be both', WORKFLOWS.every((w) => !(w.voice === true && w.talk === true)))

check('isVoiceWorkflow agrees with the flag', WORKFLOWS.every((w) => isVoiceWorkflow(w.id) === (w.voice === true)))
check('isTalkWorkflow agrees with the flag', WORKFLOWS.every((w) => isTalkWorkflow(w.id) === (w.talk === true)))
check('canSpeak is the union', WORKFLOWS.every((w) => canSpeak(w.id) === (w.voice === true || w.talk === true)))
check('an unknown id is not spoken', !isVoiceWorkflow('nonesuch') && !canSpeak('nonesuch'))

for (const id of voice) {
  // A spoken turn has no approval dialog and no native tool runner, so a
  // voice-FIRST workflow declaring native tools would offer what it cannot run.
  check(`${id} declares no native tools`, WORKFLOW_BY_ID[id].nativeTools.length === 0)
}

/*
 * A talk workflow MAY declare native tools — it is a typed workflow first, and
 * Image and Audio both read files when typed at. The spoken loop simply never
 * wires them, so voice can only ever do LESS. That is safe, and it is only
 * safe while the model is told, or it offers to read a file and then cannot.
 */
for (const id of talk) {
  const wf = WORKFLOW_BY_ID[id]
  if (wf.nativeTools.length === 0) continue
  check(
    `${id}'s native tools are named as unavailable when spoken`,
    /These are unavailable while speaking/.test(sessionSource) &&
      /wf\.nativeTools\.join/.test(sessionSource),
    'a model that believes it can read a file will offer to'
  )
}

/* The one workflow class that must never get this: an approval gate is the
   reason writing files and running shells is acceptable at all, and a spoken
   turn cannot show one. */
for (const id of ['code', 'docs']) {
  check(`${id} cannot be spoken to`, !canSpeak(id), 'it writes files behind an approval dialog')
}

/* ---- 2. the session takes its workflow from the conversation ---------- */
console.log('\n\x1b[1mLiveSession.start\x1b[0m')

/* Every spoken workflow must be reachable and must refuse a typed one. Driven
   off the flag rather than a hardcoded list, so a new voice workflow is covered
   the moment it is added — which is the failure this whole file exists for. */
const conversations = new Map(
  WORKFLOWS.map((w) => [`conv-${w.id}`, { id: `conv-${w.id}`, workflowId: w.id, modelId: null, messages: [] }])
)
const logs = []
const hookCalls = []
const deps = {
  speech: {
    start: async () => {},
    available: () => false,
    voices: async () => [],
    prewarm: async () => {}
  },
  models: { list: () => [], residentModelId: () => null, load: async () => ({ ok: true }), contextWindow: () => null },
  mcp: { wireTools: () => [], callDirect: async (server, tool, args) => {
    hookCalls.push({ server, tool, args })
    return { text: 'ok', isError: false }
  } },
  conversations: { get: (id) => conversations.get(id) ?? null, save: () => {} },
  getSettings: () => ({ defaultModelId: null, baseUrl: '', apiKey: '' }),
  onStatus: () => {},
  onAudio: () => {},
  onExchange: () => {},
  onLog: (level, scope, msg) => logs.push(`${level} ${msg}`)
}

const session = new LiveSession(deps)

const booker = await session.start('conv-booker')
check('starts on a booker conversation', booker.ok === true, booker.error ?? '')
check('and runs AS booker', session.wf?.id === 'booker', session.wf?.id)
check('so it is offered booker tools', session.toolPermitted('flights__search_flights') === true)

await session.stop()
const live = await session.start('conv-live')
check('switching to live follows the conversation', live.ok === true && session.wf?.id === 'live')
// Live's allowlist names gmail explicitly, and send_email is deliberately absent
// from it — the schema is the only gate a spoken turn has.
check('and live still withholds what it withholds', session.toolPermitted('gmail__send_email') === false)

await session.stop()
const typed = await session.start('conv-code')
check('refuses a typed workflow outright', typed.ok === false, JSON.stringify(typed))
check('and says which one', String(typed.error).includes('code'), typed.error)
check('and a stopped session holds no workflow at all', session.wf === null)

/* ---- 3. per-conversation server state -------------------------------- */
console.log('\n\x1b[1mthe session hook\x1b[0m')

hookCalls.length = 0
await session.stop()
await session.start('conv-clinic')
check('a workflow that declares a hook fires it', hookCalls.length === 1, JSON.stringify(hookCalls))
check('on the server it names', hookCalls[0]?.server === 'health')
check('with the CONVERSATION id, not the session', hookCalls[0]?.args?.id === 'conv-clinic')

// The bug this ordering test exists for: stop() clears the workflow, so setting
// it before the stop left a RESTARTED session with no workflow and no hook.
hookCalls.length = 0
await session.start('conv-clinic')
check('and again after a restart', hookCalls.length === 1, 'hook did not fire on restart')

hookCalls.length = 0
await session.stop()
await session.start('conv-live')
check('a workflow with no hook fires nothing', hookCalls.length === 0)

check(
  'the hook tool is NOT advertised to the model',
  !WORKFLOW_BY_ID.clinic.mcpTools ||
    !Object.values(WORKFLOW_BY_ID.clinic.mcpTools).flat().includes('open_case')
)

/* ---- 4. nobody hardcodes it again ------------------------------------ */
console.log('\n\x1b[1mno second source of truth\x1b[0m')

const sources = {
  'src/main/live/session.ts': await readFile(join(ROOT, 'src/main/live/session.ts'), 'utf8'),
  'src/renderer/state/store.ts': await readFile(join(ROOT, 'src/renderer/state/store.ts'), 'utf8'),
  'src/renderer/App.tsx': await readFile(join(ROOT, 'src/renderer/App.tsx'), 'utf8')
}
for (const [file, text] of Object.entries(sources)) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check(`${file} does not pin WORKFLOW_BY_ID.live`, !/WORKFLOW_BY_ID\.live|WORKFLOW_BY_ID\['live'\]/.test(stripped))
}
check(
  'App picks the workspace by flag, not by id list',
  !/workflow\.id === 'live'/.test(sources['src/renderer/App.tsx'])
)

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
