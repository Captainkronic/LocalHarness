/**
 * The single renderer store.
 *
 * Everything the UI reads lives here; every write to the main process goes
 * through one of the actions below. Components select narrowly
 * (`useStore(s => s.live)`) so a 4Hz telemetry push does not re-render the chat.
 *
 * Two invariants worth keeping:
 *  - No IPC call is allowed to throw into React. Every `invoke` goes through
 *    `call`, which logs the failure and returns null, so a dead main process
 *    degrades the UI instead of blanking it.
 *  - Event subscriptions are registered exactly once, for the app's lifetime.
 *    React StrictMode mounts twice in dev, so `bootstrap` is memoised on its
 *    own promise rather than guarded by a boolean.
 */

import { create } from 'zustand'

import {
  IPC_EVENT_CHANNELS,
  type IpcApi,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEvents
} from '@shared/ipc'
import { DEFAULT_WORKFLOW, WORKFLOWS } from '@shared/workflows'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  Attachment,
  ContextUsage,
  ControlState,
  Conversation,
  ConversationSummary,
  EditJob,
  EditParams,
  FileActivity,
  LabRecord,
  LiveMetrics,
  LoadOptions,
  McpServerSpec,
  McpServerState,
  ModelInfo,
  NativeToolInfo,
  ServerHealth,
  Settings,
  WorkflowDefinition,
  WorkflowId
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  level: string
  scope: string
  message: string
  at: number
}

export interface AppState {
  ready: boolean
  settings: Settings
  workflows: WorkflowDefinition[]
  activeWorkflow: WorkflowId
  conversations: ConversationSummary[]
  activeConversationId: string | null
  conversation: Conversation | null
  models: ModelInfo[]
  mcpSpecs: McpServerSpec[]
  mcpStates: McpServerState[]
  nativeTools: NativeToolInfo[]
  live: LiveMetrics
  control: ControlState
  editJobs: EditJob[]
  /** Live filesystem effects for the Code workspace, newest last. */
  fileActivity: FileActivity[]
  usage: ContextUsage
  health: ServerHealth
  labHistory: LabRecord[]
  approvals: ApprovalRequest[]
  artifacts: Artifact[]
  logs: LogEntry[]
  // actions
  bootstrap(): Promise<void>
  send(text: string, attachments?: Attachment[]): Promise<void>
  cancel(): void
  selectWorkflow(id: WorkflowId): Promise<void>
  selectConversation(id: string): Promise<void>
  newConversation(): Promise<void>
  deleteConversation(id: string): Promise<void>
  setMcpEnabled(serverId: string, enabled: boolean): Promise<void>
  /* remote model control */
  refreshControl(): Promise<void>
  loadModel(modelKey: string, options: LoadOptions): Promise<{ ok: boolean; error?: string }>
  unloadModel(identifier: string): Promise<{ ok: boolean; error?: string }>
  cancelLoad(): Promise<void>
  /* image editing */
  pickEditSources(): Promise<void>
  createEditFromPath(path: string, parentId?: string): Promise<void>
  setEditInstruction(id: string, text: string): Promise<void>
  setEditParams(id: string, params: Partial<EditParams>): Promise<void>
  setEditPrompt(id: string, text: string): Promise<void>
  refineEdit(id: string): Promise<void>
  applyEdit(id: string): Promise<void>
  cancelEdit(id: string): Promise<void>
  deleteEdit(id: string): Promise<void>
  readImageDataUrl(path: string): Promise<string | null>
  respondApproval(id: string, decision: ApprovalDecision): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Initial values                                                      */
/* ------------------------------------------------------------------ */

const LOG_CAP = 300
const LAB_CAP = 200
/** File activity is high-frequency during an agentic run; the workspace only
 *  ever renders a recent window of it. */
const ACTIVITY_CAP = 400

/** Placeholder only — replaced wholesale by the real settings in `bootstrap`,
 *  which lands within a frame or two of first paint. */
const INITIAL_SETTINGS: Settings = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  nativeApiUrl: 'http://127.0.0.1:1234',
  labUrl: '',
  apiKey: '',
  defaultModelId: null,
  approvalMode: 'always_ask',
  workspaceRoots: [],
  shellAllowlist: [],
  contextWarnFraction: 0.8,
  theme: 'system',
  modelPollMs: 15_000,
  workflowMcpOverrides: {}
}

const IDLE_LIVE: LiveMetrics = {
  phase: 'idle',
  modelId: null,
  elapsedMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  ttftMs: null,
  prefillTps: null,
  prefillEstimated: true,
  prefillProgress: null,
  prefillEtaMs: null,
  decodeTps: null
}

/** Model control is optional; until the websocket connects it reports
 *  'disconnected' rather than pretending there is nothing on the server. */
const INITIAL_CONTROL: ControlState = {
  status: 'disconnected',
  url: '',
  loaded: [],
  catalog: [],
  inFlight: null,
  lastRefreshedAt: 0
}

const EMPTY_USAGE: ContextUsage = {
  used: 0,
  max: null,
  breakdown: { system: 0, tools: 0, messages: 0, attachments: 0 },
  fraction: null
}

const INITIAL_HEALTH: ServerHealth = {
  endpoint: INITIAL_SETTINGS.baseUrl,
  reachable: false,
  latencyMs: null,
  residentModelId: null,
  labStatus: 'disconnected',
  lastCheckedAt: 0
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === 'string') return m
  }
  return 'unknown error'
}

/** Handlers keyed by channel, so omitting one is a compile error. */
type EventHandlerMap = { [K in IpcEventChannel]: (payload: IpcEvents[K]) => void }

/**
 * The map above guarantees each handler matches its channel's payload, but that
 * correspondence is not expressible once the key is only known as the union, so
 * registration goes through one erased signature. `never` in the listener
 * position is what makes every concrete handler assignable here.
 */
type ErasedOn = (
  channel: IpcEventChannel,
  listener: (payload: never) => void
) => () => void

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useStore = create<AppState>()((set, get) => {
  /** Held for the app's lifetime; the subscriptions are never torn down while
   *  the window is alive, but the handles are kept rather than dropped. */
  let unsubscribers: Array<() => void> = []
  let bootstrapPromise: Promise<void> | null = null

  const pushLog = (level: LogEntry['level'], scope: string, message: string): void => {
    set((s) => ({
      logs: [...s.logs, { level, scope, message, at: Date.now() }].slice(-LOG_CAP)
    }))
  }

  /** Every main-process call funnels through here. Returns null on failure. */
  const call = async <K extends IpcChannel>(
    scope: string,
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): Promise<Awaited<ReturnType<IpcApi[K]>> | null> => {
    try {
      return await window.harness.invoke(channel, ...args)
    } catch (err) {
      pushLog('error', scope, `${channel} failed: ${errorMessage(err)}`)
      return null
    }
  }

  const refreshUsage = async (conversationId: string): Promise<void> => {
    const usage = await call('context', 'chat:contextUsage', conversationId)
    if (usage && get().activeConversationId === conversationId) set({ usage })
  }

  /** Bring the main process in line with a workflow: MCP set + its artifacts. */
  const applyWorkflow = async (id: WorkflowId): Promise<void> => {
    const states = await call('mcp', 'mcp:applyWorkflow', id)
    if (states) set({ mcpStates: states })
    const artifacts = await call('artifacts', 'artifacts:list', id)
    if (artifacts && get().activeWorkflow === id) set({ artifacts })
  }

  const loadConversation = async (id: string, applyMcp: boolean): Promise<void> => {
    const conv = await call('conv', 'conv:get', id)
    if (!conv) return
    const workflowChanged = get().activeWorkflow !== conv.workflowId
    set({
      conversation: conv,
      activeConversationId: conv.id,
      activeWorkflow: conv.workflowId,
      usage: EMPTY_USAGE
    })
    await refreshUsage(conv.id)
    if (applyMcp && workflowChanged) await applyWorkflow(conv.workflowId)
  }

  const ensureConversation = async (workflowId?: WorkflowId): Promise<string | null> => {
    const existing = get().activeConversationId
    if (existing) return existing
    const conv = await call('conv', 'conv:create', workflowId ?? get().activeWorkflow)
    if (!conv) return null
    set({
      conversation: conv,
      activeConversationId: conv.id,
      activeWorkflow: conv.workflowId,
      usage: EMPTY_USAGE
    })
    return conv.id
  }

  /* ---- event handlers ------------------------------------------- */

  const handlers: EventHandlerMap = {
    'event:conversationUpdated': (conv) => {
      const active = get().activeConversationId
      // Adopt when nothing is selected yet; otherwise only the active thread
      // is allowed to overwrite what is on screen.
      if (active === null || active === conv.id) {
        set({ conversation: conv, activeConversationId: conv.id })
      }
    },
    'event:conversationList': (conversations) => set({ conversations }),
    'event:liveMetrics': (live) => set({ live }),
    'event:contextUsage': ({ conversationId, usage }) => {
      if (conversationId === get().activeConversationId) set({ usage })
    },
    'event:mcpStates': (mcpStates) => set({ mcpStates }),
    'event:models': (models) => set({ models }),
    'event:health': (health) => set({ health }),
    'event:labRecord': (record) =>
      set((s) => ({ labHistory: [...s.labHistory, record].slice(-LAB_CAP) })),
    'event:approvalRequest': (req) =>
      set((s) =>
        s.approvals.some((a) => a.id === req.id) ? {} : { approvals: [...s.approvals, req] }
      ),
    'event:approvalResolved': ({ requestId }) =>
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== requestId) })),
    'event:artifact': (artifact) =>
      set((s) =>
        s.artifacts.some((a) => a.id === artifact.id)
          ? {}
          : { artifacts: [...s.artifacts, artifact] }
      ),
    'event:log': (entry) =>
      set((s) => ({
        logs: [...s.logs, { ...entry, at: Date.now() }].slice(-LOG_CAP)
      })),
    'event:editJob': (job) =>
      set((s) => {
        const i = s.editJobs.findIndex((j) => j.id === job.id)
        if (i === -1) return { editJobs: [job, ...s.editJobs] }
        const next = s.editJobs.slice()
        next[i] = job
        return { editJobs: next }
      }),
    'event:editJobDeleted': ({ jobId }) =>
      set((s) => ({ editJobs: s.editJobs.filter((j) => j.id !== jobId) })),
    'event:fileActivity': (activity) =>
      set((s) => ({ fileActivity: [...s.fileActivity, activity].slice(-ACTIVITY_CAP) })),
    'event:controlState': (control) => set({ control }),
    // Progress arrives far more often than the full state; merging it in keeps
    // the load bar smooth without re-rendering the whole catalog each tick.
    'event:loadProgress': (inFlight) =>
      set((s) => ({ control: { ...s.control, inFlight } }))
  }

  const subscribe = (): void => {
    if (unsubscribers.length > 0) return
    try {
      const on = window.harness.on as unknown as ErasedOn
      unsubscribers = IPC_EVENT_CHANNELS.map((channel) => on(channel, handlers[channel]))
    } catch (err) {
      pushLog('error', 'ipc', `subscribe failed: ${errorMessage(err)}`)
    }
  }

  /* ---- bootstrap -------------------------------------------------- */

  const doBootstrap = async (): Promise<void> => {
    const boot = await call('bootstrap', 'app:getBootstrap')
    if (boot) {
      set({
        settings: boot.settings,
        workflows: boot.workflows.length > 0 ? boot.workflows : WORKFLOWS,
        mcpSpecs: boot.mcpSpecs,
        mcpStates: boot.mcpStates,
        nativeTools: boot.nativeTools,
        models: boot.models,
        conversations: boot.conversations,
        health: boot.health
      })
    }

    subscribe()

    // Reopen whatever was last touched, so a restart lands where you left off.
    const latest = get().conversations.reduce<ConversationSummary | null>(
      (best, c) => (best === null || c.updatedAt > best.updatedAt ? c : best),
      null
    )
    if (latest) await loadConversation(latest.id, false)

    const [history, pending, control, editJobs] = await Promise.all([
      call('lab', 'telemetry:history'),
      call('approval', 'approval:pending'),
      call('control', 'control:state'),
      call('edit', 'edit:list')
    ])
    if (history) set({ labHistory: history.slice(-LAB_CAP) })
    if (pending) set({ approvals: pending })
    if (control) set({ control })
    if (editJobs) set({ editJobs })

    // The UI comes up even if any of the above failed; the failures are in the
    // log rather than on a blank screen.
    set({ ready: true })

    // Idempotent by contract: starts what this workflow needs, stops the rest.
    void applyWorkflow(get().activeWorkflow)
  }

  return {
    ready: false,
    settings: INITIAL_SETTINGS,
    workflows: WORKFLOWS,
    activeWorkflow: DEFAULT_WORKFLOW,
    conversations: [],
    activeConversationId: null,
    conversation: null,
    models: [],
    mcpSpecs: [],
    mcpStates: [],
    nativeTools: [],
    live: IDLE_LIVE,
    control: INITIAL_CONTROL,
    editJobs: [],
    fileActivity: [],
    usage: EMPTY_USAGE,
    health: INITIAL_HEALTH,
    labHistory: [],
    approvals: [],
    artifacts: [],
    logs: [],

    bootstrap: () => {
      // StrictMode mounts the app twice in dev; one bootstrap is enough.
      if (bootstrapPromise === null) bootstrapPromise = doBootstrap()
      return bootstrapPromise
    },

    send: async (text, attachments) => {
      const hasAttachments = attachments !== undefined && attachments.length > 0
      if (text.trim().length === 0 && !hasAttachments) return
      const conversationId = await ensureConversation()
      if (!conversationId) return
      const res = await call('chat', 'chat:send', {
        conversationId,
        content: text,
        attachments
      })
      if (res && !res.ok) pushLog('error', 'chat', res.error ?? 'Send failed')
    },

    cancel: () => {
      const id = get().activeConversationId
      if (!id) return
      void call('chat', 'chat:cancel', id)
    },

    selectWorkflow: async (id) => {
      // Flip the chrome first: starting an MCP server can take seconds and the
      // rail must not sit on the old workflow while that happens.
      set({ activeWorkflow: id })
      const conversationId = await ensureConversation(id)
      if (conversationId && get().conversation?.workflowId !== id) {
        const conv = await call('workflow', 'conv:setWorkflow', conversationId, id)
        if (conv) set({ conversation: conv, activeConversationId: conv.id })
      }
      await applyWorkflow(id)
      const current = get().activeConversationId
      if (current) await refreshUsage(current)
    },

    selectConversation: async (id) => {
      if (get().activeConversationId === id) return
      await loadConversation(id, true)
    },

    /**
     * Main's `conv:delete` removes the file and emits nothing, so the list has
     * to be re-read here. Deleting the ACTIVE conversation is the case that
     * mattered: leaving activeConversationId pointing at a deleted id made
     * every later send fail with "Conversation not found" into a log panel
     * nothing renders — the composer just cleared and nothing happened.
     */
    deleteConversation: async (id) => {
      await call('conv', 'conv:delete', id)
      const list = (await call('conv', 'conv:list')) ?? []
      set({ conversations: list })
      if (get().activeConversationId !== id) return
      const next = list[0]
      if (next) {
        await loadConversation(next.id, true)
      } else {
        set({ conversation: null, activeConversationId: null, usage: EMPTY_USAGE })
      }
    },

    newConversation: async () => {
      const conv = await call('conv', 'conv:create', get().activeWorkflow)
      if (!conv) return
      set({
        conversation: conv,
        activeConversationId: conv.id,
        activeWorkflow: conv.workflowId,
        usage: EMPTY_USAGE
      })
      const list = await call('conv', 'conv:list')
      if (list) set({ conversations: list })
      await refreshUsage(conv.id)
    },

    refreshControl: async () => {
      const control = await call('control', 'control:refresh')
      if (control) set({ control })
    },

    loadModel: async (modelKey, options) => {
      const result = await call('control', 'control:load', modelKey, options)
      if (!result) return { ok: false, error: 'The load request did not reach the server.' }
      // A load changes the real context window, so the meter's denominator moves.
      const current = get().activeConversationId
      if (current) await refreshUsage(current)
      return result
    },

    unloadModel: async (identifier) => {
      const result = await call('control', 'control:unload', identifier)
      if (!result) return { ok: false, error: 'The unload request did not reach the server.' }
      const current = get().activeConversationId
      if (current) await refreshUsage(current)
      return result
    },

    cancelLoad: async () => {
      await call('control', 'control:cancelLoad')
    },

    /* --- image editing ------------------------------------------------ */
    // Every mutation returns the updated job AND main pushes event:editJob, so
    // these deliberately do not set state themselves — the event handler is the
    // single writer, which keeps optimistic and pushed state from diverging.
    pickEditSources: async () => {
      await call('edit', 'edit:pickSources')
    },
    createEditFromPath: async (path, parentId) => {
      await call('edit', 'edit:createFromPath', path, parentId)
    },
    setEditInstruction: async (id, text) => {
      await call('edit', 'edit:setInstruction', id, text)
    },
    setEditParams: async (id, params) => {
      await call('edit', 'edit:setParams', id, params)
    },
    setEditPrompt: async (id, text) => {
      await call('edit', 'edit:setPrompt', id, text)
    },
    refineEdit: async (id) => {
      await call('edit', 'edit:refine', id)
    },
    applyEdit: async (id) => {
      await call('edit', 'edit:apply', id)
    },
    cancelEdit: async (id) => {
      await call('edit', 'edit:cancel', id)
    },
    // No optimistic removal: main now emits event:editJobDeleted, so the event
    // handler stays the single writer. A failed delete leaves the row on screen,
    // which is honest — it is still on disk.
    deleteEdit: async (id) => {
      await call('edit', 'edit:delete', id)
    },
    readImageDataUrl: async (path) => call('edit', 'artifacts:readDataUrl', path),

    setMcpEnabled: async (serverId, enabled) => {
      const states = await call('mcp', 'mcp:setEnabled', get().activeWorkflow, serverId, enabled)
      if (states) set({ mcpStates: states })
      // The server really started or stopped, but McpPanel derives the toggle
      // position from settings.workflowMcpOverrides — which main just rewrote
      // and there is no settings-changed event. Without this re-read the switch
      // snaps back while the schemas are genuinely on the wire costing prefill.
      const settings = await call('mcp', 'settings:get')
      if (settings) set({ settings })
      const current = get().activeConversationId
      // Tool schemas are part of the prompt, so the window accounting moves.
      if (current) await refreshUsage(current)
    },

    respondApproval: async (id, decision) => {
      // Drop it from the queue immediately — the dialog should not sit there
      // waiting for a round trip after the user has already decided.
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
      await call('approval', 'approval:respond', id, decision)
    },

    updateSettings: async (patch) => {
      const next = await call('settings', 'settings:update', patch)
      if (next) set({ settings: next })
    }
  }
})
