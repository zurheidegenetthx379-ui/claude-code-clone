/**
 * Coordinator Mode -- Multi-agent orchestration layer
 *
 * Mirrors Claude Code's coordinator architecture: a specialized operating
 * mode where a "coordinator" agent manages a fleet of "worker" agents,
 * delegating tasks and synthesizing results.
 *
 * The coordinator is activated by setting the `CLAUDE_CODE_COORDINATOR_MODE`
 * environment variable.  When active:
 *
 *  - The system prompt is replaced with a coordinator-specific prompt that
 *    instructs the model to plan work, delegate to workers, and synthesize
 *    results.
 *
 *  - Worker results are delivered in a structured XML notification format
 *    that the coordinator model can parse and reason about.
 *
 *  - The workflow is organized into four phases: Research, Synthesis,
 *    Implementation, and Verification.  The coordinator progresses through
 *    these phases by delegating tasks to workers and evaluating their
 *    output.
 *
 * Design notes:
 *  - The coordinator never writes code directly; all implementation work
 *    is delegated to workers.  This separation of planning and execution
 *    mirrors how senior engineers lead teams.
 *  - Worker notifications use XML tags rather than JSON because the model
 *    handles XML-structured text more reliably in practice.
 *  - The coordinator's system prompt emphasizes idempotency: each worker
 *    task should be self-contained and safe to retry.
 */

// ============================================================
// Environment Detection
// ============================================================

/**
 * Environment variable that activates coordinator mode.
 *
 * Set to any truthy value (e.g. "1", "true", "yes") to enable.
 */
const COORDINATOR_ENV_VAR = 'CLAUDE_CODE_COORDINATOR_MODE'

/**
 * Check whether the current process is running in coordinator mode.
 *
 * Coordinator mode is activated when the `CLAUDE_CODE_COORDINATOR_MODE`
 * environment variable is set to a truthy value.
 *
 * @returns `true` when coordinator mode is active.
 */
export function isCoordinatorMode(): boolean {
  const value = process.env[COORDINATOR_ENV_VAR]
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

// ============================================================
// Workflow Phases
// ============================================================

/**
 * The four phases of the coordinator workflow.
 *
 * The coordinator progresses through these phases sequentially, though
 * it may cycle back to earlier phases if verification reveals issues.
 */
export const WORKFLOW_PHASES = {
  /**
   * Research phase: gather information about the codebase, understand
   * existing architecture, identify files that need to change, and assess
   * the scope of the task.
   */
  RESEARCH: 'Research',

  /**
   * Synthesis phase: analyze research findings, design the solution
   * architecture, break the work into discrete implementation tasks, and
   * assign tasks to workers.
   */
  SYNTHESIS: 'Synthesis',

  /**
   * Implementation phase: delegate implementation tasks to workers,
   * monitor progress, and handle dependencies between tasks.
   */
  IMPLEMENTATION: 'Implementation',

  /**
   * Verification phase: review worker output, run tests, validate that
   * the implementation meets the requirements, and fix any issues.
   */
  VERIFICATION: 'Verification',
} as const

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[keyof typeof WORKFLOW_PHASES]

// ============================================================
// Worker Status
// ============================================================

/**
 * Possible statuses for a worker task notification.
 */
export type WorkerStatus =
  | 'completed'
  | 'failed'
  | 'in_progress'
  | 'cancelled'
  | 'timeout'

// ============================================================
// Coordinator System Prompt
// ============================================================

/**
 * Return the coordinator-specific system prompt.
 *
 * This prompt instructs the model to operate as a multi-agent coordinator
 * that plans work, delegates to workers, and synthesizes results.  It
 * replaces the standard system prompt when coordinator mode is active.
 *
 * The prompt is structured around the four workflow phases and includes
 * instructions for interpreting worker notification XML.
 *
 * @returns The coordinator system prompt string.
 */
export function getCoordinatorSystemPrompt(): string {
  return `You are a Coordinator agent -- a senior engineering lead who orchestrates
a team of specialized worker agents to complete complex tasks.

## Your Role

You do NOT write code directly. Instead, you:
1. Analyze the user's request and break it into discrete tasks
2. Delegate tasks to worker agents using the Agent tool
3. Review worker results and synthesize them into a coherent solution
4. Iterate on any issues found during verification

## Workflow Phases

You progress through four phases. Announce each phase transition clearly.

### Phase 1: ${WORKFLOW_PHASES.RESEARCH}
Gather information about the codebase and the task:
- Use research workers to explore the codebase structure
- Identify relevant files, patterns, and dependencies
- Assess the scope and complexity of the requested changes
- Ask clarifying questions if the task is ambiguous

### Phase 2: ${WORKFLOW_PHASES.SYNTHESIS}
Design the solution and plan the work:
- Analyze research findings
- Design the architecture of the solution
- Break the implementation into discrete, idempotent tasks
- Determine task dependencies and execution order
- Assign each task to an appropriate worker

### Phase 3: ${WORKFLOW_PHASES.IMPLEMENTATION}
Delegate implementation tasks to workers:
- Spawn worker agents for each implementation task
- Provide each worker with a self-contained, detailed prompt
- Include all necessary context in each worker's prompt
- Workers should be able to complete their task independently
- Monitor worker progress and handle failures gracefully

### Phase 4: ${WORKFLOW_PHASES.VERIFICATION}
Validate the results:
- Review each worker's output for correctness
- Run tests to verify the implementation
- Check for integration issues between workers' changes
- If issues are found, return to the appropriate phase to fix them

## Worker Task Notifications

When a worker completes, you will receive a notification in this XML format:

<task-notification>
  <task-id>worker-uuid-here</task-id>
  <status>completed|failed|in_progress|cancelled|timeout</status>
  <summary>Short summary of what the worker did</summary>
  <result>Full detailed output from the worker</result>
</task-notification>

## Guidelines

- **Be thorough in research**: Spend adequate time understanding the codebase
  before making changes. Premature implementation leads to rework.
- **Write self-contained prompts**: Each worker prompt must include ALL context
  the worker needs. Workers cannot see your conversation history.
- **Prefer small tasks**: Break large tasks into smaller, focused units.
  A worker that tries to do too much is more likely to fail.
- **Handle failures gracefully**: If a worker fails, analyze the error,
  adjust the prompt, and retry. Do not give up after one failure.
- **Verify everything**: Never assume a worker's output is correct without
  verification. Run tests, read the changed files, and validate the result.
- **Communicate with the user**: Keep the user informed of your progress,
  especially during long-running tasks. Explain your plan before executing
  and summarize results after completion.`
}

// ============================================================
// Worker Result Formatting
// ============================================================

/**
 * Format a worker agent's result as an XML notification for the coordinator.
 *
 * The coordinator model receives these notifications as tool_result content
 * when a worker agent completes.  The XML structure helps the model parse
 * and reason about worker output reliably.
 *
 * @param agentId  - Unique identifier of the worker agent.
 * @param status   - Completion status of the worker task.
 * @param result   - The worker's output (text or structured data).
 * @returns Formatted XML notification string.
 *
 * @example
 * ```typescript
 * const notification = formatWorkerResult('agent-123', 'completed', 'Refactored auth module')
 * // Returns:
 * // <task-notification>
 * //   <task-id>agent-123</task-id>
 * //   <status>completed</status>
 * //   <summary>Worker agent-123 completed</summary>
 * //   <result>Refactored auth module</result>
 * // </task-notification>
 * ```
 */
export function formatWorkerResult(
  agentId: string,
  status: WorkerStatus,
  result: string,
): string {
  // Escape XML special characters in the result to prevent tag injection.
  const escapedResult = escapeXml(result)
  const escapedSummary = generateSummary(result)

  return [
    '<task-notification>',
    `  <task-id>${escapeXml(agentId)}</task-id>`,
    `  <status>${status}</status>`,
    `  <summary>${escapedSummary}</summary>`,
    `  <result>${escapedResult}</result>`,
    '</task-notification>',
  ].join('\n')
}

// ============================================================
// Phase Transition Helpers
// ============================================================

/**
 * Format a phase transition announcement for the coordinator to include
 * in its response text.
 *
 * @param fromPhase - The phase being left (or `null` for the initial transition).
 * @param toPhase   - The phase being entered.
 * @param reason    - Optional explanation for the transition.
 * @returns Formatted phase transition string.
 */
export function formatPhaseTransition(
  fromPhase: WorkflowPhase | null,
  toPhase: WorkflowPhase,
  reason?: string,
): string {
  const lines: string[] = []

  if (fromPhase) {
    lines.push(`[Phase Transition: ${fromPhase} -> ${toPhase}]`)
  } else {
    lines.push(`[Entering Phase: ${toPhase}]`)
  }

  if (reason) {
    lines.push(`Reason: ${reason}`)
  }

  return lines.join('\n')
}

/**
 * Build a coordinator task plan summary from a list of planned worker tasks.
 *
 * Used by the coordinator to communicate its plan to the user before
 * execution begins.
 *
 * @param tasks - Array of planned tasks with descriptions and assignments.
 * @returns Formatted task plan string.
 */
export function formatTaskPlan(
  tasks: Array<{
    id: string
    description: string
    workerType: string
    dependencies?: string[]
  }>,
): string {
  const lines: string[] = ['## Task Plan', '']

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!
    const deps =
      task.dependencies && task.dependencies.length > 0
        ? ` (depends on: ${task.dependencies.join(', ')})`
        : ''
    lines.push(`${i + 1}. **${task.description}** [${task.workerType}]${deps}`)
  }

  return lines.join('\n')
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Escape XML special characters to prevent tag injection in worker results.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generate a short summary from a potentially long result string.
 *
 * Takes the first non-empty line or the first 120 characters, whichever
 * is shorter.
 */
function generateSummary(result: string): string {
  const firstLine = result.split('\n').find((line) => line.trim().length > 0)
  if (!firstLine) return 'No output'

  const trimmed = firstLine.trim()
  if (trimmed.length <= 120) return escapeXml(trimmed)
  return escapeXml(trimmed.slice(0, 117)) + '...'
}
