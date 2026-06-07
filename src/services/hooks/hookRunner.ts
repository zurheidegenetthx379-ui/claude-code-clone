/**
 * Hook Runner -- Executes lifecycle hooks defined in project settings.
 *
 * Hooks allow users to run custom shell commands at key points in the
 * agent lifecycle:
 *
 *   - `PreToolUse`  -- before a tool is executed (can deny or modify input)
 *   - `PostToolUse` -- after a tool completes (informational)
 *   - `SessionStart` -- when the agent session begins
 *   - `SessionEnd`   -- when the agent session ends
 *
 * Hook definitions are loaded from `.cc-agent/hooks.json` or from a
 * `hooks` array inside `.cc-agent/settings.json`.
 *
 * Each hook handler is a shell command that receives context via stdin
 * (JSON) and may return a result via stdout (JSON).  Failures are
 * logged but never crash the main process.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { minimatch } from 'minimatch'

import type { HookDefinition, HookResult } from '../../types/index.js'

// --- Constants -----------------------------------------------------------------

/** Default timeout for hook handler execution (milliseconds). */
const HOOK_TIMEOUT_MS = 30_000

/** Maximum stdout size we will attempt to parse (1 MiB). */
const MAX_STDOUT_BYTES = 1024 * 1024

// --- Hook Loading --------------------------------------------------------------

/**
 * Load hook definitions from the project's configuration directory.
 *
 * Checks (in order):
 *   1. `<cwd>/.cc-agent/hooks.json`   -- dedicated hooks file
 *   2. `<cwd>/.cc-agent/settings.json` -- `hooks` array inside settings
 *
 * Returns an empty array when no hooks are configured or when the
 * configuration cannot be read/parsed.
 *
 * @param cwd - The project working directory (used to locate config files).
 */
export async function loadHooks(cwd: string): Promise<HookDefinition[]> {
  // ---- Try dedicated hooks file first ----
  const hooksPath = path.join(cwd, '.cc-agent', 'hooks.json')
  try {
    const raw = await readFile(hooksPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return validateHooks(parsed)
    }
    // If it's an object with a `hooks` array, use that
    if (parsed && Array.isArray(parsed.hooks)) {
      return validateHooks(parsed.hooks)
    }
  } catch {
    // File not found or parse error -- fall through to settings.json
  }

  // ---- Try settings.json ----
  const settingsPath = path.join(cwd, '.cc-agent', 'settings.json')
  try {
    const raw = await readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.hooks)) {
      return validateHooks(parsed.hooks)
    }
  } catch {
    // File not found or parse error -- no hooks configured
  }

  return []
}

/**
 * Validate and normalise a raw array of hook definitions.
 * Invalid entries are silently skipped.
 */
function validateHooks(raw: unknown[]): HookDefinition[] {
  const valid: HookDefinition[] = []
  const validEvents = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'])

  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).event === 'string' &&
      typeof (entry as Record<string, unknown>).handler === 'string'
    ) {
      const def = entry as Record<string, unknown>
      if (!validEvents.has(def.event as string)) continue
      if ((def.handler as string).trim() === '') continue

      valid.push({
        event: def.event as HookDefinition['event'],
        matcher: typeof def.matcher === 'string' ? def.matcher : undefined,
        handler: def.handler as string,
      })
    }
  }

  return valid
}

// --- Hook Matching -------------------------------------------------------------

/**
 * Find all hooks that match a given event and optional tool name.
 *
 * Matching rules:
 *   - The hook's `event` must match exactly.
 *   - If the hook has a `matcher` (glob pattern), it is matched against
 *     `toolName` using minimatch.  Hooks without a matcher match all
 *     tool names (or events that don't involve a tool, like SessionStart).
 *   - For `SessionStart` and `SessionEnd` events, the matcher is ignored
 *     (all hooks for that event match).
 *
 * @param hooks    - All loaded hook definitions.
 * @param event    - The lifecycle event to match.
 * @param toolName - Optional tool name for PreToolUse / PostToolUse events.
 */
export function findMatchingHooks(
  hooks: HookDefinition[],
  event: HookDefinition['event'],
  toolName?: string,
): HookDefinition[] {
  return hooks.filter((hook) => {
    // Event must match exactly
    if (hook.event !== event) return false

    // Session events always match (no tool name to filter on)
    if (event === 'SessionStart' || event === 'SessionEnd') return true

    // If no matcher, the hook applies to all tools
    if (!hook.matcher) return true

    // If there's a matcher but no tool name, skip (shouldn't happen in
    // practice for Pre/PostToolUse, but be defensive)
    if (!toolName) return true

    // Use minimatch for glob-style matching on tool names
    return minimatch(toolName, hook.matcher, { matchBase: true })
  })
}

// --- Hook Execution ------------------------------------------------------------

/**
 * Context passed to a hook handler via stdin (JSON).
 */
export interface HookContext {
  /** The lifecycle event that triggered this hook. */
  event: string
  /** The tool name (for PreToolUse / PostToolUse events). */
  toolName?: string
  /** The tool's input parameters (for PreToolUse). */
  input?: Record<string, unknown>
  /** The tool's output (for PostToolUse). */
  output?: string
}

/**
 * Execute a single hook handler shell command.
 *
 * The handler receives the hook context as JSON on stdin and may
 * produce a JSON result on stdout.  If the handler produces no output
 * or invalid JSON, an empty HookResult is returned (which means
 * "no opinion" -- the tool proceeds normally).
 *
 * Errors during execution are caught and logged; they do not propagate.
 *
 * @param hook    - The hook definition containing the handler command.
 * @param context - The context to pass to the handler.
 * @param cwd     - Working directory for the shell command.
 * @returns The parsed HookResult, or an empty object on failure.
 */
export async function executeHook(
  hook: HookDefinition,
  context: HookContext,
  cwd?: string,
): Promise<HookResult> {
  return new Promise<HookResult>((resolve) => {
    const contextJson = JSON.stringify(context)
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(hook.handler, {
      shell: true,
      cwd: cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CC_AGENT_HOOK_EVENT: context.event,
        CC_AGENT_HOOK_TOOL_NAME: context.toolName ?? '',
      },
    })

    // Write context to stdin and close it
    child.stdin.on('error', () => { /* ignore stdin errors */ })
    child.stdin.write(contextJson, () => {
      child.stdin.end()
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk.toString()
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Timeout guard
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        console.error(
          `[hooks] Hook handler timed out after ${HOOK_TIMEOUT_MS / 1000}s: ${hook.handler}`,
        )
        resolve({})
      }
    }, HOOK_TIMEOUT_MS)

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        console.error(
          `[hooks] Hook handler failed to start: ${hook.handler} -- ${err.message}`,
        )
        resolve({})
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      // Log stderr if present (informational)
      if (stderr.trim()) {
        console.error(`[hooks] Hook "${hook.handler}" stderr: ${stderr.trim().slice(0, 500)}`)
      }

      // Non-zero exit is not an error for the main process, but log it
      if (code !== 0 && code !== null) {
        console.error(
          `[hooks] Hook "${hook.handler}" exited with code ${code}`,
        )
      }

      // Try to parse stdout as JSON HookResult
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({})
        return
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const result: HookResult = {}

        // Validate and extract known fields
        if (
          parsed.decision === 'allow' ||
          parsed.decision === 'deny' ||
          parsed.decision === 'ask'
        ) {
          result.decision = parsed.decision
        }
        if (typeof parsed.message === 'string') {
          result.message = parsed.message
        }
        if (
          parsed.modifiedInput !== null &&
          typeof parsed.modifiedInput === 'object' &&
          !Array.isArray(parsed.modifiedInput)
        ) {
          result.modifiedInput = parsed.modifiedInput as Record<string, unknown>
        }

        resolve(result)
      } catch {
        // stdout was not valid JSON -- treat as no-op
        console.error(
          `[hooks] Hook "${hook.handler}" produced non-JSON output (ignored): ${trimmed.slice(0, 200)}`,
        )
        resolve({})
      }
    })
  })
}

// --- Batch Hook Runner ---------------------------------------------------------

/**
 * Run all matching hooks in order and collect their results.
 *
 * This is the main entry point for hook execution.  It:
 *   1. Finds all hooks matching the event + tool name.
 *   2. Executes them sequentially (order matters for PreToolUse hooks
 *      that may modify input).
 *   3. Collects and returns all results.
 *
 * Individual hook failures are caught and logged -- they never prevent
 * other hooks from running or crash the main process.
 *
 * @param hooks   - All loaded hook definitions.
 * @param event   - The lifecycle event.
 * @param context - The hook execution context.
 * @param cwd     - Working directory for shell commands.
 * @returns Array of HookResult objects (one per matching hook).
 */
export async function runHooks(
  hooks: HookDefinition[],
  event: HookDefinition['event'],
  context: Omit<HookContext, 'event'>,
  cwd?: string,
): Promise<HookResult[]> {
  const matching = findMatchingHooks(hooks, event, context.toolName)
  if (matching.length === 0) return []

  const results: HookResult[] = []

  for (const hook of matching) {
    try {
      const result = await executeHook(
        hook,
        { ...context, event },
        cwd,
      )
      results.push(result)
    } catch (err) {
      // Hook execution must never crash the main process
      console.error(
        `[hooks] Unexpected error running hook "${hook.handler}": ` +
        (err instanceof Error ? err.message : String(err)),
      )
      results.push({})
    }
  }

  return results
}

// --- Convenience: Aggregate Hook Decisions ------------------------------------

/**
 * Aggregate multiple HookResults into a single decision.
 *
 * Rules:
 *   - If ANY hook returns `decision: 'deny'`, the aggregate is `'deny'`.
 *   - If ANY hook returns `decision: 'ask'` (and none deny), the aggregate is `'ask'`.
 *   - Otherwise the aggregate is `'allow'` (or undefined if no hooks ran).
 *   - The first `modifiedInput` found is used (later modifications are ignored
 *     to keep behaviour predictable).
 *   - Messages from all hooks are concatenated.
 *
 * @param results - Array of HookResult objects from runHooks.
 * @returns A single aggregated HookResult.
 */
export function aggregateHookResults(results: HookResult[]): HookResult {
  if (results.length === 0) return {}

  let hasAsk = false
  let deniedMessage: string | undefined
  const messages: string[] = []
  let modifiedInput: Record<string, unknown> | undefined

  for (const result of results) {
    if (result.decision === 'deny') {
      deniedMessage = result.message ?? 'Denied by hook'
      // Don't return early -- collect all messages
    }
    if (result.decision === 'ask') {
      hasAsk = true
    }
    if (result.message) {
      messages.push(result.message)
    }
    if (!modifiedInput && result.modifiedInput) {
      modifiedInput = result.modifiedInput
    }
  }

  // Priority: deny > ask > allow
  if (deniedMessage) {
    return {
      decision: 'deny',
      message: messages.join('\n'),
      modifiedInput,
    }
  }

  if (hasAsk) {
    return {
      decision: 'ask',
      message: messages.join('\n') || undefined,
      modifiedInput,
    }
  }

  return {
    decision: 'allow',
    message: messages.length > 0 ? messages.join('\n') : undefined,
    modifiedInput,
  }
}
