import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ApprovalMode, ModelInfo, Settings } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { formatMs, formatPercent, formatTokens } from '@renderer/lib/format'
import VoiceTuning from './VoiceTuning'
import './workflow.css'

/**
 * Settings. Rendered into document.body so it is never clipped by the app grid;
 * that also means it sits outside the workflow accent wrapper and picks up the
 * neutral default accent, which is correct for global chrome.
 */

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const APPROVAL_MODES: Array<{ id: ApprovalMode; label: string; consequence: string }> = [
  {
    id: 'always_ask',
    label: 'Ask every time',
    consequence:
      'Every tool call stops and waits for you — reads and directory listings included. Slowest, and nothing happens you did not see.'
  },
  {
    id: 'auto_read',
    label: 'Auto-approve reads',
    consequence:
      'Reads, searches, globs and listings run on their own. Writes, edits and shell commands still stop and ask.'
  },
  {
    id: 'auto_all',
    label: 'Auto-approve everything',
    consequence:
      'Nothing asks. The agent writes files and runs shell commands inside your workspace roots without stopping. Paths outside those roots are still refused.'
  }
]

const THEMES: Array<{ id: Settings['theme']; label: string }> = [
  { id: 'system', label: 'Follow system' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' }
]

function modelOptionLabel(m: ModelInfo): string {
  const bits = [m.id, m.quantization || m.arch, m.compatibilityType]
  if (m.loadedContextLength !== null) bits.push(`${formatTokens(m.loadedContextLength)} ctx`)
  if (m.state !== 'loaded') bits.push('not loaded')
  return bits.filter(Boolean).join(' · ')
}

/** Text input that only writes through on blur or Enter, so a settings write is
 *  not fired on every keystroke. */
function Field(props: {
  label: string
  value: string
  onCommit: (v: string) => void
  type?: string
  placeholder?: string
  hint?: string
}): JSX.Element {
  const { label, value, onCommit, type, placeholder, hint } = props
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }

  return (
    <label className="set-field">
      <span className="set-field-label">{label}</span>
      <input
        className="set-input"
        type={type ?? 'text'}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          }
        }}
      />
      {hint ? <span className="set-hint">{hint}</span> : null}
    </label>
  )
}

function XIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function MinusIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 8h8" />
    </svg>
  )
}

export function SettingsModal({ open, onClose }: SettingsModalProps): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const health = useStore((s) => s.health)
  const updateSettings = useStore((s) => s.updateSettings)

  const [newCommand, setNewCommand] = useState('')
  const [warnDraft, setWarnDraft] = useState(settings.contextWarnFraction)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    setWarnDraft(settings.contextWarnFraction)
  }, [settings.contextWarnFraction])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase, like ApprovalDialog. Without it this listener runs in the
    // bubble phase alongside App's global Escape handler, whose chain does not
    // know this overlay is open — so stopPropagation() comes too late and the
    // same keypress that closes this ALSO aborts the turn in flight. Closing a
    // lightbox should not throw away forty seconds of prefill.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const patch = useCallback(
    (p: Partial<Settings>): void => {
      void updateSettings(p)
    },
    [updateSettings]
  )

  const selectedModel = useMemo(
    () => models.find((m) => m.id === settings.defaultModelId) ?? null,
    [models, settings.defaultModelId]
  )

  const addRoot = useCallback(async (): Promise<void> => {
    setPicking(true)
    try {
      const dir = await window.harness.invoke('settings:pickDirectory')
      if (!dir || settings.workspaceRoots.includes(dir)) return
      await updateSettings({ workspaceRoots: [...settings.workspaceRoots, dir] })
    } finally {
      setPicking(false)
    }
  }, [settings.workspaceRoots, updateSettings])

  const removeRoot = useCallback(
    (dir: string): void => {
      patch({ workspaceRoots: settings.workspaceRoots.filter((r) => r !== dir) })
    },
    [patch, settings.workspaceRoots]
  )

  const setAllowlistAt = useCallback(
    (i: number, value: string): void => {
      const next = [...settings.shellAllowlist]
      const trimmed = value.trim()
      if (trimmed === '') next.splice(i, 1)
      else next[i] = trimmed
      patch({ shellAllowlist: next })
    },
    [patch, settings.shellAllowlist]
  )

  const addAllowlist = useCallback((): void => {
    const trimmed = newCommand.trim()
    if (trimmed === '' || settings.shellAllowlist.includes(trimmed)) {
      setNewCommand('')
      return
    }
    patch({ shellAllowlist: [...settings.shellAllowlist, trimmed] })
    setNewCommand('')
  }, [newCommand, patch, settings.shellAllowlist])

  if (!open) return null

  const commitWarn = (): void => {
    if (warnDraft !== settings.contextWarnFraction) patch({ contextWarnFraction: warnDraft })
  }

  return createPortal(
    <div
      className="set-scrim"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="set-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="set-head">
          <h2 className="set-title">Settings</h2>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label="Close settings"
            onClick={onClose}
          >
            <XIcon />
            Esc
          </button>
        </header>

        <div className="set-body scroll-y">
          {/* ---- Connection ---- */}
          {/*
            First, deliberately.

            Every other setting here has a right answer that can be reasoned
            about — which model, which server, how many tokens. This one does
            not: how loudly you have to speak to cut the assistant off depends
            on the room, the microphone and the person, so the only way to set
            it is to talk and watch. That is what the meter under it is for, and
            it is why this is at the top rather than buried under Display.
          */}
          <section className="set-section">
            <div className="set-section-head">
              <span className="section-label">Voice</span>
              <span className="set-status-num tnum">interrupting</span>
            </div>
            <VoiceTuning />
          </section>

          <section className="set-section">
            <div className="set-section-head">
              <span className="section-label">Connection</span>
              <span className="set-status">
                <span className={health.reachable ? 'dot dot-ok' : 'dot dot-error'} />
                <span className="set-status-text">
                  {health.reachable ? 'reachable' : health.error ?? 'unreachable'}
                </span>
                {health.latencyMs !== null ? (
                  <span className="set-status-num tnum">{formatMs(health.latencyMs)}</span>
                ) : null}
              </span>
            </div>

            <div className="set-resident">
              <span className="set-resident-label">Resident model</span>
              <span className="set-resident-value">
                {health.residentModelId ?? 'none loaded'}
              </span>
              <span className="set-resident-lab" title="LM Studio Lab telemetry feed">
                lab: {health.labStatus}
              </span>
            </div>

            <Field
              label="OpenAI-compatible base URL"
              value={settings.baseUrl}
              onCommit={(v) => patch({ baseUrl: v.trim() })}
              placeholder="http://127.0.0.1:1234/v1"
            />
            <Field
              label="LM Studio native API root"
              value={settings.nativeApiUrl}
              onCommit={(v) => patch({ nativeApiUrl: v.trim() })}
              placeholder="http://127.0.0.1:1234"
              hint="Used for /api/v0/models, which is the only place the real loaded context length is reported."
            />
            <Field
              label="Lab feed root"
              value={settings.labUrl}
              onCommit={(v) => patch({ labUrl: v.trim() })}
              placeholder="http://127.0.0.1:1234"
              hint="Optional. Empty disables the feed; everything else keeps working."
            />
            <Field
              label="API key"
              type="password"
              value={settings.apiKey}
              onCommit={(v) => patch({ apiKey: v })}
              placeholder="lm-studio"
            />
          </section>

          {/* ---- Model ---- */}
          <section className="set-section">
            <div className="set-section-head">
              <span className="section-label">Model</span>
              <span className="set-status-num tnum">{models.length} known</span>
            </div>

            <label className="set-field">
              <span className="set-field-label">Default model</span>
              <select
                className="set-input set-select"
                value={settings.defaultModelId ?? ''}
                onChange={(e) => patch({ defaultModelId: e.target.value || null })}
              >
                <option value="">Follow resident model</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelOptionLabel(m)}
                  </option>
                ))}
              </select>
              <span className="set-hint">
                {settings.defaultModelId === null
                  ? 'Every conversation uses whatever LM Studio has loaded at the time.'
                  : 'Pinned. Sending will JIT-load this model if it is not resident.'}
              </span>
            </label>

            {selectedModel ? (
              <div className="set-model-facts">
                <span className="chip">{selectedModel.quantization || '—'}</span>
                <span className="chip">{selectedModel.compatibilityType}</span>
                <span className="chip tnum">
                  {selectedModel.loadedContextLength !== null
                    ? `${formatTokens(selectedModel.loadedContextLength)} ctx`
                    : 'ctx — (not resident)'}
                </span>
                {selectedModel.state !== 'loaded' ? (
                  <span className="chip is-warn">not loaded</span>
                ) : null}
                {selectedModel.supportsVision ? <span className="chip">vision</span> : null}
                {selectedModel.supportsTools ? <span className="chip">tools</span> : null}
              </div>
            ) : models.length === 0 ? (
              <p className="set-empty">
                No models reported yet. Check the native API root above — the list comes
                from <code>/api/v0/models</code>.
              </p>
            ) : null}
          </section>

          {/* ---- Agent ---- */}
          <section className="set-section">
            <div className="set-section-head">
              <span className="section-label">Agent</span>
            </div>

            <div className="set-radios" role="radiogroup" aria-label="Approval mode">
              {APPROVAL_MODES.map((m) => (
                <label
                  key={m.id}
                  className={
                    settings.approvalMode === m.id ? 'set-radio is-on' : 'set-radio'
                  }
                >
                  <input
                    type="radio"
                    name="approvalMode"
                    checked={settings.approvalMode === m.id}
                    onChange={() => patch({ approvalMode: m.id })}
                  />
                  <span className="set-radio-body">
                    <span className="set-radio-label">{m.label}</span>
                    <span className="set-radio-blurb">{m.consequence}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="set-list-block">
              <div className="set-list-head">
                <span className="set-field-label">Workspace roots</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={picking}
                  onClick={() => void addRoot()}
                >
                  Add directory…
                </button>
              </div>
              {settings.workspaceRoots.length === 0 ? (
                <p className="set-empty">
                  No roots. Every file and shell tool will refuse until you add one — that
                  is the sandbox, not a bug.
                </p>
              ) : (
                <ul className="set-list">
                  {settings.workspaceRoots.map((root) => (
                    <li key={root} className="set-list-row">
                      <span className="set-list-text" title={root}>
                        {root}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost btn-danger"
                        aria-label={`Remove ${root}`}
                        onClick={() => removeRoot(root)}
                      >
                        <MinusIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="set-list-block">
              <div className="set-list-head">
                <span className="set-field-label">Shell allowlist</span>
                <span className="set-hint set-hint-inline">
                  First token of the command, matched exactly.
                </span>
              </div>
              {settings.shellAllowlist.length === 0 ? (
                <p className="set-empty">
                  Nothing pre-approved. Every shell command goes through the approval card.
                </p>
              ) : (
                <ul className="set-list">
                  {settings.shellAllowlist.map((cmd, i) => (
                    <li key={`${cmd}-${i}`} className="set-list-row">
                      <Field
                        label=""
                        value={cmd}
                        onCommit={(v) => setAllowlistAt(i, v)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost btn-danger"
                        aria-label={`Remove ${cmd}`}
                        onClick={() => setAllowlistAt(i, '')}
                      >
                        <MinusIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="set-list-row set-list-add">
                <input
                  className="set-input"
                  value={newCommand}
                  placeholder="git, npm, rg…"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setNewCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addAllowlist()
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={newCommand.trim() === ''}
                  onClick={addAllowlist}
                >
                  Add
                </button>
              </div>
            </div>
          </section>

          {/* ---- Display ---- */}
          <section className="set-section">
            <div className="set-section-head">
              <span className="section-label">Display</span>
            </div>

            <label className="set-field">
              <span className="set-field-label">Theme</span>
              <select
                className="set-input set-select"
                value={settings.theme}
                onChange={(e) => patch({ theme: e.target.value as Settings['theme'] })}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="set-field">
              <span className="set-field-label">
                Context warning at <span className="tnum">{formatPercent(warnDraft)}</span>
              </span>
              <input
                className="set-range"
                type="range"
                min={0.5}
                max={0.95}
                step={0.05}
                value={warnDraft}
                onChange={(e) => setWarnDraft(Number(e.target.value))}
                onPointerUp={commitWarn}
                onKeyUp={commitWarn}
                onBlur={commitWarn}
              />
              <span className="set-hint">
                The context meter turns amber past this fraction of the real loaded window.
              </span>
            </label>

            <Field
              label="Model poll interval (ms)"
              type="number"
              value={String(settings.modelPollMs)}
              onCommit={(v) => {
                const n = Number(v)
                patch({ modelPollMs: Number.isFinite(n) ? Math.max(1000, Math.round(n)) : 5000 })
              }}
              hint="A floor, not a fixed rate — the poller backs off to 120s when the app is idle."
            />
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default SettingsModal
