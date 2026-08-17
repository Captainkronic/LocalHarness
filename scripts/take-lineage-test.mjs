#!/usr/bin/env node
/**
 * Checks the take-to-take diff that makes audio refinement legible.
 *
 * A song cannot be edited, only rendered again, so the diff between two
 * parameter sets is the ONLY thing connecting take 2 to take 1. If it is wrong
 * the panel quietly misdescribes what changed, which is worse than showing
 * nothing — the user would tune the wrong lever on take 3.
 *
 * The seed cases matter most. With this model a held seed does NOT preserve the
 * song, so "seed held" has to be said out loud on every diff or the comparison
 * reads as a surgical edit.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-take-'))
await writeFile(join(dir, 'e.ts'), `export { describeTakeDiff } from '${ROOT}/src/main/orchestrator'\n`)
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
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { describeTakeDiff } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}

/** The real thing the server returns, so the seed regex is tested as shipped. */
const SEED_LINE =
  '/Users/adam/Documents/llm-audio/lofi.mp3\n' +
  '20s instrumental · 80 bpm · C minor · seed 1834729382 · ACE-Step 1.5 turbo, 1.4 MB, rendered in 1m 22s.'
const seedOf = (text) => /\bseed (\d+)/.exec(text ?? '')?.[1]
check('seed parses out of the server prose', seedOf(SEED_LINE) === '1834729382', seedOf(SEED_LINE))
check('no seed in prose yields undefined', seedOf('Created /tmp/x.mp3') === undefined)

const t1 = { tags: 'lo-fi hip hop, piano', bpm: 80, key: 'C minor', seed: '1834729382', voice: 'instrumental' }

/* ---- one lever moved, seed held: the ordinary refinement ---- */
const swap = describeTakeDiff(t1, { ...t1, tags: 'lo-fi hip hop, Rhodes' })
check('names the changed lever', /tags/.test(swap ?? ''), swap ?? '(null)')
check('shows both sides of the change', /piano/.test(swap ?? '') && /Rhodes/.test(swap ?? ''))
check('says the seed was HELD', /seed held/.test(swap ?? ''),
  'with this model a held seed does not preserve the song, so it must be stated')

/* ---- new seed, same brief: the reliable "another take" ---- */
const reroll = describeTakeDiff(t1, { ...t1, tags: 'lo-fi hip hop, Rhodes', seed: '99' })
check('says NEW seed when it moved', /new seed/.test(reroll ?? ''), reroll ?? '(null)')

/* ---- nothing moved ---- */
check('identical takes produce no diff', describeTakeDiff(t1, { ...t1 }) === null)

/* ---- added and dropped parameters ---- */
const added = describeTakeDiff(t1, { ...t1, language: 'en' })
check('an added parameter is named', /language set to en/.test(added ?? ''), added ?? '(null)')
const dropped = describeTakeDiff({ ...t1, language: 'en' }, t1)
check('a dropped parameter is named', /language dropped/.test(dropped ?? ''), dropped ?? '(null)')

/* ---- several levers at once still reports all of them ---- */
const many = describeTakeDiff(t1, { ...t1, bpm: 96, key: 'A minor' })
check('multiple changes are all listed', /bpm/.test(many ?? '') && /key/.test(many ?? ''), many ?? '')

/* ---- long tag strings must not blow out the row ---- */
const longTags = 'a'.repeat(200)
const long = describeTakeDiff(t1, { ...t1, tags: longTags })
check('long values are truncated', (long ?? '').length < 140 && /…/.test(long ?? ''), `${(long ?? '').length} chars`)

/* ---- the previous take having no seed must not claim it was held ---- */
const noSeedBefore = describeTakeDiff({ tags: 'x' }, { tags: 'y', seed: '5' })
check('an absent previous seed is not reported as held', !/seed held/.test(noSeedBefore ?? ''), noSeedBefore ?? '')

/* ---- 'changed' from a previous take must not diff into the next ---- */
const carried = describeTakeDiff({ ...t1, changed: 'tags a -> b · seed held' }, { ...t1 })
check('the previous diff is not itself diffed', carried === null, carried ?? '(null)')

await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall take-lineage checks passed\x1b[0m\n' : `\n\x1b[31m${fail} failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
