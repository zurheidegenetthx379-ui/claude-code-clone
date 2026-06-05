/**
 * replLauncher — terminal lifecycle manager for the interactive REPL.
 *
 * Owns every concern that sits *around* the React/Ink component tree:
 *
 *  1. Terminal setup   — enter alternate screen buffer, enable raw mode
 *  2. Store creation    — build an AppStateStore from the supplied options
 *  3. Ink rendering     — mount the REPL component via Ink's `render()`
 *  4. Cleanup on exit   — restore terminal state, disconnect MCP servers,
 *                         release stdin, and report an exit code
 *
 * The launcher is intentionally framework-agnostic about what happens
 * *inside* the REPL component; it only cares about the terminal's
 * lifecycle and the process exit code.
 *
 * Usage:
 * ```ts
 * import { launchRepl } from './replLauncher.js'
 *
 * const exitCode = await launchRepl({
 *   queryEngine: engine,
 *   tools: assembledTools,
 *   systemPrompt: prompt,
 *   cwd: process.cwd(),
 *   sessionId: 'abc-123',
 * })
 *
 * process.exit(exitCode)
 * ```
 */

import React from 'react'
import { render } from 'ink'

import { REPL } from './components/REPL/REPL.js'
import { createAppStateStore } from './state/AppStateStore.js'
import type { AppStateStore } from './state/AppStateStore.js'
import type { QueryEngine } from './QueryEngine.js'
import type {
  Message,
  PermissionContext,
  ToolInstance,
  AgentIdentity,
} from './types/index.js'

// ============================================================
// ANSI escape sequences for alternate screen buffer
// ============================================================

/** Switch to the alternate screen buffer (preserves the original scrollback). */
const ENTER_ALT_SCREEN = '\x1b[?1049h'
/** Restore the primary screen buffer. */
const LEAVE_ALT_SCREEN = '\x1b[?1049l'
/** Hide the terminal cursor. */
const HIDE_CURSOR = '\x1b[?25l'
/** Show the terminal cursor. */
const SHOW_CURSOR = '\x1b[?25h'

// ============================================================
// Launch options
// ============================================================

export interface LaunchReplOptions {
  /** Pre-configured query engine. */
  queryEngine: QueryEngine
  /** Tool definitions available to the agent. */
  tools: ToolInstance[]
  /** The rendered system prompt (for display in /help). */
  systemPrompt: string
  /** Working directory for this session. */
  cwd: string
  /** Unique session identifier. */
  sessionId: string
  /** Permission context. */
  permissionContext: PermissionContext
  /** Optional initial prompt to execute immediately after mount. */
  initialPrompt?: string
  /** Whether to use the alternate screen buffer (default: true). */
  useAlternateScreen?: boolean
  /** Optional pre-existing messages to restore (e.g. from session resume). */
  restoredMessages?: Message[]
  /** Optional current agent identity. */
  currentAgent?: AgentIdentity
}

// ============================================================
// Terminal state tracking (for reliable cleanup)
// ============================================================

interface TerminalState {
  wasRaw: boolean
  wasAlternateScreen: boolean
  cleanupHandlers: Array<() => void>
  cleaned: boolean
}

// ============================================================
// launchRepl
// ============================================================

/**
 * Launch the interactive REPL.
 *
 * Performs terminal setup, renders the Ink component tree, and waits
 * until the user exits (via `/exit`, Ctrl+D, or process signal).
 *
 * @returns A numeric exit code: `0` for a clean exit, `1` for errors.
 */
export async function launchRepl(options: LaunchReplOptions): Promise<number> {
  const useAltScreen = options.useAlternateScreen ?? true
  const terminal: TerminalState = {
    wasRaw: false,
    wasAlternateScreen: false,
    cleanupHandlers: [],
    cleaned: false,
  }

  // ----------------------------------------------------------------
  // 1. Terminal setup
  // ----------------------------------------------------------------

  try {
    setupTerminal(useAltScreen, terminal)
  } catch (err) {
    // Terminal setup is best-effort; if it fails (e.g. non-TTY stdin)
    // we still attempt to run the REPL in degraded mode.
    process.stderr.write(
      `[replLauncher] Warning: terminal setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // ----------------------------------------------------------------
  // 2. Create the AppStateStore
  // ----------------------------------------------------------------

  const store: AppStateStore = createAppStateStore({
    messages: options.restoredMessages ?? [],
    tools: options.tools,
    permissionContext: options.permissionContext,
    sessionId: options.sessionId,
    cwd: options.cwd,
    currentAgent: options.currentAgent,
    isLoading: false,
    compacted: false,
    notifications: [],
    agents: [],
    mcpClients: new Map(),
  })

  // Seed the store with any restored messages.
  if (options.restoredMessages) {
    for (const msg of options.restoredMessages) {
      store.addMessage(msg)
    }
  }

  // ----------------------------------------------------------------
  // 3. Render the REPL via Ink
  // ----------------------------------------------------------------

  let exitCode = 0

  // The Ink render call returns an `unmount` function and a `waitUntilExit`
  // promise that resolves when `instance.unmount()` is called (which the
  // REPL component triggers via `useApp().exit()`).
  const { unmount, waitUntilExit } = render(
    React.createElement(REPL, {
      queryEngine: options.queryEngine,
      tools: options.tools,
      systemPrompt: options.systemPrompt,
      store,
      initialPrompt: options.initialPrompt,
    }),
    {
      // Ink v5 automatically patches process.stdout/stderr; we still
      // manage the alternate screen buffer ourselves for finer control.
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      exitOnCtrlC: false, // We handle Ctrl+C ourselves inside REPL.tsx.
    },
  )

  // Register cleanup so it runs regardless of how we exit.
  terminal.cleanupHandlers.push(() => {
    try {
      unmount()
    } catch {
      // Ink may have already torn down; ignore double-unmount.
    }
  })

  // ----------------------------------------------------------------
  // 4. Wait for the REPL to exit
  // ----------------------------------------------------------------

  try {
    await waitUntilExit()
  } catch (err) {
    // An error bubbled up from the React tree.
    process.stderr.write(
      `\n[replLauncher] REPL error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    exitCode = 1
  }

  // ----------------------------------------------------------------
  // 5. Cleanup
  // ----------------------------------------------------------------

  cleanupTerminal(terminal, useAltScreen)

  return exitCode
}

// ============================================================
// Terminal setup
// ============================================================

/**
 * Prepare the terminal for full-screen Ink rendering.
 *
 * - Enter the alternate screen buffer (so scrollback is preserved)
 * - Enable raw mode on stdin (so Ink receives every keystroke)
 * - Register signal handlers for graceful cleanup
 */
function setupTerminal(
  useAltScreen: boolean,
  terminal: TerminalState,
): void {
  const stdin = process.stdin

  // Enter alternate screen buffer.
  if (useAltScreen && process.stdout.isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN)
    terminal.wasAlternateScreen = true
  }

  // Enable raw mode so Ink can intercept every key press.
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
    terminal.wasRaw = true
  }

  // Hide the hardware cursor while Ink manages its own cursor.
  if (process.stdout.isTTY) {
    process.stdout.write(HIDE_CURSOR)
  }

  // Register signal-based cleanup handlers.
  const onSignal = (signal: string) => {
    cleanupTerminal(terminal, useAltScreen)
    // Re-raise the signal so the OS sees the correct exit status.
    process.kill(process.pid, signal)
  }

  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  terminal.cleanupHandlers.push(() => {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  })

  // Catch uncaught exceptions / unhandled rejections to ensure cleanup.
  const onUncaughtException = (err: Error) => {
    cleanupTerminal(terminal, useAltScreen)
    process.stderr.write(
      `\n[replLauncher] Uncaught exception: ${err.message}\n${err.stack ?? ''}\n`,
    )
    process.exit(1)
  }

  const onUnhandledRejection = (reason: unknown) => {
    cleanupTerminal(terminal, useAltScreen)
    process.stderr.write(
      `\n[replLauncher] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
    )
    process.exit(1)
  }

  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)

  terminal.cleanupHandlers.push(() => {
    process.removeListener('uncaughtException', onUncaughtException)
    process.removeListener('unhandledRejection', onUnhandledRejection)
  })

  // Also clean up on normal process exit.
  const onExit = () => {
    cleanupTerminal(terminal, useAltScreen)
  }
  process.on('exit', onExit)
  terminal.cleanupHandlers.push(() => {
    process.removeListener('exit', onExit)
  })
}

// ============================================================
// Terminal cleanup
// ============================================================

/**
 * Restore the terminal to its pre-launch state.
 *
 * This function is idempotent: calling it multiple times has no
 * additional effect.
 */
function cleanupTerminal(
  terminal: TerminalState,
  useAltScreen: boolean,
): void {
  if (terminal.cleaned) return
  terminal.cleaned = true

  // Run registered cleanup handlers (unmount Ink, remove listeners, etc.).
  for (const handler of terminal.cleanupHandlers) {
    try {
      handler()
    } catch {
      // Best-effort cleanup; do not throw.
    }
  }
  terminal.cleanupHandlers.length = 0

  // Restore cursor visibility.
  if (process.stdout.isTTY) {
    process.stdout.write(SHOW_CURSOR)
  }

  // Disable raw mode.
  const stdin = process.stdin
  if (
    terminal.wasRaw &&
    stdin.isTTY &&
    typeof stdin.setRawMode === 'function'
  ) {
    try {
      stdin.setRawMode(false)
    } catch {
      // stdin may already be closed.
    }
  }

  // Leave the alternate screen buffer.
  if (terminal.wasAlternateScreen && useAltScreen && process.stdout.isTTY) {
    process.stdout.write(LEAVE_ALT_SCREEN)
  }
}

// ============================================================
// Convenience re-export
// ============================================================

export { createAppStateStore } from './state/AppStateStore.js'
export type { AppStateStore } from './state/AppStateStore.js'
