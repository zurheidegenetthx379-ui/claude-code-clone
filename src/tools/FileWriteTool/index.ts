/**
 * FileWriteTool - Write content to a file.
 *
 * Semantics:
 *   - Creates the file if it doesn't exist, or overwrites it if it does.
 *   - Automatically creates parent directories as needed.
 *   - Returns a summary of the write operation (bytes written, line count).
 *
 * For partial edits to existing files, FileEdit should be preferred.
 */

import { writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, isAbsolute, dirname } from 'node:path'
import { buildTool } from '../../Tool.js'
import minimatch from 'minimatch'
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

const MAX_WRITE_BYTES = 50 * 1024 * 1024 // 50 MiB - refuse to write huge files

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const FileWriteTool = buildTool({
  name: 'FileWrite',

  description:
    'Write content to a file. Creates the file if it doesn\'t exist, or overwrites it if it does. ' +
    'Automatically creates parent directories. Use this for creating new files or completely replacing file contents. ' +
    'For partial edits to existing files, prefer FileEdit instead.',

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or cwd-relative path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: false,
  isReadOnly: false,
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

    const content = input.content
    if (typeof content !== 'string') {
      return { content: 'Error: `content` is required and must be a string.', isError: true }
    }

    const filePath = resolvePath(rawPath, context.cwd)

    // ── Size check ────────────────────────────────────────────────────────
    const bytesToWrite = Buffer.byteLength(content, 'utf-8')
    if (bytesToWrite > MAX_WRITE_BYTES) {
      return {
        content: `Error: Content too large (${(bytesToWrite / 1024 / 1024).toFixed(1)} MiB, max ${MAX_WRITE_BYTES / 1024 / 1024} MiB).`,
        isError: true,
      }
    }

    onProgress?.({ status: 'writing' })

    // ── Check if file already exists ──────────────────────────────────────
    let existed = false
    try {
      const fileStat = await stat(filePath)
      existed = fileStat.isFile()
      if (!fileStat.isFile()) {
        return {
          content: `Error: Path exists but is not a regular file: ${filePath}`,
          isError: true,
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error accessing path: ${msg}`, isError: true }
      }
      // File doesn't exist, that's fine — we'll create it.
    }

    // ── Create parent directories ─────────────────────────────────────────
    try {
      await mkdir(dirname(filePath), { recursive: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error creating directories: ${msg}`, isError: true }
    }

    // ── Write the file ────────────────────────────────────────────────────
    try {
      await writeFile(filePath, content, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied writing to: ${filePath}`, isError: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error writing file: ${msg}`, isError: true }
    }

    onProgress?.({ status: 'done', progress: 1 })

    const lines = content.split('\n').length
    const action = existed ? 'overwritten' : 'created'

    return {
      content: `File ${action}: ${filePath} (${lines} lines, ${bytesToWrite} bytes)`,
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Write',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '<unknown>'
    const content = typeof input.content === 'string' ? input.content : ''
    const lineCount = content.split('\n').length
    return `Write ${filePath} (${lineCount} lines)`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      return result.content
    }
    return '(file written)'
  },
})

export default FileWriteTool
