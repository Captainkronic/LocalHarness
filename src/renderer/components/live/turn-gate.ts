/**
 * When a spoken turn is over.
 *
 * Pulled out of the capture hook so it can be tested without an audio graph.
 * Everything else in that hook is buffer bookkeeping — pre-roll, tail, sample
 * offsets — and none of it decides anything. This does, and it is the decision
 * that determines whether someone gets to finish their sentence.
 *
 * Two thresholds, not one, because they answer different questions:
 *
 *   silenceMs      has he stopped making sound?
 *   pauseGraceMs   has he finished the sentence?
 *
 * The first is acoustic and the second is conversational. Folding them into a
 * single number worked acoustically and failed conversationally: a pause to
 * find a word runs to roughly half a second, landed inside a 700ms window, and
 * sent half a question — which the model then answered, confidently, as though
 * it were the whole one. Half an answer to half a question is worse than either
 * waiting or mishearing, because nothing about it looks wrong.
 *
 * Keeping them separate also gives the UI something true to show: between the
 * two, the turn is deliberately being held open, and saying so is what stops
 * someone repeating themselves into the very window that was being held for
 * them.
 */

export type GateState =
  /** Nothing captured yet. */
  | 'idle'
  /** Sound is arriving. */
  | 'listening'
  /** Quiet, but inside the grace — the turn is being held open. */
  | 'pausing'
  /** Done. The caller should send the utterance and reset. */
  | 'end'

export interface GateOptions {
  /** Silence before the turn is considered possibly over. */
  silenceMs: number
  /** Additional silence tolerated after that before it is actually sent. */
  pauseGraceMs: number
  /** Hard ceiling on a single utterance, however much speech is in it. */
  maxUtteranceMs: number
}

export class TurnGate {
  private silenceRun = 0
  private elapsed = 0
  private started = false

  /**
   * Feeds one analysis frame. Returns the state the caller should act on.
   *
   * `speaking` is the caller's voice-activity decision; this class deliberately
   * knows nothing about RMS or thresholds, so a change to how speech is
   * detected cannot quietly change when a turn ends.
   */
  frame(speaking: boolean, frameMs: number, opts: GateOptions): GateState {
    if (!this.started) {
      if (!speaking) return 'idle'
      this.started = true
    }

    this.elapsed += frameMs

    if (speaking) {
      // Resuming inside the grace continues the SAME turn rather than starting
      // a second one. That is the whole point: the pause was part of the
      // sentence, so the sentence is still in progress.
      this.silenceRun = 0
    } else {
      this.silenceRun += frameMs
    }

    if (this.elapsed >= opts.maxUtteranceMs) return 'end'

    // Never negative, and never below silenceMs: a grace of 0 means "send as
    // soon as the silence threshold is met", which is the old behaviour and
    // still a legitimate choice.
    const endOfTurn = opts.silenceMs + Math.max(0, opts.pauseGraceMs)
    if (this.silenceRun >= endOfTurn) return 'end'
    if (this.silenceRun >= opts.silenceMs) return 'pausing'
    return 'listening'
  }

  reset(): void {
    this.silenceRun = 0
    this.elapsed = 0
    this.started = false
  }
}
