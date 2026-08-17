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

import type { ApprovalMode, Settings, WorkflowId } from '@shared/types'
import { WORKFLOW_BY_ID } from '@shared/workflows'

import { atomicWriteSync, expandTilde } from './paths'

const HOME = homedir()

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://127.0.0.1:1235/v1',
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
  theme: 'dark',
  modelPollMs: 15000,
  workflowMcpOverrides: {}
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

function asWorkflowOverrides(v: unknown): Partial<Record<WorkflowId, string[]>> | undefined {
  if (!isRecord(v)) return undefined
  const out: Partial<Record<WorkflowId, string[]>> = {}
  for (const [key, value] of Object.entries(v)) {
    if (!(key in WORKFLOW_BY_ID)) continue
    const ids = asStringArray(value)
    if (ids) out[key as WorkflowId] = ids
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
function mergeSettings(base: Settings, raw: unknown): Settings {
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
    theme:
      theme !== undefined && (THEMES as readonly string[]).includes(theme)
        ? (theme as Settings['theme'])
        : base.theme,
    modelPollMs: asClampedNumber(src.modelPollMs, MIN_POLL_MS, MAX_POLL_MS) ?? base.modelPollMs,
    workflowMcpOverrides: asWorkflowOverrides(src.workflowMcpOverrides) ?? base.workflowMcpOverrides
  }
}

export class SettingsStore {
  private readonly file: string
  private current: Settings
  private readonly listeners = new Set<(s: Settings) => void>()

  /** @param dir the app's userData directory. */
  constructor(dir: string) {
    this.file = join(expandTilde(dir), 'settings.json')
    const existed = existsSync(this.file)
    this.current = this.load()
    // Seed the file on first run so there is something to hand-edit.
    if (!existed) this.persist()
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
