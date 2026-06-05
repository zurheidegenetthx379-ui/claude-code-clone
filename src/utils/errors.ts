/**
 * Structured Error Hierarchy for the AI Coding Agent.
 *
 * Provides typed error classes so callers can distinguish between different
 * failure modes (API errors, permission denials, timeouts, etc.) using
 * `instanceof` checks rather than fragile string matching.
 *
 * The base class {@link AgentError} preserves the original `cause` so that
 * stack traces and diagnostic context are never lost.
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class AgentError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'AgentError'
  }
}

// ---------------------------------------------------------------------------
// API errors
// ---------------------------------------------------------------------------

export class ApiError extends AgentError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause)
    this.name = 'ApiError'
  }
}

// ---------------------------------------------------------------------------
// Permission errors
// ---------------------------------------------------------------------------

export class PermissionError extends AgentError {
  constructor(
    message: string,
    public readonly toolName: string,
    cause?: unknown,
  ) {
    super(message, cause)
    this.name = 'PermissionError'
  }
}

// ---------------------------------------------------------------------------
// Timeout errors
// ---------------------------------------------------------------------------

export class TimeoutError extends AgentError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(message, cause)
    this.name = 'TimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Abort errors
// ---------------------------------------------------------------------------

export class AbortError extends AgentError {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

// ---------------------------------------------------------------------------
// Tool execution errors
// ---------------------------------------------------------------------------

export class ToolExecutionError extends AgentError {
  constructor(
    message: string,
    public readonly toolName: string,
    cause?: unknown,
  ) {
    super(message, cause)
    this.name = 'ToolExecutionError'
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is safe to retry.
 *
 * - {@link ApiError}: retryable when the `retryable` flag is `true`.
 * - {@link TimeoutError}: always retryable (transient by nature).
 * - Everything else: not retryable.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiError) return err.retryable
  if (err instanceof TimeoutError) return true
  return false
}

/**
 * Classify an HTTP status code into a human-readable label and a
 * retryability flag.
 *
 * Covers the most common transient codes (429, 408, 5xx) and falls back
 * to a generic non-retryable classification for everything else.
 */
export function classifyApiError(statusCode: number): { retryable: boolean; label: string } {
  if (statusCode === 429) return { retryable: true, label: 'Rate limited' }
  if (statusCode >= 500 && statusCode < 600) return { retryable: true, label: 'Server error' }
  if (statusCode === 408) return { retryable: true, label: 'Request timeout' }
  return { retryable: false, label: `HTTP ${statusCode}` }
}
