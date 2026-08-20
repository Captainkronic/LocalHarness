#!/usr/bin/env node
/**
 * The wizard's first question, and the credential store behind its last one.
 *
 * Getting the host wrong produces an install that looks finished and does
 * nothing, so the probe has to be right about what it found AND clear about
 * what it did not. The error text is tested because "failed to fetch" sends
 * someone to check their model list when the real problem is a sleeping Mac.
 *
 *   node scripts/setup-probe-test.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'probe-'))
await writeFile(join(dir, 'e.ts'),
  `export * from '${ROOT}/src/main/setup/probe'\nexport * as C from '${ROOT}/src/main/setup/credentials'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const M = await import(pathToFileURL(out).href)

let failed = 0
const check = (n, c, e = '') => { if (c) console.log(`  ok  ${n}`); else { failed++; console.log(`  FAIL ${n}${e ? ` — ${e}` : ''}`) } }

console.log('\nWhatever someone types in the host box')
for (const [input, host, api] of [
  ['adams-mac-studio.tailc7bb1e.ts.net', 'adams-mac-studio.tailc7bb1e.ts.net', 1235],
  ['http://studio.local:1235/v1', 'studio.local', 1235],
  ['127.0.0.1', '127.0.0.1', 1235],
  ['  192.168.1.9:9000  ', '192.168.1.9', 9000],
  ['', '127.0.0.1', 1235]
]) {
  const n = M.normaliseHost(input)
  check(`"${input.trim() || '(empty)'}" -> ${host}:${api}`, n.host === host && n.apiPort === api,
    `got ${n.host}:${n.apiPort}`)
}
check('the native port is only guessed when no port was given',
  M.normaliseHost('x:9000').nativePort === 8999 && M.normaliseHost('x').nativePort === 1234)

console.log('\nReading a server that answers')
const lm = async (url) => {
  if (url.includes('/api/v0/models') && url.includes(':1235')) return {
    ok: true, status: 200,
    json: async () => ({ data: [
      { id: 'qwen3.8-27b@q4_k_xl', state: 'loaded', loaded_context_length: 83712 },
      { id: 'gemma-4-e4b', state: 'not-loaded' }
    ] })
  }
  if (url.includes(':1234')) return { ok: true, status: 200, json: async () => ({ data: [] }) }
  throw new Error('ECONNREFUSED')
}
const good = await M.probeServer('studio', lm)
check('the API is reported reachable', good.api === true)
check('the native endpoint too, so telemetry will work', good.native === true)
check('models come back', good.models.length === 2)
check('and it knows which one is already in memory',
  good.models.find((m) => m.loaded)?.id === 'qwen3.8-27b@q4_k_xl')
check('context length is carried through', good.models[0].contextLength === 83712)
check('urls are built for settings', good.baseUrl === 'http://studio:1235/v1' && good.nativeApiUrl === 'http://studio:1234')

console.log('\nA usable server missing only the telemetry port')
const apiOnly = async (url) => {
  if (url.includes(':1234')) throw new Error('ECONNREFUSED')
  if (url.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) }
  throw new Error('HTTP 404')
}
const partial = await M.probeServer('studio', apiOnly)
check('still counts as reachable', partial.api === true)
check('but flags the missing native endpoint', partial.native === false)
check('and does NOT report an error, because it is usable', partial.error === undefined)

console.log('\nWhen it does not answer, say which kind of not-answering')
const failWith = (msg) => async () => { throw new Error(msg) }
const refused = await M.probeServer('studio', failWith('ECONNREFUSED'))
check('connection refused names the port and LM Studio', /nothing is listening on port 1235/.test(refused.error ?? ''), refused.error)
const dns = await M.probeServer('nope.local', failWith('getaddrinfo ENOTFOUND'))
check('a bad name says it does not resolve', /does not resolve/.test(dns.error ?? ''), dns.error)
const slow = await M.probeServer('studio', failWith('TimeoutError: signal timed out'))
check('a timeout suggests the machine may be asleep', /awake/.test(slow.error ?? ''), slow.error)
check('and none of these claim the API works', !refused.api && !dns.api && !slow.api)

console.log('\nCredentials: what is stored and what is shown')
const root = mkdtempSync(join(tmpdir(), 'creds-'))
M.C.setCredential(root, 'flights', 'duffel_token', 'duffel_test_ABCDEFGHIJKLMNOP')
M.C.setCredential(root, 'health', 'HEALTH_CONTACT_EMAIL', 'adam@example.com')
const states = M.C.credentialStates(root)
const tok = states.find((s) => s.key === 'duffel_token')
check('a secret records that it is set', tok.set === true && tok.length === 28, JSON.stringify(tok))
check('but its VALUE never leaves this module', tok.value === undefined,
  'a settings screenshot must not contain the token')
const mail = states.find((s) => s.key === 'HEALTH_CONTACT_EMAIL')
check('a non-secret IS shown, because masking it makes the panel useless',
  mail.value === 'adam@example.com')
check('an unset field reads as unset', states.find((s) => s.key === 'BRAVE_API_KEY').set === false)

console.log('\nSecrets are not left world-readable')
const mode = statSync(join(root, 'flights', 'credentials.json')).mode & 0o777
check('the credentials file is 0600', mode === 0o600, `got 0${mode.toString(8)}`)

console.log('\nThe three servers that hold their own inference URL')
const touched = M.C.applyServerUrl(root, 'http://studio:1235/v1')
check('all three are pointed at the verified server', touched.length === 3, touched.join(', '))
check('including the browser, which is the one that fails silently',
  touched.some((t) => t.startsWith('playwright.')))
const after = M.C.credentialStates(root).filter((s) => s.key.endsWith('_LMSTUDIO_URL'))
check('and they now agree with the app', after.every((s) => s.value === 'http://studio:1235/v1'))
check('env for launching a server carries them', M.C.envFor(root, 'playwright').PWMCP_LMSTUDIO_URL === 'http://studio:1235/v1')

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mall setup-probe checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
