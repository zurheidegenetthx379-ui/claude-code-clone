/**
 * FileReadTool - Read file contents with line-based offset/limit and image support.
 *
 * Behaviour:
 *   - Text files: returned with line numbers (cat -n style).
 *   - Binary / image files: returned as base64-encoded data with a media type.
 *   - Offset and limit are *1-based line numbers* to match editor conventions.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { extname } from 'node:path'
import minimatch from 'minimatch'
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
  ContentBlock,
} from '../../types/index.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20 MiB
const DEFAULT_LINE_LIMIT = 2000

/** Extensions we treat as images (returns base64 content block). */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif',
])

/** Extensions we treat as definitively binary (error instead of garbled text). */
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
])

// ─── Helpers ────────────────────────────────────────────────────────────────

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/**
 * Guess the MIME type from a file extension for image content blocks.
 */
function imageMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
  }
  return map[ext.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Add 1-based line numbers to text, matching `cat -n` output.
 */
function addLineNumbers(text: string, startLine: number): string {
  const lines = text.split('\n')
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, i) => {
      const num = String(startLine + i).padStart(width)
      return `${num}\t${line}`
    })
    .join('\n')
}

/**
 * Resolve a potentially relative path against the working directory.
 */
function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const FileReadTool = buildTool({
  name: 'FileRead',

  description:
    'Read the contents of a file from the local filesystem. ' +
    'Text files are returned with line numbers. ' +
    'Image files are returned as base64-encoded data. ' +
    'Use `offset` (1-based line number) and `limit` (max lines) to read ' +
    'a subset of a large file.',

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or cwd-relative path to the file to read.',
      },
      offset: {
        type: 'number',
        description: '1-based line number to start reading from (default: 1).',
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return (default: ${DEFAULT_LINE_LIMIT}).`,
      },
    },
    required: ['file_path'],
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
    const filePath = typeof input.file_path === 'string' ? input.file_path : ''

    if (context.denyList.some((p) => minimatch(filePath, p, { dot: true }) || filePath.includes(p))) {
      return { behavior: 'deny', message: 'File path matches deny-list entry.' }
    }

    // Enforce path boundaries (protected paths, cwd containment).
    const pathCheck = checkPathAccessSync(filePath, {
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
    // ── Validate input ────────────────────────────────────────────────────
    const rawPath = input.file_path
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { content: 'Error: `file_path` is required and must be a non-empty string.', isError: true }
    }

    const filePath = resolvePath(rawPath, context.cwd)
    const offset = typeof input.offset === 'number' && input.offset >= 1 ? Math.floor(input.offset) : 1
    const limit = typeof input.limit === 'number' && input.limit >= 1
      ? Math.min(Math.floor(input.limit), 10_000)
      : DEFAULT_LINE_LIMIT

    onProgress?.({ status: 'reading' })

    // ── Stat check ────────────────────────────────────────────────────────
    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `Error: File not found: ${filePath}`, isError: true }
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied reading file: ${filePath}`, isError: true }
      }
      return { content: `Error accessing file: ${msg}`, isError: true }
    }

    if (!fileStat.isFile()) {
      return { content: `Error: Path is not a regular file: ${filePath}`, isError: true }
    }

    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        content: `Error: File too large (${(fileStat.size / 1024 / 1024).toFixed(1)} MiB, max ${MAX_FILE_BYTES / 1024 / 1024} MiB). Use offset/limit to read portions.`,
        isError: true,
      }
    }

    // ── Image handling ────────────────────────────────────────────────────
    if (isImageFile(filePath)) {
      try {
        const buffer = await readFile(filePath)
        const ext = extname(filePath)
        const mediaType = imageMimeType(ext)
        const base64 = buffer.toString('base64')

        const imageBlock: ContentBlock = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: base64,
          },
        }

        return {
          content: [imageBlock],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error reading image: ${msg}`, isError: true }
      }
    }

    // ── Binary file guard ─────────────────────────────────────────────────
    if (isBinaryFile(filePath)) {
      return {
        content: `Error: ${filePath} appears to be a binary file and cannot be displayed as text.`,
        isError: true,
      }
    }

    // ── Text file reading ─────────────────────────────────────────────────
    try {
      const raw = await readFile(filePath, 'utf-8')
      const allLines = raw.split('\n')
      const totalLines = allLines.length

      // Slice to requested range (offset is 1-based)
      const startIdx = offset - 1
      const endIdx = Math.min(startIdx + limit, totalLines)
      const slice = allLines.slice(startIdx, endIdx)

      // Add line numbers starting from `offset`
      const numbered = addLineNumbers(slice.join('\n'), offset)

      // If we truncated, add a hint
      const truncated = endIdx < totalLines
      const hint = truncated
        ? `\n\n... (${totalLines - endIdx} more lines; total ${totalLines} lines. Increase limit or use offset to read more.)`
        : ''

      return { content: numbered + hint }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied reading file: ${filePath}`, isError: true }
      }
      return { content: `Error reading file: ${msg}`, isError: true }
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Read',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '<unknown>'
    const offset = typeof input.offset === 'number' ? ` (offset: ${input.offset})` : ''
    const limit = typeof input.limit === 'number' ? ` (limit: ${input.limit})` : ''
    return `Read ${filePath}${offset}${limit}`
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
    return '(file content read)'
  },
})

export default FileReadTool
