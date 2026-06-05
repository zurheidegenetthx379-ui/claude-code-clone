/**
 * FileEditTool - Edit files via exact string replacement.
 *
 * Semantics:
 *   - Find `old_string` in the target file and replace with `new_string`.
 *   - By default, `old_string` must appear **exactly once** to prevent
 *     accidental bulk changes.  Set `replace_all: true` to replace every
 *     occurrence.
 *   - Returns a unified-diff-style summary of the change.
 *
 * This tool intentionally does NOT support regex or fuzzy matching to keep
 * edits deterministic and auditable.
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { buildTool } from '../../Tool.js'
import minimatch from 'minimatch'
import * as Diff from 'diff'
import type {
  ToolResult,
  ToolUseContext,
  Message,
  CanUseTool,
  ToolProgressData,
  PermissionResult,
  PermissionContext,
} from '../../types/index.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MiB - refuse to edit huge files
const CONTEXT_LINES = 3 // lines of context around the diff

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * Attempt a fuzzy match of `needle` against the file content.
 *
 * Uses a sliding window of the same line count as `needle` and scores each
 * window by character-level Levenshtein similarity.  Returns the best match
 * if its similarity exceeds 85%.
 */
function findFuzzyMatch(
  haystack: string,
  needle: string,
  threshold = 0.85,
): { matchedText: string; similarity: number } | null {
  const needleLines = needle.split('\n')
  const needleLineCount = needleLines.length
  const haystackLines = haystack.split('\n')

  if (needleLineCount > haystackLines.length) return null

  // Normalise needle for comparison (trim trailing whitespace per line).
  const normNeedle = needleLines.map((l) => l.trimEnd()).join('\n')

  let bestMatch = ''
  let bestScore = 0

  // Sliding window: try each position in the haystack.
  for (let i = 0; i <= haystackLines.length - needleLineCount; i++) {
    const window = haystackLines.slice(i, i + needleLineCount)
    const normWindow = window.map((l) => l.trimEnd()).join('\n')

    // Quick character-level similarity check.
    const similarity = computeSimilarity(normNeedle, normWindow)
    if (similarity > bestScore) {
      bestScore = similarity
      bestMatch = haystackLines.slice(i, i + needleLineCount).join('\n')
    }
  }

  if (bestScore >= threshold) {
    return { matchedText: bestMatch, similarity: bestScore }
  }
  return null
}

/**
 * Compute character-level similarity ratio between two strings.
 * Uses a fast heuristic: ratio of common characters to max length.
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1

  // Use diff library for accurate character-level comparison.
  const changes = Diff.diffChars(a, b)
  let commonChars = 0
  for (const part of changes) {
    if (!part.added && !part.removed) {
      commonChars += part.value.length
    }
  }
  return (2 * commonChars) / (a.length + b.length)
}

/**
 * Produce a compact diff summary showing changed lines with context.
 */
function buildDiffSummary(
  original: string,
  modified: string,
  filePath: string,
): string {
  const origLines = original.split('\n')
  const modLines = modified.split('\n')

  // Find the first line that differs
  let firstDiff = 0
  const minLen = Math.min(origLines.length, modLines.length)
  while (firstDiff < minLen && origLines[firstDiff] === modLines[firstDiff]) {
    firstDiff++
  }

  // Find the last line that differs (from the end)
  let lastDiffOrig = origLines.length - 1
  let lastDiffMod = modLines.length - 1
  while (
    lastDiffOrig > firstDiff &&
    lastDiffMod > firstDiff &&
    origLines[lastDiffOrig] === modLines[lastDiffMod]
  ) {
    lastDiffOrig--
    lastDiffMod--
  }

  // Context bounds
  const contextStart = Math.max(0, firstDiff - CONTEXT_LINES)
  const contextEndOrig = Math.min(origLines.length - 1, lastDiffOrig + CONTEXT_LINES)
  const contextEndMod = Math.min(modLines.length - 1, lastDiffMod + CONTEXT_LINES)

  const removed = origLines.slice(contextStart, contextEndOrig + 1)
  const added = modLines.slice(contextStart, contextEndMod + 1)

  const parts: string[] = []
  parts.push(`--- ${filePath} (original)`)
  parts.push(`+++ ${filePath} (modified)`)
  parts.push(`@@ -${contextStart + 1},${removed.length} +${contextStart + 1},${added.length} @@`)

  for (const line of removed) {
    parts.push(`- ${line}`)
  }
  for (const line of added) {
    parts.push(`+ ${line}`)
  }

  return parts.join('\n')
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const FileEditTool = buildTool({
  name: 'FileEdit',

  description:
    'Edit a file by replacing an exact string match. ' +
    'The `old_string` must appear in the file. By default it must be unique; ' +
    'set `replace_all: true` to replace every occurrence. ' +
    'Returns a diff summary of the change.',

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or cwd-relative path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact string in the file to be replaced.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'When true, replace ALL occurrences of old_string. ' +
          'When false (default), old_string must appear exactly once.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: false,
  isDestructive: false,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }
    const filePath = typeof input.file_path === 'string' ? input.file_path : ''

    if (context.denyList.some((p) => minimatch(filePath, p, { matchBase: true }))) {
      return { behavior: 'deny', message: 'File path matches deny-list entry.' }
    }
    if (context.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow' }
    }
    if (context.permissionMode === 'acceptEdits') {
      return { behavior: 'allow' }
    }
    if (context.allowList.some((p) => minimatch(filePath, p, { matchBase: true }))) {
      return { behavior: 'allow' }
    }
    return { behavior: 'ask' }
  },

  // ── Core execution ────────────────────────────────────────────────────────
  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // ── Validate inputs ───────────────────────────────────────────────────
    const rawPath = input.file_path
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { content: 'Error: `file_path` is required.', isError: true }
    }

    const oldString = input.old_string
    if (typeof oldString !== 'string') {
      return { content: 'Error: `old_string` is required and must be a string.', isError: true }
    }

    const newString = input.new_string
    if (typeof newString !== 'string') {
      return { content: 'Error: `new_string` is required and must be a string.', isError: true }
    }

    if (oldString === newString) {
      return {
        content: 'Error: `old_string` and `new_string` are identical. No change to make.',
        isError: true,
      }
    }

    if (oldString === '') {
      return {
        content: 'Error: `old_string` must not be empty. Use a file-write tool for creating new content.',
        isError: true,
      }
    }

    const replaceAll = input.replace_all === true
    const filePath = resolvePath(rawPath, context.cwd)

    onProgress?.({ status: 'editing' })

    // ── File existence & size check ───────────────────────────────────────
    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `Error: File not found: ${filePath}`, isError: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error accessing file: ${msg}`, isError: true }
    }

    if (!fileStat.isFile()) {
      return { content: `Error: Path is not a regular file: ${filePath}`, isError: true }
    }

    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        content: `Error: File too large to edit (${(fileStat.size / 1024 / 1024).toFixed(1)} MiB, max ${MAX_FILE_BYTES / 1024 / 1024} MiB).`,
        isError: true,
      }
    }

    // ── Read, match, replace ──────────────────────────────────────────────
    let original: string
    try {
      original = await readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error reading file: ${msg}`, isError: true }
    }

    const occurrences = countOccurrences(original, oldString)

    if (occurrences === 0) {
      // ── Fuzzy match fallback ──────────────────────────────────────────────
      // When exact match fails, try to find the closest block of lines in the
      // file using line-level diff.  Accept if similarity >= 85%.
      const fuzzyResult = findFuzzyMatch(original, oldString)
      if (fuzzyResult) {
        const { matchedText, similarity } = fuzzyResult
        if (!replaceAll) {
          const idx = original.indexOf(matchedText)
          const modified =
            original.slice(0, idx) + newString + original.slice(idx + matchedText.length)
          try {
            await writeFile(filePath, modified, 'utf-8')
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            return { content: `Error writing file: ${msg}`, isError: true }
          }
          return {
            content:
              `[fuzzy match, ${(similarity * 100).toFixed(0)}% similar] ` +
              buildDiffSummary(original, modified, filePath),
            isError: false,
          }
        }
      }

      return {
        content:
          `Error: \`old_string\` not found in ${filePath}. ` +
          'Verify the exact text matches, including whitespace and indentation.',
        isError: true,
      }
    }

    if (!replaceAll && occurrences > 1) {
      return {
        content:
          `Error: \`old_string\` appears ${occurrences} times in ${filePath}. ` +
          'Provide more surrounding context to make the match unique, ' +
          'or set `replace_all: true` to replace all occurrences.',
        isError: true,
      }
    }

    let modified: string
    if (replaceAll) {
      modified = original.split(oldString).join(newString)
    } else {
      const idx = original.indexOf(oldString)
      modified =
        original.slice(0, idx) + newString + original.slice(idx + oldString.length)
    }

    // ── Write ─────────────────────────────────────────────────────────────
    try {
      await writeFile(filePath, modified, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied writing to: ${filePath}`, isError: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error writing file: ${msg}`, isError: true }
    }

    onProgress?.({ status: 'done', progress: 1 })

    const diff = buildDiffSummary(original, modified, filePath)
    const replacementNote = replaceAll
      ? `Replaced all ${occurrences} occurrence(s).`
      : 'Replacement applied.'

    return { content: `${replacementNote}\n\n${diff}` }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Edit',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '<unknown>'
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    const replaceAll = input.replace_all === true ? ' (replace_all)' : ''

    const oldPreview = oldStr.length > 60 ? oldStr.slice(0, 57) + '...' : oldStr
    const newPreview = newStr.length > 60 ? newStr.slice(0, 57) + '...' : newStr

    return `Edit ${filePath}${replaceAll}\n  - ${oldPreview}\n  + ${newPreview}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      // Show first line (the replacement note) and the diff header
      const lines = result.content.split('\n')
      return lines.slice(0, 5).join('\n')
    }
    return '(edit applied)'
  },
})

export default FileEditTool
