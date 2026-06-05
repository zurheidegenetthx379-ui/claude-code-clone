/**
 * SDK mode — JSON protocol on stdin/stdout.
 *
 * Reads JSON-protocol messages from stdin, processes each through the query
 * engine, and writes JSON responses to stdout.
 *
 * This is a simplified implementation; a production version would implement
 * the full Claude Code SDK wire protocol.
 */

import readline from 'node:readline'

import {
  assembleRuntime,
  createQueryEngine,
  writeSdkResponse,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../main.js'
import type { SdkModeOptions } from '../main.js'

import { runHooks } from '../services/hooks/hookRunner.js'

/**
 * Run in SDK / machine-to-machine mode.
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
