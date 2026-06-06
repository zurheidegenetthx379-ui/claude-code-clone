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
 * Mode-specific implementations live in src/modes/:
 *   - modes/headless-mode.ts — single-shot pipe mode
 *   - modes/sdk-mode.ts      — JSON protocol on stdin/stdout
 *   - modes/repl-mode.ts     — interactive readline REPL
 *   - modes/ink-mode.ts      — React+Ink full-screen TUI REPL
 *
 * Exports consumed by entrypoints/cli.ts (re-exported from mode files):
 *   - runHeadless(options)  — single-shot pipe mode
 *   - runSdkMode(options)   — JSON protocol on stdin/stdout
 *   - startRepl(options)    — interactive readline REPL
 *   - startInkRepl(options) — React+Ink full-screen TUI REPL
 *   - main(argv)            — full CLI dispatcher (default export)
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  init,
  shutdown,
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

import { StreamingMarkdownRenderer } from './utils/terminalRenderer.js'

import * as sessionStorage from './utils/sessionStorage.js'
import type { TranscriptEntry } from './utils/sessionStorage.js'

import {
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

import { loadHooks, runHooks } from './services/hooks/hookRunner.js'
import type { HookDefinition } from './types/index.js'

import { buildEffectiveSystemPrompt } from './utils/systemPrompt.js'

// ============================================================
// Re-exports from mode files (backward compatibility for cli.ts)
// ============================================================

export { runHeadless } from './modes/headless-mode.js'
export { runSdkMode } from './modes/sdk-mode.js'
export { startRepl } from './modes/repl-mode.js'
export { startInkRepl } from './modes/ink-mode.js'
export { startWebServer } from './modes/web-mode.js'

// ============================================================
// Constants
// ============================================================

export const DEFAULT_MODEL = process.env['CC_AGENT_MODEL'] ?? 'claude-sonnet-4-20250514'
export const DEFAULT_MAX_TOKENS = 8192
export const BANNER = `
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
  /** System prompt override (replaces default prompt entirely). */
  systemPrompt?: string
  /** Text appended AFTER the selected base system prompt. */
  appendSystemPrompt?: string
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
  /** Permission allow-list patterns. */
  allowList?: string[]
  /** Permission deny-list patterns. */
  denyList?: string[]
}

export interface SdkModeOptions {
  /** Model override. */
  model?: string
  /** System prompt override (replaces default prompt entirely). */
  systemPrompt?: string
  /** Text appended AFTER the selected base system prompt. */
  appendSystemPrompt?: string
  /** Permission mode. */
  permissionMode?: PermissionMode
  /** Maximum output tokens. */
  maxTokens?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /** Working directory. */
  cwd: string
  /** Permission allow-list patterns. */
  allowList?: string[]
  /** Permission deny-list patterns. */
  denyList?: string[]
}

export interface ReplOptions {
  /** Optional initial prompt to execute on startup. */
  initialPrompt?: string
  /** Model override. */
  model?: string
  /** System prompt override (replaces default prompt entirely). */
  systemPrompt?: string
  /** Text appended AFTER the selected base system prompt. */
  appendSystemPrompt?: string
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

export interface AssembledRuntime {
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
// HandleCommand result (consumed by repl-mode.ts)
// ============================================================

/**
 * Result of dispatching a slash command through the REPL command handler.
 */
export interface HandleCommandResult {
  /** What action the REPL loop should take. */
  action: 'exit' | 'reset' | 'ok'
  /** History messages to load into a fresh engine after reset (e.g. /resume). */
  historyMessages?: Message[]
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

  const fullSystemPrompt = buildFullSystemPrompt(systemPrompt)

  // Import mode functions locally to avoid circular import issues at module
  // evaluation time.  By the time main() is called all modules are fully
  // initialized, but the dynamic import makes the intent explicit.
  const { runHeadless: runHeadlessMode } = await import('./modes/headless-mode.js')
  const { startRepl: startReplMode } = await import('./modes/repl-mode.js')
  const { startInkRepl: startInkReplMode } = await import('./modes/ink-mode.js')

  // ---- Dispatch ----
  try {
    if (isHeadless) {
      const prompt = extractArg(argv, '--print') ?? extractArg(argv, '-p') ?? ''
      await runHeadlessMode({
        prompt,
        model,
        systemPrompt: fullSystemPrompt,
        appendSystemPrompt,
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
        appendSystemPrompt,
        permissionMode,
        maxTokens,
        temperature,
        cwd: initCtx.cwd,
        verbose: argv.includes('--verbose'),
        additionalDirs: addDir,
      }
      if (argv.includes('--ink')) {
        await startInkReplMode({ ...replOpts, useInk: true })
      } else {
        await startReplMode(replOpts)
      }
    }
  } finally {
    await shutdown(initCtx)
  }
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
export async function assembleRuntime(options: {
  model: string
  systemPrompt?: string
  appendSystemPrompt?: string
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
    cwd: cwd,
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

  // ---- System prompt assembly ----
  //
  // Semantics:
  //   1. Base prompt = options.systemPrompt (full override via --system-prompt)
  //                   OR buildEffectiveSystemPrompt() (coordinator > default)
  //   2. If projectSettings.systemPrompt exists, APPEND it to the base
  //   3. If options.appendSystemPrompt exists (--append-system-prompt), APPEND it
  //   4. Context and memory blocks are appended last
  //
  // --system-prompt and --append-system-prompt are non-overlapping:
  //   - --system-prompt REPLACES the default system prompt entirely
  //   - --append-system-prompt is appended AFTER whatever base was selected
  //   - They do NOT both try to set the base prompt
  //
  // projectSettings.systemPrompt (from .cc-agent/settings.json) is ALWAYS
  // appended (never replaces the default).
  const coordinatorMode = isCoordinatorMode()
  const effectiveSystemPrompt = await buildEffectiveSystemPrompt({
    tools: filteredTools,
    model: effectiveModel,
    overrideSystemPrompt: options.systemPrompt,
    coordinatorSystemPrompt: coordinatorMode ? getCoordinatorSystemPrompt() : undefined,
    isCoordinatorMode: coordinatorMode,
    // projectSettings.systemPrompt is appended below, NOT passed here as
    // customSystemPrompt (which would REPLACE the default prompt).
  })
  let systemPrompt = effectiveSystemPrompt.content

  // Append project-level system prompt from .cc-agent/settings.json.
  if (projectSettings.systemPrompt) {
    systemPrompt = systemPrompt + '\n\n' + projectSettings.systemPrompt
  }

  // Append --append-system-prompt AFTER the base + project settings.
  if (options.appendSystemPrompt) {
    systemPrompt = systemPrompt + '\n\n' + options.appendSystemPrompt
  }

  // ---- Context injection (from context.ts) ----
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

  // ---- Swarm infrastructure ----
  const teamRegistry = coordinatorMode ? new TeamRegistry() : undefined
  const fileMailbox = coordinatorMode ? new FileMailbox(cwd) : undefined
  const backgroundTaskRegistry = coordinatorMode ? new BackgroundTaskRegistry() : undefined

  // ---- Hooks ----
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
 *   - `fullySilent`: when true, skip ALL console output (Ink TUI mode).
 *   - `isInteractive`: when true, tools returning `{ behavior: 'ask' }` are
 *     allowed; non-interactive modes auto-deny them.
 */
export function createQueryEngine(
  runtime: AssembledRuntime,
  options: {
    silent?: boolean
    fullySilent?: boolean
    isInteractive?: boolean
    approvalCallback?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
  } = {},
): QueryEngine {
  const config: QueryEngineConfig = {
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    tools: runtime.tools,
    permissionContext: runtime.permissionContext,
    cwd: runtime.cwd,
    sessionId: runtime.sessionId,
    maxTokens: DEFAULT_MAX_TOKENS,
    // Interactive mode: only set when explicitly requested (REPL modes).
    // Headless and SDK modes default to non-interactive, which causes
    // tools returning `{ behavior: 'ask' }` to be denied automatically.
    isInteractive: options.isInteractive ?? false,
    // Approval callback for interactive mode — used when tools return
    // `{ behavior: 'ask' }` to request user confirmation.
    approvalCallback: options.approvalCallback,
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

  // ── Streaming markdown renderer (TTY interactive mode only) ──────
  // When stdout is a TTY and we're not in silent/fullySilent mode, use
  // a StreamingMarkdownRenderer to display rich markdown in real-time
  // with ANSI cursor control.  In pipe mode, fall back to raw write.
  const useRenderer = process.stdout.isTTY === true && !options.silent && !options.fullySilent
  let streamRenderer: StreamingMarkdownRenderer | null = null

  // Wire up event listeners for console output.
  // In silent mode, skip text streaming — the caller handles output.
  if (!options.silent && !options.fullySilent) {
    engine.on('text', (content: string) => {
      if (useRenderer) {
        if (!streamRenderer) {
          streamRenderer = new StreamingMarkdownRenderer()
          streamRenderer.start()
        }
        streamRenderer.update(content)
      } else {
        process.stdout.write(content)
      }
    })
  }

  // In fullySilent mode (Ink TUI), skip all stderr logging —
  // the UI component handles its own display via engine events.
  if (!options.fullySilent) {
    // When a tool call starts, finalize the current text segment so that
    // stderr tool output does not corrupt the cursor position.  The next
    // text chunk will create a fresh renderer.
    engine.on('tool:use', (toolUse) => {
      if (streamRenderer) {
        streamRenderer.finalize()
        streamRenderer = null
      }
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
      // Finalize any active streaming renderer before logging stats.
      if (streamRenderer) {
        streamRenderer.finalize()
        streamRenderer = null
      }
      if (result.stopReason && result.stopReason !== 'end_turn') {
        console.error(`\n[stopped: ${result.stopReason}]`)
      }
      console.error(
        `\n[tokens: ${result.tokenUsage.inputTokens} in / ${result.tokenUsage.outputTokens} out, ` +
        `${result.turnsUsed} turns, ${(result.durationMs / 1000).toFixed(1)}s]`,
      )
    })

    engine.on('error', (error: Error) => {
      // Finalize streaming on error — render what we have.
      if (streamRenderer) {
        streamRenderer.finalize()
        streamRenderer = null
      }
      console.error(`\n[error] ${error.message}`)
    })
  }

  return engine
}

// ============================================================
// User input processing (shared with repl-mode.ts)
// ============================================================

/**
 * Run a user prompt through the query engine and display results.
 *
 * Also handles:
 *  - Relevant memory injection (before the query)
 *  - Session memory extraction (after the query, threshold-gated)
 */
export async function processUserInput(
  prompt: string,
  engine: QueryEngine,
  runtime: AssembledRuntime,
  alreadySurfacedMemories?: string[],
): Promise<void> {
  console.log('') // Blank line before response.

  // ---- Relevant memory injection ----
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
      content: prompt,
    } satisfies TranscriptEntry, runtime.cwd)
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
        content: result.text,
        parentUuid: userMsgId,
      } satisfies TranscriptEntry, runtime.cwd)
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
// Slash command dispatch (shared with repl-mode.ts)
// ============================================================

/**
 * Dispatch a slash command through the command registry from commands.ts
 * and return a structured result for the REPL loop.
 *
 * Returns a {@link HandleCommandResult} with:
 *   - action: 'exit'  — the REPL should terminate
 *   - action: 'reset' — the engine was reset (e.g. /clear, /compact, /resume)
 *   - action: 'ok'    — command handled, continue normally
 *   - historyMessages — optional messages to load into a fresh engine
 */
export async function handleCommand(
  input: string,
  engine: QueryEngine,
  runtime: AssembledRuntime,
): Promise<HandleCommandResult> {
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
    return { action: 'ok' }
  }

  // Handle exit signal.
  if (result.exit) {
    if (result.text) console.log(result.text)
    return { action: 'exit' }
  }

  // Print the command's text output (if any).
  if (result.text) {
    console.log(result.text)
  }

  // Handle clearMessages signal (/clear).
  if (result.clearMessages) {
    engine.reset()
    return { action: 'reset' }
  }

  // Special post-processing for /compact:
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
      return { action: 'reset' }
    }
    return { action: 'ok' }
  }

  // Special post-processing for /resume:
  if (commandName === 'resume') {
    const resumeArgs = input.trim().replace(/^\/+/, '').split(/\s+/).slice(1).join(' ').trim()
    const targetId = resumeArgs || 'last'
    console.log(`Resuming session: ${targetId}...`)
    let historyMessages: Message[] = []
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

      // Build history messages for the REPL loop to load into a fresh engine.
      if (messages.length > 0) {
        historyMessages = messages.map((m: any) => ({
          id: m.id || m.uuid,
          uuid: m.uuid,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          parentUuid: m.parentUuid,
          model: m.model,
        }))

        // If there was an interrupted turn, show the continuation context
        if (recovery.interruptedTurnState) {
          const pending = recovery.interruptedTurnState.pendingToolUses
          console.log(
            `  Detected interrupted turn with ${pending.length} pending tool call(s): ` +
            pending.map((t: any) => t.name).join(', '),
          )
        }

        console.log(`Session context loaded. Type your next message to continue.`)
      }
      console.log('Session resumed.')
    } catch (err) {
      console.error('Resume failed:', err instanceof Error ? err.message : String(err))
    }
    return { action: 'reset', historyMessages }
  }

  // Special post-processing for /model:
  if (commandName === 'model' && result.text?.startsWith('Model switched to:')) {
    return { action: 'reset' }
  }

  return { action: 'ok' }
}

// ============================================================
// System prompt construction
// ============================================================

/**
 * Passthrough for the `--system-prompt` CLI flag.
 *
 * System prompt assembly (in assembleRuntime):
 *   1. Base prompt = options.systemPrompt (full override via --system-prompt)
 *                   OR buildEffectiveSystemPrompt() (coordinator > default)
 *   2. If projectSettings.systemPrompt exists, it is APPENDED to the base
 *   3. If options.appendSystemPrompt exists (--append-system-prompt), it is
 *      APPENDED AFTER the base
 *   4. Context and memory blocks are appended last
 *
 * --system-prompt and --append-system-prompt are non-overlapping:
 *   - --system-prompt REPLACES the default system prompt entirely
 *   - --append-system-prompt is appended AFTER whatever base was selected
 *   - They do NOT both try to set the base prompt
 */
function buildFullSystemPrompt(
  override?: string,
): string | undefined {
  // Return the --system-prompt override as-is.
  // When set, it replaces the default prompt in buildEffectiveSystemPrompt.
  // The --append-system-prompt flag is handled separately in assembleRuntime.
  return override
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
export async function gracefulShutdown(
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
// Tool-pool merging (private)
// ============================================================

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
// Argv helpers (private)
// ============================================================

function extractArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  return argv[idx + 1]
}

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
// SDK-mode helpers (shared with sdk-mode.ts)
// ============================================================

export function writeSdkResponse(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + '\n')
}

// ============================================================
// SIGTERM handler (Task 4)
// ============================================================

/**
 * Shared cleanup state for signal handlers.
 * Set by mode functions when they create a runtime/engine pair.
 */
let _signalRuntime: AssembledRuntime | null = null
let _signalEngine: QueryEngine | null = null
let _signalInitCtx: InitContext | null = null

/**
 * Register the current runtime/engine pair for signal-based cleanup.
 * Mode functions call this after creating the runtime so that SIGTERM
 * can perform an orderly shutdown.
 */
export function registerSignalHandlers(
  runtime: AssembledRuntime,
  engine: QueryEngine | null,
  initCtx: InitContext | null,
): void {
  _signalRuntime = runtime
  _signalEngine = engine
  _signalInitCtx = initCtx
}

/**
 * Shared SIGTERM/SIGINT cleanup logic.
 */
async function signalShutdown(): Promise<void> {
  console.error('\nReceived termination signal, shutting down...')

  // Cancel any running queries
  if (_signalEngine?.getState().status === 'running') {
    _signalEngine.abort()
  }

  // Disconnect MCP servers
  if (_signalRuntime?.mcpManager) {
    await _signalRuntime.mcpManager.disconnectAll().catch(() => {})
  }

  // Cancel background tasks
  if (_signalRuntime?.backgroundTaskRegistry) {
    try { _signalRuntime.backgroundTaskRegistry.cancelAll() } catch { /* best-effort */ }
  }

  // Perform full graceful shutdown if init context is available
  if (_signalRuntime && _signalInitCtx) {
    await gracefulShutdown(_signalRuntime, _signalInitCtx).catch(() => {})
  }

  process.exit(130)
}

process.on('SIGTERM', () => {
  signalShutdown().catch(() => process.exit(130))
})

// ============================================================
// Default export
// ============================================================

export default main
