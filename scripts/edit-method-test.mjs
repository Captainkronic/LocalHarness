#!/usr/bin/env node
/**
 * Checks the rules that keep the two edit methods from lying about each other.
 *
 * "Edit" means two different things here. `instruction` hands the renderer the
 * photo as conditioning and your words as the change; `restyle` is img2img and
 * re-paints a noised copy against a description. They need different renderers,
 * different briefs, and different knobs — and every one of those is a place
 * where the wrong value would still produce an image, just the wrong one, with
 * a confident readout underneath it.
 *
 * The denoise rule is the one worth guarding hardest. It is meaningless to the
 * instruction path, so sending it would put a number on the finished card that
 * had nothing to do with the render — the exact species of quiet dishonesty the
 * seed handling was already fixed for once.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-editmethod-'))
await writeFile(join(dir, 'e.ts'), `export { renderArgs } from '${ROOT}/src/main/edit/pipeline'
export { EDIT_BRIEFS } from '${ROOT}/src/shared/workflows'
export { EDIT_METHOD_DEFAULTS } from '${ROOT}/src/shared/types'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export const BrowserWindow=class{}
export const ipcMain={handle(){},on(){}}
export const shell={openPath(){},showItemInFolder(){}}
export const dialog={}
export const globalShortcut={register(){},unregister(){}}
export const protocol={registerSchemesAsPrivileged(){},handle(){}}
export default {app,BrowserWindow,ipcMain,shell,dialog,globalShortcut,protocol}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },  format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { renderArgs, EDIT_BRIEFS, EDIT_METHOD_DEFAULTS } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  const mark = ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`  ${mark} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}

const job = (method, extra = {}) => ({
  id: 'j', sourcePath: '/tmp/p.png', sourceName: 'p.png', userInstruction: 'x',
  refinedPrompt: 'x', promptEdited: false, status: 'ready', createdAt: 0, updatedAt: 0,
  params: { method, denoise: 0.6, steps: EDIT_METHOD_DEFAULTS[method].steps, ...extra }
})

console.log('\n\x1b[1mEdit methods\x1b[0m\n')

const ins = renderArgs(job('instruction'), 'make the taxis pink')
const res = renderArgs(job('restyle'), 'a street with pink taxis')

check('instruction sends NO denoise', !('denoise' in ins), JSON.stringify(Object.keys(ins).sort()))
check('restyle DOES send denoise', res.denoise === 0.6)
check('the two methods ask for different models', ins.model !== res.model,
  `${ins.model} vs ${res.model}`)
check('instruction routes to the reference-latent model', ins.model === 'klein-edit', String(ins.model))
check('restyle routes to z-image', res.model === 'z-image', String(res.model))
check('both keep confirm:true', ins.confirm === true && res.confirm === true,
  'without it the server re-runs its own VLM over the prompt')
check('the prompt is passed through verbatim', ins.instruction === 'make the taxis pink')

const seeded = renderArgs(job('instruction', { seed: 1234 }), 'p')
check('a chosen seed is sent', seeded.seed === 1234)
check('an unset seed is omitted rather than guessed', !('seed' in ins))

check('each method carries its own step default',
  EDIT_METHOD_DEFAULTS.instruction.steps !== EDIT_METHOD_DEFAULTS.restyle.steps,
  `${EDIT_METHOD_DEFAULTS.instruction.steps} vs ${EDIT_METHOD_DEFAULTS.restyle.steps}`)

/* The briefs are the other half of the handoff. An instruction brief that asks
   for a scene description would sail through every check above and still ruin
   the render, so assert the shape of what each one asks for. */
check('the two briefs are actually different', EDIT_BRIEFS.instruction !== EDIT_BRIEFS.restyle)
check('the instruction brief forbids restating the scene',
  /restating the scene/i.test(EDIT_BRIEFS.instruction))
check('the instruction brief asks for one or two sentences',
  /one or two sentences/i.test(EDIT_BRIEFS.instruction))
check('the restyle brief asks for the FINISHED image',
  /describing the FINISHED image/.test(EDIT_BRIEFS.restyle))
check('the restyle brief warns what is left out is at risk',
  /at risk/i.test(EDIT_BRIEFS.restyle))
check('neither brief leaks a LaTeX arrow macro',
  !/\\rightarrow/.test(EDIT_BRIEFS.instruction + EDIT_BRIEFS.restyle))
check('neither brief contains a stray carriage return',
  !/\r/.test(EDIT_BRIEFS.instruction + EDIT_BRIEFS.restyle))

console.log(fail === 0 ? '\n\x1b[32mall edit-method checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} edit-method check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
