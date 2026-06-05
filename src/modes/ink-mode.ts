/**
 * Interactive REPL mode — React+Ink TUI (--ink).
 *
 * Performs the same initialization and runtime assembly as `startRepl()`,
 * but renders the full-screen Ink component tree from
 * `components/REPL/REPL.tsx` instead of using a plain readline loop.
 */

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
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../main.js'
import type { ReplOptions } from '../main.js'

import {
  initSessionMemory,
} from '../services/SessionMemory/sessionMemory.js'

import { runHooks } from '../services/hooks/hookRunner.js'

import { launchRepl } from '../replLauncher.js'

/**
 * Start the interactive REPL using the React+Ink terminal UI.
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
    appendSystemPrompt: options.appendSystemPrompt,
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
  const engine = createQueryEngine(runtime, { fullySilent: true, isInteractive: true })

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
