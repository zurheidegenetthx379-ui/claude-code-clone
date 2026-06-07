/**
 * Tool registry and assembly system
 * Manages built-in tools, MCP tool integration, and permission-based filtering.
 *
 * Architecture:
 * - Each tool lives in ./tools/<ToolName>/index.ts and exports a ToolInstance
 * - getAllBaseTools() returns the canonical list of built-in tools
 * - assembleToolPool() merges built-in + MCP tools with built-in taking priority
 * - Permission filtering is applied via getTools() before sending to the model
 */

import { minimatch } from 'minimatch'
import { parseMcpToolName } from './services/mcp/client.js'
import type {
  ToolInstance,
  PermissionContext,
  McpToolDefinition,
} from './types/index.js'

// ============================================================
// Built-in Tool Imports
// Each tool directory exports a pre-built ToolInstance via buildTool()
// ============================================================

import BashTool from './tools/BashTool/index.js'
import FileReadTool from './tools/FileReadTool/index.js'
import FileEditTool from './tools/FileEditTool/index.js'
import { AgentTool } from './tools/AgentTool/index.js'
import AskUserQuestionTool from './tools/AskUserQuestionTool/index.js'
import WebFetchTool from './tools/WebFetchTool/index.js'
import WebSearchTool from './tools/WebSearchTool/index.js'
import GlobTool from './tools/GlobTool/index.js'
import GrepTool from './tools/GrepTool/index.js'
import FileWriteTool from './tools/FileWriteTool/index.js'
import TodoWriteTool from './tools/TodoWriteTool/index.js'
import TodoReadTool from './tools/TodoReadTool/index.js'
import SwarmStatusTool from './tools/SwarmStatusTool/index.js'
import FileListTool from './tools/FileListTool/index.js'

// ============================================================
// Tool Name Constants
// Single source of truth for all built-in tool identifiers
// ============================================================

/** Bash / shell command execution */
export const BASH_TOOL_NAME = 'Bash'

/** Read file contents from disk */
export const FILE_READ_TOOL_NAME = 'FileRead'

/** Edit file contents (insert, replace, delete) */
export const FILE_EDIT_TOOL_NAME = 'FileEdit'

/** Spawn a sub-agent for complex delegated tasks */
export const AGENT_TOOL_NAME = 'Agent'

/** Ask the user a clarifying question */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/** Fetch and summarize web content */
export const WEB_FETCH_TOOL_NAME = 'WebFetch'

/** Search the web using DuckDuckGo */
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

/** Glob pattern file search */
export const GLOB_TOOL_NAME = 'Glob'

/** Content regex search across files */
export const GREP_TOOL_NAME = 'Grep'

/** Write content to a file (create or overwrite) */
export const FILE_WRITE_TOOL_NAME = 'FileWrite'

/** Create and manage a structured task list */
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'

/** Read the current structured task list */
export const TODO_READ_TOOL_NAME = 'TodoRead'

/** Check multi-agent swarm status and worker results */
export const SWARM_STATUS_TOOL_NAME = 'SwarmStatus'

/** List directory contents (files and folders) */
export const FILE_LIST_TOOL_NAME = 'FileList'

/**
 * Set of all built-in tool names for fast lookup
 */
export const ALL_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  BASH_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TODO_READ_TOOL_NAME,
  SWARM_STATUS_TOOL_NAME,
  FILE_LIST_TOOL_NAME,
])

// ============================================================
// Tool Registry
// ============================================================

/**
 * Returns the full array of all built-in tool instances.
 *
 * This is the canonical registry - every built-in tool must be
 * listed here to be available to the agent.
 *
 * @returns Array of all built-in ToolInstance objects
 */
export function getAllBaseTools(): ToolInstance[] {
  return [
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    TodoWriteTool,
    TodoReadTool,
    AgentTool,
    AskUserQuestionTool,
    WebFetchTool,
    WebSearchTool,
    SwarmStatusTool,
    FileListTool,
  ]
}

/**
 * Get the list of enabled tools filtered by the current permission context.
 *
 * Applies two layers of filtering:
 * 1. Tool.isEnabled() - tool's own enablement check
 * 2. Deny rules from the permission context
 *
 * @param permissionContext - Current permission configuration
 * @returns Filtered array of tools available for use
 */
export function getTools(permissionContext: PermissionContext): ToolInstance[] {
  const allTools = getAllBaseTools()

  // First pass: remove tools that are not enabled
  const enabledTools = allTools.filter(tool => tool.isEnabled())

  // Second pass: apply deny rules from permission context
  return filterToolsByDenyRules(enabledTools, permissionContext)
}

/**
 * Assemble the complete tool pool by merging built-in tools with MCP tools.
 *
 * Deduplication strategy:
 * - Built-in tools always take priority over MCP tools with the same name
 * - Among MCP tools, first-seen wins (by server order)
 *
 * The resulting pool is then filtered by:
 * 1. Built-in tool isEnabled() checks
 * 2. Permission context deny rules
 *
 * @param permissionContext - Current permission configuration
 * @param mcpTools - Array of MCP tool definitions to merge
 * @returns Assembled and filtered tool pool
 */
export function assembleToolPool(
  permissionContext: PermissionContext,
  mcpTools: McpToolDefinition[] = [],
): ToolInstance[] {
  // Start with all enabled built-in tools
  const builtInTools = getAllBaseTools().filter(tool => tool.isEnabled())
  const builtInNames = new Set(builtInTools.map(t => t.name))

  // Convert MCP tool definitions to a name-indexed map for dedup
  const mcpToolMap = new Map<string, McpToolDefinition>()
  for (const mcpTool of mcpTools) {
    // Skip MCP tools whose names collide with built-in tools (built-in wins)
    if (builtInNames.has(mcpTool.name)) {
      continue
    }
    // First-seen MCP tool wins among duplicates
    if (!mcpToolMap.has(mcpTool.name)) {
      mcpToolMap.set(mcpTool.name, mcpTool)
    }
  }

  // Convert remaining MCP tool definitions into lightweight ToolInstance stubs.
  // Full MCP call routing is handled by the MCP client layer at invocation time.
  const mcpToolInstances: ToolInstance[] = Array.from(mcpToolMap.values()).map(
    mcpToolDef => mcpToolDefToToolInstance(mcpToolDef),
  )

  // Merge: built-in first, then MCP additions
  const mergedTools = [...builtInTools, ...mcpToolInstances]

  // Apply permission deny rules
  return filterToolsByDenyRules(mergedTools, permissionContext)
}

/**
 * Filter tools based on deny rules in the permission context.
 *
 * A tool is excluded if its name appears in the deny list.
 * The allow list is not used here - it is checked at invocation time
 * by the permission system (CanUseTool callback).
 *
 * @param tools - Array of tool instances to filter
 * @param permissionContext - Permission context containing deny rules
 * @returns Filtered array with denied tools removed
 */
export function filterToolsByDenyRules(
  tools: ToolInstance[],
  permissionContext: PermissionContext,
): ToolInstance[] {
  const denySet = new Set(permissionContext.denyList.map(normalizeToolName))

  if (denySet.size === 0) {
    return tools
  }

  return tools.filter(tool => !denySet.has(normalizeToolName(tool.name)))
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Normalize a tool name for case-insensitive comparison in deny rules.
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Convert an MCP tool definition into a minimal ToolInstance.
 *
 * The returned instance delegates actual execution to the MCP client layer.
 * Its `call` method is a placeholder that should be overridden by the MCP
 * router before the tool is presented to the model.
 *
 * @param mcpToolDef - The MCP tool definition
 * @returns A ToolInstance wrapping the MCP tool
 */
function mcpToolDefToToolInstance(mcpToolDef: McpToolDefinition): ToolInstance {
  return {
    name: mcpToolDef.name,
    description: `[MCP: ${mcpToolDef.serverName}] ${mcpToolDef.description}`,
    inputSchema: mcpToolDef.inputSchema,

    async call(input, context, _canUseTool, _parentMessage, _onProgress) {
      // Locate the MCP client for this tool's server
      const client = context.mcpClients.get(mcpToolDef.serverName)
      if (!client) {
        return {
          isError: true,
          content: `MCP server "${mcpToolDef.serverName}" is not connected.`,
        }
      }

      // Delegate to the MCP client's callTool method
      // Extract local tool name from the fully-qualified name (mcp__server__tool → tool)
      try {
        const mcpClient = client as {
          callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
        }
        const parsed = parseMcpToolName(mcpToolDef.name)
        const localName = parsed ? parsed.toolName : mcpToolDef.name
        const result = await mcpClient.callTool(localName, input)
        return {
          output: result,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        }
      } catch (error) {
        return {
          isError: true,
          content: `MCP tool "${mcpToolDef.name}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },

    // MCP tools default to fail-closed for safety
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,

    async checkPermissions(input, context) {
      // MCP tools must respect the deny list to prevent unrestricted access.
      if (context) {
        const toolName = mcpToolDef.name
        if (context.denyList.some((p) => toolName.includes(p) || minimatch(toolName, p))) {
          return { behavior: 'deny' as const, message: `MCP tool "${toolName}" matches deny-list entry.` }
        }
      }
      return { behavior: 'allow' as const }
    },

    isEnabled: () => true,

    userFacingName: () => mcpToolDef.name,
  }
}
