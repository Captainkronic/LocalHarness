/**
 * IPC router.
 *
 * Every channel declared in @shared/ipc is handled here and nowhere else. The
 * handler map is typed against IpcApi, so a channel added to the contract that
 * is not implemented here is a compile error rather than a runtime 'no handler'.
 */

import { dialog, ipcMain, shell, app, BrowserWindow } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

import type {
  IpcApi,
  BootstrapPayload,
  IpcEventChannel,
  IpcEvents
} from '@shared/ipc'
import { EDIT_IMAGE_EXTENSIONS } from '@shared/types'
import type {
  Attachment,
  DirEntry,
  EditJob,
  ModelInfo,
  Settings,
  WorkflowId,
  Artifact
} from '@shared/types'
import { WORKFLOWS, WORKFLOW_BY_ID } from '@shared/workflows'

import type { SettingsStore } from './store/settings'
import type { ConversationStore } from './store/conversations'
import type { McpManager } from './mcp/manager'
import type { ModelRegistry } from './llm/models'
import type { ApprovalBroker } from './agent/approval'
import type { LabFeed } from './telemetry/lab'
import type { LmStudioControl } from './llm/control'
import type { EditPipeline } from './edit/pipeline'
import { MAX_IMAGE_BYTES } from './edit/pipeline'
import type { ActivityTracker } from './agent/activity'
import type { SkillRegistry } from './skills/registry'
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
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

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

export function registerIpc(d: IpcDeps): void {
  const handlers: Handlers = {
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
          const buf = await readFile(path)
          const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext
          dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`
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
          mimeType: isImage ? `image/${ext}` : 'text/plain',
          dataUrl,
          tokens
        })
      }
      return out
    },

    /* ---- mcp ---- */
    'mcp:listSpecs': () => d.mcp.specs(),
    'mcp:listStates': () => d.mcp.states(),
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
    'artifacts:open': (path: string) => {
      // A tool result may hand us a URL rather than a path; openExternal handles
      // http(s) and openPath handles the filesystem.
      if (/^https?:\/\//i.test(path)) void shell.openExternal(path)
      else void shell.openPath(path)
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
