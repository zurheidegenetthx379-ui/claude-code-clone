/**
 * Slash Command Registry and Filtering
 *
 * Defines the built-in slash commands available in the interactive REPL,
 * provides type-safe registration, discovery, and dispatch utilities.
 *
 * Mirrors Claude Code's commands.ts architecture:
 *
 *  - Each command is a self-describing object with a name, description,
 *    optional aliases, an enablement flag, and an async `execute` function.
 *  - `getCommands(context)` returns the subset of commands that are enabled
 *    for the current session (some commands are gated on available tools or
 *    session state).
 *  - `findCommand(input, commands)` matches a raw input string against
 *    registered command names and aliases.
 *  - `executeCommand(input, context)` is the single entry point called by
 *    the REPL when the user types a line starting with `/`.
 *
 * The command set is intentionally small and focused on session management.
 * Complex functionality belongs in tools, skills, or the query engine.
 */

import type {
  AppState,
  ToolInstance,
} from './types/index.js'
import type { QueryEngine } from './QueryEngine.js'
import type { TokenUsage } from './services/api/claude.js'

// ============================================================
// Command Types
// ============================================================

/**
 * Result returned by a command's `execute` function.
 *
 * The REPL loop inspects the result to determine the next action:
 *  - `text`          — displayed to the user as the command's output.
 *  - `clearMessages` — when `true`, the conversation history is wiped.
 *  - `exit`          — when `true`, the REPL loop terminates.
 *  - `error`         — displayed as an error message to the user.
 */
export interface CommandResult {
  /** Text output displayed to the user. */
  text?: string
  /** When `true`, the REPL clears the conversation history. */
  clearMessages?: boolean
  /** When `true`, the REPL terminates. */
  exit?: boolean
  /** Error message displayed to the user (styled differently from `text`). */
  error?: string
}

/**
 * Runtime context passed to every command's `execute` function.
 *
 * Provides access to the query engine, application state, tool registry,
 * and session metadata so commands can inspect and mutate the running
 * session without requiring global singletons.
 */
export interface CommandContext {
  /** The active QueryEngine instance (headless execution engine). */
  queryEngine: QueryEngine

  /** Mutable application state (messages, tools, UI flags). */
  appState: AppState

  /** Full list of registered tool instances (built-in + MCP). */
  tools: ToolInstance[]

  /** Resolved working directory for the current session. */
  cwd: string

  /** Unique session identifier. */
  sessionId: string

  /** Current model identifier. */
  model: string

  /** Whether session memory is enabled. */
  memoryEnabled: boolean

  /** Callback to update the active model at runtime. */
  setModel?: (model: string) => void

  /** List of previously saved session IDs (for /resume). */
  savedSessions?: string[]

  /** Cumulative token usage for the current session. */
  sessionTokenUsage?: TokenUsage

  /** Cumulative estimated cost (USD) for the current session. */
  sessionCostUsd?: number
}

/**
 * A registered slash command.
 *
 * Commands are registered statically (see {@link BUILT_IN_COMMANDS}) and
 * filtered dynamically by {@link getCommands} based on the current session
 * context.
 */
export interface Command {
  /** Primary command name without the leading slash (e.g. "help"). */
  name: string

  /** One-line description shown in the `/help` listing. */
  description: string

  /** Alternative names that also resolve to this command (e.g. ["?"]). */
  aliases?: string[]

  /**
   * Whether the command should be listed and accepted.  When `false`,
   * `findCommand` silently ignores it.  Enablement can depend on runtime
   * state (e.g. `/resume` is only enabled when saved sessions exist).
   */
  isEnabled: boolean

  /**
   * When `true`, the command is hidden from the `/help` listing but can
   * still be invoked directly (e.g. `/quit` is an alias for `/exit` but
   * does not need its own listing).
   */
  isHidden?: boolean

  /**
   * Execute the command.
   *
   * @param args    — the raw text following the command name (may be empty).
   * @param context — runtime context with access to the engine and state.
   * @returns A {@link CommandResult} describing the outcome.
   */
  execute(args: string, context: CommandContext): Promise<CommandResult>
}

// ============================================================
// Built-In Command Definitions
// ============================================================

/**
 * The canonical list of built-in slash commands.
 *
 * Each command is defined as a plain object conforming to the {@link Command}
 * interface.  Commands that require runtime enablement checks use a getter
 * pattern — the `isEnabled` field is evaluated at registration time by
 * {@link getCommands}.
 *
 * To add a new command, append an entry to this array and implement the
 * `execute` function.
 */
export const BUILT_IN_COMMANDS: ReadonlyArray<Command> = [
  // ── /help ─────────────────────────────────────────────────────────────
  {
    name: 'help',
    description: 'List available commands and their descriptions.',
    aliases: ['?'],
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      const commands = getCommands(context)
      const visible = commands.filter((cmd) => !cmd.isHidden)

      const lines: string[] = [
        'Available commands:',
        '',
      ]

      // Compute the widest command label for alignment.
      const maxLen = visible.reduce((max, cmd) => {
        const label = formatCommandLabel(cmd)
        return Math.max(max, label.length)
      }, 0)

      for (const cmd of visible) {
        const label = formatCommandLabel(cmd)
        const padding = ' '.repeat(maxLen - label.length + 2)
        lines.push(`  ${label}${padding}${cmd.description}`)
      }

      lines.push('')
      lines.push('Type /<command> followed by any arguments.')

      return { text: lines.join('\n') }
    },
  },

  // ── /clear ────────────────────────────────────────────────────────────
  {
    name: 'clear',
    description: 'Clear the conversation history and start fresh.',
    aliases: ['reset'],
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, _context: CommandContext): Promise<CommandResult> {
      return {
        text: 'Conversation cleared. Starting fresh session.',
        clearMessages: true,
      }
    },
  },

  // ── /compact ──────────────────────────────────────────────────────────
  {
    name: 'compact',
    description: 'Compact the conversation context to free up token budget.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      const messageCount = context.appState.messages.length

      if (messageCount < 4) {
        return {
          text: 'Conversation is too short to compact (need at least 4 messages).',
        }
      }

      // The actual compaction is delegated to the compact service.  The
      // command merely signals intent; the REPL loop picks up the
      // `clearMessages` flag and replaces the transcript with the summary.
      return {
        text: `Compacting conversation (${messageCount} messages)...`,
        // The REPL will trigger compaction via the QueryEngine when it sees
        // this flag alongside the `/compact` command name.
        clearMessages: false,
      }
    },
  },

  // ── /model ────────────────────────────────────────────────────────────
  {
    name: 'model',
    description: 'Show the current model or switch to a different one. Usage: /model [name]',
    isEnabled: true,
    isHidden: false,

    async execute(args: string, context: CommandContext): Promise<CommandResult> {
      const trimmed = args.trim()

      // No argument — display the current model.
      if (!trimmed) {
        return {
          text: `Current model: ${context.model}`,
        }
      }

      // Switch model.
      if (!context.setModel) {
        return {
          error: 'Model switching is not available in this session.',
        }
      }

      // Basic validation: model names should not contain whitespace.
      if (/\s/.test(trimmed)) {
        return {
          error: `Invalid model name: "${trimmed}". Model names should not contain spaces.`,
        }
      }

      context.setModel(trimmed)
      return {
        text: `Model switched to: ${trimmed}`,
      }
    },
  },

  // ── /permissions ──────────────────────────────────────────────────────
  {
    name: 'permissions',
    description: 'Show the current permission settings and tool allow/deny lists.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      const perm = context.appState.permissionContext

      const lines: string[] = [
        'Permission Settings:',
        '',
        `  Mode:      ${perm.permissionMode}`,
        `  Allow list: ${perm.allowList.length > 0 ? perm.allowList.join(', ') : '(none)'}`,
        `  Deny list:  ${perm.denyList.length > 0 ? perm.denyList.join(', ') : '(none)'}`,
      ]

      return { text: lines.join('\n') }
    },
  },

  // ── /tools ────────────────────────────────────────────────────────────
  {
    name: 'tools',
    description: 'List all available tools and their status.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      if (context.tools.length === 0) {
        return { text: 'No tools are currently available.' }
      }

      const lines: string[] = [
        'Available tools:',
        '',
      ]

      // Compute widest name for alignment.
      const maxLen = context.tools.reduce(
        (max, tool) => Math.max(max, tool.name.length),
        0,
      )

      for (const tool of context.tools) {
        const padding = ' '.repeat(maxLen - tool.name.length + 2)
        const description =
          typeof tool.description === 'function'
            ? tool.description()
            : tool.description
        const enabled = tool.isEnabled() ? '' : ' [disabled]'
        lines.push(`  ${tool.name}${padding}${description}${enabled}`)
      }

      lines.push('')
      lines.push(`Total: ${context.tools.length} tool(s)`)

      return { text: lines.join('\n') }
    },
  },

  // ── /skills ───────────────────────────────────────────────────────────
  {
    name: 'skills',
    description: 'List all loaded skill commands.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      // Skills are loaded into the appState by the main orchestrator.
      // We surface them through the generic appState bag.
      const skills = (context.appState as unknown as Record<string, unknown>)
        .skills as Array<{ name: string; description: string }> | undefined

      if (!skills || skills.length === 0) {
        return {
          text: 'No skills are currently loaded. Place SKILL.md files in ~/.cc-agent/skills/ to register custom skills.',
        }
      }

      const lines: string[] = [
        'Loaded skills:',
        '',
      ]

      for (const skill of skills) {
        lines.push(`  /${skill.name} — ${skill.description}`)
      }

      lines.push('')
      lines.push(`Total: ${skills.length} skill(s)`)

      return { text: lines.join('\n') }
    },
  },

  // ── /memory ───────────────────────────────────────────────────────────
  {
    name: 'memory',
    description: 'Show the status of the session memory subsystem.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      if (!context.memoryEnabled) {
        return {
          text: 'Session memory is disabled for this session.',
        }
      }

      const lines: string[] = [
        'Session Memory Status:',
        '',
        `  Enabled:  yes`,
        `  Base dir: ${context.cwd}/.session-memory/`,
        `  Session:  ${context.sessionId}`,
      ]

      return { text: lines.join('\n') }
    },
  },

  // ── /resume ───────────────────────────────────────────────────────────
  {
    name: 'resume',
    description: 'Resume a previous session. Usage: /resume [session-id]',
    isEnabled: true,
    isHidden: false,

    async execute(args: string, context: CommandContext): Promise<CommandResult> {
      const trimmed = args.trim()

      if (!trimmed) {
        // List available sessions.
        const sessions = context.savedSessions ?? []
        if (sessions.length === 0) {
          return {
            text: 'No saved sessions found. Sessions are stored in ~/.cc-agent/sessions/.',
          }
        }

        const lines: string[] = [
          'Saved sessions:',
          '',
        ]
        for (const id of sessions.slice(0, 20)) {
          lines.push(`  ${id}`)
        }
        if (sessions.length > 20) {
          lines.push(`  ... and ${sessions.length - 20} more`)
        }
        lines.push('')
        lines.push('Usage: /resume <session-id>')

        return { text: lines.join('\n') }
      }

      // Session resume is handled by the REPL loop.  The command returns a
      // signal with the target session ID in the text field.
      return {
        text: `Resuming session: ${trimmed}`,
      }
    },
  },

  // ── /cost ─────────────────────────────────────────────────────────────
  {
    name: 'cost',
    description: 'Show token usage and estimated cost for the current session.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      const usage = context.sessionTokenUsage
      const cost = context.sessionCostUsd

      const lines: string[] = [
        'Session Usage:',
        '',
      ]

      if (usage) {
        lines.push(`  Input tokens:     ${formatNumber(usage.inputTokens)}`)
        lines.push(`  Output tokens:    ${formatNumber(usage.outputTokens)}`)

        if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
          lines.push(`  Cache read:       ${formatNumber(usage.cacheReadTokens)}`)
        }
        if (usage.cacheCreationTokens !== undefined && usage.cacheCreationTokens > 0) {
          lines.push(`  Cache creation:   ${formatNumber(usage.cacheCreationTokens)}`)
        }

        const total = usage.inputTokens + usage.outputTokens
        lines.push(`  Total tokens:     ${formatNumber(total)}`)
      } else {
        lines.push('  Token usage data not yet available.')
      }

      lines.push('')

      if (cost !== undefined && cost > 0) {
        lines.push(`  Estimated cost:   $${cost.toFixed(4)} USD`)
      } else {
        lines.push('  Estimated cost:   $0.0000 USD')
      }

      return { text: lines.join('\n') }
    },
  },

  // ── /exit ─────────────────────────────────────────────────────────────
  {
    name: 'exit',
    description: 'Exit the application.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, _context: CommandContext): Promise<CommandResult> {
      return {
        text: 'Goodbye!',
        exit: true,
      }
    },
  },

  // ── /quit (alias for /exit) ───────────────────────────────────────────
  {
    name: 'quit',
    description: 'Exit the application (alias for /exit).',
    aliases: ['q'],
    isEnabled: true,
    isHidden: true,

    async execute(args: string, context: CommandContext): Promise<CommandResult> {
      const exitCommand = BUILT_IN_COMMANDS.find((cmd) => cmd.name === 'exit')!
      return exitCommand.execute(args, context)
    },
  },

  // ── /abort ────────────────────────────────────────────────────────────
  {
    name: 'abort',
    description: 'Cancel the currently running query.',
    isEnabled: true,
    isHidden: false,

    async execute(_args: string, context: CommandContext): Promise<CommandResult> {
      const state = context.queryEngine.getState()
      if (state.status === 'running') {
        context.queryEngine.abort()
        return { text: 'Query aborted.' }
      }
      return { text: 'No query in progress.' }
    },
  },
]

// ============================================================
// Command Registry API
// ============================================================

/**
 * Return the subset of built-in commands that are enabled for the given
 * session context.
 *
 * Currently all built-in commands are unconditionally enabled.  This
 * function exists as the extension point for future gating logic (e.g.
 * disabling `/resume` when the session store is empty, or disabling
 * `/compact` when the conversation has fewer than N messages).
 *
 * @param context — current session context.
 * @returns Array of enabled commands.
 */
export function getCommands(_context: CommandContext): Command[] {
  return BUILT_IN_COMMANDS.filter((cmd) => {
    // Base enablement check.
    if (!cmd.isEnabled) return false

    // Contextual gating — extend here as needed.

    // /resume is only useful when there are saved sessions.
    if (cmd.name === 'resume') {
      // Still show the command even without sessions (it displays a helpful
      // message), but this is where you would disable it:
      // const sessions = context.savedSessions
      // if (!sessions || sessions.length === 0) return false
    }

    return true
  })
}

/**
 * Find a command by matching the raw user input against registered command
 * names and aliases.
 *
 * Matching is case-insensitive and supports both the primary name and any
 * registered aliases.  The leading `/` is optional in the input.
 *
 * @param input    — raw user input (e.g. "/help", "help", "/?", "?").
 * @param commands — array of commands to search (from {@link getCommands}).
 * @returns The matched command, or `null` if no match is found.
 */
export function findCommand(input: string, commands: Command[]): Command | null {
  // Strip leading slash and normalize to lowercase.
  const normalized = input.replace(/^\/+/, '').trim().toLowerCase()

  if (!normalized) return null

  for (const cmd of commands) {
    if (cmd.name.toLowerCase() === normalized) {
      return cmd
    }

    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase() === normalized) {
          return cmd
        }
      }
    }
  }

  return null
}

/**
 * Parse a raw input line and execute the matching command.
 *
 * The input is expected to start with `/` followed by the command name.
 * Everything after the command name (separated by whitespace) is passed as
 * the `args` string to the command's `execute` function.
 *
 * @param input   — raw user input line (e.g. "/model claude-3-opus").
 * @param context — runtime context forwarded to the command.
 * @returns The command result, or an error result if the command is not found.
 */
export async function executeCommand(
  input: string,
  context: CommandContext,
): Promise<CommandResult> {
  const trimmed = input.trim()

  if (!trimmed.startsWith('/')) {
    return {
      error: `Invalid command: "${trimmed}". Commands must start with /.`,
    }
  }

  // Split into command token and arguments.
  const spaceIndex = trimmed.indexOf(' ')
  const commandToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()

  // Find the command.
  const commands = getCommands(context)
  const command = findCommand(commandToken, commands)

  if (!command) {
    // Provide a helpful suggestion for near-misses.
    const suggestion = findSuggestion(commandToken, commands)
    const message = suggestion
      ? `Unknown command: "${commandToken}". Did you mean /${suggestion}?`
      : `Unknown command: "${commandToken}". Type /help for a list of available commands.`

    return { error: message }
  }

  // Execute with error boundary.
  try {
    return await command.execute(args, context)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      error: `Command /${command.name} failed: ${detail}`,
    }
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Format a command label for display in the help listing.
 *
 * Shows the primary name with the leading `/` and any aliases in parentheses.
 */
function formatCommandLabel(cmd: Command): string {
  let label = `/${cmd.name}`
  if (cmd.aliases && cmd.aliases.length > 0) {
    label += ` (${cmd.aliases.map((a) => `/${a}`).join(', ')})`
  }
  return label
}

/**
 * Format a number with comma separators for readability.
 *
 * @example formatNumber(1234567) → "1,234,567"
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Find the closest matching command name for "did you mean?" suggestions.
 *
 * Uses a simple Levenshtein distance heuristic.  Returns `null` when no
 * command is close enough to be a reasonable suggestion.
 *
 * @param input    — the normalized command token (without leading `/`).
 * @param commands — available commands to search.
 * @returns The closest command name, or `null`.
 */
function findSuggestion(input: string, commands: Command[]): string | null {
  const normalized = input.replace(/^\/+/, '').toLowerCase()
  let bestMatch: string | null = null
  let bestDistance = Infinity

  const MAX_SUGGESTION_DISTANCE = 3

  for (const cmd of commands) {
    if (cmd.isHidden) continue

    const names = [cmd.name, ...(cmd.aliases ?? [])]
    for (const name of names) {
      const dist = levenshtein(normalized, name.toLowerCase())
      if (dist < bestDistance && dist <= MAX_SUGGESTION_DISTANCE) {
        bestDistance = dist
        bestMatch = name
      }
    }
  }

  return bestMatch
}

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Used by {@link findSuggestion} to produce "did you mean?" hints.
 * Standard dynamic-programming implementation with O(m*n) time and O(n)
 * space (single-row optimization).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Ensure `a` is the shorter string for the space optimization.
  if (a.length > b.length) {
    [a, b] = [b, a]
  }

  const aLen = a.length
  const bLen = b.length

  // Previous and current row of the DP matrix.
  let prev = new Array<number>(aLen + 1)
  let curr = new Array<number>(aLen + 1)

  for (let i = 0; i <= aLen; i++) {
    prev[i] = i
  }

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j

    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min(
        prev[i] + 1,       // deletion
        curr[i - 1] + 1,   // insertion
        prev[i - 1] + cost, // substitution
      )
    }

    // Swap rows.
    [prev, curr] = [curr, prev]
  }

  return prev[aLen]!
}

/**
 * Check whether a raw input string looks like a slash command.
 *
 * Used by the REPL input handler to decide whether to route through
 * {@link executeCommand} or treat the input as a regular user message.
 *
 * @param input — raw user input line.
 * @returns `true` if the input starts with `/` followed by an alphabetic
 *          character (to avoid treating file paths like `/usr/bin` as commands).
 */
export function isSlashCommand(input: string): boolean {
  const trimmed = input.trim()
  return /^\/[a-zA-Z]/.test(trimmed)
}
