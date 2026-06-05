/**
 * Tests for the tool registry: getAllBaseTools, assembleSkillPool,
 * filterToolsByDenyRules, and tool structure validation.
 */

import { describe, it, expect } from 'vitest'
import {
  getAllBaseTools,
  assembleToolPool,
  filterToolsByDenyRules,
  getTools,
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
  ALL_BUILT_IN_TOOL_NAMES,
} from '../src/tools.js'
import type {
  PermissionContext,
  ToolInstance,
  McpToolDefinition,
} from '../src/types/index.js'

// -- Helpers ------------------------------------------------------------------

function makePermissionContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    permissionMode: 'default',
    allowList: [],
    denyList: [],
    ...overrides,
  }
}

function makeMcpTool(name: string, serverName = 'test-server'): McpToolDefinition {
  return {
    name,
    serverName,
    description: `MCP tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
  }
}

// -- Tests --------------------------------------------------------------------

describe('ALL_BUILT_IN_TOOL_NAMES', () => {
  it('contains exactly 12 tool names', () => {
    expect(ALL_BUILT_IN_TOOL_NAMES.size).toBe(12)
  })

  it('includes all expected tool name constants', () => {
    expect(ALL_BUILT_IN_TOOL_NAMES.has(BASH_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(FILE_READ_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(FILE_EDIT_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(AGENT_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(WEB_FETCH_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(WEB_SEARCH_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(GLOB_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(GREP_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(FILE_WRITE_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(TODO_WRITE_TOOL_NAME)).toBe(true)
    expect(ALL_BUILT_IN_TOOL_NAMES.has(TODO_READ_TOOL_NAME)).toBe(true)
  })
})

describe('getAllBaseTools', () => {
  it('returns exactly 12 tools', () => {
    const tools = getAllBaseTools()
    expect(tools.length).toBe(12)
  })

  it('returns an array of ToolInstance objects', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
    }
  })

  it('includes all expected tool names', () => {
    const tools = getAllBaseTools()
    const names = new Set(tools.map(t => t.name))
    expect(names.has('Bash')).toBe(true)
    expect(names.has('FileRead')).toBe(true)
    expect(names.has('FileEdit')).toBe(true)
    expect(names.has('Agent')).toBe(true)
    expect(names.has('AskUserQuestion')).toBe(true)
    expect(names.has('WebFetch')).toBe(true)
    expect(names.has('WebSearch')).toBe(true)
    expect(names.has('Glob')).toBe(true)
    expect(names.has('Grep')).toBe(true)
    expect(names.has('FileWrite')).toBe(true)
    expect(names.has('TodoWrite')).toBe(true)
    expect(names.has('TodoRead')).toBe(true)
  })

  it('has no duplicate tool names', () => {
    const tools = getAllBaseTools()
    const names = tools.map(t => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('each tool has a description (string or function)', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      const desc = typeof tool.description === 'function'
        ? tool.description()
        : tool.description
      expect(typeof desc).toBe('string')
      expect(desc.length).toBeGreaterThan(0)
    }
  })

  it('each tool has an inputSchema object', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(typeof tool.inputSchema).toBe('object')
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('each tool has a callable call function', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      expect(typeof tool.call).toBe('function')
    }
  })

  it('each tool has required lifecycle methods', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      expect(typeof tool.isConcurrencySafe).toBe('function')
      expect(typeof tool.isReadOnly).toBe('function')
      expect(typeof tool.isDestructive).toBe('function')
      expect(typeof tool.checkPermissions).toBe('function')
      expect(typeof tool.isEnabled).toBe('function')
      expect(typeof tool.userFacingName).toBe('function')
    }
  })

  it('each tool isEnabled returns true by default', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      expect(tool.isEnabled()).toBe(true)
    }
  })

  it('each tool returns a string from userFacingName', () => {
    const tools = getAllBaseTools()
    for (const tool of tools) {
      const name = tool.userFacingName()
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })
})

describe('filterToolsByDenyRules', () => {
  it('returns all tools when deny list is empty', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: [] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.length).toBe(tools.length)
  })

  it('removes a tool whose name is on the deny list', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: ['Bash'] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.find(t => t.name === 'Bash')).toBeUndefined()
    expect(filtered.length).toBe(tools.length - 1)
  })

  it('deny list matching is case-insensitive', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: ['bash'] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.find(t => t.name === 'Bash')).toBeUndefined()
  })

  it('deny list can remove multiple tools at once', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: ['Bash', 'FileEdit', 'WebSearch'] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.length).toBe(tools.length - 3)
    expect(filtered.find(t => t.name === 'Bash')).toBeUndefined()
    expect(filtered.find(t => t.name === 'FileEdit')).toBeUndefined()
    expect(filtered.find(t => t.name === 'WebSearch')).toBeUndefined()
  })

  it('non-existent tool names in deny list are silently ignored', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: ['NonExistentTool'] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.length).toBe(tools.length)
  })

  it('handles deny list with whitespace in tool names', () => {
    const tools = getAllBaseTools()
    const ctx = makePermissionContext({ denyList: ['  Bash  '] })
    const filtered = filterToolsByDenyRules(tools, ctx)
    expect(filtered.find(t => t.name === 'Bash')).toBeUndefined()
  })
})

describe('getTools', () => {
  it('returns only enabled tools that pass deny rules', () => {
    const ctx = makePermissionContext({ denyList: ['Bash'] })
    const tools = getTools(ctx)
    expect(tools.find(t => t.name === 'Bash')).toBeUndefined()
    // All other built-in tools should still be present
    expect(tools.length).toBe(11)
  })

  it('returns all tools when no deny rules are set', () => {
    const ctx = makePermissionContext()
    const tools = getTools(ctx)
    expect(tools.length).toBe(12)
  })
})

describe('assembleSkillPool', () => {
  it('returns built-in tools when no MCP tools are provided', () => {
    const ctx = makePermissionContext()
    const pool = assembleToolPool(ctx, [])
    expect(pool.length).toBe(12)
  })

  it('adds MCP tools that do not collide with built-in names', () => {
    const ctx = makePermissionContext()
    const mcpTools: McpToolDefinition[] = [
      makeMcpTool('DatabaseQuery'),
      makeMcpTool('SendEmail'),
    ]
    const pool = assembleToolPool(ctx, mcpTools)
    expect(pool.length).toBe(14)
    expect(pool.find(t => t.name === 'DatabaseQuery')).toBeDefined()
    expect(pool.find(t => t.name === 'SendEmail')).toBeDefined()
  })

  it('built-in tools take priority over MCP tools with the same name', () => {
    const ctx = makePermissionContext()
    const mcpTools: McpToolDefinition[] = [
      makeMcpTool('Bash', 'custom-server'),
    ]
    const pool = assembleToolPool(ctx, mcpTools)
    // Still 12 tools - MCP Bash was skipped
    expect(pool.length).toBe(12)
    // The built-in Bash tool should be present, not the MCP one
    const bashTool = pool.find(t => t.name === 'Bash')!
    expect(bashTool).toBeDefined()
    // Built-in tools do not have [MCP: in their description
    const desc = typeof bashTool.description === 'function'
      ? bashTool.description()
      : bashTool.description
    expect(desc).not.toContain('[MCP:')
  })

  it('first-seen MCP tool wins among duplicates', () => {
    const ctx = makePermissionContext()
    const mcpTools: McpToolDefinition[] = [
      makeMcpTool('CustomTool', 'server-a'),
      makeMcpTool('CustomTool', 'server-b'),
    ]
    const pool = assembleToolPool(ctx, mcpTools)
    const customTools = pool.filter(t => t.name === 'CustomTool')
    expect(customTools.length).toBe(1)
    const desc = typeof customTools[0].description === 'function'
      ? customTools[0].description()
      : customTools[0].description
    expect(desc).toContain('server-a')
  })

  it('applies deny rules to the merged pool', () => {
    const ctx = makePermissionContext({ denyList: ['Bash', 'DatabaseQuery'] })
    const mcpTools: McpToolDefinition[] = [
      makeMcpTool('DatabaseQuery'),
    ]
    const pool = assembleToolPool(ctx, mcpTools)
    expect(pool.find(t => t.name === 'Bash')).toBeUndefined()
    expect(pool.find(t => t.name === 'DatabaseQuery')).toBeUndefined()
  })

  it('MCP tool instances have isEnabled returning true', () => {
    const ctx = makePermissionContext()
    const mcpTools: McpToolDefinition[] = [makeMcpTool('MyMcpTool')]
    const pool = assembleToolPool(ctx, mcpTools)
    const mcpTool = pool.find(t => t.name === 'MyMcpTool')!
    expect(mcpTool.isEnabled()).toBe(true)
  })

  it('MCP tool description includes server name', () => {
    const ctx = makePermissionContext()
    const mcpTools: McpToolDefinition[] = [
      makeMcpTool('AnalyzeCode', 'code-server'),
    ]
    const pool = assembleToolPool(ctx, mcpTools)
    const tool = pool.find(t => t.name === 'AnalyzeCode')!
    const desc = typeof tool.description === 'function'
      ? tool.description()
      : tool.description
    expect(desc).toContain('[MCP: code-server]')
  })
})
