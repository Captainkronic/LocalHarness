/**
 * The shell: title bar, HUD, and the four-column body.
 *
 * It owns exactly three things beyond layout — bootstrapping the store, keeping
 * `data-theme` in sync with the settings, and the global keyboard map. Every
 * panel below it reads the store directly rather than taking props.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'

import { useStore } from '@renderer/state/store'
import { basename, formatMs, formatTokens } from '@renderer/lib/format'
import { WORKFLOW_BY_ID } from '@shared/workflows'
import type { ModelInfo, ServerHealth } from '@shared/types'

// Default imports throughout: every sibling exports its component as the module
// default, and only some of them also export it by name.
import MetricsHud from '@renderer/components/metrics/MetricsHud'
import WorkflowRail from '@renderer/components/workflow/WorkflowRail'
import Sidebar from '@renderer/components/workflow/Sidebar'
import SettingsModal from '@renderer/components/workflow/SettingsModal'
import ChatView from '@renderer/components/chat/ChatView'
import ApprovalDialog from '@renderer/components/chat/ApprovalDialog'
import ContextPanel from '@renderer/components/panels/ContextPanel'
import ModelManager from '@renderer/components/models/ModelManager'
import EditWorkspace from '@renderer/components/edit/EditWorkspace'
import CodeWorkspace from '@renderer/components/code/CodeWorkspace'
import LiveWorkspace from '@renderer/components/live/LiveWorkspace'

/** Traffic-light inset is macOS-only; everywhere else the brand sits at the edge. */
const PLATFORM: string = typeof window !== 'undefined' && window.harness
  ? window.harness.platform
  : 'darwin'

export default function App(): ReactElement {
  const ready = useStore((s) => s.ready)
  const settings = useStore((s) => s.settings)
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const models = useStore((s) => s.models)
  const health = useStore((s) => s.health)
  const livePhase = useStore((s) => s.live.phase)
  const bootstrap = useStore((s) => s.bootstrap)
  const newConversation = useStore((s) => s.newConversation)
  const selectWorkflow = useStore((s) => s.selectWorkflow)
  const updateSettings = useStore((s) => s.updateSettings)
  const cancel = useStore((s) => s.cancel)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /* --- theme ------------------------------------------------------- */
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      root.dataset.theme =
        settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme
    }
    apply()
    if (settings.theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme])

  /* --- keyboard map ------------------------------------------------ */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Layered: dismiss whatever is on top before touching the running turn.
        if (settingsOpen) {
          setSettingsOpen(false)
        } else if (modelMenuOpen) {
          setModelMenuOpen(false)
        } else if (livePhase !== 'idle') {
          cancel()
        }
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        void newConversation()
        return
      }
      if (e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        setModelsOpen(true)
        return
      }
      // Bounded by the rail's own length rather than a literal, so adding a
      // workflow does not silently leave it unreachable from the keyboard.
      if (e.key >= '1' && e.key <= '9') {
        const target = workflows[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          void selectWorkflow(target.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    settingsOpen,
    modelMenuOpen,
    livePhase,
    cancel,
    newConversation,
    selectWorkflow,
    workflows
  ])

  const workflow = useMemo(
    () => workflows.find((w) => w.id === activeWorkflow) ?? WORKFLOW_BY_ID[activeWorkflow],
    [workflows, activeWorkflow]
  )

  if (!ready) return <BootScreen />

  return (
    <div
      className="app"
      data-workflow={workflow.id}
      data-platform={PLATFORM}
      style={{ '--accent': workflow.accent } as CSSProperties}
    >
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            {workflow.glyph}
          </span>
          <span className="brand-name">CaptainLlama</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <span className="brand-workflow">{workflow.label}</span>
        </div>

        <div className="titlebar-spacer" />

        <ModelPicker
          models={models}
          pinnedId={settings.defaultModelId}
          residentId={health.residentModelId}
          open={modelMenuOpen}
          onOpenChange={setModelMenuOpen}
          onSelect={(id) => {
            void updateSettings({ defaultModelId: id })
          }}
          onManage={() => setModelsOpen(true)}
        />

        <ConnectionChip health={health} onClick={() => setSettingsOpen(true)} />

        <button
          type="button"
          className="btn btn-ghost btn-sm icon-btn"
          onClick={() => setModelsOpen(true)}
          title="Manage models on the server (⌘M)"
          aria-label="Manage models"
        >
          <ChipIcon />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm icon-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          <SlidersIcon />
        </button>
      </header>

      <MetricsHud />

      <div className="body" data-panel={workflow.panel}>
        <WorkflowRail />
        <Sidebar />
        <main className="center">
          {/* Most workflows are a conversation. Edit is a deterministic
              refine-then-render pipeline, so it gets its own centre column
              rather than being bent into a chat turn. */}
          {workflow.id === 'edit' ? (
            <EditWorkspace />
          ) : workflow.id === 'code' ? (
            <CodeWorkspace />
          ) : workflow.id === 'live' ? (
            <LiveWorkspace />
          ) : (
            <ChatView />
          )}
        </main>
        {workflow.panel !== 'none' && <ContextPanel />}
      </div>

      <ApprovalDialog />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ModelManager open={modelsOpen} onClose={() => setModelsOpen(false)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Title bar pieces                                                    */
/* ------------------------------------------------------------------ */

interface ModelPickerProps {
  models: ModelInfo[]
  /** settings.defaultModelId — null means "follow whatever is resident". */
  pinnedId: string | null
  residentId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string | null) => void
  /** Opens the model manager — load, unload, context length, cache settings. */
  onManage: () => void
}

function ModelPicker({
  models,
  pinnedId,
  residentId,
  open,
  onOpenChange,
  onSelect,
  onManage
}: ModelPickerProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Node && rootRef.current && !rootRef.current.contains(e.target)) {
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  // Embedding models cannot answer a chat turn, so they never appear here.
  const chatModels = useMemo(
    () =>
      models
        .filter((m) => !m.type.startsWith('embed'))
        .slice()
        .sort((a, b) => {
          const aLoaded = a.state === 'loaded' ? 0 : 1
          const bLoaded = b.state === 'loaded' ? 0 : 1
          if (aLoaded !== bLoaded) return aLoaded - bLoaded
          return basename(a.id).localeCompare(basename(b.id))
        }),
    [models]
  )

  const shownId = pinnedId ?? residentId
  const shown = shownId === null ? null : models.find((m) => m.id === shownId)

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="btn btn-sm model-trigger"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={shownId ?? 'No model selected'}
      >
        <span className={`dot ${stateDot(shown?.state)}`} />
        <span className="model-name">{shownId ? basename(shownId) : 'No model'}</span>
        {pinnedId === null && shownId !== null && <span className="model-auto">auto</span>}
        <ChevronIcon />
      </button>

      {open && (
        <div className="model-menu" role="listbox" aria-label="Model">
          <button
            type="button"
            role="option"
            aria-selected={pinnedId === null}
            className="model-option"
            data-selected={pinnedId === null}
            onClick={() => {
              onSelect(null)
              onOpenChange(false)
            }}
          >
            <span className={`dot ${residentId ? 'dot-ok' : ''}`} />
            <span className="model-option-name">Follow resident model</span>
            <span className="model-option-meta">
              {residentId ? basename(residentId) : 'none loaded'}
            </span>
          </button>

          <div className="hr" />

          {chatModels.length === 0 ? (
            <p className="model-empty">
              No models reported.
              <br />
              Check the endpoint in settings — LM Studio may be down.
            </p>
          ) : (
            <div className="model-list scroll-y">
              {chatModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={pinnedId === m.id}
                  className="model-option"
                  data-selected={pinnedId === m.id}
                  onClick={() => {
                    onSelect(m.id)
                    onOpenChange(false)
                  }}
                  title={m.id}
                >
                  <span className={`dot ${stateDot(m.state)}`} />
                  <span className="model-option-name">{basename(m.id)}</span>
                  <span className="model-option-meta tnum">
                    {[
                      m.compatibilityType,
                      m.quantization,
                      // Only the real loaded window is ever shown; an idle model
                      // gets a dash rather than its architectural ceiling.
                      m.loadedContextLength !== null
                        ? formatTokens(m.loadedContextLength)
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Where someone actually looks for this. It was reachable only from
              an unlabelled titlebar icon and a shortcut, which is to say: not
              reachable. */}
          <div className="hr" />
          <button
            type="button"
            className="model-option model-manage"
            onClick={() => {
              onOpenChange(false)
              onManage()
            }}
          >
            <span className="model-option-name">Load, unload &amp; configure models…</span>
            <span className="model-option-meta">⌘M</span>
          </button>
        </div>
      )}
    </div>
  )
}

function stateDot(state: string | undefined): string {
  if (state === 'loaded') return 'dot-ok'
  if (state === 'loading') return 'dot-busy'
  return ''
}

function ConnectionChip({
  health,
  onClick
}: {
  health: ServerHealth
  onClick: () => void
}): ReactElement {
  const host = useMemo(() => {
    try {
      return new URL(health.endpoint).host
    } catch {
      return health.endpoint
    }
  }, [health.endpoint])

  const title = [
    health.endpoint,
    health.reachable ? 'reachable' : `unreachable${health.error ? ` — ${health.error}` : ''}`,
    `lab feed: ${health.labStatus}`
  ].join('\n')

  return (
    <button type="button" className="btn btn-ghost btn-sm conn" onClick={onClick} title={title}>
      <span className={`dot ${health.reachable ? 'dot-ok' : 'dot-error'}`} />
      <span className="conn-host">{host}</span>
      {health.latencyMs !== null && (
        <span className="conn-latency tnum">{formatMs(health.latencyMs)}</span>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function BootScreen(): ReactElement {
  return (
    <div className="boot">
      <div className="boot-inner">
        <span className="boot-mark" aria-hidden="true">
          ◇
        </span>
        <span className="boot-name">CaptainLlama</span>
        <div className="boot-bar" role="progressbar" aria-label="Starting" />
        <span className="boot-note">Reading settings and reaching the inference host</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/** A chip/die, for the model manager: what is actually resident on the box. */
function ChipIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.25" />
      <path d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14" />
    </svg>
  )
}

function SlidersIcon(): ReactElement {
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
      <path d="M2 4.5h4M9.5 4.5H14M2 11.5h1.5M7 11.5H14" />
      <circle cx="7.75" cy="4.5" r="1.75" />
      <circle cx="5.25" cy="11.5" r="1.75" />
    </svg>
  )
}

function ChevronIcon(): ReactElement {
  return (
    <svg
      className="chevron"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 6.5 8 10 11.5 6.5" />
    </svg>
  )
}
