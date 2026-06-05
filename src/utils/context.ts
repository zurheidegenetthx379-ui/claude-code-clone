/**
 * Context window management constants and utilities
 * Mirrors Claude Code's context management system
 */

import type { ContextWindowConfig } from '../types/index.js'

// Default context window sizes
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// 1M context support
export const MODEL_CONTEXT_WINDOW_1M = 1_000_000

/**
 * Get the context window size for a given model
 */
export function getContextWindowForModel(model: string): number {
  if (model.includes('[1m]') || model.includes('1m-context')) {
    return MODEL_CONTEXT_WINDOW_1M
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Get max output tokens for a given model
 */
export function getMaxOutputTokensForModel(_model: string): number {
  // Default cap to avoid over-reserving slot capacity
  return CAPPED_DEFAULT_MAX_TOKENS
}

/**
 * Get the effective context window (minus reserved summary tokens)
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const contextWindow = getContextWindowForModel(model)
  return contextWindow - reservedTokensForSummary
}

/**
 * Get default context window configuration
 */
export function getDefaultContextConfig(model: string): ContextWindowConfig {
  return {
    windowSize: getContextWindowForModel(model),
    reservedForSummary: Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY),
    maxOutputTokens: CAPPED_DEFAULT_MAX_TOKENS,
    escalatedMaxTokens: ESCALATED_MAX_TOKENS,
    autoCompactBuffer: AUTOCOMPACT_BUFFER_TOKENS,
  }
}

/**
 * Rough token estimation from text (1 token ≈ 4 characters for English)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimate tokens from a messages array
 */
export function estimateMessageTokens(messages: Array<{ content: string | unknown[] }>): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          total += estimateTokens((block as { text: string }).text)
        }
      }
    }
  }
  return total
}

/**
 * Check if auto-compact is needed based on current token usage
 */
export function shouldAutoCompact(
  currentTokens: number,
  effectiveWindowSize: number,
  bufferTokens: number = AUTOCOMPACT_BUFFER_TOKENS,
): boolean {
  return currentTokens >= effectiveWindowSize - bufferTokens
}
