/**
 * GrepTool - Search file contents using regex patterns.
 *
 * Behaviour:
 *   - Recursively walks directories from a given search path.
 *   - Skips common non-source directories (node_modules, dist, .git, .cc-agent).
 *   - Skips binary files by extension.
 *   - Searches each line of text files against a user-supplied regex.
 *   - Returns matches in `filepath:lineNumber: matchedLine` format.
 */

import minimatch from 'minimatch'

import { readFileSync, statSync, readdirSync } from 'node:fs'
import { resolve, isAbsolute, join, extname, relative } from 'node:path'
import { buildTool } from '../../Tool.js'
import { checkPathAccessSync } from '../../utils/PathPolicy.js'
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

const DEFAULT_MAX_RESULTS = 50
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MiB per file safety limit

/** Directories to always skip during recursive walks. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.cc-agent',
])

/** Extensions we treat as binary — never attempt to read these as text. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.gif', '.ico',
  '.woff', '.ttf',
  '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.zip',
])

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a potentially relative path against the working directory.
 */
function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

/**
 * Check whether a file extension corresponds to a binary file.
 */
function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/**
 * Match a file path against a glob-like include pattern using minimatch.
 *
 * Supports: `*.ts`, `**\/*.ts`, `*.{ts,tsx}`, `src/**\/*.ts`, etc.
 * `matchBase: true` makes `*.ts` match `src/foo.ts` as well.
 */
function matchesIncludeFilter(relativePath: string, include: string): boolean {
  const pattern = include.trim()
  if (!pattern) return true
  return minimatch(relativePath, pattern, { matchBase: true })
}

/**
 * Recursively collect all text file paths under `dir`, applying the
 * directory skip list and binary extension filter.
 */
function collectFiles(dir: string, include?: string, baseDir?: string): string[] {
  const results: string[] = []
  const base = baseDir ?? dir

  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Permission denied or inaccessible — silently skip
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      // Skip well-known non-source directories
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      results.push(...collectFiles(fullPath, include, base))
    } else if (entry.isFile()) {
      // Skip binary files
      if (isBinaryFile(fullPath)) continue

      // Apply include filter if provided — match against relative path
      if (include) {
        const relPath = relative(base, fullPath)
        if (!matchesIncludeFilter(relPath, include)) continue
      }

      results.push(fullPath)
    }
  }

  return results
}

/**
 * Match interface for collected search results.
 */
interface GrepMatch {
  filePath: string
  lineNumber: number
  line: string
}

/**
 * Search a single file's contents for lines matching `regex`.
 * Returns an array of matches, up to `remaining` results.
 */
function searchFile(filePath: string, regex: RegExp, remaining: number): GrepMatch[] {
  const matches: GrepMatch[] = []
  if (remaining <= 0) return matches

  let content: string
  try {
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_BYTES) return matches
    content = readFileSync(filePath, 'utf-8')
  } catch {
    // Unreadable file — silently skip
    return matches
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= remaining) break
    if (regex.test(lines[i])) {
      matches.push({
        filePath,
        lineNumber: i + 1,
        line: lines[i],
      })
    }
  }

  return matches
}

/**
 * Format an array of matches into the output string.
 */
function formatMatches(matches: GrepMatch[], basePath: string): string {
  if (matches.length === 0) return 'No matches found.'

  const lines = matches.map((m) => {
    // Display paths relative to the search base when possible
    const displayPath = m.filePath.startsWith(basePath)
      ? relative(basePath, m.filePath)
      : m.filePath
    return `${displayPath}:${m.lineNumber}: ${m.line}`
  })

  return lines.join('\n')
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const GrepTool = buildTool({
  name: 'Grep',

  description:
    'Search for a regex pattern across files in a directory tree. ' +
    'Returns matching lines in `filepath:lineNumber: matchedLine` format. ' +
    'Skips node_modules, dist, .git, .cc-agent directories and binary files. ' +
    'Use `include` to filter by file extension (e.g. "*.ts").',

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for.',
      },
      path: {
        type: 'string',
        description:
          'Directory or file to search in (default: current working directory).',
      },
      include: {
        type: 'string',
        description:
          'Optional glob-like filter for file extensions (e.g. "*.ts", "*.js").',
      },
      maxResults: {
        type: 'number',
        description: `Maximum number of matches to return (default: ${DEFAULT_MAX_RESULTS}).`,
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Whether the search should be case-sensitive (default: false).',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: true,
  isReadOnly: true,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }
    const searchPath = typeof input.path === 'string' ? input.path : '.'

    if (context.denyList.some((p) => searchPath.includes(p))) {
      return { behavior: 'deny', message: 'Search path matches deny-list entry.' }
    }

    // Enforce path boundaries (protected paths, cwd containment).
    const pathCheck = checkPathAccessSync(searchPath, {
      cwd: context.cwd,
      allowOutsideCwd: context.permissionMode === 'bypassPermissions',
    })
    if (!pathCheck.allowed) {
      return { behavior: 'deny', message: pathCheck.reason }
    }

    return { behavior: 'allow' }
  },

  // ── Core execution ────────────────────────────────────────────────────────
  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // ── Validate pattern ──────────────────────────────────────────────────
    const rawPattern = input.pattern
    if (typeof rawPattern !== 'string' || rawPattern.trim() === '') {
      return {
        content: 'Error: `pattern` is required and must be a non-empty string.',
        isError: true,
      }
    }

    // ── Parse options ─────────────────────────────────────────────────────
    const caseSensitive = input.caseSensitive === true
    const maxResults =
      typeof input.maxResults === 'number' && input.maxResults >= 1
        ? Math.min(Math.floor(input.maxResults), 1000)
        : DEFAULT_MAX_RESULTS

    const include =
      typeof input.include === 'string' && input.include.trim() !== ''
        ? input.include.trim()
        : undefined

    const searchPath = resolvePath(
      typeof input.path === 'string' && input.path.trim() !== ''
        ? input.path.trim()
        : context.cwd,
      context.cwd,
    )

    // ── Build regex ───────────────────────────────────────────────────────
    let regex: RegExp
    try {
      const flags = caseSensitive ? 'g' : 'gi'
      regex = new RegExp(rawPattern, flags)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: Invalid regex pattern: ${msg}`, isError: true }
    }

    onProgress?.({ status: 'searching', progress: 0 })

    // ── Stat the search path ──────────────────────────────────────────────
    let pathStat
    try {
      pathStat = statSync(searchPath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `Error: Path not found: ${searchPath}`, isError: true }
      }
      return { content: `Error accessing path: ${msg}`, isError: true }
    }

    // ── Collect files ─────────────────────────────────────────────────────
    let files: string[]
    if (pathStat.isFile()) {
      // Single file search
      if (isBinaryFile(searchPath)) {
        return {
          content: `Error: ${searchPath} appears to be a binary file and cannot be searched.`,
          isError: true,
        }
      }
      files = [searchPath]
    } else if (pathStat.isDirectory()) {
      files = collectFiles(searchPath, include)
    } else {
      return { content: `Error: Path is not a file or directory: ${searchPath}`, isError: true }
    }

    if (files.length === 0) {
      return { content: 'No files found to search.' }
    }

    onProgress?.({ status: 'searching', progress: 0.5 })

    // ── Search files ──────────────────────────────────────────────────────
    const allMatches: GrepMatch[] = []
    const basePath = pathStat.isDirectory() ? searchPath : searchPath

    for (const file of files) {
      if (allMatches.length >= maxResults) break

      // Check for abort signal between files
      if (context.abortController.signal.aborted) {
        break
      }

      const remaining = maxResults - allMatches.length
      const fileMatches = searchFile(file, regex, remaining)
      allMatches.push(...fileMatches)
    }

    onProgress?.({ status: 'done', progress: 1 })

    // ── Format output ─────────────────────────────────────────────────────
    const output = formatMatches(allMatches, basePath)
    const truncated = allMatches.length >= maxResults
    const suffix = truncated
      ? `\n\n... (limited to ${maxResults} results. Increase maxResults to see more.)`
      : ''

    const summary =
      `\n\nFound ${allMatches.length} match${allMatches.length === 1 ? '' : 'es'} ` +
      `across ${new Set(allMatches.map((m) => m.filePath)).size} file(s).`

    return { content: output + summary + suffix }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Grep',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '<unknown>'
    const searchPath = typeof input.path === 'string' ? input.path : '.'
    const include = typeof input.include === 'string' ? ` (include: ${input.include})` : ''
    return `Search "${pattern}" in ${searchPath}${include}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (result.isError && typeof result.content === 'string') {
      return result.content
    }
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      const preview = lines.slice(0, 10).join('\n')
      return lines.length > 10
        ? preview + `\n... (${lines.length - 10} more lines)`
        : preview
    }
    return '(grep results available)'
  },
})

export { GrepTool }
export default GrepTool
