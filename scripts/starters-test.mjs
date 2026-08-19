#!/usr/bin/env node
/**
 * Checks the generated starter grammars for Image and Audio.
 *
 * Three things are easy to get wrong here and invisible once shipped.
 *
 * A grammar assembles text from fragments, so a missing separator or a stray
 * comma produces a suggestion that reads as broken but still works — nobody
 * files a bug, the empty state just looks cheap. Every template is rendered,
 * rather than spot-checking a sample that might miss the one bad branch.
 *
 * Both workflows GENERATE. A starter referring to a previous result is a dead
 * end on an empty state, and for Audio it is worse than that: there is no
 * audio-to-audio path in this stack at all, so "the same but slower" promises
 * something the tool cannot do.
 *
 * And range is the whole point of generating these rather than listing seven.
 * A length check cannot see it — three photographs pass it as long as one is
 * wordier — so each workflow declares the kinds it should be offering and every
 * one has to actually show up.
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'lh-starters-'))
await writeFile(join(dir, 'e.ts'), `
export { randomImagePrompts, imagePromptSpaceSize, imagePromptSamples } from '${ROOT}/src/shared/image-prompts'
export { randomAudioPrompts, audioPromptSpaceSize, audioPromptSamples } from '${ROOT}/src/shared/audio-prompts'
export { STARTER_GENERATORS } from '${ROOT}/src/shared/starters'
export { WORKFLOWS, WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'
export const app={getPath:()=>tmpdir(),getVersion:()=>'0'}
export default {app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },  format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim } })
const M = await import(pathToFileURL(out).href)

let fail = 0
const check = (name, ok, note = '') => {
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
    (note ? `  \x1b[2m${note}\x1b[0m` : ''))
}

/* Anything pointing at a result that does not exist yet. */
const BACKREF = /\b(edit|re-?render|the last (image|one|take)|previous (image|take)|same (subject|brief)|that image|this image|this paragraph|redo)\b/i

const SUITES = [
  {
    id: 'image',
    label: 'Image starters',
    random: M.randomImagePrompts,
    size: M.imagePromptSpaceSize,
    samples: M.imagePromptSamples,
    minShort: 5000,
    kinds: {
      photograph: /\bat sunset\b|\bin the rain\b|foggy|golden afternoon|black and white|first light|A photo of|street scene|shot from above|window light|stormy sky|full moon|long shadows/i,
      'drawn / illustrated': /\bDraw\b|watercolour|cartoon|pencil sketch|cut-paper|pixel art|childrens book|chalk drawing|marker lines|stamp print|pastels|stained glass|comic|embroidery|claymation|linocut|screen print|doodle|woodcut|neon sign|risograph|mosaic|ink style|knitted/i,
      'cards / occasions': /\bcard\b|save the date|invitation/i,
      'design work': /\blogo\b|poster|sign|business card|tote|enamel pin|menu|sticker|t-shirt|matchbox|cup sleeve|livery|book cover|album cover|bookmark|beer label|jam jar|badge|awning|keyring|mug design|wrapping paper/i,
      'abstract / pattern': /abstract|repeating pattern|A design for/i,
      '3D / isometric': /isometric|clay model|low-poly|paper craft|diorama|cutaway|felt model|wooden toy|model village/i,
      characters: /character design sheet|Design a character|mascot|Ghibli|comic book panel|pixel art sprite|wooden puppet|plush toy|paper doll/i
    }
  },
  {
    id: 'audio',
    label: 'Audio starters',
    random: M.randomAudioPrompts,
    size: M.audioPromptSpaceSize,
    samples: M.audioPromptSamples,
    minShort: 3000,
    kinds: {
      songs: /A song about|song about|track,|Something (hopeful|melancholy|triumphant|restless|sleepy|tense|warm|lonely|playful|defiant|wistful|urgent|unbothered|menacing|tender|giddy)|instrumental/i,
      'loops and beds': /A loop for|bed for/i,
      /* Detected by their lead-in rather than by listing their vocabulary.
         The list version silently undercounted the moment new entries were
         added, which read as "this family is too rare" when it was not. */
      'sound effects': /^The sound of /i,
      ambience: /^Ambience: /i,
      'stings and UI': /^A short sound: /i,
      cinematic: /Music for /i
    },
    /* This workflow is mostly for music. A screen of door slams would be
       accurate about what it can do and wrong about what it is for.
       Measured as the complement of the three non-musical prefixes rather than
       by listing musical phrasings — a genre-led line like "Gqom, with a brass
       section" is obviously music and matched no keyword, which understated
       the share by twenty points. */
    musicShare: { notRe: /^(The sound of |Ambience: |A short sound: )/i, min: 0.6 }
  }
]

for (const suite of SUITES) {
  const total = suite.size()
  const short = suite.size('simple')
  console.log(`\n\x1b[1m${suite.label}\x1b[0m  ${total.toLocaleString()} distinct ideas` +
    ` \x1b[2m(${short.toLocaleString()} of them short)\x1b[0m\n`)

  check('the space is in the thousands', total >= 1000, total.toLocaleString())
  // Every hand carries one short line, so this pool -- not the total -- decides
  // how soon a repeat is actually seen.
  check('the SHORT pool is large enough not to repeat quickly', short >= suite.minShort,
    short.toLocaleString())

  const draws = []
  for (let i = 0; i < 4000; i++) draws.push(...suite.random(3))
  const all = [...draws, ...suite.samples()]

  const back = all.filter((s) => BACKREF.test(s))
  check('nothing points at a previous result', back.length === 0, back[0] ?? '')
  const pool = M.WORKFLOW_BY_ID[suite.id].suggestions
  check('the fixed fallback pool is clean too', !pool.some((s) => BACKREF.test(s)),
    pool.find((s) => BACKREF.test(s)) ?? '')
  check('the workflow is wired to a generator',
    typeof M.STARTER_GENERATORS[suite.id] === 'function')

  const bad = (re, label) => {
    const hit = all.find((s) => re.test(s))
    check(label, hit === undefined, hit ?? '')
  }
  bad(/ {2}/, 'no doubled spaces')
  bad(/,\s*,/, 'no doubled commas')
  bad(/\s,/, 'no space before a comma')
  bad(/\.\./, 'no doubled full stops')
  bad(/[,-]\s*$/, 'none ends on a comma or dash')
  bad(/^\s|\s$/, 'no leading or trailing whitespace')
  // Only "a" before a vowel SOUND is wrong; "an observatory" is right. 'u' and
  // "one" are excluded because both are spoken as consonants — "a unicorn",
  // "a one-minute song".
  bad(/\ba\s+(?!one\b|once\b)[aeio]\w/i, 'no "a apple" style article slips')
  check('every idea starts with a capital', all.every((s) => /^[A-Z]/.test(s)),
    all.find((s) => !/^[A-Z]/.test(s)) ?? '')

  const trios = Array.from({ length: 500 }, () => suite.random(3))
  check('a trio always has three', trios.every((t) => t.length === 3))
  check('a trio never repeats a line', trios.every((t) => new Set(t).size === t.length))

  const kindPool = []
  for (let i = 0; i < 1200; i++) kindPool.push(...suite.random(3))
  for (const [kind, re] of Object.entries(suite.kinds)) {
    const share = kindPool.filter((s) => re.test(s)).length / kindPool.length
    check(`${kind} shows up often enough to be seen`, share > 0.03,
      `${(share * 100).toFixed(1)}% of draws`)
  }
  if (suite.musicShare) {
    const share =
      kindPool.filter((s) => !suite.musicShare.notRe.test(s)).length / kindPool.length
    check('music is the bulk of it', share >= suite.musicShare.min,
      `${(share * 100).toFixed(1)}% of draws are musical`)
  }

  /* Repeats, measured as they are actually experienced. A flat "are N draws
     unique" number cannot pass by construction: every hand carries one short
     line, and there are far fewer short lines than total ideas. Forty visits is
     a heavy day. */
  const VISITS = 40
  let sessionsWithRepeat = 0
  for (let s = 0; s < 2000; s++) {
    const seen = new Set()
    let repeated = false
    for (let v = 0; v < VISITS; v++) {
      for (const line of suite.random(3)) {
        if (seen.has(line)) repeated = true
        seen.add(line)
      }
    }
    if (repeated) sessionsWithRepeat++
  }
  const rate = sessionsWithRepeat / 2000
  check(`a repeat is rare across ${VISITS} visits in a row`, rate < 0.25,
    `${(rate * 100).toFixed(1)}% of ${VISITS}-visit runs saw one`)

  console.log('\n\x1b[2m  three, as dealt:\x1b[0m')
  for (const s of suite.random(3)) console.log(`   \x1b[2m·\x1b[0m ${s}`)
}

/* The bug this guards against cost a morning: a generator was put ON the
   workflow definition. That object is sent to the renderer by structured clone
   in `app:getBootstrap`, structured clone cannot carry a function, and the
   handler threw "An object could not be cloned" — so the app sat on its splash
   screen forever with nothing on screen to say why. Typecheck and build were
   both clean, because it is a runtime constraint on the shape, not a type. */
console.log()
let cloneError = null
try {
  structuredClone(M.WORKFLOWS)
} catch (e) {
  cloneError = e.message
}
check('every workflow definition survives structuredClone', cloneError === null,
  cloneError ?? 'they cross IPC in app:getBootstrap')

console.log(fail === 0 ? '\n\x1b[32mall starter checks passed\x1b[0m\n'
  : `\n\x1b[31m${fail} starter check(s) failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
