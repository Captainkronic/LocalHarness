#!/usr/bin/env node
/**
 * edit_file's relaxed match, and the limits on it.
 *
 * `old_string was not found` was the most common tool failure across a day of
 * agentic runs — more than sandbox refusals, bad paths and shell quoting put
 * together. Almost none were the model asking for the wrong text; they were the
 * model retyping text it had read earlier and getting the indentation wrong,
 * which an exact indexOf cannot forgive. Each one costs a re-read of the file
 * and a round trip through a 27B model at ~18 tok/s.
 *
 * The relaxing is the easy half. The half worth testing is everything it must
 * still REFUSE, because a matcher that guesses would edit the wrong line and
 * report success.
 *
 *   node scripts/edit-match-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-editmatch-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { fuzzyRange, nearestLine } from '${ROOT}/src/main/agent/executor'\n`
)
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
const { fuzzyRange, nearestLine } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`) }
}
/** The text a real edit would replace, or null. */
const cut = (hay, needle) => {
  const r = fuzzyRange(hay, needle)
  return r ? hay.slice(r[0], r[1]) : null
}

const FILE = [
  'function stepSim(dt) {',
  '    const speed = Math.hypot(vel.x, vel.z);',
  '    if (speed > STOP_EPS) {',
  '        applyDrag(dt);',
  '    }',
  '}',
  '',
  'function other() {',
  '    return 1;',
  '}',
  ''
].join('\n')

console.log('\n\x1b[1mIndentation is forgiven\x1b[0m')
check('a line indented differently still matches',
  cut(FILE, 'const speed = Math.hypot(vel.x, vel.z);') === '    const speed = Math.hypot(vel.x, vel.z);')
check('the returned range is the FILE text, not the needle',
  cut(FILE, 'const speed = Math.hypot(vel.x, vel.z);').startsWith('    '),
  'replacing with the needle text would silently reindent the file')
check('a multi-line block matches across differing indents',
  cut(FILE, 'if (speed > STOP_EPS) {\n  applyDrag(dt);\n}') ===
  '    if (speed > STOP_EPS) {\n        applyDrag(dt);\n    }')
check('trailing whitespace on a file line is forgiven',
  cut('a\n   hello   \nb', 'hello') === '   hello   ')

console.log('\n\x1b[1mA trailing newline is preserved\x1b[0m')
const withNl = cut(FILE, 'const speed = Math.hypot(vel.x, vel.z);\n')
check('a needle ending in \\n consumes the file newline too',
  withNl !== null && withNl.endsWith('\n'),
  'without this the replacement joins two lines together')
check('a needle with no trailing \\n does not consume one',
  !cut(FILE, 'const speed = Math.hypot(vel.x, vel.z);').endsWith('\n'))

console.log('\n\x1b[1mWhat it must REFUSE\x1b[0m')
check('an ambiguous match returns null rather than picking one',
  fuzzyRange('  x = 1;\nfoo\n     x = 1;\n', 'x = 1;') === null,
  'two candidates is the model\'s ambiguity to resolve, not ours to guess')
check('a non-whitespace difference is NOT forgiven',
  fuzzyRange(FILE, 'const speed = Math.hypot(vel.x, vel.y);') === null,
  'only whitespace may differ — every other character must match')
check('an all-blank needle matches nothing',
  fuzzyRange('a\n\n\n\nb', '\n\n') === null,
  'it would match any run of blank lines')
check('text genuinely absent is still absent',
  fuzzyRange(FILE, 'launchRocket();') === null)
check('a needle longer than the file is refused',
  fuzzyRange('one line', 'one line\ntwo line\nthree') === null)

console.log('\n\x1b[1mThe error points somewhere useful\x1b[0m')
const near = nearestLine(FILE, 'const speed = Math.hypot(vel.x, vel.y);')
check('a near miss names the closest line', typeof near === 'string' && /line 2:/.test(near), String(near))
check('and quotes what is actually there', /Math\.hypot\(vel\.x, vel\.z\)/.test(near ?? ''), String(near))
check('nothing similar yields no false lead',
  nearestLine('alpha\nbeta\ngamma', 'zzzzzzzzzzzzzzzz') === null)
check('a too-short needle is not guessed at', nearestLine(FILE, 'x') === null)

console.log(failed === 0 ? '\n\x1b[32mall edit-match checks passed\x1b[0m\n' : `\n\x1b[31m${failed} failed\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
