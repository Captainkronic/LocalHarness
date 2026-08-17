/**
 * IPC router.
 *
 * Every channel declared in @shared/ipc is handled here and nowhere else. The
 * handler map is typed against IpcApi, so a channel added to the contract that
 * is not implemented here is a compile error rather than a runtime 'no handler'.
 */

import { dialog, ipcMain, shell, app, BrowserWindow } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import type { IpcApi, BootstrapPayload } from '@shared/ipc'
import type {
  Attachment,
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
  orchestrator: Orchestrator
  getWindow: () => BrowserWindow | null
}

/** Implementations, keyed by channel. Types are enforced against IpcApi. */
type Handlers = {
  [K in keyof IpcApi]: (
    ...args: Parameters<IpcApi[K]>
  ) => ReturnType<IpcApi[K]> | Awaited<ReturnType<IpcApi[K]>>
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

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
      appVersion: app.getVersion()
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
      if (!info || info.size > 16 * 1024 * 1024) return null
      const buf = await readFile(path).catch(() => null)
      if (!buf) return null
      const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext
      return `data:image/${mime};base64,${buf.toString('base64')}`
    },

    /* ---- telemetry ---- */
    'telemetry:health': () => d.models.health(),
    'telemetry:history': () => d.lab.history()
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
