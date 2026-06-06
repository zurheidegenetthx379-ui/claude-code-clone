/**
 * AI-powered Compact Summary Generator
 *
 * Uses the LLM to generate an abstractive summary of messages that will be
 * dropped during compaction. This produces a much higher-quality summary
 * than the heuristic fallback (which just extracts user message snippets).
 *
 * The summary preserves:
 *  - Key decisions and conclusions reached
 *  - Files modified or created
 *  - Tools used and their outcomes
 *  - The user's original intent and goals
 *  - Any unresolved issues or pending tasks
 */

import type { Message, ContentBlock } from '../../types/index.js'
import type { ProviderAdapter } from '../api/provider.js'
import type { StreamOptions } from '../api/claude.js'

// ---------------------------------------------------------------------------
// Prompt Template
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to create a concise but comprehensive summary of a coding conversation that will be used as context for continuing the conversation after compaction.

Focus on:
- The user's goals and intent
- Key decisions made and why
- Files created, modified, or read (with paths)
- Commands executed and their results
- Tools used and outcomes
- Any errors encountered and how they were resolved
- Unresolved issues or pending tasks
- Code patterns and conventions established

Output ONLY the summary text, wrapped in <compaction_summary> tags.
Be concise but complete — the model continuing this conversation will only have this summary and the most recent messages.`

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an AI summary of messages that will be dropped during compaction.
 *
 * Falls back to a simple text extraction if the API call fails.
 *
 * @param provider - The provider adapter to use for the summary call.
 * @param messages - The messages to summarize (typically the "dropped" messages).
 * @param model - Optional model override for the summary call.
 * @returns The summary text, or null if generation failed.
 */
export async function generateCompactSummary(
  provider: ProviderAdapter,
  messages: Message[],
  model?: string,
): Promise<string | null> {
  if (messages.length === 0) return null

  // Build a transcript of the dropped messages for the summary prompt.
  const transcript = buildTranscript(messages)

  // Truncate if too long (keep within ~8K tokens for the summary input).
  const maxChars = 32000
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n\n[... transcript truncated ...]'
    : transcript

  const userPrompt = `Summarize the following coding conversation concisely:\n\n${truncated}`

  try {
    let summaryText = ''
    const streamOptions: StreamOptions = {
      model,
      maxTokens: 1024,
      temperature: 0.3,
    }

    const summaryMessage: Message = {
      id: 'compact-summary-request',
      uuid: 'compact-summary-request',
      role: 'user',
      content: userPrompt,
      timestamp: Date.now(),
    }

    for await (const event of provider.stream(
      [summaryMessage],
      SUMMARY_SYSTEM_PROMPT,
      [], // No tools needed for summarization
      streamOptions,
    )) {
      if (event.type === 'text') {
        summaryText += event.content
      }
    }

    if (summaryText.trim()) {
      return summaryText.trim()
    }

    return null
  } catch {
    // If the summary generation fails, return null so the caller
    // falls back to the heuristic summary.
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable transcript from messages for the summary prompt.
 */
function buildTranscript(messages: Message[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()

    if (typeof msg.content === 'string') {
      lines.push(`[${role}]: ${msg.content}`)
      lines.push('')
      continue
    }

    const parts: string[] = []
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'text') {
        parts.push(block.text)
      } else if (block.type === 'tool_use') {
        const input = JSON.stringify(block.input).slice(0, 500)
        parts.push(`[Tool: ${block.name}(${input})]`)
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content.slice(0, 500)
          : '[complex result]'
        const errorNote = block.is_error ? ' (ERROR)' : ''
        parts.push(`[Result${errorNote}: ${content}]`)
      } else if (block.type === 'thinking') {
        parts.push(`[Thinking: ${block.thinking.slice(0, 300)}...]`)
      }
    }

    if (parts.length > 0) {
      lines.push(`[${role}]: ${parts.join('\n')}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}
