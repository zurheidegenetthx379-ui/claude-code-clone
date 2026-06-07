/**
 * Conversation Recovery Pipeline
 *
 * Restores a prior conversation session so the agent can resume work from
 * where it left off.  Mirrors Claude Code's `--resume` and `--continue`
 * recovery paths.
 *
 * The pipeline handles several source types:
 *
 *  - `'last'`        -- resolve to the most recent session in the project.
 *  - Session ID      -- load a specific session by its UUID.
 *  - File path       -- load a session from an explicit `.jsonl` path.
 *  - Pre-loaded data -- accept an already-parsed transcript object.
 *
 * Recovery steps:
 *
 *  1. **Resolve source** -- map the source identifier to a JSONL file path.
 *  2. **Load transcript** -- parse the JSONL file using the session storage
 *     engine ({@link loadTranscriptFile}).
 *  3. **Copy plan & file history** -- extract any plan data and file-history
 *     metadata from the transcript entries.
 *  4. **Resume consistency check** -- detect drift between the in-memory
 *     checkpoint and the on-disk transcript.
 *  5. **Filter invalid messages** -- remove orphaned tool_uses, blank
 *     assistant messages, and unresolved tool_result references.
 *  6. **Detect interrupted turns** -- if the last assistant turn was cut
 *     short (crash, cancellation), inject a "Continue from where you left
 *     off" user message so the model picks up the thread.
 *  7. **Return** -- yield the cleaned message array, metadata, session ID,
 *     file history, and interrupted-turn state.
 *
 * Design notes:
 *  - The pipeline is **non-destructive**: the original JSONL file is never
 *    modified.  Filtering and injection happen on the in-memory copy.
 *  - All errors during recovery are caught and surfaced as part of the
 *    result so the caller can decide how to proceed (e.g. start a new
 *    session or show an error to the user).
 */

import {
  loadTranscriptFile,
  buildConversationChain,
  recoverOrphanedParallelToolResults,
  checkResumeConsistency,
  getTranscriptPath,
} from './sessionStorage.js'
import type {
  TranscriptEntry,
  JournalEntry,
  ResumeCheckpoint,
  ResumeConsistencyResult,
} from './sessionStorage.js'
import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  SessionMetadata,
  TranscriptMessage,
} from '../types/index.js'

import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// ============================================================
// Types
// ============================================================

/**
 * Source specifier for the conversation to resume.
 */
export type ResumeSource =
  | 'last'                     // Most recent session
  | string                     // Session ID or file path

/**
 * Pre-loaded transcript data (for callers that have already parsed the file).
 */
export interface PreloadedTranscriptData {
  messages: TranscriptMessage[]
  metadata: SessionMetadata
  filePath: string
  summary?: string
  allEntries?: JournalEntry[]
}

/**
 * The result of the conversation recovery pipeline.
 */
export interface RecoveryResult {
  /** Cleaned messages ready for the agent to consume. */
  messages: Message[]
  /** Reconstructed session metadata (title, tag, mode, etc.). */
  metadata: SessionMetadata
  /** Session ID of the recovered conversation. */
  sessionId: string
  /** File paths that were read/written during the prior session. */
  fileHistory: string[]
  /** State of the interrupted turn, if one was detected. */
  interruptedTurnState: InterruptedTurnState | null
  /** Whether the resume consistency check passed. */
  consistencyCheck: ResumeConsistencyResult | null
  /** Compaction summary from the prior session, if any. */
  summary?: string
  /** Any warnings generated during recovery. */
  warnings: string[]
  /** Any errors that occurred during recovery (non-fatal). */
  errors: string[]
}

/**
 * State captured from an interrupted (incomplete) assistant turn.
 */
export interface InterruptedTurnState {
  /** The partial assistant message that was interrupted. */
  partialMessage: Message
  /** Tool uses that were started but not completed. */
  pendingToolUses: ToolUseBlock[]
  /** The index of the interrupted message in the messages array. */
  messageIndex: number
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Load and prepare a conversation for resume.
 *
 * Accepts a source specifier and an optional project directory, resolves
 * the source to a JSONL transcript, loads and cleans the messages, detects
 * interrupted turns, and returns everything the agent needs to continue.
 *
 * @param source     - What to resume: `'last'`, a session ID, a file path,
 *                     or pre-loaded data.
 * @param projectDir - Root directory of the project (used to resolve paths).
 *                     Defaults to `process.cwd()`.
 * @param checkpoint - Optional resume checkpoint for consistency verification.
 * @returns A {@link RecoveryResult} with cleaned messages and metadata.
 *
 * @example
 * ```typescript
 * // Resume the most recent session
 * const result = await loadConversationForResume('last', '/home/user/project')
 *
 * // Resume a specific session
 * const result = await loadConversationForResume('abc-123-def', '/home/user/project')
 *
 * // Resume from a file path
 * const result = await loadConversationForResume('/path/to/session.jsonl')
 * ```
 */
export async function loadConversationForResume(
  source: ResumeSource | PreloadedTranscriptData,
  projectDir: string = process.cwd(),
  checkpoint?: ResumeCheckpoint,
): Promise<RecoveryResult> {
  const warnings: string[] = []
  const errors: string[] = []

  // ---- Step 1: Resolve source to transcript data ----
  let transcriptData: PreloadedTranscriptData
  let sessionId: string

  try {
    if (typeof source === 'object' && source !== null && 'messages' in source) {
      // Pre-loaded data path.
      transcriptData = source as PreloadedTranscriptData
      sessionId = extractSessionIdFromData(transcriptData)
    } else {
      const resolvedSource = source as ResumeSource
      const filePath = await resolveSourceToPath(resolvedSource, projectDir)
      sessionId = extractSessionIdFromPath(filePath)

      // ---- Step 2: Load transcript ----
      const loadResult = await loadTranscriptFile(filePath)

      // Build the main conversation chain from the loaded messages.
      let chain = buildConversationChain(loadResult.messages, loadResult.leafUuid)

      // Reattach orphaned parallel tool results.
      const { chain: repairedChain, remainingOrphans } =
        recoverOrphanedParallelToolResults(chain, loadResult.orphanedMessages)
      chain = repairedChain

      if (remainingOrphans.length > 0) {
        warnings.push(
          `${remainingOrphans.length} orphaned message(s) could not be reattached ` +
          `and will be excluded from the resumed conversation.`,
        )
      }

      transcriptData = {
        messages: chain,
        metadata: loadResult.metadata,
        filePath: loadResult.filePath,
        summary: loadResult.summary,
        allEntries: loadResult.allEntries,
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      messages: [],
      metadata: {},
      sessionId: '',
      fileHistory: [],
      interruptedTurnState: null,
      consistencyCheck: null,
      warnings,
      errors: [...errors, `Failed to load conversation: ${message}`],
    }
  }

  // ---- Step 3: Copy plan and file history ----
  const fileHistory = extractFileHistory(transcriptData)
  const planData = extractPlanData(transcriptData)

  if (planData) {
    warnings.push('Recovered plan data from prior session.')
  }

  // ---- Step 4: Resume consistency check ----
  let consistencyCheck: ResumeConsistencyResult | null = null

  if (checkpoint) {
    consistencyCheck = checkResumeConsistency(transcriptData.messages, checkpoint)

    if (!consistencyCheck.isConsistent) {
      if (consistencyCheck.isRecoverable) {
        warnings.push(
          `Resume consistency warning: ${consistencyCheck.reason}`,
        )
      } else {
        errors.push(
          `Resume consistency failure: ${consistencyCheck.reason}`,
        )
        // Return early with the error -- the transcript is not safe to resume.
        return {
          messages: [],
          metadata: transcriptData.metadata,
          sessionId,
          fileHistory,
          interruptedTurnState: null,
          consistencyCheck,
          warnings,
          errors,
        }
      }
    }
  }

  // ---- Step 5: Filter invalid messages ----
  const { messages: cleanedMessages, removedCount } = filterInvalidMessages(
    transcriptData.messages,
  )

  if (removedCount > 0) {
    warnings.push(
      `Removed ${removedCount} invalid message(s) during recovery ` +
      `(orphaned tool_uses, blank assistants, unresolved tool uses).`,
    )
  }

  // ---- Step 6: Detect interrupted turns ----
  const interruptedTurnState = detectInterruptedTurn(cleanedMessages)
  let finalMessages = cleanedMessages

  if (interruptedTurnState) {
    warnings.push(
      'Detected an interrupted assistant turn. A continuation prompt ' +
      'has been injected to resume from where the agent left off.',
    )

    // Inject a continuation message after the interrupted turn.
    const continuationMessage: Message = {
      id: `resume-${Date.now()}`,
      uuid: `resume-${Date.now()}`,
      role: 'user',
      content: buildContinuationPrompt(interruptedTurnState),
      timestamp: Date.now(),
    }

    finalMessages = [...cleanedMessages, continuationMessage]
  }

  // ---- Step 7: Return ----
  return {
    messages: finalMessages,
    metadata: transcriptData.metadata,
    sessionId,
    fileHistory,
    interruptedTurnState,
    consistencyCheck,
    summary: transcriptData.summary,
    warnings,
    errors,
  }
}

// ============================================================
// Source Resolution
// ============================================================

/**
 * Resolve a resume source specifier to an absolute JSONL file path.
 *
 * @param source     - `'last'`, a session ID, or an absolute file path.
 * @param projectDir - Project root directory.
 * @returns Absolute path to the transcript file.
 * @throws When the source cannot be resolved.
 */
async function resolveSourceToPath(
  source: ResumeSource,
  projectDir: string,
): Promise<string> {
  // ---- File path ----
  if (source.endsWith('.jsonl')) {
    return resolve(source)
  }

  // ---- 'last' -- find the most recent session ----
  if (source === 'last') {
    return findMostRecentSession(projectDir)
  }

  // ---- Session ID ----
  // Assume it's a session ID and construct the transcript path.
  return getTranscriptPath(source, projectDir)
}

/**
 * Find the most recently modified `.jsonl` transcript file in the project
 * directory.
 *
 * Scans the directory for JSONL files and returns the one with the latest
 * modification timestamp.  Ignores sidechain files (those matching the
 * `*-agent-*.jsonl` pattern).
 *
 * @param projectDir - Project root directory.
 * @returns Absolute path to the most recent transcript file.
 * @throws When no transcript files are found.
 */
async function findMostRecentSession(projectDir: string): Promise<string> {
  // Sessions are stored in .cc-agent/sessions/ subdirectory.
  const resolvedDir = resolve(projectDir, '.cc-agent', 'sessions')

  let entries: string[]
  try {
    entries = await readdir(resolvedDir)
  } catch {
    throw new Error(
      `Cannot read sessions directory "${resolvedDir}" to find the most recent session.`,
    )
  }

  // Filter for main-chain JSONL files (exclude sidechains).
  const jsonlFiles = entries.filter(
    (f) => f.endsWith('.jsonl') && !f.includes('-agent-'),
  )

  if (jsonlFiles.length === 0) {
    throw new Error(
      `No session transcript files found in "${resolvedDir}". ` +
      `Start a new conversation or specify a session ID.`,
    )
  }

  // Sort by modification time (most recent first).
  const { stat } = await import('node:fs/promises')
  const fileStats = await Promise.all(
    jsonlFiles.map(async (file) => {
      const filePath = join(resolvedDir, file)
      const fileStat = await stat(filePath)
      return { filePath, mtimeMs: fileStat.mtimeMs }
    }),
  )

  fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return fileStats[0]!.filePath
}

// ============================================================
// Message Filtering
// ============================================================

/**
 * Filter invalid messages from a recovered conversation.
 *
 * Removes:
 *  - **Orphaned tool_use blocks**: assistant messages containing tool_use
 *    blocks whose corresponding tool_result blocks are missing.
 *  - **Blank assistant messages**: assistant messages with empty or
 *    whitespace-only text content and no other block types.
 *  - **Unresolved tool_result references**: user messages containing
 *    tool_result blocks that reference non-existent tool_use IDs.
 *
 * The filtering is non-destructive -- the original array is not mutated.
 *
 * @param messages - Raw messages from the transcript.
 * @returns Cleaned messages and the count of removed entries.
 */
export function filterInvalidMessages(
  messages: TranscriptMessage[] | Message[],
): { messages: Message[]; removedCount: number } {
  if (messages.length === 0) {
    return { messages: [], removedCount: 0 }
  }

  // ---- Phase 1: Collect all tool_use IDs present in the conversation ----
  const allToolUseIds = new Set<string>()
  const allToolResultIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if (isToolUseBlock(block)) {
        allToolUseIds.add(block.id)
      }
      if (isToolResultBlock(block)) {
        allToolResultIds.add(block.tool_use_id)
      }
    }
  }

  // ---- Phase 2: Filter messages ----
  const filtered: Message[] = []
  let removedCount = 0

  for (const msg of messages) {
    // ---- Handle string content ----
    if (typeof msg.content === 'string') {
      // Check for blank assistant messages.
      if (msg.role === 'assistant' && msg.content.trim().length === 0) {
        removedCount++
        continue
      }
      filtered.push(msg)
      continue
    }

    // ---- Handle array content ----
    if (!Array.isArray(msg.content)) {
      filtered.push(msg)
      continue
    }

    const cleanedBlocks: ContentBlock[] = []

    for (const block of msg.content) {
      if (isToolUseBlock(block)) {
        // Keep tool_use blocks only if a matching tool_result exists.
        if (allToolResultIds.has(block.id)) {
          cleanedBlocks.push(block)
        }
        // Orphaned tool_use: silently drop.
        continue
      }

      if (isToolResultBlock(block)) {
        // Keep tool_result blocks only if a matching tool_use exists.
        if (allToolUseIds.has(block.tool_use_id)) {
          cleanedBlocks.push(block)
        }
        // Unresolved tool_result: silently drop.
        continue
      }

      // All other block types pass through.
      cleanedBlocks.push(block)
    }

    // ---- Evaluate the cleaned message ----
    if (cleanedBlocks.length === 0) {
      // Message became empty after filtering -- remove it.
      removedCount++
      continue
    }

    // Check for blank assistant messages (only text blocks, all empty).
    if (msg.role === 'assistant') {
      const hasNonEmptyContent = cleanedBlocks.some((block) => {
        if (block.type === 'text') {
          return (block as { text: string }).text.trim().length > 0
        }
        return true  // Non-text blocks are always "non-empty".
      })

      if (!hasNonEmptyContent) {
        removedCount++
        continue
      }
    }

    filtered.push({
      ...msg,
      content: cleanedBlocks,
    })
  }

  return { messages: filtered, removedCount }
}

// ============================================================
// Interrupted Turn Detection
// ============================================================

/**
 * Detect whether the last assistant turn was interrupted (incomplete).
 *
 * An interrupted turn is characterized by:
 *  - The last message is an assistant message containing tool_use blocks.
 *  - No subsequent user message contains tool_result blocks for those
 *    tool_uses (i.e., the tools were never executed or their results were
 *    lost).
 *
 * When an interrupted turn is detected, the recovery pipeline injects a
 * "Continue from where you left off" message so the model can resume.
 *
 * @param messages - Cleaned conversation messages.
 * @returns Interrupted turn state, or `null` if the last turn was complete.
 */
export function detectInterruptedTurn(
  messages: Message[],
): InterruptedTurnState | null {
  if (messages.length === 0) return null

  // ---- Find the last assistant message ----
  let lastAssistantIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }

  if (lastAssistantIndex === -1) return null

  const lastAssistant = messages[lastAssistantIndex]!

  // ---- Check if it contains tool_use blocks ----
  if (typeof lastAssistant.content === 'string') {
    // Pure text assistant message -- not interrupted (the model finished
    // its turn without requesting tools).
    return null
  }

  if (!Array.isArray(lastAssistant.content)) return null

  const toolUseBlocks = lastAssistant.content.filter(
    (block): block is ToolUseBlock => isToolUseBlock(block),
  )

  if (toolUseBlocks.length === 0) {
    // No tool calls -- the assistant completed its turn normally.
    return null
  }

  // ---- Check if any subsequent messages contain tool_results for these uses ----
  const toolUseIds = new Set(toolUseBlocks.map((tu) => tu.id))
  let hasResults = false

  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i]!
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if (isToolResultBlock(block) && toolUseIds.has(block.tool_use_id)) {
        hasResults = true
        break
      }
    }

    if (hasResults) break
  }

  if (hasResults) {
    // All tool uses have results -- the turn completed normally.
    return null
  }

  // ---- Interrupted turn detected ----
  // Find which tool uses are still pending (no results at all).
  const allResultIds = new Set<string>()
  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i]!
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (isToolResultBlock(block)) {
        allResultIds.add(block.tool_use_id)
      }
    }
  }

  const pendingToolUses = toolUseBlocks.filter((tu) => !allResultIds.has(tu.id))

  return {
    partialMessage: lastAssistant,
    pendingToolUses,
    messageIndex: lastAssistantIndex,
  }
}

// ============================================================
// Continuation Prompt Builder
// ============================================================

/**
 * Build a user message that prompts the model to continue from where it
 * left off after an interrupted turn.
 *
 * The prompt includes:
 *  - The names and inputs of pending tool calls.
 *  - An instruction to continue execution.
 *
 * @param state - The interrupted turn state.
 * @returns A user message content string.
 */
function buildContinuationPrompt(state: InterruptedTurnState): string {
  const lines: string[] = [
    'Your previous response was interrupted before all tool calls could be ' +
    'completed. Please continue from where you left off.',
    '',
  ]

  if (state.pendingToolUses.length > 0) {
    lines.push('The following tool calls were initiated but not completed:')
    lines.push('')

    for (const tu of state.pendingToolUses) {
      const inputSummary = JSON.stringify(tu.input).slice(0, 200)
      lines.push(`- **${tu.name}**: ${inputSummary}`)
    }

    lines.push('')
    lines.push(
      'Please re-execute these tool calls and continue with the rest of ' +
      'your plan.',
    )
  } else {
    lines.push(
      'Please review what you were doing and continue with the next step.',
    )
  }

  return lines.join('\n')
}

// ============================================================
// File History Extraction
// ============================================================

/**
 * Extract file paths that were read or written during the prior session.
 *
 * Scans tool_use blocks for file-related tools (FileRead, FileEdit, Bash)
 * and extracts path arguments.  This gives the resumed agent awareness of
 * which files were recently touched.
 *
 * @param data - Pre-loaded transcript data.
 * @returns Array of unique file paths referenced during the session.
 */
function extractFileHistory(data: PreloadedTranscriptData): string[] {
  const paths = new Set<string>()

  for (const msg of data.messages) {
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if (!isToolUseBlock(block)) continue

      // Extract paths from known file-related tools.
      const input = block.input as Record<string, unknown>

      switch (block.name) {
        case 'FileRead':
        case 'FileEdit':
        case 'FileWrite':
          if (typeof input.file_path === 'string') {
            paths.add(input.file_path)
          }
          if (typeof input.path === 'string') {
            paths.add(input.path)
          }
          break

        case 'Glob':
        case 'Grep':
          if (typeof input.path === 'string') {
            paths.add(input.path)
          }
          break
      }
    }
  }

  return Array.from(paths)
}

// ============================================================
// Plan Data Extraction
// ============================================================

/**
 * Extract plan data from the prior session, if any was persisted.
 *
 * Plan data is stored in system or meta messages with a specific marker.
 * This is a simplified implementation that looks for plan-like content
 * in system messages.
 *
 * @param data - Pre-loaded transcript data.
 * @returns Plan data string, or `null` if no plan was found.
 */
function extractPlanData(data: PreloadedTranscriptData): string | null {
  // Look for system messages that contain plan data.
  for (const msg of data.messages) {
    if (msg.role !== 'system') continue
    if (typeof msg.content !== 'string') continue

    // Simple heuristic: system messages containing "plan" markers.
    if (
      msg.content.includes('[Plan]') ||
      msg.content.includes('<plan>') ||
      msg.isMeta
    ) {
      return msg.content
    }
  }

  // Also check entries for plan metadata.
  if (data.allEntries) {
    for (const entry of data.allEntries) {
      if (entry.type === 'system' && 'content' in entry) {
        const content = (entry as TranscriptEntry).content
        if (
          typeof content === 'string' &&
          (content.includes('[Plan]') || content.includes('<plan>'))
        ) {
          return content
        }
      }
    }
  }

  return null
}

// ============================================================
// Session ID Extraction Helpers
// ============================================================

/**
 * Extract a session ID from pre-loaded transcript data.
 */
function extractSessionIdFromData(data: PreloadedTranscriptData): string {
  // Try to extract from the first message's metadata.
  if (data.messages.length > 0) {
    const firstMsg = data.messages[0]! as SessionEntryLike
    if (firstMsg.sessionId) return firstMsg.sessionId
  }

  // Fall back to extracting from the file path.
  return extractSessionIdFromPath(data.filePath)
}

/**
 * Extract a session ID from a file path.
 *
 * Handles both main paths (`<sessionId>.jsonl`) and sidechain paths
 * (`<sessionId>-agent-<agentId>.jsonl`).
 */
function extractSessionIdFromPath(filePath: string): string {
  const basename =
    filePath.split('/').pop() ?? filePath.split('\\').pop() ?? ''
  const withoutExt = basename.replace(/\.jsonl$/, '')
  const agentIdx = withoutExt.indexOf('-agent-')
  if (agentIdx >= 0) return withoutExt.slice(0, agentIdx)
  return withoutExt
}

// ============================================================
// Type Guards
// ============================================================

interface SessionEntryLike {
  sessionId?: string
}

/**
 * Type guard: checks if a content block is a tool_use block.
 */
function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
}

/**
 * Type guard: checks if a content block is a tool_result block.
 */
function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}
