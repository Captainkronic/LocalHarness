/**
 * What each inference phase means, in one sentence.
 *
 * Lives here rather than in the HUD because two surfaces now explain phases to
 * the user — the HUD's tooltip and the strip under the composer — and two
 * copies of this text would drift the first time one of them was reworded.
 */

import type { InferencePhase } from '@shared/types'

export const PHASE_TIP: Record<InferencePhase, string> = {
  idle: 'Nothing in flight.',
  queued: 'Request sent. The server has not begun answering it yet.',
  prefill:
    'The model is reading the prompt. No tokens are produced during this phase, and the protocol reports no progress through it.',
  decode: 'The model is generating tokens.',
  tool: 'A tool call is running. The wait here is the tool, not the GPU.'
}
