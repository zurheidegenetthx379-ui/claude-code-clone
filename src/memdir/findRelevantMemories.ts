/**
 * findRelevantMemories
 *
 * Scans a memory directory, extracts file headers (first H1/H2 + optional
 * description paragraph), and selects the most relevant memory files for the
 * current conversational context.
 *
 * The selection is deterministic and keyword-based so that it runs fast and
 * does not require an LLM round-trip.  It mirrors the "manifest + filter"
 * approach used internally by Claude Code.
 */

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MemoryFile } from '../types/index.js'
import { ENTRYPOINT_NAME } from './memdir.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelevantMemory extends Pick<MemoryFile, 'path' | 'name' | 'mtimeMs'> {
  /** One-line description extracted from the file header. */
  description: string
  /** Relevance score (higher = more relevant). Used for ranking. */
  score: number
}

export interface FindRelevantMemoriesOptions {
  /** Free-text description of the current task / user query. */
  currentContext: string
  /** File paths that have already been surfaced earlier in the conversation. */
  alreadySurfaced?: string[]
  /** Hard cap on the number of files returned. */
  maxResults?: number
  /** Optional keyword overrides that always match. */
  keywords?: string[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5
const MAX_SCAN_DEPTH = 4

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

/**
 * Reads the first ~2 KB of a file and extracts:
 *  - The first `#` or `##` heading (used as the display name).
 *  - The paragraph immediately following the heading (used as a description).
 *
 * Falls back to the filename when no heading is found.
 */
async function extractFileHeader(filePath: string, fileName: string): Promise<{
  name: string
  description: string
}> {
  try {
    // Read only the first 2 KB to keep I/O minimal.
    const handle = await (await import('node:fs/promises')).open(filePath, 'r')
    try {
      const buf = Buffer.alloc(2048)
      const { bytesRead } = await handle.read(buf, 0, 2048, 0)
      const head = buf.toString('utf-8', 0, bytesRead)

      const headingMatch = head.match(/^#{1,2}\s+(.+)$/m)
      const name = headingMatch ? headingMatch[1].trim() : fileName.replace(/\.md$/, '')

      // Try to capture the first non-empty paragraph after the heading.
      let description = name
      if (headingMatch) {
        const afterHeading = head.slice(head.indexOf(headingMatch[0]) + headingMatch[0].length)
        const paragraphMatch = afterHeading.match(/\n\s*\n\s*([\s\S]*?)(?:\n\s*\n|\n#|$)/)
        if (paragraphMatch) {
          description = paragraphMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200)
        }
      }

      return { name, description }
    } finally {
      await handle.close()
    }
  } catch {
    return { name: fileName.replace(/\.md$/, ''), description: fileName }
  }
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

interface MemoryManifestEntry {
  path: string
  name: string
  fileName: string
  description: string
  mtimeMs: number
  /** Lowercased tokens derived from filename + heading + description. */
  tokens: string[]
}

async function buildManifest(dir: string, depth = 0): Promise<MemoryManifestEntry[]> {
  if (depth > MAX_SCAN_DEPTH) return []

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' })
  } catch {
    return []
  }

  const manifest: MemoryManifestEntry[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      const nested = await buildManifest(fullPath, depth + 1)
      manifest.push(...nested)
      continue
    }

    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    // Skip the canonical entrypoint — it is always loaded.
    if (depth === 0 && entry.name === ENTRYPOINT_NAME) continue

    const fileStat = await stat(fullPath).catch(() => null)
    if (!fileStat) continue

    const header = await extractFileHeader(fullPath, entry.name)

    // Tokenise for fast keyword matching later.
    const rawTokens = [
      entry.name.replace(/\.md$/, ''),
      header.name,
      header.description,
    ]
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)

    manifest.push({
      path: fullPath,
      name: header.name,
      fileName: entry.name,
      description: header.description,
      mtimeMs: fileStat.mtimeMs,
      tokens: [...new Set(rawTokens)],
    })
  }

  return manifest
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Computes a simple relevance score for a manifest entry given the current
 * context tokens and any explicit keyword overrides.
 *
 * Scoring heuristics:
 *  +3  for each exact keyword override match in tokens
 *  +2  for each context token that appears in the file tokens
 *  +1  if the file was modified in the last 24 hours (recency bonus)
 */
function scoreEntry(
  entry: MemoryManifestEntry,
  contextTokens: string[],
  keywordOverrides: string[],
): number {
  let score = 0

  // Keyword overrides carry the highest weight.
  for (const kw of keywordOverrides) {
    const needle = kw.toLowerCase()
    if (entry.tokens.some((t) => t.includes(needle) || needle.includes(t))) {
      score += 3
    }
  }

  // General context token matching.
  for (const ct of contextTokens) {
    if (entry.tokens.includes(ct)) {
      score += 2
    }
  }

  // Recency bonus — files modified in the last 24 h get +1.
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
  if (entry.mtimeMs > oneDayAgo) {
    score += 1
  }

  return score
}

// ---------------------------------------------------------------------------
// Tokeniser (lightweight)
// ---------------------------------------------------------------------------

function tokeniseContext(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans the memory directory at `memoryDir`, builds a lightweight manifest of
 * all `.md` files (excluding `MEMORY.md`), scores each file against the
 * current conversational context, and returns at most `maxResults` files
 * sorted by descending relevance.
 *
 * Files whose paths appear in `alreadySurfaced` are excluded so the same file
 * is not injected twice within one conversation.
 *
 * Returns an empty array when no relevant files are found.
 */
export async function findRelevantMemories(
  memoryDir: string,
  options: FindRelevantMemoriesOptions,
): Promise<RelevantMemory[]> {
  const {
    currentContext,
    alreadySurfaced = [],
    maxResults = DEFAULT_MAX_RESULTS,
    keywords = [],
  } = options

  const resolvedDir = resolve(memoryDir)
  const manifest = await buildManifest(resolvedDir)

  if (manifest.length === 0) return []

  // Normalise the already-surfaced set for O(1) lookups.
  const surfacedSet = new Set(alreadySurfaced.map((p) => resolve(p)))

  // Tokenise the context once.
  const contextTokens = [...new Set(tokeniseContext(currentContext))]

  // Score, filter, and sort.
  const scored = manifest
    .filter((entry) => !surfacedSet.has(resolve(entry.path)))
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, contextTokens, keywords),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      // Primary: descending score.  Secondary: most recently modified first.
      if (b.score !== a.score) return b.score - a.score
      return b.entry.mtimeMs - a.entry.mtimeMs
    })
    .slice(0, maxResults)

  return scored.map(({ entry, score }) => ({
    path: entry.path,
    name: entry.name,
    description: entry.description,
    mtimeMs: entry.mtimeMs,
    score,
  }))
}
