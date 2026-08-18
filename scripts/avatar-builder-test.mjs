#!/usr/bin/env node
/**
 * Checks the avatar build orchestration.
 *
 * A build is ten to twelve minutes of GPU, so the behaviour that matters is
 * what happens when it does NOT go cleanly — and that is exactly what nobody
 * exercises by hand, because reproducing it costs a quarter of an hour each
 * time. The CLI is faked here; the real invocations were verified separately by
 * building a face through comfy-image by hand.
 *
 * The three rules worth guarding:
 *   - it saves after every step, so a failure at frame six still leaves five
 *   - one dead frame is skipped, not fatal, because the stage degrades
 *   - cancelling keeps what already landed
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-avb-'))
await writeFile(join(dir, 'e.ts'),
  `export { AvatarBuilder } from '${ROOT}/src/main/live/avatar-builder'
   export { AvatarStore } from '${ROOT}/src/main/store/avatars'
   export { AVATAR_FRAME_SPECS } from '${ROOT}/src/shared/avatar'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), '@main': join(ROOT, 'src/main'), electron: shim } })
const { AvatarBuilder, AvatarStore, AVATAR_FRAME_SPECS } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
    (note ? `  \x1b[2m${note}\x1b[0m` : ''))
}

/** A fake comfy-image CLI that writes real files, so the store's existsSync
 *  check passes and the path-parsing is exercised for real. */
function fakeCli(box, { failOn = null, onCall = () => {} } = {}) {
  let n = 0
  return async (argv) => {
    n++
    onCall(n)
    if (failOn !== null && n === failOn) return 'Nothing was rendered.\n'
    const path = join(box, `f${n}.png`)
    await writeFile(path, 'x')
    // Exactly the shape the real CLI prints, including the surrounding noise.
    return `Generated in 91s\nFile name: f${n}.png\nFull path: ${path}\n`
  }
}

const mk = async (opts = {}) => {
  const box = await mkdtemp(join(tmpdir(), 'lh-avbox-'))
  const store = new AvatarStore(box)
  const steps = []
  const builder = new AvatarBuilder({
    run: fakeCli(box, opts),
    store,
    onProgress: (p) => steps.push(p),
    onLog: () => {}
  })
  return { box, store, steps, builder }
}

console.log('\n\x1b[1mAvatar builder\x1b[0m\n')

/* ---- the clean path ---- */
{
  const { store, steps, builder } = await mk()
  const avatar = await builder.build({ name: 'Ada', description: 'a woman', includeExtras: true })
  check('a full build returns an avatar', avatar !== null)
  check('every frame in the recipe is produced',
    Object.keys(avatar.frames).length === AVATAR_FRAME_SPECS.length + 1,
    `${Object.keys(avatar.frames).length} frames`)
  check('rest is always present', typeof avatar.frames.rest === 'string')
  check('it is persisted, not just returned', store.get(avatar.id) !== null)
  check('the last step reports done', steps.at(-1).status === 'done')
  check('progress counts the base render too',
    steps[0].total === AVATAR_FRAME_SPECS.length + 1, `total ${steps[0].total}`)
  check('the name is carried through', avatar.name === 'Ada')
}

/* ---- saved incrementally ---- */
{
  const { store, builder } = await mk({ onCall: () => {} })
  const partial = []
  const p = builder.build({ name: 'Mid', description: 'x', includeExtras: false })
  // Sample the store while it runs; a build that only wrote at the end would
  // show nothing here.
  const sampler = setInterval(() => partial.push(store.list().length), 1)
  await p
  clearInterval(sampler)
  check('the avatar exists in the store before the build finishes',
    partial.some((n) => n > 0), 'otherwise a crash at frame six loses everything')
}

/* ---- one dead frame ---- */
{
  // Call 3 is the second edit; make it return no image.
  const { builder } = await mk({ failOn: 3 })
  const avatar = await builder.build({ name: 'Gap', description: 'x', includeExtras: false })
  check('a frame that fails to render is skipped, not fatal', avatar !== null)
  check('the rest of the set still builds',
    Object.keys(avatar.frames).length >= 3, `${Object.keys(avatar.frames).length} frames`)
}

/* ---- the base failing IS fatal, because there is no face ---- */
{
  const { store, builder } = await mk({ failOn: 1 })
  const avatar = await builder.build({ name: 'None', description: 'x', includeExtras: false })
  check('a failed base portrait yields no avatar', avatar === null)
  check('and nothing is saved', store.list().length === 0,
    'an avatar with no rest frame has no face to show')
}

/* ---- cancelling ---- */
{
  const { builder, steps } = await mk({ onCall: (n) => { if (n === 2) builder.cancel() } })
  const avatar = await builder.build({ name: 'Stop', description: 'x', includeExtras: true })
  check('cancelling keeps what already landed', avatar !== null &&
    typeof avatar.frames.rest === 'string')
  check('cancelling stops early',
    Object.keys(avatar.frames).length < AVATAR_FRAME_SPECS.length + 1,
    `${Object.keys(avatar.frames).length} frames`)
  check('the cancel is reported', steps.some((s) => s.status === 'cancelled'))
}

/* ---- one at a time ---- */
{
  const { builder } = await mk()
  const first = builder.build({ name: 'A', description: 'x', includeExtras: false })
  const second = await builder.build({ name: 'B', description: 'x', includeExtras: false })
  check('a second concurrent build is refused', second === null,
    'two builds would fight over one GPU and interleave their frames')
  await first
}

/* ---- the CLI itself failing ---- */
{
  const box = await mkdtemp(join(tmpdir(), 'lh-avbox-'))
  const builder = new AvatarBuilder({
    run: async () => {
      throw new Error('spawn comfy-image ENOENT')
    },
    store: new AvatarStore(box),
    onProgress: () => {},
    onLog: () => {}
  })
  const avatar = await builder.build({ name: 'X', description: 'x', includeExtras: false })
  check('a missing or broken CLI fails cleanly rather than throwing', avatar === null)
  await rm(box, { recursive: true, force: true })
}

await rm(dir, { recursive: true, force: true })
console.log(fail === 0 ? '\n\x1b[32mall avatar-builder checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} avatar-builder check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
