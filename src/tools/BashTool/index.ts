/**
 * BashTool - Execute shell commands with timeout, command guard, and abort support.
 *
 * Security notes:
 *   - Command Guard (pre-flight check) is enabled by default (fail-closed).
 *   - Commands are executed via child_process.spawn with shell: true to
 *     support pipes, redirects, etc.  Callers must sanitise input.
 *   - A configurable timeout (default 120 s) prevents runaway processes.
 *
 * NOTE: The command guard provides heuristic pre-flight checks, NOT
 * OS-level sandboxing.  For true isolation, use containers or OS-level
 * sandboxing (e.g., Docker, Firejail, Seatbelt).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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
import { shouldUseSandbox } from './shouldUseSandbox.js'
import type { BashToolConfig } from './shouldUseSandbox.js'
import {
  runSandboxChecks,
  shouldEnforceSandbox,
  extractFilePaths,
} from '../../utils/sandbox/sandbox-enforcer.js'
import type { SandboxMode } from '../../utils/sandbox/sandbox-enforcer.js'
import type { SandboxRuntimeConfig } from '../../utils/sandbox/sandbox-adapter.js'

// minimatch is loaded dynamically inside checkPermissions to avoid blocking
// the tool registration path with a synchronous CJS require.

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_OUTPUT_BYTES = 1_048_576 // 1 MiB

// ─── Background Task Registry ───────────────────────────────────────────────

interface BackgroundTask {
  id: string
  command: string
  child: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  status: 'running' | 'completed' | 'killed'
  startedAt: number
  finishedAt?: number
}

const backgroundTasks = new Map<string, BackgroundTask>()
let bgTaskCounter = 0

/**
 * Generate a unique background task ID.
 */
function generateBgTaskId(): string {
  bgTaskCounter++
  return `bg_${Date.now().toString(36)}_${bgTaskCounter}`
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Truncate a string to `maxBytes`, appending a notice when truncated.
 */
function truncateOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  const truncated = Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n\n... (output truncated)'
}

/**
 * Build the sandbox config from runtime context.  Reads sandbox state that
 * was injected into `appState` by `assembleRuntime()` in main.ts:
 *   - `sandbox.enabled` / `sandbox.excludedCommands` — basic sandbox toggle
 *   - `sandboxMode` — 'always' | 'never' | 'auto'
 *   - `sandboxRuntimeConfig` — the resolved {@link SandboxRuntimeConfig}
 */
function getSandboxConfig(context: ToolUseContext): BashToolConfig {
  const appSandbox = context.appState['sandbox'] as
    | { enabled?: boolean; excludedCommands?: string[] }
    | undefined

  const sandboxRuntime = context.appState['sandboxRuntimeConfig'] as
    | SandboxRuntimeConfig
    | undefined

  // Sandbox is considered "enabled" when either the basic flag is set or
  // a full runtime config with `enabled: true` was injected.
  const enabled = (appSandbox?.enabled ?? false) || (sandboxRuntime?.enabled ?? false)

  return {
    sandboxEnabled: enabled,
    excludedCommands: appSandbox?.excludedCommands ?? [
      'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'date', 'whoami',
      'hostname', 'uname', 'which', 'type', 'file',
    ],
  }
}

/**
 * Read the resolved {@link SandboxRuntimeConfig} from appState, if present.
 */
function getRuntimeSandboxConfig(context: ToolUseContext): SandboxRuntimeConfig | undefined {
  return context.appState['sandboxRuntimeConfig'] as SandboxRuntimeConfig | undefined
}

/**
 * Read the sandbox mode from appState (defaults to 'auto').
 */
function getSandboxMode(context: ToolUseContext): SandboxMode {
  const mode = context.appState['sandboxMode'] as SandboxMode | undefined
  return mode ?? 'auto'
}

/**
 * Normalise a timeout value from user input, clamping to safe bounds.
 */
function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(value, MAX_TIMEOUT_MS)
}

/**
 * Start a command in the background and return immediately with a task ID.
 * The task continues to run and can be polled via `bash_id`.
 */
function startBackgroundTask(
  command: string,
  context: ToolUseContext,
  onProgress?: (progress: ToolProgressData) => void,
): ToolResult {
  const isWindows = process.platform === 'win32'
  const taskId = generateBgTaskId()

  let spawnCommand: string
  let spawnArgs: string[]

  if (isWindows) {
    const utf8Prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    spawnCommand = 'powershell.exe'
    spawnArgs = ['-NoProfile', '-Command', utf8Prefix + command]
  } else {
    spawnCommand = '/bin/sh'
    spawnArgs = ['-c', command]
  }

  const child = spawn(spawnCommand, spawnArgs, {
    cwd: context.cwd,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      ...(isWindows ? {} : { LANG: (process.env as Record<string, string | undefined>)['LANG'] ?? 'en_US.UTF-8' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWindows, // Detach on Unix for true background execution
  })

  const task: BackgroundTask = {
    id: taskId,
    command,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'running',
    startedAt: Date.now(),
  }

  // Capture output asynchronously
  child.stdout?.on('data', (chunk: Buffer) => {
    task.stdout += chunk.toString('utf-8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    task.stderr += chunk.toString('utf-8')
  })
  child.on('close', (code) => {
    task.exitCode = code
    task.status = code === null ? 'killed' : 'completed'
    task.finishedAt = Date.now()
  })
  child.on('error', () => {
    task.status = 'killed'
    task.finishedAt = Date.now()
  })

  // Unref so the child doesn't keep the parent process alive
  child.unref()

  backgroundTasks.set(taskId, task)
  onProgress?.({ status: 'done', progress: 1 })

  return {
    content:
      `Background task started.\n` +
      `  ID: ${taskId}\n` +
      `  Command: ${command}\n\n` +
      `Use bash_id: "${taskId}" to check status or retrieve output.`,
    isError: false,
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const BashTool = buildTool({
  name: 'Bash',

  description:
    'Execute a shell command and return its output. ' +
    'Commands run in the project working directory by default. ' +
    'A timeout (default 120 s) is enforced; long-running commands should be ' +
    'backgrounded explicitly. Standard output and standard error are both captured.',

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      description: {
        type: 'string',
        description: 'A short, human-readable description of what the command does.',
      },
      timeout: {
        type: 'number',
        description:
          `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
      },
      run_in_background: {
        type: 'boolean',
        description:
          'When true, run the command in the background and return immediately with a bash_id. ' +
          'Use the bash_id to check status or retrieve output later.',
      },
      bash_id: {
        type: 'string',
        description:
          'ID of a previously started background task. When provided, returns the current ' +
          'status and output of that task instead of executing a new command.',
      },
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description:
          'When true, bypasses the sandbox for this invocation. Use with extreme caution.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: false,
  isReadOnly: false,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }

    // Lazy-load minimatch on first permission check to avoid blocking tool
    // registration with a synchronous CJS require.
    const { minimatch } = await import('minimatch')

    const command = typeof input.command === 'string' ? input.command : ''

    // Extract the first token (command name) for prefix matching.
    const firstToken = command.trim().split(/\s+/)[0] ?? ''

    // Deny-list takes precedence (glob patterns + first-token prefix)
    if (context.denyList.some((pattern) =>
      minimatch(firstToken, pattern) || minimatch(command, pattern),
    )) {
      return { behavior: 'deny', message: 'Command matches a deny-list entry.' }
    }

    // Enforce path boundaries — extract file paths from the command string
    // using the sandbox-enforcer's extractor (handles bare relative paths like
    // `.env`, `.git/config`, etc. that the old regex missed).  Applied before
    // mode-based shortcuts so protected paths are always blocked regardless
    // of permission mode.
    const cwd = context.cwd
    const allowOutsideCwd = context.permissionMode === 'bypassPermissions'
    const extractedPaths = extractFilePaths(command)

    for (const p of extractedPaths) {
      const pathCheck = checkPathAccessSync(p, { cwd, allowOutsideCwd })
      if (!pathCheck.allowed) {
        return { behavior: 'deny', message: `Bash command accesses protected path: ${pathCheck.reason}` }
      }
    }

    // Also check for known protected filenames/directories anywhere in the
    // command string — catches cases where extractFilePaths may not detect
    // a bare relative reference (e.g. `cat .env`, `rm .git/config`).
    const PROTECTED_FILENAMES = ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', '.gitconfig']
    const PROTECTED_DIRS = ['.git', '.ssh', '.gnupg', '.aws', '.kube', 'credentials']

    for (const protected_ of [...PROTECTED_FILENAMES, ...PROTECTED_DIRS]) {
      const escaped = protected_.replace(/\./g, '\\.')
      const pattern = new RegExp(`(?:^|\\s|[/\\\\])${escaped}(?:\\s|$|[/\\\\])`, 'i')
      if (pattern.test(command)) {
        const pathCheck = checkPathAccessSync(protected_, { cwd, allowOutsideCwd })
        if (!pathCheck.allowed) {
          return { behavior: 'deny', message: `Bash command references protected path "${protected_}": ${pathCheck.reason}` }
        }
      }
    }

    // Allow-list grants automatic approval
    if (context.allowList.some((pattern) =>
      minimatch(firstToken, pattern) || minimatch(command, pattern),
    )) {
      return { behavior: 'allow' }
    }

    // In bypass mode, auto-allow everything else
    if (context.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow' }
    }

    // Default: ask the user
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
    // ── Background task status check ──────────────────────────────────────
    const bashId = input.bash_id as string | undefined
    if (bashId) {
      const task = backgroundTasks.get(bashId)
      if (!task) {
        return { content: `Background task "${bashId}" not found.`, isError: true }
      }

      const trimmedStdout = task.stdout.trim()
      const trimmedStderr = task.stderr.trim()
      const parts: string[] = [
        `Task: ${task.id}`,
        `Command: ${task.command}`,
        `Status: ${task.status}`,
      ]

      if (task.exitCode !== null) {
        parts.push(`Exit code: ${task.exitCode}`)
      }

      if (task.finishedAt) {
        const elapsed = ((task.finishedAt - task.startedAt) / 1000).toFixed(1)
        parts.push(`Duration: ${elapsed}s`)
      } else {
        const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1)
        parts.push(`Running for: ${elapsed}s`)
      }

      if (trimmedStdout) {
        parts.push(`\n[stdout]\n${truncateOutput(trimmedStdout, MAX_OUTPUT_BYTES)}`)
      }
      if (trimmedStderr) {
        parts.push(`\n[stderr]\n${truncateOutput(trimmedStderr, MAX_OUTPUT_BYTES)}`)
      }

      // Clean up completed tasks from registry
      if (task.status !== 'running') {
        backgroundTasks.delete(bashId)
      }

      return { content: parts.join('\n'), isError: task.status === 'killed' }
    }

    const command = input.command as string
    if (!command || typeof command !== 'string') {
      return {
        content: 'Error: `command` is required and must be a non-empty string.',
        isError: true,
      }
    }

    // ── Background execution ────────────────────────────────────────────────
    if (input.run_in_background === true) {
      return startBackgroundTask(command, context, onProgress)
    }

    // ── Dangerous command patterns ──────────────────────────────────────────
    // Block commands that match known destructive patterns.  This is a
    // best-effort safety net — not a substitute for proper sandboxing.
    const DANGEROUS_PATTERNS = [
      /\brm\s+(-\w*\s+)*-?\w*r\w*\s+(-\w*\s+)*\//,  // rm -rf /
      /\bmkfs\b/,
      /\bdd\s+.*of=\/dev\//,
      /:(){ :\|:& };:/, // fork bomb
      /\bchmod\s+-R\s+777\s+\//,
      /\bcurl\b.*\|\s*(ba)?sh\b/,  // curl | sh
      /\bwget\b.*\|\s*(ba)?sh\b/,  // wget | sh
    ]

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          content: `Command blocked by safety policy: matches dangerous pattern ${pattern}`,
          isError: true,
        }
      }
    }

    const timeoutMs = normalizeTimeout(input.timeout)
    const cwd = context.cwd
    const sandboxConfig = getSandboxConfig(context)
    const useSandbox = shouldUseSandbox(
      { command, dangerouslyDisableSandbox: input.dangerouslyDisableSandbox as boolean | undefined },
      sandboxConfig,
    )

    // ── Sandbox enforcement ──────────────────────────────────────────────
    // When sandboxing is active, run the full pre-flight check suite from
    // the sandbox-enforcer.  This validates filesystem access, network
    // rules, git-internal protection, and sanitises the environment.
    let spawnEnv: Record<string, string | undefined> = process.env

    if (useSandbox) {
      const mode = getSandboxMode(context)

      if (shouldEnforceSandbox(command, mode)) {
        const runtimeConfig = getRuntimeSandboxConfig(context)
        if (runtimeConfig) {
          const check = runSandboxChecks(command, runtimeConfig)

          if (!check.allowed) {
            const reasonText = check.reasons.join('\n  - ')
            return {
              content:
                `Sandbox blocked this command (risk: ${check.riskLevel}):\n  - ${reasonText}`,
              isError: true,
            }
          }

          // Use the sanitised environment when spawning.
          if (check.sanitizedEnv) {
            spawnEnv = check.sanitizedEnv
          }
        }
      }
    }

    onProgress?.({ status: 'executing', progress: 0 })

    // ── Build spawn arguments ─────────────────────────────────────────────
    //
    // Windows encoding fix:
    //   cmd.exe defaults to the system ANSI codepage (e.g. GBK/CP936 on
    //   Chinese Windows).  Since Node.js reads stdout/stderr as UTF-8, the
    //   bytes are garbled.  We use PowerShell instead, which supports
    //   [Console]::OutputEncoding = UTF8 natively.
    //
    //   Additionally we set `PYTHONIOENCODING` so that child processes
    //   spawned by the shell also default to UTF-8.
    //
    const isWindows = process.platform === 'win32'

    let spawnCommand: string
    let spawnArgs: string[]

    if (isWindows) {
      // PowerShell with UTF-8 output encoding
      const utf8Prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
      spawnCommand = 'powershell.exe'
      spawnArgs = ['-NoProfile', '-Command', utf8Prefix + command]
    } else {
      spawnCommand = '/bin/sh'
      spawnArgs = ['-c', command]
    }

    // ── Execute ───────────────────────────────────────────────────────────
    return new Promise<ToolResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      let settled = false

      try {
        const child: ChildProcess = spawn(spawnCommand, spawnArgs, {
          cwd,
          env: {
            ...spawnEnv,
            // Force UTF-8 for child processes on all platforms
            PYTHONIOENCODING: 'utf-8',
            ...(isWindows ? {} : { LANG: (spawnEnv as Record<string, string | undefined>)['LANG'] ?? 'en_US.UTF-8' }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })

        // ── Timeout handling ────────────────────────────────────────────────
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          // Force-kill after 5 s grace period
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL')
          }, 5_000)
        }, timeoutMs)

        // ── Abort signal handling ───────────────────────────────────────────
        let abortKillTimer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          aborted = true
          child.kill('SIGTERM')
          // Force-kill after 5 s grace period (mirrors timeout handler)
          abortKillTimer = setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL')
          }, 5_000)
        }
        context.abortController.signal.addEventListener('abort', onAbort, { once: true })

        // ── Stream capture ──────────────────────────────────────────────────
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8')
        })

        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })

        // ── Completion ──────────────────────────────────────────────────────
        child.on('close', (code, _signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (abortKillTimer) clearTimeout(abortKillTimer)
          context.abortController.signal.removeEventListener('abort', onAbort)

          onProgress?.({ status: 'done', progress: 1 })

          // Build output sections
          const parts: string[] = []

          if (timedOut) {
            parts.push(`Process killed: timed out after ${timeoutMs / 1000}s.`)
          } else if (aborted) {
            parts.push('Process killed: aborted by user.')
          }

          const trimmedStdout = stdout.trim()
          const trimmedStderr = stderr.trim()

          if (trimmedStdout) {
            parts.push(truncateOutput(trimmedStdout, MAX_OUTPUT_BYTES))
          }

          if (trimmedStderr) {
            parts.push(`[stderr]\n${truncateOutput(trimmedStderr, MAX_OUTPUT_BYTES)}`)
          }

          if (code !== null && code !== 0) {
            parts.push(`Exit code: ${code}`)
          }

          const output = parts.length > 0 ? parts.join('\n\n') : '(no output)'

          resolve({
            content: output,
            isError: timedOut || aborted || (code !== null && code !== 0),
          })
        })

        child.on('error', (err: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (abortKillTimer) clearTimeout(abortKillTimer)
          context.abortController.signal.removeEventListener('abort', onAbort)

          resolve({
            content: `Failed to execute command: ${err.message}`,
            isError: true,
          })
        })
      } catch (err) {
        // spawn() itself threw (e.g. invalid arguments, ENOENT on shell binary).
        // Resolve with an error result rather than rejecting the Promise so the
        // caller's error-handling path is consistent.
        if (!settled) {
          settled = true
          resolve({
            content: `Failed to execute command: ${String(err)}`,
            isError: true,
          })
        }
      }
    })
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'Bash',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const command = typeof input.command === 'string' ? input.command : ''
    const description = typeof input.description === 'string' ? input.description : ''
    const preview = command.length > 120 ? command.slice(0, 117) + '...' : command
    if (description) {
      return `${description}\n$ ${preview}`
    }
    return `$ ${preview}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      if (lines.length <= 10) return result.content
      return lines.slice(0, 10).join('\n') + `\n... (${lines.length - 10} more lines)`
    }
    return '(output available)'
  },
})

export default BashTool
