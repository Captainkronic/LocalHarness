/**
 * The two-stage image edit pipeline: refine, then render.
 *
 * Stage 1 sends the actual photo to a vision model on whatever host the chat
 * endpoint points at, together with what the user typed, and asks it for an edit
 * prompt. Stage 2 hands that
 * prompt to comfy-image's `edit_image` with `confirm: true`.
 *
 * Both halves exist because of what the renderer on the other end actually is.
 * It is img2img: it has no memory of the original and no concept of "change" —
 * it sees the source pixels and a block of prompt text, nothing else. So the
 * prompt has to describe the finished image in full, which is a job for a model
 * that can see the photo. And `confirm: true` is what stops comfy-image running
 * its own small local VLM over that text and rewriting it; the Studio's model is
 * far stronger, so letting comfy redo the work would only make it worse.
 *
 * This is not a tool-calling chat turn. The output is a fixed triptych — source,
 * prompt, result — and a model deciding for itself whether to call a tool cannot
 * guarantee one.
 *
 * Previews: `sourceDataUrl` / `outputDataUrl` are never persisted (see store.ts).
 * The pipeline keeps a small bounded cache of the ones it has already read so
 * every pushed job can carry its previews, and `dataUrl()` re-derives anything
 * the cache does not hold.
 */

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

import type { EditJob, EditParams, ModelInfo, Settings } from '@shared/types'
import { EDIT_IMAGE_MIME } from '@shared/types'
import { hostLabel } from '@shared/hosts'
import { WORKFLOW_BY_ID } from '@shared/workflows'

import { streamChat, type WireMessage } from '../llm/client'
import type { ModelRegistry } from '../llm/models'
import type { McpCallResult } from '../mcp/client'
import type { LogFn, McpManager } from '../mcp/manager'
import { expandTilde } from '../store/paths'

import type { EditJobStore } from './store'

/** The MCP server and tool this pipeline is built around. */
const COMFY_SERVER_ID = 'comfy-image'
const EDIT_TOOL_NAME = 'edit_image'

/** Shared with the drop zone and the file dialog so the three cannot drift. */
const IMAGE_MIME = EDIT_IMAGE_MIME

/**
 * Ceiling on a source photo. Must not exceed the renderer's own re-read cap in
 * `artifacts:readDataUrl`, or a file is accepted here and then shows as broken
 * on the next state push when the preview is re-derived.
 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** Preview cache bounds: only modest images are held, and only for the most
 *  recently touched handful of jobs, so this cannot grow without limit. */
const MAX_PREVIEW_JOBS = 8
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

/** comfy-image's own bounds and defaults. */
const DENOISE_MIN = 0.1
const DENOISE_MAX = 1.0
const STEPS_MIN = 1
const STEPS_MAX = 60
const SEED_MAX = 0xffff_ffff
const DEFAULT_DENOISE = 0.6
const DEFAULT_STEPS = 8

const BLIND_NOTE =
  'No vision-capable model is loaded on the server, so this prompt was written from your words alone — the model never saw the photo. Read it before rendering.'

export interface EditPipelineOptions {
  store: EditJobStore
  mcp: McpManager
  models: ModelRegistry
  getSettings: () => Settings
  /** Called on every state transition, with previews attached where known. */
  onJob: (job: EditJob) => void
  onLog: LogFn
}

interface Previews {
  source?: string
  output?: string
}

/** Either the wire name edit_image is reachable under, or why it is not. */
type ToolLookup = { qualifiedName: string } | { qualifiedName: null; reason: string }

export class EditPipeline {
  private readonly o: EditPipelineOptions
  /** Job id -> the controller aborting its in-flight refine. */
  private readonly refines = new Map<string, AbortController>()
  /** Job ids with a render dispatched to comfy-image right now. */
  private readonly renders = new Set<string>()
  /** Renders the user cancelled; their eventual result is dropped, not applied. */
  private readonly cancelledRenders = new Set<string>()
  private readonly previews = new Map<string, Previews>()

  constructor(opts: EditPipelineOptions) {
    this.o = opts
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  list(): EditJob[] {
    return this.o.store.list().map((job) => this.withPreviews(job))
  }

  /** data: URL for a job's source or output, read on demand. */
  async dataUrl(path: string): Promise<string | null> {
    if (typeof path !== 'string' || path.trim().length === 0) return null
    const file = resolve(expandTilde(path))
    const mime = IMAGE_MIME[extension(file)]
    if (mime === undefined) return null

    const info = await stat(file).catch(() => null)
    if (info === null || !info.isFile() || info.size > MAX_IMAGE_BYTES) return null

    const bytes = await readFile(file).catch(() => null)
    if (bytes === null) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  /* ---------------------------------------------------------------- */
  /* Job lifecycle                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * A rejected file returns null and says why through `onLog` — the log feed is
   * on screen, and a half-built job in the panel would be worse than nothing.
   */
  async createFromPath(path: string, parentId?: string): Promise<EditJob | null> {
    if (typeof path !== 'string' || path.trim().length === 0) return null
    const file = resolve(expandTilde(path))

    if (IMAGE_MIME[extension(file)] === undefined) {
      this.o.onLog(
        'warn',
        'edit',
        `${basename(file)} is not an image LocalHarness can edit (png, jpg, jpeg, webp, gif or bmp).`
      )
      return null
    }

    const info = await stat(file).catch(() => null)
    if (info === null || !info.isFile()) {
      this.o.onLog('warn', 'edit', `No such image: ${file}`)
      return null
    }
    if (info.size > MAX_IMAGE_BYTES) {
      this.o.onLog(
        'warn',
        'edit',
        `${basename(file)} is ${mb(info.size)}MB; the limit is ${mb(MAX_IMAGE_BYTES)}MB. Export a smaller copy and try again.`
      )
      return null
    }

    const now = Date.now()
    const job: EditJob = {
      id: randomUUID(),
      sourcePath: file,
      sourceName: basename(file),
      userInstruction: '',
      refinedPrompt: null,
      promptEdited: false,
      status: 'draft',
      // comfy-image's own defaults, so an untouched job renders exactly as the
      // server would have rendered it on its own.
      params: { denoise: DEFAULT_DENOISE, steps: DEFAULT_STEPS },
      createdAt: now,
      updatedAt: now
    }
    if (typeof parentId === 'string' && parentId.length > 0) job.parentId = parentId

    const preview = await this.dataUrl(file)
    if (preview !== null) {
      job.sourceDataUrl = preview
      this.remember(job.id, 'source', preview)
    }

    return this.commit(job)
  }

  setInstruction(jobId: string, instruction: string): EditJob | null {
    const job = this.o.store.get(jobId)
    if (job === null) return null
    // Stored verbatim, and deliberately without touching refinedPrompt: a prompt
    // the user has hand-edited must not be thrown away by a keystroke in the
    // instruction box. Re-refining is their call.
    job.userInstruction = typeof instruction === 'string' ? instruction : ''
    return this.commit(job)
  }

  setParams(jobId: string, params: Partial<EditParams>): EditJob | null {
    const job = this.o.store.get(jobId)
    if (job === null) return null
    job.params = mergeParams(job.params, params)
    return this.commit(job)
  }

  setPrompt(jobId: string, prompt: string): EditJob | null {
    const job = this.o.store.get(jobId)
    if (job === null) return null
    if (this.refines.has(jobId)) {
      // A refine in flight is about to overwrite refinedPrompt, so accepting an
      // edit here would silently discard the user's typing seconds later.
      this.o.onLog('warn', 'edit', 'Ignored a prompt edit while the refine was still running.')
      return job
    }

    const text = typeof prompt === 'string' ? prompt.trim() : ''
    job.refinedPrompt = text.length > 0 ? text : null
    job.promptEdited = text.length > 0
    if (text.length > 0) {
      // A hand-written prompt is as renderable as a refined one.
      if (job.status === 'draft' || job.status === 'error') job.status = 'ready'
    } else if (job.status === 'ready' && job.timings === undefined && job.outputPath === undefined) {
      // Only a job that has never done real work falls back to 'draft'. The feed
      // hides drafts, so demoting a refined or rendered card because its prompt
      // box was momentarily emptied unmounted the card out from under the caret
      // — which is exactly what select-all-and-retype does.
      job.status = 'draft'
    }
    return this.commit(job)
  }

  /* ---------------------------------------------------------------- */
  /* Stage 1: refine                                                   */
  /* ---------------------------------------------------------------- */

  async refine(jobId: string): Promise<EditJob | null> {
    const job = this.o.store.get(jobId)
    if (job === null) return null
    if (this.isBusy(jobId)) return job

    const instruction = job.userInstruction.trim()
    if (instruction.length === 0) {
      job.error = 'Say what you want changed before refining.'
      return this.commit(job)
    }

    const vision = this.pickModel(true)
    const model = vision ?? this.pickModel(false)
    if (model === null) {
      job.status = 'error'
      job.error = 'No model is available on the server. Load one in LM Studio and try again.'
      return this.commit(job)
    }

    // The image only goes to a model that can actually take one. Without a VLM
    // we refine from the text alone and say so on the job — never silently.
    let sourceDataUrl: string | null = null
    if (vision !== null) {
      sourceDataUrl = await this.preview(job, 'source')
      if (sourceDataUrl === null) {
        job.status = 'error'
        job.error = `Could not read the source image at ${job.sourcePath}.`
        return this.commit(job)
      }
    } else {
      this.o.onLog(
        'warn',
        'edit',
        `No vision-capable model on the server; refining "${job.sourceName}" from text alone.`
      )
    }

    const settings = this.o.getSettings()

    job.status = 'refining'
    job.error = undefined
    // The turn goes to `settings.baseUrl`, so that is the machine to name — not
    // wherever the model was discovered.
    job.refineHost = hostLabel(settings.baseUrl) ?? undefined
    this.commit(job)

    const wf = WORKFLOW_BY_ID.edit
    const controller = new AbortController()
    this.refines.set(jobId, controller)

    const startedAt = Date.now()
    let content = ''
    /** Reasoning is counted, never accumulated — a model's thinking must not
     *  end up in the image prompt. */
    let reasoningChars = 0
    let finishReason = 'stop'
    let failure: string | null = null

    try {
      await streamChat(
        {
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: model.id,
          messages: buildRefineMessages(wf.systemPrompt, instruction, sourceDataUrl),
          temperature: wf.sampling.temperature,
          topP: wf.sampling.topP,
          maxTokens: wf.sampling.maxTokens,
          signal: controller.signal
        },
        {
          onFirstToken: () => undefined,
          onContent: (delta) => {
            content += delta
          },
          onReasoning: (delta) => {
            reasoningChars += delta.length
          },
          onToolCallDelta: () => undefined,
          onUsage: () => undefined,
          onDone: (reason) => {
            finishReason = reason
          }
        }
      )
    } catch (err) {
      failure = messageOf(err)
    } finally {
      this.refines.delete(jobId)
    }

    // Re-read: the user may have edited params — or deleted the job — during the
    // stream, and this method owns only the fields it sets below.
    const latest = this.o.store.get(jobId)
    if (latest === null) return null

    if (failure !== null) {
      latest.status = 'error'
      latest.error = failure
      this.o.onLog('error', 'edit', `refine failed: ${failure}`)
      return this.commit(latest)
    }

    if (controller.signal.aborted || finishReason === 'aborted') {
      latest.status = hasPrompt(latest) ? 'ready' : 'draft'
      latest.error = 'Refine cancelled.'
      return this.commit(latest)
    }

    const prompt = cleanPrompt(content)
    if (prompt.length === 0) {
      latest.status = 'error'
      latest.error =
        finishReason === 'length' || reasoningChars > 0
          ? 'The model spent its whole output budget reasoning and never wrote a prompt. Try again, or write the prompt yourself.'
          : 'The model returned an empty prompt.'
      return this.commit(latest)
    }

    latest.refinedPrompt = prompt
    latest.promptEdited = false
    latest.status = 'ready'
    latest.timings = { ...latest.timings, refineMs: Date.now() - startedAt }
    latest.error = vision === null ? BLIND_NOTE : undefined
    return this.commit(latest)
  }

  /* ---------------------------------------------------------------- */
  /* Stage 2: render                                                   */
  /* ---------------------------------------------------------------- */

  async apply(jobId: string): Promise<EditJob | null> {
    const job = this.o.store.get(jobId)
    if (job === null) return null
    if (this.isBusy(jobId)) return job

    const prompt = (job.refinedPrompt ?? '').trim()
    if (prompt.length === 0) {
      job.error = 'There is no prompt to render yet — refine the instruction, or write a prompt yourself.'
      return this.commit(job)
    }

    const source = await stat(job.sourcePath).catch(() => null)
    if (source === null || !source.isFile()) {
      // Bytes cannot travel through a tool call; comfy-image opens this path
      // itself, so a missing file has to be caught before the call.
      job.status = 'error'
      job.error = `The source image is no longer at ${job.sourcePath}.`
      return this.commit(job)
    }

    const tool = this.resolveEditTool()
    if (tool.qualifiedName === null) {
      job.status = 'error'
      job.error = tool.reason
      return this.commit(job)
    }

    job.status = 'rendering'
    job.error = undefined
    job.renderHost = this.comfyHost() ?? undefined
    this.commit(job)
    this.renders.add(jobId)

    const args: Record<string, unknown> = {
      // confirm:true makes the server use this text exactly as given. Without it
      // comfy-image reruns its own local VLM over the instruction and rewrites
      // it, throwing away the refinement the Studio's model just did.
      instruction: prompt,
      source: job.sourcePath,
      denoise: job.params.denoise,
      steps: job.params.steps,
      confirm: true
    }
    // Always send a seed, choosing one ourselves when the user has not.
    //
    // Leaving it out let ComfyUI pick, and it never told us what it picked — so
    // a finished card said "seed random", which is not a fact about the render,
    // it is an admission that we did not record one. The whole point of a
    // parameter readout on an image you liked is being able to make that image
    // again, or vary one thing about it. Choosing here means every render is
    // reproducible and the number on the card is the number that was used.
    if (typeof job.params.seed !== 'number') {
      job.params.seed = Math.floor(Math.random() * (SEED_MAX + 1))
    }
    args.seed = job.params.seed
    // `model` is deliberately unset: z-image is the only one installed here.

    const startedAt = Date.now()
    let result: McpCallResult | null = null
    let failure: string | null = null
    try {
      result = await this.o.mcp.callTool(tool.qualifiedName, args)
    } catch (err) {
      failure = messageOf(err)
    } finally {
      this.renders.delete(jobId)
    }

    // Cleared before the existence check, so a job deleted mid-render does not
    // leave its id behind in the cancelled set.
    const cancelled = this.cancelledRenders.delete(jobId)
    const latest = this.o.store.get(jobId)
    if (latest === null) return null

    if (cancelled) {
      // cancel() already moved the job. The image may well exist — ComfyUI was
      // never told to stop — so name it in the log rather than losing it.
      const rendered = result === null ? null : await pickOutputPath(result, latest.sourcePath)
      this.o.onLog(
        'info',
        'edit',
        rendered === null
          ? 'A cancelled render finished with no usable output.'
          : `A cancelled render finished anyway: ${rendered}`
      )
      return this.withPreviews(latest)
    }

    if (failure !== null || result === null) {
      latest.status = 'error'
      latest.error = failure ?? 'comfy-image returned nothing.'
      this.o.onLog('error', 'edit', `render failed: ${latest.error}`)
      return this.commit(latest)
    }

    if (result.isError) {
      // The server's own text, verbatim — it names the real cause far better
      // than anything this side could infer.
      latest.status = 'error'
      latest.error = result.text.trim().length > 0 ? result.text.trim() : 'comfy-image reported an error with no message.'
      return this.commit(latest)
    }

    const outputPath = await pickOutputPath(result, latest.sourcePath)
    if (outputPath === null) {
      latest.status = 'error'
      latest.error = `comfy-image did not report an output file. Its reply was:\n${result.text.trim()}`
      return this.commit(latest)
    }

    latest.outputPath = outputPath
    const preview = await this.dataUrl(outputPath)
    if (preview !== null) {
      latest.outputDataUrl = preview
      this.remember(latest.id, 'output', preview)
    }
    latest.status = 'done'
    latest.timings = { ...latest.timings, renderMs: Date.now() - startedAt }
    latest.error = undefined
    return this.commit(latest)
  }

  /* ---------------------------------------------------------------- */
  /* Cancel / delete                                                   */
  /* ---------------------------------------------------------------- */

  async cancel(jobId: string): Promise<void> {
    const controller = this.refines.get(jobId)
    if (controller !== undefined) {
      // refine()'s own completion path settles the job once the stream unwinds.
      controller.abort()
      return
    }
    if (!this.renders.has(jobId)) return

    // A render already dispatched cannot truly be recalled: the request is with
    // ComfyUI, which will finish the image whatever LocalHarness does. All this
    // can do is stop waiting and drop the result when it lands.
    this.cancelledRenders.add(jobId)
    const job = this.o.store.get(jobId)
    if (job === null) return
    job.status = hasPrompt(job) ? 'ready' : 'draft'
    job.error =
      'Cancelled. ComfyUI had already started this render and will finish it on its own; LocalHarness has stopped waiting and will not pick up the result.'
    this.commit(job)
  }

  delete(jobId: string): void {
    this.refines.get(jobId)?.abort()
    this.refines.delete(jobId)
    // An in-flight render outlives the record; mark it so its result is dropped
    // instead of resurrecting a deleted job.
    if (this.renders.has(jobId)) this.cancelledRenders.add(jobId)
    this.previews.delete(jobId)
    this.o.store.delete(jobId)
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private isBusy(jobId: string): boolean {
    if (!this.refines.has(jobId) && !this.renders.has(jobId)) return false
    this.o.onLog('info', 'edit', `job ${jobId} is already working; ignoring the duplicate request.`)
    return true
  }

  /** Persists, attaches previews and pushes. Every transition goes through here. */
  private commit(job: EditJob): EditJob {
    job.updatedAt = Date.now()
    // save() strips the data: URLs from its own copy; `job` keeps them.
    this.o.store.save(job)
    const pushed = this.withPreviews(job)
    this.o.onJob(pushed)
    return pushed
  }

  /**
   * Which model gets stage 1. A pinned model wins if it can see; otherwise the
   * resident one, since it needs no load; otherwise anything suitable.
   */
  private pickModel(needsVision: boolean): ModelInfo | null {
    const models = this.o.models.list()
    const suitable = (m: ModelInfo | undefined): m is ModelInfo =>
      m !== undefined && (!needsVision || m.supportsVision)

    const pinnedId = this.o.getSettings().defaultModelId
    const pinned = pinnedId === null ? undefined : models.find((m) => m.id === pinnedId)
    if (suitable(pinned)) return pinned

    const residentId = this.o.models.residentModelId()
    const resident = residentId === null ? undefined : models.find((m) => m.id === residentId)
    if (suitable(resident)) return resident

    return models.find((m) => !needsVision || m.supportsVision) ?? null
  }

  /**
   * Where the renderer actually is: comfy-image's own COMFY_HOST, which is
   * 127.0.0.1 unless the spec has been changed. Nothing about it follows the
   * chat endpoint, so it has to be read from the server's environment.
   */
  private comfyHost(): string | null {
    const spec = this.o.mcp.specs().find((s) => s.id === COMFY_SERVER_ID)
    return hostLabel(spec?.env?.COMFY_HOST)
  }

  /**
   * The wire name comfy-image's edit_image is reachable under. The manager
   * namespaces tools and rewrites characters the OpenAI grammar rejects, so the
   * name is resolved from what it reports rather than assumed.
   */
  private resolveEditTool(): ToolLookup {
    const state = this.o.mcp.states().find((s) => s.id === COMFY_SERVER_ID)
    if (state === undefined) {
      return { qualifiedName: null, reason: `The ${COMFY_SERVER_ID} MCP server is not in the registry.` }
    }
    if (state.status !== 'ready') {
      const detail = state.error ? `: ${state.error}` : ''
      return {
        qualifiedName: null,
        reason: `The ${COMFY_SERVER_ID} server is ${state.status}${detail}. Start it from the MCP panel and try again.`
      }
    }

    const tool = state.tools.find((t) => t.name === EDIT_TOOL_NAME)
    if (tool === undefined) {
      const names = state.tools.map((t) => t.name).join(', ') || 'none'
      return {
        qualifiedName: null,
        reason: `${COMFY_SERVER_ID} is running but exposes no ${EDIT_TOOL_NAME} tool. It offers: ${names}.`
      }
    }

    // Prefer the exact name the model would have been shown; fall back to the
    // tool's own qualified name, which the manager also routes (it resolves by
    // splitting on the separator when a wire name is not in its map — the case
    // when the user has switched this tool off in the MCP panel).
    const wireNames = this.o.mcp.wireTools().map((t) => t.function.name)
    const suffix = `__${EDIT_TOOL_NAME}`
    const wire =
      wireNames.find((n) => n === tool.qualifiedName) ?? wireNames.find((n) => n.endsWith(suffix))
    return { qualifiedName: wire ?? tool.qualifiedName }
  }

  /* -- previews ---------------------------------------------------- */

  private async preview(job: EditJob, which: keyof Previews): Promise<string | null> {
    const cached = this.previews.get(job.id)?.[which]
    if (cached !== undefined) return cached
    const path = which === 'source' ? job.sourcePath : job.outputPath
    if (path === undefined) return null
    const url = await this.dataUrl(path)
    if (url !== null) this.remember(job.id, which, url)
    return url
  }

  private remember(jobId: string, which: keyof Previews, url: string): void {
    // Big images are read on demand instead; caching them is what would turn
    // this into a memory leak.
    if (url.length > MAX_PREVIEW_BYTES) return
    const entry = this.previews.get(jobId) ?? {}
    entry[which] = url
    this.previews.delete(jobId)
    this.previews.set(jobId, entry)
    while (this.previews.size > MAX_PREVIEW_JOBS) {
      const oldest = this.previews.keys().next()
      if (oldest.done === true) break
      this.previews.delete(oldest.value)
    }
  }

  /** Fills in whatever previews are already known, so a pushed job is renderable
   *  without a second round trip. Anything missing comes from `dataUrl()`. */
  private withPreviews(job: EditJob): EditJob {
    const cached = this.previews.get(job.id)
    if (cached === undefined) return job
    if (job.sourceDataUrl === undefined && cached.source !== undefined) {
      job.sourceDataUrl = cached.source
    }
    if (job.outputDataUrl === undefined && cached.output !== undefined && job.outputPath) {
      job.outputDataUrl = cached.output
    }
    return job
  }
}

/* ------------------------------------------------------------------ */
/* Message building                                                   */
/* ------------------------------------------------------------------ */

function buildRefineMessages(
  systemPrompt: string,
  instruction: string,
  sourceDataUrl: string | null
): WireMessage[] {
  if (sourceDataUrl === null) {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        // Said plainly, because the system prompt tells the model to carry over
        // what it can see and there is nothing to see.
        content: `You cannot see the photo this time — no vision-capable model is loaded. Write the prompt from the request alone and do not invent details you have not been told.\n\n${instruction}`
      }
    ]
  }

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: sourceDataUrl } },
        { type: 'text', text: instruction }
      ]
    }
  ]
}

/* ------------------------------------------------------------------ */
/* Prompt cleanup                                                     */
/* ------------------------------------------------------------------ */

/** `<think>` blocks, in case a template leaks reasoning into `content` rather
 *  than the `reasoning_content` channel. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi
const UNCLOSED_THINK = /^[\s\S]*<\/think>/i
const FENCE = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i
/** "Prompt:", "**Final prompt:**", "Edit prompt —" and friends. */
const LABEL = /^\s*(?:\*\*|__)?\s*(?:final|edit|image|refined|revised)?\s*prompt\s*(?:\*\*|__)?\s*[:：\-—]\s*/i
const QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»']
]

/**
 * What comes back is going into an image prompt verbatim, so strip the wrappers
 * a chat model reaches for: leaked thinking, a code fence, a "Prompt:" label,
 * and surrounding quotes.
 */
function cleanPrompt(raw: string): string {
  let text = raw.replace(THINK_BLOCK, '')
  if (/<\/think>/i.test(text)) text = text.replace(UNCLOSED_THINK, '')
  text = text.trim()

  const fenced = FENCE.exec(text)
  if (fenced?.[1] !== undefined) text = fenced[1].trim()

  text = text.replace(LABEL, '').trim()

  for (;;) {
    const pair = QUOTE_PAIRS.find(
      ([open, close]) => text.length > 1 && text.startsWith(open) && text.endsWith(close)
    )
    if (pair === undefined) break
    text = text.slice(1, -1).trim()
  }

  return text
}

/* ------------------------------------------------------------------ */
/* Result mining                                                      */
/* ------------------------------------------------------------------ */

const TEXT_IMAGE_PATH = /\/[^\s"'`<>|]+\.(?:png|jpe?g|webp|gif|bmp)\b/gi

/**
 * Where the render landed. The artifacts the MCP client already built are the
 * structured answer; the text is mined as a fallback, newest mention first,
 * because a server that only says "saved to /x/y.png" still told us.
 * Candidates are checked against the disk, which settles any ambiguity.
 */
async function pickOutputPath(result: McpCallResult, sourcePath: string): Promise<string | null> {
  const fromArtifacts = result.artifacts
    .filter((a) => a.kind === 'image' && typeof a.path === 'string')
    .map((a) => a.path as string)
  const fromText = (result.text.match(TEXT_IMAGE_PATH) ?? []).reverse()

  const seen = new Set<string>([sourcePath])
  for (const candidate of [...fromArtifacts, ...fromText]) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const info = await stat(candidate).catch(() => null)
    if (info !== null && info.isFile()) return candidate
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function mergeParams(base: EditParams, patch: Partial<EditParams>): EditParams {
  const next: EditParams = { ...base }
  if (typeof patch.denoise === 'number' && Number.isFinite(patch.denoise)) {
    next.denoise = clamp(patch.denoise, DENOISE_MIN, DENOISE_MAX)
  }
  if (typeof patch.steps === 'number' && Number.isFinite(patch.steps)) {
    next.steps = Math.round(clamp(patch.steps, STEPS_MIN, STEPS_MAX))
  }
  // Presence of the key is what distinguishes "clear the seed" (so comfy picks a
  // random one) from "leave it alone".
  if ('seed' in patch) {
    if (typeof patch.seed === 'number' && Number.isFinite(patch.seed)) {
      next.seed = Math.round(clamp(patch.seed, 0, SEED_MAX))
    } else {
      delete next.seed
    }
  }
  return next
}

function hasPrompt(job: EditJob): boolean {
  return (job.refinedPrompt ?? '').trim().length > 0
}

function extension(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause
    if (cause instanceof Error && cause.message !== err.message) {
      return `${err.message} (${cause.message})`
    }
    return err.message
  }
  return String(err)
}
