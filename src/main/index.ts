/**
 * Electron entry point. Constructs every subsystem, wires the event bus that
 * pushes to the renderer, and owns the window lifecycle.
 */

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import type {
  ControlState,
  EditJob,
  LabRecord,
  LiveAudioChunk,
  LiveExchange,
  LiveSessionStatus,
  LabStatus,
  LoadProgress,
  McpServerState,
  ModelInfo,
  ServerHealth
} from '@shared/types'

import { SettingsStore } from './store/settings'
import { ConversationStore } from './store/conversations'
import { McpManager } from './mcp/manager'
import { ModelRegistry } from './llm/models'
import { LabFeed } from './telemetry/lab'
import { LmStudioControl } from './llm/control'
import { LiveSession } from './live/session'
import { SpeechServices } from './live/speech'
import { EditPipeline } from './edit/pipeline'
import { EditJobStore } from './edit/store'
import { ToolExecutor } from './agent/executor'
import { ApprovalBroker } from './agent/approval'
import { ActivityTracker } from './agent/activity'
import { Orchestrator } from './orchestrator'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { setupScreenshots } from './screenshot'

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

  // The Live workflow needs the mic and camera. Electron denies media requests
  // by default, and a denial surfaces in the renderer as a generic
  // NotAllowedError that looks identical to the user refusing — so grant these
  // two explicitly and refuse everything else rather than passing through.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => permission === 'media')

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

  // Model control needs a DIRECT websocket to LM Studio's own port — the relay
  // in front of it cannot perform an upgrade. Entirely optional: if it cannot
  // connect it reports 'unavailable' and nothing else in the app is affected.
  const control = new LmStudioControl({
    getSettings: () => settings.get(),
    onState: (s: ControlState) => emit('event:controlState', s),
    onProgress: (p: LoadProgress) => emit('event:loadProgress', p),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const approvals = new ApprovalBroker(
    (req) => emit('event:approvalRequest', req),
    (requestId, decision) => emit('event:approvalResolved', { requestId, decision })
  )

  const activity = new ActivityTracker({
    onActivity: (a) => emit('event:fileActivity', a),
    getRoots: () => settings.get().workspaceRoots
  })

  const executor = new ToolExecutor({
    getSettings: () => settings.get(),
    requestApproval: (req) => approvals.request(req),
    onLog: (level, scope, message) => log(level, scope, message),
    onActivity: (input) => activity.record(input)
  })

  // The Edit workflow is a deterministic refine-then-render pipeline rather than
  // a tool-calling turn, so it is composed here alongside the orchestrator, not
  // inside it.
  const edit = new EditPipeline({
    store: new EditJobStore(userData),
    mcp,
    models,
    getSettings: () => settings.get(),
    onJob: (job: EditJob) => emit('event:editJob', job),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  // Speech runs on THIS Mac, not the Studio: LM Studio's API rejects audio
  // content parts, so hearing has to happen locally and arrive as text.
  const speech = new SpeechServices({
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const live = new LiveSession({
    speech,
    models,
    conversations,
    getSettings: () => settings.get(),
    onStatus: (s: LiveSessionStatus) => emit('event:liveStatus', s),
    onAudio: (c: LiveAudioChunk) => emit('event:liveAudio', c),
    onExchange: (e: LiveExchange) => emit('event:liveExchange', e),
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
    control,
    edit,
    activity,
    live,
    orchestrator,
    getWindow: () => mainWindow,
    emit
  })

  models.start()
  lab.start()
  control.start()

  mainWindow = createWindow()
  buildMenu({
    onNewConversation: () => emit('event:log', { level: 'info', scope: 'menu', message: 'new' }),
    onToggleDevTools: () => mainWindow?.webContents.toggleDevTools(),
    onReload: () => mainWindow?.webContents.reload()
  })

  // Deliberately NOT applying a workflow here. Main does not know which
  // workflow the user is actually in — that comes from the last conversation,
  // which only the renderer resolves during bootstrap. Starting DEFAULT_WORKFLOW
  // speculatively spawned one set of servers and had the renderer kill them and
  // spawn another a few hundred ms later; comfy-image was observed starting and
  // being SIGTERMed three times before the app had painted. The renderer's
  // bootstrap owns the first and only apply.

  // Focus drives the model poller's cadence — see the adaptive backoff in
  // ModelRegistry. An unfocused app must not keep polling at the fast interval.
  setupScreenshots(() => mainWindow, log)

  mainWindow.on('focus', () => {
    models.setActive(true)
    control.setActive(true)
  })
  mainWindow.on('blur', () => {
    if (orchestrator.isBusy()) return
    models.setActive(false)
    // Without this the control client's 30s resident-set poll kept hitting the
    // Studio behind an unfocused window — the same discipline the model poller
    // already follows.
    control.setActive(false)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  const shutdown = async (): Promise<void> => {
    models.stop()
    lab.stop()
    control.stop()
    await live.stop().catch(() => undefined)
    // SpeechServices owns its own McpClient rather than going through
    // McpManager, so mcp.shutdown() does not reach it and it must be stopped
    // explicitly. Without this a Python process holding Kokoro and
    // whisper-large-v3-turbo — several GB — outlives every quit, because MCP
    // children are spawned detached:false, which does NOT kill them with the
    // parent.
    await speech.stop().catch(() => undefined)
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
