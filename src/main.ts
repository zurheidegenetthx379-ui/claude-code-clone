/**
 * Main orchestrator entry point for the AI Coding Agent.
 *
 * Coordinates initialization, tool assembly, MCP connection, skill loading,
 * and dispatches to either headless (pipe) or interactive REPL mode.
 *
 * This module is the "conductor" that wires together every subsystem:
 *   1. Pre-trust initialization via entrypoints/init.ts
 *   2. Permission context construction from CLI args
 *   3. Built-in tool assembly via tools.ts
 *   4. MCP server connection + tool discovery via services/mcp/client.ts
 *   5. Skill loading via skills/loadSkillsDir.ts
 *   6. Query engine creation via QueryEngine.ts
 *   7. REPL loop or headless execution
 *
 * Exports consumed by entrypoints/cli.ts:
 *   - runHeadless(options)  — single-shot pipe mode
 *   - runSdkMode(options)   — JSON protocol on stdin/stdout
 *   - startRepl(options)    — interactive readline REPL
 *   - startInkRepl(options) — React+Ink full-screen TUI REPL
 *   - main(argv)            — full CLI dispatcher (default export)
 */

import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  init,
  shutdown,
  grantTrust,
  emitTelemetry,
} from './entrypoints/init.js'
import type { InitContext } from './entrypoints/init.js'

import {
  getAllBaseTools,
} from './tools.js'

import {
  McpClientManager,
  getMcpToolsCommandsAndResources,
  mcpToolDefToToolInstance,
} from './services/mcp/client.js'
import type { McpServerConfig } from './types/index.js'

import { getSkillDirCommands } from './skills/loadSkillsDir.js'
import type { SkillCommand } from './skills/loadSkillsDir.js'

import {
  estimateMessageTokens,
  shouldAutoCompact,
  getEffectiveContextWindowSize,
} from './utils/context.js'

import { compactConversation } from './services/compact/compact.js'

import { QueryEngine } from './QueryEngine.js'
import type { QueryEngineConfig, QueryResult } from './QueryEngine.js'

import * as sessionStorage from './utils/sessionStorage.js'

import {
  initSessionMemory,
  shouldExtractMemory,
  updateSessionMemory,
  getSessionMemoryState,
  disposeSessionMemory,
} from './services/SessionMemory/sessionMemory.js'

import { buildMemoryPrompt } from './memdir/memdir.js'
import { findRelevantMemories } from './memdir/findRelevantMemories.js'

import type {
  Message,
  PermissionContext,
  PermissionMode,
  ToolInstance,
  McpToolDefinition,
  SandboxMode,
} from './types/index.js'

import {
  convertToSandboxRuntimeConfig,
} from './utils/sandbox/sandbox-adapter.js'
import type {
  SandboxSettings,
  SandboxRuntimeConfig,
  PermissionContext as AdapterPermissionContext,
} from './utils/sandbox/sandbox-adapter.js'

import {
  isCoordinatorMode,
  getCoordinatorSystemPrompt,
} from './coordinator/coordinatorMode.js'
import { TeamRegistry } from './coordinator/swarm/TeamRegistry.js'
import { FileMailbox } from './coordinator/swarm/FileMailbox.js'
import { BackgroundTaskRegistry } from './coordinator/swarm/BackgroundTaskRegistry.js'

import {
  executeCommand,
} from './commands.js'
import type { CommandContext, CommandResult } from './commands.js'

import {
  getUserContext,
  getSystemContext,
  buildContextMessage,
} from './context.js'

import {
  loadProjectConfig,
} from './setup.js'
import type { ProjectSettings } from './setup.js'

import { launchRepl } from './replLauncher.js'

import { loadHooks, runHooks } from './services/hooks/hookRunner.js'
import type { HookDefinition } from './types/index.js'

import { buildEffectiveSystemPrompt } from './utils/systemPrompt.js'

// ============================================================
// Constants
// ============================================================

const DEFAULT_MODEL = process.env['CC_AGENT_MODEL'] ?? 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 8192
const BANNER = `
  ____   ____   ____   ____   ____   ____
 / ___\\ / ___\\ /  _ \\ /  _ \\ /  __\\ /  __\\
| |    | |    | |_) || |_) || |___ | |___
| |___ | |___ |  _ < |  __/ | |___ | |___
\\____/ \\____/ |_| \\_\\|_|    \\____/ \\____/

  AI Coding Agent — type /help for commands
`

// ============================================================
// Option interfaces (consumed by cli.ts)
// ============================================================

export interface HeadlessOptions {
  /** The user prompt to process. */
  prompt: string
  /** Model override. */
  model?: string
  /** System prompt override. */
  systemPrompt?: string
  /** Permission mode. */
  permissionMode?: PermissionMode
  /** Maximum output tokens. */
  maxTokens?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /** Working directory. */
  cwd: string
  /** Output format — currently only "text" is supported. */
  outputFormat?: 'text' | 'json'
}

export interface SdkModeOptions {
  /** Model override. */
  model?: string
  /** System prompt override. */
  systemPrompt?: string
  /** Permission mode. */
  permissionMode?: PermissionMode
  /** Maximum output tokens. */
  maxTokens?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /** Working directory. */
  cwd: string
}

export interface ReplOptions {
  /** Optional initial prompt to execute on startup. */
  initialPrompt?: string
  /** Model override. */
  model?: string
  /** System prompt override. */
  systemPrompt?: string
  /** Permission mode. */
  permissionMode?: PermissionMode
  /** Maximum output tokens. */
  maxTokens?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /** Working directory. */
  cwd: string
  /** Session ID to resume from. */
  resumeSessionId?: string
  /** Whether session memory is enabled. */
  enableMemory?: boolean
  /** Verbose logging. */
  verbose?: boolean
  /** Additional skill directories (--add-dir). */
  additionalDirs?: string[]
  /** MCP server configurations. */
  mcpConfigs?: McpServerConfig[]
  /** Permission allow-list patterns (glob). */
  allowList?: string[]
  /** Permission deny-list patterns (glob). */
  denyList?: string[]
  /** Use the React+Ink TUI instead of the plain readline REPL. */
  useInk?: boolean
}

// ============================================================
// Assembled runtime context
// ============================================================

interface AssembledRuntime {
  /** The merged tool pool (built-in + MCP). */
  tools: ToolInstance[]
  /** Discovered MCP tool definitions (raw). */
  mcpToolDefs: McpToolDefinition[]
  /** Loaded skill commands. */
  skills: SkillCommand[]
  /** The MCP client manager (for later invocation + disconnect). */
  mcpManager: McpClientManager
  /** The resolved system prompt. */
  systemPrompt: string
  /** The resolved permission context. */
  permissionContext: PermissionContext
  /** The working directory. */
  cwd: string
  /** The session identifier. */
  sessionId: string
  /** The model to use. */
  model: string
  /** Whether session memory extraction is enabled. */
  enableMemory: boolean
  /** Path to the memory directory (for MemoryDir system). */
  memoryDir: string
  /** Resolved sandbox runtime configuration (null when sandboxing is unavailable). */
  sandboxRuntimeConfig: SandboxRuntimeConfig | null
  /** Sandbox mode: 'always', 'never', or 'auto'. */
  sandboxMode: SandboxMode
  /** Whether coordinator (multi-agent orchestration) mode is active. */
  coordinatorMode: boolean
  /** Team registry for swarm mode (present only when coordinator mode is active). */
  teamRegistry?: TeamRegistry
  /** File-based mailbox for inter-agent messaging (present only when coordinator mode is active). */
  fileMailbox?: FileMailbox
  /** Background task registry for tracking async agents (present only when coordinator mode is active). */
  backgroundTaskRegistry?: BackgroundTaskRegistry
  /** Lifecycle hooks loaded from project configuration. */
  hooks: HookDefinition[]
}

// ============================================================
// Main CLI dispatcher
// ============================================================

/**
 * Top-level CLI entry point.
 *
 * Parses `argv`, runs pre-trust initialization, and branches into either
 * headless or REPL mode depending on the `--print` flag.
 *
 * In practice this function is called by `entrypoints/cli.ts` only when no
 * fast-path command matched; the fast paths (`--version`, `--help`,
 * `--print`) are handled directly in cli.ts for speed.
 */
export async function main(argv: string[]): Promise<void> {
  // ---- Pre-trust initialization ----
  const cwd = extractArg(argv, '--cwd') ?? process.cwd()
  const permissionMode = (extractArg(argv, '--permission-mode') ?? 'default') as PermissionMode
  const isHeadless = argv.includes('--print') || argv.includes('-p')

  const initCtx = await init({
    cwd: path.resolve(cwd),
    permissionMode,
    headless: isHeadless,
    verbose: argv.includes('--verbose'),
  })

  emitTelemetry(initCtx, 'cli.start', {
    argv: argv.slice(0, 10).join(' '),
    isHeadless,
  })

  // ---- Parse remaining options ----
  const model = extractArg(argv, '--model') ?? DEFAULT_MODEL
  const systemPrompt = extractArg(argv, '--system-prompt')
  const appendSystemPrompt = extractArg(argv, '--append-system-prompt')
  const addDir = extractAllArgs(argv, '--add-dir')
  const maxTokens = parseInt(extractArg(argv, '--max-tokens') ?? '', 10) || undefined
  const temperature = parseFloat(extractArg(argv, '--temperature') ?? '') || undefined

  const fullSystemPrompt = buildFullSystemPrompt(systemPrompt, appendSystemPrompt)

  // ---- Dispatch ----
  try {
    if (isHeadless) {
      const prompt = extractArg(argv, '--print') ?? extractArg(argv, '-p') ?? ''
      await runHeadless({
        prompt,
        model,
        systemPrompt: fullSystemPrompt,
        permissionMode,
        maxTokens,
        temperature,
        cwd: initCtx.cwd,
        outputFormat: 'text',
      })
    } else {
      const replOpts: ReplOptions = {
        initialPrompt: argv.find(a => !a.startsWith('-')),
        model,
        systemPrompt: fullSystemPrompt,
        permissionMode,
        maxTokens,
        temperature,
        cwd: initCtx.cwd,
        verbose: argv.includes('--verbose'),
        additionalDirs: addDir,
      }
      if (argv.includes('--ink')) {
        await startInkRepl({ ...replOpts, useInk: true })
      } else {
        await startRepl(replOpts)
      }
    }
  } finally {
    await shutdown(initCtx)
  }
}

// ============================================================
// Headless mode (--print)
// ============================================================

/**
 * Execute a single prompt in headless mode: assemble the runtime, run the
 * query, print the result to stdout, and exit.
 *
 * Designed for piping: the response text is the only thing written to
 * stdout; all diagnostics go to stderr.
 */
export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const runtime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode ?? 'default',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: options.cwd,
    mcpConfigs: [],
  })

  const engine = createQueryEngine(runtime, { silent: true })

  // ---- Run SessionStart hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(runtime.hooks, 'SessionStart', {}, runtime.cwd)
    } catch (err) {
      console.error(
        '[hooks] SessionStart hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  try {
    // Persist user message
    const userMsgId = randomUUID()
    try {
      sessionStorage.appendEntry({
        type: 'user',
        uuid: userMsgId,
        sessionId: runtime.sessionId,
        timestamp: Date.now(),
        role: 'user',
        content: options.prompt,
      } as any, runtime.cwd)
    } catch { /* best-effort */ }

    const timeoutMs = parseInt(process.env.CC_HEADLESS_TIMEOUT_MS || '300000', 10) // 5 min default
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Headless query timed out after ${timeoutMs}ms`)), timeoutMs)
    )
    const result: QueryResult = await Promise.race([engine.run(options.prompt), timeoutPromise])

    // Persist assistant response
    try {
      sessionStorage.appendEntry({
        type: 'assistant',
        uuid: randomUUID(),
        sessionId: runtime.sessionId,
        timestamp: Date.now(),
        role: 'assistant',
        content: result.text,
        parentUuid: userMsgId,
      } as any, runtime.cwd)
    } catch { /* best-effort */ }

    if (options.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({
        text: result.text,
        stopReason: result.stopReason,
        turnsUsed: result.turnsUsed,
        tokenUsage: result.tokenUsage,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      }))
    } else {
      process.stdout.write(result.text)
      // Ensure trailing newline for shell piping.
      if (!result.text.endsWith('\n')) {
        process.stdout.write('\n')
      }
    }
  } catch (err) {
    console.error(
      'Error:',
      err instanceof Error ? err.message : String(err),
    )
    process.exitCode = 1
  } finally {
    // ---- Run SessionEnd hooks ----
    if (runtime.hooks.length > 0) {
      try {
        await runHooks(runtime.hooks, 'SessionEnd', {}, runtime.cwd)
      } catch (err) {
        console.error(
          '[hooks] SessionEnd hook error:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    // Flush session write queue before disconnecting
    try {
      await sessionStorage.flushWriteQueue()
    } catch { /* best-effort */ }
    await runtime.mcpManager.disconnectAll()
  }
}

// ============================================================
// SDK mode (--sdk)
// ============================================================

/**
 * Run in SDK / machine-to-machine mode.
 *
 * Reads JSON-protocol messages from stdin, processes each through the query
 * engine, and writes JSON responses to stdout.
 *
 * This is a simplified implementation; a production version would implement
 * the full Claude Code SDK wire protocol.
 */
export async function runSdkMode(options: SdkModeOptions): Promise<void> {
  const runtime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode ?? 'bypassPermissions',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: options.cwd,
    mcpConfigs: [],
  })

  const engine = createQueryEngine(runtime, { silent: true })

  // ---- Run SessionStart hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(runtime.hooks, 'SessionStart', {}, runtime.cwd)
    } catch (err) {
      console.error(
        '[hooks] SessionStart hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Wire up streaming events for the SDK protocol.
  // Each event is emitted as a JSON line on stdout so the SDK client
  // gets real-time feedback during query execution.
  engine.on('text', (chunk: string) => {
    writeSdkResponse({ type: 'text_delta', content: chunk })
  })
  engine.on('tool:use', (toolUse) => {
    writeSdkResponse({
      type: 'tool_use',
      name: toolUse.name,
      id: toolUse.id,
      input: toolUse.input,
    })
  })
  engine.on('tool:result', (result) => {
    writeSdkResponse({
      type: 'tool_result',
      toolUseId: result.tool_use_id,
      content: typeof result.content === 'string' ? result.content : '[complex]',
      isError: result.is_error ?? false,
    })
  })

  // Read JSON lines from stdin.
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      let request: { type: string; prompt?: string }
      try {
        request = JSON.parse(line)
      } catch {
        writeSdkResponse({ type: 'error', error: 'Invalid JSON on stdin' })
        continue
      }

      if (request.type === 'query' && request.prompt) {
        try {
          const result = await engine.run(request.prompt)
          writeSdkResponse({
            type: 'result',
            text: result.text,
            stopReason: result.stopReason,
            turnsUsed: result.turnsUsed,
            tokenUsage: result.tokenUsage,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          })
        } catch (err) {
          writeSdkResponse({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else if (request.type === 'abort') {
        engine.abort()
        writeSdkResponse({ type: 'aborted' })
      } else if (request.type === 'shutdown') {
        break
      } else {
        writeSdkResponse({ type: 'error', error: `Unknown request type: ${request.type}` })
      }
    }
  } finally {
    // Ensure MCP connections are torn down even if stdin processing throws.
    if (runtime.mcpManager) {
      await runtime.mcpManager.disconnectAll().catch(() => {})
    }
  }

  // ---- Run SessionEnd hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(runtime.hooks, 'SessionEnd', {}, runtime.cwd)
    } catch (err) {
      console.error(
        '[hooks] SessionEnd hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // MCP disconnect is handled by the try/finally block above.
}

// ============================================================
// Interactive REPL mode
// ============================================================

/**
 * Start the interactive read-eval-print loop.
 *
 * Initializes all subsystems, builds the system prompt, prints a startup
 * banner, and enters a readline loop that dispatches user input through the
 * query engine.
 *
 * Supports slash commands:
 *   /help          — print available commands
 *   /clear         — reset the conversation
 *   /compact       — compact the conversation history
 *   /exit          — exit the REPL
 *   /model [name]  — show or switch the active model
 *   /permissions   — show current permission settings
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  // ---- Initialization ----
  const initCtx = await init({
    cwd: path.resolve(options.cwd),
    permissionMode: options.permissionMode ?? 'default',
    headless: false,
    verbose: options.verbose ?? false,
  })

  // Grant trust implicitly in REPL mode (user is present and interactive).
  const trustedCtx = grantTrust(initCtx)
  emitTelemetry(trustedCtx, 'repl.start', { cwd: trustedCtx.cwd })

  // ---- Assemble runtime ----
  const runtime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode ?? 'default',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: trustedCtx.cwd,
    mcpConfigs: options.mcpConfigs ?? [],
    additionalDirs: options.additionalDirs,
    sessionId: options.resumeSessionId,
    allowList: options.allowList,
    denyList: options.denyList,
  })

  let engine = createQueryEngine(runtime)

  // ---- Session memory initialization ----
  if (runtime.enableMemory && options.enableMemory !== false) {
    try {
      const memPath = await initSessionMemory(runtime.sessionId, runtime.cwd)
      console.error(`[memory] Session memory file: ${memPath}`)
    } catch {
      // Non-fatal — session memory is best-effort.
    }
  }

  // ---- Run SessionStart hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(
        runtime.hooks,
        'SessionStart',
        { toolName: undefined },
        runtime.cwd,
      )
    } catch (err) {
      console.error(
        '[hooks] SessionStart hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Track already-surfaced memory files to avoid injecting the same file twice.
  const alreadySurfacedMemories: string[] = []

  // Track in-flight work so the close handler can wait for completion.
  let currentQuery: Promise<void> | null = null
  let lineHandlerBusy: Promise<void> | null = null

  // ---- Startup banner ----
  console.log(BANNER)
  console.log(`  Model:       ${runtime.model}`)
  console.log(`  CWD:         ${runtime.cwd}`)
  console.log(`  Session:     ${runtime.sessionId}`)
  console.log(`  Tools:       ${runtime.tools.length} available`)
  console.log(`  MCP servers: ${runtime.mcpToolDefs.length > 0 ? runtime.mcpToolDefs.length + ' tools' : 'none'}`)
  console.log(`  Skills:      ${runtime.skills.length} loaded`)
  console.log(`  Permissions: ${runtime.permissionContext.permissionMode}`)
  const sandboxStatus = runtime.sandboxRuntimeConfig?.enabled
    ? `ACTIVE (mode: ${runtime.sandboxMode})`
    : `disabled (mode: ${runtime.sandboxMode})`
  console.log(`  Sandbox:     ${sandboxStatus}`)
  console.log(`  Coordinator: ${runtime.coordinatorMode ? 'ACTIVE' : 'inactive'}`)
  console.log('')

  // ---- Readline setup ----
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    historySize: 200,
  })

  rl.prompt()

  // Handle initial prompt if provided.
  if (options.initialPrompt) {
    console.log(`> ${options.initialPrompt}`)
    currentQuery = processUserInput(options.initialPrompt, engine, runtime, alreadySurfacedMemories)
    await currentQuery
    currentQuery = null
  }

  // ---- REPL loop ----
  rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) {
      rl.prompt()
      return
    }

    const lineWork = (async () => {
      try {
        // ---- Slash commands ----
        if (trimmed.startsWith('/')) {
          const handled = await handleCommand(
            trimmed,
            engine,
            runtime,
          )
          if (handled === 'exit') {
            rl.close()
            return
          }
          if (handled === 'reset') {
            // After /clear, recreate the engine with fresh state.
            engine = createQueryEngine(runtime)
          }
        } else {
          // ---- Normal prompt ----
          currentQuery = processUserInput(trimmed, engine, runtime, alreadySurfacedMemories)
          await currentQuery
          currentQuery = null
        }
      } catch (err) {
        currentQuery = null
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        )
      }

      rl.prompt()
    })()

    lineHandlerBusy = lineWork
    await lineWork
    lineHandlerBusy = null
  })

  rl.on('close', async () => {
    // Wait for any in-flight work to complete before shutting down.
    if (lineHandlerBusy) {
      try { await lineHandlerBusy } catch { /* ignore */ }
    }
    if (currentQuery) {
      try { await currentQuery } catch { /* ignore */ }
    }
    console.log('\nGoodbye!')
    await gracefulShutdown(runtime, trustedCtx)
    process.exit(0)
  })

  // Handle SIGINT gracefully.
  process.on('SIGINT', () => {
    if (engine.getState().status === 'running') {
      console.log('\nAborting current query...')
      engine.abort()
    } else {
      rl.close()
    }
  })
}

// ============================================================
// Interactive REPL mode — Ink TUI (--ink)
// ============================================================

/**
 * Start the interactive REPL using the React+Ink terminal UI.
 *
 * Performs the same initialization and runtime assembly as `startRepl()`,
 * but renders the full-screen Ink component tree from
 * `components/REPL/REPL.tsx` instead of using a plain readline loop.
 */
export async function startInkRepl(options: ReplOptions): Promise<void> {
  // ---- Initialization (same as startRepl) ----
  const initCtx = await init({
    cwd: path.resolve(options.cwd),
    permissionMode: options.permissionMode ?? 'default',
    headless: false,
    verbose: options.verbose ?? false,
  })

  const trustedCtx = grantTrust(initCtx)
  emitTelemetry(trustedCtx, 'repl.ink.start', { cwd: trustedCtx.cwd })

  // ---- Assemble runtime (same as startRepl) ----
  const runtime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode ?? 'default',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: trustedCtx.cwd,
    mcpConfigs: options.mcpConfigs ?? [],
    additionalDirs: options.additionalDirs,
    sessionId: options.resumeSessionId,
    allowList: options.allowList,
    denyList: options.denyList,
  })

  // Create the query engine in fully-silent mode — the Ink component handles
  // its own display via engine events, so we suppress ALL console output
  // to avoid corrupting the Ink render.
  const engine = createQueryEngine(runtime, { fullySilent: true })

  // ---- Session memory initialization (Ink mode) ----
  if (runtime.enableMemory) {
    try {
      await initSessionMemory(runtime.sessionId, runtime.cwd)
    } catch { /* best-effort */ }
  }

  // ---- Run SessionStart hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(runtime.hooks, 'SessionStart', {}, runtime.cwd)
    } catch (err) {
      console.error(
        '[hooks] SessionStart hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ---- Launch the Ink REPL via replLauncher.ts ----
  // The launcher handles terminal setup (alt screen, raw mode), store
  // creation, Ink rendering, and terminal cleanup on exit.
  await launchRepl({
    queryEngine: engine,
    tools: runtime.tools,
    systemPrompt: runtime.systemPrompt,
    cwd: runtime.cwd,
    sessionId: runtime.sessionId,
    permissionContext: runtime.permissionContext,
    initialPrompt: options.initialPrompt,
  })

  // ---- Cleanup ----
  await gracefulShutdown(runtime, trustedCtx)
}

// ============================================================
// Runtime assembly
// ============================================================

/**
 * Assemble the complete runtime context by merging built-in tools, MCP
 * tools, and loaded skills.
 *
 * This is the single function that wires together every subsystem into a
 * coherent context object consumed by the query engine and REPL.
 */
async function assembleRuntime(options: {
  model: string
  systemPrompt?: string
  permissionMode: PermissionMode
  maxTokens: number
  temperature?: number
  cwd: string
  mcpConfigs?: McpServerConfig[]
  additionalDirs?: string[]
  sessionId?: string
  allowList?: string[]
  denyList?: string[]
}): Promise<AssembledRuntime> {
  const cwd = path.resolve(options.cwd)
  const sessionId = options.sessionId ?? randomUUID()

  // Ensure session storage directory exists
  const sessionsDir = path.join(cwd, '.cc-agent', 'sessions')
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(sessionsDir, { recursive: true })
  } catch { /* best-effort */ }

  // ---- Project settings (from setup.ts) ----
  // Load project-level configuration from <cwd>/.cc-agent/settings.json.
  // Settings provide project-scoped overrides for model, system prompt,
  // permission mode, and MCP server connections.
  const projectSettings: ProjectSettings = await loadProjectConfig(cwd)

  // Apply model override from project settings (CLI args take precedence).
  const effectiveModel = options.model !== DEFAULT_MODEL
    ? options.model
    : (projectSettings.model ?? options.model)

  // Apply permission mode override from project settings (CLI args take precedence).
  const effectivePermissionMode = options.permissionMode !== 'default'
    ? options.permissionMode
    : (projectSettings.permissionMode ?? options.permissionMode)

  // Merge MCP server configs from project settings with those passed via CLI.
  const settingsMcpConfigs: McpServerConfig[] = (projectSettings.mcpServers ?? []).map(s => ({
    name: s.name,
    type: s.type,
    command: s.command,
    args: s.args,
    url: s.url,
    env: s.env,
  }))
  const allMcpConfigs = [...settingsMcpConfigs, ...(options.mcpConfigs ?? [])]

  // ---- Permission context ----
  const permissionContext: PermissionContext = {
    permissionMode: effectivePermissionMode,
    allowList: options.allowList ?? [],
    denyList: options.denyList ?? [],
  }

  // ---- Built-in tools ----
  const builtInTools = getAllBaseTools()

  // ---- MCP tools ----
  const { manager: mcpManager, tools: mcpToolDefs } =
    await getMcpToolsCommandsAndResources(allMcpConfigs)

  // Convert MCP tool defs to ToolInstance objects and merge with built-in.
  const mcpToolInstances = mcpToolDefs.map(def =>
    mcpToolDefToToolInstance(def, mcpManager),
  )
  const mergedTools = mergeToolPools(builtInTools, mcpToolInstances)

  // Apply permission deny rules.
  const filteredTools = mergedTools.filter(
    tool => !permissionContext.denyList.includes(tool.name),
  )

  // ---- Skills ----
  const skills = getSkillDirCommands(cwd, {
    additionalDirs: options.additionalDirs,
  })

  // ---- System prompt ----
  // Use the priority-based system prompt assembler to unify override,
  // coordinator, agent, custom, and default prompts in a single call.
  const coordinatorMode = isCoordinatorMode()
  const effectiveSystemPrompt = await buildEffectiveSystemPrompt({
    tools: filteredTools,
    model: effectiveModel,
    overrideSystemPrompt: options.systemPrompt,
    coordinatorSystemPrompt: coordinatorMode ? getCoordinatorSystemPrompt() : undefined,
    isCoordinatorMode: coordinatorMode,
    customSystemPrompt: projectSettings.systemPrompt,
  })
  let systemPrompt = effectiveSystemPrompt.content

  // Apply project settings' system prompt addition (if provided).
  if (projectSettings.systemPrompt) {
    systemPrompt = systemPrompt + '\n\n' + projectSettings.systemPrompt
  }

  // ---- Context injection (from context.ts) ----
  // Gather per-session contextual information (project memory files, git
  // status, platform info) and inject as an <environment> block into the
  // system prompt.  This happens BEFORE memory directory injection so the
  // ordering is: base prompt -> context -> memory -> coordinator override.
  try {
    const userCtx = await getUserContext(cwd)
    const sysCtx = await getSystemContext(cwd)
    const contextBlock = buildContextMessage(userCtx, sysCtx)
    if (contextBlock) {
      systemPrompt = systemPrompt + '\n\n' + contextBlock
    }
  } catch {
    // Context gathering failure is non-fatal — continue without it.
  }

  // ---- Memory directory injection ----
  // Look for a memory directory at .cc-agent/memory/ and inject its
  // contents (MEMORY.md entrypoint + sibling file manifest) into the
  // system prompt so the model has persistent project-scoped context.
  const memoryDir = path.join(cwd, '.cc-agent', 'memory')
  const enableMemory = true // default on; CLI flag can disable later
  try {
    const memoryBlock = await buildMemoryPrompt(memoryDir)
    if (memoryBlock) {
      systemPrompt = systemPrompt + '\n\n' + memoryBlock
    }
  } catch {
    // Memory dir read failure is non-fatal — continue without it.
  }

  // ---- Sandbox configuration ----
  // Read sandbox settings from .cc-agent/sandbox.json (or use defaults).
  // The adapter translates these high-level settings into a low-level
  // SandboxRuntimeConfig that the sandbox-enforcer consumes.
  const defaultSandboxSettings: SandboxSettings = {
    enabled: false,
    enabledPlatforms: [],
    protectGitInternals: true,
  }

  let sandboxSettings = defaultSandboxSettings
  const sandboxMode: SandboxMode = 'auto'

  try {
    const { readFile } = await import('node:fs/promises')
    const sandboxConfigPath = path.join(cwd, '.cc-agent', 'sandbox.json')
    const raw = await readFile(sandboxConfigPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SandboxSettings>
    sandboxSettings = {
      enabled: parsed.enabled ?? defaultSandboxSettings.enabled,
      enabledPlatforms: parsed.enabledPlatforms ?? defaultSandboxSettings.enabledPlatforms,
      filesystem: parsed.filesystem,
      network: parsed.network,
      protectGitInternals: parsed.protectGitInternals ?? defaultSandboxSettings.protectGitInternals,
    }
  } catch {
    // Config file not found or parse error — use defaults (sandbox off).
  }

  const adapterPermCtx: AdapterPermissionContext = {
    cwd,
  }

  const sandboxRuntimeConfig = convertToSandboxRuntimeConfig(
    sandboxSettings,
    adapterPermCtx,
  )

  // ---- Coordinator mode ----
  // Coordinator mode is already factored into the system prompt via
  // buildEffectiveSystemPrompt above.  The swarm infrastructure below
  // is instantiated conditionally based on the coordinatorMode flag.

  // ---- Swarm infrastructure ----
  // Only instantiate the swarm primitives when coordinator mode is active.
  // They are lightweight but unnecessary for single-agent sessions.
  const teamRegistry = coordinatorMode ? new TeamRegistry() : undefined
  const fileMailbox = coordinatorMode ? new FileMailbox(cwd) : undefined
  const backgroundTaskRegistry = coordinatorMode ? new BackgroundTaskRegistry() : undefined

  // ---- Hooks ----
  // Load lifecycle hooks from project configuration (.cc-agent/hooks.json
  // or .cc-agent/settings.json).  Hook failures are logged but never fatal.
  let hooks: HookDefinition[] = []
  try {
    hooks = await loadHooks(cwd)
    if (hooks.length > 0) {
      console.error(`[hooks] Loaded ${hooks.length} hook(s) from project configuration`)
    }
  } catch (err) {
    console.error(
      '[hooks] Failed to load hooks:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Persist the swarm infrastructure into appState so tools can access it.
  // The QueryEngine reads these from the config's appState and injects them
  // into the ToolUseContext on each tool call.

  return {
    tools: filteredTools,
    mcpToolDefs,
    skills,
    mcpManager,
    systemPrompt,
    permissionContext,
    cwd,
    sessionId,
    model: effectiveModel,
    enableMemory,
    memoryDir,
    sandboxRuntimeConfig,
    sandboxMode,
    coordinatorMode,
    teamRegistry: teamRegistry ?? undefined,
    fileMailbox: fileMailbox ?? undefined,
    backgroundTaskRegistry: backgroundTaskRegistry ?? undefined,
    hooks,
  }
}

// ============================================================
// Query engine factory
// ============================================================

/**
 * Create a QueryEngine wired to the assembled runtime.
 *
 * @param runtime  — the assembled runtime context.
 * @param options  — optional flags:
 *   - `silent`: when true, skip the real-time text streaming listener.
 *     Used by headless mode which outputs text via `result.text` instead.
 */
function createQueryEngine(
  runtime: AssembledRuntime,
  options: { silent?: boolean; fullySilent?: boolean } = {},
): QueryEngine {
  const config: QueryEngineConfig = {
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    tools: runtime.tools,
    permissionContext: runtime.permissionContext,
    cwd: runtime.cwd,
    sessionId: runtime.sessionId,
    maxTokens: DEFAULT_MAX_TOKENS,
    // Inject sandbox and swarm infrastructure into appState so tools
    // (AgentTool in particular) can access the registries at invocation time.
    sandboxState: {
      sandbox: { enabled: runtime.sandboxRuntimeConfig?.enabled ?? false },
      sandboxRuntimeConfig: runtime.sandboxRuntimeConfig ?? undefined,
      sandboxMode: runtime.sandboxMode,
      teamRegistry: runtime.teamRegistry,
      fileMailbox: runtime.fileMailbox,
      backgroundTaskRegistry: runtime.backgroundTaskRegistry,
    },
    // Lifecycle hooks for PreToolUse/PostToolUse interception.
    hooks: runtime.hooks,
  }

  const engine = new QueryEngine(config)

  // Wire up event listeners for console output.
  // In silent mode, skip text streaming — the caller handles output.
  if (!options.silent && !options.fullySilent) {
    engine.on('text', (content: string) => {
      process.stdout.write(content)
    })
  }

  // In fullySilent mode (Ink TUI), skip all stderr logging —
  // the UI component handles its own display via engine events.
  if (!options.fullySilent) {
    engine.on('tool:use', (toolUse) => {
      console.error(`\n[tool] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 120)})`)
    })

    engine.on('tool:result', (toolResult) => {
      const preview = typeof toolResult.content === 'string'
        ? toolResult.content.slice(0, 200)
        : '[complex result]'
      const status = toolResult.is_error ? 'error' : 'ok'
      console.error(`[tool] -> ${status}: ${preview}`)
    })

    engine.on('done', (result: QueryResult) => {
      if (result.stopReason && result.stopReason !== 'end_turn') {
        console.error(`\n[stopped: ${result.stopReason}]`)
      }
      console.error(
        `\n[tokens: ${result.tokenUsage.inputTokens} in / ${result.tokenUsage.outputTokens} out, ` +
        `${result.turnsUsed} turns, ${(result.durationMs / 1000).toFixed(1)}s]`,
      )
    })

    engine.on('error', (error: Error) => {
      console.error(`\n[error] ${error.message}`)
    })
  }

  return engine
}

// ============================================================
// User input processing
// ============================================================

/**
 * Run a user prompt through the query engine and display results.
 *
 * Also handles:
 *  - Relevant memory injection (before the query)
 *  - Session memory extraction (after the query, threshold-gated)
 */
async function processUserInput(
  prompt: string,
  engine: QueryEngine,
  runtime: AssembledRuntime,
  alreadySurfacedMemories?: string[],
): Promise<void> {
  console.log('') // Blank line before response.

  // ---- Relevant memory injection ----
  // Before the query, find relevant memory files and inject a hint into
  // the prompt so the model knows about available context.
  let effectivePrompt = prompt
  if (runtime.enableMemory && alreadySurfacedMemories) {
    try {
      const relevant = await findRelevantMemories(runtime.memoryDir, {
        currentContext: prompt,
        alreadySurfaced: alreadySurfacedMemories,
        maxResults: 3,
      })
      if (relevant.length > 0) {
        const memHints = relevant.map(r =>
          `- ${r.name}: ${r.description} (path: ${r.path})`,
        ).join('\n')
        effectivePrompt = prompt +
          '\n\n[Relevant memory files you may want to read for context:]\n' +
          memHints
        // Track surfaced files to avoid re-injection.
        for (const r of relevant) {
          alreadySurfacedMemories.push(r.path)
        }
      }
    } catch {
      // Memory scan failure is non-fatal.
    }
  }

  // Persist user message
  const userMsgId = randomUUID()
  try {
    sessionStorage.appendEntry({
      type: 'user',
      uuid: userMsgId,
      sessionId: runtime.sessionId,
      timestamp: Date.now(),
      role: 'user',
      content: prompt,
    } as any, runtime.cwd)
  } catch { /* persistence is best-effort */ }

  try {
    const result = await engine.run(effectivePrompt)

    // Persist assistant response
    try {
      sessionStorage.appendEntry({
        type: 'assistant',
        uuid: randomUUID(),
        sessionId: runtime.sessionId,
        timestamp: Date.now(),
        role: 'assistant',
        content: result.text,
        parentUuid: userMsgId,
      } as any, runtime.cwd)
    } catch { /* best-effort */ }

    // Ensure output ends on a new line.
    if (!result.text.endsWith('\n')) {
      process.stdout.write('\n')
    }

    // ---- Session memory extraction (threshold-gated) ----
    if (runtime.enableMemory) {
      try {
        const state = engine.getState()
        const memState = getSessionMemoryState(runtime.sessionId)
        const decision = shouldExtractMemory({
          messages: state.messages,
          sessionMemoryState: memState,
        })
        if (decision.shouldExtract) {
          await updateSessionMemory(runtime.sessionId, state.messages)
          console.error(`[memory] Session memory updated (${decision.reason})`)
        }
      } catch {
        // Memory extraction failure is non-fatal.
      }
    }

    // Check if auto-compact is needed
    const state = engine.getState()
    const totalTokens = estimateMessageTokens(state.messages.map(m => ({ content: m.content })))
    const effectiveWindow = getEffectiveContextWindowSize(runtime.model)
    if (shouldAutoCompact(totalTokens, effectiveWindow)) {
      console.error('[auto-compact] Context approaching limit, compacting...')

      // Use the real compact service: strip images, preserve tool chains,
      // compute a summary, and reload the engine with compacted history.
      const targetTokens = Math.floor(effectiveWindow * 0.5) // keep 50% budget
      const { result, keptMessages } = compactConversation(
        state.messages,
        { targetTokens },
      )

      engine.reset()
      engine.loadHistory(keptMessages)

      console.error(
        `[auto-compact] Done. Removed ${result.messagesRemoved} messages, ` +
        `kept ${result.messagesKept}. ` +
        `Tokens: ${result.tokenCountBefore} → ${result.tokenCountAfter}`,
      )
    }
  } catch (err) {
    console.error(
      'Query failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ============================================================
// Slash command dispatch (delegates to commands.ts registry)
// ============================================================

/**
 * Dispatch a slash command through the command registry from commands.ts
 * and return a status string for the REPL loop.
 *
 * Returns:
 *   - 'exit'    — the REPL should terminate
 *   - 'reset'   — the engine was reset (e.g. /clear, /compact, /resume)
 *   - 'ok'      — command handled, continue normally
 */
async function handleCommand(
  input: string,
  engine: QueryEngine,
  runtime: AssembledRuntime,
): Promise<'exit' | 'reset' | 'ok'> {
  // Build the CommandContext expected by the command registry.
  const commandContext: CommandContext = {
    queryEngine: engine,
    appState: {
      messages: engine.getState().messages,
      input: '',
      isLoading: engine.getState().status === 'running',
      permissionContext: runtime.permissionContext,
      tools: runtime.tools,
      mcpClients: new Map(),
      agents: [],
      sessionId: runtime.sessionId,
      cwd: runtime.cwd,
      compacted: false,
      notifications: [],
      skills: runtime.skills as unknown as undefined,
    } as any,
    tools: runtime.tools,
    cwd: runtime.cwd,
    sessionId: runtime.sessionId,
    model: runtime.model,
    memoryEnabled: runtime.enableMemory,
    setModel: (newModel: string) => {
      (runtime as { model: string }).model = newModel
    },
  }

  const result: CommandResult = await executeCommand(input, commandContext)

  // Handle error results — display and continue.
  if (result.error) {
    console.error(result.error)
    return 'ok'
  }

  // Handle exit signal.
  if (result.exit) {
    if (result.text) console.log(result.text)
    return 'exit'
  }

  // Print the command's text output (if any).
  if (result.text) {
    console.log(result.text)
  }

  // Handle clearMessages signal (/clear).
  if (result.clearMessages) {
    engine.reset()
    return 'reset'
  }

  // Special post-processing for /compact:
  // The command registry signals intent but the REPL performs the actual
  // compaction since it owns the engine lifecycle.
  const commandName = input.trim().replace(/^\/+/, '').split(/\s+/)[0]!.toLowerCase()

  if (commandName === 'compact') {
    const state = engine.getState()
    if (state.messages.length >= 4) {
      const effectiveWindow = getEffectiveContextWindowSize(runtime.model)
      const targetTokens = Math.floor(effectiveWindow * 0.5)
      const { result: compactResult, keptMessages } = compactConversation(
        state.messages,
        { targetTokens },
      )
      engine.reset()
      engine.loadHistory(keptMessages)
      console.log(
        `Compacted: removed ${compactResult.messagesRemoved} messages, ` +
        `kept ${compactResult.messagesKept}. ` +
        `Tokens: ${compactResult.tokenCountBefore} → ${compactResult.tokenCountAfter}`,
      )
      return 'reset'
    }
    return 'ok'
  }

  // Special post-processing for /resume:
  // The command registry returns a signal; the REPL performs the actual
  // session recovery since it owns the engine lifecycle.
  if (commandName === 'resume') {
    const resumeArgs = input.trim().replace(/^\/+/, '').split(/\s+/).slice(1).join(' ').trim()
    const targetId = resumeArgs || 'last'
    console.log(`Resuming session: ${targetId}...`)
    try {
      const { loadConversationForResume } = await import('./utils/conversationRecovery.js')
      const recovery = await loadConversationForResume(targetId, runtime.cwd)

      const messages = recovery.messages
      console.log(`Loaded ${messages.length} messages from session ${recovery.sessionId}.`)

      // Surface recovery warnings
      for (const w of recovery.warnings) {
        console.log(`  [warn] ${w}`)
      }

      // Display a summary of the conversation history
      const previewCount = Math.min(messages.length, 5)
      for (let i = 0; i < previewCount; i++) {
        const msg = messages[i]
        const preview = typeof msg.content === 'string'
          ? msg.content.slice(0, 100)
          : '[tool exchange]'
        console.log(`  [${msg.role}] ${preview}`)
      }
      if (messages.length > previewCount) {
        console.log(`  ... and ${messages.length - previewCount} more messages`)
      }

      // Show file history if available
      if (recovery.fileHistory.length > 0) {
        console.log(`  Files touched: ${recovery.fileHistory.slice(0, 5).join(', ')}`)
      }

      // Create a fresh engine and inject the recovered history.
      engine = createQueryEngine(runtime)
      if (messages.length > 0) {
        const historyMessages: Message[] = messages.map(m => ({
          id: m.id || m.uuid,
          uuid: m.uuid,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          parentUuid: m.parentUuid,
          model: m.model,
        }))
        engine.loadHistory(historyMessages)

        // If there was an interrupted turn, show the continuation context
        if (recovery.interruptedTurnState) {
          const pending = recovery.interruptedTurnState.pendingToolUses
          console.log(
            `  Detected interrupted turn with ${pending.length} pending tool call(s): ` +
            pending.map(t => t.name).join(', '),
          )
        }

        console.log(`Session context loaded. Type your next message to continue.`)
      }
      console.log('Session resumed.')
    } catch (err) {
      console.error('Resume failed:', err instanceof Error ? err.message : String(err))
    }
    return 'reset'
  }

  // Special post-processing for /model:
  // After a successful model switch, signal the REPL to recreate the engine.
  // The REPL loop handles engine recreation via the 'reset' signal.
  if (commandName === 'model' && result.text?.startsWith('Model switched to:')) {
    return 'reset'
  }

  return 'ok'
}

// ============================================================
// System prompt construction
// ============================================================

/**
 * Build the default system prompt when none is provided via CLI.
 *
/**
 * Compose the full system prompt from the base and optional appendage.
 */
function buildFullSystemPrompt(
  base?: string,
  append?: string,
): string | undefined {
  if (!base && !append) return undefined
  const parts: string[] = []
  if (base) parts.push(base)
  if (append) parts.push(append)
  return parts.join('\n\n')
}

// ============================================================
// Graceful shutdown
// ============================================================

/**
 * Perform an orderly shutdown of all subsystems.
 *
 * Disconnects MCP servers, cancels all background agent tasks, dissolves
 * all teams, emits shutdown telemetry, and destroys HTTP agents.  Errors
 * during shutdown are logged but do not propagate -- the goal is to
 * release as many resources as possible.
 */
async function gracefulShutdown(
  runtime: AssembledRuntime,
  initCtx: InitContext,
): Promise<void> {
  // ---- Run SessionEnd hooks ----
  if (runtime.hooks.length > 0) {
    try {
      await runHooks(
        runtime.hooks,
        'SessionEnd',
        { toolName: undefined },
        runtime.cwd,
      )
    } catch (err) {
      console.error(
        '[hooks] SessionEnd hook error:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ---- Cancel all background agent tasks ----
  try {
    const runningTasks = runtime.backgroundTaskRegistry?.listTasks('running') ?? []
    if (runningTasks.length > 0) {
      console.error(
        `[shutdown] Cancelling ${runningTasks.length} background agent task(s)...`,
      )
      runtime.backgroundTaskRegistry?.cancelAll()
    }
  } catch (err) {
    console.error(
      '[shutdown] Error cancelling background tasks:',
      err instanceof Error ? err.message : err,
    )
  }

  // ---- Dissolve all teams and persist their final state ----
  try {
    const teams = runtime.teamRegistry?.listTeams() ?? []
    for (const team of teams) {
      try {
        await runtime.teamRegistry?.persistTeam(team.name, runtime.cwd)
      } catch { /* best-effort */ }
      runtime.teamRegistry?.dissolveTeam(team.name)
    }
    if (teams.length > 0) {
      console.error(`[shutdown] Dissolved ${teams.length} team(s).`)
    }
  } catch (err) {
    console.error(
      '[shutdown] Error dissolving teams:',
      err instanceof Error ? err.message : err,
    )
  }

  // Flush session write queue to persist data before exit.
  try {
    await sessionStorage.flushWriteQueue()
  } catch (err) {
    console.error(
      '[shutdown] Error flushing session queue:',
      err instanceof Error ? err.message : err,
    )
  }

  // Clean up session memory in-memory state.
  try {
    disposeSessionMemory(runtime.sessionId)
  } catch { /* best-effort */ }

  try {
    await runtime.mcpManager.disconnectAll()
  } catch (err) {
    console.error(
      '[shutdown] Error disconnecting MCP servers:',
      err instanceof Error ? err.message : err,
    )
  }

  try {
    emitTelemetry(initCtx, 'cli.shutdown', {})
    await shutdown(initCtx)
  } catch (err) {
    console.error(
      '[shutdown] Error during init shutdown:',
      err instanceof Error ? err.message : err,
    )
  }
}

// ============================================================
// Tool-pool merging
// ============================================================

/**
 * Merge built-in tools with MCP tool instances.
 *
 * Built-in tools always take priority when names collide.  Among MCP tools
 * the first-seen wins.
 */
function mergeToolPools(
  builtIn: ToolInstance[],
  mcpTools: ToolInstance[],
): ToolInstance[] {
  const builtInNames = new Set(builtIn.map(t => t.name))
  const seen = new Set(builtInNames)
  const merged = [...builtIn]

  for (const mcpTool of mcpTools) {
    if (!seen.has(mcpTool.name)) {
      seen.add(mcpTool.name)
      merged.push(mcpTool)
    }
  }

  return merged
}

// ============================================================
// Argv helpers
// ============================================================

/**
 * Extract the value of a `--flag value` pair from an argv array.
 * Returns `undefined` when the flag is absent.
 */
function extractArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  return argv[idx + 1]
}

/**
 * Extract all values for a repeatable `--flag value` argument.
 *
 * @example
 * extractAllArgs(['--add-dir', 'a', '--add-dir', 'b'], '--add-dir')
 * // => ['a', 'b']
 */
function extractAllArgs(argv: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) {
      values.push(argv[i + 1]!)
      i++ // Skip the value.
    }
  }
  return values
}

// ============================================================
// SDK-mode helpers
// ============================================================

function writeSdkResponse(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + '\n')
}

// ============================================================
// Default export
// ============================================================

export default main
