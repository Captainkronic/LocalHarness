/**
 * Does the ComfyUI server actually have the models these servers need?
 *
 * comfy-image and comfy-audio start perfectly happily against a ComfyUI with no
 * models in it. Nothing fails until a generation is submitted, minutes later,
 * and what comes back is a node error about a filename rather than "you never
 * downloaded this". So setup asks up front.
 *
 * The naive version of this check — list the checkpoints — would miss most of
 * what matters. An image preset needs three files from three different
 * directories, loaded by three different nodes:
 *
 *   unet  -> diffusion_models/  UNETLoader.unet_name
 *   clip  -> text_encoders/     CLIPLoader.clip_name
 *   vae   -> vae/               VAELoader.vae_name
 *
 * while audio uses a single checkpoint via CheckpointLoaderSimple. Asking only
 * about checkpoints would report a fully-equipped server for an install that
 * cannot render anything.
 */

/** Which ComfyUI node exposes the list of files for each slot. */
const LOADER: Record<ModelSlot, { node: string; field: string; folder: string }> = {
  unet: { node: 'UNETLoader', field: 'unet_name', folder: 'diffusion_models' },
  clip: { node: 'CLIPLoader', field: 'clip_name', folder: 'text_encoders' },
  vae: { node: 'VAELoader', field: 'vae_name', folder: 'vae' },
  checkpoint: { node: 'CheckpointLoaderSimple', field: 'ckpt_name', folder: 'checkpoints' }
}

export type ModelSlot = 'unet' | 'clip' | 'vae' | 'checkpoint'

export interface RequiredModel {
  /** Which preset or feature needs it, for a message worth reading. */
  feature: string
  slot: ModelSlot
  file: string
}

export interface ModelReport {
  reachable: boolean
  /** Why not, when the host did not answer. */
  error?: string
  present: RequiredModel[]
  missing: RequiredModel[]
  /** Slots whose loader node the server does not expose at all. */
  unknownSlots: ModelSlot[]
}

/**
 * Parse the presets out of comfy-mcp's own source rather than restating them.
 *
 * A second copy of this list would be wrong the first time a preset changed,
 * and it would be wrong silently — the check would pass while asking about
 * models nothing uses. The shape it reads is stable and simple:
 *
 *   "z-image": { "label": ..., "unet": "...", "clip": "...", "vae": "..." }
 */
export function parseImageModels(serverSource: string): RequiredModel[] {
  const out: RequiredModel[] = []
  const preset = /"([a-z0-9-]+)"\s*:\s*\{([^}]*)\}/gi
  let m: RegExpExecArray | null
  while ((m = preset.exec(serverSource)) !== null) {
    const body = m[2] ?? ''
    const label = /"(?:label|short)"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? m[1] ?? 'preset'
    for (const slot of ['unet', 'clip', 'vae'] as const) {
      const file = new RegExp(`"${slot}"\\s*:\\s*"([^"]+\\.(?:safetensors|ckpt|pth|gguf))"`).exec(body)?.[1]
      if (file) out.push({ feature: label, slot, file })
    }
  }
  return dedupe(out)
}

/** Audio names its two checkpoints as env-var defaults, not as a preset block. */
export function parseAudioModels(serverSource: string): RequiredModel[] {
  const out: RequiredModel[] = []
  const pattern = /environ\.get\(\s*"(AUDIO_\w*CKPT)"\s*,\s*"([^"]+)"\s*\)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(serverSource)) !== null) {
    out.push({
      feature: m[1] === 'AUDIO_MUSIC_CKPT' ? 'Music' : 'Sound effects',
      slot: 'checkpoint',
      file: m[2] ?? ''
    })
  }
  return dedupe(out)
}

function dedupe(models: RequiredModel[]): RequiredModel[] {
  const seen = new Set<string>()
  return models.filter((r) => {
    const key = `${r.slot}:${r.file}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Ask a ComfyUI server what it has, and compare.
 *
 * Only the loaders actually needed are queried — one small request each rather
 * than the whole of /object_info, which on a populated install is megabytes.
 */
export async function checkComfyModels(
  host: string,
  required: RequiredModel[],
  fetchImpl: typeof fetch = fetch
): Promise<ModelReport> {
  const base = host.replace(/\/+$/, '')
  const slots = [...new Set(required.map((r) => r.slot))]
  const available = new Map<ModelSlot, Set<string>>()
  const unknownSlots: ModelSlot[] = []

  for (const slot of slots) {
    const { node, field } = LOADER[slot]
    let payload: unknown
    try {
      const res = await fetchImpl(`${base}/object_info/${node}`, {
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) {
        if (res.status === 404) {
          unknownSlots.push(slot)
          continue
        }
        return { reachable: false, error: `${node}: HTTP ${res.status}`, present: [], missing: required, unknownSlots }
      }
      payload = await res.json()
    } catch (err) {
      return {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
        present: [],
        missing: required,
        unknownSlots
      }
    }
    const names = optionsFrom(payload, node, field)
    if (names === null) unknownSlots.push(slot)
    else available.set(slot, new Set(names))
  }

  const present: RequiredModel[] = []
  const missing: RequiredModel[] = []
  for (const r of required) {
    const have = available.get(r.slot)
    /* A slot whose loader is missing is reported separately rather than as a
       missing model — "your ComfyUI has no VAELoader" is a different problem
       from "this VAE is not downloaded", and needs a different fix. */
    if (!have) continue
    ;(have.has(r.file) ? present : missing).push(r)
  }
  return { reachable: true, present, missing, unknownSlots }
}

/**
 * `/object_info/<Node>` answers `{ Node: { input: { required: { field: [[...names], {...}] } } }}`.
 *
 * Navigated defensively: this shape is ComfyUI's internal node schema, not a
 * documented API, and a version that moves it should read as "cannot tell"
 * rather than as "you have no models".
 */
function optionsFrom(payload: unknown, node: string, field: string): string[] | null {
  if (payload === null || typeof payload !== 'object') return null
  const nodeInfo = (payload as Record<string, unknown>)[node]
  if (nodeInfo === null || typeof nodeInfo !== 'object') return null
  const input = (nodeInfo as Record<string, unknown>)['input']
  if (input === null || typeof input !== 'object') return null
  const req = (input as Record<string, unknown>)['required']
  if (req === null || typeof req !== 'object') return null
  const entry = (req as Record<string, unknown>)[field]
  if (!Array.isArray(entry) || !Array.isArray(entry[0])) return null
  return (entry[0] as unknown[]).filter((v): v is string => typeof v === 'string')
}

/** Where a missing file has to be put, for a message that can be acted on. */
export function installHint(model: RequiredModel): string {
  return `${LOADER[model.slot].folder}/${model.file}`
}

/**
 * Where a model can actually be got, for the ones whose source is recorded.
 *
 * Taken from comfy-mcp's own fetch-audio-models.sh, which is the only place in
 * this system that records a download location. The image models' sources are
 * NOT written down anywhere, and a plausible-looking Hugging Face repo invented
 * here would send someone to a 404 and cost them their trust in every other
 * instruction on the screen. So they are listed as "source not recorded" and
 * pointed at ComfyUI Manager, which can search for them properly.
 */
const MODEL_SOURCES: Record<string, { repo: string; path: string; gb: number }> = {
  'ace_step_1.5_turbo_aio.safetensors': {
    repo: 'Comfy-Org/ace_step_1.5_ComfyUI_files',
    path: 'checkpoints/ace_step_1.5_turbo_aio.safetensors',
    gb: 10
  },
  'stable-audio-open-1.0.safetensors': {
    repo: 'Comfy-Org/stable-audio-open-1.0_repackaged',
    path: 'stable-audio-open-1.0.safetensors',
    gb: 4.85
  },
  't5-base.safetensors': {
    repo: 'ComfyUI-Wiki/t5-base',
    path: 't5-base.safetensors',
    gb: 0.9
  }
}

export interface ModelGuidance {
  file: string
  where: string
  feature: string
  /** A command that will actually work, when the source is known. */
  command?: string
  sizeGb?: number
  /** What to do instead, when it is not. */
  advice: string
}

export function guidanceFor(missing: RequiredModel[], modelsDir: string): ModelGuidance[] {
  return missing.map((m) => {
    const src = MODEL_SOURCES[m.file]
    const where = installHint(m)
    if (!src) {
      return {
        file: m.file,
        where,
        feature: m.feature,
        advice:
          `Install through ComfyUI Manager, or drop the file into ${modelsDir}/${where}. ` +
          `Its download location is not recorded anywhere in this setup, so no command is ` +
          `offered rather than a guessed one.`
      }
    }
    return {
      file: m.file,
      where,
      feature: m.feature,
      sizeGb: src.gb,
      /* -C - so an interrupted download resumes rather than restarting, which
         matters a great deal at ten gigabytes. */
      command:
        `curl -fL -C - --retry 5 -o "${modelsDir}/${where}" ` +
        `"https://huggingface.co/${src.repo}/resolve/main/${src.path}"`,
      advice: `About ${src.gb} GB. Resumable — re-run the same command if it stops.`
    }
  })
}

/** What to say when no ComfyUI could be found at all. */
export const NO_COMFY_ADVICE = [
  'No ComfyUI was found on this machine.',
  '',
  'Image and audio generation need one running somewhere reachable — it does not have to be',
  'this machine. If you already have one elsewhere, put its address in the field above.',
  '',
  'To install one here, the desktop app from comfy.org is the least work. This app expects the',
  'layout it produces: a folder containing ComfyUI/main.py and ComfyUI/.venv/bin/python.',
  'Point the field above at the folder CONTAINING ComfyUI, not at ComfyUI itself.'
].join('\n')
