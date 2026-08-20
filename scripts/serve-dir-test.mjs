#!/usr/bin/env node
/**
 * The local origin: path containment, MIME types, and the outcome line.
 *
 * Two of these are load-bearing in different ways. resolveRequestPath is the
 * only thing standing between a served folder and the rest of the disk, so a
 * miss there is a security bug rather than a broken page. contentTypeFor is
 * load-bearing for a subtler reason: serving .js as text/plain makes a browser
 * refuse the module and report it as a script error, which sends whoever is
 * reading looking for a fault in code that is fine.
 *
 *   node scripts/serve-dir-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'serve-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { resolveRequestPath, contentTypeFor, serveDirectory, stopAllServed, listServed } from '${ROOT}/src/main/agent/static-server'\n` +
    `export { toolOutcome, outcomeDetail } from '${ROOT}/src/renderer/lib/toolFacts'\n`
)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const m = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ok  ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\nPath containment')
const root = sep === '\\' ? 'C:\\srv' : '/srv/site'
const inside = (url) => m.resolveRequestPath(root, url)
check('plain file resolves', inside('/golf.html') === join(root, 'golf.html'))
check('nested file resolves', inside('/assets/tex.png') === join(root, 'assets', 'tex.png'))
check('root resolves to the directory', inside('/') === root)
check('query string is dropped', inside('/golf.html?fresh=1') === join(root, 'golf.html'))
check('hash is dropped', inside('/golf.html#top') === join(root, 'golf.html'))
check('percent-encoded space decodes', inside('/my%20file.js') === join(root, 'my file.js'))
/* Traversal splits into two cases and only one of them reaches the containment
   check. The WHATWG URL parser resolves dot segments while parsing — including
   %2e-encoded ones — so `/../secrets.txt` has already become `/secrets.txt`
   before this function looks at it. Those are safe by normalisation, and the
   assertion is that they land INSIDE the root rather than that they are
   refused. Asserting null there would pass for the wrong reason and would go
   on passing if the containment check were deleted. */
const within = (url) => {
  const got = inside(url)
  return got !== null && (got === root || got.startsWith(root + sep))
}
check('dot-dot normalises to inside the root', within('/../secrets.txt'))
check('deep dot-dot normalises to inside the root', within('/a/b/../../../etc/passwd'))
check('%2e-encoded dot-dot normalises too', within('/%2e%2e/%2e%2e/etc/passwd'))
check('sibling with a shared prefix normalises inside', within('/../site-backup/x'))

/* The case that genuinely escapes: an ENCODED slash. The parser leaves
   `..%2f..%2f` as one opaque segment, so no dot-segment resolution happens,
   and decodeURIComponent then turns it back into real `../../`. This is the
   containment check earning its place. */
check('encoded-slash traversal is refused', inside('/..%2f..%2fetc/passwd') === null)
check('fully encoded traversal is refused', inside('/%2e%2e%2f%2e%2e%2fetc') === null)
check('encoded traversal one level up is refused', inside('/x/..%2f..%2f..%2ftmp') === null)

check('double-encoding stays literal rather than decoding twice',
  within('/%252e%252e/x'))
check('NUL byte is refused', inside('/a%00.html') === null)
check('malformed encoding is refused', inside('/%zz') === null)

console.log('\nContent types')
check('.js is the module MIME type', m.contentTypeFor('/a/three.js').startsWith('text/javascript'),
  m.contentTypeFor('/a/three.js'))
check('.mjs is the module MIME type', m.contentTypeFor('x.mjs').startsWith('text/javascript'))
check('.html is html', m.contentTypeFor('golf.html').startsWith('text/html'))
check('.css is css', m.contentTypeFor('golf.css').startsWith('text/css'))
check('.wasm is wasm', m.contentTypeFor('a.wasm') === 'application/wasm')
check('.glb is a model type', m.contentTypeFor('course.glb') === 'model/gltf-binary')
check('uppercase extension still matches', m.contentTypeFor('A.JS').startsWith('text/javascript'))
check('unknown falls back to octet-stream', m.contentTypeFor('x.weird') === 'application/octet-stream')

console.log('\nServing for real')
const site = join(dir, 'site')
await mkdir(join(site, 'sub'), { recursive: true })
await writeFile(join(site, 'index.html'), '<!doctype html><p>hi')
await writeFile(join(site, 'app.js'), 'export const x = 1\n')
await writeFile(join(dir, 'outside.txt'), 'secret')

const a = await m.serveDirectory(site)
const b = await m.serveDirectory(site)
check('serving twice reuses one origin', a.origin === b.origin, `${a.origin} vs ${b.origin}`)
check('bound to loopback', a.origin.startsWith('http://127.0.0.1:'), a.origin)
check('one entry is listed', m.listServed().filter((s) => s.root === site).length === 1)

const get = async (path) => {
  const res = await fetch(`${a.origin}${path}`)
  return { status: res.status, type: res.headers.get('content-type') ?? '', cache: res.headers.get('cache-control') ?? '', body: await res.text() }
}
const idx = await get('/')
check('directory serves index.html', idx.status === 200 && idx.body.includes('hi'), `${idx.status}`)
const js = await get('/app.js')
check('js served as a module type', js.type.startsWith('text/javascript'), js.type)
check('nothing is cached', js.cache.includes('no-store'), js.cache)
const missing = await get('/nope.js')
check('missing file is 404', missing.status === 404, `${missing.status}`)
const esc = await get('/../outside.txt')
check('traversal over the wire is refused', esc.status === 403 || esc.status === 404 || !esc.body.includes('secret'),
  `${esc.status} ${esc.body.slice(0, 40)}`)
const noIndex = await get('/sub/')
check('directory without an index is 404', noIndex.status === 404, `${noIndex.status}`)
m.stopAllServed()
check('stopping clears the registry', m.listServed().length === 0)

console.log('\nOutcome line')
const shell = (o) => m.toolOutcome({ kind: 'shell', exitCode: 0, timedOut: false, headline: '', headlineFromStderr: false, stdoutLines: 0, stderrLines: 0, ...o })
check('clean exit reads ok', shell({}).tone === 'ok')
check('clean exit with no output says so', m.outcomeDetail(shell({})) === 'no output')
check('nonzero exit reads bad', shell({ exitCode: 1 }).tone === 'bad')
check('nonzero exit names the code', shell({ exitCode: 127 }).status === 'exit 127')
check('timeout says timed out', shell({ timedOut: true, exitCode: null }).status === 'timed out')
check('killed process is not called exit null', shell({ exitCode: null }).status === 'killed')
check('stderr headline is flagged as an error',
  shell({ exitCode: 1, headline: 'not found', headlineFromStderr: true }).detailIsError === true)
check('one line of output gets no line count', shell({ stdoutLines: 1, headline: 'x' }).note === '')
check('many lines are counted', shell({ stdoutLines: 47, headline: 'x' }).note === '47 lines')
check('stderr volume is mentioned when the headline came from stdout',
  shell({ stdoutLines: 2, stderrLines: 3, headline: 'x' }).note.includes('3 on stderr'))
const serve = m.toolOutcome({ kind: 'serve', origin: 'http://127.0.0.1:5', displayPath: 'golf', pages: ['a', 'b'], reused: false })
check('serve reports the origin', serve.detail === 'http://127.0.0.1:5')
check('serve counts pages', serve.note === '2 pages')
check('re-serving says already up', m.toolOutcome({ kind: 'serve', origin: 'x', displayPath: 'y', pages: [], reused: true }).status === 'already up')
check('unknown structured payloads are ignored', m.toolOutcome({ kind: 'other' }) === null)
check('null structured is ignored', m.toolOutcome(null) === null)
check('a bare string is ignored', m.toolOutcome('exit 0') === null)

console.log(failed === 0 ? '\n\x1b[32mall serve_dir checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
