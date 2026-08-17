/**
 * How hard the model should think, per workflow.
 *
 * This is not a tuning knob for its own sake. Reasoning tokens are billed
 * against `max_tokens`, so a model left to think as long as it likes can spend
 * the entire answer budget and return nothing: qwen once used all 8,192 of the
 * Code workflow's output on reasoning and produced no answer at all, after
 * eleven minutes. The control exists because that trade — thinking versus
 * answering — is the user's to make, per task, and it was previously buried in
 * a profile.
 *
 * Defaults to Low everywhere. A model that reasons less is not a worse model
 * for most of what happens here; it is a faster one, and the depth is a
 * deliberate choice for the turns that earn it.
 */

import type { ReactElement } from 'react'

import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/types'
import { useStore } from '@renderer/state/store'
import './workflow.css'

/** Named for what they cost the user, not for what they do to the sampler. */
const LABEL: Record<ReasoningEffort, string> = {
  none: 'Off',
  low: 'Low',
  medium: 'Med',
  high: 'High'
}

const HELP: Record<ReasoningEffort, string> = {
  none: 'No thinking at all. The fastest first token this app can produce — on a small model it is the difference between roughly four seconds and a third of a second.',
  low: 'A little thinking. The default, because reasoning is charged against the same budget as the answer.',
  medium: 'More thinking, for a problem with a few steps in it. Slower, and it eats into what is left for the answer.',
  high: 'Think hard. For genuinely difficult problems only — on a long prompt this can consume the whole output budget and return nothing at all.'
}

export function ReasoningPicker(): ReactElement | null {
  const workflows = useStore((s) => s.workflows)
  const activeWorkflow = useStore((s) => s.activeWorkflow)
  const settings = useStore((s) => s.settings)
  const setWorkflowReasoning = useStore((s) => s.setWorkflowReasoning)

  const definition = workflows.find((w) => w.id === activeWorkflow)
  if (!definition) return null

  // The user's choice if they made one, otherwise whatever the profile ships.
  const current: ReasoningEffort =
    settings.workflowReasoning[activeWorkflow] ?? definition.sampling.reasoningEffort ?? 'low'

  return (
    <div className="rsn">
      <span className="section-label rsn-label" title="Reasoning tokens are charged against this workflow's output budget, so thinking longer leaves less room for the answer.">
        Thinking
      </span>
      <div className="rsn-seg" role="radiogroup" aria-label="Reasoning effort">
        {REASONING_EFFORTS.map((effort) => (
          <button
            key={effort}
            type="button"
            role="radio"
            aria-checked={current === effort}
            className={current === effort ? 'rsn-opt is-on' : 'rsn-opt'}
            title={HELP[effort]}
            onClick={() => void setWorkflowReasoning(activeWorkflow, effort)}
          >
            {LABEL[effort]}
          </button>
        ))}
      </div>
    </div>
  )
}

export default ReasoningPicker
