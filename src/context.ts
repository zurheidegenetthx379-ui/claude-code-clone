/**
 * Runtime context injection.
 *
 * Gathers per-session contextual information that is injected into the
 * conversation alongside (but separately from) the system prompt.  The
 * distinction matters:
 *
 *  - The **system prompt** is (mostly) stable and lives in the `system`
 *    parameter of the API call.
 *  - The **context message** is a user-role message inserted at the
 *    beginning of the conversation so the model always has fresh
 *    environment data (git status, current date, project memory) even
 *    after context compression drops early messages.
 *
 * This module provides:
 *  - `getUserContext(cwd)`      – project memory + current date
 *  - `getSystemContext(cwd)`    – git status, platform, shell
 *  - `buildContextMessage(...)` – format both into an injectable message
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

// ============================================================
// Types
// ============================================================

/**
 * User-level context: project memory file content and the current date.
 */
export interface UserContext {
  /** Concatenated contents of memory files found in the project tree, or null. */
  agentMd: string | null
  /** ISO-8601 date string (YYYY-MM-DD). */
  currentDate: string
}

/**
 * System-level context: git status and basic platform information.
 */
export interface SystemContext {
  /** Output of `git status --short`, or null if not inside a git repo. */
  gitStatus: string | null
  /** Operating-system platform string (e.g. "darwin", "linux", "win32"). */
  platform: string
  /** Current shell (from SHELL or COMSPEC env var). */
  shell: string
}

// ============================================================
// Memory file constants
// ============================================================

/**
 * Filenames recognised as project memory files, checked in priority order.
 *
 * When multiple files exist in the same directory they are concatenated
 * (with headers).  When files exist in different directories (e.g. a root
 * CLAUDE.md and a sub-directory AGENTS.md), all discovered files are
 * concatenated in the order they are found.
 */
const MEMORY_FILE_NAMES = ['CLAUDE.md', '.cc-agent.md', 'AGENTS.md'] as const

/**
 * Maximum number of parent directories to walk upward when scanning for
 * memory files.  Prevents runaway traversal on deeply nested or symlinked
 * directory trees.
 */
const MAX_DIRECTORY_SCAN_DEPTH = 10

// ============================================================
// getUserContext
// ============================================================

/**
 * Scan the project tree rooted at `cwd` for recognised memory files and
 * return their concatenated content together with the current date.
 *
 * Scan strategy:
 *  1. Walk *up* from `cwd` to the filesystem root (bounded by
 *     `MAX_DIRECTORY_SCAN_DEPTH`) looking for memory files in each
 *     directory.  Files found in higher (more general) directories are
 *     prepended before files found in lower (more specific) ones.
 *  2. Also scan `cwd` itself.
 *
 * @param cwd - The working directory of the current session.
 */
export async function getUserContext(cwd: string): Promise<UserContext> {
  const memoryContents = await findMemoryFiles(cwd)

  return {
    agentMd: memoryContents.length > 0 ? memoryContents.join('\n\n') : null,
    currentDate: new Date().toISOString().split('T')[0]!,
  }
}

// ============================================================
// getSystemContext
// ============================================================

/**
 * Gather system-level context: git status and platform metadata.
 *
 * The git status is obtained by running `git status --short` inside `cwd`.
 * If the directory is not inside a git repository the value is `null`
 * rather than an error.
 *
 * @param cwd - The working directory of the current session.
 */
export async function getSystemContext(cwd: string): Promise<SystemContext> {
  const gitStatus = await getGitStatus(cwd)

  return {
    gitStatus,
    platform: process.platform,
    shell: process.env.SHELL ?? process.env.COMSPEC ?? 'unknown',
  }
}

// ============================================================
// buildContextMessage
// ============================================================

/**
 * Format user and system context into a single string that can be injected
 * as a user-role message at the start of the conversation.
 *
 * Sections that carry no useful data (e.g. `agentMd` is null,
 * `gitStatus` is null) are silently omitted to keep the message lean.
 *
 * @param userCtx - User-level context from `getUserContext`.
 * @param sysCtx  - System-level context from `getSystemContext`.
 */
export function buildContextMessage(
  userCtx: UserContext,
  sysCtx: SystemContext,
): string {
  const lines: string[] = []

  lines.push('<environment>')

  // System sub-section
  lines.push(`<platform>${sysCtx.platform}</platform>`)
  lines.push(`<shell>${sysCtx.shell}</shell>`)

  if (sysCtx.gitStatus !== null) {
    lines.push('<git-status>')
    lines.push(sysCtx.gitStatus)
    lines.push('</git-status>')
  }

  lines.push(`<current-date>${userCtx.currentDate}</current-date>`)
  lines.push('</environment>')

  // Agent memory sub-section
  if (userCtx.agentMd !== null) {
    lines.push('')
    lines.push('<agent-instructions>')
    lines.push(userCtx.agentMd)
    lines.push('</agent-instructions>')
  }

  return lines.join('\n')
}

// ============================================================
// Loaded Context File Discovery
// ============================================================

/**
 * Metadata about a single context file that was found during scanning.
 */
export interface LoadedContextFile {
  /** File name (e.g. "CLAUDE.md"). */
  fileName: string
  /** Directory containing the file. */
  dirPath: string
  /** Full absolute path to the file. */
  filePath: string
  /** File size in bytes. */
  sizeBytes: number
}

/**
 * Scan the project tree for recognised memory files and return metadata
 * about which files were found (without reading full content).
 *
 * Uses the same scan strategy as `getUserContext` but is much cheaper —
 * only performs `stat` calls instead of full file reads.
 *
 * @param cwd - The working directory of the current session.
 */
export async function findLoadedContextFiles(cwd: string): Promise<LoadedContextFile[]> {
  const found: LoadedContextFile[] = []

  const dirsToScan: string[] = []
  let currentDir = path.resolve(cwd)

  for (let i = 0; i < MAX_DIRECTORY_SCAN_DEPTH; i++) {
    dirsToScan.push(currentDir)
    const parent = path.dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }

  dirsToScan.reverse()

  for (const dir of dirsToScan) {
    for (const fileName of MEMORY_FILE_NAMES) {
      const filePath = path.join(dir, fileName)
      try {
        const st = fs.statSync(filePath)
        if (st.isFile() && st.size > 0) {
          found.push({ fileName, dirPath: dir, filePath, sizeBytes: st.size })
        }
      } catch {
        // File does not exist or is not accessible — skip.
      }
    }
  }

  return found
}

/**
 * Re-read all context files and rebuild the context block string.
 *
 * Convenience function for mid-session context refresh — combines
 * `findMemoryFiles` (via `getUserContext`) and `buildContextMessage`
 * in a single call.
 *
 * @param cwd - The working directory of the current session.
 */
export async function reloadContextBlock(cwd: string): Promise<string> {
  const userCtx = await getUserContext(cwd)
  const sysCtx = await getSystemContext(cwd)
  return buildContextMessage(userCtx, sysCtx)
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Walk up from `cwd` looking for memory files.
 *
 * Returns an array of file contents (with filename headers), ordered so
 * that files from higher (more general) directories appear first.
 */
async function findMemoryFiles(cwd: string): Promise<string[]> {
  const contents: string[] = []

  // Collect directories to scan, starting from `cwd` and walking up.
  const dirsToScan: string[] = []
  let currentDir = path.resolve(cwd)

  for (let i = 0; i < MAX_DIRECTORY_SCAN_DEPTH; i++) {
    dirsToScan.push(currentDir)

    const parent = path.dirname(currentDir)
    if (parent === currentDir) {
      // Reached the filesystem root.
      break
    }
    currentDir = parent
  }

  // Reverse so that the most-general directory is processed first.
  dirsToScan.reverse()

  for (const dir of dirsToScan) {
    for (const fileName of MEMORY_FILE_NAMES) {
      const filePath = path.join(dir, fileName)

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8')
        const trimmed = content.trim()

        if (trimmed.length > 0) {
          contents.push(
            [
              `# ${fileName} (${dir})`,
              '',
              trimmed,
            ].join('\n'),
          )
        }
      } catch {
        // File does not exist or is not readable — silently skip.
      }
    }
  }

  return contents
}

/**
 * Run `git status --short` in the given directory.
 *
 * Returns the trimmed stdout on success, or `null` when:
 *  - the directory is not inside a git repository,
 *  - git is not installed, or
 *  - any other error occurs.
 */
async function getGitStatus(cwd: string): Promise<string | null> {
  try {
    const result = execSync('git status --short', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    })

    const trimmed = result.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    // Not a git repo, git not installed, or command timed out.
    return null
  }
}
