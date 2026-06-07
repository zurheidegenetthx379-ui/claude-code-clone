/**
 * FileListTool — Directory listing tool for browsing project structure.
 *
 * Behaviour:
 *   - Lists files and subdirectories in a given path.
 *   - Supports recursive listing via the `depth` parameter (default: 1).
 *   - Can filter entries by type: `file`, `directory`, or `all` (default: `all`).
 *   - Shows entry name, type, size, and last-modified timestamp.
 *   - Results are capped at 200 entries to keep output manageable.
 *   - Read-only operation safe for concurrent execution.
 */

import { stat } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { resolve, isAbsolute, relative, join, sep } from 'node:path'
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

const MAX_ENTRIES = 200
const DEFAULT_DEPTH = 1
const MAX_DEPTH = 5

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a potentially relative path against the working directory.
 */
function resolvePath(searchPath: string, cwd: string): string {
  return isAbsolute(searchPath) ? searchPath : resolve(cwd, searchPath)
}

/**
 * Human-readable file size formatter.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Format a date as a compact YYYY-MM-DD HH:mm string.
 */
function formatMtime(mtimeMs: number): string {
  const d = new Date(mtimeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface ListEntry {
  path: string
  name: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  mtimeMs: number
}

/**
 * Recursively list directory entries up to the given depth.
 */
async function listDirectory(
  dirPath: string,
  currentDepth: number,
  maxDepth: number,
  filter: 'file' | 'directory' | 'all',
  basePath: string,
): Promise<ListEntry[]> {
  const entries: ListEntry[] = []

  let dirEntries
  try {
    dirEntries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return entries
  }

  for (const entry of dirEntries) {
    const fullPath = join(dirPath, entry.name)
    let entryStat
    try {
      entryStat = await stat(fullPath)
    } catch {
      continue
    }

    const entryType: 'file' | 'directory' | 'symlink' = entry.isDirectory()
      ? 'directory'
      : entry.isSymbolicLink()
        ? 'symlink'
        : 'file'

    // Apply filter
    const passesFilter =
      filter === 'all' ||
      (filter === 'file' && entryType !== 'directory') ||
      (filter === 'directory' && entryType === 'directory')

    if (passesFilter) {
      entries.push({
        path: fullPath,
        name: relative(basePath, fullPath),
        type: entryType,
        size: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
      })
    }

    if (entries.length >= MAX_ENTRIES) break

    // Recurse into subdirectories
    if (entryType === 'directory' && currentDepth < maxDepth) {
      const subEntries = await listDirectory(
        fullPath,
        currentDepth + 1,
        maxDepth,
        filter,
        basePath,
      )
      entries.push(...subEntries)
      if (entries.length >= MAX_ENTRIES) break
    }
  }

  return entries
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const FileListTool = buildTool({
  name: 'FileList',

  description:
    'List files and directories in a given path. ' +
    'Supports recursive listing with the `depth` parameter (1–5). ' +
    'Shows entry name, type, size, and modification time. ' +
    'Results are limited to 200 entries.',

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list. Defaults to the current working directory.',
      },
      depth: {
        type: 'number',
        description: 'Maximum recursion depth (1 = top-level only, default: 1, max: 5).',
      },
      filter: {
        type: 'string',
        enum: ['all', 'file', 'directory'],
        description: 'Filter entries by type (default: "all").',
      },
    },
    required: [],
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
    const rawPath = typeof input.path === 'string' ? input.path : '.'
    const targetPath = resolvePath(rawPath, context.cwd)
    const depth = typeof input.depth === 'number'
      ? Math.min(Math.max(1, input.depth), MAX_DEPTH)
      : DEFAULT_DEPTH
    const filter = (input.filter === 'file' || input.filter === 'directory' || input.filter === 'all')
      ? input.filter as 'file' | 'directory' | 'all'
      : 'all'

    onProgress?.({ status: 'scanning' })

    // Validate path is a directory
    try {
      const dirStat = await stat(targetPath)
      if (!dirStat.isDirectory()) {
        return {
          content: `Error: "${targetPath}" is not a directory.`,
          isError: true,
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: `Error accessing path "${targetPath}": ${msg}`,
        isError: true,
      }
    }

    // ── Execute listing ──────────────────────────────────────────────────
    try {
      const entries = await listDirectory(targetPath, 1, depth, filter, targetPath)

      if (entries.length === 0) {
        return { content: `No entries found in "${targetPath}" (filter: ${filter}).` }
      }

      // Sort: directories first, then files, alphabetically within each group
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })

      // Limit results
      const limited = entries.slice(0, MAX_ENTRIES)

      // ── Format output ──────────────────────────────────────────────────
      const lines: string[] = []
      lines.push(`Directory: ${targetPath}`)
      if (depth > 1) {
        lines.push(`Depth: ${depth} | Filter: ${filter}`)
      }
      lines.push('')

      for (const entry of limited) {
        const typeIcon = entry.type === 'directory' ? '[DIR] ' : '[FILE]'
        const sizeStr = entry.type === 'directory'
          ? ''.padEnd(10)
          : formatSize(entry.size).padStart(10)
        const mtimeStr = formatMtime(entry.mtimeMs)
        lines.push(`${typeIcon} ${sizeStr}  ${mtimeStr}  ${entry.name}`)
      }

      if (entries.length > MAX_ENTRIES) {
        lines.push('')
        lines.push(`... (${entries.length - MAX_ENTRIES} more entries not shown; ${entries.length} total)`)
      }

      lines.push('')
      lines.push(`Total: ${entries.length} entries`)

      onProgress?.({ status: 'done', progress: 1 })

      return { content: lines.join('\n') }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error listing directory: ${msg}`, isError: true }
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'FileList',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const path = typeof input.path === 'string' ? input.path : '.'
    const depth = typeof input.depth === 'number' ? ` (depth: ${input.depth})` : ''
    return `FileList ${path}${depth}`
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
    return '(file list results available)'
  },
})

export { FileListTool }
export default FileListTool
