/**
 * Provider Adapter Layer
 *
 * Defines a provider-agnostic interface for LLM API communication and a
 * factory function that selects the right adapter based on configuration.
 *
 * Architecture:
 *  - `ProviderAdapter` is the contract that all LLM providers implement.
 *    It exposes `stream()`, `countTokens()`, and usage tracking — the same
 *    surface area that `QueryEngine` relies on.
 *  - `ClaudeApiClient` (claude.ts) is the Anthropic implementation.
 *  - `OpenAICompatibleAdapter` (openai.ts) handles OpenAI-compatible APIs
 *    (OpenAI, Azure OpenAI, local LLMs, proxy services like LongCat).
 *  - `createProvider()` is the single entry point used by QueryEngine and
 *    main.ts to instantiate the correct adapter.
 *
 * The internal `StreamEvent` type (types/index.ts) is already provider-
 * agnostic, so adapters only need to translate their native streaming
 * protocol into `StreamEvent` objects.
 */

import type { Message, StreamEvent, ToolInstance } from '../../types/index.js'
import type { StreamOptions, TokenUsage } from './claude.js'
import { ClaudeApiClient } from './claude.js'

// ============================================================
// Provider Types
// ============================================================

/** Supported LLM provider backends. */
export type ProviderName = 'anthropic' | 'openai'

/**
 * Configuration for provider selection and initialisation.
 *
 * The `provider` field selects the backend; remaining fields are forwarded
 * to the provider-specific adapter constructor.
 */
export interface ProviderConfig {
  /** Which provider backend to use (default: auto-detect from model name). */
  provider?: ProviderName
  /** API key for the selected provider. */
  apiKey?: string
  /** Base URL override (for self-hosted or proxy endpoints). */
  baseUrl?: string
  /** Default model identifier. */
  defaultModel?: string
  /** Maximum retry attempts for transient errors. */
  maxRetries?: number
  /** Additional HTTP headers. */
  headers?: Record<string, string>
  /** Enable provider-specific prompt caching (Anthropic only). */
  enablePromptCache?: boolean
}

// ============================================================
// Provider Adapter Interface
// ============================================================

/**
 * The universal contract that all LLM provider adapters must satisfy.
 *
 * `QueryEngine` programs against this interface so the agentic loop is
 * completely decoupled from any specific provider's API format.
 */
export interface ProviderAdapter {
  /**
   * Stream a model response.
   *
   * Yields `StreamEvent` objects that the engine consumes in real time
   * (text deltas, tool use blocks, thinking tokens, etc.).
   */
  stream(
    messages: Message[],
    systemPrompt: string,
    tools?: ToolInstance[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, undefined>

  /**
   * Count the tokens that a set of messages would consume.
   *
   * May fall back to a local heuristic if the provider doesn't expose
   * a dedicated counting endpoint.
   */
  countTokens(
    messages: Message[],
    systemPrompt?: string,
    tools?: ToolInstance[],
  ): Promise<number>

  /** Return a snapshot of cumulative token usage for this session. */
  getUsage(): Readonly<TokenUsage>

  /** Reset cumulative usage counters to zero. */
  resetUsage(): void

  /** The default model identifier for this adapter. */
  readonly defaultModel: string
}

// ============================================================
// Provider Factory
// ============================================================

/** Known OpenAI-compatible model prefixes for auto-detection. */
const OPENAI_MODEL_PREFIXES = [
  'gpt-',
  'o1',
  'o3',
  'o4',
  'chatgpt-',
]

/** Known Anthropic model prefixes for auto-detection. */
const ANTHROPIC_MODEL_PREFIXES = [
  'claude-',
]

/**
 * Auto-detect the provider from a model name.
 *
 * Falls back to 'anthropic' for unknown models (preserving the current
 * default behaviour).
 */
export function detectProvider(model: string): ProviderName {
  const lower = model.toLowerCase()
  if (OPENAI_MODEL_PREFIXES.some(p => lower.startsWith(p))) return 'openai'
  if (ANTHROPIC_MODEL_PREFIXES.some(p => lower.startsWith(p))) return 'anthropic'
  return 'anthropic'
}

/**
 * Create a provider adapter from configuration.
 *
 * If `provider` is not specified, the adapter is selected based on the
 * model name (auto-detection).  The returned object satisfies
 * `ProviderAdapter` and can be passed directly to `QueryEngine`.
 *
 * @example
 * ```ts
 * // Anthropic (default)
 * const provider = createProvider({ apiKey: 'sk-ant-...' })
 *
 * // OpenAI
 * const provider = createProvider({ provider: 'openai', apiKey: 'sk-...' })
 *
 * // OpenAI-compatible proxy (e.g. local LLM)
 * const provider = createProvider({
 *   provider: 'openai',
 *   baseUrl: 'http://localhost:8080/v1',
 *   apiKey: 'not-needed',
 *   defaultModel: 'llama-3-70b',
 * })
 * ```
 */
export async function createProvider(config: ProviderConfig = {}): Promise<ProviderAdapter> {
  const providerName = config.provider ?? detectProvider(config.defaultModel ?? '')
  const defaultModel = config.defaultModel ?? resolveDefaultModel(providerName)

  switch (providerName) {
    case 'anthropic': {
      return new ClaudeApiClient(config.apiKey, {
        baseUrl: config.baseUrl,
        defaultModel,
        maxRetries: config.maxRetries,
        headers: config.headers,
        enablePromptCache: config.enablePromptCache,
      })
    }

    case 'openai': {
      // Dynamic import to avoid pulling in the openai SDK when not needed.
      const { OpenAICompatibleAdapter } = await import('./openai.js')
      return new OpenAICompatibleAdapter(config.apiKey, {
        baseUrl: config.baseUrl,
        defaultModel,
        maxRetries: config.maxRetries,
        headers: config.headers,
      })
    }

    default:
      throw new Error(`Unknown provider: "${providerName as string}". Supported: anthropic, openai.`)
  }
}

/**
 * Resolve the default model name for a given provider.
 */
function resolveDefaultModel(provider: ProviderName): string {
  // Check environment variable first.
  const envModel = process.env['CC_AGENT_MODEL']
  if (envModel) return envModel

  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-20250514'
    case 'openai':
      return 'gpt-4o'
  }
}
