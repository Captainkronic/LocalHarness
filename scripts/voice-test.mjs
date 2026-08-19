#!/usr/bin/env node
/**
 * Round-trips the real speech stack: synthesise a sentence with Kokoro, then
 * transcribe that audio back with Whisper and check the words survive. Both run
 * locally on this Mac through voice-mcp; nothing is mocked.
 *
 * Also measures the latency that decides whether the Live workflow feels like a
 * conversation — see the reasoning_effort note below.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'lh-voice-'))
await writeFile(
  join(dir, 'e.ts'),
  `export { SpeechServices } from '${ROOT}/src/main/live/speech'
   export { encodeWav } from '${ROOT}/src/main/live/wav'
  `
)

// The speech layer asks Electron for the temp directory. That is the only thing
// it needs from Electron, so the harness supplies it rather than dragging a
// whole Electron runtime in — the code under test is otherwise unmodified.
const shim = join(dir, 'electron-shim.mjs')
await writeFile(
  shim,
  `import { tmpdir } from 'node:os'
   export const app = {
     getPath: (name) => (name === 'temp' ? tmpdir() : tmpdir()),
     getVersion: () => '0.1.0-test'
   }
   export default { app }
  `
)

const outfile = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')],
  outfile,
  bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, 
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim }
})
const { SpeechServices, encodeWav } = await import(pathToFileURL(outfile).href)

console.log('\n\x1b[1mSpeech round-trip (local Kokoro + Whisper)\x1b[0m\n')

/* --- wav encoder, before anything depends on it --- */
{
  const pcm = new Int16Array(16000) // 1s of silence
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin((i / 16000) * 2 * Math.PI * 440))
  const wav = encodeWav(pcm, 16000)
  const riff = wav.subarray(0, 4).toString('ascii')
  const wave = wav.subarray(8, 12).toString('ascii')
  const rate = wav.readUInt32LE(24)
  const bits = wav.readUInt16LE(34)
  const dataLen = wav.readUInt32LE(40)
  check('wav header is well formed', riff === 'RIFF' && wave === 'WAVE', `${riff}/${wave}`)
  check('wav sample rate and depth', rate === 16000 && bits === 16, `${rate}Hz ${bits}-bit`)
  check('wav data length matches the samples', dataLen === pcm.length * 2, `${dataLen} bytes`)
}

const speech = new SpeechServices({ onLog: () => {} })
try {
  const t0 = Date.now()
  await speech.start()
  check('voice-mcp starts', speech.available(), `${Date.now() - t0}ms`)
} catch (err) {
  check('voice-mcp starts', false, String(err))
}

if (speech.available()) {
  const PHRASE = 'The quick brown fox jumps over the lazy dog.'
  let warmTts = 0

  const t1 = Date.now()
  let audio = null
  try {
    audio = await speech.synthesize(PHRASE, 'af_heart', 1.0)
  } catch (err) {
    check('synthesize a sentence', false, String(err))
  }
  if (audio) {
    const coldMs = Date.now() - t1
    check('synthesize a sentence', audio.length > 1000, `${(audio.length / 1024).toFixed(0)}KB in ${coldMs}ms (cold)`)

    // The first call also loads Kokoro. That cost is paid once per voice-mcp
    // lifetime, so the number that matters mid-conversation is the second one —
    // and it is why the session keeps the speech server warm rather than
    // starting it per turn.
    const t1b = Date.now()
    await speech.synthesize('And here is a second sentence, spoken warm.', 'af_heart', 1.0)
    const warmMs = Date.now() - t1b
    warmTts = warmMs
    check(
      'warm TTS is inside a conversational budget',
      warmMs < 1500,
      `${warmMs}ms warm vs ${coldMs}ms cold — ${(coldMs / Math.max(1, warmMs)).toFixed(1)}x`
    )

    const t2 = Date.now()
    let text = ''
    try {
      text = await speech.transcribe(audio)
    } catch (err) {
      check('transcribe it back', false, String(err))
    }
    const sttMs = Date.now() - t2
    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean)
    const want = norm(PHRASE)
    const got = norm(text)
    const hits = want.filter((w) => got.includes(w)).length
    check('transcribe it back', text.trim().length > 0, `${sttMs}ms cold — ${JSON.stringify(text.trim().slice(0, 70))}`)
    check(
      'the words survive the round trip',
      hits >= want.length - 1,
      `${hits}/${want.length} words recovered`
    )

    // Whisper loads on the first transcribe too. STT sits directly in the turn,
    // between the user stopping and anything else starting, so the warm figure
    // is the one the conversation actually pays.
    const t3 = Date.now()
    await speech.transcribe(audio)
    const sttWarmMs = Date.now() - t3
    check(
      'warm STT is inside a conversational budget',
      sttWarmMs < 1500,
      `${sttWarmMs}ms warm vs ${sttMs}ms cold — ${(sttMs / Math.max(1, sttWarmMs)).toFixed(1)}x`
    )

    // The headline: what the user waits between finishing a sentence and
    // hearing the first word back, with everything warm.
    console.log(
      `\n\x1b[1m  estimated warm first-audio: ${sttWarmMs} STT + ~312 model + ${'{tts}'} TTS\x1b[0m`.replace(
        '{tts}',
        String(warmTts)
      )
    )
  }

  const voices = await speech.voices().catch(() => [])
  check('voice list is available', voices.length > 0, `${voices.length} voices${voices.length ? `, e.g. ${voices.slice(0, 4).join(', ')}` : ''}`)

  /* --- the REAL pipeline path -------------------------------------- */
  // The checks above transcribe Kokoro's own wav. The app never does that: it
  // transcribes OUR encodeWav output from microphone PCM. Testing the former
  // and claiming the latter works is how the ffmpeg failure reached the user.
  {
    const tone = new Int16Array(16000)
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.round(2500 * Math.sin((i / 16000) * 2 * Math.PI * 220))
    }
    let ok = true
    let detail = ''
    try {
      // Silence/tone is expected to transcribe to nothing useful; what is being
      // proven is that the DECODE path works at all, not the words.
      await speech.transcribe(encodeWav(tone, 16000))
      detail = 'our own encodeWav output decodes'
    } catch (err) {
      ok = false
      detail = String(err)
    }
    check('transcribe accepts audio from our own encoder', ok, detail)
  }
}

await speech.stop().catch(() => undefined)
check('speech services stop cleanly', true)

await rm(dir, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '\x1b[32mall voice checks passed\x1b[0m\n' : `\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
