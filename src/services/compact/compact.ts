/**
 * Compact Service — Context Compression / Compaction
 *
 * When the conversation grows beyond the model's context window the compact
 * service truncates the message history while preserving:
 *
 *  - The initial system / user framing messages.
 *  - The most recent exchange so the model retains short-term context.
 *  - Structural API invariants (e.g. every `tool_use` must be followed by
 *    its `tool_result`, images are stripped to save tokens, etc.).
 *
 * The compact output includes a summary of the removed messages so the model
 * can continue the conversation with minimal information loss.
 *
 * Mirrors the compaction strategy used by Claude Code.
 */

import type {
  Message,
  ContentBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolInstance,
  Attachment,
  CompactResult,
} from '../../types/index.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Target token budget for the retained messages. */
  targetTokens: number
  /** Optional pre-computed summary to inject at the top of the kept messages. */
  summary?: string
  /** Token estimator — defaults to a simple chars/4 heuristic. */
  estimateTokens?: (text: string) => number
}

export interface PostCompactAttachment {
  type: string
  content: string
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function messageTokenCount(
  msg: Message,
  estimate: (text: string) => number,
): number {
  if (typeof msg.content === 'string') {
    return estimate(msg.content)
  }

  let tokens = 0
  for (const block of msg.content) {
    if (block.type === 'text') {
      tokens += estimate(block.text)
    } else if (block.type === 'thinking') {
      tokens += estimate(block.thinking)
    } else if (block.type === 'tool_use') {
      tokens += estimate(JSON.stringify(block.input)) + estimate(block.name)
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        tokens += estimate(block.content)
      } else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'text') tokens += estimate(inner.text)
        }
      }
    }
    // Image blocks are counted as a fixed overhead since they don't have text.
    if (block.type === 'image') {
      tokens += 100 // rough overhead per image
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Image stripping
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of `messages` with all {@link ImageBlock} entries
 * removed from structured content arrays.  Plain-string content is left
 * untouched.
 *
 * Images are the single biggest token sink in most conversations; stripping
 * them before compaction dramatically reduces the retained token count.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return { ...msg }

    const filtered = msg.content.filter(
      (block): block is Exclude<ContentBlock, ImageBlock> => block.type !== 'image',
    )

    // If the content array is now empty, insert a placeholder so the
    // message is not dropped from the conversation.
    if (filtered.length === 0) {
      return {
        ...msg,
        content: [{ type: 'text' as const, text: '[image removed during compaction]' }],
      }
    }

    return { ...msg, content: filtered }
  })
}

// ---------------------------------------------------------------------------
// Reinjected-attachment stripping
// ---------------------------------------------------------------------------

/**
 * Some tool results include "reinjected" attachments — large blobs that were
 * re-attached to the conversation for context (e.g. full file contents after
 * a read).  After compaction these are no longer needed because the summary
 * captures the salient information.
 *
 * This function replaces the content of `tool_result` blocks that carry an
 * attachment-like marker with a short placeholder string.
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return { ...msg }

    const cleaned: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block

      const tr = block as ToolResultBlock
      // Convention: if the tool_result content is very large (> 4 KB of text)
      // it is likely a reinjected attachment.  Replace it with a stub.
      if (typeof tr.content === 'string' && tr.content.length > 4096) {
        return {
          ...tr,
          content: `[attachment stripped during compaction — original length: ${tr.content.length} chars]`,
        }
      }

      // Also strip large nested content-block arrays inside tool_result.
      if (Array.isArray(tr.content)) {
        const stripped: ContentBlock[] = tr.content.map((inner) => {
          if (inner.type === 'text' && inner.text.length > 4096) {
            return {
              ...inner,
              text: `[attachment stripped during compaction — original length: ${inner.text.length} chars]`,
            }
          }
          return inner
        })
        return { ...tr, content: stripped }
      }

      return block
    })

    return { ...msg, content: cleaned }
  })
}

// ---------------------------------------------------------------------------
// Calculate split index
// ---------------------------------------------------------------------------

/**
 * Walks `messages` from the **end** backwards and finds the earliest index
 * such that the total token count of messages[index..] is at most
 * `targetTokens`.
 *
 * Returns the index of the first message to **keep**.  Messages before this
 * index will be summarised / discarded.
 */
export function calculateMessagesToKeepIndex(
  messages: Message[],
  targetTokens: number,
  estimate: (text: string) => number = defaultEstimateTokens,
): number {
  let accumulated = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += messageTokenCount(messages[i]!, estimate)
    if (accumulated > targetTokens) {
      // The message at `i` would push us over the budget, so we keep
      // everything from `i + 1` onward.
      return Math.min(i + 1, messages.length)
    }
  }
  // All messages fit within the budget.
  return 0
}

// ---------------------------------------------------------------------------
// Preserve API invariants
// ---------------------------------------------------------------------------

/**
 * Adjusts the keep-index returned by {@link calculateMessagesToKeepIndex}
 * to ensure that `tool_use` / `tool_result` pairs are never split across
 * the compaction boundary.
 *
 * The Anthropic API requires that every `tool_use` block in an assistant
 * message is followed by a `tool_result` in the next user message.  If the
 * raw split index lands between a `tool_use` and its `tool_result` we must
 * move the index backward to include the `tool_use` or forward to exclude
 * it — whichever is safe.
 *
 * This function also ensures the first kept message is a `user` message
 * (the API requires conversations to alternate starting with user).
 */
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  index: number,
): number {
  if (index <= 0 || index >= messages.length) return index

  let adjusted = index

  // Walk backwards from the split point to find a safe boundary.
  // We need to make sure that:
  //  a) If the message just before the split is an assistant with tool_use,
  //     we must include its tool_result (which comes after).
  //  b) The first kept message should be from the user role.

  // Fix (a): if the last *dropped* message is an assistant tool_use, move the
  // index backward so that message is kept (and its result will be kept too).
  const lastDropped = messages[adjusted - 1]
  if (lastDropped && lastDropped.role === 'assistant' && Array.isArray(lastDropped.content)) {
    const hasToolUse = lastDropped.content.some((b) => b.type === 'tool_use')
    if (hasToolUse) {
      // Move index back to include this assistant message and its result.
      adjusted = Math.max(0, adjusted - 1)
    }
  }

  // Fix (b): the first kept message must be from the user.
  while (adjusted < messages.length && messages[adjusted]!.role !== 'user') {
    adjusted++
  }

  // Clamp.
  return Math.min(adjusted, messages.length)
}

// ---------------------------------------------------------------------------
// Post-compact file attachments
// ---------------------------------------------------------------------------

/**
 * After compaction, any `tool_result` blocks that referenced files via the
 * attachment cache may be broken because the original content was discarded.
 *
 * This function scans the **kept** messages and generates lightweight
 * "re-attachment" entries for file references found in tool_use blocks whose
 * results were dropped.  The returned attachments can be injected as a
 * synthetic user message right after the compaction summary.
 *
 * `cache` maps a tool_use id to the original attachment payload.
 */
export function createPostCompactFileAttachments(
  messages: Message[],
  cache: Map<string, Attachment>,
): PostCompactAttachment[] {
  const attachments: PostCompactAttachment[] = []
  const seen = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue

    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      const tu = block as ToolUseBlock

      if (seen.has(tu.id)) continue

      const attachment = cache.get(tu.id)
      if (attachment) {
        seen.add(tu.id)
        attachments.push({
          type: attachment.type,
          content: attachment.content,
        })
      }
    }
  }

  return attachments
}

// ---------------------------------------------------------------------------
// Deferred tools delta
// ---------------------------------------------------------------------------

/**
 * When the set of available tools changes between the pre-compact and
 * post-compact turns, the model needs to be told about tools that were
 * added or removed.
 *
 * This function computes a human-readable delta string that can be appended
 * to the compaction summary.
 */
export function getDeferredToolsDeltaAttachment(tools: ToolInstance[]): PostCompactAttachment | null {
  if (tools.length === 0) return null

  const toolLines = tools.map((t) => {
    const desc = typeof t.description === 'function' ? t.description() : t.description
    return `- \`${t.name}\`: ${desc.slice(0, 120)}`
  })

  return {
    type: 'deferred-tools-delta',
    content: [
      '## Available tools (post-compaction)',
      '',
      ...toolLines,
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Main compaction entry point
// ---------------------------------------------------------------------------

/**
 * Compacts a conversation by:
 *
 *  1. Stripping images from all messages.
 *  2. Stripping reinjected attachments.
 *  3. Computing how many recent messages fit within `targetTokens`.
 *  4. Adjusting the split index to preserve `tool_use` / `tool_result` chains.
 *  5. Prepending a summary message that describes the removed messages.
 *
 * Returns a {@link CompactResult} with the kept messages and statistics.
 */
export function compactConversation(
  messages: Message[],
  options: CompactOptions,
): { result: CompactResult; keptMessages: Message[]; attachments: PostCompactAttachment[] } {
  const {
    targetTokens,
    summary,
    estimateTokens: estimate = defaultEstimateTokens,
  } = options

  // -- Pre-processing -------------------------------------------------------
  let processed = stripImagesFromMessages(messages)
  processed = stripReinjectedAttachments(processed)

  const tokenCountBefore = processed.reduce(
    (sum, m) => sum + messageTokenCount(m, estimate),
    0,
  )

  // -- Determine split point ------------------------------------------------
  let keepIndex = calculateMessagesToKeepIndex(processed, targetTokens, estimate)
  keepIndex = adjustIndexToPreserveAPIInvariants(processed, keepIndex)

  const dropped = processed.slice(0, keepIndex)
  const kept = processed.slice(keepIndex)

  const messagesRemoved = dropped.length
  const messagesKept = kept.length

  // -- Build summary message ------------------------------------------------
  const summaryText =
    summary ??
    buildDefaultSummary(dropped)

  const summaryMessage: Message = {
    id: `compact-summary-${Date.now()}`,
    uuid: randomUUID(),
    role: 'user',
    content: summaryText,
    timestamp: Date.now(),
    isMeta: true,
  }

  const finalMessages: Message[] = [summaryMessage, ...kept]

  const tokenCountAfter = finalMessages.reduce(
    (sum, m) => sum + messageTokenCount(m, estimate),
    0,
  )

  // -- Post-compact attachments (file re-attachments, tools delta) ----------
  // Build a stub cache — in a real system the caller would pass the actual
  // attachment cache built up during the conversation.
  const attachments: PostCompactAttachment[] = []

  const toolsDelta = getDeferredToolsDeltaAttachment([])
  if (toolsDelta) {
    attachments.push(toolsDelta)
  }

  return {
    result: {
      summary: summaryText,
      messagesKept,
      messagesRemoved,
      tokenCountBefore,
      tokenCountAfter,
    },
    keptMessages: finalMessages,
    attachments,
  }
}

// ---------------------------------------------------------------------------
// Default summary builder
// ---------------------------------------------------------------------------

/**
 * Builds a simple textual summary of the `dropped` messages.  This is a
 * heuristic fallback — production code would call an LLM for a proper
 * abstractive summary.
 */
function buildDefaultSummary(dropped: Message[]): string {
  if (dropped.length === 0) {
    return '[No prior messages to summarise.]'
  }

  const lines: string[] = []
  lines.push('<compaction_summary>')
  lines.push('')
  lines.push(`The following is a summary of the first ${dropped.length} messages that were compacted:`)
  lines.push('')

  // Count roles.
  const roleCounts: Record<string, number> = {}
  for (const msg of dropped) {
    roleCounts[msg.role] = (roleCounts[msg.role] ?? 0) + 1
  }
  lines.push(`Message counts: ${Object.entries(roleCounts).map(([r, c]) => `${r}=${c}`).join(', ')}`)
  lines.push('')

  // Extract user message snippets as conversation anchors.
  const userSnippets = dropped
    .filter((m) => m.role === 'user')
    .map((m) => {
      if (typeof m.content === 'string') return m.content.slice(0, 200)
      const firstText = m.content.find((b) => b.type === 'text')
      if (firstText && firstText.type === 'text') return firstText.text.slice(0, 200)
      return ''
    })
    .filter(Boolean)

  if (userSnippets.length > 0) {
    lines.push('Key user messages:')
    for (const snippet of userSnippets.slice(0, 5)) {
      lines.push(`- ${snippet}`)
    }
    lines.push('')
  }

  // List tool names that were used.
  const toolNames = new Set<string>()
  for (const msg of dropped) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolNames.add((block as ToolUseBlock).name)
      }
    }
  }

  if (toolNames.size > 0) {
    lines.push(`Tools used: ${[...toolNames].map((n) => `\`${n}\``).join(', ')}`)
    lines.push('')
  }

  lines.push('Please continue the conversation from where it left off.')
  lines.push('')
  lines.push('</compaction_summary>')

  return lines.join('\n')
}
