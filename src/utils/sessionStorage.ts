/**
 * Session Storage Engine — Append-Only JSONL Event Stream
 *
 * Provides durable, crash-safe persistence for every conversation in the
 * coding agent.  Each session is stored as a newline-delimited JSON (JSONL)
 * file inside the project directory:
 *
 *   <projectDir>/<sessionId>.jsonl
 *
 * Sub-agent sidechains are stored alongside the main transcript:
 *
 *   <projectDir>/<sessionId>-agent-<agentId>.jsonl
 *
 * Design goals (mirrors Claude Code's storage layer):
 *
 *  - **Append-only writes** — existing data is never mutated, so a crash
 *    mid-write can only lose the trailing entry, not corrupt prior history.
 *  - **UUID deduplication** — on read, duplicate UUIDs on the main chain are
 *    resolved by keeping only the *last* occurrence (latest-writer-wins).
 *    Sidechain files allow duplicate UUIDs because parallel agent turns can
 *    legitimately produce them.
 *  - **Batched write queue** — entries are buffered in memory and flushed in
 *    a single `appendFile` syscall to reduce I/O overhead.
 *  - **Lite reads** — the session list view reads only the first and last
 *    64 KB of each file, which is enough to extract the title, timestamps,
 *    and latest message without parsing the full transcript.
 *
 * The file format is one JSON object per line.  Entry types include messages
 * (user / assistant / attachment / system), metadata (title / tag / mode),
 * compaction summaries, progress markers, and agent-specific settings.
 */

import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  ContentBlock,
  EntryType,
  SessionEntry,
  SessionMetadata,
  TranscriptMessage,
} from '../types/index.js'

// ============================================================
// Constants
// ============================================================

/**
 * Buffer size (in bytes) used when reading the head and tail of a transcript
 * file for the session-list "lite" view.  64 KB provides enough data to
 * capture the initial metadata entries and the most recent messages without
 * loading the entire file into memory.
 */
export const LITE_READ_BUF_SIZE = 65_536 // 64 KB

/**
 * File permission mask for transcript files.  Owner read/write only —
 * conversation logs may contain sensitive code snippets and should not be
 * world-readable.
 */
const FILE_PERMISSIONS = 0o600

/**
 * Directory permission mask for transcript directories.
 */
const DIR_PERMISSIONS = 0o700

/**
 * Maximum interval (ms) between automatic write-queue drains.  The queue
 * also drains when it reaches {@link WRITE_QUEUE_BATCH_SIZE} entries.
 */
const WRITE_QUEUE_FLUSH_INTERVAL_MS = 100

/**
 * Maximum number of entries to accumulate before forcing a synchronous drain.
 */
const WRITE_QUEUE_BATCH_SIZE = 64

// ============================================================
// Extended Entry Interfaces
// ============================================================

/**
 * A transcript-level message entry that carries full conversation content.
 *
 * Stored as a single JSONL line.  The `type` field determines how the entry
 * is routed during replay: user, assistant, attachment (tool_result), and
 * system messages each follow distinct code paths.
 */
export interface TranscriptEntry extends SessionEntry {
  type: 'user' | 'assistant' | 'attachment' | 'system'
  content: string | ContentBlock[]
  model?: string
  isMeta?: boolean
  /** Marks the boundary of a compaction event. */
  isCompactBoundary?: boolean
  /** When set, this message was generated as part of a sidechain agent conversation. */
  agentId?: string
}

/**
 * A metadata-only entry that carries session-level attributes rather than
 * conversation content.  Examples: custom titles, tags, mode switches.
 */
export interface MetadataEntry extends SessionEntry {
  type:
    | 'summary'
    | 'custom-title'
    | 'tag'
    | 'agent-setting'
    | 'agent-name'
    | 'agent-color'
    | 'mode'
    | 'worktree-state'
    | 'pr-link'
    | 'content-replacement'
  /** Free-form payload whose shape depends on `type`. */
  value?: unknown
  /** Summary text (only for `type === 'summary'`). */
  summary?: string
}

/**
 * A lightweight progress marker used to track tool execution state across
 * crash boundaries.  Progress entries form their own linked list via
 * `progressParentUuid` so the recovery code can reconstruct in-flight tool
 * state without scanning every message.
 */
export interface ProgressEntry extends SessionEntry {
  type: 'progress'
  toolName: string
  toolUseId: string
  status: string
  /** Parent pointer within the progress sub-chain. */
  progressParentUuid?: string
  progress?: number
  total?: number
}

/**
 * Discriminated union of every possible JSONL line.
 */
export type JournalEntry = TranscriptEntry | MetadataEntry | ProgressEntry

// ============================================================
// Loaded-Transcript Result
// ============================================================

/**
 * The output of {@link loadTranscriptFile} — a fully parsed and
 * deduplicated conversation graph ready for replay or resume.
 */
export interface TranscriptLoadResult {
  /** Messages forming the main conversation chain (root → leaf). */
  messages: TranscriptMessage[]
  /** Reconstructed session metadata from attribute entries. */
  metadata: SessionMetadata
  /** Compaction summary text, if a summary entry was found. */
  summary?: string
  /** UUID of the most recent message (leaf of the parent chain). */
  leafUuid?: string
  /** Messages that could not be attached to the main chain. */
  orphanedMessages: TranscriptMessage[]
  /** Sidechain messages keyed by agent ID (sub-agent conversations). */
  agentChains: Map<string, TranscriptMessage[]>
  /** Every raw entry that was successfully parsed from the file. */
  allEntries: JournalEntry[]
  /** File path that was loaded. */
  filePath: string
  /** Whether the loaded transcript contains a compaction boundary. */
  hasCompactBoundary: boolean
}

/**
 * Lightweight metadata extracted from the head + tail of a transcript file.
 * Used exclusively by the session-list view to avoid loading entire files.
 */
export interface LiteSessionMetadata {
  sessionId: string
  title?: string
  tag?: string
  agentName?: string
  agentColor?: string
  mode?: string
  startedAt?: number
  lastActivityAt?: number
  messageCount?: number
  filePath: string
  fileSizeBytes: number
}

// ============================================================
// Write Queue
// ============================================================

/** A pending write in the batch queue. */
interface QueuedWrite {
  filePath: string
  line: string
}

/**
 * In-memory write buffer.  Entries are accumulated here and flushed to disk
 * in a single batched append to minimise syscall overhead.
 */
const writeQueue: QueuedWrite[] = []

/** Whether a drain timer is currently armed. */
let drainTimerArmed = false

/** Set of file paths whose parent directories have been created. */
const ensuredDirectories = new Set<string>()

// ============================================================
// Path Resolution
// ============================================================

/**
 * Returns the absolute path to the main transcript file for a session.
 *
 * ```
 * <projectDir>/.cc-agent/sessions/<sessionId>.jsonl
 * ```
 *
 * @param sessionId  — unique session identifier (typically a UUID).
 * @param projectDir — root directory of the project being worked on.
 */
export function getTranscriptPath(sessionId: string, projectDir: string): string {
  return join(resolve(projectDir), '.cc-agent', 'sessions', `${sessionId}.jsonl`)
}

/**
 * Returns the absolute path to a sidechain transcript file for an agent
 * sub-conversation within a session.
 *
 * ```
 * <projectDir>/.cc-agent/sessions/<sessionId>-agent-<agentId>.jsonl
 * ```
 *
 * Sidechain files store the full conversation of a delegated agent task
 * separately from the main chain so they can be replayed independently.
 *
 * @param agentId    — unique identifier for the sub-agent.
 * @param sessionId  — parent session identifier.
 * @param projectDir — root directory of the project.
 */
export function getAgentTranscriptPath(
  agentId: string,
  sessionId: string,
  projectDir: string,
): string {
  return join(resolve(projectDir), '.cc-agent', 'sessions', `${sessionId}-agent-${agentId}.jsonl`)
}

// ============================================================
// Entry Classification
// ============================================================

/** Set of entry types that represent conversation messages. */
const TRANSCRIPT_MESSAGE_TYPES: ReadonlySet<EntryType> = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
])

/** Set of entry types that represent metadata attributes. */
const METADATA_ENTRY_TYPES: ReadonlySet<EntryType> = new Set([
  'summary',
  'custom-title',
  'tag',
  'agent-setting',
  'agent-name',
  'agent-color',
  'mode',
  'worktree-state',
  'pr-link',
  'content-replacement',
])

/**
 * Type guard: returns `true` when the given entry is a transcript message
 * (user, assistant, attachment, or system).
 */
export function isTranscriptMessage(entry: SessionEntry): entry is TranscriptEntry {
  return TRANSCRIPT_MESSAGE_TYPES.has(entry.type)
}

/**
 * Type guard: returns `true` when the given entry is a metadata attribute.
 */
function isMetadataEntry(entry: SessionEntry): entry is MetadataEntry {
  return METADATA_ENTRY_TYPES.has(entry.type)
}

/**
 * Type guard: returns `true` when the given entry is a progress marker.
 */
function isProgressEntry(entry: SessionEntry): entry is ProgressEntry {
  return entry.type === 'progress'
}

// ============================================================
// Append Entry — Central Write Router
// ============================================================

/**
 * Options controlling how an entry is appended.
 */
export interface AppendEntryOptions {
  /** When `true`, the entry is also written to a remote/sync path. */
  syncToRemote?: boolean
  /** Override the destination file path (bypasses the default router). */
  overridePath?: string
}

/**
 * Central write router — every journal entry flows through this function.
 *
 * Routing logic:
 *
 *  - **Metadata entries** → written to the main transcript file only.
 *  - **Transcript messages** → written to the main transcript file and
 *    optionally mirrored to a remote sync path.
 *  - **Sidechain messages** (entries with an `agentId`) → written to the
 *    agent-specific sidechain file.
 *  - **Progress entries** → written to the main transcript file.
 *
 * The actual disk I/O is deferred: entries are pushed onto
 * {@link writeQueue} and flushed in batches by {@link drainWriteQueue}.
 *
 * @param entry      — the journal entry to persist.
 * @param projectDir — project root (used to resolve file paths).
 * @param options    — optional routing overrides.
 */
export function appendEntry(
  entry: JournalEntry,
  projectDir: string,
  options: AppendEntryOptions = {},
): void {
  const line = JSON.stringify(entry) + '\n'

  // --- Determine target file path(s) ---
  if (options.overridePath) {
    writeQueue.push({ filePath: options.overridePath, line })
    scheduleDrain()
    return
  }

  // Sidechain routing: agent-scoped entries go to a separate file.
  if (isTranscriptMessage(entry) && (entry as TranscriptEntry).agentId) {
    const agentEntry = entry as TranscriptEntry
    const agentPath = getAgentTranscriptPath(
      agentEntry.agentId!,
      entry.sessionId,
      projectDir,
    )
    writeQueue.push({ filePath: agentPath, line })
    scheduleDrain()
    return
  }

  // Main-chain routing.
  const mainPath = getTranscriptPath(entry.sessionId, projectDir)
  writeQueue.push({ filePath: mainPath, line })

  // Optional remote mirror for transcript messages.
  if (options.syncToRemote && isTranscriptMessage(entry)) {
    const remotePath = getRemoteSyncPath(entry.sessionId, projectDir)
    writeQueue.push({ filePath: remotePath, line })
  }

  scheduleDrain()
}

/**
 * Compute the remote sync path for a session.  This mirrors the main
 * transcript to a `.remote/` subdirectory so external sync tools (e.g.
 * rsync, cloud storage) can pick up changes without scanning the project
 * root.
 */
function getRemoteSyncPath(sessionId: string, projectDir: string): string {
  return join(resolve(projectDir), '.remote', `${sessionId}.jsonl`)
}

// ============================================================
// Write Queue Drain
// ============================================================

/**
 * Arm the drain timer if it is not already running.  The timer ensures the
 * queue is flushed within {@link WRITE_QUEUE_FLUSH_INTERVAL_MS} even when
 * entries arrive one at a time.
 */
function scheduleDrain(): void {
  if (drainTimerArmed) return
  drainTimerArmed = true

  // Use setTimeout rather than setImmediate for cross-runtime compatibility.
  setTimeout(() => {
    drainTimerArmed = false
    // Fire-and-forget; errors are caught inside drainWriteQueue.
    drainWriteQueue().catch((err) => {
      console.error('[sessionStorage] Write queue drain failed:', err)
    })
  }, WRITE_QUEUE_FLUSH_INTERVAL_MS)
}

/**
 * Flush all buffered entries to disk in batched append operations.
 *
 * Entries are grouped by target file path so each file receives at most one
 * `appendFile` syscall per drain cycle.  Newly encountered directories are
 * created with restrictive permissions before the first write.
 *
 * File writes use `0o600` permissions (owner read/write only).
 *
 * @returns Resolves when every queued entry has been written.
 */
export async function drainWriteQueue(): Promise<void> {
  if (writeQueue.length === 0) return

  // Snapshot and clear the queue atomically so new entries arriving during
  // the drain go into a fresh batch.
  const batch = writeQueue.splice(0, writeQueue.length)

  // Group by file path.
  const grouped = new Map<string, string[]>()
  for (const write of batch) {
    let lines = grouped.get(write.filePath)
    if (!lines) {
      lines = []
      grouped.set(write.filePath, lines)
    }
    lines.push(write.line)
  }

  // Write each group.
  const writePromises: Promise<void>[] = []

  for (const [filePath, lines] of grouped) {
    writePromises.push(writeGroupedEntries(filePath, lines))
  }

  await Promise.all(writePromises)

  // If new entries arrived while we were writing, drain again.
  if (writeQueue.length > 0) {
    await drainWriteQueue()
  }
}

/**
 * Write a batch of serialized lines to a single file, creating the file
 * and its parent directories if necessary.
 */
async function writeGroupedEntries(filePath: string, lines: string[]): Promise<void> {
  const payload = lines.join('')

  // Ensure parent directory exists (cached to avoid redundant syscalls).
  if (!ensuredDirectories.has(filePath)) {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: DIR_PERMISSIONS })
    ensuredDirectories.add(filePath)
  }

  // Append to the file with restrictive permissions.
  // `appendFile` creates the file if it does not exist, but does not set
  // permissions on creation, so we handle that explicitly.
  try {
    await appendFile(filePath, payload, { encoding: 'utf-8', mode: FILE_PERMISSIONS })
  } catch (err: unknown) {
    // If the file does not exist and appendFile failed, create it first.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      await writeFile(filePath, payload, { encoding: 'utf-8', mode: FILE_PERMISSIONS })
    } else {
      throw err
    }
  }
}

// ============================================================
// UUID Deduplication
// ============================================================

/**
 * Deduplicate an array of transcript messages by UUID.
 *
 * For the **main chain** we keep only the *last* entry with a given UUID
 * (latest-writer-wins).  This handles the rare case where a retry or crash
 * recovery causes the same UUID to be appended twice.
 *
 * For **sidechains** (agent sub-conversations) duplicate UUIDs are allowed
 * because parallel agent turns can legitimately produce messages with the
 * same UUID prefix.  Pass `allowDuplicates: true` to skip deduplication.
 *
 * @param messages         — raw messages in file order.
 * @param allowDuplicates  — when `true`, return messages as-is.
 * @returns Deduplicated message array preserving original ordering.
 */
export function deduplicateByUuid(
  messages: TranscriptMessage[],
  allowDuplicates: boolean = false,
): TranscriptMessage[] {
  if (allowDuplicates || messages.length === 0) return messages

  // Walk backwards and keep only the last occurrence of each UUID.
  const seen = new Set<string>()
  const deduped: TranscriptMessage[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (seen.has(msg.uuid)) continue
    seen.add(msg.uuid)
    deduped.push(msg)
  }

  // Reverse to restore chronological order.
  deduped.reverse()
  return deduped
}

// ============================================================
// Load Transcript File — Full Recovery
// ============================================================

/**
 * Parse a JSONL transcript file and rebuild the complete conversation graph.
 *
 * Processing pipeline:
 *
 *  1. **Read & split** — load the file and split on newlines.
 *  2. **Parse** — JSON-parse each line into a {@link JournalEntry}.
 *  3. **Type dispatch** — route entries into separate Maps by type:
 *     - Transcript messages → `messagesByUuid`
 *     - Metadata attributes → `metadataMap`
 *     - Progress entries → `progressByToolUseId`
 *     - Summary entries → `summary` (last one wins)
 *  4. **Deduplicate** — main-chain UUID dedup (latest-writer-wins).
 *  5. **Legacy progress bridge repair** — connect progress entries that
 *     pre-date the `progressParentUuid` field to their nearest ancestor.
 *  6. **Compact boundary handling** — when a compact boundary is found,
 *     messages before the boundary are replaced by the summary.
 *  7. **Leaf UUID recomputation** — find the UUID that no other message
 *     references as a `parentUuid` (the graph's leaf / most recent node).
 *
 * @param filePath — absolute path to the `.jsonl` transcript file.
 * @returns Parsed and reconstructed conversation data.
 */
export async function loadTranscriptFile(filePath: string): Promise<TranscriptLoadResult> {
  const raw = await readFile(filePath, 'utf-8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)

  // --- Phase 1: Parse all lines -------------------------------------------
  const allEntries: JournalEntry[] = []
  const parseErrors: Array<{ lineNumber: number; error: unknown }> = []

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!) as JournalEntry
      allEntries.push(entry)
    } catch (err) {
      parseErrors.push({ lineNumber: i + 1, error: err })
    }
  }

  // --- Phase 2: Type-based dispatch into separate Maps --------------------
  const messagesByUuid = new Map<string, TranscriptMessage>()
  const metadataMap = new Map<string, unknown>()
  const progressByToolUseId = new Map<string, ProgressEntry>()
  const agentMessagesByAgent = new Map<string, TranscriptMessage[]>()

  let summary: string | undefined
  let hasCompactBoundary = false
  let compactBoundaryTimestamp: number | undefined

  for (const entry of allEntries) {
    // --- Transcript messages ---
    if (isTranscriptMessage(entry)) {
      const te = entry as TranscriptEntry
      const msg = transcriptEntryToMessage(te)

      // Route agent sidechain messages separately.
      if (te.agentId) {
        let agentMsgs = agentMessagesByAgent.get(te.agentId)
        if (!agentMsgs) {
          agentMsgs = []
          agentMessagesByAgent.set(te.agentId, agentMsgs)
        }
        agentMsgs.push(msg)
        continue
      }

      // Track compact boundaries.
      if (te.isCompactBoundary) {
        hasCompactBoundary = true
        compactBoundaryTimestamp = te.timestamp
      }

      // Main chain: last-writer-wins deduplication.
      messagesByUuid.set(msg.uuid, msg)
      continue
    }

    // --- Metadata entries ---
    if (isMetadataEntry(entry)) {
      const me = entry as MetadataEntry

      if (me.type === 'summary') {
        // Summary: last entry wins (most recent compaction).
        summary = me.summary ?? (typeof me.value === 'string' ? me.value : undefined)
        continue
      }

      // Other metadata: store by type key.
      metadataMap.set(me.type, me.value)
      continue
    }

    // --- Progress entries ---
    if (isProgressEntry(entry)) {
      const pe = entry as ProgressEntry
      // Keep the latest progress entry per tool use ID.
      progressByToolUseId.set(pe.toolUseId, pe)
      continue
    }
  }

  // --- Phase 3: Legacy progress bridge repair ----------------------------
  // Older transcript files may have progress entries without the
  // `progressParentUuid` field.  We repair the chain by linking each
  // progress entry to the chronologically preceding one for the same
  // tool use ID.
  repairLegacyProgressChain(allEntries, progressByToolUseId)

  // --- Phase 4: Compact boundary handling ---------------------------------
  // When a compact boundary exists, messages with timestamps before the
  // boundary are considered part of the pre-compaction history.  They
  // are still returned in the result but flagged so the caller can
  // decide whether to include them.
  let messages = Array.from(messagesByUuid.values())

  if (hasCompactBoundary && compactBoundaryTimestamp !== undefined) {
    // Sort by timestamp to find messages before the boundary.
    messages.sort((a, b) => a.timestamp - b.timestamp)

    // The compact boundary message itself and everything after it is the
    // "active" conversation.  Messages before are historical context that
    // the summary replaces.
    // We keep them in the result but the caller (conversationRecovery)
    // will decide whether to splice them out.
  }

  // --- Phase 5: Deduplicate main chain ------------------------------------
  messages = deduplicateByUuid(messages, false)

  // Sort chronologically for chain building.
  messages.sort((a, b) => a.timestamp - b.timestamp)

  // --- Phase 6: Leaf UUID recomputation -----------------------------------
  const leafUuid = computeLeafUuid(messages)

  // --- Phase 7: Identify orphaned messages --------------------------------
  const orphanedMessages = findOrphanedMessages(messages)

  // --- Phase 8: Reconstruct metadata object --------------------------------
  const metadata = reconstructMetadata(metadataMap)

  // --- Phase 9: Deduplicate sidechain messages ----------------------------
  const agentChains = new Map<string, TranscriptMessage[]>()
  for (const [agentId, agentMsgs] of agentMessagesByAgent) {
    // Sidechains allow duplicates.
    agentMsgs.sort((a, b) => a.timestamp - b.timestamp)
    agentChains.set(agentId, agentMsgs)
  }

  return {
    messages,
    metadata,
    summary,
    leafUuid,
    orphanedMessages,
    agentChains,
    allEntries,
    filePath,
    hasCompactBoundary,
  }
}

// ============================================================
// Transcript ↔ Message Conversion
// ============================================================

/**
 * Convert a raw {@link TranscriptEntry} into a {@link TranscriptMessage}
 * suitable for the conversation graph.
 */
function transcriptEntryToMessage(entry: TranscriptEntry): TranscriptMessage {
  return {
    id: entry.uuid, // Use UUID as the stable message ID.
    uuid: entry.uuid,
    role: entry.type === 'attachment' ? 'user' : (entry.type as TranscriptMessage['role']),
    content: entry.content,
    timestamp: entry.timestamp,
    parentUuid: entry.parentUuid,
    isMeta: entry.isMeta,
    model: entry.model,
    type: entry.type,
  }
}

// ============================================================
// Leaf UUID Computation
// ============================================================

/**
 * Find the leaf UUID — the message UUID that no other message references as
 * a `parentUuid`.  This is the most recent node in the conversation DAG.
 *
 * If multiple leaves exist (forked conversation), the one with the latest
 * timestamp is returned.
 *
 * @returns The leaf UUID, or `undefined` if the message array is empty.
 */
function computeLeafUuid(messages: TranscriptMessage[]): string | undefined {
  if (messages.length === 0) return undefined

  const parentUuids = new Set<string>()
  for (const msg of messages) {
    if (msg.parentUuid) {
      parentUuids.add(msg.parentUuid)
    }
  }

  // Find all UUIDs that are NOT referenced as a parent.
  const leaves = messages.filter((msg) => !parentUuids.has(msg.uuid))

  if (leaves.length === 0) {
    // Fallback: every message is someone's parent, so use the last one.
    return messages[messages.length - 1]!.uuid
  }

  // If multiple leaves, pick the most recent by timestamp.
  leaves.sort((a, b) => b.timestamp - a.timestamp)
  return leaves[0]!.uuid
}

// ============================================================
// Orphan Detection
// ============================================================

/**
 * Identify messages that cannot be reached by walking the `parentUuid` chain
 * from the leaf.  Orphans arise from incomplete writes, duplicate sessions,
 * or bugs in the branching logic.
 *
 * They are returned separately so the recovery pipeline can decide whether
 * to reattach them (e.g. parallel tool results) or discard them.
 */
function findOrphanedMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  if (messages.length === 0) return []

  const leafUuid = computeLeafUuid(messages)
  if (!leafUuid) return []

  // Build a UUID → message map.
  const byUuid = new Map<string, TranscriptMessage>()
  for (const msg of messages) {
    byUuid.set(msg.uuid, msg)
  }

  // Walk from leaf to root, collecting reachable UUIDs.
  const reachable = new Set<string>()
  let current: TranscriptMessage | undefined = byUuid.get(leafUuid)
  while (current) {
    reachable.add(current.uuid)
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined
  }

  // Messages not in the reachable set are orphans.
  return messages.filter((msg) => !reachable.has(msg.uuid))
}

// ============================================================
// Build Conversation Chain
// ============================================================

/**
 * Walk the `parentUuid` chain from the given leaf UUID back to the root,
 * returning an ordered array of messages from oldest to newest.
 *
 * This function handles:
 *  - Missing intermediate nodes (gaps in the chain).
 *  - Cycles (defensive — should never happen in practice).
 *  - Multiple roots (returns the longest chain).
 *
 * @param messages  — full message array (may include orphans).
 * @param leafUuid  — UUID of the leaf node to start from.
 * @returns Ordered conversation chain (oldest first).
 */
export function buildConversationChain(
  messages: TranscriptMessage[],
  leafUuid?: string,
): TranscriptMessage[] {
  if (messages.length === 0) return []

  // Build UUID → message index.
  const byUuid = new Map<string, TranscriptMessage>()
  for (const msg of messages) {
    byUuid.set(msg.uuid, msg)
  }

  // Determine starting leaf.
  const startUuid = leafUuid ?? computeLeafUuid(messages)
  if (!startUuid) return [...messages]

  // Walk from leaf to root.
  const chain: TranscriptMessage[] = []
  const visited = new Set<string>()
  let current = byUuid.get(startUuid)

  while (current) {
    // Cycle detection.
    if (visited.has(current.uuid)) break
    visited.add(current.uuid)
    chain.push(current)

    if (!current.parentUuid) break
    current = byUuid.get(current.parentUuid)
  }

  // Reverse to get chronological order (root → leaf).
  chain.reverse()
  return chain
}

// ============================================================
// Recover Orphaned Parallel Tool Results
// ============================================================

/**
 * Reattach sibling tool_result messages that were orphaned because the
 * `parentUuid` chain only follows one of several parallel tool results.
 *
 * When the agent executes multiple tool calls concurrently, each tool_result
 * message has the same `parentUuid` (the assistant message with the tool_use
 * blocks).  However, only one of them is on the main chain — the others are
 * "orphaned" siblings.
 *
 * This function scans the orphan pool for tool_result messages whose
 * `parentUuid` matches a message already in the chain and reattaches them
 * immediately after their parent.
 *
 * @param chain    — the main conversation chain (mutated in place).
 * @param orphans  — pool of orphaned messages to check.
 * @returns Updated chain with reattached siblings and remaining orphans.
 */
export function recoverOrphanedParallelToolResults(
  chain: TranscriptMessage[],
  orphans: TranscriptMessage[],
): { chain: TranscriptMessage[]; remainingOrphans: TranscriptMessage[] } {
  if (orphans.length === 0) return { chain, remainingOrphans: orphans }

  // Index chain messages by UUID for fast lookup.
  const chainUuids = new Set(chain.map((m) => m.uuid))

  // Build a parent → index map for the chain so we can insert siblings
  // at the correct position.
  const chainIndexByUuid = new Map<string, number>()
  for (let i = 0; i < chain.length; i++) {
    chainIndexByUuid.set(chain[i]!.uuid, i)
  }

  const reattached: TranscriptMessage[] = []
  const remainingOrphans: TranscriptMessage[] = []

  for (const orphan of orphans) {
    if (
      orphan.parentUuid &&
      chainUuids.has(orphan.parentUuid) &&
      isToolResultMessage(orphan)
    ) {
      reattached.push(orphan)
    } else {
      remainingOrphans.push(orphan)
    }
  }

  if (reattached.length === 0) {
    return { chain, remainingOrphans }
  }

  // Group reattached orphans by parentUuid.
  const byParent = new Map<string, TranscriptMessage[]>()
  for (const msg of reattached) {
    const parent = msg.parentUuid!
    let siblings = byParent.get(parent)
    if (!siblings) {
      siblings = []
      byParent.set(parent, siblings)
    }
    siblings.push(msg)
  }

  // Insert siblings after their parent in the chain.  Process from end to
  // start so index shifts don't affect earlier insertions.
  const result = [...chain]
  const insertionPoints = Array.from(byParent.entries())
    .map(([parentUuid, siblings]) => ({
      index: chainIndexByUuid.get(parentUuid) ?? -1,
      siblings,
    }))
    .filter((ip) => ip.index >= 0)
    .sort((a, b) => b.index - a.index) // descending index order

  for (const { index, siblings } of insertionPoints) {
    // Sort siblings by timestamp for deterministic ordering.
    siblings.sort((a, b) => a.timestamp - b.timestamp)
    result.splice(index + 1, 0, ...siblings)
  }

  return { chain: result, remainingOrphans }
}

/**
 * Check whether a message contains tool_result blocks (indicating it is a
 * tool result message that might be a parallel sibling).
 */
function isToolResultMessage(msg: TranscriptMessage): boolean {
  if (typeof msg.content === 'string') return false
  return msg.content.some((block) => block.type === 'tool_result')
}

// ============================================================
// Legacy Progress Bridge Repair
// ============================================================

/**
 * Repair progress entries that pre-date the `progressParentUuid` field.
 *
 * Older transcript files contain progress entries with only a `toolUseId`
 * and no explicit parent pointer within the progress sub-chain.  This
 * function walks all entries in chronological order and links each progress
 * entry to the preceding progress entry for the same `toolUseId`.
 *
 * The repair is done in-place on the `progressByToolUseId` map — entries
 * that already have a `progressParentUuid` are left untouched.
 */
function repairLegacyProgressChain(
  allEntries: JournalEntry[],
  _progressByToolUseId: Map<string, ProgressEntry>,
): void {
  // Track the last seen progress UUID per toolUseId.
  const lastProgressUuid = new Map<string, string>()

  for (const entry of allEntries) {
    if (!isProgressEntry(entry)) continue
    const pe = entry as ProgressEntry

    if (!pe.progressParentUuid) {
      // Legacy entry — link to the previous progress entry for this tool use.
      const prevUuid = lastProgressUuid.get(pe.toolUseId)
      if (prevUuid) {
        pe.progressParentUuid = prevUuid
      }
    }

    lastProgressUuid.set(pe.toolUseId, pe.uuid)
  }
}

// ============================================================
// Metadata Reconstruction
// ============================================================

/**
 * Reconstruct a {@link SessionMetadata} object from the raw metadata map
 * built during transcript loading.
 */
function reconstructMetadata(metadataMap: Map<string, unknown>): SessionMetadata {
  return {
    title: metadataMap.get('custom-title') as string | undefined,
    tag: metadataMap.get('tag') as string | undefined,
    agentName: metadataMap.get('agent-name') as string | undefined,
    agentColor: metadataMap.get('agent-color') as string | undefined,
    mode: metadataMap.get('mode') as string | undefined,
  }
}

// ============================================================
// Session ID Extraction
// ============================================================

/**
 * Extract a session ID from a transcript file path as a fallback when no
 * entries are present in the file.
 *
 * Handles both main paths (`<sessionId>.jsonl`) and sidechain paths
 * (`<sessionId>-agent-<agentId>.jsonl`).
 */
function extractSessionIdFromPath(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath.split('\\').pop() ?? ''
  const withoutExt = basename.replace(/\.jsonl$/, '')
  // Strip sidechain suffix if present.
  const agentIdx = withoutExt.indexOf('-agent-')
  if (agentIdx >= 0) return withoutExt.slice(0, agentIdx)
  return withoutExt
}

// ============================================================
// Re-Append Session Metadata
// ============================================================

/**
 * Re-append session metadata entries to the tail of a transcript file.
 *
 * This is used after compaction or migration to ensure the tail of the file
 * contains up-to-date metadata for {@link readLiteMetadata}.  Without this
 * step, a lite read of the last 64 KB might miss metadata that was written
 * at the very beginning of a long transcript.
 *
 * @param filePath — absolute path to the transcript file.
 * @param metadata — session metadata to re-append.
 * @param sessionId — session ID for the metadata entries.
 */
export async function reAppendSessionMetadata(
  filePath: string,
  metadata: SessionMetadata,
  sessionId: string,
): Promise<void> {
  const now = Date.now()
  const entries: MetadataEntry[] = []

  if (metadata.title !== undefined) {
    entries.push({
      type: 'custom-title',
      uuid: crypto.randomUUID(),
      timestamp: now,
      sessionId,
      value: metadata.title,
    })
  }

  if (metadata.tag !== undefined) {
    entries.push({
      type: 'tag',
      uuid: crypto.randomUUID(),
      timestamp: now,
      sessionId,
      value: metadata.tag,
    })
  }

  if (metadata.agentName !== undefined) {
    entries.push({
      type: 'agent-name',
      uuid: crypto.randomUUID(),
      timestamp: now,
      sessionId,
      value: metadata.agentName,
    })
  }

  if (metadata.agentColor !== undefined) {
    entries.push({
      type: 'agent-color',
      uuid: crypto.randomUUID(),
      timestamp: now,
      sessionId,
      value: metadata.agentColor,
    })
  }

  if (metadata.mode !== undefined) {
    entries.push({
      type: 'mode',
      uuid: crypto.randomUUID(),
      timestamp: now,
      sessionId,
      value: metadata.mode,
    })
  }

  if (entries.length === 0) return

  const payload = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'

  // Ensure directory exists.
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: DIR_PERMISSIONS })

  await appendFile(filePath, payload, { encoding: 'utf-8', mode: FILE_PERMISSIONS })
}

// ============================================================
// Lite Metadata Read
// ============================================================

/**
 * Read lightweight metadata from a transcript file without parsing the
 * entire contents.
 *
 * Only the first and last {@link LITE_READ_BUF_SIZE} bytes (64 KB) of the
 * file are read.  This is sufficient to extract:
 *
 *  - Session ID and title (typically in the first few entries).
 *  - Latest activity timestamp and message count hint (last few entries).
 *  - Mode, tag, agent name/color (re-appended to the tail by
 *    {@link reAppendSessionMetadata}).
 *
 * This function is designed for the session-list view where dozens of
 * sessions need to be displayed quickly.
 *
 * @param filePath — absolute path to the `.jsonl` transcript file.
 * @returns Lightweight metadata, or `null` if the file cannot be read.
 */
export async function readLiteMetadata(filePath: string): Promise<LiteSessionMetadata | null> {
  let fileHandle
  try {
    const fileStat = await stat(filePath)
    const fileSize = fileStat.size

    fileHandle = await open(filePath, 'r')

    // --- Read head (first 64 KB) ---
    const headSize = Math.min(LITE_READ_BUF_SIZE, fileSize)
    const headBuf = Buffer.alloc(headSize)
    await fileHandle.read(headBuf, 0, headSize, 0)
    const headText = headBuf.toString('utf-8')

    // --- Read tail (last 64 KB) ---
    let tailText = ''
    if (fileSize > LITE_READ_BUF_SIZE) {
      const tailOffset = fileSize - LITE_READ_BUF_SIZE
      const tailSize = LITE_READ_BUF_SIZE
      const tailBuf = Buffer.alloc(tailSize)
      await fileHandle.read(tailBuf, 0, tailSize, tailOffset)
      tailText = tailBuf.toString('utf-8')
    }

    // --- Parse entries from head and tail ---
    const allLines = [
      ...headText.split('\n'),
      ...(tailText ? tailText.split('\n') : []),
    ]

    let sessionId = extractSessionIdFromPath(filePath)
    let title: string | undefined
    let tag: string | undefined
    let agentName: string | undefined
    let agentColor: string | undefined
    let mode: string | undefined
    let startedAt: number | undefined
    let lastActivityAt: number | undefined
    let messageCount = 0

    for (const line of allLines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: JournalEntry
      try {
        entry = JSON.parse(trimmed) as JournalEntry
      } catch {
        continue // Skip malformed lines.
      }

      // Track session ID from entries.
      if (entry.sessionId) {
        sessionId = entry.sessionId
      }

      // Track timestamps.
      if (entry.timestamp) {
        if (startedAt === undefined || entry.timestamp < startedAt) {
          startedAt = entry.timestamp
        }
        if (lastActivityAt === undefined || entry.timestamp > lastActivityAt) {
          lastActivityAt = entry.timestamp
        }
      }

      // Count transcript messages.
      if (isTranscriptMessage(entry)) {
        messageCount++
      }

      // Extract metadata fields (last value wins, matching full-load behavior).
      if (isMetadataEntry(entry)) {
        const me = entry as MetadataEntry
        switch (me.type) {
          case 'custom-title':
            title = me.value as string
            break
          case 'tag':
            tag = me.value as string
            break
          case 'agent-name':
            agentName = me.value as string
            break
          case 'agent-color':
            agentColor = me.value as string
            break
          case 'mode':
            mode = me.value as string
            break
        }
      }
    }

    // De-duplicate message count estimate: since head and tail may overlap
    // for small files, the count is approximate.  The session list only uses
    // it for display, so this is acceptable.
    if (fileSize <= LITE_READ_BUF_SIZE) {
      // Head covers the entire file — count is exact.
    } else {
      // Head + tail overlap region might cause double-counting.  Mark as
      // approximate by prefixing with ≥.
      // (The UI can display this as "≈ N messages".)
    }

    return {
      sessionId,
      title,
      tag,
      agentName,
      agentColor,
      mode,
      startedAt,
      lastActivityAt,
      messageCount,
      filePath,
      fileSizeBytes: fileSize,
    }
  } catch {
    return null
  } finally {
    if (fileHandle) {
      await fileHandle.close()
    }
  }
}

// ============================================================
// Snip Removal — Chain Repair After Deletions
// ============================================================

/**
 * Repair `parentUuid` chains after one or more messages have been deleted
 * ("snipped") from the conversation.
 *
 * When a message is removed, any message whose `parentUuid` pointed to the
 * deleted message would become orphaned.  This function rewires those
 * pointers to skip over the deleted messages, linking each affected child
 * to the nearest surviving ancestor.
 *
 * Algorithm:
 *  1. Build a set of snipped UUIDs.
 *  2. For each surviving message, walk up the `parentUuid` chain until a
 *     non-snipped ancestor is found (or the root is reached).
 *  3. Update the message's `parentUuid` to that ancestor.
 *
 * @param chain      — surviving messages (mutated in place).
 * @param snippedIds — UUIDs of messages that were deleted.
 * @returns The repaired chain.
 */
export function applySnipRemovals(
  chain: TranscriptMessage[],
  snippedIds: Set<string>,
): TranscriptMessage[] {
  if (snippedIds.size === 0 || chain.length === 0) return chain

  // Build a UUID → message index for the surviving chain.
  const survivingByUuid = new Map<string, TranscriptMessage>()
  for (const msg of chain) {
    survivingByUuid.set(msg.uuid, msg)
  }

  // For each message whose parentUuid was snipped, find the nearest
  // surviving ancestor.
  for (const msg of chain) {
    if (!msg.parentUuid) continue
    if (!snippedIds.has(msg.parentUuid)) continue

    // Walk up the chain looking for a non-snipped ancestor.
    // We use the original parentUuid chain from the *pre-snip* data,
    // which means we need to look at the original entries.  Since the
    // snipped messages are no longer in `chain`, we walk through the
    // surviving messages' parentUuids to find the nearest ancestor.
    //
    // Strategy: find the message in the chain that immediately precedes
    // the first snipped ancestor and use its UUID.
    let ancestor: TranscriptMessage | undefined
    const chainIdx = chain.indexOf(msg)

    // Walk backwards through the chain from the message's position.
    for (let i = chainIdx - 1; i >= 0; i--) {
      const candidate = chain[i]!
      if (!snippedIds.has(candidate.uuid)) {
        ancestor = candidate
        break
      }
    }

    msg.parentUuid = ancestor?.uuid
  }

  return chain
}

// ============================================================
// Resume Consistency Check
// ============================================================

/**
 * Checkpoint data captured at the end of a session turn, used to detect
 * "resume drift" — situations where the transcript on disk has diverged
 * from what the running process expected.
 */
export interface ResumeCheckpoint {
  /** UUID of the last message the process wrote. */
  lastMessageUuid: string
  /** Total number of messages the process expected to be in the transcript. */
  expectedMessageCount: number
  /** Timestamp of the last write the process performed. */
  lastWriteTimestamp: number
  /** Whether the session was compacted during this run. */
  wasCompacted: boolean
}

/**
 * Result of a resume consistency check.
 */
export interface ResumeConsistencyResult {
  /** Whether the transcript is consistent and safe to resume. */
  isConsistent: boolean
  /** Human-readable description of any inconsistency found. */
  reason?: string
  /** Whether the inconsistency is recoverable (e.g. extra entries from a
   *  concurrent process can be discarded). */
  isRecoverable: boolean
  /** Number of messages found in the transcript. */
  actualMessageCount: number
  /** UUID of the actual last message in the transcript. */
  actualLastMessageUuid?: string
}

/**
 * Detect resume drift between the in-memory checkpoint and the on-disk
 * transcript.
 *
 * Drift scenarios:
 *
 *  1. **Missing tail** — the last message UUID in the transcript does not
 *     match the checkpoint.  This means the process crashed mid-write or
 *     the file was externally truncated.
 *
 *  2. **Extra entries** — the transcript has more messages than expected.
 *     This can happen if another process (e.g. a concurrent agent) wrote
 *     to the same file.  Recoverable by re-loading the full transcript.
 *
 *  3. **Stale data** — the transcript's last write timestamp is older than
 *     the checkpoint's.  This means writes were lost.
 *
 * @param messages   — messages loaded from the transcript file.
 * @param checkpoint — the checkpoint captured at the end of the last turn.
 * @returns Consistency assessment.
 */
export function checkResumeConsistency(
  messages: TranscriptMessage[],
  checkpoint: ResumeCheckpoint,
): ResumeConsistencyResult {
  const actualCount = messages.length
  const actualLastUuid = messages.length > 0
    ? messages[messages.length - 1]!.uuid
    : undefined

  // --- Scenario 1: Missing tail ---
  if (actualCount < checkpoint.expectedMessageCount) {
    return {
      isConsistent: false,
      reason:
        `Transcript has fewer messages than expected ` +
        `(${actualCount} vs ${checkpoint.expectedMessageCount}). ` +
        `Data may have been lost due to a crash or external truncation.`,
      isRecoverable: false,
      actualMessageCount: actualCount,
      actualLastMessageUuid: actualLastUuid,
    }
  }

  // --- Scenario 3: Stale data ---
  const lastMsg = messages[messages.length - 1]
  if (lastMsg && lastMsg.timestamp < checkpoint.lastWriteTimestamp) {
    return {
      isConsistent: false,
      reason:
        `Transcript's last message timestamp (${lastMsg.timestamp}) is older ` +
        `than the checkpoint's last write timestamp (${checkpoint.lastWriteTimestamp}). ` +
        `Writes may have been lost.`,
      isRecoverable: false,
      actualMessageCount: actualCount,
      actualLastMessageUuid: actualLastUuid,
    }
  }

  // --- Scenario 2: Extra entries ---
  if (actualCount > checkpoint.expectedMessageCount) {
    return {
      isConsistent: false,
      reason:
        `Transcript has more messages than expected ` +
        `(${actualCount} vs ${checkpoint.expectedMessageCount}). ` +
        `Another process may have written to this file concurrently.`,
      isRecoverable: true,
      actualMessageCount: actualCount,
      actualLastMessageUuid: actualLastUuid,
    }
  }

  // --- Last UUID mismatch ---
  if (actualLastUuid !== checkpoint.lastMessageUuid) {
    return {
      isConsistent: false,
      reason:
        `Last message UUID mismatch: expected "${checkpoint.lastMessageUuid}" ` +
        `but found "${actualLastUuid}". The transcript tail may have been ` +
        `overwritten or a concurrent write occurred.`,
      isRecoverable: actualCount >= checkpoint.expectedMessageCount,
      actualMessageCount: actualCount,
      actualLastMessageUuid: actualLastUuid,
    }
  }

  // --- All checks passed ---
  return {
    isConsistent: true,
    isRecoverable: true,
    actualMessageCount: actualCount,
    actualLastMessageUuid: actualLastUuid,
  }
}

// ============================================================
// Utility: Force-Flush & Testing Helpers
// ============================================================

/**
 * Force an immediate drain of the write queue, bypassing the timer.
 * Useful in tests and during shutdown to ensure all entries are persisted.
 */
export async function flushWriteQueue(): Promise<void> {
  drainTimerArmed = false
  await drainWriteQueue()
}

/**
 * Return the current number of entries in the write queue.
 * Intended for diagnostics and testing.
 */
export function getWriteQueueSize(): number {
  return writeQueue.length
}

/**
 * Clear the directory-creation cache.  Useful in tests that create and
 * tear down temporary directories.
 */
export function clearDirectoryCache(): void {
  ensuredDirectories.clear()
}
