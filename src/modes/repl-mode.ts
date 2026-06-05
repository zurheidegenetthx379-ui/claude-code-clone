/**
 * Interactive REPL mode — readline-based.
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

import readline from 'node:readline'
import path from 'node:path'

import {
  init,
  grantTrust,
  emitTelemetry,
} from '../entrypoints/init.js'

import {
  assembleRuntime,
  createQueryEngine,
  gracefulShutdown,
  processUserInput,
  handleCommand,
  registerSignalHandlers,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  BANNER,
} from '../main.js'
import type { ReplOptions } from '../main.js'

import {
  initSessionMemory,
} from '../services/SessionMemory/sessionMemory.js'

import { runHooks } from '../services/hooks/hookRunner.js'

/**
 * Start the interactive read-eval-print loop.
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

  let engine = createQueryEngine(runtime, { isInteractive: true })

  // Register for signal-based cleanup.
  registerSignalHandlers(runtime, engine, null)

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
  console.log(`  CommandGuard: ${sandboxStatus}`)
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
          const result = await handleCommand(
            trimmed,
            engine,
            runtime,
          )
          if (result.action === 'exit') {
            rl.close()
            return
          }
          if (result.action === 'reset') {
            // After /clear, /compact, or /resume, recreate the engine with
            // fresh state.  If history messages were returned (e.g. /resume),
            // load them into the new engine.
            engine = createQueryEngine(runtime, { isInteractive: true })
            if (result.historyMessages && result.historyMessages.length > 0) {
              engine.loadHistory(result.historyMessages)
            }
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
