/**
 * IPC router.
 *
 * Every channel declared in @shared/ipc is handled here and nowhere else. The
 * handler map is typed against IpcApi, so a channel added to the contract that
 * is not implemented here is a compile error rather than a runtime 'no handler'.
 */

import { dialog, ipcMain, shell, app, BrowserWindow, Menu, clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

import type {
  IpcApi,
  BootstrapPayload,
  IpcEventChannel,
  IpcEvents
} from '@shared/ipc'
import { EDIT_IMAGE_EXTENSIONS, WIRE_IMAGE_MIMES } from '@shared/types'
import type {
  ReasoningEffort,
  Attachment,
  DirEntry,
  EditJob,
  ModelInfo,
  Settings,
  WorkflowId,
  Artifact,
  Avatar
} from '@shared/types'
import { WORKFLOWS, WORKFLOW_BY_ID } from '@shared/workflows'
import type { BrowserMirror } from './browser/mirror'

import type { SettingsStore } from './store/settings'
import type { ConversationStore } from './store/conversations'
import type { McpManager } from './mcp/manager'
import type { ModelRegistry } from './llm/models'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { CREDENTIAL_SPEC, applyServerUrl, credentialStates, setCredential } from './setup/credentials'
import { probeServer } from './setup/probe'
import {
  checkComfyModels,
  guidanceFor,
  installHint,
  parseAudioModels,
  parseImageModels
} from './setup/comfy-models'
import { findComfyInstalls, inspectRoot, startComfy } from './setup/comfy-install'
import { provision, readManifest, resourcesRoot } from './setup/provision'
import type { ModelSlot } from '@shared/setup'
import type { ApprovalBroker } from './agent/approval'
import type { LabFeed } from './telemetry/lab'
import type { LmStudioControl } from './llm/control'
import type { EditPipeline } from './edit/pipeline'
import { MAX_IMAGE_BYTES } from './edit/pipeline'
import type { ActivityTracker } from './agent/activity'
import type { SkillRegistry } from './skills/registry'
import type { AvatarStore } from './store/avatars'
import type { AvatarBuilder } from './live/avatar-builder'
import type { LiveSession } from './live/session'
import { isInsideAny } from './store/paths'
import type { Orchestrator } from './orchestrator'
import { NATIVE_TOOLS } from './agent/tools'
import { estimateTokens } from './mcp/tokens'
import { MCP_REGISTRY } from '@shared/mcp-registry'

export interface IpcDeps {
  settings: SettingsStore
  conversations: ConversationStore
  mcp: McpManager
  models: ModelRegistry
  approvals: ApprovalBroker
  lab: LabFeed
  control: LmStudioControl
  edit: EditPipeline
  activity: ActivityTracker
  live: LiveSession
  skills: SkillRegistry
  mirror: BrowserMirror
  avatars: AvatarStore
  avatarBuilder: AvatarBuilder
  orchestrator: Orchestrator
  getWindow: () => BrowserWindow | null
  emit: <K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]) => void
}

/** Implementations, keyed by channel. Types are enforced against IpcApi. */
type Handlers = {
  [K in keyof IpcApi]: (
    ...args: Parameters<IpcApi[K]>
  ) => ReturnType<IpcApi[K]> | Awaited<ReturnType<IpcApi[K]>>
}

/** Chat attachments may be any image the model can look at, SVG included. */
const execFileAsync = promisify(execFile)

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

/**
 * What the files panel is allowed to load inline, and how big each may be.
 *
 * Audio gets the largest ceiling because a rendered song legitimately runs to
 * tens of megabytes; text gets the smallest because the panel shows the head of
 * it, and pulling a 50MB CSV across the bridge to display forty lines is pure
 * waste. Anything not listed is opened in the user's own application instead —
 * which is the better answer for a .docx regardless.
 */
/**
 * The first page of a PDF, as PNG bytes.
 *
 * Written to a temp file because sips has no stdout mode, and removed straight
 * after — a preview that leaves a copy of every document it showed in /tmp is
 * a quiet way to spread files someone may not want spread.
 *
 * -Z bounds the LONGEST side, so a landscape page and a portrait one both come
 * back at a sane size without either being stretched.
 */
async function renderPdfFirstPage(path: string): Promise<Buffer | null> {
  const out = join(tmpdir(), `clpdf-${randomUUID()}.png`)
  try {
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '1600', path, '--out', out], {
      timeout: 20_000
    })
    return await readFile(out)
  } catch {
    return null
  } finally {
    await rm(out, { force: true }).catch(() => undefined)
  }
}

/**
 * Re-encodes an image into something the inference server will accept.
 *
 * A WebP attachment produced a 400 that killed the whole turn — the server
 * refuses webp, bmp and svg, and says so by complaining the url "must be a
 * base64 encoded image", which points at the wrong thing entirely. The file
 * on disk is left alone; only what goes on the wire is converted.
 *
 * PNG first because it is lossless and keeps transparency. PNG of a photograph
 * is however much larger than the webp it came from — 121KB became 821KB here —
 * so anything still oversized after that is re-encoded as JPEG, where the
 * alpha channel is worth less than the turn fitting in the context window.
 */
async function transcodeForWire(
  path: string
): Promise<{ mime: string; buf: Buffer } | null> {
  const png = join(tmpdir(), `climg-${randomUUID()}.png`)
  const jpg = join(tmpdir(), `climg-${randomUUID()}.jpg`)
  try {
    /* -Z bounds the longest side. Vision encoders work well below this, so it
       costs nothing visible and stops a large source becoming a huge payload. */
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '2048', path, '--out', png], {
      timeout: 30_000
    })
    const asPng = await readFile(png)
    if (asPng.length <= 6 * MB) return { mime: 'image/png', buf: asPng }
    await execFileAsync(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '2048', path, '--out', jpg],
      { timeout: 30_000 }
    )
    return { mime: 'image/jpeg', buf: await readFile(jpg) }
  } catch {
    return null
  } finally {
    await rm(png, { force: true }).catch(() => undefined)
    await rm(jpg, { force: true }).catch(() => undefined)
  }
}

const MB = 1024 * 1024
const PREVIEWABLE: Record<string, { mime: string; max: number }> = {
  png: { mime: 'image/png', max: 32 * MB },
  jpg: { mime: 'image/jpeg', max: 32 * MB },
  jpeg: { mime: 'image/jpeg', max: 32 * MB },
  gif: { mime: 'image/gif', max: 32 * MB },
  webp: { mime: 'image/webp', max: 32 * MB },
  bmp: { mime: 'image/bmp', max: 32 * MB },
  svg: { mime: 'image/svg+xml', max: 8 * MB },
  mp3: { mime: 'audio/mpeg', max: 96 * MB },
  wav: { mime: 'audio/wav', max: 96 * MB },
  flac: { mime: 'audio/flac', max: 96 * MB },
  ogg: { mime: 'audio/ogg', max: 96 * MB },
  m4a: { mime: 'audio/mp4', max: 96 * MB },
  aac: { mime: 'audio/aac', max: 96 * MB },
  mp4: { mime: 'video/mp4', max: 96 * MB },
  webm: { mime: 'video/webm', max: 96 * MB },
  pdf: { mime: 'application/pdf', max: 64 * MB },
  txt: { mime: 'text/plain', max: 1 * MB },
  md: { mime: 'text/plain', max: 1 * MB },
  csv: { mime: 'text/plain', max: 1 * MB },
  json: { mime: 'text/plain', max: 1 * MB },
  log: { mime: 'text/plain', max: 1 * MB },
  html: { mime: 'text/plain', max: 1 * MB }
}

/** The edit source picker is narrower: only what the img2img pipeline accepts,
 *  so the dialog cannot offer a file that is then silently refused. */
const EDIT_SOURCE_EXT = EDIT_IMAGE_EXTENSIONS

/** Entries returned for one directory. Beyond this the tree shows a terminal
 *  "more" row rather than serialising an unbounded list over IPC. */
const LIST_DIR_CAP = 5000

/** Dimmed in the tree and never auto-expanded — but still openable. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', '.venv', 'venv',
  '__pycache__', '.next', 'build', 'target', '.cache'
])

/** Servers that talk to ComfyUI and therefore need its address and models. */
const COMFY_SERVERS = new Set(['comfy-image', 'comfy-audio'])

/**
 * Where installed servers live.
 *
 * Application Support, not inside the .app: the installer replaces the bundle
 * wholesale on upgrade, and an environment that took two minutes to build —
 * or a token someone typed in — should survive that.
 */
function installRoot(): string {
  return join(app.getPath('userData'), 'servers')
}

/** Read a staged server's source so its model requirements can be parsed. */
function readServerSource<T>(resources: string, id: string, parse: (src: string) => T[]): T[] {
  const file = join(resources, 'mcp', id, 'server.py')
  if (!existsSync(file)) return []
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function registerIpc(d: IpcDeps): void {
  const handlers: Handlers = {

    /* ---- first-run setup ---- */
    'setup:state': async () => {
      const root = installRoot()
      const resources = resourcesRoot(process.resourcesPath, app.getAppPath())
      const manifest = readManifest(resources)
      const specs = d.mcp.specs()
      return {
        firstRun: d.settings.isFirstRun(),
        servers: manifest.map((m) => ({
          id: m.id,
          label: specs.find((s) => s.id === m.id)?.label ?? m.id,
          blurb: specs.find((s) => s.id === m.id)?.blurb ?? '',
          tier: m.tier,
          /* Stated plainly rather than discovered halfway through an install. */
          ...(m.depsOnDemand ? { cost: 'about 1.4 GB, downloaded after setup' } : {}),
          ...(COMFY_SERVERS.has(m.id) ? { requires: 'a ComfyUI server on your network' } : {}),
          ...(m.id === 'gmail' ? { requires: 'Node, and a Google sign-in' } : {}),
          /* The entry file, not the directory: a directory can exist because
             something wrote a config into it. */
          installed: existsSync(join(root, m.id, m.entry))
        })),
        credentials: CREDENTIAL_SPEC,
        states: credentialStates(root)
      }
    },

    'setup:probe': async (host: string) => probeServer(host),

    'setup:install': async (ids: string[]) => {
      const resources = resourcesRoot(process.resourcesPath, app.getAppPath())
      return provision(ids, {
        resources,
        installRoot: installRoot(),
        onProgress: (p) => d.emit('event:setupProgress', p)
      })
    },

    'setup:setCredential': async (serverId: string, key: string, value: string) => {
      const root = installRoot()
      setCredential(root, serverId, key, value)
      return credentialStates(root)
    },

    'setup:checkComfyModels': async (host: string) => {
      const resources = resourcesRoot(process.resourcesPath, app.getAppPath())
      const required = [
        ...readServerSource(resources, 'comfy-image', parseImageModels),
        ...readServerSource(resources, 'comfy-audio', parseAudioModels)
      ]
      const report = await checkComfyModels(host, required)
      /* `where` is carried over the wire so the renderer never has to know
         about ComfyUI's folder layout to render an actionable message. */
      const withWhere = <T extends { slot: ModelSlot }>(list: T[]) =>
        list.map((m) => ({ ...m, where: installHint(m as never) }))
      return {
        ...report,
        present: withWhere(report.present),
        missing: withWhere(report.missing)
      }
    },

    'setup:findComfy': async () => findComfyInstalls(),

    'setup:startComfy': async (root: string, host: string) => {
      const install = inspectRoot(root)
      if (!install) {
        return { started: false, alreadyRunning: false, error: `No ComfyUI under ${root}.` }
      }
      return startComfy(install, host)
    },

    'setup:modelGuidance': async (host: string) => {
      const resources = resourcesRoot(process.resourcesPath, app.getAppPath())
      const required = [
        ...readServerSource(resources, 'comfy-image', parseImageModels),
        ...readServerSource(resources, 'comfy-audio', parseAudioModels)
      ]
      const report = await checkComfyModels(host, required)
      /* The shared tree, not the install: that is where these actually go, and
         a command writing into ComfyUI/models would put a 10 GB file somewhere
         ComfyUI is not looking. */
      const shared = join(homedir(), 'ComfyUI-Shared', 'models')
      return guidanceFor(report.missing, shared)
    },

    'setup:finish': async (choice) => {
      const root = installRoot()
      /* The three servers that each hold their own inference URL are pointed
         at the server just verified. Without this they keep their localhost
         defaults and vision quietly answers from the wrong machine. */
      applyServerUrl(root, choice.baseUrl, choice.installed)
      const patch: Partial<Settings> = {
        baseUrl: choice.baseUrl,
        nativeApiUrl: choice.nativeApiUrl,
        labUrl: choice.nativeApiUrl,
        ...(choice.modelId ? { defaultModelId: choice.modelId } : {}),
        ...(choice.workspaceRoot ? { workspaceRoots: [choice.workspaceRoot] } : {})
      }
      return d.settings.update(patch)
    },

    /* ---- app ---- */
    'app:getBootstrap': async (): Promise<BootstrapPayload> => ({
      settings: d.settings.get(),
      workflows: WORKFLOWS,
      mcpSpecs: d.mcp.specs(),
      mcpStates: d.mcp.states(),
      nativeTools: NATIVE_TOOLS,
      models: d.models.list(),
      conversations: d.conversations.list(),
      health: d.models.health(),
      appVersion: app.getVersion(),
      startWorkflow: WORKFLOWS.some((w) => w.id === process.env['LH_START_WORKFLOW'])
        ? (process.env['LH_START_WORKFLOW'] as WorkflowId)
        : undefined
    }),

    /* ---- settings ---- */
    'settings:get': () => d.settings.get(),
    'settings:update': (patch: Partial<Settings>) => d.settings.update(patch),
    'settings:pickDirectory': async () => {
      const win = d.getWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },

    /* ---- models ---- */
    'models:list': () => d.models.list(),
    'models:refresh': () => d.models.refresh(),
    // load() issues the 1-token completion that triggers LM Studio's JIT load
    // and returns the backend's failure text verbatim. learn() only re-polls
    // /api/v0/models, so it can never make a model resident.
    'models:load': (modelId: string) => d.models.load(modelId),

    /* ---- conversations ---- */
    'conv:list': () => d.conversations.list(),
    'conv:get': (id: string) => d.conversations.get(id),
    'conv:create': (workflowId: WorkflowId) => d.conversations.create(workflowId),
    'conv:delete': (id: string) => {
      d.conversations.delete(id)
    },
    'conv:rename': (id: string, title: string) => {
      d.conversations.rename(id, title)
    },
    'conv:setModel': (id: string, modelId: string | null) => {
      const conv = d.conversations.get(id)
      if (!conv) return
      conv.modelId = modelId
      d.conversations.save(conv)
    },
    'conv:setWorkflow': async (id: string, workflowId: WorkflowId) => {
      const conv = d.conversations.get(id) ?? d.conversations.create(workflowId)
      conv.workflowId = workflowId
      d.conversations.save(conv)
      return conv
    },

    /* ---- chat ---- */
    'chat:send': (req) => d.orchestrator.send(req),
    'chat:continue': (id) => d.orchestrator.continueTurn(id),
    'chat:cancel': (conversationId: string) => {
      d.orchestrator.cancel(conversationId)
    },
    'chat:contextUsage': (conversationId: string) =>
      d.orchestrator.contextUsage(conversationId),
    'chat:attachFiles': async (): Promise<Attachment[]> => {
      const win = d.getWindow()
      const opts: Electron.OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Images', extensions: [...IMAGE_EXT] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (result.canceled) return []

      const out: Attachment[] = []
      for (const path of result.filePaths) {
        const ext = extname(path).slice(1).toLowerCase()
        const isImage = IMAGE_EXT.has(ext)
        const info = await stat(path).catch(() => null)
        if (!info) continue
        let dataUrl: string | undefined
        let tokens = 0
        if (isImage && info.size < 8 * 1024 * 1024) {
          const native = `image/${ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext}`
          /* Converted here rather than at send time: this runs once when the
             file is picked, where a second of sips is invisible, instead of on
             every request that carries the attachment. */
          const wire = WIRE_IMAGE_MIMES.includes(native)
            ? { mime: native, buf: await readFile(path) }
            : await transcodeForWire(path)
          if (wire) dataUrl = `data:${wire.mime};base64,${wire.buf.toString('base64')}`
          // Vision tokens do not track file size; this is the usual ballpark for
          // a full-frame image and is labelled an estimate in the UI.
          tokens = 1200
        } else if (!isImage && info.size < 512 * 1024) {
          const text = await readFile(path, 'utf8').catch(() => '')
          tokens = estimateTokens(text)
        }
        out.push({
          id: `${Date.now()}-${out.length}`,
          kind: isImage ? 'image' : 'file',
          path,
          name: path.split('/').pop() ?? path,
          /* The mime of what will be SENT, which after a conversion is not the
             mime of the file on disk. `path` still points at the original, so
             Open and Reveal are unaffected. */
          mimeType: isImage ? (dataUrl?.slice(5, dataUrl.indexOf(';')) ?? `image/${ext}`) : 'text/plain',
          dataUrl,
          tokens
        })
      }
      return out
    },

    /* ---- mcp ---- */
    'mcp:listSpecs': () => d.mcp.specs(),
    'mcp:listStates': () => d.mcp.states(),
    'settings:setReasoning': (workflowId: WorkflowId, effort: ReasoningEffort) => {
      const current = d.settings.get()
      return d.settings.update({
        workflowReasoning: { ...current.workflowReasoning, [workflowId]: effort }
      })
    },
    /** A sparse patch: only what the user moved is stored, and clearing a
     *  field (undefined) returns that knob to the workflow's default. */
    'settings:setSampling': (workflowId: WorkflowId, patch: Record<string, number | undefined>) => {
      const current = d.settings.get()
      const merged = { ...(current.workflowSampling[workflowId] ?? {}) }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || Number.isNaN(v)) delete (merged as Record<string, unknown>)[k]
        else (merged as Record<string, number>)[k] = v
      }
      return d.settings.update({
        workflowSampling: { ...current.workflowSampling, [workflowId]: merged }
      })
    },
    'mcp:setEnabled': async (
      workflowId: WorkflowId,
      serverId: string,
      enabled: boolean
    ) => {
      const settings = d.settings.get()
      const wf = WORKFLOW_BY_ID[workflowId]
      const current = new Set(
        settings.workflowMcpOverrides[workflowId] ?? wf?.mcpServers ?? []
      )
      if (enabled) current.add(serverId)
      else current.delete(serverId)
      d.settings.update({
        workflowMcpOverrides: {
          ...settings.workflowMcpOverrides,
          [workflowId]: [...current]
        }
      })
      return d.mcp.applySet([...current])
    },
    'mcp:setToolEnabled': (serverId: string, toolName: string, enabled: boolean) =>
      d.mcp.setToolEnabled(serverId, toolName, enabled),
    'mcp:restart': (serverId: string) => d.mcp.restart(serverId),
    'mcp:applyWorkflow': (workflowId: WorkflowId) =>
      d.orchestrator.applyWorkflow(workflowId),

    /* ---- workflows ---- */
    'workflow:list': () => WORKFLOWS,

    /* ---- approvals ---- */
    'approval:respond': (requestId: string, decision) => {
      d.approvals.respond(requestId, decision)
    },
    'approval:pending': () => d.approvals.pending(),

    /* ---- artifacts ---- */
    'artifacts:list': (workflowId: WorkflowId): Artifact[] =>
      d.orchestrator.artifacts(workflowId),
    'artifacts:reveal': (path: string) => {
      shell.showItemInFolder(path)
    },

    /* A real context menu, built in main.
     *
     * Rendering one in the renderer means reimplementing native behaviour —
     * dismissal, keyboard, screen edges, the platform's own look — and getting
     * it subtly wrong. This is a right-click on a file, which macOS has had an
     * answer for since before the web, so it uses that answer. */
    'files:contextMenu': async (path: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return
      const menu = Menu.buildFromTemplate([
        {
          label: 'Reveal in Finder',
          click: () => shell.showItemInFolder(path)
        },
        {
          label: 'Open',
          click: () => {
            void shell.openPath(path)
          }
        },
        { type: 'separator' },
        {
          label: 'Copy path',
          click: () => clipboard.writeText(path)
        },
        {
          label: 'Copy file name',
          click: () => clipboard.writeText(path.slice(path.lastIndexOf('/') + 1))
        }
      ])
      menu.popup({ window: win })
    },
    'artifacts:open': (path: string) => {
      // A tool result may hand us a URL rather than a path; openExternal handles
      // http(s) and openPath handles the filesystem.
      if (/^https?:\/\//i.test(path)) void shell.openExternal(path)
      else void shell.openPath(path)
    },
    /*
     * Anything the panel can show inline.
     *
     * An allowlist rather than "read whatever is asked for": this hands file
     * bytes to the renderer, and the renderer is the part that runs model
     * output. Each kind carries its own ceiling — a texture ceiling written for
     * the edit pipeline is the wrong number for a WAV, and one number for both
     * is wrong for one of them.
     */
    'artifacts:preview': async (path: string) => {
      if (/^https?:\/\//i.test(path)) return null
      const ext = extname(path).slice(1).toLowerCase()
      const kind = PREVIEWABLE[ext]
      if (!kind) return null
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile() || info.size > kind.max) return null
      /*
       * A PDF comes back as a picture of its first page.
       *
       * Chromium's own viewer is not usable here: <embed> and <iframe> both
       * load the blob without complaint and paint nothing, in a packaged build,
       * with plugins enabled and navigator.pdfViewerEnabled true. There is no
       * error anywhere to distinguish that from a corrupt file — verified the
       * bytes were a valid 73KB %PDF-1.4 with the right blob type, and it still
       * rendered an empty rectangle.
       *
       * sips is part of macOS, this app is macOS-only, and one page is a real
       * preview for a sidebar. The full document is one click away in Preview,
       * which is the better place to read it anyway.
       */
      if (kind.mime === 'application/pdf') {
        const png = await renderPdfFirstPage(path)
        if (!png) return null
        return {
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
          mime: 'image/png',
          bytes: info.size,
          renderedFrom: 'pdf'
        }
      }
      const buf = await readFile(path).catch(() => null)
      if (!buf) return null
      return {
        dataUrl: `data:${kind.mime};base64,${buf.toString('base64')}`,
        mime: kind.mime,
        bytes: info.size
      }
    },
    'artifacts:readDataUrl': async (path: string) => {
      const ext = extname(path).slice(1).toLowerCase()
      if (!IMAGE_EXT.has(ext)) return null
      const info = await stat(path).catch(() => null)
      // Same ceiling the edit pipeline enforces, so a file it accepts can always
      // be re-read for display. These drifting apart made 16-32MB sources render
      // once and then show as broken on the next state push.
      if (!info || info.size > MAX_IMAGE_BYTES) return null
      const buf = await readFile(path).catch(() => null)
      if (!buf) return null
      const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext
      return `data:image/${mime};base64,${buf.toString('base64')}`
    },

    /* ---- telemetry ---- */
    'telemetry:health': () => d.models.health(),
    'telemetry:history': () => d.lab.history(),

    /* ---- remote model control ---- */
    'control:state': () => d.control.state(),
    'control:refresh': () => d.control.refresh(),
    'control:load': async (modelKey: string, options) => {
      const result = await d.control.load(modelKey, options)
      // A load changes the real context window, so the model registry's learned
      // value is now stale for this model. Re-observe before the next turn
      // computes a context meter against it.
      if (result.ok) await d.models.refresh().catch(() => undefined)
      return result
    },
    'control:unload': async (identifier: string) => {
      const result = await d.control.unload(identifier)
      if (result.ok) await d.models.refresh().catch(() => undefined)
      return result
    },
    'control:cancelLoad': () => d.control.cancelLoad(),
    'control:getConfig': (identifier: string) => d.control.getConfig(identifier),

    /* ---- image editing ---- */
    'edit:list': () => d.edit.list(),
    'edit:pickSources': async () => {
      const win = d.getWindow()
      const opts: Electron.OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: EDIT_SOURCE_EXT }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (result.canceled) return []
      const jobs: EditJob[] = []
      for (const path of result.filePaths) {
        const job = await d.edit.createFromPath(path)
        if (job) jobs.push(job)
      }
      return jobs
    },
    'edit:createFromPath': (path: string, parentId?: string) =>
      d.edit.createFromPath(path, parentId),
    'edit:setInstruction': (jobId: string, instruction: string) =>
      d.edit.setInstruction(jobId, instruction),
    'edit:setParams': (jobId: string, params) => d.edit.setParams(jobId, params),
    'edit:refine': (jobId: string) => d.edit.refine(jobId),
    'edit:setPrompt': (jobId: string, prompt: string) => d.edit.setPrompt(jobId, prompt),
    'edit:apply': (jobId: string) => d.edit.apply(jobId),
    'edit:cancel': (jobId: string) => d.edit.cancel(jobId),
    'edit:delete': (jobId: string) => {
      d.edit.delete(jobId)
      // The contract declares this event and the store handles it; without the
      // emission the store's optimistic removal was the only thing working, so
      // a failed delete cleared the row locally and it came back on restart.
      d.emit('event:editJobDeleted', { jobId })
    },

    /* ---- live code workspace ---- */
    'code:activity': (conversationId: string) => d.activity.activity(conversationId),
    'code:touched': (conversationId: string) => d.activity.touchedFiles(conversationId),
    'code:readFile': async (path: string) => {
      // Same sandbox as every other path the agent can reach — the viewer must
      // not become a way to read outside the workspace roots.
      const roots = d.settings.get().workspaceRoots
      if (!isInsideAny(path, roots)) return null
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile()) return null
      const MAX = 2 * 1024 * 1024
      const buf = await readFile(path, 'utf8').catch(() => null)
      if (buf === null) return null
      return info.size > MAX
        ? { content: buf.slice(0, MAX), truncated: true }
        : { content: buf, truncated: false }
    },

    /* ---- live voice/video ---- */
    'live:start': (conversationId: string) => d.live.start(conversationId),
    'live:stop': () => d.live.stop(),
    'live:status': () => d.live.status(),
    'live:settings': () => d.live.settings(),
    'live:updateSettings': (patch) => d.live.updateSettings(patch),
    'live:utterance': (pcm: ArrayBuffer, sampleRate: number, frameDataUrl?: string) =>
      d.live.utterance(pcm, sampleRate, frameDataUrl),
    'live:interrupt': () => d.live.interrupt(),
    'live:exchanges': () => d.live.exchanges(),
    'live:voices': () => d.live.voices(),

    /* ---- file tree ---- */
    'code:listDir': async (path: string) => {
      // Same sandbox as every other path: the tree must not become a way to
      // browse outside the workspace roots.
      const roots = d.settings.get().workspaceRoots
      if (!isInsideAny(path, roots)) return []
      const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
      if (entries === null) return []

      // Two bounds, both real. node_modules can hold tens of thousands of
      // entries, and the tree deliberately lets you open it: without a cap that
      // is a huge structured-clone across IPC. And `stat` per entry, awaited in
      // sequence, was one round trip each — size and mtime only feed a tooltip,
      // so the Dirent's own isDirectory() is enough and stat is skipped.
      const out: DirEntry[] = []
      for (const e of entries) {
        if (out.length >= LIST_DIR_CAP) break
        if (e.name.startsWith('.') && e.name !== '.agents') continue
        out.push({
          name: e.name,
          path: join(path, e.name),
          isDirectory: e.isDirectory(),
          size: 0,
          modifiedAt: 0,
          ignored: IGNORED_DIRS.has(e.name)
        })
      }
      return out.sort((a, b) =>
        a.isDirectory === b.isDirectory
          ? a.name.localeCompare(b.name)
          : a.isDirectory
            ? -1
            : 1
      )
    },

    /* ---- skills ---- */
    'avatars:list': async () => d.avatars.list(),
    'avatars:save': async (avatar) => d.avatars.save(avatar),
    'avatars:delete': async (id) => {
      d.avatars.delete(id)
    },
    'avatars:build': (spec) => d.avatarBuilder.build(spec),
    'avatars:cancelBuild': async () => {
      d.avatarBuilder.cancel()
    },
    'avatars:finish': (id) => d.avatarBuilder.finish(id),

    /* Reference counted in the mirror: several viewers can watch, and the
       stream stops when the last one looks away. */
    'browser:watch': async (on: boolean) => {
      if (on) d.mirror.watch()
      else d.mirror.unwatch()
    },
    'skills:list': () => d.skills.list(),
    'skills:refresh': () => d.skills.refresh(),
    'skills:setEnabled': (path: string, enabled: boolean) =>
      d.skills.setEnabled(path, enabled),
    'skills:read': (path: string) => d.skills.read(path),
    'skills:reveal': (path: string) => {
      shell.showItemInFolder(path)
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (process.env['LH_TRACE_IPC'] === '1') {
        console.log(`[ipc] ${channel} ${JSON.stringify(args).slice(0, 160)}`)
      }
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        // Surface the real message to the renderer rather than Electron's
        // opaque "Error invoking remote method" wrapper.
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`${channel}: ${message}`)
      }
    })
  }

  // Keep the registry honest: every spec the UI can show must be runnable.
  const unknown = MCP_REGISTRY.filter((s) => !s.command)
  if (unknown.length) {
    console.warn('MCP specs missing a command:', unknown.map((s) => s.id).join(', '))
  }
}
