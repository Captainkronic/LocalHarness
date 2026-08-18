#!/usr/bin/env node
/**
 * Checks that the gallery survives a restart.
 *
 * The panel used to be backed by a Map on the orchestrator, so every quit
 * emptied it — the rendered files were still on disk, just no longer findable
 * from the app. That is the bug this store exists to fix, and "it persists" is
 * exactly the kind of claim that is easy to assume and never verify, because it
 * only fails on the second run.
 *
 * So every check below constructs a SECOND store over the same directory. A
 * test that only ever reads back from the instance that did the writing would
 * pass against the old in-memory version too.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-artifacts-'))
await writeFile(join(dir, 'e.ts'),
  `export { ArtifactStore } from '${ROOT}/src/main/store/artifacts'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { ArtifactStore } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
    (note ? `  \x1b[2m${note}\x1b[0m` : ''))
}

const box = await mkdtemp(join(tmpdir(), 'lh-gallery-'))
const files = join(box, 'files')
await mkdir(files, { recursive: true })

const made = async (name) => {
  const p = join(files, name)
  await writeFile(p, 'x')
  return p
}
const art = (id, path, extra = {}) => ({
  id, kind: 'image', label: id, path, createdAt: Date.now(), ...extra
})

console.log('\n\x1b[1mGallery persistence\x1b[0m\n')

const a = await made('a.png')
const b = await made('b.png')
const song = await made('song.wav')

const first = new ArtifactStore(box)
first.add('image', art('a', a))
first.add('image', art('b', b))
first.add('audio', { ...art('s', song), kind: 'audio' })

// The whole point: a NEW instance, as if the app had quit and come back.
const second = new ArtifactStore(box)
check('artifacts come back after a restart', second.list('image').length === 2,
  `${second.list('image').length} of 2`)
check('newest is still first', second.list('image')[0].id === 'b',
  second.list('image')[0]?.id)
check('workflows stay separate', second.list('audio').length === 1 &&
  second.list('audio')[0].id === 's')
check('an unknown workflow is empty, not undefined',
  Array.isArray(second.list('code')) && second.list('code').length === 0)
check('the path survives', second.list('image')[0].path === b)

/* Growth across sessions is the actual request — each run must add to the
   record rather than replace it. */
second.add('image', art('c', await made('c.png')))
const third = new ArtifactStore(box)
check('a later session ADDS to the history', third.list('image').length === 3,
  `${third.list('image').length} of 3`)

/* Re-emitting the same artifact must not double it. */
third.add('image', art('c', join(files, 'c.png')))
const fourth = new ArtifactStore(box)
check('re-adding the same id does not duplicate', fourth.list('image').length === 3,
  `${fourth.list('image').length} of 3`)
check('a re-added artifact moves to the front', fourth.list('image')[0].id === 'c')

/* A file the user deleted should not leave a row that fails when clicked. */
await rm(join(files, 'b.png'))
const fifth = new ArtifactStore(box)
check('an entry whose file is gone is dropped', fifth.list('image').length === 2,
  `${fifth.list('image').length} of 2`)
check('the drop is counted, not silent', fifth.takePrunedCount() === 1)
check('the count resets once read', fifth.takePrunedCount() === 0)
check('surviving entries are untouched',
  fifth.list('image').map((x) => x.id).sort().join(',') === 'a,c')

/* Metadata the audio panel depends on for take lineage. */
const meta = new ArtifactStore(box)
meta.add('audio', { ...art('t2', song), kind: 'audio', parentId: 't1',
  meta: { seed: 1234, tags: 'lo-fi, piano' } })
const reread = new ArtifactStore(box).list('audio').find((x) => x.id === 't2')
check('parentId survives, so take lineage is not lost', reread?.parentId === 't1')
check('meta survives', reread?.meta?.seed === 1234 && reread?.meta?.tags === 'lo-fi, piano')

/* A corrupt or hand-edited file must not take the app down on boot. */
await writeFile(join(box, 'artifacts.json'), '{ this is not json')
let threw = null
try {
  new ArtifactStore(box)
} catch (e) {
  threw = e.message
}
check('a corrupt file boots as an empty gallery, not a crash', threw === null, threw ?? '')

await rm(box, { recursive: true, force: true })
await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall gallery checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} gallery check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
