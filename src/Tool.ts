/**
 * Tool system foundation - Factory function and utilities
 * Mirrors Claude Code's Tool.ts architecture with fail-closed defaults
 */

import type {
  ToolInstance,
  ToolUseContext,
  PermissionResult,
  PermissionContext,
  ToolResult,
  ToolProgressData,
  Message,
  CanUseTool,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from './types/index.js'

// Re-export ToolUseContext for convenience
export type { ToolUseContext }

/**
 * Default tool policy - FAIL-CLOSED for security
 * All safety flags default to false (most restrictive)
 */
export const TOOL_DEFAULTS = {
  isConcurrencySafe: false,
  isReadOnly: false,
  isDestructive: false,
  requiresUserInteraction: false,
  interruptBehavior: 'block' as const,
}

/**
 * Generate a unique tool use ID
 */
export function createToolUseId(): string {
  return `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Type guard to check if a content block is a tool use
 */
export function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
}

/**
 * Type guard to check if a content block is a tool result
 */
export function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

/**
 * Partial tool definition for buildTool factory
 */
export type PartialToolDefinition = {
  name: string
  description: string | (() => string)
  inputSchema: Record<string, unknown>
  call: (
    input: Record<string, unknown>,
    context: ToolUseContext,
    canUseTool: CanUseTool,
    parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ) => Promise<ToolResult>
  isConcurrencySafe?: boolean | ((input?: Record<string, unknown>) => boolean)
  isReadOnly?: boolean | ((input?: Record<string, unknown>) => boolean)
  isDestructive?: boolean | ((input?: Record<string, unknown>) => boolean)
  checkPermissions?: (
    input: Record<string, unknown>,
    context?: PermissionContext,
  ) => Promise<PermissionResult>
  isEnabled?: () => boolean
  prompt?: (tools: ToolInstance[]) => string
  userFacingName?: (input?: Record<string, unknown>) => string
  interruptBehavior?: () => 'block' | 'cancel' | 'allow'
  requiresUserInteraction?: () => boolean
  renderToolUseMessage?: (input: Record<string, unknown>) => string
  renderToolResultMessage?: (result: ToolResult) => string
}

/**
 * Factory function to build a complete ToolInstance with fail-closed defaults
 * Applies TOOL_DEFAULTS to any unspecified safety flags
 *
 * @param toolDef - Partial tool definition with required fields
 * @returns Complete ToolInstance with all fields populated
 *
 * @example
 * ```typescript
 * const myTool = buildTool({
 *   name: 'MyTool',
 *   description: 'A custom tool',
 *   inputSchema: { type: 'object', properties: {} },
 *   call: async (input, context) => {
 *     return { output: 'result' }
 *   },
 *   isReadOnly: true, // Override default
 * })
 * ```
 */
export function buildTool(toolDef: PartialToolDefinition): ToolInstance {
  // Helper to normalize boolean or function to function
  const normalizeFlag = (
    value: boolean | ((input?: Record<string, unknown>) => boolean) | undefined,
    defaultValue: boolean,
  ): ((input?: Record<string, unknown>) => boolean) => {
    if (value === undefined) {
      return () => defaultValue
    }
    if (typeof value === 'boolean') {
      return () => value
    }
    return value
  }

  // Default permission checker - allows everything
  const defaultCheckPermissions = async (
    _input: Record<string, unknown>,
    _context?: PermissionContext,
  ): Promise<PermissionResult> => {
    return { behavior: 'allow' }
  }

  // Default enabled check
  const defaultIsEnabled = (): boolean => true

  // Default user-facing name
  const defaultUserFacingName = (_input?: Record<string, unknown>): string => {
    return toolDef.name
  }

  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    call: toolDef.call,

    // Safety flags with fail-closed defaults
    isConcurrencySafe: normalizeFlag(toolDef.isConcurrencySafe, TOOL_DEFAULTS.isConcurrencySafe),
    isReadOnly: normalizeFlag(toolDef.isReadOnly, TOOL_DEFAULTS.isReadOnly),
    isDestructive: normalizeFlag(toolDef.isDestructive, TOOL_DEFAULTS.isDestructive),

    // Permission and lifecycle methods
    checkPermissions: toolDef.checkPermissions ?? defaultCheckPermissions,
    isEnabled: toolDef.isEnabled ?? defaultIsEnabled,
    userFacingName: toolDef.userFacingName ?? defaultUserFacingName,

    // Optional methods
    prompt: toolDef.prompt,
    interruptBehavior: toolDef.interruptBehavior ?? (() => TOOL_DEFAULTS.interruptBehavior),
    requiresUserInteraction:
      toolDef.requiresUserInteraction ?? (() => TOOL_DEFAULTS.requiresUserInteraction),
    renderToolUseMessage: toolDef.renderToolUseMessage,
    renderToolResultMessage: toolDef.renderToolResultMessage,
  }
}
