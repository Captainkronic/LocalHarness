/**
 * Persistent app settings.
 *
 * Everything on disk is treated as untrusted: each key is validated and merged
 * over DEFAULT_SETTINGS individually, so a file written by an older build (or a
 * hand-edit that dropped a key) can never leave a field undefined at runtime.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIVE_SETTINGS, PANEL_W_DEFAULT, PANEL_W_MAX, PANEL_W_MIN, REASONING_EFFORTS } from '@shared/types'
import type {
  ApprovalMode,
  LlmEndpoint,
  PanelKind,
  ReasoningEffort,
  Settings,
  WorkflowId
} from '@shared/types'
import { WORKFLOW_BY_ID } from '@shared/workflows'

import { atomicWriteSync, expandTilde } from './paths'

const HOME = homedir()

export const DEFAULT_SETTINGS: Settings = {
  /**
   * LM Studio directly, not the local schema-sanitising proxy on :1235.
   *
   * That proxy exists to solve a VS Code Copilot problem — Gemma chat templates
   * abort on `enum` and `anyOf` in tool schemas, which Copilot ships and cannot
   * disable, so it rewrites them on the way through. This app has never needed
   * that: mcp/tokens.ts sanitises every schema before it reaches the wire, and
   * context windows come from the control websocket rather than being inferred
   * from traffic. Pointing here was inherited configuration, and it bought
   * nothing but an extra hop on every streamed token.
   */
  baseUrl: 'http://adams-mac-studio.tailc7bb1e.ts.net:1235/v1',
  nativeApiUrl: 'http://adams-mac-studio.tailc7bb1e.ts.net:1234',
  labUrl: 'http://adams-mac-studio.tailc7bb1e.ts.net:1234',
  apiKey: 'lm-studio',
  defaultModelId: null,
  approvalMode: 'always_ask',
  workspaceRoots: [join(HOME, 'Documents'), join(HOME, 'Desktop'), join(HOME, 'LocalHarness')],
  // Deliberately excludes `cat` and `ls`: both take an arbitrary path, so
  // allowlisting them would let the model read any file on the disk with no
  // approval, straight past the workspace sandbox. `read_file` and `list_dir`
  // are the sandboxed route to the same capability. Everything left here either
  // takes no path or operates on the working directory.
  shellAllowlist: ['pwd', 'git status', 'git diff', 'git log', 'npm run typecheck', 'node -v'],
  contextWarnFraction: 0.75,
  contextSlots: 1,
  autoContinueTurns: 0,
  theme: 'dark',
  modelPollMs: 600000,
  // Adam's MLX server with multi-token prediction, alongside LM Studio's own.
  // Model ids collide between the two, which is why endpoints are first-class.
  /* Empty by design. This carried an "MTP MLX" entry on :1236 — a second
     inference server whose models collided by id with LM Studio's own, so the
     picker listed every model twice with only a faint source label to tell them
     apart. Removed at Adam's request; the field stays because pointing at an
     extra endpoint is still a reasonable thing to want. */
  extraEndpoints: [],
  workflowReasoning: {},
  workflowSampling: {},
  workflowMcpOverrides: {},
  panelLayout: {},
  liveAvatarId: null,
  live: { ...DEFAULT_LIVE_SETTINGS }
}

const APPROVAL_MODES: readonly ApprovalMode[] = ['always_ask', 'auto_read', 'auto_all']
const THEMES: readonly Settings['theme'][] = ['dark', 'light', 'system']

/** Floor on the poll interval. A previous incarnation of the model poller hit
 *  this endpoint 5,760 times a day; a bad settings value must not get us there. */
const MIN_POLL_MS = 1_000
const MAX_POLL_MS = 600_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Any string, including empty (labUrl uses '' to mean "Lab disabled"). */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

/** Returns the filtered array whenever the input *was* an array, so clearing a
 *  list to empty is respected rather than silently reverted to the default. */
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((item): item is string => typeof item === 'string')
}

function asClampedNumber(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(max, Math.max(min, v))
}

/**
 * Per-workflow MCP overrides, with one migration applied on the way in.
 *
 * An override records that the user deviated from a workflow's own server set.
 * The trouble is that it is stored as an absolute list, so it keeps winning
 * after the workflow's defaults change — and a workflow that GAINS a server
 * then silently withholds it, with the panel reading "0 tools" and nothing on
 * screen to say why. That happened for real: Live shipped with no servers, an
 * empty override was recorded for it, and when Live later gained mail and
 * weather the override kept them switched off.
 *
 * So an EMPTY override for a workflow that ships servers is dropped. It cannot
 * have been a considered choice about servers that did not exist yet, and if
 * the user does want none, one toggle says so again. Non-empty overrides are
 * left exactly as they are — those are real choices about real servers.
 */
/**
 * Panel sizes, clamped rather than trusted.
 *
 * This file is hand-editable and survives upgrades, so a width of 5 or 50000
 * would otherwise reach the layout and leave a panel that cannot be grabbed to
 * fix it. Anything unusable is dropped back to the default.
 */
function asPanelLayout(v: unknown): Settings['panelLayout'] | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Settings['panelLayout'] = {}
  for (const [kind, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const w = typeof entry.width === 'number' && Number.isFinite(entry.width)
      ? Math.round(Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, entry.width)))
      : PANEL_W_DEFAULT
    out[kind as PanelKind] = { width: w, collapsed: entry.collapsed === true }
  }
  return out
}

function asWorkflowOverrides(v: unknown): Partial<Record<WorkflowId, string[]>> | undefined {
  if (!isRecord(v)) return undefined
  const out: Partial<Record<WorkflowId, string[]>> = {}
  for (const [key, value] of Object.entries(v)) {
    if (!(key in WORKFLOW_BY_ID)) continue
    const ids = asStringArray(value)
    if (!ids) continue
    const workflowId = key as WorkflowId
    if (ids.length === 0 && WORKFLOW_BY_ID[workflowId].mcpServers.length > 0) continue
    out[workflowId] = ids
  }
  return out
}

function asEndpoints(v: unknown): LlmEndpoint[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: LlmEndpoint[] = []
  for (const raw of v) {
    if (!isRecord(raw)) continue
    const id = asNonEmptyString(raw.id)
    const baseUrl = asNonEmptyString(raw.baseUrl)
    if (!id || !baseUrl) continue
    out.push({ id, label: asNonEmptyString(raw.label) ?? id, baseUrl })
  }
  return out
}

function asWorkflowReasoning(v: unknown): Partial<Record<WorkflowId, ReasoningEffort>> | undefined {
  if (!isRecord(v)) return undefined
  const out: Partial<Record<WorkflowId, ReasoningEffort>> = {}
  for (const [key, value] of Object.entries(v)) {
    if (!(key in WORKFLOW_BY_ID)) continue
    if (typeof value !== 'string') continue
    if (!(REASONING_EFFORTS as readonly string[]).includes(value)) continue
    out[key as WorkflowId] = value as ReasoningEffort
  }
  return out
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Merge `raw` over `base` key by key. Used both for the on-disk file (base =
 * DEFAULT_SETTINGS) and for update patches (base = current settings).
 */
/** Exported for tests: the clamping here is what makes a hand-edited settings
 *  file safe, and it is only exercised by a file nobody writes by hand. */
/**
 * Sampler overrides from a file nobody writes by hand, and might.
 *
 * Every value is clamped to a range the sampler can actually use. A hand-typed
 * temperature of 20 or a top_k of -1 does not fail loudly at this layer — it
 * reaches the server and comes back as an opaque 400, or worse, is accepted and
 * quietly ruins the output.
 */
const SAMPLING_RANGE: Record<string, [number, number]> = {
  temperature: [0, 2],
  topP: [0, 1],
  topK: [0, 500],
  minP: [0, 1],
  frequencyPenalty: [-2, 2],
  presencePenalty: [-2, 2],
  maxTokens: [64, 131072]
}

function asWorkflowSampling(
  value: unknown
): Settings['workflowSampling'] | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, Record<string, number>> = {}
  for (const [wf, patch] of Object.entries(value)) {
    if (!isRecord(patch)) continue
    const kept: Record<string, number> = {}
    for (const [key, raw] of Object.entries(patch)) {
      const range = SAMPLING_RANGE[key]
      if (!range || typeof raw !== 'number' || !Number.isFinite(raw)) continue
      kept[key] = Math.min(range[1], Math.max(range[0], raw))
    }
    if (Object.keys(kept).length > 0) out[wf] = kept
  }
  return out as Settings['workflowSampling']
}

export function mergeSettings(base: Settings, raw: unknown): Settings {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {}

  const roots = asStringArray(src.workspaceRoots)
  const allowlist = asStringArray(src.shellAllowlist)
  const approvalMode = asString(src.approvalMode)
  const theme = asString(src.theme)

  return {
    baseUrl: asNonEmptyString(src.baseUrl) ?? base.baseUrl,
    nativeApiUrl: asNonEmptyString(src.nativeApiUrl) ?? base.nativeApiUrl,
    labUrl: asString(src.labUrl)?.trim() ?? base.labUrl,
    apiKey: asString(src.apiKey) ?? base.apiKey,
    // An explicit null (or '') means "follow whatever is resident"; only an
    // absent key falls back to the previous value.
    defaultModelId:
      'defaultModelId' in src
        ? (asNonEmptyString(src.defaultModelId) ?? null)
        : base.defaultModelId,
    approvalMode:
      approvalMode !== undefined && (APPROVAL_MODES as readonly string[]).includes(approvalMode)
        ? (approvalMode as ApprovalMode)
        : base.approvalMode,
    workspaceRoots: roots ? dedupe(roots.map(expandTilde)) : base.workspaceRoots,
    shellAllowlist: allowlist ? dedupe(allowlist.map((c) => c.trim()).filter(Boolean)) : base.shellAllowlist,
    contextWarnFraction: asClampedNumber(src.contextWarnFraction, 0.1, 1) ?? base.contextWarnFraction,
    contextSlots: Math.round(asClampedNumber(src.contextSlots, 1, 16) ?? base.contextSlots),
    autoContinueTurns: Math.round(asClampedNumber(src.autoContinueTurns, 0, 50) ?? base.autoContinueTurns),
    theme:
      theme !== undefined && (THEMES as readonly string[]).includes(theme)
        ? (theme as Settings['theme'])
        : base.theme,
    modelPollMs: asClampedNumber(src.modelPollMs, MIN_POLL_MS, MAX_POLL_MS) ?? base.modelPollMs,
    extraEndpoints: asEndpoints(src.extraEndpoints) ?? base.extraEndpoints,
    workflowReasoning: asWorkflowReasoning(src.workflowReasoning) ?? base.workflowReasoning,
    workflowSampling: asWorkflowSampling(src.workflowSampling) ?? base.workflowSampling,
    workflowMcpOverrides: asWorkflowOverrides(src.workflowMcpOverrides) ?? base.workflowMcpOverrides,
    panelLayout: asPanelLayout(src.panelLayout) ?? base.panelLayout,
    // `in`, not a truthiness test: null is a MEANINGFUL value here — it is how
    // the Face picker says "go back to the orb". Falling back to `base` when
    // the value was not a string meant selecting Orb silently kept the avatar,
    // and the dropdown snapped straight back.
    /* Passed through rather than field-checked here. LiveSession.updateSettings
       already clamps every one of these, and it is the only thing that reads
       them, so a second set of ranges in this file could only ever drift out of
       step with the first. A malformed blob is merged onto the defaults there
       and the bad fields are simply not taken. */
    live: isRecord(raw) && isRecord(src.live) ? { ...base.live, ...src.live } : base.live,
    liveAvatarId:
      isRecord(raw) && 'liveAvatarId' in raw
        ? typeof src.liveAvatarId === 'string'
          ? src.liveAvatarId
          : null
        : base.liveAvatarId
  }
}

export class SettingsStore {
  private readonly file: string
  private current: Settings
  private readonly listeners = new Set<(s: Settings) => void>()

  /**
   * True when there was no settings file when this process started.
   *
   * The constructor has always known this; it just kept it to itself. The
   * setup wizard is the thing that needs it, and asking "does the file exist"
   * later is the wrong question — by then the constructor has written one.
   */
  private readonly firstRun: boolean

  /** @param dir the app's userData directory. */
  constructor(dir: string) {
    this.file = join(expandTilde(dir), 'settings.json')
    const existed = existsSync(this.file)
    this.firstRun = !existed
    this.current = this.load()
    // Seed the file on first run so there is something to hand-edit.
    if (!existed) this.persist()
  }

  isFirstRun(): boolean {
    return this.firstRun
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = mergeSettings(this.current, patch as unknown)
    this.persist()
    for (const cb of [...this.listeners]) {
      try {
        cb(this.current)
      } catch (err) {
        console.warn('[settings] onChange listener threw:', err)
      }
    }
    return this.current
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private load(): Settings {
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch {
      // Missing or corrupt: fall through with an empty object so every key
      // comes from DEFAULT_SETTINGS. Never throw out of the constructor.
      parsed = {}
    }
    // Merging even in the empty case gives us fresh arrays, so nothing can
    // mutate DEFAULT_SETTINGS through the live settings object.
    return mergeSettings(DEFAULT_SETTINGS, parsed)
  }

  private persist(): void {
    try {
      atomicWriteSync(this.file, `${JSON.stringify(this.current, null, 2)}\n`)
    } catch (err) {
      console.warn('[settings] failed to write', this.file, err)
    }
  }
}
