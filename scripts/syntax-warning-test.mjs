#!/usr/bin/env node
/**
 * The parse check that runs after write_file and edit_file.
 *
 * A model cannot see a syntax error. The browser reports it to a console it is
 * not reading, and reading the file back shows source that looks perfectly
 * reasonable line by line. On a live flight-sim run one edit inserted a second
 * copy of a block, leaving three functions declared twice; the module never
 * evaluated, so window.__sim was absent, every probe returned nothing, and the
 * page looked dead. Roughly twenty minutes went into hunting a ReferenceError
 * in code that had never run. `--check` answers it in milliseconds.
 *
 * Two properties matter and they pull against each other: it must CATCH a
 * broken file, and it must never cry wolf on a working one — a false warning
 * would send a model rewriting code that was fine.
 *
 *   node scripts/syntax-warning-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-syntax-'))
await writeFile(join(dir, 'e.ts'), `export { syntaxWarning } from '${ROOT}/src/main/agent/executor'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim }
})
const { syntaxWarning } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n\x1b[1mIt catches what actually broke the run\x1b[0m')
/* The real shape: an edit pasted a block instead of replacing it. */
const duplicated = `
import * as THREE from './three.min.js';
function stepThrottle(dt) { return dt; }
function doReset() { return 1; }
function stepThrottle(dt) { return dt * 2; }
`
const dup = await syntaxWarning('/x/sim.js', duplicated)
check('a duplicated declaration is reported', typeof dup === 'string', String(dup))
check('and it says the file does not parse', /DOES NOT PARSE/.test(dup ?? ''), String(dup))
check('and names the identifier', /stepThrottle|already been declared/.test(dup ?? ''), String(dup))
check('and points at a line', /around line \d+/.test(dup ?? ''), String(dup))

const unclosed = await syntaxWarning('/x/a.js', 'function f() { if (true) { return 1; }')
check('an unclosed brace is reported', typeof unclosed === 'string', String(unclosed))

console.log('\n\x1b[1mIt does NOT cry wolf\x1b[0m')
check('valid ESM passes',
  (await syntaxWarning('/x/sim.js', "import * as T from './t.js';\nexport const a = 1;\n")) === null)
check('valid CommonJS passes',
  (await syntaxWarning('/x/a.js', "const x = require('y');\nmodule.exports = x;\n")) === null)
check('modern syntax passes',
  (await syntaxWarning('/x/a.js', 'const f = async (a) => a?.b ?? (a ||= 2);\nclass K { #p = 1; }\n')) === null)
check('an UNDEFINED variable is not a parse error',
  (await syntaxWarning('/x/a.js', 'liftNowN = cl;\n')) === null,
  'only syntax is checked — flagging this would be a false alarm about working code')

console.log('\n\x1b[1mScope\x1b[0m')
check('TypeScript is skipped, not mis-parsed',
  (await syntaxWarning('/x/a.ts', 'const x: number = 1;\n')) === null,
  'type annotations are not valid JavaScript — checking them would report every .ts file as broken')
check('JSX is skipped — it is not JavaScript',
  (await syntaxWarning('/x/Home.jsx', 'export default () => <div className="a">hi</div>\n')) === null,
  'every React component would come back "DOES NOT PARSE" at the first angle bracket')
check('TSX is skipped too',
  (await syntaxWarning('/x/Home.tsx', 'const a: number = 1; export default () => <p>{a}</p>\n')) === null)
check('css is skipped', (await syntaxWarning('/x/a.css', 'body { color: red }')) === null)
check('html is skipped', (await syntaxWarning('/x/a.html', '<!doctype html><p>hi')) === null)
check('broken JSON is caught', typeof (await syntaxWarning('/x/a.json', '{"a": 1,}')) === 'string')
check('good JSON passes', (await syntaxWarning('/x/a.json', '{"a": 1}')) === null)
check('a very large file is skipped',
  (await syntaxWarning('/x/big.js', 'var a = 1;\n'.repeat(60000) + 'function(){')) === null,
  'a bundle is not what an agent hand-edits, and parsing one costs more than it saves')

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n\x1b[32mall syntax-warning checks passed\x1b[0m\n' : `\n\x1b[31m${failed} failed\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
