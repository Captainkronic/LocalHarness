#!/usr/bin/env node
/**
 * The ComfyUI model check.
 *
 * comfy-image and comfy-audio start fine against a ComfyUI with nothing
 * downloaded; the failure arrives minutes later as a node error naming a file.
 * So setup asks first — and asks correctly, which is the part worth testing: an
 * image preset needs a unet, a text encoder and a VAE from three different
 * folders behind three different loader nodes. Checking only checkpoints would
 * pass a server that cannot render anything.
 *
 *   node scripts/comfy-models-test.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'comfy-'))
await writeFile(join(dir, 'e.ts'), `export * from '${ROOT}/src/main/setup/comfy-models'\n`)
const out = join(dir, 'b.mjs')
await build({
  entryPoints: [join(dir, 'e.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', target: 'node22', logLevel: 'silent',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const M = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

/* The real shape, lifted from comfy-mcp/server.py. */
const IMAGE_SRC = `
    "z-image": {
        "label": "Z-Image Turbo (Qwen3-4B text encoder)",
        "short": "Z-Image Turbo",
        "unet": "z_image_turbo_bf16.safetensors",
        "clip": "qwen_3_4b.safetensors",
        "clip_type": "lumina2",
        "vae": "ae.safetensors",
    },
    "flux-klein": {
        "label": "FLUX.2 Klein 4B",
        "unet": "flux-2-klein-4b.safetensors",
        "clip": "qwen_3_4b.safetensors",
        "vae": "flux2-vae.safetensors",
    },
`
const AUDIO_SRC = `
MUSIC_CKPT = os.environ.get("AUDIO_MUSIC_CKPT", "ace_step_1.5_turbo_aio.safetensors")
SFX_CKPT = os.environ.get("AUDIO_SFX_CKPT", "stable-audio-open-1.0.safetensors")
`

console.log('\nReading requirements out of the servers themselves')
const img = M.parseImageModels(IMAGE_SRC)
check('finds every slot, not just checkpoints', new Set(img.map((m) => m.slot)).size === 3,
  `slots: ${[...new Set(img.map((m) => m.slot))].join(',')}`)
check('a shared text encoder is listed once', img.filter((m) => m.file === 'qwen_3_4b.safetensors').length === 1)
check('five distinct files across two presets', img.length === 5, `got ${img.length}`)
check('a unet maps to diffusion_models/', M.installHint(img.find((m) => m.slot === 'unet')).startsWith('diffusion_models/'))
check('a clip maps to text_encoders/', M.installHint(img.find((m) => m.slot === 'clip')).startsWith('text_encoders/'))
check('a vae maps to vae/', M.installHint(img.find((m) => m.slot === 'vae')).startsWith('vae/'))
const aud = M.parseAudioModels(AUDIO_SRC)
check('audio finds both checkpoints', aud.length === 2, `got ${aud.length}`)
check('and labels which is which', aud.some((m) => m.feature === 'Music') && aud.some((m) => m.feature === 'Sound effects'))

console.log('\nComparing against a server')
const reply = (names) => ({
  ok: true, status: 200,
  json: async () => ({ [names.node]: { input: { required: { [names.field]: [names.list, {}] } } } })
})
const server = (have) => async (url) => {
  if (url.includes('UNETLoader')) return reply({ node: 'UNETLoader', field: 'unet_name', list: have.unet ?? [] })
  if (url.includes('CLIPLoader')) return reply({ node: 'CLIPLoader', field: 'clip_name', list: have.clip ?? [] })
  if (url.includes('VAELoader')) return reply({ node: 'VAELoader', field: 'vae_name', list: have.vae ?? [] })
  return reply({ node: 'CheckpointLoaderSimple', field: 'ckpt_name', list: have.checkpoint ?? [] })
}

const full = await M.checkComfyModels('http://x:8188', img, server({
  unet: ['z_image_turbo_bf16.safetensors', 'flux-2-klein-4b.safetensors'],
  clip: ['qwen_3_4b.safetensors'],
  vae: ['ae.safetensors', 'flux2-vae.safetensors']
}))
check('a complete server reports nothing missing', full.missing.length === 0, JSON.stringify(full.missing))
check('and counts what it found', full.present.length === 5)

/* The failure this whole module exists for: checkpoints fine, everything else absent. */
const partial = await M.checkComfyModels('http://x:8188', img, server({
  unet: ['z_image_turbo_bf16.safetensors', 'flux-2-klein-4b.safetensors'], clip: [], vae: []
}))
check('a server with unets but no encoders or VAEs is NOT reported healthy', partial.missing.length === 3,
  `missing ${partial.missing.length}, would have looked fine to a checkpoint-only check`)
check('and names the folder each one belongs in',
  partial.missing.every((m) => /^(text_encoders|vae)\//.test(M.installHint(m))))

console.log('\nWhen the server cannot answer')
const dead = await M.checkComfyModels('http://x:8188', img, async () => { throw new Error('ECONNREFUSED') })
check('an unreachable host is not reported as "no models"', dead.reachable === false)
check('and says why', /ECONNREFUSED/.test(dead.error ?? ''))
const moved = await M.checkComfyModels('http://x:8188', img, async () => ({ ok: true, status: 200, json: async () => ({}) }))
check('an unrecognised schema reads as cannot-tell, not as missing',
  moved.missing.length === 0 && moved.unknownSlots.length === 3,
  `missing=${moved.missing.length} unknown=${moved.unknownSlots.length}`)

console.log(failed === 0 ? '\n\x1b[32mall comfy-model checks passed\x1b[0m' : `\n\x1b[31m${failed} failed\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)
