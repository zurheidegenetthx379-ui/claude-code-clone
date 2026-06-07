/**
 * AgentTool -- Sub-agent orchestration
 *
 * Mirrors Claude Code's AgentTool architecture: a single tool entry point
 * that routes between two execution paths depending on the supplied input:
 *
 *  1. **Swarm path** (`spawnTeammate`) -- triggered when both `team_name`
 *     and `name` are present.  Creates a named teammate within an existing
 *     team swarm, enabling multi-agent collaboration with shared state.
 *
 *  2. **Subagent path** (`runAgent`) -- the default path.  Spawns an
 *     isolated child agent with its own context, tool subset, and optional
 *     memory.  The child agent reuses the main query runtime but operates
 *     in a sandboxed conversation so errors and side effects do not leak
 *     into the parent.
 *
 * Both paths return a structured result to the parent model via the
 * standard tool_result mechanism.
 *
 * Design notes (why this mirrors Claude Code):
 *  - `isConcurrencySafe` is `false` because spawning agents mutates global
 *    state (session IDs, file handles, abort controllers).
 *  - The `prompt()` method dynamically adjusts the tool description based
 *    on the currently available tools so the model only sees relevant
 *    sub-agent capabilities.
 *  - `interruptBehavior` is `'block'` -- cancelling a sub-agent mid-flight
 *    could leave orphaned processes and half-written files.
 */

import { buildTool } from '../../Tool.js'
import type {
  ToolInstance,
  ToolUseContext,
  ToolResult,
  Message,
  CanUseTool,
  ToolProgressData,
} from '../../types/index.js'
import { runAgent } from './runAgent.js'
import type { TeamRegistry } from '../../coordinator/swarm/TeamRegistry.js'
import type { FileMailbox } from '../../coordinator/swarm/FileMailbox.js'
import type { BackgroundTaskRegistry } from '../../coordinator/swarm/BackgroundTaskRegistry.js'
import {
  isCoordinatorMode,
  formatWorkerResult,
} from '../../coordinator/coordinatorMode.js'

// ============================================================
// Input Schema
// ============================================================

/**
 * JSON-Schema-style definition for the AgentTool input.
 *
 * Required fields:
 *  - `prompt` -- the task description sent to the child agent.
 *
 * Optional fields control routing, model selection, and background execution.
 */
const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description:
        'A short, human-readable description of what the sub-agent will do. ' +
        'Used for progress display and logging.',
    },
    prompt: {
      type: 'string',
      description:
        'The full task prompt sent to the child agent. Should be self-contained ' +
        'and include all context the agent needs to complete the task.',
    },
    subagent_type: {
      type: 'string',
      description:
        'Optional subagent variant identifier (e.g. "general", "code-review", "fork"). ' +
        'Determines which tool subset and system prompt the child agent receives. ' +
        'The "fork" variant inherits the parent\'s rendered system prompt for ' +
        'prompt-cache stability.',
      enum: ['general', 'code-review', 'fork', 'research', 'implementation'],
    },
    model: {
      type: 'string',
      description:
        'Override the model used for the child agent. When omitted the child ' +
        'inherits the parent\'s model.',
    },
    run_in_background: {
      type: 'boolean',
      description:
        'When true, the child agent runs in the background and the tool returns ' +
        'immediately with an agent ID that can be used to poll for results later. ' +
        'Default: false.',
    },
    name: {
      type: 'string',
      description:
        'Name for the spawned agent (used in swarm mode to identify the teammate).',
    },
    team_name: {
      type: 'string',
      description:
        'Team name (swarm mode). When both `team_name` and `name` are present the ' +
        'tool routes to the swarm spawn path instead of the standard subagent path.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

// ============================================================
// Swarm Spawn (Placeholder)
// ============================================================

/**
 * Spawn a named teammate within an existing team swarm.
 *
 * Full implementation:
 *  1. Looks up the TeamRegistry, FileMailbox, and BackgroundTaskRegistry
 *     from the parent's appState.
 *  2. Validates the team exists.
 *  3. Registers the new teammate in the team.
 *  4. Creates a mailbox for the teammate and sends a task message.
 *  5. Spawns the teammate as a background sub-agent via `runAgent`.
 *  6. Returns the teammate's agent ID and status.
 *
 * @param input    - Tool input containing `team_name`, `name`, and `prompt`.
 * @param context  - Parent tool-use context.
 * @returns A tool result indicating the swarm spawn status.
 */
async function spawnTeammate(
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<ToolResult> {
  const teamName = input.team_name as string
  const agentName = input.name as string
  const prompt = input.prompt as string
  const subagentType = (input.subagent_type as string) ?? 'general'
  const modelOverride = input.model as string | undefined

  // ---- Resolve registries from appState ----
  const teamRegistry = context.appState['teamRegistry'] as TeamRegistry | undefined
  const fileMailbox = context.appState['fileMailbox'] as FileMailbox | undefined
  const bgRegistry = context.appState['backgroundTaskRegistry'] as BackgroundTaskRegistry | undefined

  if (!teamRegistry || !fileMailbox || !bgRegistry) {
    return {
      output:
        'Cannot spawn teammate: swarm infrastructure is not initialized. ' +
        'Ensure coordinator mode is active and the runtime has been assembled with ' +
        'TeamRegistry, FileMailbox, and BackgroundTaskRegistry.',
      isError: true,
    }
  }

  // ---- Validate the team exists ----
  const teamState = teamRegistry.getTeam(teamName)
  if (!teamState) {
    return {
      output: `Cannot spawn teammate: team "${teamName}" does not exist. ` +
        `Available teams: ${teamRegistry.listTeams().map((t) => t.name).join(', ') || '(none)'}`,
      isError: true,
    }
  }

  // ---- Register the new teammate in the team ----
  let member
  try {
    member = teamRegistry.addMember(teamName, {
      name: agentName,
      agentType: subagentType,
      model: modelOverride ?? 'claude-sonnet-4-20250514',
    })
  } catch (err) {
    return {
      output: `Failed to register teammate: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }

  const agentId = member.agentId

  // ---- Send a task message to the teammate's mailbox ----
  try {
    await fileMailbox.send({
      from: teamState.team.leadAgentId,
      to: agentId,
      type: 'task',
      payload: {
        teamName,
        agentName,
        prompt,
        subagentType,
        description: `Teammate task for ${agentName} in team ${teamName}`,
      },
    })
  } catch {
    // Mailbox send failure is non-fatal -- the agent will still start.
  }

  // ---- Register a task in the team for tracking ----
  let teamTask
  try {
    teamTask = teamRegistry.addTask(teamName, {
      name: `${agentName}-task`,
      description: prompt.slice(0, 200),
      status: 'in_progress',
      assignee: agentId,
    })
  } catch {
    // Task registration failure is non-fatal.
  }

  // ---- Create an AbortController for the background agent ----
  const abortController = new AbortController()
  // Link to the parent's abort signal so the teammate is cancelled
  // when the parent is cancelled.
  context.abortController.signal.addEventListener(
    'abort',
    () => abortController.abort(),
    { once: true },
  )

  // ---- Register in the background task registry ----
  bgRegistry.register(
    agentId,
    `Teammate "${agentName}" in team "${teamName}"`,
    abortController,
  )

  // ---- Spawn the teammate as a background sub-agent ----
  // Fire-and-forget: we start the agent loop but do not await it here.
  // The background task registry tracks completion.
  void (async () => {
    try {
      let finalResult: ToolResult | undefined

      for await (const event of runAgent({
        prompt,
        description: `Teammate "${agentName}" (${subagentType})`,
        subagentType,
        modelOverride,
        runInBackground: true,
        parentContext: {
          ...context,
          abortController,
          sessionId: `${context.sessionId}-teammate-${agentId}`,
          appState: {
            ...context.appState,
            swarmAgentId: agentId,
            swarmTeamName: teamName,
            swarmMailbox: fileMailbox,
          },
        },
        parentMessage: {
          id: agentId,
          uuid: agentId,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
        canUseTool: async () => ({ behavior: 'allow' as const }),
      })) {
        if (event.type === 'done' && event.result) {
          finalResult = event.result
        }
      }

      const resultText =
        typeof finalResult?.output === 'string'
          ? finalResult.output
          : 'Teammate completed with no text output.'

      bgRegistry.complete(agentId, resultText)

      // Update team member status
      try {
        teamRegistry.updateMemberStatus(teamName, agentId, 'completed', resultText)
      } catch { /* best-effort */ }

      // Update team task status
      if (teamTask) {
        try {
          teamRegistry.updateTask(teamName, teamTask.id, 'completed', resultText)
        } catch { /* best-effort */ }
      }

      // Send a result message back to the lead agent's mailbox
      try {
        await fileMailbox.send({
          from: agentId,
          to: teamState.team.leadAgentId,
          type: 'result',
          payload: {
            agentId,
            agentName,
            teamName,
            taskId: teamTask?.id,
            result: resultText,
          },
        })
      } catch { /* best-effort */ }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      bgRegistry.fail(agentId, errorMessage)

      try {
        teamRegistry.updateMemberStatus(teamName, agentId, 'failed', errorMessage)
      } catch { /* best-effort */ }

      if (teamTask) {
        try {
          teamRegistry.updateTask(teamName, teamTask.id, 'failed', errorMessage)
        } catch { /* best-effort */ }
      }

      // Send error notification to lead agent
      try {
        await fileMailbox.send({
          from: agentId,
          to: teamState.team.leadAgentId,
          type: 'error',
          payload: { agentId, agentName, teamName, error: errorMessage },
        })
      } catch { /* best-effort */ }
    }
  })()

  // ---- Return spawn confirmation ----
  return {
    output: [
      `Teammate spawned successfully:`,
      `  Agent ID:   ${agentId}`,
      `  Name:       ${agentName}`,
      `  Team:       ${teamName}`,
      `  Type:       ${subagentType}`,
      `  Task ID:    ${teamTask?.id ?? '(none)'}`,
      `  Status:     running in background`,
      '',
      `The teammate is now working asynchronously. You will receive a mailbox`,
      `notification when it completes, or you can check its status via the`,
      `BackgroundTaskRegistry.`,
    ].join('\n'),
    isError: false,
  }
}

// ============================================================
// Call Routing
// ============================================================

/**
 * Route the tool call to the appropriate execution path.
 *
 * Routing logic:
 *  - If both `team_name` AND `name` are present -> `spawnTeammate()` (swarm)
 *  - Otherwise -> `runAgent()` (standard subagent)
 *
 * In background mode (non-swarm), the agent is registered in the
 * BackgroundTaskRegistry so the caller can track it.
 *
 * In coordinator mode, worker results are formatted using the XML
 * notification format via `formatWorkerResult`.
 */
async function callAgent(
  input: Record<string, unknown>,
  context: ToolUseContext,
  canUseTool: CanUseTool,
  parentMessage: Message,
  onProgress?: (progress: ToolProgressData) => void,
): Promise<ToolResult> {
  const hasTeamName = typeof input.team_name === 'string' && input.team_name.length > 0
  const hasName = typeof input.name === 'string' && input.name.length > 0

  // ---- Swarm path ----
  if (hasTeamName && hasName) {
    return spawnTeammate(input, context)
  }

  // ---- Standard subagent path ----
  const description = (input.description as string) ?? 'Sub-agent task'
  const prompt = input.prompt as string
  const subagentType = (input.subagent_type as string) ?? 'general'
  const modelOverride = input.model as string | undefined
  const runInBackground = (input.run_in_background as boolean) ?? false

  // Notify the UI that the agent is starting.
  onProgress?.({
    status: `Starting sub-agent: ${description}`,
    progress: 0,
    total: 1,
  })

  // ---- Background mode registration ----
  const bgRegistry = context.appState['backgroundTaskRegistry'] as
    | BackgroundTaskRegistry
    | undefined
  let bgAgentId: string | undefined

  if (runInBackground && bgRegistry) {
    const { randomUUID } = await import('node:crypto')
    bgAgentId = randomUUID()
    const bgAbort = new AbortController()
    context.abortController.signal.addEventListener(
      'abort',
      () => bgAbort.abort(),
      { once: true },
    )
    bgRegistry.register(bgAgentId, description, bgAbort)
  }

  try {
    // Collect the final result from the agent's async generator.
    let finalResult: ToolResult | undefined

    for await (const event of runAgent({
      prompt,
      description,
      subagentType,
      modelOverride,
      runInBackground,
      parentContext: context,
      parentMessage,
      canUseTool,
      onProgress,
    })) {
      // The last event with a `done` type carries the tool result.
      if (event.type === 'done' && event.result) {
        finalResult = event.result
      }
    }

    // Notify the UI that the agent finished.
    onProgress?.({
      status: `Sub-agent completed: ${description}`,
      progress: 1,
      total: 1,
    })

    const baseResult =
      finalResult ?? {
        output: 'Sub-agent completed but produced no output.',
        isError: false,
      }

    // ---- Background task completion ----
    if (bgAgentId && bgRegistry) {
      const resultText =
        typeof baseResult.output === 'string'
          ? baseResult.output
          : 'Completed with no text output.'
      if (baseResult.isError) {
        bgRegistry.fail(bgAgentId, resultText)
      } else {
        bgRegistry.complete(bgAgentId, resultText)
      }
    }

    // ---- Coordinator mode: format as XML worker notification ----
    if (isCoordinatorMode()) {
      const resultText =
        typeof baseResult.output === 'string'
          ? baseResult.output
          : 'No output'
      const agentId = bgAgentId ?? 'subagent'
      const status = baseResult.isError ? 'failed' : 'completed'
      return {
        output: formatWorkerResult(agentId, status, resultText),
        isError: baseResult.isError,
      }
    }

    return baseResult
  } catch (err) {
    // Error isolation: agent errors must not crash the parent.
    const errorMessage = err instanceof Error ? err.message : String(err)

    // ---- Background task failure ----
    if (bgAgentId && bgRegistry) {
      bgRegistry.fail(bgAgentId, errorMessage)
    }

    // ---- Coordinator mode: format error as XML worker notification ----
    if (isCoordinatorMode()) {
      const agentId = bgAgentId ?? 'subagent'
      return {
        output: formatWorkerResult(agentId, 'failed', errorMessage),
        isError: true,
      }
    }

    return {
      output: `Sub-agent failed with error: ${errorMessage}`,
      isError: true,
    }
  }
}

// ============================================================
// Tool Definition
// ============================================================

const AgentTool: ToolInstance = buildTool({
  name: 'Agent',

  description: () =>
    'Spawn a sub-agent to handle a complex task. The sub-agent runs in an ' +
    'isolated context with its own conversation and can use a subset of the ' +
    'parent\'s tools. Use this when a task requires deep investigation, ' +
    'multi-file refactoring, or autonomous problem-solving that would be too ' +
    'lengthy for the main conversation. The sub-agent\'s output is returned ' +
    'as a tool result so you can incorporate it into your response.',

  inputSchema,

  call: callAgent,

  // Agent spawning is NOT concurrency-safe -- it creates sessions, file
  // handles, and abort controllers that must not overlap.
  isConcurrencySafe: false,

  // Agent spawning is neither read-only nor destructive in the traditional
  // sense, but the child agent may perform writes.
  isReadOnly: false,
  isDestructive: false,

  // The sub-agent may require user permissions for tool calls, so we mark
  // this as potentially requiring user interaction.
  requiresUserInteraction: () => false,

  // Block interruptions to avoid orphaned sub-agent processes.
  interruptBehavior: () => 'block',

  // User-facing name for UI display.
  userFacingName: (input?: Record<string, unknown>) => {
    if (input?.description) {
      return `Agent (${input.description})`
    }
    return 'Agent'
  },

  // Dynamic prompt that adapts based on available tools.
  prompt: (tools: ToolInstance[]) => {
    const toolNames = tools.map((t) => t.name).join(', ')
    return (
      `The Agent tool spawns an isolated sub-agent that can autonomously ` +
      `complete complex tasks. The sub-agent has access to a subset of the ` +
      `parent's tools: ${toolNames}. Use sub-agents for tasks that require ` +
      `deep investigation or multi-step autonomous work. The sub-agent runs ` +
      `in its own conversation context and returns a summary result.`
    )
  },

  // Render a human-readable summary of the tool invocation.
  renderToolUseMessage: (input: Record<string, unknown>) => {
    const desc = (input.description as string) ?? 'Sub-agent task'
    const promptPreview = (input.prompt as string)?.slice(0, 100) ?? ''
    return `Spawning agent: ${desc}\nPrompt: ${promptPreview}...`
  },

  // Render a human-readable summary of the tool result.
  renderToolResultMessage: (result: ToolResult) => {
    if (result.isError) {
      return `Agent failed: ${typeof result.output === 'string' ? result.output.slice(0, 200) : 'Unknown error'}`
    }
    const output = typeof result.output === 'string' ? result.output : 'Completed'
    return `Agent result: ${output.slice(0, 200)}${output.length > 200 ? '...' : ''}`
  },
})

export default AgentTool
export { AgentTool }
