#!/usr/bin/env node
/**
 * Checks that skill folders are readable and still unwritable.
 *
 * This widens the sandbox, so it is exactly the change that needs its boundary
 * pinned. A skill ships references and templates and tells the model to open
 * them, so reads have to reach outside the workspace — but the agent has no
 * business editing the instructions it was handed, and nothing else may leak
 * through the wider door either.
 */
import { build } from 'esbuild'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = '/Users/adam/LocalHarness'
const box = await mkdtemp(join(tmpdir(), 'lh-skillroot-'))
const workspace = join(box, 'workspace')
const skill = join(box, 'skills', 'web-game-dev')
const outside = join(box, 'elsewhere')
await mkdir(join(skill, 'templates'), { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(outside, { recursive: true })
await writeFile(join(workspace, 'app.ts'), 'export const x = 1\n')
await writeFile(join(skill, 'SKILL.md'), '---\nname: web-game-dev\ndescription: d\n---\nbody\n')
await writeFile(join(skill, 'templates', 'engine.js'), '// engine template\n')
await writeFile(join(outside, 'secret.txt'), 'TOP SECRET\n')

const dir = await mkdtemp(join(tmpdir(), 'lh-sr-'))
await writeFile(join(dir, 'e.ts'),
  `export { ToolExecutor } from '${ROOT}/src/main/agent/executor'
   export { DEFAULT_SETTINGS } from '${ROOT}/src/main/store/settings'
   export { WORKFLOWS } from '${ROOT}/src/shared/workflows'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { ToolExecutor, DEFAULT_SETTINGS, WORKFLOWS } = await import(pathToFileURL(out).href)

const settings = { ...DEFAULT_SETTINGS, workspaceRoots: [workspace], approvalMode: 'auto' }
let skillsEnabled = true
const exec = new ToolExecutor({
  getSettings: () => settings,
    // ApprovalDecision is a bare string union, not an object.
  requestApproval: async () => 'allow_session',
  onLog: () => {},
  readOnlyRoots: () => (skillsEnabled ? [skill] : [])
})

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}
/**
 * ToolResult is { text, artifacts, isError } — `isError` is the verdict, not the
 * shape of the string. Reading the wrong field here once made every refusal
 * score as a success and briefly looked like a hole in the sandbox.
 */
const call = async (tool, args) => {
  try {
    const r = await exec.execute(tool, args, 'conv')
    return { ok: r.isError !== true, text: String(r.text ?? '') }
  } catch (err) {
    return { ok: false, text: String(err?.message ?? err) }
  }
}

console.log('\n\x1b[1mSkill folders: readable, never writable\x1b[0m\n')

const r1 = await call('read_file', { path: join(skill, 'templates', 'engine.js') })
check('read_file reaches a skill template', r1.ok && r1.text.includes('engine template'), r1.ok ? '' : r1.text.slice(0, 90))

const r2 = await call('read_file', { path: join(skill, 'SKILL.md') })
check('read_file reaches SKILL.md', r2.ok, r2.ok ? '' : r2.text.slice(0, 90))

const r3 = await call('list_dir', { path: skill })
check('list_dir reaches a skill folder', r3.ok, r3.ok ? '' : r3.text.slice(0, 90))

const r4 = await call('read_file', { path: join(workspace, 'app.ts') })
check('workspace reads still work', r4.ok, r4.ok ? '' : r4.text.slice(0, 90))

/* ---- the boundary ---- */
const w1 = await call('write_file', { path: join(skill, 'templates', 'engine.js'), content: 'PWNED' })
check('write_file into a skill is REFUSED', !w1.ok, w1.ok ? 'WROTE IT' : '')

const w2 = await call('write_file', { path: join(skill, 'new.txt'), content: 'x' })
check('creating a file in a skill is REFUSED', !w2.ok, w2.ok ? 'WROTE IT' : '')

const w3 = await call('edit_file', { path: join(skill, 'SKILL.md'), old_string: 'body', new_string: 'evil' })
check('edit_file on SKILL.md is REFUSED', !w3.ok, w3.ok ? 'EDITED IT' : '')

const o1 = await call('read_file', { path: join(outside, 'secret.txt') })
check('reading outside every root is still REFUSED', !o1.ok, o1.ok ? 'READ IT' : '')

const o2 = await call('read_file', { path: join(skill, '..', '..', 'elsewhere', 'secret.txt') })
check('.. out of a skill folder is REFUSED', !o2.ok, o2.ok ? 'READ IT' : '')

skillsEnabled = false
const d1 = await call('read_file', { path: join(skill, 'SKILL.md') })
check('a DISABLED skill is not readable', !d1.ok, d1.ok ? 'READ IT' : '')

/* Every skill a workflow names must actually be on disk.
 *
 * `skills: [...]` is a filter over discovered skills, so a typo is not an error
 * — the name simply matches nothing, the panel shows one fewer toggle, and the
 * model is never told that craft exists. Silent, and easy to miss when a
 * workflow lists five. Checked against the canonical root; sync-skills.sh
 * copies from there to the other harnesses. */
const skillRoot = join(homedir(), '.claude', 'skills')
const onDisk = new Set(
  (await readdir(skillRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
)
for (const wf of WORKFLOWS) {
  for (const name of wf.skills ?? []) {
    check(`${wf.id} names a skill that exists: ${name}`, onDisk.has(name),
      onDisk.has(name) ? '' : `not in ${skillRoot}`)
  }
}

await rm(box, { recursive: true, force: true })
await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall skill-root checks passed\x1b[0m\n' : `\n\x1b[31m${fail} failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
