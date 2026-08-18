#!/usr/bin/env node
/**
 * Checks the Image workflow's starter grammar.
 *
 * Two things are easy to get wrong here and invisible once shipped. A grammar
 * assembles text from fragments, so a missing separator or a stray comma
 * produces a prompt that reads as broken but still renders something — nobody
 * files a bug, the suggestions just look cheap. And the workflow generates
 * images; a starter that says "edit the last image" on an empty state points at
 * a render that does not exist and at a job the Edit workflow does properly.
 *
 * So: every template is rendered and inspected, rather than spot-checking a
 * random sample that might miss the one broken branch.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-imgprompt-'))
await writeFile(join(dir, 'e.ts'), `export { randomImagePrompts, imagePromptSpaceSize, imagePromptSamples, STARTER_GENERATORS } from '${ROOT}/src/shared/image-prompts'
export { WORKFLOWS, WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim } })
const { randomImagePrompts, imagePromptSpaceSize, imagePromptSamples, STARTER_GENERATORS,
        WORKFLOWS, WORKFLOW_BY_ID } = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
    (note ? `  \x1b[2m${note}\x1b[0m` : ''))
}

const size = imagePromptSpaceSize()
const simpleSize = imagePromptSpaceSize('simple')
console.log(`\n\x1b[1mImage starters\x1b[0m  ${size.toLocaleString()} distinct prompts` +
  ` \x1b[2m(${simpleSize.toLocaleString()} of them short)\x1b[0m\n`)

check('the space is in the thousands, as promised', size >= 1000, size.toLocaleString())
// Every hand is dealt at least one short line, so this pool -- not the total --
// decides how soon a repeat is actually seen.
check('the SHORT pool is large enough not to repeat quickly', simpleSize >= 5000,
  simpleSize.toLocaleString())

/* Draw a large sample AND render every template at its first choice, so a
   branch that is rarely picked cannot hide a formatting bug. */
const sample = []
for (let i = 0; i < 4000; i++) sample.push(...randomImagePrompts(3))
const all = [...sample, ...imagePromptSamples()]

/* This workflow GENERATES. Anything referring to a previous image is a dead
   end on an empty state. */
const EDITY = /\b(edit|re-?render|the last image|previous image|same subject|instead of the|that image|this image|redo)\b/i
const edity = all.filter((s) => EDITY.test(s))
check('nothing refers to editing a previous image', edity.length === 0, edity[0] ?? '')
check('the fixed fallback pool is generation-only',
  !WORKFLOW_BY_ID.image.suggestions.some((s) => EDITY.test(s)),
  WORKFLOW_BY_ID.image.suggestions.find((s) => EDITY.test(s)) ?? '')
check('the Image workflow actually uses the generator',
  typeof STARTER_GENERATORS.image === 'function')

/* The bug this guards against, which cost a morning: a generator was put ON the
   workflow definition. That object is sent to the renderer by structured clone
   in `app:getBootstrap`, structured clone cannot carry a function, and the
   handler threw "An object could not be cloned" — so the app sat on its splash
   screen forever with nothing on screen to say why. Typecheck and build were
   both clean, because it is a runtime constraint on the shape, not a type. */
let cloneError = null
try {
  structuredClone(WORKFLOWS)
} catch (e) {
  cloneError = e.message
}
check('every workflow definition survives structuredClone', cloneError === null,
  cloneError ?? 'they cross IPC in app:getBootstrap')

/* Assembly faults. */
const bad = (re, label) => {
  const hit = all.find((s) => re.test(s))
  check(label, hit === undefined, hit ?? '')
}
bad(/ {2}/, 'no doubled spaces')
bad(/,\s*,/, 'no doubled commas')
bad(/\s,/, 'no space before a comma')
bad(/\.\./, 'no doubled full stops')
bad(/,\s*$/, 'none ends on a comma')
bad(/^\s|\s$/, 'no leading or trailing whitespace')
// Only "a" before a vowel is wrong; "an observatory" is right, and the old
// form of this check flagged it. 'u' is excluded because it is usually spoken
// as a consonant ("a unicorn", "a used camera").
bad(/\ba\s+[aeio]\w/i, 'no "a apple" style article slips')
check('every prompt starts with a capital', all.every((s) => /^[A-Z]/.test(s)),
  all.find((s) => !/^[A-Z]/.test(s)) ?? '')

/* Shape of a dealt hand. */
const trios = Array.from({ length: 500 }, () => randomImagePrompts(3))
check('a trio always has three', trios.every((t) => t.length === 3))
check('a trio never repeats a line', trios.every((t) => new Set(t).size === t.length))

/* Range of KIND, which is the actual requirement.
 *
 * This replaced a check on line length, which was the wrong measure twice over:
 * it passed for a page of three photographs as long as one was wordier, and it
 * failed for three genuinely different ideas that happened to be about as long
 * as each other. What matters is that the suggestions do not all come from one
 * corner of what the renderer can do — a screen of camera work implies it only
 * does camera work. */
const KINDS = {
  photograph: /\bat sunset\b|\bin the rain\b|foggy|golden afternoon|black and white|first light|A photo of|street scene|shot from above|window light|stormy sky|full moon|long shadows/i,
  'drawn / illustrated': /\bDraw\b|watercolour|cartoon|pencil sketch|cut-paper|pixel art|childrens book|chalk drawing|marker lines|stamp print|pastels|stained glass|comic|embroidery|claymation|linocut|screen print|doodle|woodcut|neon sign|risograph|mosaic|ink style|knitted/i,
  'cards / occasions': /\bcard\b|save the date|invitation/i,
  'design work': /\blogo\b|poster|sign|business card|tote|enamel pin|menu|sticker|t-shirt|matchbox|cup sleeve|livery|book cover|album cover|bookmark|beer label|jam jar|badge|awning|keyring|mug design|wrapping paper/i,
  'abstract / pattern': /abstract|repeating pattern|A design for/i,
  '3D / isometric': /isometric|clay model|low-poly|paper craft|diorama|cutaway|felt model|wooden toy|model village/i,
  characters: /character design sheet|Design a character|mascot|Ghibli|comic book panel/i
}
const pool = []
for (let i = 0; i < 1200; i++) pool.push(...randomImagePrompts(3))
for (const [kind, re] of Object.entries(KINDS)) {
  const share = pool.filter((s) => re.test(s)).length / pool.length
  check(`${kind} shows up often enough to be seen`, share > 0.03,
    `${(share * 100).toFixed(1)}% of draws`)
}

/* Variety, measured as it is actually experienced.
 *
 * A flat "are 12,000 draws unique" number is the wrong question and cannot pass
 * by construction: every hand contains one short line, and there are far fewer
 * short lines than total prompts, so collisions concentrate there no matter how
 * large the grammar is. What matters is whether a repeat shows up during a
 * realistic run of visits. Forty is a heavy day. */
const VISITS = 40
let sessionsWithRepeat = 0
for (let s = 0; s < 2000; s++) {
  const seen = new Set()
  let repeated = false
  for (let v = 0; v < VISITS; v++) {
    for (const line of randomImagePrompts(3)) {
      if (seen.has(line)) repeated = true
      seen.add(line)
    }
  }
  if (repeated) sessionsWithRepeat++
}
const rate = sessionsWithRepeat / 2000
check(`a repeat is rare across ${VISITS} visits in a row`, rate < 0.25,
  `${(rate * 100).toFixed(1)}% of ${VISITS}-visit runs saw one`)

const uniq = new Set(sample).size
console.log(`  \x1b[2m     ${uniq.toLocaleString()} distinct lines across ` +
  `${sample.length.toLocaleString()} draws\x1b[0m`)

console.log('\n\x1b[2m  three, as dealt:\x1b[0m')
for (const s of randomImagePrompts(3)) console.log(`   \x1b[2m·\x1b[0m ${s}`)

console.log(fail === 0 ? '\n\x1b[32mall image-starter checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} image-starter check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
