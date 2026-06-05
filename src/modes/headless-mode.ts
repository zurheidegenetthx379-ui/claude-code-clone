/**
 * Headless mode — single-shot pipe execution.
 *
 * Assembles the runtime, runs a single query through the engine, prints the
 * result to stdout, and exits.  Designed for piping: the response text is
 * the only thing written to stdout; all diagnostics go to stderr.
 */

import { randomUUID } from 'node:crypto'

import {
  assembleRuntime,
  createQueryEngine,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../main.js'
import type { HeadlessOptions } from '../main.js'

import * as sessionStorage from '../utils/sessionStorage.js'
import { runHooks } from '../services/hooks/hookRunner.js'
import type { QueryResult } from '../QueryEngine.js'

/**
 * Execute a single prompt in headless mode.
 */
export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const runtime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    permissionMode: options.permissionMode ?? 'default',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: options.cwd,
    mcpConfigs: [],
    allowList: options.allowList,
    denyList: options.denyList,
  })

  const engine = createQueryEngine(runtime, { silent: true, isInteractive: false })

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
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        engine.abort() // Abort the running query so the API call doesn't continue
        reject(new Error(`Headless query timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    let result: QueryResult
    try {
      result = await Promise.race([engine.run(options.prompt), timeoutPromise])
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId) // Always clean up the timer
      }
    }

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
