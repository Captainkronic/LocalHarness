#!/usr/bin/env node
/**
 * An image the server refuses must never reach the wire.
 *
 * Measured against LM Studio, not assumed: png, jpeg and gif are accepted;
 * webp, bmp and svg come back as
 *
 *   400 {"error":"'url' field must be a base64 encoded image."}
 *
 * which names the wrong thing entirely — the url IS a well-formed base64 data
 * URL, and the objection is to the format inside it. That misdirection cost
 * real time.
 *
 * The part that made it much worse: every request replays the whole
 * conversation, attachments included. One refused image does not fail one
 * turn — it fails EVERY turn after it. Observed exactly that: a webp failed,
 * then a plain PNG failed too, because the webp was still in the history
 * behind it. The conversation was permanently unusable with nothing on screen
 * explaining why.
 *
 *   node scripts/image-wire-test.mjs
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
const ipc = read('src/main/ipc.ts')
const prompt = read('src/main/llm/prompt.ts')

/* ---- the allowlist is shared, so the two ends cannot disagree ---------- */

check('the accepted set is declared once, in shared', /WIRE_IMAGE_MIMES/.test(types))
const listed = /WIRE_IMAGE_MIMES[^=]*=\s*\[([^\]]*)\]/.exec(types)?.[1] ?? ''
for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
  check(`${mime} is allowed`, listed.includes(mime))
}
for (const mime of ['image/webp', 'image/bmp', 'image/svg']) {
  check(`${mime} is NOT allowed`, !listed.includes(mime), 'the server refuses it')
}
check('both ends read the same list', /WIRE_IMAGE_MIMES/.test(ipc) && /WIRE_IMAGE_MIMES/.test(prompt))

/* ---- new attachments are converted when picked ------------------------ */

check(
  'an unsupported image is transcoded at attach time',
  /WIRE_IMAGE_MIMES\.includes\(native\)[\s\S]{0,200}?transcodeForWire\(path\)/.test(ipc),
  'once when the file is picked, not on every request that carries it'
)
check(
  'the stored mime is the one that will be SENT, not the file on disk',
  /mimeType: isImage \? \(dataUrl\?\.slice/.test(ipc),
  'otherwise the wire gate below judges it by the wrong type'
)
check(
  'transcode falls back to jpeg when png comes out too large',
  /6 \* MB[\s\S]{0,400}?'jpeg'/.test(ipc),
  'PNG of a photograph is far bigger than the webp it came from'
)
check(
  'and always cleans up its temp files',
  /finally\s*\{[\s\S]{0,200}?rm\(png[\s\S]{0,120}?rm\(jpg/.test(ipc)
)

/* ---- already-stored images are stopped at the wire -------------------- */

check(
  'the prompt builder drops an unsendable image',
  /if \(!WIRE_IMAGE_MIMES\.includes\(mime\)\)[\s\S]{0,300}?continue/.test(prompt),
  'attachments already on disk cannot be converted retroactively'
)
check(
  'and says so in the transcript rather than silently',
  /image not sent[\s\S]{0,200}?Attach it again/.test(prompt),
  'a dropped image with no explanation is a model that has gone blind'
)
check(
  'the drop happens BEFORE the part is pushed',
  prompt.indexOf('WIRE_IMAGE_MIMES.includes(mime)') <
    prompt.indexOf("images.push({ type: 'image_url'"),
  'a gate after the push is not a gate'
)

console.log(
  failures === 0
    ? '\n\x1b[32mall image-wire checks passed\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m`
)
process.exit(failures === 0 ? 0 : 1)
