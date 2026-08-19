#!/usr/bin/env node
/**
 * Runs the REAL Code workflow, headlessly, against the real inference box.
 *
 * Not a reimplementation of the agent loop — it boots the actual Orchestrator,
 * ToolExecutor, SettingsStore and ModelRegistry the app uses, wires an
 * auto-approving ApprovalBroker in place of the dialog, and points the workspace
 * at a throwaway directory. What it observes is therefore what Adam sees when he
 * types the same thing into the window, minus the window.
 *
 * It exists because "it overthinks and makes mistakes" is not a bug report. This
 * turns it into numbers: how many turns, how many reasoning tokens, which tools
 * were called in which order, what the model wrote, and whether the thing it
 * built actually runs.
 *
 *   node scripts/code-bench.mjs --task tetris
 *   node scripts/code-bench.mjs --task tetris --model qwen/qwen3.8-27b --effort low
 *   node scripts/code-bench.mjs --list
 *
 * Everything it produces lands in a run directory that is printed at the end and
 * NOT cleaned up — the artifact is the point.
 */
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---- tasks ---------------------------------------------------------- */

const TASKS = {
  tetris: {
    label: 'Tetris',
    prompt:
      'Build a complete, playable Tetris game as a single self-contained ' +
      'index.html in the workspace root. Canvas rendering, arrow keys to move ' +
      'and rotate, down to soft drop, space to hard drop, line clears, a score, ' +
      'increasing speed, and a game over state. No external libraries.',
    // What "done" means, checked mechanically rather than by reading it.
    expect: {
      file: 'index.html',
      minBytes: 2500,
      mustInclude: ['canvas', 'requestAnimationFrame', 'keydown'],
      // The seven tetrominoes have to be in there somewhere.
      shapes: ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
    }
  },
  snake: {
    label: 'Snake',
    prompt:
      'Build a complete, playable Snake game as a single self-contained ' +
      'index.html in the workspace root. Canvas rendering, arrow keys, food, ' +
      'growth, a score, and a game over state. No external libraries.',
    expect: {
      file: 'index.html',
      minBytes: 1500,
      mustInclude: ['canvas', 'keydown'],
      shapes: []
    }
  },
  breakout: {
    label: 'Breakout',
    prompt:
      'Build a complete, playable Breakout game as a single self-contained ' +
      'index.html in the workspace root. Canvas rendering, mouse or arrow key ' +
      'paddle control, a brick grid, ball physics with wall and paddle bounces, ' +
      'a score, lives, and win and lose states. No external libraries.',
    expect: {
      file: 'index.html',
      minBytes: 2000,
      mustInclude: ['canvas', 'requestAnimationFrame'],
      shapes: []
    }
  }
}

/* ---- args ----------------------------------------------------------- */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
if (argv.includes('--list')) {
  for (const [key, t] of Object.entries(TASKS)) console.log(`  ${key.padEnd(10)} ${t.label}`)
  process.exit(0)
}
const taskKey = arg('task', 'tetris')
const task = TASKS[taskKey]
if (!task) {
  console.error(`Unknown task ${taskKey}. Try --list.`)
  process.exit(1)
}
const modelOverride = arg('model', null)
const effortOverride = arg('effort', null)
const timeoutMs = Number(arg('timeout', 15 * 60 * 1000))

/* ---- bundle the real modules ---------------------------------------- */

const dir = await mkdtemp(join(tmpdir(), 'lh-codebench-'))
await writeFile(
  join(dir, 'entry.ts'),
  `export { Orchestrator } from '${ROOT}/src/main/orchestrator'
   export { ToolExecutor } from '${ROOT}/src/main/agent/executor'
   export { ApprovalBroker } from '${ROOT}/src/main/agent/approval'
   export { SettingsStore } from '${ROOT}/src/main/store/settings'
   export { ConversationStore } from '${ROOT}/src/main/store/conversations'
   export { ArtifactStore } from '${ROOT}/src/main/store/artifacts'
   export { ModelRegistry } from '${ROOT}/src/main/llm/models'
   export { McpManager } from '${ROOT}/src/main/mcp/manager'
   export { SkillRegistry } from '${ROOT}/src/main/skills/registry'
   export { LmStudioControl } from '${ROOT}/src/main/llm/control'
   export { WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`
)
const shim = join(dir, 'electron-shim.mjs')
await writeFile(
  shim,
  `export const app = { getPath: () => process.env.LH_USERDATA, getVersion: () => '0.1.0' }
   export default { app }\n`
)
const userData = join(dir, 'userdata')
const workspace = arg('workspace', join(dir, 'workspace'))
await mkdir(userData, { recursive: true })
await mkdir(workspace, { recursive: true })
process.env.LH_USERDATA = userData

const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'entry.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim }
})
const M = await import(pathToFileURL(outfile).href)

/* ---- observation ----------------------------------------------------- */

const t0 = Date.now()
const ms = () => Date.now() - t0
const events = []
const note = (kind, detail) => events.push({ at: ms(), kind, ...detail })

const logLines = []
const log = (level, scope, message) => {
  logLines.push(`${String(ms()).padStart(7)}ms ${level.padEnd(5)} ${scope.padEnd(10)} ${message}`)
  if (level === 'error') console.log(`  \x1b[31m${scope}: ${message}\x1b[0m`)
}

let liveMetrics = null
const toolCalls = []
let assistantTurns = 0
let reasoningChars = 0
let contentChars = 0
const trims = []

/* One line per completed turn, as it completes.
 *
 * The whole point of watching a run rather than reading it afterwards: a turn
 * that takes five minutes looks identical to a hung process until it prints,
 * and knowing WHICH turn is slow is most of the diagnosis. */
let reported = 0
let turnStart = Date.now()
let lastPrefill = 0
/** The loaded window, read from the server. Context fill is meaningless as a
 *  raw token count — 14k is comfortable at 98k and fatal at 16k. */
let windowTokens = null

/* Tool-call ARGUMENT growth over time.
 *
 * A large write_file streams its whole file as JSON-escaped arguments, and that
 * is where a run died: `error: terminated`, zero arguments recorded, twelve
 * minutes gone. The conversation only stores the final state, so a stream that
 * dies mid-argument leaves nothing to look at. This samples it while it runs. */
const argTrack = new Map()
let lastArgLog = 0
const trackArgs = (payload) => {
  for (const m of payload.messages ?? []) {
    for (const c of m.toolCalls ?? []) {
      const len = (c.arguments ?? '').length
      const prev = argTrack.get(c.id) ?? { len: 0, first: Date.now() }
      if (len > prev.len) {
        argTrack.set(c.id, { len, first: prev.first })
        const now = Date.now()
        if (now - lastArgLog > 5000) {
          lastArgLog = now
          process.stdout.write(
            `\r    ${c.name} args ${String(len).padStart(7)} chars after ` +
              `${((now - prev.first) / 1000).toFixed(0)}s (${c.status})\n`
          )
        }
      }
    }
  }
}

const emit = (channel, payload) => {
  if (channel === 'event:conversationUpdated') trackArgs(payload)
  if (channel === 'event:liveMetrics') {
    liveMetrics = payload
    if (payload?.promptTokens) lastPrefill = payload.promptTokens
    return
  }
  if (channel === 'event:conversationUpdated') {
    const done = (payload.messages ?? []).filter(
      (m) => m.role === 'assistant' && (m.metrics || (m.toolCalls ?? []).length > 0)
    )
    while (reported < done.length) {
      const m = done[reported]
      reported += 1
      const met = m.metrics ?? {}
      const wall = ((Date.now() - turnStart) / 1000).toFixed(0)
      turnStart = Date.now()
      const tools = (m.toolCalls ?? []).map((c) => c.name).join(', ') || '—'
      const failed = (m.toolCalls ?? []).filter((c) => c.status === 'error')
      const ctx = met.promptTokens ?? lastPrefill
      const fill = windowTokens ? `${String(Math.round((ctx / windowTokens) * 100)).padStart(3)}%` : '  ?'
      process.stdout.write(
        `\r  turn ${String(reported).padStart(2)}  ${String(wall).padStart(4)}s  ` +
          `ctx ${String(ctx).padStart(6)} ${fill}  ` +
          `ttft ${String(((met.ttftMs ?? 0) / 1000).toFixed(1)).padStart(5)}s  ` +
          `pre ${String(Math.round(met.prefillTps ?? 0)).padStart(4)}/s  ` +
          `dec ${String((met.decodeTps ?? 0).toFixed(1)).padStart(5)}/s  ` +
          `think ${String(Math.round((m.reasoning ?? '').length / 4)).padStart(5)}  ` +
          `wrote ${String((m.content ?? '').length).padStart(5)}  ${tools}\n`
      )
      if (met && !(m.content ?? '').trim() && (m.toolCalls ?? []).length === 0) {
        process.stdout.write('            \x1b[31mEMPTY REPLY — the model returned nothing\x1b[0m\n')
      }
      for (const f of failed) {
        process.stdout.write(`            \x1b[31m${f.name} refused:\x1b[0m ${String(f.error).split('\n')[0].slice(0, 96)}\n`)
      }
    }
    return
  }
  if (channel === 'event:log') {
    // EVERY level, not just errors, and not just trims. The Orchestrator's own
    // warnings come through here rather than through the onLog callbacks the
    // subsystems take — which is how a run that aborted mid-turn produced a
    // harness.log containing one line about a websocket, and left me guessing
    // at the cause from a phase change.
    const { level, scope, message } = payload ?? {}
    logLines.push(`${String(ms()).padStart(7)}ms ${String(level).padEnd(5)} ${String(scope).padEnd(10)} ${message}`)
    if (level === 'warn' || level === 'error') {
      process.stdout.write(`\r  \x1b[33m${scope}: ${String(message).slice(0, 150)}\x1b[0m\n`)
    }
    if (String(message).includes('trimmed')) trims.push(message)
  }
}

/* ---- subsystems, as the app builds them ------------------------------ */

const settings = new M.SettingsStore(userData)
settings.update({
  workspaceRoots: [workspace],
  // auto_all stands in for a human clicking Allow. The executor still enforces
  // the workspace roots, so the model is no less contained than in the app —
  // it just is not asked.
  approvalMode: 'auto_all',
  shellAllowlist: ['node -v', 'ls', 'pwd', 'cat', 'python3 -c']
})
const conversations = new M.ConversationStore(userData)
const artifacts = new M.ArtifactStore(userData)
const mcp = new M.McpManager({ onStates: () => {}, onLog: log })
const models = new M.ModelRegistry({
  getSettings: () => settings.get(),
  onModels: () => {},
  onHealth: () => {},
  onLog: log
})
const control = new M.LmStudioControl({
  getSettings: () => settings.get(),
  onState: () => {},
  onProgress: () => {},
  onLog: log
})
const skills = new M.SkillRegistry({ getSettings: () => settings.get(), onSkills: () => {}, onLog: log })
// Auto-approve stands in for the dialog. Every request is recorded, so a run
// that only "worked" because it was allowed to do something alarming is visible.
const approvals = new M.ApprovalBroker((req) => {
  note('approval', { tool: req.toolName, summary: req.summary })
  // Answered on the next tick, exactly as a very fast human would.
  setTimeout(() => approvals.resolve(req.id, 'allow'), 0)
})
const executor = new M.ToolExecutor({
  getSettings: () => settings.get(),
  requestApproval: (req) => approvals.request(req),
  onLog: log,
  onActivity: () => {},
  readOnlyRoots: () => []
})

const orchestrator = new M.Orchestrator({
  settings,
  conversations,
  mcp,
  models,
  executor,
  approvals,
  skills,
  control,
  artifacts,
  emit
})


await models.refresh?.().catch(() => undefined)

/* ---- make room -------------------------------------------------------- */
//
// The Studio holds one big model at a time, and the guardrail that refuses a
// load says "insufficient system resources" — which reads like the machine is
// too small rather than like something else is still resident. Two things must
// be true before a turn is worth sending: nothing else is loaded, and the model
// that is loaded actually answers.
//
// Both are verified rather than assumed. The alternative is what happened on
// the second attempt at this: 514 seconds of wall clock waiting on a model that
// was never going to load, and a run that reported nothing built.

const wanted = modelOverride ?? M.WORKFLOW_BY_ID.code.preferredModel
const contextLength = Number(arg('context', 32768))
let displaced = null

async function loadedNow() {
  const state = await control.refresh().catch(() => null)
  return state?.loaded ?? []
}

{
  control.start()
  for (let i = 0; i < 40 && control.state().status !== 'connected'; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (control.state().status !== 'connected') {
    console.error(`\n  model control never connected (${control.state().url}).`)
    console.error('  Load the model yourself and re-run with --skip-load.')
    process.exit(1)
  }

  let resident = await loadedNow()
  const already = resident.some((m) => m.modelKey === wanted)
  if (!already && !argv.includes('--skip-load')) {
    for (const m of resident) {
      displaced = displaced ?? { key: m.modelKey, context: m.contextLength ?? null }
      console.log(`  unloading ${m.modelKey}`)
      await control.unload(m.identifier).catch(() => undefined)
    }
    // WAIT for it. unload returns before the memory is actually back, and
    // loading into a machine that has not finished freeing is exactly what
    // trips the guardrail.
    for (let i = 0; i < 60; i++) {
      resident = await loadedNow()
      if (resident.length === 0) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (resident.length > 0) {
      console.error(`\n  ${resident.map((m) => m.modelKey).join(', ')} would not unload.`)
      console.error('  Quit CaptainLlama if it is running — it reloads the model it needs.')
      process.exit(1)
    }

    // An explicit context, because the guardrail prices the DEFAULT one. The
    // refusal quotes 25.1GB for a model whose weights are about 16.
    console.log(`  loading   ${wanted} at ${contextLength} context`)
    const loaded = await control
      .load(wanted, { contextLength })
      .catch((e) => ({ ok: false, error: String(e) }))
    if (!loaded?.ok) {
      console.error(`\n  could not load ${wanted}: ${loaded?.error ?? 'unknown'}`)
      process.exit(1)
    }
  }

  // Proof, not optimism: one real completion before committing to the task.
  process.stdout.write('  checking    ')
  const probe = await fetch(`${settings.get().baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: wanted,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 8
    })
  })
    .then((r) => r.json())
    .catch((e) => ({ error: { message: String(e) } }))
  if (probe?.error) {
    console.error(`\n\n  ${wanted} will not answer:\n  ${probe.error.message}\n`)
    process.exit(1)
  }
  const st = await control.refresh().catch(() => null)
  windowTokens = st?.loaded?.[0]?.contextLength ?? null
  console.log(`answers — window ${windowTokens ?? 'unknown'} tokens\n`)
}

/* ---- run -------------------------------------------------------------- */

const wf = M.WORKFLOW_BY_ID.code
const model = modelOverride ?? wf.preferredModel
console.log(`\n\x1b[1m${task.label}\x1b[0m via the Code workflow`)
console.log(`  model     ${model}`)
console.log(`  effort    ${effortOverride ?? wf.sampling.reasoningEffort ?? '(model default)'}`)
console.log(`  workspace ${workspace}`)
console.log(`  window    ${windowTokens ?? 'unknown'} tokens\n`)

const conv = conversations.create('code')
conv.modelId = model
conversations.save(conv)
if (effortOverride) settings.update({ workflowReasoning: { code: effortOverride } })

const done = new Promise((resolveDone) => {
  const timer = setInterval(() => {
    const c = conversations.get(conv.id)
    if (!c) return
    const finished = !orchestrator.isBusy()
    const phase = liveMetrics?.phase ?? 'idle'
    const tokens = liveMetrics?.completionTokens ?? 0
    process.stdout.write(
      `\r      ${String(Math.round(ms() / 1000)).padStart(4)}s  ${phase.padEnd(8)} ` +
        `${String(tokens).padStart(6)} tok generated   `
    )
    if (finished && ms() > 4000) {
      clearInterval(timer)
      resolveDone('finished')
    }
    if (ms() > timeoutMs) {
      clearInterval(timer)
      resolveDone('timeout')
    }
  }, 1000)
})

/* Optionally start the workflow's MCP servers, as the app does on entering a
 * workflow. Off by default because it costs seconds and most runs do not need
 * it — on when reproducing something that only happens in the window, where
 * websearch and playwright are attached and the tool payload is twice the size.
 */
if (argv.includes('--mcp')) {
  process.stdout.write('  starting MCP servers for code…')
  const states = await orchestrator.applyWorkflow('code').catch(() => [])
  const ready = (states ?? []).filter((s) => s.status === 'ready')
  console.log(` ${ready.length} ready (${ready.map((s) => s.id).join(', ') || 'none'})`)
}

const sent = await orchestrator.send({ conversationId: conv.id, content: task.prompt })
if (!sent.accepted) {
  console.error(`\n  the harness refused the message: ${sent.error}`)
  process.exit(1)
}
const outcome = await done
process.stdout.write('\n')

/* ---- what happened ---------------------------------------------------- */

const final = conversations.get(conv.id)
for (const m of final?.messages ?? []) {
  if (m.role !== 'assistant') continue
  assistantTurns += 1
  contentChars += (m.content ?? '').length
  reasoningChars += (m.reasoning ?? '').length
  for (const c of m.toolCalls ?? []) {
    toolCalls.push({
      name: c.name,
      status: c.status,
      error: c.error ?? null,
      args: (c.arguments ?? '').slice(0, 160)
    })
  }
}

const runDir = join(ROOT, '.code-bench', `${taskKey}-${new Date(t0).toISOString().replace(/[:.]/g, '-')}`)
await mkdir(runDir, { recursive: true })
await writeFile(join(runDir, 'conversation.json'), JSON.stringify(final, null, 2))
await writeFile(join(runDir, 'harness.log'), logLines.join('\n'))
await writeFile(join(runDir, 'events.json'), JSON.stringify(events, null, 2))

/* ---- did it actually build the thing? --------------------------------- */

const built = []
async function walk(d, base = '') {
  for (const name of await readdir(d)) {
    const p = join(d, name)
    const s = await stat(p)
    if (s.isDirectory()) await walk(p, join(base, name))
    else built.push({ path: join(base, name), bytes: s.size })
  }
}
await walk(workspace).catch(() => undefined)
for (const f of built) {
  await mkdir(dirname(join(runDir, 'workspace', f.path)), { recursive: true })
  await writeFile(join(runDir, 'workspace', f.path), await readFile(join(workspace, f.path)))
}

const target = built.find((f) => f.path === task.expect.file)
const html = target ? await readFile(join(workspace, task.expect.file), 'utf8') : ''
const missing = task.expect.mustInclude.filter((t) => !html.includes(t))
const shapesFound = task.expect.shapes.filter((s) => new RegExp(`['"\`]${s}['"\`]|\\b${s}\\b`).test(html))

const emptyTurns = (final?.messages ?? []).filter(
  (m) => m.role === 'assistant' && !(m.content ?? '').trim() && (m.toolCalls ?? []).length === 0
).length

const verdict = {
  outcome,
  emptyTurns,
  wallClockMs: ms(),
  assistantTurns,
  reasoningChars,
  contentChars,
  toolCalls: toolCalls.length,
  toolErrors: toolCalls.filter((c) => c.status === 'error').length,
  fileWritten: Boolean(target),
  fileBytes: target?.bytes ?? 0,
  missingMarkers: missing,
  shapesFound: shapesFound.length,
  shapesExpected: task.expect.shapes.length
}
await writeFile(join(runDir, 'verdict.json'), JSON.stringify({ verdict, toolCalls }, null, 2))

const ok = (b) => (b ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mno\x1b[0m  ')
console.log(`\n\x1b[1mresult\x1b[0m`)
console.log(`  ${ok(outcome === 'finished')}finished cleanly            ${outcome}`)
console.log(`  ${ok(verdict.fileWritten)}wrote ${task.expect.file.padEnd(22)} ${verdict.fileBytes} bytes`)
console.log(`  ${ok(verdict.fileBytes >= task.expect.minBytes)}large enough to be complete  min ${task.expect.minBytes}`)
console.log(`  ${ok(missing.length === 0)}has the markers              ${missing.length ? `missing ${missing.join(', ')}` : 'all present'}`)
if (task.expect.shapes.length) {
  console.log(`  ${ok(shapesFound.length === task.expect.shapes.length)}all seven tetrominoes        ${shapesFound.length}/${task.expect.shapes.length}`)
}
console.log(`  ${ok(verdict.toolErrors === 0)}tool calls without error     ${toolCalls.length - verdict.toolErrors}/${toolCalls.length}`)
console.log(`  ${ok(emptyTurns === 0)}no empty replies             ${emptyTurns} turn(s) returned nothing`)

console.log(`\n\x1b[1mcost\x1b[0m`)
console.log(`  wall clock        ${(verdict.wallClockMs / 1000).toFixed(0)}s`)
console.log(`  assistant turns   ${assistantTurns}`)
console.log(`  reasoning         ${reasoningChars} chars (~${Math.round(reasoningChars / 4)} tokens)`)
console.log(`  written           ${contentChars} chars`)

if (toolCalls.length) {
  console.log(`\n\x1b[1mtools, in order\x1b[0m`)
  for (const [i, c] of toolCalls.entries()) {
    const mark = c.status === 'error' ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'
    console.log(`  ${String(i + 1).padStart(2)}. ${mark} ${c.name.padEnd(12)} ${c.error ?? c.args.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
}

// Put the machine back as it was found. A benchmark that leaves the voice
// workflows unable to load their model is a benchmark nobody runs twice.
if (displaced?.key) {
  console.log(`  restoring ${displaced.key}`)
  await control.unload(wanted).catch(() => undefined)
  await control
    .load(displaced.key, displaced.context ? { contextLength: displaced.context } : {})
    .catch(() => undefined)
}

console.log(`\n  run saved to ${runDir}\n`)
await rm(dir, { recursive: true, force: true })
process.exit(0)
