/**
 * BashTool - Execute shell commands with timeout, sandbox, and abort support.
 *
 * Security notes:
 *   - Sandbox is enabled by default (fail-closed).
 *   - Commands are executed via child_process.spawn with shell: true to
 *     support pipes, redirects, etc.  Callers must sanitise input.
 *   - A configurable timeout (default 120 s) prevents runaway processes.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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
import { shouldUseSandbox } from './shouldUseSandbox.js'
import type { BashToolConfig } from './shouldUseSandbox.js'
import {
  runSandboxChecks,
  shouldEnforceSandbox,
} from '../../utils/sandbox/sandbox-enforcer.js'
import type { SandboxMode } from '../../utils/sandbox/sandbox-enforcer.js'
import type { SandboxRuntimeConfig } from '../../utils/sandbox/sandbox-adapter.js'

// Dynamic minimatch import for glob-pattern permission matching.
import minimatch from 'minimatch'

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_OUTPUT_BYTES = 1_048_576 // 1 MiB

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
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description:
          'When true, bypasses the sandbox for this invocation. Use with extreme caution.',
      },
    },
    required: ['command'],
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

    const command = typeof input.command === 'string' ? input.command : ''

    // Extract the first token (command name) for prefix matching.
    const firstToken = command.trim().split(/\s+/)[0] ?? ''

    // Deny-list takes precedence (glob patterns + first-token prefix)
    if (context.denyList.some((pattern) =>
      minimatch(firstToken, pattern) || minimatch(command, pattern),
    )) {
      return { behavior: 'deny', message: 'Command matches a deny-list entry.' }
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
    const command = input.command as string
    if (!command || typeof command !== 'string') {
      return {
        content: 'Error: `command` is required and must be a non-empty string.',
        isError: true,
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
      let killed = false
      let settled = false

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
        killed = true
        child.kill('SIGTERM')
        // Force-kill after 5 s grace period
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5_000)
      }, timeoutMs)

      // ── Abort signal handling ───────────────────────────────────────────
      const onAbort = () => {
        killed = true
        child.kill('SIGTERM')
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
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.abortController.signal.removeEventListener('abort', onAbort)

        onProgress?.({ status: 'done', progress: 1 })

        // Build output sections
        const parts: string[] = []

        if (killed && signal) {
          parts.push(`Process killed (timed out after ${timeoutMs / 1000}s).`)
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
          isError: code !== null && code !== 0,
        })
      })

      child.on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.abortController.signal.removeEventListener('abort', onAbort)

        resolve({
          content: `Failed to execute command: ${err.message}`,
          isError: true,
        })
      })
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
