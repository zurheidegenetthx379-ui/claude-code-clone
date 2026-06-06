/**
 * ApprovalBridge — bridges the QueryEngine's synchronous approvalCallback
 * with an asynchronous UI confirmation dialog (Ink TUI, web, etc.).
 *
 * The engine emits `tool:approval_needed` and then immediately calls
 * `approvalCallback`.  The bridge creates a pending promise in the
 * callback, which the UI resolves once the user responds.
 *
 * Usage:
 *   const bridge = new ApprovalBridge()
 *
 *   // Pass bridge.callback as the approvalCallback to createQueryEngine
 *   const engine = createQueryEngine(runtime, {
 *     approvalCallback: bridge.callback,
 *   })
 *
 *   // In the UI component, listen for tool:approval_needed events,
 *   // then call bridge.respond(true|false) when the user decides.
 */

import { EventEmitter } from 'node:events'

export interface PendingApproval {
  toolName: string
  input: Record<string, unknown>
}

export class ApprovalBridge extends EventEmitter {
  private pendingResolve: ((approved: boolean) => void) | null = null

  /** Information about the current pending approval (if any). */
  pending: PendingApproval | null = null

  /**
   * The callback to pass as `approvalCallback` to createQueryEngine.
   *
   * It creates a pending promise and emits a 'request' event so the UI
   * can display a confirmation dialog.  The promise resolves when the
   * UI calls `respond()`.
   */
  callback = (toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    this.pending = { toolName, input }

    const promise = new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve
    })

    // Emit after setting up the resolver so listeners can react immediately.
    this.emit('request', this.pending)

    return promise
  }

  /**
   * Respond to the current pending approval.
   *
   * @param approved — true to approve, false to deny.
   */
  respond(approved: boolean): void {
    const resolve = this.pendingResolve
    this.pendingResolve = null
    this.pending = null

    if (resolve) {
      resolve(approved)
      this.emit('responded', approved)
    }
  }

  /** Whether there is currently a pending approval awaiting response. */
  get isPending(): boolean {
    return this.pendingResolve !== null
  }
}
