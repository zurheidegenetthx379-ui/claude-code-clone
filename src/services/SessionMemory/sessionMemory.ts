/**
 * Session Memory Service
 *
 * Maintains a per-session markdown file that captures high-level context,
 * decisions, and progress as the conversation evolves.  The file lives at a
 * well-known path inside the project's `.session-memory/` directory and is
 * periodically rewritten by an extraction step that summarises recent
 * messages.
 *
 * The extraction is gated by several thresholds to avoid excessive writes:
 *  - A minimum token count before the first extraction is triggered.
 *  - A minimum token delta between successive extractions.
 *  - A minimum number of tool calls between extractions.
 *
 * These thresholds mirror the breakpoint-detection logic used by Claude Code.
 */

import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  Message,
  SessionMemoryState,
  ToolUseBlock,
} from '../../types/index.js'
import { estimateTokenCount } from '../compact/compact.js'
import { generateSessionMemoryUpdate } from './aiMemoryExtractor.js'
import type { ProviderAdapter } from '../api/provider.js'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum estimated token count across all messages before the very first
 * memory extraction is triggered.  This prevents premature extraction on
 * trivially short conversations.
 */
export const minimumMessageTokensToInit = 10_000

/**
 * Minimum token delta since the last extraction before a new extraction is
 * triggered.  This spaces out writes so we don't burn cycles rewriting the
 * memory file after every single message.
 */
export const minimumTokensBetweenUpdate = 5_000

/**
 * Minimum number of tool_use blocks observed since the last extraction.
 * This acts as a secondary gate — even when the token delta is large enough
 * we only extract if meaningful tool activity has occurred.
 */
export const toolCallsBetweenUpdates = 3

/** Directory name (relative to project root) where session memory files live. */
const SESSION_MEMORY_DIR = '.session-memory'

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Token estimator with CJK awareness.
 * Delegates to the CJK-aware estimator in the compact service for accurate
 * estimation across ASCII and CJK text.
 */
function estimateTokens(text: string): number {
  return estimateTokenCount(text)
}

/**
 * Estimates the total token count for an array of messages by summing the
 * stringified content of each message.
 */
function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else {
      // Sum text from structured content blocks.
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          total += estimateTokens(block.text)
        } else if ('thinking' in block && typeof block.thinking === 'string') {
          total += estimateTokens(block.thinking)
        }
      }
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// Tool-call counter
// ---------------------------------------------------------------------------

/**
 * Counts the number of `tool_use` content blocks present in an array of
 * messages.  Used to gate extractions behind the `toolCallsBetweenUpdates`
 * threshold.
 */
function countToolCalls(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        count++
      }
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// State store (in-memory, keyed by sessionId)
// ---------------------------------------------------------------------------

const sessionStates = new Map<string, SessionMemoryState>()

/**
 * Returns the current session-memory state for `sessionId`, or `null` if
 * session memory has not been initialised.
 */
export function getSessionMemoryState(sessionId: string): SessionMemoryState | null {
  return sessionStates.get(sessionId) ?? null
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical file path for a session's memory file and ensures
 * the parent directory exists.
 */
function resolveSessionMemoryPath(cwd: string, sessionId: string): string {
  return join(resolve(cwd), SESSION_MEMORY_DIR, `${sessionId}.md`)
}

/**
 * Creates (or opens) the session memory markdown file at `filePath` with
 * restrictive permissions (0o600 — owner read/write only).
 *
 * Returns the absolute path that was created.
 */
export async function createSessionMemoryFile(filePath: string): Promise<string> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  // Open with exclusive create to avoid clobbering an existing file.
  const handle = await open(filePath, 'wx', 0o600)
  try {
    const header = [
      '# Session Memory',
      '',
      `> Auto-generated session memory file.`,
      `> Created: ${new Date().toISOString()}`,
      '',
      '## Key Context',
      '',
      '_(No context captured yet.)_',
      '',
      '## Decisions Made',
      '',
      '_(No decisions recorded yet.)_',
      '',
      '## Progress',
      '',
      '_(No progress captured yet.)_',
      '',
    ].join('\n')

    await handle.writeFile(header, 'utf-8')
  } finally {
    await handle.close()
  }

  return filePath
}

/**
 * Initialises session memory for a given session.
 *
 * - Resolves the canonical file path.
 * - Creates the file if it does not already exist.
 * - Registers an in-memory state entry.
 *
 * Returns the resolved file path.
 */
export async function initSessionMemory(
  sessionId: string,
  cwd: string,
): Promise<string> {
  const filePath = resolveSessionMemoryPath(cwd, sessionId)

  // Only create the file when it doesn't exist yet.
  try {
    await open(filePath, 'r').then((h) => h.close())
  } catch {
    await createSessionMemoryFile(filePath)
  }

  const existingContent = await readFile(filePath, 'utf-8').catch(() => '')

  sessionStates.set(sessionId, {
    filePath,
    lastUpdated: Date.now(),
    tokenCount: estimateTokens(existingContent),
  })

  return filePath
}

// ---------------------------------------------------------------------------
// Breakpoint detection — should we extract?
// ---------------------------------------------------------------------------

export interface ExtractionDecision {
  shouldExtract: boolean
  reason: string
}

/**
 * Determines whether a memory extraction should run for the current
 * conversation state.
 *
 * The decision is governed by three thresholds that must **all** be
 * satisfied (logical AND) before extraction is triggered:
 *
 *  1. The total message token count must exceed `minimumMessageTokensToInit`.
 *  2. The token delta since the last extraction must exceed
 *     `minimumTokensBetweenUpdate`.
 *  3. The number of tool calls since the last extraction must be at least
 *     `toolCallsBetweenUpdates`.
 *
 * When session memory has not yet been initialised the last two conditions
 * are vacuously true (i.e. only the first gate applies).
 */
export function shouldExtractMemory(state: {
  messages: Message[]
  sessionMemoryState: SessionMemoryState | null
}): ExtractionDecision {
  const { messages, sessionMemoryState } = state

  const totalTokens = estimateMessageTokens(messages)

  // Gate 1 — absolute minimum.
  if (totalTokens < minimumMessageTokensToInit) {
    return {
      shouldExtract: false,
      reason: `Total token count (${totalTokens}) below init threshold (${minimumMessageTokensToInit}).`,
    }
  }

  // If no prior state exists, we are good to go after passing gate 1.
  if (!sessionMemoryState) {
    return {
      shouldExtract: true,
      reason: 'First extraction — init threshold reached and no prior state.',
    }
  }

  // For subsequent extractions we need to look at the delta.  We approximate
  // the delta by looking at messages whose timestamp is after lastUpdated.
  const recentMessages = messages.filter(
    (m) => m.timestamp > sessionMemoryState.lastUpdated,
  )
  const deltaTokens = estimateMessageTokens(recentMessages)
  const deltaToolCalls = countToolCalls(recentMessages)

  // Gate 2 — token delta.
  if (deltaTokens < minimumTokensBetweenUpdate) {
    return {
      shouldExtract: false,
      reason: `Token delta (${deltaTokens}) below update threshold (${minimumTokensBetweenUpdate}).`,
    }
  }

  // Gate 3 — tool call count.
  if (deltaToolCalls < toolCallsBetweenUpdates) {
    return {
      shouldExtract: false,
      reason: `Tool calls since last update (${deltaToolCalls}) below threshold (${toolCallsBetweenUpdates}).`,
    }
  }

  return {
    shouldExtract: true,
    reason: `All thresholds met (delta tokens: ${deltaTokens}, delta tool calls: ${deltaToolCalls}).`,
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Extracts key context from `messages` and writes an updated session memory
 * file.  The extraction logic here is intentionally heuristic — in a real
 * system this would call out to an LLM for summarisation.
 *
 * After a successful write the in-memory state is updated with the new
 * timestamp and token count.
 */
export async function updateSessionMemory(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  const state = sessionStates.get(sessionId)
  if (!state) {
    throw new Error(
      `Session memory not initialised for session "${sessionId}". Call initSessionMemory() first.`,
    )
  }

  // ---- Heuristic extraction ------------------------------------------------
  // Pull out user messages and tool_use names as lightweight "context".
  const userSnippets: string[] = []
  const toolNames: string[] = []
  const assistantSnippets: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join(' ')
      if (text.trim()) userSnippets.push(text.trim().slice(0, 300))
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNames.push((block as ToolUseBlock).name)
        }
        if (block.type === 'text') {
          assistantSnippets.push(block.text.slice(0, 200))
        }
      }
    }
  }

  // ---- Build updated markdown content --------------------------------------
  const sections: string[] = []

  sections.push('# Session Memory', '')
  sections.push(`> Last updated: ${new Date().toISOString()}`, '')

  // Key context
  sections.push('## Key Context', '')
  if (userSnippets.length > 0) {
    const recent = userSnippets.slice(-5)
    for (const s of recent) {
      sections.push(`- ${s}`)
    }
  } else {
    sections.push('_(No context captured yet.)_')
  }
  sections.push('')

  // Tools used
  sections.push('## Tools Used', '')
  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)]
    for (const name of unique) {
      const count = toolNames.filter((n) => n === name).length
      sections.push(`- \`${name}\` (x${count})`)
    }
  } else {
    sections.push('_(No tools used yet.)_')
  }
  sections.push('')

  // Progress
  sections.push('## Progress', '')
  if (assistantSnippets.length > 0) {
    const recent = assistantSnippets.slice(-3)
    for (const s of recent) {
      sections.push(`- ${s}`)
    }
  } else {
    sections.push('_(No progress captured yet.)_')
  }
  sections.push('')

  const newContent = sections.join('\n')

  // ---- Write to disk -------------------------------------------------------
  await writeFile(state.filePath, newContent, { encoding: 'utf-8', mode: 0o600 })

  // ---- Update in-memory state ----------------------------------------------
  sessionStates.set(sessionId, {
    filePath: state.filePath,
    lastUpdated: Date.now(),
    tokenCount: estimateTokens(newContent),
  })
}

// ---------------------------------------------------------------------------
// AI-powered update
// ---------------------------------------------------------------------------

/**
 * Updates session memory using LLM-powered extraction.
 *
 * Attempts to use the AI extractor first; falls back to the heuristic
 * `updateSessionMemory` if the provider is unavailable or the call fails.
 *
 * @param sessionId - The session identifier.
 * @param messages - Current conversation messages.
 * @param provider - The LLM provider adapter for AI extraction.
 * @param model - Optional model override for the extraction call.
 */
export async function updateSessionMemoryWithAI(
  sessionId: string,
  messages: Message[],
  provider: ProviderAdapter,
  model?: string,
): Promise<'ai' | 'heuristic'> {
  const state = sessionStates.get(sessionId)
  if (!state) {
    throw new Error(
      `Session memory not initialised for session "${sessionId}". Call initSessionMemory() first.`,
    )
  }

  // Read existing memory content for the AI to merge with.
  let existingContent = ''
  try {
    existingContent = await readFile(state.filePath, 'utf-8')
  } catch {
    // File may not exist yet — that's fine.
  }

  // Attempt AI-powered extraction.
  const aiResult = await generateSessionMemoryUpdate(
    provider,
    messages,
    existingContent,
    model,
  )

  if (aiResult) {
    await writeFile(state.filePath, aiResult, { encoding: 'utf-8', mode: 0o600 })
    sessionStates.set(sessionId, {
      filePath: state.filePath,
      lastUpdated: Date.now(),
      tokenCount: estimateTokenCount(aiResult),
    })
    return 'ai'
  }

  // Fall back to heuristic extraction.
  await updateSessionMemory(sessionId, messages)
  return 'heuristic'
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes the in-memory state for a session.  Does **not** delete the file
 * on disk — call the caller should handle that if desired.
 */
export function disposeSessionMemory(sessionId: string): void {
  sessionStates.delete(sessionId)
}
