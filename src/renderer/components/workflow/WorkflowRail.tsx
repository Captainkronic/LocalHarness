import type { CSSProperties, JSX } from 'react'
import { useStore } from '@renderer/state/store'
import './workflow.css'

/**
 * The workflow switcher.
 *
 * This is the one component allowed to touch a workflow's own accent colour
 * directly — everywhere else the accent arrives as `var(--accent)` from a
 * wrapper. The rail has to show all seven at once, so it needs all seven hues.
 */

const MOD_KEY = window.harness?.platform === 'darwin' ? '⌘' : 'Ctrl+'

export function WorkflowRail(): JSX.Element {
  const workflows = useStore((s) => s.workflows)
  const active = useStore((s) => s.activeWorkflow)
  const selectWorkflow = useStore((s) => s.selectWorkflow)

  return (
    <nav className="rail" aria-label="Workflows">
      {workflows.map((w, i) => {
        const isActive = w.id === active
        return (
          <button
            key={w.id}
            type="button"
            className={isActive ? 'rail-item is-active' : 'rail-item'}
            style={{ '--wf-accent': w.accent } as CSSProperties}
            aria-current={isActive ? 'page' : undefined}
            title={`${w.label} — ${w.blurb}\n${MOD_KEY}${i + 1}`}
            onClick={() => {
              if (!isActive) void selectWorkflow(w.id)
            }}
          >
            <span className="rail-bar" aria-hidden="true" />
            <span className="rail-glyph" aria-hidden="true">
              {w.glyph}
            </span>
            <span className="rail-label">{w.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

export default WorkflowRail
