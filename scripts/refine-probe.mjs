#!/usr/bin/env node
/**
 * What does stage 1 of the edit pipeline actually write?
 *
 * The Edit workflow is two models in a row, and when the result is wrong there
 * is no way to tell from the picture alone which of them was at fault. This
 * runs stage 1 on its own -- the real system prompt from workflows.ts, the real
 * photo, the real request -- and prints what comes back, so the prompt can be
 * judged before a single pixel is rendered.
 *
 * It also takes ALTERNATIVE system prompts, because the right stage-1 output
 * depends entirely on what stage 2 is. An img2img renderer wants a description
 * of the finished image; an instruction-edit model wants a short instruction and
 * is actively hurt by a wall of scene description. Same photo, same request,
 * different brief -- that comparison is the point.
 *
 *   node scripts/refine-probe.mjs <image> "<request>" [--style all]
 */
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.LH_BASE_URL ?? 'http://adams-mac-studio.tailc7bb1e.ts.net:1235/v1'
const MODEL = process.env.LH_MODEL ?? 'google/gemma-4-26b-a4b-qat'

const args = process.argv.slice(2)
const image = args[0]
const request = args[1]
const styleArg = (args.find((a) => a.startsWith('--style')) ?? '--style=shipped').split('=')[1] ?? 'shipped'
if (!image || !request) {
  console.error('usage: refine-probe.mjs <image> "<request>" [--style=shipped|instruction|all]')
  process.exit(1)
}

/* The shipped prompt, read from the source rather than copied, so this cannot
   quietly test something the app no longer sends. */
const dir = await mkdtemp(join(tmpdir(), 'lh-refine-'))
await writeFile(join(dir, 'e.ts'), `export { WORKFLOW_BY_ID } from '${ROOT}/src/shared/workflows'\n`)
const shim = join(dir, 's.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir, 'b.mjs')
await build({ entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },  format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared'), electron: shim } })
const { WORKFLOW_BY_ID } = await import(pathToFileURL(out).href)

/**
 * A brief written for an instruction-edit renderer instead of an img2img one.
 *
 * The difference that matters: it must NOT restate the scene. A reference-latent
 * model already has the photo as conditioning, so describing what is in it is at
 * best wasted tokens and at worst a second, competing description that pulls the
 * result away from the original.
 */
const INSTRUCTION_STYLE = `${WORKFLOW_BY_ID.edit.systemPrompt.split('\n\n')[0]}

You are a retoucher. You work on someone else's photograph, and that means restraint: change what was asked, keep what was not, and never quietly improve something he did not mention.

He says what he wants different. You turn that into an instruction the image model can act on.

The renderer is an instruction-following edit model. It is ALREADY LOOKING at this
photo — it has the original as reference. So it needs an instruction, not a
description: telling it what is already in the picture competes with the picture
itself and pulls the result away from the source.

Write one or two sentences, imperative, naming:
- the change, concretely — the object, and exactly what about it is different
- anything nearby that must NOT change, but only where the change could
  plausibly bleed into it

Say nothing about the parts of the photo the request does not touch. No preamble,
no explanation, no restating the scene. Output the instruction only.`

const STYLES = {
  shipped: WORKFLOW_BY_ID.edit.systemPrompt,
  instruction: INSTRUCTION_STYLE
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const bytes = await readFile(resolve(image))
const mime = MIME[extname(image).slice(1).toLowerCase()]
if (!mime) { console.error(`not an image this can send: ${image}`); process.exit(1) }
const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`

const chosen = styleArg === 'all' ? Object.keys(STYLES) : [styleArg]
for (const name of chosen) {
  if (!STYLES[name]) { console.error(`unknown style ${name}`); process.exit(1) }
}

console.log(`\n\x1b[1m${MODEL}\x1b[0m on ${image.split('/').pop()}`)
console.log(`  request: \x1b[36m${request}\x1b[0m\n`)

for (const name of chosen) {
  const t0 = Date.now()
  let r
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: STYLES[name] },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: request }
          ] }
        ],
        temperature: WORKFLOW_BY_ID.edit.sampling.temperature,
        top_p: WORKFLOW_BY_ID.edit.sampling.topP,
        max_tokens: WORKFLOW_BY_ID.edit.sampling.maxTokens
      })
    })
  } catch (err) {
    console.log(`  \x1b[31m${name}: request failed\x1b[0m ${err.message}`)
    continue
  }
  if (!r.ok) {
    console.log(`  \x1b[31m${name}: HTTP ${r.status}\x1b[0m ${(await r.text()).slice(0, 200)}`)
    continue
  }
  const j = await r.json()
  const msg = j.choices?.[0]?.message ?? {}
  const text = (msg.content ?? '').trim()
  const reasoning = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const words = text.split(/\s+/).filter(Boolean).length

  console.log(`\x1b[1m  ── ${name} ──\x1b[0m  ${secs}s · ${words} words · ` +
    `${j.usage?.completion_tokens ?? '?'} tok` + (reasoning ? ` (${reasoning} reasoning)` : ''))
  console.log(text.split('\n').map((l) => '     ' + l).join('\n'))
  console.log()
}
