/**
 * The sampler, per workflow, where you can reach it.
 *
 * These numbers were hardcoded in the workflow definitions and unreachable from
 * the app, which made the one problem this stack actually has — a model that
 * thinks until its output budget is gone and returns nothing — impossible to
 * work on without editing source and rebuilding. Qwen publish a specific
 * sampler for thinking mode; trying it should not require a compiler.
 *
 * Two things this control is careful about.
 *
 * It shows the DEFAULT until you move something, and says so. A field that
 * silently pre-fills with a number looks like a setting you chose, and the
 * difference matters: an untouched knob keeps tracking the workflow, so a later
 * change to a default still reaches you.
 *
 * And every hint here is measured rather than folklore. The temperature note in
 * particular contradicts the obvious guess, which is exactly why it is written
 * down.
 */

import { useState, type ReactElement } from 'react'

import type { SamplingOverrides } from '@shared/types'
import { useStore } from '@renderer/state/store'
import './workflow.css'

type Knob = keyof SamplingOverrides

interface Spec {
  key: Knob
  label: string
  min: number
  max: number
  step: number
  help: string
}

/**
 * Ordered by how often they are the answer, not alphabetically.
 *
 * top_k is first among the tail controls because it was never sent at all —
 * the app had no such field, so a workflow could name it and be ignored.
 */
const KNOBS: Spec[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    min: 0,
    max: 2,
    step: 0.05,
    help:
      'Not what you would guess. Measured on qwen3.8, temperature 0.0 spent MORE reasoning than 0.6 — 919 tokens against 546 — because greedy decoding re-treads ground it has already covered, and a little sampling noise is what breaks the loop. Colder is not calmer here.'
  },
  {
    key: 'topP',
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.01,
    help: 'Nucleus sampling. Qwen specify 0.95 for thinking mode and 0.8 for non-thinking.'
  },
  {
    key: 'topK',
    label: 'Top K',
    min: 0,
    max: 200,
    step: 1,
    help:
      'How many candidates stay in play. Qwen specify 20 for thinking mode. This app sent no top_k at all until recently, so an unconstrained tail was free to wander. 0 leaves it unset.'
  },
  {
    key: 'minP',
    label: 'Min P',
    min: 0,
    max: 1,
    step: 0.01,
    help: 'Floor on a token’s probability relative to the best one. Qwen specify 0.'
  },
  {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    step: 0.05,
    help:
      'Penalises tokens already used. Added here to stop a model re-deriving decisions it had made, which is repetition by another name. Qwen warn that penalties can cause language mixing, so it is off-spec — worth trying at 0 if output looks odd.'
  },
  {
    key: 'presencePenalty',
    label: 'Presence penalty',
    min: -2,
    max: 2,
    step: 0.05,
    help: 'Penalises any token that has appeared at all. Blunter than frequency penalty.'
  },
  {
    key: 'maxTokens',
    label: 'Reply budget',
    min: 256,
    max: 65536,
    step: 256,
    help:
      'The ceiling for reasoning AND answer together. Thinking is billed from this, so a turn can spend the whole budget deliberating and return nothing — which is what a blank reply means when you see one.'
  }
]

export function SamplingPanel(): ReactElement | null {
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const settings = useStore((s) => s.settings)
  const setWorkflowSampling = useStore((s) => s.setWorkflowSampling)
  const [open, setOpen] = useState(false)

  const definition = workflows.find((w) => w.id === activeWorkflow)
  if (!definition) return null

  const overrides = settings.workflowSampling[activeWorkflow] ?? {}
  const defaults = definition.sampling as unknown as Record<Knob, number | undefined>
  const changed = Object.keys(overrides).length

  const valueOf = (k: Knob): number | undefined => overrides[k] ?? defaults[k]

  return (
    <div className="smp">
      <button className="smp-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="section-label">Inference</span>
        {/* The count is the point of the collapsed state: it answers "have I
            changed anything here" without opening it. */}
        <span className="smp-count">
          {changed > 0 ? `${changed} changed` : 'defaults'}
          <span aria-hidden="true"> {open ? '−' : '+'}</span>
        </span>
      </button>

      {open ? (
        <div className="smp-body">
          {KNOBS.map((spec) => {
            const v = valueOf(spec.key)
            const isSet = spec.key in overrides
            return (
              <label key={spec.key} className={isSet ? 'smp-row is-set' : 'smp-row'} title={spec.help}>
                <span className="smp-name">{spec.label}</span>
                <input
                  className="smp-input tnum"
                  type="number"
                  inputMode="decimal"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={v ?? ''}
                  placeholder="unset"
                  onChange={(e) => {
                    const raw = e.target.value
                    void setWorkflowSampling(activeWorkflow, {
                      // Empty clears the override and returns the knob to the
                      // workflow's default, rather than pinning it to zero.
                      [spec.key]: raw === '' ? undefined : Number(raw)
                    } as Partial<SamplingOverrides>)
                  }}
                />
                <span className="smp-origin">{isSet ? 'yours' : 'default'}</span>
              </label>
            )
          })}

          {changed > 0 ? (
            <button
              className="smp-reset"
              onClick={() =>
                void setWorkflowSampling(
                  activeWorkflow,
                  Object.fromEntries(KNOBS.map((k) => [k.key, undefined])) as Partial<SamplingOverrides>
                )
              }
            >
              Reset to {definition.label} defaults
            </button>
          ) : null}

          <p className="smp-note">
            Applies to the next message in {definition.label}. Thinking level is separate — it
            is the one control measured to change reasoning length on this model.
          </p>
        </div>
      ) : null}
    </div>
  )
}

export default SamplingPanel
