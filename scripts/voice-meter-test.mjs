#!/usr/bin/env node
/**
 * A meter must be wired to something that moves.
 *
 * LiveSessionStatus.level reads exactly like the microphone level and is
 * always 0: the level is measured in the RENDERER by the audio worklet, and
 * the main process never learns it. Two meters were built against it — the
 * panel orb and the composer's bars — and both sat perfectly still through
 * entire calls while looking, in every line, like working code.
 *
 * Measured before the fix: 75 consecutive samples of the composer's bars, all
 * 0.22, the floor. After: 103 distinct values in 120 samples, 0.26 to 1.00,
 * tracking real audio.
 *
 *   node scripts/voice-meter-test.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

const types = read('src/shared/types.ts')
const store = read('src/renderer/state/store.ts')
const live = read('src/renderer/components/live/LiveWorkspace.tsx')
const indicator = read('src/renderer/components/converse/VoiceIndicator.tsx')
const session = read('src/main/live/session.ts')

/* ---- the trap is labelled ---------------------------------------------- */

check(
  'LiveSessionStatus.level is documented as always 0',
  /Always 0\. Do NOT draw a meter from this/.test(types),
  'it reads like a mic level and is not'
)
check(
  'and main really does leave it at 0',
  /level: 0,/.test(session) && !/level: rmsOf|level = this\.micLevel/.test(session)
)

/* ---- the live value exists and is published ---------------------------- */

check('the store carries micLevel', /micLevel: number/.test(store) && /setMicLevel/.test(store))
check(
  'the capture loop publishes it every frame',
  /publishLevel\(source\)/.test(live),
  'the same rAF loop that already drove the orb'
)
check(
  'and zeroes it when the call ends',
  (live.match(/publishLevel\(0\)/g) ?? []).length >= 2,
  'a frozen meter reads as a microphone still open'
)

/* ---- the meter reads the live value, not the dead one ------------------ */

check(
  'the composer meter subscribes to micLevel',
  /useStore\(\(s\) => s\.micLevel\)/.test(indicator)
)
check(
  'and does NOT read liveStatus.level',
  !/liveStatus\.level|status\.level/.test(indicator.replace(/\/\*[\s\S]*?\*\//g, '')),
  'that is the constant zero'
)
check(
  'attack is instant, only the fall is smoothed',
  /t > current \? t :/.test(indicator),
  'smoothing the rise puts lag between a syllable and the bar moving'
)
check(
  'no CSS transition stacked on top of the per-frame updates',
  !/transition: transform/.test(read('src/renderer/components/converse/converse.css')),
  'two smoothing passes is what "not realtime enough" feels like'
)

/* ---- and the row it lives in did not grow --------------------------- */

const css = read('src/renderer/components/converse/converse.css')
check(
  'the live pill reserves its border rather than adding one',
  /\.cv-controls \{[^}]*border: 1px solid transparent/.test(css) &&
    /\.cv-controls\.is-live \{[^}]*border-color:/.test(css),
  'otherwise the composer grows the instant a call starts'
)

console.log(
  failures === 0
    ? '\n\x1b[32mall voice-meter checks passed\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m`
)
process.exit(failures === 0 ? 0 : 1)
