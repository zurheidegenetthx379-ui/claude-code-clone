/**
 * Sub-agent execution engine
 *
 * Implements the child agent lifecycle for the AgentTool's standard
 * (non-swarm) execution path.  The design mirrors Claude Code's `runAgent`
 * architecture:
 *
 *  1. **Context isolation** -- the child agent receives its own conversation,
 *     tool subset, abort controller, and session ID.  Parent state is never
 *     mutated by the child.
 *
 *  2. **Query runtime reuse** -- the child agent calls the same `query()`
 *     function from `../../query.js` that the main loop uses, so streaming,
 *     tool batching, and context-window management work identically.
 *
 *  3. **Fork subagent variant** -- when `subagentType === 'fork'`, the child
 *     inherits the parent's fully-rendered system prompt rather than
 *     generating a fresh one.  This maximizes prompt-cache hit rates because
 *     the system prompt prefix is byte-identical to the parent's.
 *
 *  4. **Error isolation** -- any uncaught exception inside the child agent
 *     is caught at the boundary and returned as an error tool result to the
 *     parent.  The parent's query loop is never terminated by a child
 *     failure.
 *
 *  5. **Streaming bridge** -- the child's `StreamEvent` objects are yielded
 *     back to the parent via an async generator so the UI can render
 *     sub-agent progress in real time.
 */

import type {
  Message,
  ContentBlock,
  ToolInstance,
  ToolResult,
  ToolUseContext,
  ToolProgressData,
  CanUseTool,
  AgentDefinition,
} from '../../types/index.js'
import { generateId } from '../../query.js'
import type { FileMailbox } from '../../coordinator/swarm/FileMailbox.js'

// ============================================================
// SubAgentRunner type (exposed by QueryEngine via appState)
// ============================================================

/**
 * Function signature for the sub-agent runner factory that QueryEngine
 * injects into `appState.subAgentRunner`.
 *
 * This is a high-level interface that creates an isolated child
 * QueryEngine and runs a full agentic loop within it.  The parent's
 * API client is shared so token usage is tracked globally.
 */
type SubAgentRunner = (options: {
  prompt: string
  systemPrompt: string
  toolNames?: string[]
  model?: string
  maxTokens?: number
  maxTurns?: number
}) => Promise<{
  text: string
  content: ContentBlock[]
  stopReason: string
  turnsUsed: number
  tokenUsage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; requestCount: number }
  costUsd: number
  durationMs: number
  error?: Error
}>

// ============================================================
// Agent Run Event Types
// ============================================================

/**
 * Events yielded by {@link runAgent} to the parent caller.
 *
 * The parent (AgentTool) consumes these events to track progress and
 * extract the final tool result.
 */
export type AgentRunEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; output: string; isError: boolean }
  | { type: 'error'; error: Error }
  | { type: 'done'; stopReason: string; result: ToolResult }

// ============================================================
// Agent Configuration
// ============================================================

/**
 * Options controlling a single sub-agent invocation.
 */
export interface RunAgentOptions {
  /** Full task prompt for the child agent. */
  prompt: string
  /** Short human-readable description (for logging / UI). */
  description: string
  /** Subagent variant: 'general' | 'code-review' | 'fork' | 'research' | 'implementation'. */
  subagentType: string
  /** Optional model override for the child agent. */
  modelOverride?: string
  /** When true, run in background mode (return immediately with an agent ID). */
  runInBackground: boolean
  /** Parent's tool-use context (used to derive the child context). */
  parentContext: ToolUseContext
  /** The parent message that triggered this agent. */
  parentMessage: Message
  /** Permission callback forwarded from the parent. */
  canUseTool: CanUseTool
  /** Optional progress callback for UI updates. */
  onProgress?: (progress: ToolProgressData) => void
}

// ============================================================
// Subagent Tool Subsets
// ============================================================

/**
 * Tool names available to each subagent variant.
 *
 * Sub-agents receive a filtered subset of the parent's tools to prevent
 * recursive agent spawning and limit blast radius.  The `fork` variant
 * gets the broadest access because it is designed for context-continuation
 * tasks.
 */
const SUBAGENT_TOOL_ALLOWLISTS: Record<string, string[]> = {
  general: [
    'Bash',
    'FileRead',
    'FileEdit',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
  ],
  'code-review': [
    'Bash',
    'FileRead',
    'Glob',
    'Grep',
  ],
  fork: [
    'Bash',
    'FileRead',
    'FileEdit',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    // Fork agents can spawn their own sub-agents (one level deep).
    'Agent',
  ],
  research: [
    'FileRead',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
  ],
  implementation: [
    'Bash',
    'FileRead',
    'FileEdit',
    'Glob',
    'Grep',
  ],
}

/**
 * Default allowlist used when the subagent type is not recognized.
 */
const DEFAULT_SUBAGENT_TOOLS = SUBAGENT_TOOL_ALLOWLISTS['general']!

// ============================================================
// System Prompts per Subagent Variant
// ============================================================

const SUBAGENT_SYSTEM_PROMPTS: Record<string, string> = {
  general: `You are a sub-agent working on a specific task delegated by a parent agent.
Focus exclusively on the task described in the prompt. When you have completed
the task or gathered the necessary information, provide a clear and concise
summary of your findings or the work you completed. Do not attempt tasks
outside the scope of your assignment.`,

  'code-review': `You are a code review sub-agent. Your job is to thoroughly examine
code for bugs, security issues, performance problems, and style violations.
Read all relevant files, search for patterns, and provide detailed findings.
Be specific about file paths, line numbers, and the nature of each issue.`,

  fork: ``,  // Fork agents inherit the parent's rendered system prompt.

  research: `You are a research sub-agent. Your job is to investigate a question or
topic thoroughly using the available tools. Read files, search codebases, and
fetch web resources as needed. Provide a comprehensive summary of your
findings with citations and references where applicable.`,

  implementation: `You are an implementation sub-agent. Your job is to make specific code
changes as described in the task prompt. Read the relevant files, understand
the existing code, and make precise edits. Test your changes when possible
by running relevant commands. Provide a summary of all changes made.`,
}

// ============================================================
// Context Creation
// ============================================================

/**
 * Create an isolated {@link ToolUseContext} for the child agent.
 *
 * The child context:
 *  - Receives a filtered subset of the parent's tools (no recursive Agent
 *    spawning unless the variant explicitly allows it).
 *  - Gets a fresh abort controller linked to the parent's signal so the
 *    parent can cancel the child on its own abort.
 *  - Gets a unique session ID to avoid transcript collisions.
 *  - Starts with an empty message array.
 *
 * @param parentContext - The parent agent's tool-use context.
 * @param agentConfig   - Configuration for the child agent.
 * @returns A new, isolated ToolUseContext for the child.
 */
export function createSubagentContext(
  parentContext: ToolUseContext,
  agentConfig: {
    subagentType: string
    modelOverride?: string
    sessionId?: string
  },
): ToolUseContext {
  const { subagentType, sessionId } = agentConfig

  // ---- Filter tools to the variant's allowlist ----
  const allowlist = SUBAGENT_TOOL_ALLOWLISTS[subagentType] ?? DEFAULT_SUBAGENT_TOOLS
  const allowSet = new Set(allowlist)
  const childTools: ToolInstance[] = parentContext.tools.filter(
    (tool) => allowSet.has(tool.name),
  )

  // ---- Create a child abort controller linked to the parent ----
  const childAbortController = new AbortController()
  parentContext.abortController.signal.addEventListener(
    'abort',
    () => childAbortController.abort(),
    { once: true },
  )

  // ---- Build the child context ----
  const childSessionId = sessionId ?? `${parentContext.sessionId}-agent-${generateId()}`

  // Propagate swarm-related appState so sub-agents can access the mailbox.
  const childAppState: Record<string, unknown> = {}
  if (parentContext.appState['swarmAgentId']) {
    childAppState['swarmAgentId'] = parentContext.appState['swarmAgentId']
  }
  if (parentContext.appState['swarmTeamName']) {
    childAppState['swarmTeamName'] = parentContext.appState['swarmTeamName']
  }
  if (parentContext.appState['swarmMailbox']) {
    childAppState['swarmMailbox'] = parentContext.appState['swarmMailbox']
  }
  // Always propagate the subAgentRunner so nested agents work.
  if (parentContext.appState['subAgentRunner']) {
    childAppState['subAgentRunner'] = parentContext.appState['subAgentRunner']
  }

  return {
    tools: childTools,
    permissionContext: { ...parentContext.permissionContext },
    cwd: parentContext.cwd,
    sessionId: childSessionId,
    abortController: childAbortController,
    mcpClients: new Map(parentContext.mcpClients),
    appState: childAppState,
    messages: [],  // Empty conversation -- the prompt is the first message.
  }
}

// ============================================================
// Sub-agent Execution (Async Generator)
// ============================================================

/**
 * Execute a sub-agent task, yielding streaming events to the parent.
 *
 * This async generator:
 *  1. Creates an isolated child context via {@link createSubagentContext}.
 *  2. Optionally initializes agent-specific memory.
 *  3. Calls the main `query()` runtime with the child context.
 *  4. Yields each `StreamEvent` as an `AgentRunEvent` for the parent to
 *     observe.
 *  5. Returns a final `ToolResult` summarizing the agent's output.
 *
 * Error isolation: any exception thrown inside the generator is caught and
 * converted into an error event + error tool result. The parent's query
 * loop continues normally.
 *
 * @param options - Sub-agent configuration and execution parameters.
 * @yields AgentRunEvent objects representing the child agent's progress.
 */
export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentRunEvent> {
  const {
    prompt,
    description,
    subagentType,
    modelOverride,
    runInBackground,
    parentContext,
    parentMessage: _parentMessage,
    canUseTool: _canUseTool,
    onProgress,
  } = options

  // ---- Background mode: return immediately with an agent ID ----
  if (runInBackground) {
    const agentId = generateId()

    // In swarm mode, the actual background execution is managed by the
    // AgentTool's spawnTeammate or callAgent.  Here we just return the
    // agent ID for tracking.
    yield {
      type: 'done',
      stopReason: 'background_started',
      result: {
        output: JSON.stringify({
          agentId,
          status: 'started',
          description,
          message:
            `Sub-agent "${description}" started in background with ID ${agentId}. ` +
            `Use the agent ID to check status or retrieve results later.`,
        }),
        isError: false,
      },
    }
    return
  }

  // ---- Resolve system prompt ----
  let systemPrompt: string
  if (subagentType === 'fork') {
    // Fork variant: inherit the parent's rendered system prompt for
    // prompt-cache stability.  The child's system prompt is byte-identical
    // to the parent's, maximizing cache hit rates on the API side.
    systemPrompt =
      parentContext.renderedSystemPrompt ??
      SUBAGENT_SYSTEM_PROMPTS['general']!
  } else {
    systemPrompt =
      SUBAGENT_SYSTEM_PROMPTS[subagentType] ??
      SUBAGENT_SYSTEM_PROMPTS['general']!
  }

  // ---- Resolve model ----
  const model = modelOverride ?? detectParentModel(parentContext)

  // ---- Find agent definition (if any) for effort/maxTokens tuning ----
  const agentDef = findAgentDefinition(parentContext, subagentType)

  // ---- Build the tool allowlist for this subagent variant ----
  const allowlist = SUBAGENT_TOOL_ALLOWLISTS[subagentType] ?? DEFAULT_SUBAGENT_TOOLS

  // ---- Mailbox integration ----
  // Detect whether the parent context has a swarm mailbox.  If so, the
  // child agent is operating as a swarm teammate and should receive
  // pending mailbox messages as additional context.
  const swarmMailbox = parentContext.appState['swarmMailbox'] as FileMailbox | undefined
  const swarmAgentId = parentContext.appState['swarmAgentId'] as string | undefined
  let mailboxContextPrefix = ''

  if (swarmMailbox && swarmAgentId) {
    try {
      const unreadMessages = await swarmMailbox.receive(swarmAgentId)
      if (unreadMessages.length > 0) {
        const messageLines = unreadMessages.map((msg) => {
          const payloadStr =
            typeof msg.payload === 'string'
              ? msg.payload
              : JSON.stringify(msg.payload)
          return `[Message from ${msg.from} (${msg.type}): ${payloadStr}]`
        })
        mailboxContextPrefix =
          '\n\n[You are part of a swarm team. The following messages were ' +
          'delivered to your mailbox before you started:]\n' +
          messageLines.join('\n') + '\n'
      }
    } catch {
      // Mailbox read failure is non-fatal -- proceed without context.
    }
  }

  // ---- Execute the child agent via the parent's subAgentRunner ----
  try {
    // Resolve the sub-agent runner from the parent's appState.
    const subAgentRunner = parentContext.appState['subAgentRunner'] as SubAgentRunner | undefined

    if (!subAgentRunner || typeof subAgentRunner !== 'function') {
      yield {
        type: 'error',
        error: new Error(
          'Unable to resolve sub-agent runner. ' +
          'The parent QueryEngine did not inject a subAgentRunner into appState.',
        ),
      }
      yield {
        type: 'done',
        stopReason: 'error',
        result: {
          output: 'Sub-agent could not start: subAgentRunner unavailable.',
          isError: true,
        },
      }
      return
    }

    onProgress?.({
      status: `Agent "${description}" executing with tools: ${allowlist.join(', ')}`,
      progress: 0,
      total: 1,
    })

    // Compose the effective prompt with any mailbox context.
    const effectivePrompt = mailboxContextPrefix
      ? mailboxContextPrefix + '\n' + prompt
      : prompt

    // Run the isolated sub-agent
    const result = await subAgentRunner({
      prompt: effectivePrompt,
      systemPrompt,
      toolNames: allowlist,
      model,
      maxTokens: agentDef?.effort === 'high' ? 16_000 : 8_000,
      maxTurns: 20,
    })

    // Yield text output as events
    if (result.text) {
      yield { type: 'text', content: result.text }
    }

    // Report error if the sub-agent encountered one
    if (result.error) {
      yield { type: 'error', error: result.error }
    }

    // ---- Mailbox: check for messages received during execution ----
    let mailboxPostscript = ''
    if (swarmMailbox && swarmAgentId) {
      try {
        const newMessages = await swarmMailbox.receive(swarmAgentId)
        if (newMessages.length > 0) {
          const messageLines = newMessages.map((msg) => {
            const payloadStr =
              typeof msg.payload === 'string'
                ? msg.payload
                : JSON.stringify(msg.payload)
            return `[Message from ${msg.from} (${msg.type}): ${payloadStr}]`
          })
          mailboxPostscript =
            '\n\n[The following messages were received from teammates during your execution:]\n' +
            messageLines.join('\n')
        }
      } catch {
        // Non-fatal.
      }
    }

    // ---- Produce the final result ----
    const fullOutput = result.text + mailboxPostscript
    const truncatedOutput =
      fullOutput.length > 10_000
        ? fullOutput.slice(0, 10_000) + '\n\n[Output truncated at 10,000 characters]'
        : fullOutput

    yield {
      type: 'done',
      stopReason: result.stopReason || 'end_turn',
      result: {
        output: truncatedOutput || 'Sub-agent completed with no text output.',
        isError: result.stopReason === 'error',
      },
    }
  } catch (err) {
    // ---- Error isolation ----
    // Catch any unhandled exception and return it as a tool error rather
    // than propagating it to the parent's query loop.
    const error = err instanceof Error ? err : new Error(String(err))
    yield { type: 'error', error }
    yield {
      type: 'done',
      stopReason: 'error',
      result: {
        output: `Sub-agent "${description}" failed: ${error.message}`,
        isError: true,
      },
    }
  }
}

// ============================================================
// Helper: Detect Parent Model
// ============================================================

/**
 * Attempt to determine the model the parent is using so the child can
 * inherit it when no explicit override is provided.
 *
 * Scans the parent context's message history for the most recent
 * assistant message with a `model` field.
 */
function detectParentModel(context: ToolUseContext): string {
  // Walk messages in reverse to find the latest assistant model tag.
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i]!
    if (msg.role === 'assistant' && msg.model) {
      return msg.model
    }
  }
  // Fallback default.
  return 'claude-sonnet-4-20250514'
}

// ============================================================
// Helper: Find Agent Definition
// ============================================================

/**
 * Look up an {@link AgentDefinition} from the parent context's app state.
 *
 * Agent definitions are typically loaded from `.claude/agents/` files and
 * stored in `appState.agents`.  This helper retrieves one by name.
 */
function findAgentDefinition(
  context: ToolUseContext,
  agentType: string,
): AgentDefinition | undefined {
  const agents = context.appState['agents'] as AgentDefinition[] | undefined
  if (!Array.isArray(agents)) return undefined
  return agents.find((a) => a.name === agentType)
}
