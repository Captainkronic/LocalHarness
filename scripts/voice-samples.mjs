#!/usr/bin/env node
/**
 * Renders the same line in several Kokoro voices so a human can choose.
 *
 * Written because timbre is not something this process can judge — the right
 * JARVIS voice has to be picked by ear, so the job here is to make listening
 * easy rather than to guess.
 *
 *   node scripts/voice-samples.mjs [outDir] [voice...]
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ?? join(homedir(), 'Desktop', 'CaptainLlama-voices')

/** British male voices, the plausible JARVIS candidates, plus the old default. */
const VOICES =
  process.argv.length > 3
    ? process.argv.slice(3)
    : ['bm_george', 'bm_daniel', 'bm_lewis', 'bm_fable', 'af_heart']

const LINE =
  'Good evening, sir. All systems are online and the inference server is responding normally. ' +
  'Shall I begin?'

const dir = await mkdtemp(join(tmpdir(), 'lh-voices-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { SpeechServices } from '${ROOT}/src/main/live/speech'\n`
)
const shim = join(dir, 'electron-shim.mjs')
await writeFile(
  shim,
  `import { tmpdir } from 'node:os'
   export const app = { getPath: () => tmpdir(), getVersion: () => '0.1.0' }
   export default { app }
  `
)
const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim }
})
const { SpeechServices } = await import(pathToFileURL(outfile).href)

const speech = new SpeechServices({ onLog: () => {} })
await speech.start()
if (!speech.available()) {
  console.error('voice-mcp did not start')
  process.exit(1)
}

await mkdir(outDir, { recursive: true })
console.log(`\n\x1b[1mRendering ${VOICES.length} voices\x1b[0m  \x1b[2m${outDir}\x1b[0m\n`)

for (const voice of VOICES) {
  const t0 = Date.now()
  try {
    const wav = await speech.synthesize(LINE, voice, 1.0)
    const file = join(outDir, `${voice}.wav`)
    await writeFile(file, wav)
    console.log(
      `  \x1b[32mok\x1b[0m  ${voice.padEnd(12)} ${(wav.length / 1024).toFixed(0)}KB  ${Date.now() - t0}ms`
    )
  } catch (err) {
    console.log(`  \x1b[31mfail\x1b[0m ${voice.padEnd(12)} ${String(err).slice(0, 80)}`)
  }
}

await speech.stop()
await rm(dir, { recursive: true, force: true })
console.log(`\nOpen the folder and listen: ${outDir}\n`)
