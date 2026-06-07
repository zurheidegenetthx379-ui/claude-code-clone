/**
 * OpenAI-Compatible Provider Adapter
 *
 * Implements the ProviderAdapter interface for OpenAI and any API that
 * follows the OpenAI Chat Completions protocol (Azure OpenAI, local LLMs
 * via Ollama/vLLM/LM Studio, proxy services, etc.).
 *
 * Streaming protocol:
 *  - POST /v1/chat/completions with stream: true
 *  - Server-Sent Events with `data: { choices: [{ delta: {...} }] }`
 *  - Tool calls arrive as incremental `tool_calls[].function` deltas
 *
 * Translation layer:
 *  - Internal `Message`/`ContentBlock` → OpenAI messages array
 *  - Internal `ToolInstance` → OpenAI function definitions
 *  - OpenAI SSE deltas → internal `StreamEvent` objects
 */

import type {
  ContentBlock,
  Message,
  StreamEvent,
  ToolInstance,
  ToolUseBlock,
} from '../../types/index.js'
import type { StreamOptions, TokenUsage } from './claude.js'
import type { ProviderAdapter } from './provider.js'

// ============================================================
// Configuration
// ============================================================

export interface OpenAIAdapterConfig {
  baseUrl?: string
  defaultModel?: string
  maxRetries?: number
  headers?: Record<string, string>
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_MAX_TOKENS = 8192
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 60_000

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

// ============================================================
// OpenAI API Types (minimal subset)
// ============================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIStreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ============================================================
// Adapter Implementation
// ============================================================

export class OpenAICompatibleAdapter implements ProviderAdapter {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  readonly defaultModel: string
  private readonly headers: Record<string, string>
  private readonly usage: TokenUsage

  constructor(apiKey?: string, config?: OpenAIAdapterConfig) {
    this.apiKey = apiKey ?? process.env['OPENAI_API_KEY'] ?? 'not-needed'
    this.baseUrl = (config?.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
    this.defaultModel = config?.defaultModel ?? process.env['CC_AGENT_MODEL'] ?? 'gpt-4o'
    this.headers = config?.headers ?? {}

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

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolInstance[] = [],
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const model = options.model ?? this.defaultModel
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS

    const openaiMessages = this.formatMessages(messages, systemPrompt)
    const openaiTools = this.formatTools(tools)

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.topP !== undefined) body.top_p = options.topP
    if (options.stopSequences) body.stop = options.stopSequences
    if (openaiTools.length > 0) body.tools = openaiTools

    // Retry loop
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (options.abortSignal?.aborted) {
        yield { type: 'error', error: new Error('Aborted') }
        return
      }

      if (attempt > 0) {
        const delay = computeRetryDelay(attempt - 1)
        yield { type: 'text', content: `\n[retry ${attempt}/${this.maxRetries} after ${delay}ms]\n` }
        await sleep(delay)
      }

      try {
        yield* this.executeStream(body, options.abortSignal)
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const status = extractHttpStatus(err)
        if (status && !RETRYABLE_STATUS_CODES.has(status)) break
        if (attempt === this.maxRetries) break
      }
    }

    yield { type: 'error', error: lastError ?? new Error('Unknown streaming error') }
  }

  // ----------------------------------------------------------
  // Token Counting
  // ----------------------------------------------------------

  async countTokens(
    messages: Message[],
    systemPrompt?: string,
    _tools?: ToolInstance[],
  ): Promise<number> {
    // OpenAI doesn't have a dedicated token counting endpoint for chat.
    // Use the local heuristic estimator.
    return this.estimateTokensLocally(messages, systemPrompt)
  }

  // ----------------------------------------------------------
  // Usage Tracking
  // ----------------------------------------------------------

  getUsage(): Readonly<TokenUsage> {
    return { ...this.usage }
  }

  resetUsage(): void {
    this.usage.inputTokens = 0
    this.usage.outputTokens = 0
    this.usage.cacheCreationTokens = 0
    this.usage.cacheReadTokens = 0
    this.usage.requestCount = 0
  }

  // ==========================================================
  // Private: Stream Execution
  // ==========================================================

  private async *executeStream(
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const url = `${this.baseUrl}/chat/completions`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown')
      const err = new Error(`OpenAI API error ${response.status}: ${errorBody.slice(0, 500)}`)
      ;(err as any).status = response.status
      throw err
    }

    this.usage.requestCount++

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', error: new Error('No response body from OpenAI API') }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    // Track in-progress tool calls across chunks
    const pendingToolCalls = new Map<number, {
      id: string
      name: string
      arguments: string
    }>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          let chunk: OpenAIStreamChunk
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunk
          } catch {
            continue // Skip malformed chunks
          }

          // Process usage if present (typically in the final chunk)
          if (chunk.usage) {
            this.usage.inputTokens += chunk.usage.prompt_tokens
            this.usage.outputTokens += chunk.usage.completion_tokens
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          const { delta, finish_reason } = choice

          // Text content delta
          if (delta.content) {
            yield { type: 'text', content: delta.content }
          }

          // Tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              let pending = pendingToolCalls.get(idx)

              if (tc.id && tc.function?.name) {
                // New tool call starting
                pending = { id: tc.id, name: tc.function.name, arguments: '' }
                pendingToolCalls.set(idx, pending)
                // Emit tool_use event
                yield {
                  type: 'tool_use',
                  toolUse: {
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: {},
                  },
                }
              } else if (pending && tc.function?.arguments) {
                // Incremental arguments delta
                pending.arguments += tc.function.arguments
                yield {
                  type: 'tool_input_delta',
                  index: idx,
                  partialJson: tc.function.arguments,
                }
              }
            }
          }

          // Finish reason
          if (finish_reason === 'tool_calls') {
            // Emit completed tool calls with parsed input
            for (const [_idx, tc] of pendingToolCalls) {
              let parsedInput: Record<string, unknown> = {}
              try {
                parsedInput = JSON.parse(tc.arguments)
              } catch {
                parsedInput = { _raw: tc.arguments }
              }

              yield {
                type: 'tool_use',
                toolUse: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: parsedInput,
                } as ToolUseBlock,
              }
            }
          } else if (finish_reason === 'stop' || finish_reason === 'length') {
            // Normal completion
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done', stopReason: 'end_turn' }
  }

  // ==========================================================
  // Private: Message Formatting
  // ==========================================================

  private formatMessages(messages: Message[], systemPrompt: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = []

    // System prompt as first message
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (msg.role === 'system') continue // Skip internal system messages

      if (typeof msg.content === 'string') {
        result.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        })
        continue
      }

      // Handle ContentBlock arrays
      const blocks = msg.content as ContentBlock[]
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []
      let toolResultId: string | undefined
      let toolResultContent: string | undefined

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })
        } else if (block.type === 'tool_result') {
          toolResultId = block.tool_use_id
          toolResultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)
        } else if (block.type === 'thinking') {
          // Include thinking as a text prefix (OpenAI doesn't have native thinking)
          textParts.push(`[Thinking: ${block.thinking}]`)
        }
        // ImageBlock: skip for now (could be added via multimodal content)
      }

      if (toolResultId !== undefined) {
        // This is a tool result message
        result.push({
          role: 'tool',
          tool_call_id: toolResultId,
          content: toolResultContent ?? '',
        })
      } else if (toolCalls.length > 0) {
        // Assistant message with tool calls
        const entry: OpenAIMessage = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('\n') : null,
          tool_calls: toolCalls,
        }
        result.push(entry)
      } else {
        // Plain text message
        result.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: textParts.join('\n'),
        })
      }
    }

    return result
  }

  // ==========================================================
  // Private: Tool Formatting
  // ==========================================================

  private formatTools(tools: ToolInstance[]): OpenAITool[] {
    return tools
      .filter(t => t.isEnabled())
      .map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description:
            typeof tool.description === 'function' ? tool.description() : tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      }))
  }

  // ==========================================================
  // Private: Token Estimation
  // ==========================================================

  private estimateTokensLocally(messages: Message[], systemPrompt?: string): number {
    let totalChars = 0
    if (systemPrompt) totalChars += systemPrompt.length

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length
      } else {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') totalChars += block.text.length
          else if (block.type === 'tool_use') totalChars += JSON.stringify(block.input).length
          else if (block.type === 'tool_result') {
            totalChars += typeof block.content === 'string' ? block.content.length : 200
          }
        }
      }
    }

    // Rough heuristic: ~4 characters per token for English text.
    return Math.ceil(totalChars / 4)
  }
}

// ============================================================
// Helpers
// ============================================================

function computeRetryDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS)
  }
  const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
  const jitter = Math.random() * RETRY_BASE_DELAY_MS
  return Math.min(exponentialDelay + jitter, RETRY_MAX_DELAY_MS)
}

function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    if (typeof e['status'] === 'number') return e['status']
    if (typeof e['statusCode'] === 'number') return e['statusCode']
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
