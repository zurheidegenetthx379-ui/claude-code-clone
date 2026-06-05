/**
 * Shared Tool Executor — single source of truth for tool invocation.
 *
 * Both `query.ts` (async-generator loop) and `QueryEngine.ts` (EventEmitter
 * engine) route their tool calls through the `executeToolCall` function
 * defined here.  This eliminates duplicated validation, permission, hook,
 * and result-formatting logic across the two consumers.
 *
 * Pipeline stages executed in order:
 *   1. Tool lookup & enabled check (optional)
 *   2. Schema validation (required-field check against JSON-Schema `required`)
 *   3. Semantic validation (`tool.validateInput` if exposed)
 *   4. Pre-tool hooks (`PreToolUse` via hookRunner)
 *   5. Permission check (via caller-supplied `canUseTool` callback)
 *   6. `tool.call()` execution
 *   7. Post-tool hooks (`PostToolUse` via hookRunner — informational)
 *   8. Result formatting into a `ToolResultBlock`
 *
 * Any unhandled exception at any stage is caught and converted into a
 * standardized error `tool_result` so the model can self-correct.
 */

import type {
  HookDefinition,
  Message,
  PermissionContext,
  PermissionResult,
  ToolInstance,
  ToolProgressData,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
  ToolUseContext,
  CanUseTool,
} from '../types/index.js'

import {
  runHooks,
  aggregateHookResults,
} from '../services/hooks/hookRunner.js'

// ============================================================
// Public Interface
// ============================================================

/**
 * Options controlling optional behaviour in `executeToolCall`.
 */
export interface ExecuteToolCallOptions {
  /**
   * When `true`, the tool must be enabled (`tool.isEnabled() === true`)
   * to proceed.  When `false` (default), the enabled check is skipped.
   *
   * QueryEngine uses `true` because it resolves tools through its own
   * `findTool` helper that already filters by enabled state.  The query.ts
   * loop passes `false` because it works with the full tool list.
   */
  checkEnabled?: boolean

  /**
   * Optional progress callback forwarded to `tool.call()`.
   * QueryEngine uses this to emit state-update events during long-running
   * tool executions.  query.ts passes `undefined`.
   */
  onProgress?: (progress: ToolProgressData) => void
}

/**
 * Execute a single tool_use block through the full pipeline.
 *
 * This is the **single place** where tools are actually executed, validated,
 * permission-checked, hooked, and their results formatted.  Both `query.ts`
 * and `QueryEngine.ts` delegate to this function.
 *
 * @param toolUse        - The tool_use block from the model response.
 * @param tool           - The matching ToolInstance (or `undefined` if not found).
 * @param context        - Shared ToolUseContext passed to every tool.
 * @param parentMessage  - The assistant message that contained this tool_use.
 * @param canUseTool     - Callback to perform permission checks.
 * @param hooks          - Lifecycle hooks for Pre/PostToolUse interception.
 * @param options        - Optional behaviour flags.
 * @returns A ToolResultBlock ready to feed back to the model.
 */
export async function executeToolCall(
  toolUse: ToolUseBlock,
  tool: ToolInstance | undefined,
  context: ToolUseContext,
  parentMessage: Message,
  canUseTool: CanUseTool,
  hooks: HookDefinition[] = [],
  options: ExecuteToolCallOptions = {},
): Promise<ToolResultBlock> {
  // ---- Stage 0: Tool lookup ----
  if (!tool) {
    return makeErrorResult(toolUse.id, `Unknown tool: "${toolUse.name}"`)
  }

  if (options.checkEnabled && !tool.isEnabled()) {
    return makeErrorResult(toolUse.id, `Tool "${toolUse.name}" is not enabled`)
  }

  try {
    // ---- Stage 1: Schema validation (simplified) ----
    const schemaError = validateInputSchema(toolUse.input, tool.inputSchema)
    if (schemaError) {
      return makeErrorResult(toolUse.id, `Schema validation failed: ${schemaError}`)
    }

    // ---- Stage 2: Semantic validation ----
    // Some tools expose a `validateInput` method for richer checks beyond
    // what the JSON schema can express (e.g. path existence, value ranges).
    const validateInput = (tool as unknown as Record<string, unknown>).validateInput
    if (typeof validateInput === 'function') {
      try {
        const semanticError: string | null = await (validateInput as (
          input: Record<string, unknown>,
          ctx: ToolUseContext,
        ) => Promise<string | null>)(toolUse.input, context)
        if (semanticError) {
          return makeErrorResult(toolUse.id, `Validation failed: ${semanticError}`)
        }
      } catch (err) {
        return makeErrorResult(
          toolUse.id,
          `Validation error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ---- Stage 3: Pre-tool hooks ----
    let effectiveInput = { ...toolUse.input }
    if (hooks.length > 0) {
      try {
        const hookResults = await runHooks(
          hooks,
          'PreToolUse',
          { toolName: toolUse.name, input: effectiveInput },
          context.cwd,
        )
        const aggregated = aggregateHookResults(hookResults)
        if (aggregated.decision === 'deny') {
          return makeErrorResult(
            toolUse.id,
            aggregated.message ?? `Tool "${toolUse.name}" denied by hook`,
          )
        }
        if (aggregated.modifiedInput) {
          effectiveInput = { ...effectiveInput, ...aggregated.modifiedInput }
        }
      } catch (err) {
        // Hook execution failure must not crash the main process.
        console.error(
          `[hooks] PreToolUse hook error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ---- Stage 4: Permission check ----
    const permission = await canUseTool(tool, effectiveInput)

    if (permission.behavior === 'deny') {
      return makeErrorResult(
        toolUse.id,
        permission.message ?? `Permission denied for tool "${tool.name}".`,
      )
    }

    // If the permission system returned modified input, use it from here on.
    if (permission.updatedInput) {
      effectiveInput = permission.updatedInput
    }

    // ---- Stage 5: Execute tool.call() ----
    const result: ToolResult = await tool.call(
      effectiveInput,
      context,
      canUseTool,
      parentMessage,
      options.onProgress,
    )

    // ---- Stage 6: Post-tool hooks (informational, results don't affect flow) ----
    if (hooks.length > 0) {
      try {
        const outputStr = typeof (result.content ?? result.output) === 'string'
          ? String(result.content ?? result.output)
          : '[complex result]'
        await runHooks(
          hooks,
          'PostToolUse',
          { toolName: toolUse.name, output: outputStr },
          context.cwd,
        )
      } catch (err) {
        console.error(
          `[hooks] PostToolUse hook error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ---- Stage 7: Format result ----
    return formatToolResult(toolUse.id, result)
  } catch (err) {
    // Catch-all: any unhandled exception becomes a tool error the model can
    // reason about, rather than crashing the entire loop.
    const errorMessage = err instanceof Error ? err.message : String(err)
    return makeErrorResult(
      toolUse.id,
      `Tool "${toolUse.name}" failed with an unexpected error: ${errorMessage}`,
    )
  }
}

// ============================================================
// Permission Helpers
// ============================================================

/**
 * Build a `CanUseTool` callback that applies deny-list / allow-list checks
 * before delegating to the tool's own `checkPermissions`.
 *
 * Permission resolution order:
 *   1. Deny-list ALWAYS wins — checked first.
 *   2. Run the tool's own `checkPermissions`.
 *   3. If the tool says "deny", respect it regardless of allow-list.
 *   4. If the tool says "ask" and the allow-list includes the tool,
 *      upgrade to "allow" (allow-list can skip "asking" but cannot
 *      override "denying").
 *   5. Otherwise use the tool's verdict as-is.
 *
 * @param permissionContext - Global permission context with deny/allow lists.
 */
export function buildPermissionChecker(
  permissionContext: PermissionContext,
): CanUseTool {
  return async (tool: ToolInstance, input: Record<string, unknown>): Promise<PermissionResult> => {
    // 1. Deny-list ALWAYS wins — checked first.
    if (permissionContext.denyList.includes(tool.name)) {
      return {
        behavior: 'deny',
        message: `Tool "${tool.name}" is on the deny list`,
      }
    }

    // 2. Run the tool's own checkPermissions.
    let toolResult: PermissionResult
    try {
      toolResult = await tool.checkPermissions(input, permissionContext)
    } catch (err) {
      return {
        behavior: 'deny',
        message: `Permission check failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 3. Tool says deny → respect it, regardless of allow-list.
    if (toolResult.behavior === 'deny') {
      return toolResult
    }

    // 4. Tool says ask + allow-list includes tool → upgrade to allow.
    if (toolResult.behavior === 'ask' && permissionContext.allowList.includes(tool.name)) {
      return { behavior: 'allow' }
    }

    // 5. Use tool's verdict as-is.
    return toolResult
  }
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Format a `ToolResult` into a `ToolResultBlock` for the model.
 */
function formatToolResult(toolUseId: string, result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content:
      result.content ??
      (typeof result.output === 'string'
        ? result.output
        : result.output != null
          ? JSON.stringify(result.output)
          : ''),
    is_error: result.isError ?? false,
  }
}

/**
 * Build a standardized error tool_result.
 */
function makeErrorResult(toolUseId: string, message: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: message,
    is_error: true,
  }
}

/**
 * Perform a simplified schema validation of the tool input.
 *
 * A full implementation would use Zod or JSON Schema; here we perform the
 * most critical check: ensuring that all `required` fields declared in the
 * schema are present in the input.
 *
 * @returns An error message string if validation fails, or `null` if valid.
 */
function validateInputSchema(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const required = schema.required
  if (!Array.isArray(required)) return null

  for (const field of required) {
    if (typeof field === 'string' && !(field in input)) {
      return `Missing required field: "${field}"`
    }
  }

  return null
}
