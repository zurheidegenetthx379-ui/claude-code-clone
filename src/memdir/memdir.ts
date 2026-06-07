/**
 * Memory Directory System
 *
 * Reads MEMORY.md (or configured entrypoint) from a designated memory directory,
 * scans sibling .md files, and builds instruction blocks that are injected into
 * the system prompt so the agent has persistent, project-scoped context.
 *
 * Mirrors the architecture used by Claude Code for hierarchical memory management.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MemoryFile } from '../types/index.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename of the canonical entrypoint that anchors every memory directory. */
export const ENTRYPOINT_NAME = 'MEMORY.md'

/** Hard ceiling on the number of lines kept from the entrypoint file. */
export const MAX_ENTRYPOINT_LINES = 200

/** Hard ceiling on raw byte length kept from the entrypoint file. */
export const MAX_ENTRYPOINT_BYTES = 25_000

/** File extension recognised when scanning the memory directory tree. */
const MEMORY_FILE_EXTENSION = '.md'

/** Maximum depth when recursively scanning for memory files. */
const MAX_SCAN_DEPTH = 4

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

/**
 * Applies a two-stage hard truncation to `content`:
 *  1. Trim to at most `maxLines` lines.
 *  2. Trim the resulting string to at most `maxBytes` UTF-8 bytes.
 *
 * If the content is truncated a short ellipsis marker is appended so the agent
 * is aware that content was dropped.
 */
export function truncateEntrypointContent(
  content: string,
  maxLines: number = MAX_ENTRYPOINT_LINES,
  maxBytes: number = MAX_ENTRYPOINT_BYTES,
): string {
  // Stage 1 — line truncation
  const lines = content.split('\n')
  let truncated = lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n')
    : content

  // Stage 2 — byte truncation (use Buffer for accurate UTF-8 byte counting)
  const byteLength = Buffer.byteLength(truncated, 'utf-8')
  if (byteLength > maxBytes) {
    // Progressively trim characters from the end until we fit.
    // This is O(n) in the worst case but memory files are small so it is fine.
    while (Buffer.byteLength(truncated, 'utf-8') > maxBytes && truncated.length > 0) {
      truncated = truncated.slice(0, -1)
    }
  }

  const wasTruncated =
    lines.length > maxLines ||
    Buffer.byteLength(content, 'utf-8') > maxBytes

  if (wasTruncated) {
    truncated += '\n\n[... content truncated for length ...]'
  }

  return truncated
}

// ---------------------------------------------------------------------------
// Memory file scanner
// ---------------------------------------------------------------------------

/**
 * Recursively scans `dir` for `.md` files (up to `MAX_SCAN_DEPTH`) and returns
 * a lightweight {@link MemoryFile} descriptor for each one.
 *
 * The entrypoint (`MEMORY.md` at the root of the directory) is **excluded**
 * because it is handled separately by `buildMemoryPrompt`.
 */
export async function scanMemoryFiles(dir: string, depth = 0): Promise<MemoryFile[]> {
  if (depth > MAX_SCAN_DEPTH) return []

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' })
  } catch {
    // Directory is unreadable or doesn't exist — silently skip.
    return []
  }

  const results: MemoryFile[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      const nested = await scanMemoryFiles(fullPath, depth + 1)
      results.push(...nested)
      continue
    }

    if (!entry.isFile()) continue
    if (!entry.name.endsWith(MEMORY_FILE_EXTENSION)) continue
    // Skip the entrypoint — it is processed independently.
    if (depth === 0 && entry.name === ENTRYPOINT_NAME) continue

    try {
      const [content, stats] = await Promise.all([
        readFile(fullPath, 'utf-8'),
        stat(fullPath),
      ])

      // Extract the first H1/H2 heading or fall back to the filename.
      const headingMatch = content.match(/^#{1,2}\s+(.+)$/m)
      const description = headingMatch ? headingMatch[1].trim() : entry.name.replace(/\.md$/, '')

      results.push({
        path: fullPath,
        name: entry.name,
        description,
        content,
        mtimeMs: stats.mtimeMs,
      })
    } catch {
      // Unreadable file — skip silently.
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Build memory lines (instruction block constructor)
// ---------------------------------------------------------------------------

/**
 * Constructs the raw instruction lines that should be merged into the system
 * prompt.  This is a low-level helper used by `buildMemoryPrompt`.
 *
 * `config` allows callers to override the default truncation limits.
 */
export function buildMemoryLines(config: {
  entrypointContent: string | null
  entrypointPath: string | null
  siblingFiles: MemoryFile[]
  maxLines?: number
  maxBytes?: number
}): string[] {
  const {
    entrypointContent,
    entrypointPath,
    siblingFiles,
    maxLines = MAX_ENTRYPOINT_LINES,
    maxBytes = MAX_ENTRYPOINT_BYTES,
  } = config

  const lines: string[] = []

  lines.push('<memory_system>')

  // -- Entrypoint section ---------------------------------------------------
  if (entrypointContent && entrypointPath) {
    const truncated = truncateEntrypointContent(entrypointContent, maxLines, maxBytes)
    lines.push('')
    lines.push(`## Memory entrypoint (${entrypointPath})`)
    lines.push('')
    lines.push(truncated)
  }

  // -- Sibling file manifest ------------------------------------------------
  if (siblingFiles.length > 0) {
    lines.push('')
    lines.push('## Available memory files')
    lines.push('')
    lines.push(
      'The following files are stored in the memory directory. ',
    )
    lines.push(
      'Read them on demand when their topic becomes relevant to the current task.',
    )
    lines.push('')

    for (const file of siblingFiles) {
      lines.push(`- **${file.name}**: ${file.description}`)
    }
  }

  lines.push('')
  lines.push('</memory_system>')

  return lines
}

// ---------------------------------------------------------------------------
// High-level public API
// ---------------------------------------------------------------------------

/**
 * Reads the memory directory at `memoryDir`, loads the entrypoint file,
 * scans sibling `.md` files, and returns a fully-formed instruction block
 * (as a single string) ready to be appended to the system prompt.
 *
 * Returns `null` when no memory directory or entrypoint exists.
 */
export async function buildMemoryPrompt(memoryDir: string): Promise<string | null> {
  const resolvedDir = resolve(memoryDir)
  const entrypointPath = join(resolvedDir, ENTRYPOINT_NAME)

  // Attempt to read the entrypoint.  If it doesn't exist we still proceed
  // with an empty entrypoint so that sibling files are surfaced.
  let entrypointContent: string | null = null
  try {
    entrypointContent = await readFile(entrypointPath, 'utf-8')
  } catch {
    // No entrypoint — that is acceptable; we will only list siblings.
  }

  // Scan sibling memory files.
  const siblingFiles = await scanMemoryFiles(resolvedDir)

  // If we have neither an entrypoint nor any siblings, signal "no memory".
  if (entrypointContent === null && siblingFiles.length === 0) {
    return null
  }

  const lines = buildMemoryLines({
    entrypointContent,
    entrypointPath: entrypointContent !== null ? entrypointPath : null,
    siblingFiles,
  })

  return lines.join('\n')
}
