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
  Skill,
  LabStatus,
  LoadProgress,
  McpServerState,
  ModelInfo,
  ServerHealth
} from '@shared/types'

import { SettingsStore } from './store/settings'
import { ConversationStore } from './store/conversations'
import { ArtifactStore } from './store/artifacts'
import { AvatarStore } from './store/avatars'
import { AvatarBuilder } from './live/avatar-builder'
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
import { SkillRegistry } from './skills/registry'
import { BrowserMirror } from './browser/mirror'
import { MCP_BY_ID } from '@shared/mcp-registry'
import { Orchestrator } from './orchestrator'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { createTray, type TrayHandle } from './tray'
import { setupScreenshots } from './screenshot'

let mainWindow: BrowserWindow | null = null

let tray: TrayHandle | null = null

/** Push to the renderer. Safe before the window exists and after it is gone. */
function emitToWindow<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/**
 * Everything main tells the renderer passes through here, so the tray can watch
 * the same traffic instead of needing its own accessors.
 *
 * That matters for one field in particular: LiveMetrics lives on
 * Orchestrator.active.meter, which is private with no getter. Rather than open
 * the orchestrator up or add an IPC method, the tray reads the snapshot already
 * flowing past at ~4Hz — one wrapper, and no second source of truth that could
 * disagree with the in-app HUD.
 */
function emit<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  emitToWindow(channel, payload)
  tray?.observe(channel, payload)
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

  // Screenshot hooks. LH_CODE_MODE picks which half of the Code workflow is
  // shown; LH_LIVE_STATE pins a call state that a real turn passes through in
  // a fraction of a second. Both exist so the driver can photograph a state
  // without clicking, and neither does anything unless set.
  const query: Record<string, string> = {}
  const codeMode = process.env['LH_CODE_MODE']
  const liveState = process.env['LH_LIVE_STATE']
  const avatarBuilder = process.env['LH_AVATAR_BUILDER']
  if (codeMode) query['codeMode'] = codeMode
  if (liveState) query['liveState'] = liveState
  if (avatarBuilder) query['avatarBuilder'] = avatarBuilder

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      query: Object.keys(query).length > 0 ? query : undefined
    })
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
  const artifacts = new ArtifactStore(userData)
  const avatars = new AvatarStore(userData)
  // Said out loud rather than dropped quietly: the only entries this removes
  // are ones whose file the user deleted themselves, and a gallery that
  // silently shrinks is indistinguishable from one that lost your work.
  const prunedArtifacts = artifacts.takePrunedCount()
  if (prunedArtifacts > 0) {
    log('info', 'artifacts',
      `dropped ${prunedArtifacts} gallery entr${prunedArtifacts === 1 ? 'y' : 'ies'} whose file is gone`)
  }

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
    onHealth: (h: ServerHealth) => emit('event:health', h),
    onLog: (level, scope, message) => log(level, scope, message)
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

  // Skills are near-free by design: only name + description reach the prompt,
  // and the body is read on demand through the use_skill tool.
  const skills = new SkillRegistry({
    getSettings: () => settings.get(),
    onSkills: (list: Skill[]) => emit('event:skills', list),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  /* The live browser view. Nothing runs until the Browser tab is on screen —
     see BrowserMirror: an idle mirror on a 60fps canvas is a lot of JPEG for
     nobody. The port is the one the playwright server was given. */
  const mirror = new BrowserMirror({
    getPort: () => Number(MCP_BY_ID['playwright']?.env?.['PWMCP_PORT'] ?? 9333),
    onFrame: (frame) => emit('event:browserFrame', frame),
    onStatus: (status) => emit('event:browserMirror', { status }),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const activity = new ActivityTracker({
    onActivity: (a) => emit('event:fileActivity', a),
    getRoots: () => settings.get().workspaceRoots
  })

  const executor = new ToolExecutor({
    getSettings: () => settings.get(),
    requestApproval: (req) => approvals.request(req),
    onLog: (level, scope, message) => log(level, scope, message),
    onActivity: (input) => activity.record(input),
    // Enabled skills only: a disabled skill is not in play, so its folder is
    // not readable either. Recomputed per call so toggling one takes effect
    // immediately rather than at the next restart.
    readOnlyRoots: () => skills.list().filter((s) => s.enabled).map((s) => s.dir)
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
    mcp,
    conversations,
    getSettings: () => settings.get(),
    onStatus: (s: LiveSessionStatus) => emit('event:liveStatus', s),
    onAudio: (c: LiveAudioChunk) => emit('event:liveAudio', c),
    onExchange: (e: LiveExchange) => emit('event:liveExchange', e),
    // The same channel the Orchestrator uses, so the instrument strip does not
    // care which kind of turn is running — it just stops being idle.
    onMetrics: (m) => emit('event:liveMetrics', m),
    onLog: (level, scope, message) => log(level, scope, message)
  })

  const orchestrator = new Orchestrator({
    settings,
    conversations,
    mcp,
    models,
    executor,
    approvals,
    skills,
    control,
    artifacts,
    emit
  })

  const avatarBuilder = new AvatarBuilder({
    store: avatars,
    onProgress: (p) => emit('event:avatarBuild', p),
    onLog: log
  })

  registerIpc({
    mirror,
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
    skills,
    avatars,
    avatarBuilder,
    orchestrator,
    getWindow: () => mainWindow,
    emit
  })

  models.start()
  lab.start()
  control.start()
  skills.start()

  mainWindow = createWindow()
  tray = createTray({
    onOpen: () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
      mainWindow.show()
      mainWindow.focus()
    },
    onNewConversation: () => emit('event:menuCommand', { command: 'newConversation' }),
    residentModelId: () => models.residentModelId(),
    contextWindow: (id) => models.contextWindow(id),
    unloadModel: (id) => {
      void control.unload(id).catch((err: unknown) => {
        log('warn', 'tray', `could not unload ${id}: ${String(err)}`)
      })
    }
  })

  buildMenu({
    // Was a log line and nothing else, so File > New Conversation had never
    // done anything — it looked wired because the menu item existed.
    onNewConversation: () => emit('event:menuCommand', { command: 'newConversation' }),
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
    // Before the subsystems it observes go away, or it repaints against a
    // half-torn-down app on the way out.
    tray?.destroy()
    tray = null
    models.stop()
    lab.stop()
    control.stop()
    skills.stop()
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
  // Closing the window does not quit on macOS, so without this a live session
  // kept the microphone open and the speech models resident with nothing on
  // screen — and an audio feedback loop, once started, had no way to be seen or
  // stopped. A call belongs to the window that started it.
  mainWindow.on('close', () => {
    void live.stop().catch(() => undefined)
  })

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
