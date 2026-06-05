/**
 * Core agent execution loop — the heart of the coding agent.
 *
 * Implements the closed-loop tool-calling cycle:
 *   1. Assemble context & normalize messages for the API
 *   2. Call the Claude model (streaming)
 *   3. Extract tool_use blocks from the response
 *   4. Execute tools (concurrent-safe batching)
 *   5. Append tool_result messages → next iteration
 *   6. Break when the model produces no further tool calls
 *
 * Mirrors the architecture of Claude Code's `query.ts`.
 */

import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  StreamEvent,
  QueryOptions,
  ToolInstance,
  ToolUseContext,
  CanUseTool,
} from './types/index.js'

import {
  estimateMessageTokens,
  shouldAutoCompact,
  getEffectiveContextWindowSize,
  AUTOCOMPACT_BUFFER_TOKENS,
} from './utils/context.js'

import { executeToolCall } from './utils/toolExecutor.js'

// ============================================================
// ID Generation
// ============================================================

/** Counter used as a fallback entropy source when crypto is unavailable. */
let idCounter = 0

/**
 * Generate a unique identifier suitable for messages, tool calls, etc.
 *
 * Prefers `crypto.randomUUID()` when available; otherwise falls back to a
 * timestamp + monotonic counter combination that is guaranteed unique within
 * the current process.
 */
export function generateId(): string {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }
  idCounter += 1
  return `id-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ============================================================
// Message Normalization
// ============================================================

/**
 * Strip content that the Claude API cannot accept and return a sanitized
 * copy of the messages array.
 *
 * Specifically this removes:
 *   - `image` blocks (large binary payloads handled out-of-band)
 *   - Locally-mounted attachment metadata
 *   - Verbose internal fields (`isMeta`, `parentUuid`, etc.)
 *
 * It also validates that every `tool_result` block references a preceding
 * `tool_use` block and that the message roles alternate correctly.
 *
 * @param messages - Raw conversation messages (will NOT be mutated).
 * @returns A new array of messages safe to send to the API.
 */
export function normalizeMessagesForAPI(messages: Message[]): Message[] {
  /** Track tool_use ids we have seen so we can pair tool_results. */
  const seenToolUseIds = new Set<string>()
  const normalized: Message[] = []

  for (const msg of messages) {
    // Skip meta-only messages (progress indicators, internal markers, etc.)
    if (msg.isMeta) continue

    if (typeof msg.content === 'string') {
      // Plain-text messages pass through with only public fields.
      normalized.push(stripMessageMetadata(msg))
      continue
    }

    // Array content — filter and validate individual blocks.
    const cleanedBlocks: ContentBlock[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'image':
          // Images are stripped from the API payload in this simplified
          // implementation. A production system would forward them as
          // base64 media blocks when the model supports vision.
          break

        case 'tool_use':
          seenToolUseIds.add(block.id)
          cleanedBlocks.push(block)
          break

        case 'tool_result': {
          // Validate pairing: every tool_result must reference a known tool_use.
          if (!seenToolUseIds.has(block.tool_use_id)) {
            // Orphaned tool_result — drop it silently rather than crashing the
            // API call. This can happen after context compaction.
            break
          }
          cleanedBlocks.push(sanitizeToolResultBlock(block))
          break
        }

        case 'text':
          cleanedBlocks.push(block)
          break

        case 'thinking':
          // Thinking blocks are forwarded so the model can see its prior
          // chain-of-thought when extended thinking is enabled.
          cleanedBlocks.push(block)
          break

        default:
          // Unknown block type — drop defensively.
          break
      }
    }

    // Drop messages that ended up with zero content blocks.
    if (cleanedBlocks.length === 0) continue

    normalized.push({
      ...stripMessageMetadata(msg),
      content: cleanedBlocks,
    })
  }

  return ensureRoleAlternation(normalized)
}

/**
 * Return a shallow copy of a message with internal-only fields removed.
 */
function stripMessageMetadata(msg: Message): Message {
  const {
    parentUuid: _parentUuid,
    isMeta: _isMeta,
    ...rest
  } = msg
  return rest
}

/**
 * Sanitize a `tool_result` block: ensure its content is either a plain string
 * or an array of API-compatible content blocks (no images).
 */
function sanitizeToolResultBlock(block: ToolResultBlock): ToolResultBlock {
  if (typeof block.content === 'string') return block

  const cleaned = (block.content as ContentBlock[]).filter(
    (b) => b.type !== 'image',
  )
  return { ...block, content: cleaned }
}

/**
 * Ensure the message array alternates between `user` and `assistant` roles,
 * merging consecutive same-role messages where necessary.
 *
 * The Claude API requires strict role alternation. When the internal message
 * list contains consecutive user messages (e.g. a follow-up user message
 * immediately after a tool_result), they must be merged.
 */
function ensureRoleAlternation(messages: Message[]): Message[] {
  if (messages.length === 0) return messages

  const merged: Message[] = [messages[0]]

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = messages[i]

    if (prev.role === curr.role && prev.role !== 'system') {
      // Merge consecutive same-role messages.
      merged[merged.length - 1] = mergeMessages(prev, curr)
    } else {
      merged.push(curr)
    }
  }

  // The first non-system message must be from the user.
  // If the first message is an assistant message, prepend an empty user message.
  const firstNonSystem = merged.findIndex((m) => m.role !== 'system')
  if (firstNonSystem !== -1 && merged[firstNonSystem].role === 'assistant') {
    merged.splice(firstNonSystem, 0, {
      id: generateId(),
      uuid: generateId(),
      role: 'user',
      content: '.',
      timestamp: merged[firstNonSystem].timestamp - 1,
    })
  }

  return merged
}

/**
 * Merge two consecutive messages from the same role into one.
 */
function mergeMessages(a: Message, b: Message): Message {
  const aBlocks = typeof a.content === 'string'
    ? [{ type: 'text' as const, text: a.content }]
    : a.content
  const bBlocks = typeof b.content === 'string'
    ? [{ type: 'text' as const, text: b.content }]
    : b.content

  return {
    ...a,
    content: [...aBlocks, ...bBlocks],
    timestamp: Math.max(a.timestamp, b.timestamp),
  }
}

// ============================================================
// Tool Call Partitioning
// ============================================================

/** A batch of tool calls to execute together. */
export interface ToolCallBatch {
  /** The tool_use blocks in this batch. */
  toolUses: ToolUseBlock[]
  /** Whether the tools in this batch can run concurrently. */
  concurrent: boolean
}

/**
 * Partition a list of tool_use blocks into execution batches.
 *
 * Concurrency-safe tools are grouped into a single concurrent batch.
 * Tools that are NOT concurrency-safe each get their own sequential batch
 * to ensure they execute in isolation.
 *
 * The ordering of tool calls is preserved: if a non-safe tool appears
 * between two safe tools the result will be:
 *   [safe batch] -> [unsafe singleton] -> [safe batch]
 *
 * @param toolUses - Tool use blocks extracted from the model response.
 * @param tools    - Available tool instances (used to look up `isConcurrencySafe`).
 * @returns Ordered array of batches.
 */
export function partitionToolCalls(
  toolUses: ToolUseBlock[],
  tools: ToolInstance[],
): ToolCallBatch[] {
  if (toolUses.length === 0) return []

  const toolMap = new Map<string, ToolInstance>()
  for (const t of tools) {
    toolMap.set(t.name, t)
  }

  const batches: ToolCallBatch[] = []
  let currentConcurrentBatch: ToolUseBlock[] = []

  /** Flush the accumulated concurrent batch (if any). */
  const flushConcurrent = () => {
    if (currentConcurrentBatch.length > 0) {
      batches.push({ toolUses: currentConcurrentBatch, concurrent: true })
      currentConcurrentBatch = []
    }
  }

  for (const tu of toolUses) {
    const tool = toolMap.get(tu.name)
    const isSafe = tool ? tool.isConcurrencySafe(tu.input) : false

    if (isSafe) {
      currentConcurrentBatch.push(tu)
    } else {
      // Flush any pending concurrent batch first.
      flushConcurrent()
      // Non-safe tools always execute alone in a sequential batch.
      batches.push({ toolUses: [tu], concurrent: false })
    }
  }

  // Flush trailing concurrent batch.
  flushConcurrent()

  return batches
}

// ============================================================
// Individual Tool Execution Pipeline
// ============================================================

/** The result of executing a single tool, paired with its originating call. */
interface ToolExecutionResult {
  toolUseId: string
  toolResult: ToolResultBlock
}

/**
 * Execute a single tool_use block by delegating to the shared
 * `executeToolCall` function in `utils/toolExecutor.ts`.
 *
 * This thin wrapper adapts the shared executor's `ToolResultBlock` return
 * value into the `ToolExecutionResult` shape used by the `runTools` batch
 * runner in this module.
 *
 * @param toolUse       - The tool_use block from the model.
 * @param tool          - The matching ToolInstance.
 * @param context       - Shared context passed to every tool.
 * @param parentMessage - The assistant message that contained this tool_use.
 * @param canUseTool    - Callback to perform interactive permission prompts.
 * @returns The tool_result block to feed back to the model.
 */
async function runToolUse(
  toolUse: ToolUseBlock,
  tool: ToolInstance,
  context: ToolUseContext,
  parentMessage: Message,
  canUseTool: CanUseTool,
): Promise<ToolExecutionResult> {
  const toolResult = await executeToolCall(
    toolUse,
    tool,
    context,
    parentMessage,
    canUseTool,
    // query.ts does not use lifecycle hooks; QueryEngine handles those.
    [],
  )

  return {
    toolUseId: toolUse.id,
    toolResult,
  }
}

// ============================================================
// Result Helpers (local to batch runner)
// ============================================================

/**
 * Build a standardized error ToolExecutionResult for the batch runner.
 */
function makeErrorResult(toolUseId: string, message: string): ToolExecutionResult {
  return {
    toolUseId,
    toolResult: {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: message,
      is_error: true,
    },
  }
}

// ============================================================
// Batch Tool Runner
// ============================================================

/**
 * Execute partitioned tool-call batches, yielding `tool_result` stream events.
 *
 * - **Concurrent batches**: all tools run in parallel via `Promise.all`.
 * - **Sequential batches**: tools execute one at a time, in order.
 *
 * Each completed tool yields a `{ type: 'tool_result' }` StreamEvent so the
 * UI can display results incrementally.
 *
 * @param batches       - Ordered batches from `partitionToolCalls`.
 * @param tools         - Available tool instances.
 * @param context       - Shared tool-use context.
 * @param parentMessage - The assistant message containing the tool_use blocks.
 * @param canUseTool    - Permission-check callback.
 */
async function* runTools(
  batches: ToolCallBatch[],
  tools: ToolInstance[],
  context: ToolUseContext,
  parentMessage: Message,
  canUseTool: CanUseTool,
): AsyncGenerator<StreamEvent> {
  const toolMap = new Map<string, ToolInstance>()
  for (const t of tools) {
    toolMap.set(t.name, t)
  }

  for (const batch of batches) {
    if (batch.concurrent && batch.toolUses.length > 1) {
      // ---- Concurrent execution ----
      const promises = batch.toolUses.map(async (tu) => {
        const tool = toolMap.get(tu.name)
        if (!tool) {
          return makeErrorResult(tu.id, `Unknown tool: "${tu.name}"`)
        }
        return runToolUse(tu, tool, context, parentMessage, canUseTool)
      })

      const results = await Promise.all(promises)

      for (const result of results) {
        yield { type: 'tool_result', toolResult: result.toolResult }
      }
    } else {
      // ---- Sequential execution ----
      for (const tu of batch.toolUses) {
        const tool = toolMap.get(tu.name)
        if (!tool) {
          const errResult = makeErrorResult(tu.id, `Unknown tool: "${tu.name}"`)
          yield { type: 'tool_result', toolResult: errResult.toolResult }
          continue
        }

        const result = await runToolUse(tu, tool, context, parentMessage, canUseTool)
        yield { type: 'tool_result', toolResult: result.toolResult }
      }
    }
  }
}

// ============================================================
// Claude API Abstraction
// ============================================================

/**
 * Minimal abstraction over the Claude Messages API so the query loop
 * remains transport-agnostic.
 *
 * Implementations may wrap the official `@anthropic-ai/sdk`, a proxy, or
 * a mock for testing.
 */
export interface ClaudeApiDeps {
  /**
   * Send a (streaming) request to the Claude API.
   *
   * The returned async iterable yields raw response events that the query
   * loop will interpret. At minimum the implementation must yield objects
   * with a `type` field matching the Anthropic streaming protocol:
   *
   *   - `{ type: 'content_block_start', content_block: TextBlock | ToolUseBlock | ThinkingBlock }`
   *   - `{ type: 'content_block_delta', delta: { type: 'text_delta', text: string } | { type: 'input_json_delta', partial_json: string } | { type: 'thinking_delta', thinking: string } }`
   *   - `{ type: 'content_block_stop' }`
   *   - `{ type: 'message_stop', stop_reason: string }`
   */
  createMessage(
    params: ClaudeApiParams,
  ): AsyncIterable<ClaudeStreamRawEvent>
}

/** Parameters forwarded to the Claude Messages API. */
export interface ClaudeApiParams {
  model: string
  max_tokens: number
  temperature: number
  system: string
  messages: Message[]
  tools: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  stream: true
  signal?: AbortSignal
}

/** Raw streaming events from the Claude API (simplified). */
export type ClaudeStreamRawEvent =
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'thinking'; thinking: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop'; stop_reason: string }
  | { type: 'error'; error: { message: string } }

// ============================================================
// Core Query Loop
// ============================================================

/** Maximum number of agentic turns before the loop force-exits. */
const MAX_TURNS = 200

/**
 * The core agent execution loop.
 *
 * This async generator implements the closed tool-calling cycle:
 *
 * ```
 *   while (turn < maxTurns) {
 *     response = claude(messages + tools)
 *     yield text/thinking events
 *     if (no tool_use blocks) break
 *     execute tools -> yield tool_result events
 *     append tool_results to messages
 *   }
 *   yield { type: 'done' }
 * ```
 *
 * The caller consumes events with a standard `for await (const event of query(...))`
 * loop and can render them incrementally in a TUI or web UI.
 *
 * @param options   - Conversation state, tools, and model configuration.
 * @param claudeApi - Transport-agnostic Claude API implementation.
 * @yields StreamEvent objects representing the real-time agent output.
 */
export async function* query(
  options: QueryOptions,
  claudeApi: ClaudeApiDeps,
): AsyncGenerator<StreamEvent> {
  const {
    systemPrompt,
    tools,
    model = 'claude-sonnet-4-20250514',
    maxTokens = 8000,
    temperature = 1,
    abortSignal,
    permissionContext,
    cwd,
    sessionId,
  } = options

  // Working copy of messages — we append to this across turns.
  const messages: Message[] = [...options.messages]

  // Build the tool definitions for the API (serializable schema objects).
  const apiTools = tools
    .filter((t) => t.isEnabled())
    .map((t) => ({
      name: t.name,
      description: typeof t.description === 'function' ? t.description() : t.description,
      input_schema: t.inputSchema,
    }))

  // AbortController for coordinating cancellation across the loop.
  const abortController = new AbortController()
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  // Shared context object passed to every tool invocation.
  const toolContext: ToolUseContext = {
    tools,
    permissionContext,
    cwd,
    sessionId,
    abortController,
    mcpClients: new Map(),
    appState: {},
    messages,
  }

  // Permission callback — delegates to the tool's own checkPermissions and
  // then applies the global permission context.
  const canUseTool: CanUseTool = async (tool, input) => {
    return tool.checkPermissions(input, permissionContext)
  }

  let turn = 0

  while (turn < MAX_TURNS) {
    turn++

    // ---- Context window guard ----
    const effectiveWindow = getEffectiveContextWindowSize(model)
    const currentTokens = estimateMessageTokens(messages)

    if (shouldAutoCompact(currentTokens, effectiveWindow, AUTOCOMPACT_BUFFER_TOKENS)) {
      // In a full implementation we would trigger auto-compaction here
      // (summarize older messages and replace them). For now we yield a
      // warning event and continue — the API will truncate if needed.
      yield {
        type: 'text',
        content: '\n[Warning: Context window nearing capacity. Consider compacting the conversation.]\n',
      }
    }

    // ---- Normalize messages for the API call ----
    const normalizedMessages = normalizeMessagesForAPI(messages)

    // ---- Call the Claude API ----
    let stopReason = 'end_turn'
    const assistantContentBlocks: ContentBlock[] = []
    const pendingToolInputs = new Map<number, { id: string; name: string; jsonAccum: string }>()

    try {
      const stream = claudeApi.createMessage({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: normalizedMessages,
        tools: apiTools,
        stream: true,
        signal: abortController.signal,
      })

      for await (const rawEvent of stream) {
        // Check for cancellation.
        if (abortController.signal.aborted) {
          yield { type: 'done', stopReason: 'cancelled' }
          return
        }

        switch (rawEvent.type) {
          case 'content_block_start': {
            const cb = rawEvent.content_block
            if (cb.type === 'text') {
              // Text blocks start empty; deltas will fill them.
              assistantContentBlocks.push({ type: 'text', text: '' })
            } else if (cb.type === 'tool_use') {
              assistantContentBlocks.push({
                type: 'tool_use',
                id: cb.id,
                name: cb.name,
                input: {},
              })
              // Track partial JSON accumulation for streaming tool inputs.
              pendingToolInputs.set(rawEvent.index, {
                id: cb.id,
                name: cb.name,
                jsonAccum: '',
              })
            } else if (cb.type === 'thinking') {
              assistantContentBlocks.push({ type: 'thinking', thinking: '' })
            }
            break
          }

          case 'content_block_delta': {
            const delta = rawEvent.delta
            if (delta.type === 'text_delta') {
              // Append text and yield a streaming event.
              const block = assistantContentBlocks[rawEvent.index] as TextBlock | undefined
              if (block && block.type === 'text') {
                block.text += delta.text
                yield { type: 'text', content: delta.text }
              }
            } else if (delta.type === 'thinking_delta') {
              const block = assistantContentBlocks[rawEvent.index] as ThinkingBlock | undefined
              if (block && block.type === 'thinking') {
                block.thinking += delta.thinking
                yield { type: 'thinking', content: delta.thinking }
              }
            } else if (delta.type === 'input_json_delta') {
              // Accumulate partial JSON for tool_use input.
              const pending = pendingToolInputs.get(rawEvent.index)
              if (pending) {
                pending.jsonAccum += delta.partial_json
              }
            }
            break
          }

          case 'content_block_stop': {
            // Finalize tool_use blocks by parsing accumulated JSON.
            const pending = pendingToolInputs.get(rawEvent.index)
            if (pending) {
              const block = assistantContentBlocks[rawEvent.index] as ToolUseBlock | undefined
              if (block && block.type === 'tool_use') {
                try {
                  block.input = pending.jsonAccum
                    ? JSON.parse(pending.jsonAccum)
                    : {}
                } catch {
                  // If JSON parsing fails, fall back to empty input. The
                  // schema validation stage will catch missing required fields.
                  block.input = {}
                }
              }
              pendingToolInputs.delete(rawEvent.index)
            }
            break
          }

          case 'message_stop':
            stopReason = rawEvent.stop_reason
            break

          case 'error':
            yield {
              type: 'error',
              error: new Error(rawEvent.error.message),
            }
            break
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' }
        return
      }
      yield {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      }
      // On API errors we stop the loop rather than retrying indefinitely.
      yield { type: 'done', stopReason: 'api_error' }
      return
    }

    // ---- Build the assistant message from collected blocks ----
    const assistantMessage: Message = {
      id: generateId(),
      uuid: generateId(),
      role: 'assistant',
      content: assistantContentBlocks,
      timestamp: Date.now(),
      model,
    }
    messages.push(assistantMessage)

    // ---- Emit tool_use events ----
    const toolUseBlocks = assistantContentBlocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    )

    for (const tu of toolUseBlocks) {
      yield { type: 'tool_use', toolUse: tu }
    }

    // ---- End-of-turn check: no tool calls means the model is done ----
    if (toolUseBlocks.length === 0 || stopReason === 'end_turn') {
      if (toolUseBlocks.length === 0) {
        yield { type: 'done', stopReason }
        return
      }
    }

    // ---- Partition & execute tool calls ----
    const batches = partitionToolCalls(toolUseBlocks, tools)

    const toolResultBlocks: ToolResultBlock[] = []

    for await (const event of runTools(
      batches,
      tools,
      toolContext,
      assistantMessage,
      canUseTool,
    )) {
      yield event
      if (event.type === 'tool_result') {
        toolResultBlocks.push(event.toolResult)
      }
    }

    // ---- Append a user message containing all tool_results ----
    if (toolResultBlocks.length > 0) {
      const toolResultMessage: Message = {
        id: generateId(),
        uuid: generateId(),
        role: 'user',
        content: toolResultBlocks,
        timestamp: Date.now(),
      }
      messages.push(toolResultMessage)

      // Keep the shared context in sync.
      toolContext.messages = messages
    }
  }

  // If we exhausted MAX_TURNS, stop gracefully.
  yield {
    type: 'text',
    content: `\n[Reached maximum turn limit (${MAX_TURNS}). Stopping agent loop.]\n`,
  }
  yield { type: 'done', stopReason: 'max_turns' }
}
