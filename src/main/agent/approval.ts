/**
 * Approval broker.
 *
 * Owns the pending-permission table. The executor awaits `request(...)`; the
 * renderer answers through `approval:respond`, which lands here as `respond`.
 * Nothing else in the main process is allowed to resolve an approval, so there
 * is exactly one place a "yes" can come from.
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'

type PartialRequest = Omit<ApprovalRequest, 'id' | 'createdAt'>

interface PendingEntry {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
}

export class ApprovalBroker {
  private readonly pendingById = new Map<string, PendingEntry>()
  private readonly onRequest: (req: ApprovalRequest) => void
  private readonly onResolved: (id: string, decision: ApprovalDecision) => void

  /**
   * `onResolved` is an ADDITION TO THE SPEC. Without it, a request resolved
   * anywhere other than the renderer's own click — `denyAll()` on cancel or on
   * shutdown — leaves its card on screen with nothing able to dismiss it.
   */
  constructor(
    onRequest: (req: ApprovalRequest) => void,
    onResolved: (id: string, decision: ApprovalDecision) => void = () => {}
  ) {
    this.onRequest = onRequest
    this.onResolved = onResolved
  }

  private settle(entry: PendingEntry, decision: ApprovalDecision): void {
    entry.resolve(decision)
    try {
      this.onResolved(entry.request.id, decision)
    } catch {
      // A dead renderer must not break the tool call that was waiting.
    }
  }

  /**
   * Publish a request and wait for the user. The promise never rejects — a
   * denial is a value, so callers do not have to distinguish "denied" from
   * "the broker broke".
   */
  request(partial: PartialRequest): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...partial,
      id: randomUUID(),
      createdAt: Date.now()
    }
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingById.set(request.id, { request, resolve })
      try {
        this.onRequest(request)
      } catch {
        // A renderer that is gone must not strand the tool call forever.
        this.pendingById.delete(request.id)
        resolve('deny')
      }
    })
  }

  /** Resolve a pending request. Unknown or already-answered ids are ignored. */
  respond(id: string, decision: ApprovalDecision): void {
    const entry = this.pendingById.get(id)
    if (!entry) return
    this.pendingById.delete(id)
    this.settle(entry, decision)
  }

  /** Oldest first, so the UI can show a stable queue. */
  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()]
      .map((e) => e.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Used on cancel and on shutdown: nothing in flight gets silently allowed. */
  denyAll(): void {
    const entries = [...this.pendingById.values()]
    this.pendingById.clear()
    for (const entry of entries) this.settle(entry, 'deny')
  }
}
