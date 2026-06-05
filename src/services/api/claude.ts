/**
 * Claude API communication layer
 *
 * Provides a streaming-first client for the Anthropic Messages API with
 * automatic retry handling, token tracking, and tool definition support.
 *
 * Architecture mirrors Claude Code's API service layer:
 *  - AsyncGenerator-based streaming for real-time event consumption
 *  - Exponential backoff with jitter for 429 and 5xx errors
 *  - First-class extended thinking and tool use support
 *  - Cumulative usage tracking across all requests in a session
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageCreateParams,
  MessageParam,
  RawMessageStreamEvent,
  Tool as AnthropicToolDefinition,
} from '@anthropic-ai/sdk/resources/messages'
import type {
  ContentBlock,
  Message,
  StreamEvent,
  ToolInstance,
  ToolUseBlock,
} from '../../types/index.js'

// ============================================================
// Configuration Types
// ============================================================

export interface ClaudeApiClientConfig {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string
  /** Override the default Anthropic API base URL. */
  baseUrl?: string
  /** Maximum number of retry attempts for retryable errors (default: 5). */
  maxRetries?: number
  /** Default model identifier used when not specified per-request. */
  defaultModel?: string
  /** Additional HTTP headers sent with every request. */
  headers?: Record<string, string>
}

export interface StreamOptions {
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model?: string
  /** Maximum output tokens the model may generate. */
  maxTokens?: number
  /** Sampling temperature (0-1). Lower = more deterministic. */
  temperature?: number
  /** AbortSignal for cooperative cancellation. */
  abortSignal?: AbortSignal
  /**
   * Maximum thinking tokens for extended thinking models.
   * Set to 0 or omit to disable extended thinking.
   */
  thinkingBudgetTokens?: number
  /** Stop sequences that terminate generation. */
  stopSequences?: string[]
  /** Nucleus sampling parameter. */
  topP?: number
}

export interface TokenUsage {
  /** Cumulative input tokens consumed across all requests. */
  inputTokens: number
  /** Cumulative output tokens consumed across all requests. */
  outputTokens: number
  /** Total cache creation tokens (prompt caching). */
  cacheCreationTokens: number
  /** Total cache read tokens (prompt caching). */
  cacheReadTokens: number
  /** Number of API requests made. */
  requestCount: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_MAX_TOKENS = 8192
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 60_000

/** HTTP status codes eligible for retry. */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Convert internal ToolInstance definitions to the Anthropic API tool format.
 */
function formatToolDefinitions(tools: ToolInstance[]): AnthropicToolDefinition[] {
  return tools
    .filter(t => t.isEnabled())
    .map(tool => ({
      name: tool.name,
      description:
        typeof tool.description === 'function' ? tool.description() : tool.description,
      input_schema: tool.inputSchema as AnthropicToolDefinition['input_schema'],
    }))
}

/**
 * Convert internal Message objects to the Anthropic API MessageParam format.
 *
 * System messages are excluded (the system prompt is passed separately).
 * Tool result blocks are normalised to the shape the API expects.
 */
function formatMessagesForApi(messages: Message[]): MessageParam[] {
  return messages
    .filter(m => m.role !== 'system')
    .map((message): MessageParam => {
      if (typeof message.content === 'string') {
        return { role: message.role as 'user' | 'assistant', content: message.content }
      }

      const content = (message.content as ContentBlock[]).map(block => {
        if (block.type === 'tool_result') {
          // Normalise tool_result content to string or typed blocks
          const resultContent =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(b => b.type === 'text' || b.type === 'image')
                    .map(b =>
                      b.type === 'text'
                        ? { type: 'text' as const, text: (b as { text: string }).text }
                        : b,
                    )
                : String(block.content)

          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: resultContent,
            is_error: block.is_error,
          }
        }

        if (block.type === 'thinking') {
          return {
            type: 'thinking' as const,
            thinking: block.thinking,
          }
        }

        return block
      })

      return { role: message.role as 'user' | 'assistant', content: content as any }
    })
}

/**
 * Compute a retry delay with exponential backoff and full jitter.
 *
 * If the error carries a `retryAfter` value (from a Retry-After header) it
 * takes precedence up to the configured maximum delay.
 */
function computeRetryDelay(
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS)
  }
  const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
  const jitter = Math.random() * RETRY_BASE_DELAY_MS
  return Math.min(exponentialDelay + jitter, RETRY_MAX_DELAY_MS)
}

/**
 * Extract an HTTP status code from an unknown error value.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    if (typeof e['status'] === 'number') return e['status']
    if (typeof e['statusCode'] === 'number') return e['statusCode']
    if (
      e['response'] &&
      typeof e['response'] === 'object' &&
      typeof (e['response'] as Record<string, unknown>)['status'] === 'number'
    ) {
      return (e['response'] as Record<string, unknown>)['status'] as number
    }
  }
  return undefined
}

/**
 * Attempt to extract a Retry-After value (in milliseconds) from an error.
 */
function extractRetryAfter(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const headers = (error as Record<string, unknown>)['headers'] as
      | Record<string, string>
      | undefined
    const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!Number.isNaN(seconds)) return seconds * 1000
    }
  }
  return undefined
}

// ============================================================
// ClaudeApiClient
// ============================================================

export class ClaudeApiClient {
  private readonly client: Anthropic
  private readonly maxRetries: number
  private readonly defaultModel: string
  private readonly usage: TokenUsage

  /** Per-request usage accumulator from streaming events. */
  private streamUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  }

  constructor(apiKey?: string, config?: Omit<ClaudeApiClientConfig, 'apiKey'>) {
    const resolvedKey = apiKey ?? process.env['ANTHROPIC_API_KEY']
    if (!resolvedKey) {
      throw new Error(
        'Anthropic API key is required. Provide it via the constructor or the ANTHROPIC_API_KEY environment variable.',
      )
    }

    const resolvedBaseUrl = config?.baseUrl ?? process.env['ANTHROPIC_BASE_URL']

    // Merge custom headers; support Bearer auth override for third-party providers (e.g. LongCat)
    const mergedHeaders: Record<string, string> = { ...config?.headers }
    if (process.env['ANTHROPIC_AUTH_HEADER']) {
      // Allow full override: e.g. "Bearer ak_xxx"
      mergedHeaders['Authorization'] = process.env['ANTHROPIC_AUTH_HEADER']
    }

    this.client = new Anthropic({
      apiKey: resolvedKey,
      baseURL: resolvedBaseUrl,
      defaultHeaders: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    })

    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
    this.defaultModel = config?.defaultModel ?? process.env['CC_AGENT_MODEL'] ?? 'claude-sonnet-4-20250514'

    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      requestCount: 0,
    }
  }

  // ----------------------------------------------------------
  // Streaming
  // ----------------------------------------------------------

  /**
   * Stream a response from the Anthropic Messages API.
   *
   * Yields {@link StreamEvent} objects that the caller can consume in real
   * time. The generator handles retries transparently: if a retryable error
   * occurs mid-stream, the request is re-issued from scratch.
   */
  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolInstance[] = [],
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const model = options.model ?? this.defaultModel
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    const formattedMessages = formatMessagesForApi(messages)
    const formattedTools = formatToolDefinitions(tools)

    // Build base request parameters (immutable across retries)
    const baseParams: MessageCreateParams = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: true,
    }

    if (systemPrompt.length > 0) {
      baseParams.system = systemPrompt
    }

    if (formattedTools.length > 0) {
      baseParams.tools = formattedTools
    }

    if (options.temperature !== undefined) {
      baseParams.temperature = options.temperature
    }

    if (options.stopSequences !== undefined) {
      baseParams.stop_sequences = options.stopSequences
    }

    if (options.topP !== undefined) {
      baseParams.top_p = options.topP
    }

    // Extended thinking configuration
    if (options.thinkingBudgetTokens && options.thinkingBudgetTokens > 0) {
      baseParams.thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudgetTokens,
      }
      // Extended thinking requires temperature = 1
      baseParams.temperature = 1
    }

    // Retry loop
    let lastError: unknown = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Honour cooperative cancellation before each attempt
      if (options.abortSignal?.aborted) {
        yield { type: 'error', error: new Error('Request aborted') }
        return
      }

      try {
        yield* this.executeStreamRequest(baseParams, options.abortSignal)
        return // Stream completed successfully
      } catch (err) {
        lastError = err

        // Never retry AbortErrors
        if (err instanceof Error && err.name === 'AbortError') {
          yield { type: 'error', error: err }
          return
        }

        if (!this.isRetryable(err, attempt)) {
          yield {
            type: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          }
          return
        }

        // Log retry for observability (callers can intercept via events)
        const delay = computeRetryDelay(attempt, extractRetryAfter(err))
        await sleep(delay, options.abortSignal)
      }
    }

    // All retry attempts exhausted
    yield {
      type: 'error',
      error:
        lastError instanceof Error
          ? lastError
          : new Error(`Request failed after ${this.maxRetries + 1} attempts`),
    }
  }

  // ----------------------------------------------------------
  // Token Counting
  // ----------------------------------------------------------

  /**
   * Count the tokens that a set of messages would consume.
   *
   * Uses the Anthropic Messages Count Tokens endpoint for an exact count.
   * Falls back to the local heuristic estimator if the API call fails.
   */
  async countTokens(
    messages: Message[],
    systemPrompt?: string,
    tools?: ToolInstance[],
  ): Promise<number> {
    const formattedMessages = formatMessagesForApi(messages)
    const formattedTools = tools ? formatToolDefinitions(tools) : undefined

    try {
      const params: Record<string, unknown> = {
        model: this.defaultModel,
        messages: formattedMessages,
      }

      if (systemPrompt) {
        params['system'] = systemPrompt
      }

      if (formattedTools && formattedTools.length > 0) {
        params['tools'] = formattedTools
      }

      const result = await this.client.messages.countTokens(
        params as unknown as Parameters<typeof this.client.messages.countTokens>[0],
      )
      return result.input_tokens
    } catch {
      // Fall back to local heuristic when the API is unavailable
      return this.estimateTokensLocally(messages, systemPrompt)
    }
  }

  // ----------------------------------------------------------
  // Usage Tracking
  // ----------------------------------------------------------

  /** Return a snapshot of cumulative token usage. */
  getUsage(): Readonly<TokenUsage> {
    return { ...this.usage }
  }

  /** Reset cumulative usage counters to zero. */
  resetUsage(): void {
    this.usage.inputTokens = 0
    this.usage.outputTokens = 0
    this.usage.cacheCreationTokens = 0
    this.usage.cacheReadTokens = 0
    this.usage.requestCount = 0
  }

  // ----------------------------------------------------------
  // Private: Stream Execution
  // ----------------------------------------------------------

  /**
   * Execute a single streaming API request and yield events.
   *
   * Separated from the retry loop so that each attempt gets its own
   * independent stream.
   */
  private async *executeStreamRequest(
    params: MessageCreateParams,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    // Reset per-request stream usage accumulator
    this.streamUsage = { inputTokens: 0, outputTokens: 0 }

    const stream = await this.client.messages.stream(params as Parameters<typeof this.client.messages.stream>[0])

    // Propagate abort to the underlying HTTP connection
    const abortHandler = () => {
      stream.abort()
    }
    abortSignal?.addEventListener('abort', abortHandler, { once: true })

    try {
      for await (const event of stream) {
        if (abortSignal?.aborted) {
          stream.abort()
          yield { type: 'error', error: new Error('Request aborted') }
          return
        }

        yield* this.processStreamEvent(event)
      }

      // Retrieve final message metadata
      const finalMessage = await stream.finalMessage()

      // Update cumulative usage.
      // Prefer finalMessage.usage when it contains real values; fall back to
      // values accumulated from message_start / message_delta streaming events
      // (third-party APIs like LongCat may leave usage empty or restructure it).
      const usage = finalMessage.usage
      const inputTokens =
        (typeof usage?.input_tokens === 'number' && usage.input_tokens > 0)
          ? usage.input_tokens
          : this.streamUsage.inputTokens
      const outputTokens =
        (typeof usage?.output_tokens === 'number' && usage.output_tokens > 0)
          ? usage.output_tokens
          : this.streamUsage.outputTokens

      this.usage.inputTokens += inputTokens
      this.usage.outputTokens += outputTokens
      this.usage.requestCount += 1

      // Track cache tokens if present
      if (usage) {
        const usageRecord = usage as unknown as Record<string, unknown>
        const cacheCreation = usageRecord['cache_creation_input_tokens']
        const cacheRead = usageRecord['cache_read_input_tokens']
        if (typeof cacheCreation === 'number') {
          this.usage.cacheCreationTokens += cacheCreation
        }
        if (typeof cacheRead === 'number') {
          this.usage.cacheReadTokens += cacheRead
        }
      }

      yield {
        type: 'done',
        stopReason: finalMessage.stop_reason ?? 'end_turn',
      }
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler)
    }
  }

  /**
   * Translate a raw Anthropic stream event into internal StreamEvent(s).
   *
   * The Anthropic streaming API delivers tool input as a series of
   * `input_json_delta` events that must be accumulated and parsed.  Rather
   * than mixing these with text content, we emit dedicated
   * `tool_input_delta` events so the consumer can track them per content
   * block index and assemble the final JSON when the block completes.
   */
  private *processStreamEvent(
    event: RawMessageStreamEvent,
  ): Generator<StreamEvent, void, undefined> {
    switch (event.type) {
      case 'content_block_delta': {
        const delta = event.delta

        if (delta.type === 'text_delta') {
          yield { type: 'text', content: delta.text }
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'thinking', content: delta.thinking }
        } else if (delta.type === 'input_json_delta') {
          // Emit a dedicated event for tool input accumulation.
          // The consumer tracks partial JSON per block index and parses
          // the complete object when content_block_stop fires.
          yield {
            type: 'tool_input_delta',
            index: event.index,
            partialJson: delta.partial_json,
          }
        }
        break
      }

      case 'content_block_start': {
        const block = event.content_block

        if (block.type === 'tool_use') {
          const toolUse: ToolUseBlock = {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            // The input object is populated incrementally via
            // input_json_delta events; the initial value is empty.
            input: (block.input as Record<string, unknown>) ?? {},
          }
          yield { type: 'tool_use', toolUse }
        }
        break
      }

      case 'content_block_stop': {
        // Consumers use this signal to finalise tool input accumulation
        // for the block at `event.index`.  No data is yielded here; the
        // QueryEngine handles parsing in its own tracking structures.
        break
      }

      // Track usage from streaming events as fallback for third-party APIs.
      // Note: the official Anthropic API puts input_tokens in message_start
      // and output_tokens in message_delta.  Some providers (e.g. LongCat)
      // put BOTH in message_delta and leave message_start.usage empty.
      case 'message_start': {
        const msgUsage = (event as any).message?.usage
        if (msgUsage) {
          if (typeof msgUsage.input_tokens === 'number') {
            this.streamUsage.inputTokens = msgUsage.input_tokens
          }
          if (typeof msgUsage.output_tokens === 'number') {
            this.streamUsage.outputTokens = msgUsage.output_tokens
          }
        }
        break
      }

      case 'message_delta': {
        const deltaUsage = (event as any).usage
        if (deltaUsage) {
          if (typeof deltaUsage.output_tokens === 'number') {
            this.streamUsage.outputTokens = deltaUsage.output_tokens
          }
          // Some providers also include input_tokens here
          if (typeof deltaUsage.input_tokens === 'number') {
            this.streamUsage.inputTokens = deltaUsage.input_tokens
          }
        }
        break
      }

      // message_stop requires no action
      default:
        break
    }
  }

  // ----------------------------------------------------------
  // Private: Retry Logic
  // ----------------------------------------------------------

  /**
   * Determine whether a failed request should be retried.
   */
  private isRetryable(error: unknown, attempt: number): boolean {
    if (attempt >= this.maxRetries) return false

    const status = extractHttpStatus(error)
    if (status !== undefined) {
      return RETRYABLE_STATUS_CODES.has(status)
    }

    // Retry on network-level errors (ECONNRESET, ETIMEDOUT, etc.)
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
        return true
      }
    }

    return false
  }

  // ----------------------------------------------------------
  // Private: Token Estimation
  // ----------------------------------------------------------

  /**
   * Rough local token estimator. Uses the ~4 chars/token heuristic for
   * English text. Intended as a fallback when the API is unavailable.
   */
  private estimateTokensLocally(messages: Message[], systemPrompt?: string): number {
    let total = 0

    if (systemPrompt) {
      total += Math.ceil(systemPrompt.length / 4)
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') {
            total += Math.ceil(block.text.length / 4)
          } else if (block.type === 'tool_result') {
            const content = block.content
            if (typeof content === 'string') {
              total += Math.ceil(content.length / 4)
            }
          } else if (block.type === 'thinking') {
            total += Math.ceil(block.thinking.length / 4)
          }
          // Image and tool_use blocks are not easily estimable; skip.
        }
      }
    }

    return total
  }
}

// ============================================================
// Utility: cancellable sleep
// ============================================================

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Sleep aborted'))
      return
    }

    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Sleep aborted'))
    }

    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create a configured {@link ClaudeApiClient} instance.
 *
 * @example
 * ```ts
 * const client = createApiClient({
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   defaultModel: 'claude-sonnet-4-20250514',
 *   maxRetries: 3,
 * })
 * ```
 */
export function createApiClient(config: ClaudeApiClientConfig = {}): ClaudeApiClient {
  const { apiKey, ...rest } = config
  return new ClaudeApiClient(apiKey, rest)
}
