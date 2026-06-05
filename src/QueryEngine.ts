/**
 * QueryEngine — headless / SDK execution engine
 *
 * Orchestrates the full agentic query cycle: sends messages to Claude,
 * receives streaming responses, executes any tool calls the model requests,
 * feeds results back, and repeats until the model produces a final answer
 * or a turn/cost limit is reached.
 *
 * Designed for headless operation (no UI dependency) and exposes an
 * EventEmitter interface so that hosts can observe progress, stream text,
 * or integrate with higher-level UI frameworks.
 *
 * Architecture mirrors Claude Code's QueryEngine.ts:
 *  - Single-turn `run(prompt)` and multi-turn `runMultiTurn(messages)` entry
 *    points
 *  - Cooperative cancellation via `abort()`
 *  - Per-turn cost and token accounting
 *  - Concurrent execution of read-only / concurrency-safe tools
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

import { ClaudeApiClient, createApiClient } from './services/api/claude.js'
import type { TokenUsage, StreamOptions } from './services/api/claude.js'
import type {
  ContentBlock,
  HookDefinition,
  Message,
  PermissionContext,
  PermissionResult,
  ToolInstance,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseContext,
} from './types/index.js'
import {
  executeToolCall,
  buildPermissionChecker,
} from './utils/toolExecutor.js'

// ============================================================
// Event Types
// ============================================================

/**
 * Events emitted by the QueryEngine during execution.
 *
 * All events carry structured payloads so that consumers can reconstruct
 * a UI, persist transcripts, or pipe data into downstream systems.
 */
export interface QueryEngineEvents {
  /** A chunk of assistant text was generated. */
  text: (content: string) => void
  /** The model requested a tool invocation. */
  'tool:use': (toolUse: ToolUseBlock) => void
  /** A partial tool input JSON fragment was received during streaming. */
  'tool:input_delta': (data: { toolUseId: string; partialJson: string }) => void
  /** A tool finished executing. */
  'tool:result': (toolResult: ToolResultBlock) => void
  /** The model produced an extended-thinking block. */
  thinking: (content: string) => void
  /** A tool requires user approval before execution. */
  'tool:approval_needed': (info: { toolUseId: string; toolName: string; input: Record<string, unknown> }) => void
  /** An error occurred during execution. */
  error: (error: Error) => void
  /** The query cycle completed (successfully or not). */
  done: (result: QueryResult) => void
  /** Engine state transitioned. */
  state: (state: Readonly<QueryEngineState>) => void
  /** Token accounting updated after a request. */
  usage: (usage: TokenUsage) => void
}

// ============================================================
// Configuration & State Types
// ============================================================

export interface QueryEngineConfig {
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model: string
  /** System prompt prepended to every request. */
  systemPrompt: string
  /** Tool definitions available to the model. */
  tools: ToolInstance[]
  /** Permission rules governing tool execution. */
  permissionContext: PermissionContext
  /** Working directory for tool execution. */
  cwd: string
  /** Unique session identifier. */
  sessionId: string
  /**
   * Pre-configured API client. When provided, `apiKey` and `baseUrl` are
   * ignored.
   */
  apiClient?: ClaudeApiClient
  /** API key (used only when `apiClient` is not supplied). */
  apiKey?: string
  /** Base URL override (used only when `apiClient` is not supplied). */
  baseUrl?: string
  /** Maximum output tokens per model response (default: 8192). */
  maxTokens?: number
  /**
   * Maximum agentic turns before the engine stops automatically
   * (default: 50). A "turn" is one model response plus the ensuing tool
   * execution batch.
   */
  maxTurns?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /**
   * Enable extended thinking and allocate this many tokens for it.
   * Set to 0 or omit to disable.
   */
  thinkingBudgetTokens?: number
  /**
   * Hard cost ceiling (USD). The engine aborts once estimated cost exceeds
   * this value. 0 or undefined means no limit.
   */
  maxCostUsd?: number
  /**
   * Sandbox state injected into `appState` so that BashTool and other
   * tools can access the resolved sandbox configuration at invocation time.
   *
   * Shape: `{ sandboxRuntimeConfig, sandboxMode }`
   */
  sandboxState?: Record<string, unknown>
  /**
   * Lifecycle hooks loaded from project configuration.
   * When provided, PreToolUse and PostToolUse hooks are executed around
   * each tool invocation.
   */
  hooks?: HookDefinition[]
  /**
   * Whether the engine is running in an interactive mode (TTY / REPL).
   * When `false` (default), tools that return `{ behavior: 'ask' }` are
   * treated as denied because there is no user present to confirm.
   * When `true`, `ask` results are resolved via `approvalCallback`.
   *
   * TODO: In interactive mode, `ask` should emit a `tool:approval_needed`
   * event and pause execution until the REPL layer collects user confirmation.
   * This wiring is a separate concern and not yet implemented.
   */
  isInteractive?: boolean
  /**
   * Callback to request user approval for tools that return 'ask'.
   * Should return true if approved, false if denied.
   * Required when `isInteractive` is true for proper approval flow.
   */
  approvalCallback?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
}

export interface QueryEngineState {
  /** Current engine status. */
  status: 'idle' | 'running' | 'aborting' | 'error'
  /** Full conversation transcript. */
  messages: Message[]
  /** Cumulative token usage for this engine instance. */
  totalTokens: TokenUsage
  /** Estimated cumulative cost in USD. */
  estimatedCostUsd: number
  /** Number of completed agentic turns in the current run. */
  turnsCompleted: number
  /** Model identifier in use. */
  model: string
  /** Session identifier. */
  sessionId: string
}

export interface QueryResult {
  /** The model's final textual response (concatenated text blocks). */
  text: string
  /** All content blocks from the final assistant message. */
  content: ContentBlock[]
  /** Why the model stopped generating. */
  stopReason: string
  /** Number of agentic turns consumed. */
  turnsUsed: number
  /** Token usage for this query. */
  tokenUsage: TokenUsage
  /** Estimated cost for this query (USD). */
  costUsd: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Set when the query ended due to an error. */
  error?: Error
}

// ============================================================
// Pricing Constants (approximate, for estimation only)
// ============================================================

const PRICING_PER_INPUT_TOKEN: Record<string, number> = {
  'claude-sonnet-4-20250514': 3 / 1_000_000,
  'claude-opus-4-20250514': 15 / 1_000_000,
  'claude-3-5-sonnet-20241022': 3 / 1_000_000,
  'claude-3-5-haiku-20241022': 1 / 1_000_000,
}

const PRICING_PER_OUTPUT_TOKEN: Record<string, number> = {
  'claude-sonnet-4-20250514': 15 / 1_000_000,
  'claude-opus-4-20250514': 75 / 1_000_000,
  'claude-3-5-sonnet-20241022': 15 / 1_000_000,
  'claude-3-5-haiku-20241022': 5 / 1_000_000,
}

const DEFAULT_INPUT_PRICE = 3 / 1_000_000
const DEFAULT_OUTPUT_PRICE = 15 / 1_000_000

const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MAX_TURNS = 50

// ============================================================
// QueryEngine
// ============================================================

export class QueryEngine {
  // ----------------------------------------------------------
  // Instance State
  // ----------------------------------------------------------

  private readonly config: Required<
    Pick<QueryEngineConfig, 'model' | 'maxTokens' | 'maxTurns'>
  > &
    QueryEngineConfig
  private readonly apiClient: ClaudeApiClient
  private readonly emitter: EventEmitter

  private abortController: AbortController
  private state: QueryEngineState
  private currentRunStart: number = 0

  // ----------------------------------------------------------
  // Constructor
  // ----------------------------------------------------------

  constructor(config: QueryEngineConfig) {
    this.config = {
      ...config,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    }

    this.apiClient =
      config.apiClient ??
      createApiClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.model,
      })

    this.emitter = new EventEmitter()
    // Allow many listeners (e.g. UI + logger + analytics)
    this.emitter.setMaxListeners(100)

    this.abortController = new AbortController()

    this.state = this.createInitialState()
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /**
   * Execute a full query cycle from a single user prompt.
   *
   * The engine enters the agentic loop: the model responds, tool calls are
   * executed, results are fed back, and the cycle repeats until the model
   * stops requesting tools or a limit is hit.
   */
  async run(prompt: string): Promise<QueryResult> {
    if (this.state.status === 'running') {
      throw new Error(
        'A query is already in progress. Call abort() first to cancel it.',
      )
    }

    this.resetForNewRun()
    this.emit('state', { ...this.state })

    // Append the user message
    const userMessage = this.createMessage('user', prompt)
    this.state.messages.push(userMessage)

    return this.executeAgenticLoop()
  }

  /**
   * Continue a conversation with an existing message history.
   *
   * Useful for SDK / headless callers that manage their own transcript and
   * want the engine to pick up from where a previous run left off.
   */
  async runMultiTurn(messages: Message[]): Promise<QueryResult> {
    if (this.state.status === 'running') {
      throw new Error(
        'A query is already in progress. Call abort() first to cancel it.',
      )
    }

    this.resetForNewRun()

    // Merge incoming messages into the transcript, avoiding duplicates
    const existingIds = new Set(this.state.messages.map(m => m.id))
    for (const msg of messages) {
      if (!existingIds.has(msg.id)) {
        this.state.messages.push(msg)
      }
    }

    this.emit('state', { ...this.state })
    return this.executeAgenticLoop()
  }

  /**
   * Cancel the currently running query.
   *
   * The abort is cooperative: in-flight HTTP requests are cancelled and the
   * agentic loop exits at the next check-point.
   */
  abort(): void {
    if (this.state.status === 'running') {
      this.state.status = 'aborting'
      this.emit('state', { ...this.state })
      this.abortController.abort()
    }
  }

  /** Return a read-only snapshot of the current engine state. */
  getState(): Readonly<QueryEngineState> {
    return { ...this.state }
  }

  /** Access cumulative token usage. */
  getUsage(): Readonly<TokenUsage> {
    return this.apiClient.getUsage()
  }

  /** Reset the engine to its initial state, clearing the transcript. */
  reset(): void {
    this.abort()
    this.state = this.createInitialState()
    this.apiClient.resetUsage()
    this.abortController = new AbortController()
    this.emit('state', { ...this.state })
  }

  /**
   * Load a pre-existing message history into the engine without triggering
   * an API call.
   *
   * Used by the `/resume` command to restore a prior session's context so
   * the next `run()` call continues from where the old session left off.
   *
   * @param messages — ordered conversation history (oldest first).
   */
  loadHistory(messages: Message[]): void {
    this.state.messages = [...messages]
    this.emit('state', { ...this.state })
  }

  /**
   * Run an isolated sub-agent query using a fresh engine instance.
   *
   * Creates a child QueryEngine that shares the same API client but has
   * its own conversation, tool subset, system prompt, and event emitter.
   * The child's events are NOT forwarded to the parent — the caller
   * observes progress via the returned QueryResult.
   *
   * This avoids the impedance mismatch between the low-level `query()`
   * function (which expects raw Anthropic streaming events via
   * `ClaudeApiDeps`) and the high-level `ClaudeApiClient.stream()` that
   * the engine already wraps.
   */
  async runIsolated(options: {
    prompt: string
    systemPrompt: string
    toolNames?: string[]
    model?: string
    maxTokens?: number
    maxTurns?: number
    parentAbortSignal?: AbortSignal
  }): Promise<QueryResult> {
    // Filter tools to the allowed subset
    let childTools = this.config.tools
    if (options.toolNames && options.toolNames.length > 0) {
      const allowSet = new Set(options.toolNames)
      childTools = this.config.tools.filter(t => allowSet.has(t.name))
    }

    // Create a child config with overrides
    const childConfig: QueryEngineConfig = {
      ...this.config,
      systemPrompt: options.systemPrompt,
      tools: childTools,
      model: options.model ?? this.config.model,
      maxTokens: options.maxTokens ?? this.config.maxTokens,
      maxTurns: options.maxTurns ?? 20,
      // Share the same API client so usage is tracked globally
      apiClient: this.apiClient,
    }

    const childEngine = new QueryEngine(childConfig)

    // Link parent abort to child
    if (options.parentAbortSignal) {
      options.parentAbortSignal.addEventListener(
        'abort',
        () => childEngine.abort(),
        { once: true },
      )
    }

    return childEngine.run(options.prompt)
  }

  // ----------------------------------------------------------
  // Event Subscription
  // ----------------------------------------------------------

  on<E extends keyof QueryEngineEvents>(
    event: E,
    listener: QueryEngineEvents[E],
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  once<E extends keyof QueryEngineEvents>(
    event: E,
    listener: QueryEngineEvents[E],
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void)
    return this
  }

  off<E extends keyof QueryEngineEvents>(
    event: E,
    listener: QueryEngineEvents[E],
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
    return this
  }

  removeAllListeners(event?: keyof QueryEngineEvents): this {
    this.emitter.removeAllListeners(event)
    return this
  }

  // ==========================================================
  // Private: Agentic Loop
  // ==========================================================

  /**
   * Core execution loop. Streams model responses, dispatches tool calls,
   * and iterates until completion or a guard-rail triggers.
   */
  private async executeAgenticLoop(): Promise<QueryResult> {
    this.state.status = 'running'
    this.currentRunStart = Date.now()
    this.emit('state', { ...this.state })

    const runTokenSnapshot: TokenUsage = { ...this.apiClient.getUsage() }
    let finalText = ''
    let finalContent: ContentBlock[] = []
    let stopReason = ''
    let runError: Error | undefined

    try {
      while (this.state.turnsCompleted < this.config.maxTurns) {
        // Check abort
        if (this.abortController.signal.aborted) {
          stopReason = 'aborted'
          break
        }

        // Stream one model response
        const assistantBlocks = await this.collectModelResponse()

        // Extract text and tool_use blocks
        const textParts: string[] = []
        const toolUseBlocks: ToolUseBlock[] = []

        for (const block of assistantBlocks) {
          if (block.type === 'text') {
            textParts.push((block as { text: string }).text)
          } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block as ToolUseBlock)
          }
        }

        // Record the assistant turn in the transcript
        const assistantMessage = this.createMessage('assistant', assistantBlocks)
        this.state.messages.push(assistantMessage)

        // If no tool calls, the model is done
        if (toolUseBlocks.length === 0) {
          finalText = textParts.join('')
          finalContent = assistantBlocks
          stopReason = stopReason || 'end_turn'
          break
        }

        // Execute tool calls and record results
        const toolResultBlocks = await this.executeToolBatch(
          toolUseBlocks,
          assistantMessage,
        )

        const resultsMessage = this.createMessage('user', toolResultBlocks)
        this.state.messages.push(resultsMessage)

        this.state.turnsCompleted += 1
        this.syncUsage()
        this.emit('state', { ...this.state })

        // Cost guard
        if (
          this.config.maxCostUsd &&
          this.config.maxCostUsd > 0 &&
          this.state.estimatedCostUsd >= this.config.maxCostUsd
        ) {
          stopReason = 'max_cost_reached'
          finalText =
            textParts.join('') ||
            '[Execution stopped: estimated cost exceeded the configured limit.]'
          finalContent = assistantBlocks
          break
        }
      }

      // Turn limit guard
      if (
        this.state.turnsCompleted >= this.config.maxTurns &&
        stopReason === ''
      ) {
        stopReason = 'max_turns_reached'
        finalText =
          finalText ||
          `[Execution stopped: maximum agentic turns (${this.config.maxTurns}) reached.]`
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err))
      stopReason = 'error'
      this.state.status = 'error'
      this.emit('error', runError)
    }

    // Finalise
    if (this.state.status === 'running') {
      this.state.status = 'idle'
    }

    const runUsage: TokenUsage = {
      inputTokens: this.apiClient.getUsage().inputTokens - runTokenSnapshot.inputTokens,
      outputTokens:
        this.apiClient.getUsage().outputTokens - runTokenSnapshot.outputTokens,
      cacheCreationTokens:
        this.apiClient.getUsage().cacheCreationTokens -
        runTokenSnapshot.cacheCreationTokens,
      cacheReadTokens:
        this.apiClient.getUsage().cacheReadTokens -
        runTokenSnapshot.cacheReadTokens,
      requestCount:
        this.apiClient.getUsage().requestCount - runTokenSnapshot.requestCount,
    }

    const result: QueryResult = {
      text: finalText,
      content: finalContent,
      stopReason,
      turnsUsed: this.state.turnsCompleted,
      tokenUsage: runUsage,
      costUsd: this.state.estimatedCostUsd,
      durationMs: Date.now() - this.currentRunStart,
      error: runError,
    }

    this.emit('done', result)
    this.emit('state', { ...this.state })

    return result
  }

  // ----------------------------------------------------------
  // Private: Model Interaction
  // ----------------------------------------------------------

  /**
   * Stream a single model response and collect all content blocks.
   *
   * Returns the ordered list of content blocks the model produced.
   *
   * Tool input arrives as a stream of `tool_input_delta` events that must
   * be accumulated per content-block index and parsed into a JSON object
   * once the response is complete.  This method maintains per-index
   * accumulators to handle responses with multiple tool calls.
   */
  private async collectModelResponse(): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = []

    /**
     * Per-index tracking for tool_use blocks.
     *
     * The Anthropic streaming API assigns each content block a sequential
     * index (0, 1, 2, ...).  When a `content_block_start` fires for a
     * tool_use block we register a tracker keyed by that index.  Subsequent
     * `input_json_delta` events carry the same index so we can accumulate
     * the partial JSON correctly even when multiple tool calls are
     * interleaved with text blocks.
     */
    interface ToolTracker {
      id: string
      name: string
      rawInput: string
    }
    const toolTrackers = new Map<number, ToolTracker>()
    /** Monotonically increasing counter for the next block index. */
    let nextBlockIndex = 0

    const streamOptions: StreamOptions = {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      abortSignal: this.abortController.signal,
      thinkingBudgetTokens: this.config.thinkingBudgetTokens,
    }

    for await (const event of this.apiClient.stream(
      this.state.messages,
      this.config.systemPrompt,
      this.config.tools,
      streamOptions,
    )) {
      switch (event.type) {
        case 'text':
          this.emit('text', event.content)
          // Coalesce consecutive text deltas into a single block.
          if (
            blocks.length > 0 &&
            blocks[blocks.length - 1]!.type === 'text'
          ) {
            const last = blocks[blocks.length - 1] as { type: 'text'; text: string }
            last.text += event.content
          } else {
            blocks.push({ type: 'text', text: event.content })
            nextBlockIndex++
          }
          break

        case 'tool_use': {
          // content_block_start for a tool_use block — register a tracker
          // keyed by the block index that the API will use in subsequent
          // input_json_delta events.
          const blockIdx = nextBlockIndex++
          toolTrackers.set(blockIdx, {
            id: event.toolUse.id,
            name: event.toolUse.name,
            rawInput: '',
          })
          this.emit('tool:use', event.toolUse)
          break
        }

        case 'tool_input_delta': {
          const tracker = toolTrackers.get(event.index)
          if (tracker) {
            tracker.rawInput += event.partialJson
            this.emit('tool:input_delta', {
              toolUseId: tracker.id,
              partialJson: event.partialJson,
            })
          }
          break
        }

        case 'thinking':
          this.emit('thinking', event.content)
          if (
            blocks.length > 0 &&
            blocks[blocks.length - 1]!.type === 'thinking'
          ) {
            const last = blocks[blocks.length - 1] as {
              type: 'thinking'
              thinking: string
            }
            last.thinking += event.content
          } else {
            blocks.push({ type: 'thinking', thinking: event.content })
            nextBlockIndex++
          }
          break

        case 'done':
          // No additional action needed; finalisation happens below.
          break

        case 'error':
          throw event.error
      }
    }

    // Post-stream: finalise all tracked tool_use blocks by parsing the
    // accumulated JSON input and appending the blocks in index order.
    const sortedIndices = [...toolTrackers.keys()].sort((a, b) => a - b)
    for (const idx of sortedIndices) {
      const tracker = toolTrackers.get(idx)!
      let input: Record<string, unknown> = {}
      try {
        input = tracker.rawInput.length > 0 ? JSON.parse(tracker.rawInput) : {}
      } catch {
        // Malformed JSON — pass the raw string so the tool can decide
        // how to handle it.
        input = { _raw: tracker.rawInput }
      }

      blocks.push({
        type: 'tool_use',
        id: tracker.id,
        name: tracker.name,
        input,
      } as ToolUseBlock)
    }

    return blocks
  }

  // ----------------------------------------------------------
  // Private: Tool Execution
  // ----------------------------------------------------------

  /**
   * Execute a batch of tool calls.
   *
   * Processes the batch in order, grouping CONSECUTIVE concurrency-safe tools
   * into parallel batches while preserving the original order relative to
   * non-safe tools.  This avoids reordering side effects: e.g.
   * [read, write, read] stays in that order rather than becoming
   * [read, read] concurrent then [write] sequential.
   */
  private async executeToolBatch(
    toolUseBlocks: ToolUseBlock[],
    parentMessage: Message,
  ): Promise<ToolResultBlock[]> {
    const permissions = await this.checkToolPermissions(toolUseBlocks)
    const results: ToolResultBlock[] = []

    // Group consecutive concurrency-safe tools into parallel batches,
    // while preserving the original order relative to non-safe tools.
    let i = 0
    while (i < toolUseBlocks.length) {
      const block = toolUseBlocks[i]!
      const perm = permissions.get(block.id)

      // Handle denied tools (add deny result).
      if (perm?.behavior === 'deny') {
        results.push(this.errorResult(block.id, perm.message ?? `Permission denied for "${block.name}"`))
        i++
        continue
      }

      // In non-interactive mode, 'ask' cannot be resolved — treat as deny.
      if (perm?.behavior === 'ask' && !this.config.isInteractive) {
        results.push(this.errorResult(
          block.id,
          `Tool requires user confirmation but running in non-interactive mode`,
        ))
        i++
        continue
      }

      // In interactive mode, 'ask' requires user approval via callback.
      if (perm?.behavior === 'ask' && this.config.isInteractive) {
        this.emit('tool:approval_needed', { toolUseId: block.id, toolName: block.name, input: block.input })
        if (this.config.approvalCallback) {
          const approved = await this.config.approvalCallback(block.name, block.input)
          if (!approved) {
            results.push(this.errorResult(block.id, `User denied tool "${block.name}"`))
            i++
            continue
          }
        } else {
          // No callback registered — deny to maintain fail-closed security
          results.push(this.errorResult(block.id, `Tool "${block.name}" requires user confirmation but no approval callback is configured`))
          i++
          continue
        }
      }

      const tool = this.findTool(block.name)
      if (!tool) {
        results.push(this.errorResult(block.id, `Unknown tool: "${block.name}"`))
        i++
        continue
      }

      // Collect consecutive concurrency-safe tools.
      if (tool.isConcurrencySafe(block.input) && toolUseBlocks.length > 1) {
        const batch: Array<{ block: ToolUseBlock; tool: ToolInstance }> = [{ block, tool }]
        let j = i + 1
        while (j < toolUseBlocks.length) {
          const nextBlock = toolUseBlocks[j]!
          const nextPerm = permissions.get(nextBlock.id)
          // Stop at denied tools — they need inline error results.
          if (nextPerm?.behavior === 'deny') break
          // Stop at ask-in-non-interactive — same treatment as deny.
          if (nextPerm?.behavior === 'ask' && !this.config.isInteractive) break
          // Stop at ask-in-interactive — requires sequential user approval.
          if (nextPerm?.behavior === 'ask' && this.config.isInteractive) break
          const nextTool = this.findTool(nextBlock.name)
          if (!nextTool || !nextTool.isConcurrencySafe(nextBlock.input)) break
          batch.push({ block: nextBlock, tool: nextTool })
          j++
        }

        // Execute the consecutive safe batch in parallel.
        if (batch.length > 1) {
          const settled = await Promise.allSettled(
            batch.map(({ block: b, tool: t }) => this.executeSingleTool(b, t, parentMessage))
          )
          for (const [k, outcome] of settled.entries()) {
            results.push(this.settleToResult(outcome, batch[k]!.block))
          }
          i = j
          continue
        }
      }

      // Single tool execution (non-safe or alone).
      try {
        const result = await this.executeSingleTool(block, tool, parentMessage)
        results.push(result)
      } catch (err) {
        results.push(this.errorResult(block.id, err instanceof Error ? err.message : String(err)))
      }
      i++
    }

    return results
  }

  /**
   * Run permission checks for every tool call in the batch.
   *
   * Precedence:
   *   1. Deny-list ALWAYS wins (checked first).
   *   2. The tool's own `checkPermissions` is ALWAYS invoked.
   *   3. If the tool says "deny", we respect it regardless of allowList.
   *   4. If the tool says "ask" and the tool is on the allowList, we
   *      upgrade to "allow" (allowList can skip "asking" but cannot
   *      override "denying").
   *   5. Otherwise the tool's own verdict is used as-is.
   */
  private async checkToolPermissions(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<Map<string, PermissionResult>> {
    const results = new Map<string, PermissionResult>()

    for (const block of toolUseBlocks) {
      const tool = this.findTool(block.name)

      if (!tool) {
        results.set(block.id, {
          behavior: 'deny',
          message: `Unknown tool: "${block.name}"`,
        })
        continue
      }

      // 1. Deny-list ALWAYS wins — checked first
      if (this.config.permissionContext.denyList.includes(tool.name)) {
        results.set(block.id, {
          behavior: 'deny',
          message: `Tool "${tool.name}" is on the deny list`,
        })
        continue
      }

      // 2. ALWAYS run the tool's own checkPermissions
      let toolPerm: PermissionResult
      try {
        toolPerm = await tool.checkPermissions(
          block.input,
          this.config.permissionContext,
        )
      } catch (err) {
        results.set(block.id, {
          behavior: 'deny',
          message: `Permission check failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }

      // 3. Tool says deny → respect it, regardless of allowList
      if (toolPerm.behavior === 'deny') {
        results.set(block.id, toolPerm)
        continue
      }

      // 4. Tool says ask + allowList includes tool → upgrade to allow
      //    (allowList can skip "asking" but CANNOT override "denying")
      if (toolPerm.behavior === 'ask' && this.config.permissionContext.allowList.includes(tool.name)) {
        results.set(block.id, { behavior: 'allow' })
        continue
      }

      // 5. Use tool's verdict as-is
      results.set(block.id, toolPerm)
    }

    return results
  }

  /**
   * Execute a single tool call by delegating to the shared `executeToolCall`
   * function in `utils/toolExecutor.ts`.
   *
   * The QueryEngine wraps the shared executor with:
   *   - `tool:use` event emission before execution
   *   - `tool:result` event emission after execution
   *   - A progress callback that triggers state-update events
   *   - The QueryEngine's own tool context (with sub-agent factory, etc.)
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolInstance,
    parentMessage: Message,
  ): Promise<ToolResultBlock> {
    this.emit('tool:use', block)

    const context = this.buildToolContext()

    // Build a permission checker that applies deny/allow-list rules
    // before delegating to the tool's own checkPermissions.
    const canUseTool = buildPermissionChecker(this.config.permissionContext)

    const hooks = this.config.hooks ?? []

    const resultBlock = await executeToolCall(
      block,
      tool,
      context,
      parentMessage,
      canUseTool,
      hooks,
      {
        checkEnabled: true,
        onProgress: (_progress) => {
          this.emit('state', { ...this.state })
        },
      },
    )

    this.emit('tool:result', resultBlock)
    return resultBlock
  }

  // ----------------------------------------------------------
  // Private: Context Construction
  // ----------------------------------------------------------

  /**
   * Build the ToolUseContext that tools receive at invocation time.
   *
   * The `appState.subAgentRunner` factory allows the AgentTool to spawn
   * isolated sub-agent queries without needing direct access to the
   * low-level ClaudeApiDeps interface.
   */
  private buildToolContext(): ToolUseContext {
    return {
      tools: this.config.tools,
      permissionContext: this.config.permissionContext,
      cwd: this.config.cwd,
      sessionId: this.config.sessionId,
      abortController: this.abortController,
      mcpClients: new Map(),
      appState: {
        // Expose a sub-agent runner factory so AgentTool.runAgent can
        // create isolated child engines without touching ClaudeApiDeps.
        subAgentRunner: (options: {
          prompt: string
          systemPrompt: string
          toolNames?: string[]
          model?: string
          maxTokens?: number
          maxTurns?: number
        }) => this.runIsolated({
          ...options,
          parentAbortSignal: this.abortController.signal,
        }),
        // Spread sandbox state (sandboxRuntimeConfig, sandboxMode, sandbox)
        // so that BashTool can access it via context.appState.
        ...(this.config.sandboxState ?? {}),
        // Expose hooks so sub-agents can also run PreToolUse/PostToolUse hooks.
        hooks: this.config.hooks,
      },
      messages: [...this.state.messages],
      renderedSystemPrompt: this.config.systemPrompt,
    }
  }

  // ----------------------------------------------------------
  // Private: State & Accounting
  // ----------------------------------------------------------

  private createInitialState(): QueryEngineState {
    return {
      status: 'idle',
      messages: [],
      totalTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      },
      estimatedCostUsd: 0,
      turnsCompleted: 0,
      model: this.config.model,
      sessionId: this.config.sessionId,
    }
  }

  private resetForNewRun(): void {
    this.abortController = new AbortController()
    this.state.status = 'running'
    this.state.turnsCompleted = 0
    this.state.estimatedCostUsd = 0
  }

  /** Pull latest usage from the API client and update cost estimate. */
  private syncUsage(): void {
    const usage = this.apiClient.getUsage()
    this.state.totalTokens = { ...usage }
    this.state.estimatedCostUsd = this.calculateCost(usage)
    this.emit('usage', { ...usage })
  }

  /**
   * Estimate cost in USD based on token usage and the current model.
   */
  private calculateCost(usage: TokenUsage): number {
    const inputPrice =
      PRICING_PER_INPUT_TOKEN[this.config.model] ?? DEFAULT_INPUT_PRICE
    const outputPrice =
      PRICING_PER_OUTPUT_TOKEN[this.config.model] ?? DEFAULT_OUTPUT_PRICE

    return usage.inputTokens * inputPrice + usage.outputTokens * outputPrice
  }

  // ----------------------------------------------------------
  // Private: Message Helpers
  // ----------------------------------------------------------

  private createMessage(
    role: 'user' | 'assistant',
    content: string | ContentBlock[],
    parentUuid?: string,
  ): Message {
    return {
      id: randomUUID(),
      uuid: randomUUID(),
      role,
      content,
      timestamp: Date.now(),
      parentUuid,
      model: role === 'assistant' ? this.config.model : undefined,
    }
  }

  private findTool(name: string): ToolInstance | undefined {
    return this.config.tools.find(t => t.name === name && t.isEnabled())
  }

  // ----------------------------------------------------------
  // Private: Result Helpers
  // ----------------------------------------------------------

  private settleToResult(
    outcome: PromiseSettledResult<ToolResultBlock>,
    block: ToolUseBlock,
  ): ToolResultBlock {
    if (outcome.status === 'fulfilled') return outcome.value
    return this.errorResult(
      block.id,
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason),
    )
  }

  private errorResult(toolUseId: string, message: string): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: message,
      is_error: true,
    }
  }

  // ----------------------------------------------------------
  // Private: Event Dispatch
  // ----------------------------------------------------------

  private emit<E extends keyof QueryEngineEvents>(
    event: E,
    ...args: Parameters<QueryEngineEvents[E]>
  ): void {
    this.emitter.emit(event, ...args)
  }
}
