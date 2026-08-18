#!/usr/bin/env node
/**
 * Checks the persisted right-hand panel size.
 *
 * The hazard here is specific and unrecoverable from inside the app: settings
 * are a hand-editable file that survives upgrades, so a width of 5 would reach
 * the layout and leave a panel too narrow to grab and drag back. Clamping is
 * what makes the control safe to expose at all, and clamping is exactly the
 * kind of thing that is written once and never exercised.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-panel-'))
await writeFile(join(dir, 'e.ts'),
  `export { mergeSettings, DEFAULT_SETTINGS } from '${ROOT}/src/main/store/settings'
   export { PANEL_W_MIN, PANEL_W_MAX, PANEL_W_DEFAULT, PANEL_W_COLLAPSED } from '${ROOT}/src/shared/types'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const M = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
    (note ? `  \x1b[2m${note}\x1b[0m` : ''))
}

const { PANEL_W_MIN, PANEL_W_MAX, PANEL_W_DEFAULT, PANEL_W_COLLAPSED } = M
const layout = (raw) => M.mergeSettings(M.DEFAULT_SETTINGS, { panelLayout: raw }).panelLayout

console.log(`\n\x1b[1mPanel layout\x1b[0m  ${PANEL_W_MIN}-${PANEL_W_MAX}px, ` +
  `default ${PANEL_W_DEFAULT}, collapsed strip ${PANEL_W_COLLAPSED}\n`)

check('a sane width is kept', layout({ gallery: { width: 480, collapsed: false } }).gallery.width === 480)
check('too narrow is clamped up, not dropped',
  layout({ gallery: { width: 5 } }).gallery.width === PANEL_W_MIN,
  'otherwise the panel cannot be grabbed to fix it')
check('too wide is clamped down',
  layout({ gallery: { width: 99999 } }).gallery.width === PANEL_W_MAX)
check('a non-numeric width falls back to the default',
  layout({ gallery: { width: 'wide' } }).gallery.width === PANEL_W_DEFAULT)
check('NaN falls back to the default',
  layout({ gallery: { width: Number.NaN } }).gallery.width === PANEL_W_DEFAULT)
check('a fractional width is rounded',
  Number.isInteger(layout({ gallery: { width: 412.7 } }).gallery.width))

check('collapsed survives', layout({ gallery: { width: 400, collapsed: true } }).gallery.collapsed === true)
check('collapsed defaults to false when absent',
  layout({ gallery: { width: 400 } }).gallery.collapsed === false)
check('a non-boolean collapsed is not truthy',
  layout({ gallery: { width: 400, collapsed: 'yes' } }).gallery.collapsed === false,
  'only a real true collapses a panel')

check('each kind is independent', (() => {
  const l = layout({ gallery: { width: 500 }, audio: { width: 300, collapsed: true } })
  return l.gallery.width === 500 && !l.gallery.collapsed &&
         l.audio.width === 300 && l.audio.collapsed === true
})(), 'a gallery is not a transcript rail')

check('a garbage entry is skipped, not fatal',
  Object.keys(layout({ gallery: 'nope', audio: { width: 400 } })).join() === 'audio')
check('a non-object panelLayout falls back to the default',
  JSON.stringify(M.mergeSettings(M.DEFAULT_SETTINGS, { panelLayout: 'nope' }).panelLayout) === '{}')
check('an absent panelLayout is an empty object, never undefined',
  JSON.stringify(M.mergeSettings(M.DEFAULT_SETTINGS, {}).panelLayout) === '{}')

check('the collapsed strip is wide enough to hold its own button',
  PANEL_W_COLLAPSED >= 24, `${PANEL_W_COLLAPSED}px`)
check('the default sits inside the bounds',
  PANEL_W_DEFAULT >= PANEL_W_MIN && PANEL_W_DEFAULT <= PANEL_W_MAX)

await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall panel-layout checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} panel-layout check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
