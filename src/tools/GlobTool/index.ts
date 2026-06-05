/**
 * GlobTool - Fast file pattern matching using glob syntax.
 *
 * Behaviour:
 *   - Matches files using glob patterns like `**\/*.ts`, `src/**\/*.{js,jsx}`, etc.
 *   - Results are sorted by modification time (newest first) for relevance.
 *   - Limited to 100 results to keep output manageable.
 *   - Read-only operation safe for concurrent execution.
 */

import { statSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { glob } from 'glob'
import { buildTool } from '../../Tool.js'
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

const MAX_RESULTS = 100

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a potentially relative path against the working directory.
 */
function resolvePath(searchPath: string, cwd: string): string {
  return isAbsolute(searchPath) ? searchPath : resolve(cwd, searchPath)
}

/**
 * Safely get the modification time of a file, returning 0 on error.
 */
function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const GlobTool = buildTool({
  name: 'Glob',

  description:
    'Find files matching a glob pattern. ' +
    'Results are sorted by modification time (newest first) and limited to 100 files. ' +
    'Use patterns like `**/*.ts` to match TypeScript files recursively, ' +
    '`src/**/*.js` to match JS files under src/, etc.',

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against (e.g. `**/*.ts`, `src/**/*.{js,jsx}`).',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the current working directory.',
      },
      dot: {
        type: 'boolean',
        description: 'Include files/directories starting with `.` (default: false).',
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

    const searchPath = typeof input.path === 'string' ? input.path : ''

    if (context.denyList.some((p) => searchPath.includes(p))) {
      return { behavior: 'deny', message: 'Search path matches deny-list entry.' }
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
    // ── Validate input ────────────────────────────────────────────────────
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return {
        content: 'Error: `pattern` is required and must be a non-empty string.',
        isError: true,
      }
    }

    const rawPath = typeof input.path === 'string' ? input.path : '.'
    const searchPath = resolvePath(rawPath, context.cwd)
    const dot = typeof input.dot === 'boolean' ? input.dot : false

    onProgress?.({ status: 'searching' })

    // ── Execute glob ──────────────────────────────────────────────────────
    try {
      const matches = glob.sync(pattern, {
        cwd: searchPath,
        dot,
        nodir: true,
        absolute: true,
      })

      if (matches.length === 0) {
        return { content: `No files found matching pattern: ${pattern}` }
      }

      // ── Sort by modification time (newest first) ────────────────────────
      const withMtime = matches.map((filePath) => ({
        path: filePath,
        mtimeMs: getMtimeMs(filePath),
      }))

      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)

      // ── Limit results ───────────────────────────────────────────────────
      const limited = withMtime.slice(0, MAX_RESULTS)

      // ── Format output ───────────────────────────────────────────────────
      const lines = limited.map((item, index) => {
        const num = String(index + 1).padStart(String(limited.length).length)
        return `${num}. ${item.path}`
      })

      let output = lines.join('\n')

      if (matches.length > MAX_RESULTS) {
        output += `\n\n... (${matches.length - MAX_RESULTS} more files not shown; ${matches.length} total matches)`
      }

      onProgress?.({ status: 'done', progress: 1 })

      return { content: output }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error executing glob: ${msg}`, isError: true }
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Glob',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '<unknown>'
    const path = typeof input.path === 'string' ? ` (path: ${input.path})` : ''
    return `Glob ${pattern}${path}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (result.isError && typeof result.content === 'string') {
      return result.content
    }
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      const preview = lines.slice(0, 5).join('\n')
      return lines.length > 5 ? preview + '\n...' : preview
    }
    return '(glob results available)'
  },
})

export { GlobTool }
export default GlobTool
