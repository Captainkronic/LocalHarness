#!/usr/bin/env node
/**
 * Build one thing, over many turns, unattended.
 *
 * code-bench.mjs sends a single prompt and grades whatever comes back. That is
 * the right shape for a benchmark and the wrong shape for a build: nothing
 * non-trivial is finished in one turn, and the interesting harness failures —
 * context exhaustion, a stream that dies mid-argument, a tool that refuses on
 * the fortieth call but not the first — only show up after an hour of turns.
 *
 * So this boots the same real subsystems code-bench does, then runs a LOOP:
 * send, wait, probe the artifact in a real browser, feed the findings back as
 * the next message, repeat until the probe passes or the deadline lands.
 *
 * It is deliberately hard to kill. A refused send, a stalled turn, an MCP
 * server that dies, a model that returns nothing — each is logged, counted and
 * worked around rather than thrown. The run ending early because of the
 * harness is the failure mode this exists to measure.
 *
 *   node scripts/overnight/build-game.mjs \
 *     --workspace "/path/to/ws" --brief brief.md --probe scripts/overnight/probe-3d.mjs \
 *     --model qwen3.8-27b@q4_k_xl --rounds 24 --deadline-mins 480 --out .overnight/minigolf
 */
import { build } from 'esbuild'
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const workspace = resolve(arg('workspace', join(ROOT, '.overnight/ws')))
const briefFile = arg('brief', null)
const probeScript = arg('probe', join(ROOT, 'scripts/overnight/probe-3d.mjs'))
const modelOverride = arg('model', null)
const effortOverride = arg('effort', null)
const maxRounds = Number(arg('rounds', 24))
const deadlineMs = Number(arg('deadline-mins', 480)) * 60_000
const turnTimeoutMs = Number(arg('turn-timeout-mins', 25)) * 60_000
const outDir = resolve(arg('out', join(ROOT, '.overnight/build')))
const page = arg('page', 'index.html')
const withMcp = !argv.includes('--no-mcp')

await mkdir(outDir, { recursive: true })
await mkdir(workspace, { recursive: true })

const t0 = Date.now()
const ms = () => Date.now() - t0
const clock = () => new Date().toISOString().slice(11, 19)
const logFile = join(outDir, 'driver.log')
const jsonl = join(outDir, 'events.jsonl')
const say = async (line) => {
  const s = `[${clock()} +${Math.round(ms() / 1000)}s] ${line}`
  console.log(s)
  await appendFile(logFile, s + '\n').catch(() => {})
}
const event = async (kind, detail = {}) => {
  await appendFile(jsonl, JSON.stringify({ at: Date.now(), ms: ms(), kind, ...detail }) + '\n').catch(() => {})
}

// Nothing below is allowed to end the process. An unattended run that dies at
// 02:00 with a stack trace has measured nothing.
process.on('unhandledRejection', (e) => {
  say(`unhandledRejection: ${String(e).slice(0, 300)}`)
  event('unhandledRejection', { error: String(e).slice(0, 2000) })
})
process.on('uncaughtException', (e) => {
  say(`uncaughtException: ${String(e?.stack ?? e).slice(0, 300)}`)
  event('uncaughtException', { error: String(e?.stack ?? e).slice(0, 2000) })
})

/* ---- bundle the real modules, exactly as code-bench does -------------- */

const tmp = await mkdtemp(join(tmpdir(), 'lh-build-'))
await writeFile(
  join(tmp, 'entry.ts'),
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
const shim = join(tmp, 'electron-shim.mjs')
await writeFile(
  shim,
  `export const app = { getPath: () => process.env.LH_USERDATA, getVersion: () => '0.1.0' }
   export default { app }\n`
)
const userData = join(outDir, 'userdata')
await mkdir(userData, { recursive: true })
process.env.LH_USERDATA = userData

const outfile = join(tmp, 'b.mjs')
await build({
  entryPoints: [join(tmp, 'entry.ts')],
  outfile,
  bundle: true,
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim }
})
const M = await import(pathToFileURL(outfile).href)

/* ---- observation ------------------------------------------------------ */

const harnessLog = []
const log = (level, scope, message) => {
  const line = `${String(ms()).padStart(8)}ms ${String(level).padEnd(5)} ${String(scope).padEnd(10)} ${message}`
  harnessLog.push(line)
  if (harnessLog.length % 200 === 0) flushHarnessLog()
  if (level === 'error' || level === 'warn') say(`  ${level} ${scope}: ${String(message).slice(0, 200)}`)
}
const flushHarnessLog = () => writeFile(join(outDir, 'harness.log'), harnessLog.join('\n')).catch(() => {})

let liveMetrics = null
let reported = 0
let turnStart = Date.now()
let windowTokens = null
let lastPrefill = 0
const turnRecords = []
const emit = (channel, payload) => {
  if (channel === 'event:liveMetrics') {
    liveMetrics = payload
    if (payload?.promptTokens) lastPrefill = payload.promptTokens
    return
  }
  if (channel === 'event:log') {
    const { level, scope, message } = payload ?? {}
    log(level, scope, message)
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
      const wall = Math.round((Date.now() - turnStart) / 1000)
      turnStart = Date.now()
      const tools = (m.toolCalls ?? []).map((c) => c.name).join(',') || '—'
      const ctx = met.promptTokens ?? lastPrefill
      const fill = windowTokens ? `${Math.round((ctx / windowTokens) * 100)}%` : '?'
      const empty = !(m.content ?? '').trim() && (m.toolCalls ?? []).length === 0
      const errs = (m.toolCalls ?? []).filter((c) => c.status === 'error')
      turnRecords.push({ ms: ms(), wall, ctx, fill, tools, empty, toolErrors: errs.length })
      say(
        `  turn ${String(reported).padStart(3)} ${String(wall).padStart(4)}s ctx ${String(ctx).padStart(6)} ${String(fill).padStart(4)} ` +
          `think ${String(Math.round((m.reasoning ?? '').length / 4)).padStart(5)} wrote ${String((m.content ?? '').length).padStart(5)} ${tools}` +
          (empty ? '  << EMPTY REPLY' : '')
      )
      for (const f of errs) say(`        tool ${f.name} errored: ${String(f.error).split('\n')[0].slice(0, 160)}`)
      event('turn', { n: reported, wall, ctx, tools, empty, toolErrors: errs.length })
    }
  }
}

/* ---- subsystems -------------------------------------------------------- */

// Start from Adam's real settings so this run sees the same endpoint, MCP
// selection and reasoning levels the window does. A driver that quietly used
// defaults would be testing a configuration nobody runs.
let realSettings = {}
try {
  realSettings = JSON.parse(
    await readFile(join(homedir(), 'Library/Application Support/localharness/settings.json'), 'utf8')
  )
} catch {
  /* defaults are fine */
}

const settings = new M.SettingsStore(userData)
settings.update({
  ...realSettings,
  workspaceRoots: [workspace],
  approvalMode: 'auto_all',
  shellAllowlist: ['ls', 'cat', 'pwd', 'node', 'node -v', 'node --check', 'python3', 'head', 'tail', 'wc', 'grep', 'find', 'du', 'stat']
})
const conversations = new M.ConversationStore(userData)
const artifacts = new M.ArtifactStore(userData)
const mcp = new M.McpManager({ onStates: () => {}, onLog: log })
const models = new M.ModelRegistry({ getSettings: () => settings.get(), onModels: () => {}, onHealth: () => {}, onLog: log })
const control = new M.LmStudioControl({ getSettings: () => settings.get(), onState: () => {}, onProgress: () => {}, onLog: log })
const skills = new M.SkillRegistry({ getSettings: () => settings.get(), onSkills: () => {}, onLog: log })
const approvals = new M.ApprovalBroker((req) => {
  event('approval', { tool: req.toolName, summary: String(req.summary ?? '').slice(0, 200) })
  setTimeout(() => approvals.resolve(req.id, 'allow'), 0)
})
const executor = new M.ToolExecutor({
  getSettings: () => settings.get(),
  requestApproval: (req) => approvals.request(req),
  onLog: log,
  onActivity: () => {},
  readOnlyRoots: () => []
})
const orchestrator = new M.Orchestrator({ settings, conversations, mcp, models, executor, approvals, skills, control, artifacts, emit })
await models.refresh?.().catch(() => undefined)

/* ---- the model is up and answering ------------------------------------- */

const wf = M.WORKFLOW_BY_ID.code
const model = modelOverride ?? wf.preferredModel

control.start()
for (let i = 0; i < 40 && control.state().status !== 'connected'; i++) await new Promise((r) => setTimeout(r, 250))
const st = await control.refresh().catch(() => null)
windowTokens = st?.loaded?.[0]?.contextLength ?? null
await say(`model control ${control.state().status} — loaded: ${(st?.loaded ?? []).map((m) => m.modelKey).join(', ') || 'none'}`)

const probeReply = await fetch(`${settings.get().baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 8 })
})
  .then((r) => r.json())
  .catch((e) => ({ error: { message: String(e) } }))
if (probeReply?.error) {
  await say(`FATAL: ${model} will not answer: ${probeReply.error.message}`)
  process.exit(1)
}
await say(`${model} answers — window ${windowTokens ?? 'unknown'} tokens`)

if (effortOverride) settings.update({ workflowReasoning: { ...(settings.get().workflowReasoning ?? {}), code: effortOverride } })

if (withMcp) {
  const states = await orchestrator.applyWorkflow('code').catch((e) => {
    say(`applyWorkflow failed: ${String(e).slice(0, 200)}`)
    return []
  })
  const ready = (states ?? []).filter((s) => s.status === 'ready')
  await say(`MCP: ${ready.length} ready (${ready.map((s) => s.id).join(', ') || 'none'})` +
    `${(states ?? []).filter((s) => s.status !== 'ready').map((s) => ` [${s.id}=${s.status}]`).join('')}`)
}

/* ---- helpers ----------------------------------------------------------- */

const brief = briefFile ? await readFile(briefFile, 'utf8') : 'Build something in the workspace.'

const runProbe = () =>
  new Promise((res) => {
    const outJson = join(outDir, 'probe-last.json')
    execFile(
      process.execPath,
      [probeScript, workspace, '--page', page, '--json', outJson, '--shots', join(outDir, 'shots')],
      { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      async (err, stdout, stderr) => {
        let parsed = null
        try {
          parsed = JSON.parse(await readFile(outJson, 'utf8'))
        } catch {
          /* the probe may have died before writing */
        }
        res({
          passed: !err,
          text: String(stdout || '') + (stderr ? `\n${stderr}` : ''),
          json: parsed,
          crashed: Boolean(err && err.code === undefined)
        })
      }
    )
  })

const workspaceListing = async () => {
  const out = []
  const walk = async (d, base = '') => {
    for (const name of await readdir(d).catch(() => [])) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      const s = await stat(p).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) await walk(p, join(base, name))
      else out.push(`${join(base, name)} (${s.size} bytes)`)
    }
  }
  await walk(workspace)
  return out
}

/** Wait for the orchestrator to go idle, reporting nothing and giving up late. */
const waitIdle = async (limitMs) => {
  const start = Date.now()
  await new Promise((r) => setTimeout(r, 3000))
  while (orchestrator.isBusy()) {
    if (Date.now() - start > limitMs) return 'timeout'
    await new Promise((r) => setTimeout(r, 2000))
  }
  return 'idle'
}

let conv = conversations.create('code')
conv.modelId = model
conversations.save(conv)
await say(`conversation ${conv.id.slice(0, 8)} — workspace ${workspace}`)

const freshConversation = async (why) => {
  await say(`starting a fresh conversation (${why})`)
  event('fresh-conversation', { why })
  conv = conversations.create('code')
  conv.modelId = model
  conversations.save(conv)
  reported = 0
}

/* ---- the loop ---------------------------------------------------------- */

let round = 0
let lastProbe = null
let consecutiveNoProgress = 0
let lastFingerprint = ''
let finalVerdict = 'incomplete'

while (round < maxRounds && ms() < deadlineMs) {
  round += 1
  const first = round === 1

  const files = await workspaceListing()
  let message
  if (first) {
    message = brief
  } else {
    const probe = lastProbe ?? { text: '(no probe output)' }
    message =
      `Automated play-test of the game as it stands, run in headless Chrome over http:// ` +
      `(the same way a player would load it):\n\n${probe.text.trim().slice(0, 4000)}\n\n` +
      `Files in the workspace now:\n${files.join('\n') || '(empty)'}\n\n` +
      `Fix the failures above, starting with the one that stops the game being playable at all. ` +
      `Open the page yourself and check before you tell me it is fixed. Do not rewrite what already works.`
  }

  await say(`--- round ${round}/${maxRounds} --- sending ${message.length} chars`)
  event('round-start', { round, chars: message.length })

  let sent = await orchestrator.send({ conversationId: conv.id, content: message }).catch((e) => ({ accepted: false, error: String(e) }))
  if (!sent.accepted) {
    await say(`send refused: ${sent.error}`)
    event('send-refused', { round, error: String(sent.error).slice(0, 500) })
    await freshConversation('the send was refused')
    sent = await orchestrator.send({ conversationId: conv.id, content: message }).catch((e) => ({ accepted: false, error: String(e) }))
    if (!sent.accepted) {
      await say(`send refused twice — waiting 60s and trying the next round`)
      await new Promise((r) => setTimeout(r, 60_000))
      continue
    }
  }

  const outcome = await waitIdle(turnTimeoutMs)
  if (outcome === 'timeout') {
    await say(`round ${round} hit the ${Math.round(turnTimeoutMs / 60000)}min turn limit — cancelling`)
    event('turn-timeout', { round })
    try {
      orchestrator.cancel(conv.id)
    } catch (e) {
      await say(`cancel threw: ${String(e).slice(0, 200)}`)
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  flushHarnessLog()

  // Context pressure: a conversation that has eaten most of the window will
  // spend the next round being trimmed rather than working. Start clean and
  // let the probe findings carry the state.
  const usage = (() => {
    try {
      return orchestrator.contextUsage(conv.id)
    } catch {
      return null
    }
  })()
  const used = usage?.tokens ?? lastPrefill
  if (windowTokens && used > windowTokens * 0.6) {
    await freshConversation(`context at ${Math.round((used / windowTokens) * 100)}% of the window`)
  }

  // Probe the artifact.
  lastProbe = await runProbe()
  await say(`probe: ${lastProbe.json?.summary ?? (lastProbe.passed ? 'passed' : 'no summary — probe failed to report')}`)
  event('probe', { round, passed: lastProbe.passed, summary: lastProbe.json?.summary ?? null, results: lastProbe.json?.results ?? null })
  await writeFile(join(outDir, `probe-round-${String(round).padStart(2, '0')}.json`), JSON.stringify(lastProbe.json ?? { text: lastProbe.text }, null, 2)).catch(() => {})

  if (lastProbe.passed) {
    finalVerdict = 'playable'
    await say(`the probe passes — the game is playable. Continuing to polish is a separate decision; stopping here.`)
    break
  }

  const fingerprint = JSON.stringify((lastProbe.json?.results ?? []).map((r) => [r.name, r.ok]))
  if (fingerprint === lastFingerprint) {
    consecutiveNoProgress += 1
    await say(`no change in the probe results (${consecutiveNoProgress} round(s) running)`)
    if (consecutiveNoProgress === 2) await freshConversation('two rounds with identical results')
    if (consecutiveNoProgress >= 4) {
      finalVerdict = 'stuck'
      await say(`four rounds with identical results — stopping rather than burning the night on it`)
      break
    }
  } else {
    consecutiveNoProgress = 0
  }
  lastFingerprint = fingerprint
}

if (ms() >= deadlineMs) finalVerdict = 'deadline'
if (round >= maxRounds && finalVerdict === 'incomplete') finalVerdict = 'out-of-rounds'

flushHarnessLog()
const files = await workspaceListing()
await writeFile(
  join(outDir, 'summary.json'),
  JSON.stringify(
    {
      verdict: finalVerdict,
      rounds: round,
      wallClockMs: ms(),
      model,
      windowTokens,
      turns: turnRecords.length,
      emptyTurns: turnRecords.filter((t) => t.empty).length,
      toolErrors: turnRecords.reduce((a, t) => a + t.toolErrors, 0),
      files,
      lastProbe: lastProbe?.json ?? null
    },
    null,
    2
  )
).catch(() => {})
await say(`DONE verdict=${finalVerdict} rounds=${round} turns=${turnRecords.length} wall=${Math.round(ms() / 60000)}min`)
process.exit(0)
