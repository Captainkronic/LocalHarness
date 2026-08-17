/**
 * Electron entry point. Constructs every subsystem, wires the event bus that
 * pushes to the renderer, and owns the window lifecycle.
 */

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import type { LabRecord, LabStatus, McpServerState, ModelInfo, ServerHealth } from '@shared/types'
import { DEFAULT_WORKFLOW } from '@shared/workflows'

import { SettingsStore } from './store/settings'
import { ConversationStore } from './store/conversations'
import { McpManager } from './mcp/manager'
import { ModelRegistry } from './llm/models'
import { LabFeed } from './telemetry/lab'
import { ToolExecutor } from './agent/executor'
import { ApprovalBroker } from './agent/approval'
import { Orchestrator } from './orchestrator'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'

let mainWindow: BrowserWindow | null = null

/** Push to the renderer. Safe before the window exists and after it is gone. */
function emit<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function log(level: 'info' | 'warn' | 'error', scope: string, message: string): void {
  const line = `[${scope}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  emit('event:log', { level, scope, message })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: '#101218',
    // Frameless-with-traffic-lights, the same treatment Claude Code's desktop
    // app and Bionic use. App.tsx leaves 78px of left padding for the buttons.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Never navigate the app window itself; open real links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.adam.localharness')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const userData = app.getPath('userData')

  /* ---- subsystems ---- */
  const settings = new SettingsStore(userData)
  const conversations = new ConversationStore(userData)

  // Note the three-arg shape: LogFn is (level, scope, message). Binding a
  // two-arg function here compiles fine — a shorter function is assignable —
  // but silently swallows every message and logs the scope as the text.
  const mcp = new McpManager({
    onStates: (states: McpServerState[]) => emit('event:mcpStates', states),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const models = new ModelRegistry({
    getSettings: () => settings.get(),
    onModels: (m: ModelInfo[]) => emit('event:models', m),
    onHealth: (h: ServerHealth) => emit('event:health', h)
  })

  const lab = new LabFeed({
    getUrl: () => settings.get().labUrl,
    onRecord: (r: LabRecord) => emit('event:labRecord', r),
    onStatus: (s: LabStatus) => {
      // ServerHealth carries labStatus, and ModelRegistry is what stamps it onto
      // every health push — logging alone would leave the indicator reading
      // "unavailable" while records were visibly arriving.
      models.setLabStatus(s)
      log('info', 'lab', `feed ${s}`)
    }
  })

  const approvals = new ApprovalBroker(
    (req) => emit('event:approvalRequest', req),
    (requestId, decision) => emit('event:approvalResolved', { requestId, decision })
  )

  const executor = new ToolExecutor({
    getSettings: () => settings.get(),
    requestApproval: (req) => approvals.request(req),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const orchestrator = new Orchestrator({
    settings,
    conversations,
    mcp,
    models,
    executor,
    approvals,
    emit
  })

  registerIpc({
    settings,
    conversations,
    mcp,
    models,
    approvals,
    lab,
    orchestrator,
    getWindow: () => mainWindow
  })

  models.start()
  lab.start()

  mainWindow = createWindow()
  buildMenu({
    onNewConversation: () => emit('event:log', { level: 'info', scope: 'menu', message: 'new' }),
    onToggleDevTools: () => mainWindow?.webContents.toggleDevTools(),
    onReload: () => mainWindow?.webContents.reload()
  })

  // Bring up the default workflow's servers once the window exists, so the MCP
  // panel is populated by the time the user looks at it.
  void orchestrator.applyWorkflow(DEFAULT_WORKFLOW).catch((err: unknown) => {
    log('warn', 'mcp', `initial workflow apply failed: ${String(err)}`)
  })

  // Focus drives the model poller's cadence — see the adaptive backoff in
  // ModelRegistry. An unfocused app must not keep polling at the fast interval.
  mainWindow.on('focus', () => models.setActive(true))
  mainWindow.on('blur', () => {
    if (!orchestrator.isBusy()) models.setActive(false)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  const shutdown = async (): Promise<void> => {
    models.stop()
    lab.stop()
    await mcp.shutdown().catch(() => undefined)
  }

  // MCP children are spawned with detached:false, which does NOT kill them when
  // the parent exits, and stop() needs up to 3s per server for its
  // SIGTERM->SIGKILL escalation. Quitting without awaiting that orphans any
  // server that does not exit on stdin EOF, so the quit is held until shutdown
  // finishes and then forced.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void shutdown().finally(() => app.exit(0))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
})
