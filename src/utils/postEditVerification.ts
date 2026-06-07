/**
 * Post-Edit Auto-Verification
 *
 * Runs lightweight validation after FileEdit and FileWrite tool calls
 * to catch common issues before the model moves on to the next step:
 *
 *  1. **Read-back check** — verify the file exists and is non-empty
 *     (unless an empty write was intentional).
 *  2. **Encoding check** — ensure the file can be read as valid UTF-8.
 *  3. **Basic syntax heuristic** — for JSON files, attempt a parse; for
 *     bracket-heavy languages, check for gross bracket imbalance.
 *
 * The verification is best-effort and non-blocking. If validation fails
 * the result is appended to the tool output so the model can react.
 * If validation passes or cannot be performed, the original result is
 * returned unchanged.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerificationResult {
  ok: boolean
  issues: string[]
}

/**
 * Verify a file after an edit/write operation.
 *
 * @param filePath - Absolute path to the file that was modified.
 * @param expectedNonEmpty - If true, flag an empty file as an issue.
 * @returns A verification result with any detected issues.
 */
export async function verifyFileAfterEdit(
  filePath: string,
  expectedNonEmpty = true,
): Promise<VerificationResult> {
  const issues: string[] = []

  // 1. Read-back check — file should exist.
  let content: string
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      issues.push(`Path "${filePath}" exists but is not a regular file.`)
      return { ok: false, issues }
    }

    if (expectedNonEmpty && fileStat.size === 0) {
      issues.push(`File "${filePath}" is empty after write (0 bytes).`)
    }

    content = await readFile(filePath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    issues.push(`Cannot read back file "${filePath}": ${msg}`)
    return { ok: false, issues }
  }

  // 2. Encoding check — if readFile('utf-8') succeeded, encoding is OK.
  //    But check for replacement character (indicates encoding issues).
  if (content.includes('\uFFFD')) {
    issues.push('File contains Unicode replacement characters — possible encoding corruption.')
  }

  // 3. Syntax heuristic based on file extension.
  const ext = extname(filePath).toLowerCase()
  const syntaxIssues = checkSyntaxHeuristic(content, ext)
  issues.push(...syntaxIssues)

  return {
    ok: issues.length === 0,
    issues,
  }
}

// ---------------------------------------------------------------------------
// Syntax Heuristics
// ---------------------------------------------------------------------------

/**
 * Run lightweight syntax checks based on file extension.
 * Returns an array of issue descriptions (empty if no issues found).
 */
function checkSyntaxHeuristic(content: string, ext: string): string[] {
  const issues: string[] = []

  // JSON — must parse cleanly.
  if (ext === '.json') {
    try {
      JSON.parse(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      issues.push(`JSON parse error: ${msg}`)
    }
    return issues
  }

  // Bracket-balance check for C-family and similar languages.
  const bracketExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
    '.go', '.rs', '.py', '.rb', '.php', '.swift',
    '.kt', '.scala', '.vue', '.svelte',
  ])

  if (bracketExts.has(ext)) {
    const balance = checkBracketBalance(content)
    if (balance) {
      issues.push(balance)
    }
  }

  return issues
}

/**
 * Check for gross bracket imbalance in source code.
 *
 * Counts opening vs closing brackets of each type and reports
 * significant mismatches. Ignores brackets inside string literals
 * and comments for a rough-but-fast heuristic.
 */
function checkBracketBalance(content: string): string | null {
  // Strip string literals and comments for more accurate counting.
  const stripped = stripStringsAndComments(content)

  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]

  for (const [open, close] of pairs) {
    const openCount = countChar(stripped, open)
    const closeCount = countChar(stripped, close)
    const diff = Math.abs(openCount - closeCount)

    // Allow a mismatch of 1-2 for edge cases (template literals, etc.)
    if (diff > 2) {
      return `Bracket imbalance: ${open}${close} — ${openCount} opening vs ${closeCount} closing (diff: ${diff}).`
    }
  }

  return null
}

/**
 * Count occurrences of a single character in a string.
 */
function countChar(str: string, char: string): number {
  let count = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) count++
  }
  return count
}

/**
 * Strip string literals (single, double, backtick) and line/block comments
 * from source code. This is a rough heuristic — not a full parser.
 */
function stripStringsAndComments(source: string): string {
  // Replace string literals and comments with spaces.
  // Handles: "...", '...', `...`, // ..., /* ... */
  return source.replace(
    /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (match) => ' '.repeat(match.length),
  )
}

// ---------------------------------------------------------------------------
// Tool Result Enrichment
// ---------------------------------------------------------------------------

/**
 * Extract the file path from a FileEdit or FileWrite tool input.
 * Returns null if the path cannot be determined.
 */
export function extractFilePathFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === 'FileWrite' || toolName === 'FileEdit') {
    if (typeof input.file_path === 'string') return input.file_path
    if (typeof input.filePath === 'string') return input.filePath
    if (typeof input.path === 'string') return input.path
  }
  return null
}

/**
 * Format a verification result as a string to append to a tool result.
 * Returns null if verification passed cleanly.
 */
export function formatVerificationNote(result: VerificationResult): string | null {
  if (result.ok) return null

  const header = '\n\n[Auto-Verification Warning]'
  const issues = result.issues.map(i => `  - ${i}`).join('\n')
  return `${header}\n${issues}`
}
