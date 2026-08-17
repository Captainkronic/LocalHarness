#!/usr/bin/env node
/**
 * End-to-end smoke test against the real inference box and the real MCP servers.
 *
 * The app's main-process modules are TypeScript with `@shared/*` aliases, so this
 * bundles them with esbuild (already present as a Vite dependency) and runs the
 * bundle under plain Node. Nothing is mocked — a pass here means the same code
 * paths the app uses actually work against this machine and this network.
 *
 *   node scripts/smoke.mjs
 *
 * Exit code 0 = all checks passed, 1 = something is genuinely broken.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '[32m  ok  [0m' : '[31m FAIL [0m'
  console.log(`${mark} ${name}${detail ? `  [2m${detail}[0m` : ''}`)
}

/** Bundle the modules under test into one ESM file Node can import. */
async function bundle() {
  const dir = await mkdtemp(join(tmpdir(), 'localharness-smoke-'))
  const entry = join(dir, 'entry.ts')
  await writeFile(
    entry,
    `export { McpClient } from '${ROOT}/src/main/mcp/client'
     export { estimateTokens, sanitizeSchema, toolSchemaTokens } from '${ROOT}/src/main/mcp/tokens'
     export { streamChat } from '${ROOT}/src/main/llm/client'
     export { isInsideAny, expandTilde } from '${ROOT}/src/main/store/paths'
     export { unifiedDiff, diffStat } from '${ROOT}/src/main/agent/diff'
    `,
    'utf8'
  )
  const outfile = join(dir, 'bundle.mjs')
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
  return { dir, outfile }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n[1mLocalHarness smoke test[0m\n')

  let tmp
  let mod
  try {
    tmp = await bundle()
    mod = await import(pathToFileURL(tmp.outfile).href)
    check('bundle main-process modules', true)
  } catch (err) {
    check('bundle main-process modules', false, String(err))
    return finish()
  }

  /* ---- pure logic ------------------------------------------------- */

  const home = mod.expandTilde('~')
  check('expandTilde resolves home', home.startsWith('/'), home)

  // The containment check must be a path-segment test, not a string prefix.
  const segmentSafe =
    mod.isInsideAny('/etc/hosts', ['/etc']) === true &&
    mod.isInsideAny('/etcfoo/x', ['/etc']) === false
  check('sandbox containment is segment-based', segmentSafe, '/etcfoo is not inside /etc')

  const escapes = mod.isInsideAny(`${home}/../../etc/passwd`, [`${home}/Documents`])
  check('sandbox rejects ../ escape', escapes === false)

  const sanitized = mod.sanitizeSchema({
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'] },
      any: { anyOf: [{ type: 'number' }, { type: 'string' }] },
      bare: { description: 'no type' }
    }
  })
  const noEnum = JSON.stringify(sanitized).includes('"enum"') === false
  const noAnyOf = JSON.stringify(sanitized).includes('anyOf') === false
  const typed = sanitized.properties.bare.type !== undefined
  check('schema sanitiser strips enum/anyOf and types bare nodes', noEnum && noAnyOf && typed)

  const diff = mod.unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.txt')
  const stat = mod.diffStat('a\nb\nc\n', 'a\nB\nc\n')
  check(
    'unified diff produces hunks and stats',
    diff.includes('@@') && diff.includes('-b') && diff.includes('+B') && stat.added === 1 && stat.removed === 1,
    `+${stat.added} -${stat.removed}`
  )

  /* ---- the inference box ------------------------------------------ */

  const NATIVE = process.env.LH_NATIVE_URL ?? 'http://adams-mac-studio.tailc7bb1e.ts.net:1234'
  const BASE = process.env.LH_BASE_URL ?? 'http://127.0.0.1:1235/v1'

  let resident = null
  let loadedWindow = null
  try {
    const t0 = Date.now()
    const res = await fetch(`${NATIVE}/api/v0/models`, { signal: AbortSignal.timeout(10_000) })
    const body = await res.json()
    const models = body.data ?? []
    resident = models.find((m) => m.state === 'loaded') ?? null
    loadedWindow = resident?.loaded_context_length ?? null
    check(
      'LM Studio native API reachable',
      res.ok && models.length > 0,
      `${models.length} models, ${Date.now() - t0}ms`
    )
    check(
      'a model is resident and reports its real window',
      resident !== null && typeof loadedWindow === 'number',
      resident ? `${resident.id} @ ${loadedWindow?.toLocaleString()} ctx (ceiling ${resident.max_context_length.toLocaleString()})` : 'nothing loaded'
    )
    if (resident && loadedWindow) {
      // The invariant is that the REAL window is read and never substituted,
      // not that it differs from the ceiling. Those two coincide legitimately:
      // a small model like gemma-4-e4b fits its full 131,072. Asserting they
      // differ was a property of whichever model happened to be resident.
      const sane = loadedWindow > 0 && loadedWindow <= resident.max_context_length
      check(
        'the real window is reported and within the ceiling',
        sane,
        loadedWindow === resident.max_context_length
          ? 'loaded at its full ceiling — legitimate for a model this size'
          : `loaded ${loadedWindow.toLocaleString()} of a possible ${resident.max_context_length.toLocaleString()} — the meter must use the former`
      )
    }
  } catch (err) {
    check('LM Studio native API reachable', false, String(err))
  }

  /* ---- streaming chat, measured ----------------------------------- */

  if (resident) {
    try {
      const controller = new AbortController()
      const t0 = Date.now()
      let ttft = null
      let content = ''
      let tokens = 0
      let usage = null
      let finish = null

      await mod.streamChat(
        {
          baseUrl: BASE,
          apiKey: process.env.LH_API_KEY ?? 'lm-studio',
          model: resident.id,
          messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
          temperature: 0,
          topP: 1,
          maxTokens: 2048,
          signal: controller.signal
        },
        {
          onFirstToken: () => {
            ttft = Date.now() - t0
          },
          onContent: (d) => {
            content += d
            tokens++
          },
          onReasoning: () => {
            tokens++
          },
          onToolCallDelta: () => {},
          onUsage: (u) => {
            usage = u
          },
          onDone: (r) => {
            finish = r
          }
        }
      )

      const total = Date.now() - t0
      check('streaming chat completion works', content.trim().length > 0, JSON.stringify(content.trim().slice(0, 40)))
      check('TTFT measured', ttft !== null, `${ttft}ms`)
      check(
        'usage arrives in the final SSE chunk',
        usage !== null && usage.promptTokens > 0,
        usage ? `${usage.promptTokens} in / ${usage.completionTokens} out` : 'none'
      )
      if (usage && ttft) {
        const prefill = (usage.promptTokens / ttft) * 1000
        const decode = (usage.completionTokens / Math.max(1, total - ttft)) * 1000
        check(
          'throughput derivable from the stream',
          prefill > 0 && decode > 0,
          `prefill ~${prefill.toFixed(1)} tok/s, decode ~${decode.toFixed(1)} tok/s`
        )
      }
      check('finish_reason surfaced', finish !== null, String(finish))
    } catch (err) {
      check('streaming chat completion works', false, String(err))
    }
  }

  /* ---- a real MCP server ------------------------------------------ */

  try {
    const client = new mod.McpClient({
      id: 'websearch',
      command: '/usr/bin/python3',
      args: ['~/.config/websearch-mcp/server.py'],
      env: { WEBSEARCH_MIN_INTERVAL: '1.0' },
      callTimeoutMs: 30_000,
      onLog: () => {}
    })
    const tools = await client.start()
    const cost = tools.reduce((n, t) => n + t.tokens, 0)
    check(
      'MCP stdio handshake + tools/list',
      tools.length > 0,
      `${tools.length} tools, ${cost} tokens, handshake ${client.handshakeMs}ms`
    )
    check('tilde in args expanded before spawn', client.pid !== undefined, `pid ${client.pid}`)
    await client.stop()
    check('MCP server stops cleanly', true)
  } catch (err) {
    check('MCP stdio handshake + tools/list', false, String(err))
  }

  if (tmp) await rm(tmp.dir, { recursive: true, force: true })
  return finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (failed.length === 0) {
    console.log(`[32m${results.length}/${results.length} checks passed[0m\n`)
    process.exit(0)
  }
  console.log(`[31m${failed.length} of ${results.length} checks failed[0m\n`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
