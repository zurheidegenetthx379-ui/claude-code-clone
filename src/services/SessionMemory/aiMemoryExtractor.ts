/**
 * AI-Powered Session Memory Extractor
 *
 * Uses the LLM to extract structured session memory from conversation
 * transcripts. Produces higher-quality memory than the heuristic fallback
 * by identifying:
 *
 *  - Key decisions and their rationale
 *  - Files created/modified with purpose descriptions
 *  - Patterns, conventions, and coding standards established
 *  - Unresolved issues and pending tasks
 *  - User preferences and project-specific knowledge
 *
 * The extraction is designed to be incremental — it reads the existing
 * memory file and produces an updated version that merges prior context
 * with new information from recent messages.
 *
 * Falls back to the existing heuristic extraction when the LLM call fails.
 */

import { readFile } from 'node:fs/promises'
import type { Message, ContentBlock } from '../../types/index.js'
import type { ProviderAdapter } from '../api/provider.js'
import type { StreamOptions } from '../api/claude.js'

// ---------------------------------------------------------------------------
// Prompt Template
// ---------------------------------------------------------------------------

const MEMORY_SYSTEM_PROMPT = `You are a session memory extractor for a coding assistant. Your task is to maintain a structured session memory file that captures important context from a coding conversation.

You will receive:
1. The current session memory file content (may be a template with no data yet)
2. Recent conversation messages

Your job is to produce an UPDATED session memory markdown file that preserves important prior context and adds new learnings.

Focus on extracting:
- **Key decisions**: What was decided and why (architecture choices, library picks, design patterns)
- **Files and changes**: Which files were created/modified and their purpose
- **Code patterns**: Conventions, standards, or patterns established in the session
- **Project knowledge**: Tech stack, structure, build commands, dependencies discovered
- **Unresolved items**: Pending tasks, known bugs, TODO items mentioned
- **User preferences**: Coding style, communication preferences, workflow choices

Guidelines:
- Be concise — this memory will be injected into future sessions as context
- Preserve specifics (file paths, function names, error messages) over vague descriptions
- Remove redundant or outdated information
- Use markdown headers and bullet points for scannability
- Keep the total output under 2000 words
- Output ONLY the markdown content, no explanatory text`

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an AI-powered session memory update.
 *
 * @param provider - The provider adapter to use for the extraction call.
 * @param messages - The conversation messages to extract from.
 * @param existingMemory - Current content of the session memory file.
 * @param model - Optional model override.
 * @returns The updated memory markdown, or null if generation failed.
 */
export async function generateSessionMemoryUpdate(
  provider: ProviderAdapter,
  messages: Message[],
  existingMemory: string,
  model?: string,
): Promise<string | null> {
  if (messages.length === 0) return null

  // Build a compact transcript focusing on recent activity.
  const transcript = buildMemoryTranscript(messages)

  // Truncate if too long (keep within ~12K tokens for input).
  const maxChars = 48000
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n\n[... transcript truncated ...]'
    : transcript

  const userPrompt = [
    '## Current Session Memory',
    '',
    existingMemory || '_(No prior memory — this is a new session.)_',
    '',
    '## Recent Conversation',
    '',
    truncated,
    '',
    'Produce an updated session memory markdown file that incorporates relevant context from the recent conversation.',
  ].join('\n')

  try {
    let resultText = ''
    const streamOptions: StreamOptions = {
      model,
      maxTokens: 2048,
      temperature: 0.2,
    }

    const requestMessage: Message = {
      id: 'memory-extract-request',
      uuid: 'memory-extract-request',
      role: 'user',
      content: userPrompt,
      timestamp: Date.now(),
    }

    for await (const event of provider.stream(
      [requestMessage],
      MEMORY_SYSTEM_PROMPT,
      [], // No tools needed for extraction
      streamOptions,
    )) {
      if (event.type === 'text') {
        resultText += event.content
      }
    }

    if (resultText.trim()) {
      return resultText.trim()
    }

    return null
  } catch {
    // If AI extraction fails, the caller falls back to heuristic extraction.
    return null
  }
}

// ---------------------------------------------------------------------------
// Memory Injection for New Sessions
// ---------------------------------------------------------------------------

/**
 * Read existing session memory files from the project and produce a
 * consolidated context block for injection into new sessions.
 *
 * @param cwd - The project working directory.
 * @param maxFiles - Maximum number of memory files to read (default: 5, most recent).
 * @returns A string containing relevant past context, or null if none found.
 */
export async function loadProjectMemoryContext(
  cwd: string,
  maxFiles = 5,
): Promise<string | null> {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const memoryDir = join(cwd, '.session-memory')

  try {
    const entries = await readdir(memoryDir)
    const memoryFiles = entries
      .filter(f => f.endsWith('.md'))
      .sort() // Lexicographic sort — session IDs are time-ordered UUIDs
      .reverse() // Most recent first
      .slice(0, maxFiles)

    if (memoryFiles.length === 0) return null

    const sections: string[] = []
    for (const file of memoryFiles) {
      try {
        const content = await readFile(join(memoryDir, file), 'utf-8')
        // Skip template files with no real content
        if (content.includes('_(No context captured yet.)_') && content.includes('_(No decisions recorded yet.)_')) {
          continue
        }
        const sessionId = file.replace('.md', '')
        sections.push(`### Session ${sessionId.slice(0, 8)}\n${content}`)
      } catch {
        // Skip unreadable files
      }
    }

    if (sections.length === 0) return null

    return [
      '## Relevant Past Session Context',
      '',
      'The following context was captured from previous sessions in this project.',
      'Use it as background knowledge but verify assumptions against the current state.',
      '',
      ...sections,
    ].join('\n')
  } catch {
    // Directory doesn't exist or can't be read
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Build a compact transcript from messages optimized for memory extraction.
 * Focuses on user intent, tool usage, and assistant conclusions.
 */
function buildMemoryTranscript(messages: Message[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()

    if (typeof msg.content === 'string') {
      lines.push(`[${role}]: ${msg.content.slice(0, 1000)}`)
      lines.push('')
      continue
    }

    const parts: string[] = []
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'text') {
        // Keep text concise but longer than compact summary
        parts.push(block.text.slice(0, 800))
      } else if (block.type === 'tool_use') {
        const input = JSON.stringify(block.input).slice(0, 300)
        parts.push(`[Tool: ${block.name}(${input})]`)
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content.slice(0, 300)
          : '[complex result]'
        const errorNote = block.is_error ? ' (ERROR)' : ''
        parts.push(`[Result${errorNote}: ${content}]`)
      }
      // Skip thinking blocks for memory extraction
    }

    if (parts.length > 0) {
      lines.push(`[${role}]: ${parts.join('\n')}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}
