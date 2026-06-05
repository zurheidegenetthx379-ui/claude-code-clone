/**
 * Background Task Registry -- tracks agents running in background mode.
 *
 * When the AgentTool spawns a sub-agent with `run_in_background: true` or
 * a swarm teammate, the agent runs asynchronously.  This registry provides:
 *
 *  - Registration and lifecycle tracking for each background agent
 *  - Cancellation via AbortController
 *  - Completion/failure notification with results
 *  - A `waitForCompletion()` promise-based API for awaiting a specific task
 *
 * Design notes:
 *  - Each task holds its own AbortController so cancellation is granular.
 *  - The registry is process-local and lives in `appState.backgroundTaskRegistry`.
 *  - `waitForCompletion` uses a polling loop with a configurable timeout;
 *    it does not rely on event emitters to keep the dependency surface small.
 *  - On graceful shutdown, `cancelAll()` aborts every running task to
 *    prevent orphaned agent processes.
 */

// ============================================================
// Background Task Interface
// ============================================================

/**
 * Represents a single background agent task.
 */
export interface BackgroundTask {
  /** The agent ID this task belongs to. */
  agentId: string
  /** Human-readable description of what the agent is doing. */
  description: string
  /** Current status. */
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** Unix timestamp (ms) when the task started. */
  startedAt: number
  /** Unix timestamp (ms) when the task reached a terminal state. */
  completedAt?: number
  /** Result text (set on completion). */
  result?: string
  /** Error message (set on failure). */
  error?: string
  /** AbortController used to cancel this task. */
  abortController: AbortController
}

// ============================================================
// Background Task Registry
// ============================================================

export class BackgroundTaskRegistry {
  /** All registered tasks keyed by agentId. */
  private tasks: Map<string, BackgroundTask> = new Map()

  // ----------------------------------------------------------
  // Registration
  // ----------------------------------------------------------

  /**
   * Register a new background task.
   *
   * The task starts in `running` status.  The caller is responsible for
   * actually executing the agent loop and calling `complete()` or `fail()`
   * when done.
   *
   * @returns The newly created BackgroundTask.
   */
  register(
    agentId: string,
    description: string,
    abortController: AbortController,
  ): BackgroundTask {
    const task: BackgroundTask = {
      agentId,
      description,
      status: 'running',
      startedAt: Date.now(),
      abortController,
    }

    this.tasks.set(agentId, task)
    return task
  }

  // ----------------------------------------------------------
  // Terminal state transitions
  // ----------------------------------------------------------

  /**
   * Mark a task as completed with a result string.
   */
  complete(agentId: string, result: string): void {
    const task = this.tasks.get(agentId)
    if (!task) return

    task.status = 'completed'
    task.result = result
    task.completedAt = Date.now()
  }

  /**
   * Mark a task as failed with an error description.
   */
  fail(agentId: string, error: string): void {
    const task = this.tasks.get(agentId)
    if (!task) return

    task.status = 'failed'
    task.error = error
    task.completedAt = Date.now()
  }

  // ----------------------------------------------------------
  // Cancellation
  // ----------------------------------------------------------

  /**
   * Cancel a running background task.
   *
   * Aborts the task's AbortController (which signals the agent loop to
   * stop) and marks the task as `cancelled`.
   *
   * @returns `true` if the task was found and cancelled, `false` otherwise.
   */
  cancel(agentId: string): boolean {
    const task = this.tasks.get(agentId)
    if (!task || task.status !== 'running') return false

    try {
      task.abortController.abort()
    } catch {
      // Abort may throw if the signal is already aborted -- ignore.
    }
    task.status = 'cancelled'
    task.completedAt = Date.now()
    return true
  }

  /**
   * Cancel all currently running tasks.
   *
   * Used during graceful shutdown to ensure no orphaned agents survive.
   */
  cancelAll(): void {
    for (const [_agentId, task] of this.tasks) {
      if (task.status === 'running') {
        try {
          task.abortController.abort()
        } catch {
          // Best-effort.
        }
        task.status = 'cancelled'
        task.completedAt = Date.now()
      }
    }
  }

  // ----------------------------------------------------------
  // Queries
  // ----------------------------------------------------------

  /**
   * Get the current state of a background task.
   */
  getTask(agentId: string): BackgroundTask | undefined {
    return this.tasks.get(agentId)
  }

  /**
   * List all tasks, optionally filtered by status.
   */
  listTasks(status?: BackgroundTask['status']): BackgroundTask[] {
    const all = Array.from(this.tasks.values())
    if (status) {
      return all.filter((t) => t.status === status)
    }
    return all
  }

  // ----------------------------------------------------------
  // Awaiting completion
  // ----------------------------------------------------------

  /**
   * Wait for a specific task to reach a terminal state.
   *
   * Polls the task status every 250 ms until it is no longer `running`.
   * If `timeoutMs` is provided and the task does not complete within that
   * window, the returned promise resolves with the task in its current
   * (still-running) state rather than rejecting.
   *
   * @param agentId   - The agent ID to wait for.
   * @param timeoutMs - Maximum time to wait (ms).  Default: 300000 (5 min).
   * @returns The BackgroundTask in its final (or timed-out) state.
   * @throws If the agent ID is not registered.
   */
  async waitForCompletion(
    agentId: string,
    timeoutMs: number = 300_000,
  ): Promise<BackgroundTask> {
    const task = this.tasks.get(agentId)
    if (!task) {
      throw new Error(`No background task registered for agent "${agentId}".`)
    }

    const deadline = Date.now() + timeoutMs
    const POLL_INTERVAL = 250

    while (task.status === 'running' && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL))
    }

    return task
  }
}
