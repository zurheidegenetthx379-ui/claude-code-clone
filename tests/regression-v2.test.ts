/**
 * Regression tests for V2 review findings.
 *
 * These tests ensure the security and correctness fixes from the V2 code
 * review remain intact:
 *
 *  1. allowList cannot bypass a tool's own deny verdict (PathPolicy etc.)
 *  2. Concurrent-safe tool batches preserve original tool_use ordering
 *  3. `ask` in interactive mode calls approvalCallback (not auto-allow)
 */

import { describe, it, expect, vi } from 'vitest'
import { QueryEngine } from '../src/QueryEngine.js'
import type { QueryEngineConfig } from '../src/QueryEngine.js'
import type {
  StreamEvent,
  ToolInstance,
  PermissionContext,
} from '../src/types/index.js'
import type { TokenUsage } from '../src/services/api/claude.js'

// ── helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  requestCount: 0,
}

function makePermissionContext(
  overrides: Partial<PermissionContext> = {},
): PermissionContext {
  return {
    permissionMode: 'default',
    allowList: [],
    denyList: [],
    cwd: '/tmp/test-project',
    ...overrides,
  }
}

function makeTool(overrides: Partial<ToolInstance> = {}): ToolInstance {
  return {
    name: 'MockTool',
    description: 'A mock tool',
    inputSchema: { type: 'object', properties: {} },
    call: vi.fn(async () => ({ success: true, output: 'ok' })),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    checkPermissions: vi.fn(async () => ({ behavior: 'allow' as const })),
    isEnabled: () => true,
    userFacingName: () => 'MockTool',
    ...overrides,
  }
}

function createMockApiClient(events: StreamEvent[] = []) {
  const usage: TokenUsage = { ...DEFAULT_USAGE }
  return {
    sendMessage: vi.fn(async function* () {
      for (const ev of events) yield ev
    }),
    getUsage: () => ({ ...usage }),
    resetUsage: () => {
      usage.inputTokens = 0
      usage.outputTokens = 0
      usage.cacheCreationTokens = 0
      usage.cacheReadTokens = 0
      usage.requestCount = 0
    },
    config: { model: 'test-model' },
  }
}

function makeEngineConfig(
  tools: ToolInstance[],
  permissionContext: PermissionContext,
  extra: Partial<QueryEngineConfig> = {},
): QueryEngineConfig {
  return {
    model: 'test-model',
    systemPrompt: 'test prompt',
    tools,
    permissionContext,
    cwd: permissionContext.cwd,
    sessionId: 'test-session',
    maxTokens: 1024,
    apiClient: createMockApiClient([
      { type: 'text', text: 'done' },
      { type: 'done', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    ]) as any,
    ...extra,
  }
}

// ── Regression 1: allowList must NOT bypass tool deny ───────────────────────

describe('Regression: allowList cannot bypass tool deny', () => {
  it('denies tool even when on allowList if tool checkPermissions returns deny', async () => {
    const protectedTool = makeTool({
      name: 'FileWrite',
      checkPermissions: vi.fn(async () => ({
        behavior: 'deny' as const,
        message: 'Access denied: ".env" is a protected path',
      })),
    })

    const permCtx = makePermissionContext({
      allowList: ['FileWrite'],  // Tool is on the allow list
    })

    const config = makeEngineConfig([protectedTool], permCtx)
    const engine = new QueryEngine(config)

    // The engine's private checkToolPermissions is tested indirectly:
    // We access it via the prototype to verify the logic.
    const permissions = await (engine as any).checkToolPermissions([
      { id: 'tu_1', type: 'tool_use', name: 'FileWrite', input: { file_path: '.env', content: 'x' } },
    ])

    const perm = permissions.get('tu_1')
    expect(perm).toBeDefined()
    expect(perm!.behavior).toBe('deny')
    expect(perm!.message).toContain('.env')
  })

  it('allows tool on allowList when tool returns ask (upgrade ask→allow)', async () => {
    const askTool = makeTool({
      name: 'Bash',
      checkPermissions: vi.fn(async () => ({ behavior: 'ask' as const })),
    })

    const permCtx = makePermissionContext({
      allowList: ['Bash'],
    })

    const config = makeEngineConfig([askTool], permCtx)
    const engine = new QueryEngine(config)

    const permissions = await (engine as any).checkToolPermissions([
      { id: 'tu_2', type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ])

    expect(permissions.get('tu_2')!.behavior).toBe('allow')
  })

  it('respects tool ask when tool is NOT on allowList', async () => {
    const askTool = makeTool({
      name: 'Bash',
      checkPermissions: vi.fn(async () => ({ behavior: 'ask' as const })),
    })

    const permCtx = makePermissionContext({
      allowList: [],  // NOT on allow list
    })

    const config = makeEngineConfig([askTool], permCtx)
    const engine = new QueryEngine(config)

    const permissions = await (engine as any).checkToolPermissions([
      { id: 'tu_3', type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ])

    expect(permissions.get('tu_3')!.behavior).toBe('ask')
  })

  it('deny-list always wins even if tool returns allow', async () => {
    const tool = makeTool({
      name: 'DangerousTool',
      checkPermissions: vi.fn(async () => ({ behavior: 'allow' as const })),
    })

    const permCtx = makePermissionContext({
      denyList: ['DangerousTool'],
      allowList: ['DangerousTool'],
    })

    const config = makeEngineConfig([tool], permCtx)
    const engine = new QueryEngine(config)

    const permissions = await (engine as any).checkToolPermissions([
      { id: 'tu_4', type: 'tool_use', name: 'DangerousTool', input: {} },
    ])

    expect(permissions.get('tu_4')!.behavior).toBe('deny')
    expect(permissions.get('tu_4')!.message).toContain('deny list')
  })
})

// ── Regression 2: concurrent batches preserve tool_use order ────────────────

describe('Regression: concurrent batch preserves original order', () => {
  it('executes consecutive safe tools in parallel but preserves order in results', async () => {
    const callOrder: string[] = []

    const readTool = makeTool({
      name: 'FileRead',
      isConcurrencySafe: () => true,
      call: vi.fn(async (input) => {
        callOrder.push(`read:${(input as any).path}`)
        return { success: true, output: 'content' }
      }),
    })

    const writeTool = makeTool({
      name: 'FileWrite',
      isConcurrencySafe: () => false,
      call: vi.fn(async (input) => {
        callOrder.push(`write:${(input as any).path}`)
        return { success: true, output: 'written' }
      }),
    })

    const permCtx = makePermissionContext({ permissionMode: 'bypassPermissions' as any })
    const config = makeEngineConfig([readTool, writeTool], permCtx)
    const engine = new QueryEngine(config)

    // Simulate a batch: [read A, read B, write C, read D]
    const toolUseBlocks = [
      { id: 'tu_r1', type: 'tool_use' as const, name: 'FileRead', input: { path: 'A' } },
      { id: 'tu_r2', type: 'tool_use' as const, name: 'FileRead', input: { path: 'B' } },
      { id: 'tu_w1', type: 'tool_use' as const, name: 'FileWrite', input: { path: 'C' } },
      { id: 'tu_r3', type: 'tool_use' as const, name: 'FileRead', input: { path: 'D' } },
    ]

    const parentMessage = { role: 'assistant' as const, content: [] }
    const results = await (engine as any).executeToolBatch(toolUseBlocks, parentMessage)

    // All 4 should produce results
    expect(results).toHaveLength(4)

    // The write must happen AFTER read A and read B, and BEFORE read D
    const writeIdx = callOrder.indexOf('write:C')
    const readAIdx = callOrder.indexOf('read:A')
    const readBIdx = callOrder.indexOf('read:B')
    const readDIdx = callOrder.indexOf('read:D')

    expect(writeIdx).toBeGreaterThan(readAIdx)
    expect(writeIdx).toBeGreaterThan(readBIdx)
    expect(readDIdx).toBeGreaterThan(writeIdx)
  })

  it('executes all-non-safe tools strictly sequentially', async () => {
    const callOrder: string[] = []

    const toolA = makeTool({
      name: 'ToolA',
      isConcurrencySafe: () => false,
      call: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10))
        callOrder.push('A')
        return { success: true, output: 'a' }
      }),
    })

    const toolB = makeTool({
      name: 'ToolB',
      isConcurrencySafe: () => false,
      call: vi.fn(async () => {
        callOrder.push('B')
        return { success: true, output: 'b' }
      }),
    })

    const permCtx = makePermissionContext({ permissionMode: 'bypassPermissions' as any })
    const config = makeEngineConfig([toolA, toolB], permCtx)
    const engine = new QueryEngine(config)

    const blocks = [
      { id: 'tu_a', type: 'tool_use' as const, name: 'ToolA', input: {} },
      { id: 'tu_b', type: 'tool_use' as const, name: 'ToolB', input: {} },
    ]

    const parentMessage = { role: 'assistant' as const, content: [] }
    await (engine as any).executeToolBatch(blocks, parentMessage)

    // B should not start until A finishes
    expect(callOrder).toEqual(['A', 'B'])
  })
})

// ── Regression 3: ask in interactive mode calls approvalCallback ────────────

describe('Regression: interactive ask calls approvalCallback', () => {
  it('calls approvalCallback when tool returns ask in interactive mode', async () => {
    const approvalCallback = vi.fn(async () => true)  // User approves

    const askTool = makeTool({
      name: 'FileEdit',
      checkPermissions: vi.fn(async () => ({ behavior: 'ask' as const })),
    })

    const permCtx = makePermissionContext()
    const config = makeEngineConfig([askTool], permCtx, {
      isInteractive: true,
      approvalCallback,
    })

    const engine = new QueryEngine(config)

    const blocks = [
      { id: 'tu_edit', type: 'tool_use' as const, name: 'FileEdit', input: { file_path: '/tmp/test', old_string: 'a', new_string: 'b' } },
    ]

    const parentMessage = { role: 'assistant' as const, content: [] }
    const results = await (engine as any).executeToolBatch(blocks, parentMessage)

    expect(approvalCallback).toHaveBeenCalledWith('FileEdit', expect.any(Object))
    expect(results).toHaveLength(1)
    // Should not be an error since user approved
    expect(results[0].is_error).toBeFalsy()
  })

  it('denies tool when approvalCallback returns false', async () => {
    const approvalCallback = vi.fn(async () => false)  // User denies

    const askTool = makeTool({
      name: 'FileEdit',
      checkPermissions: vi.fn(async () => ({ behavior: 'ask' as const })),
    })

    const permCtx = makePermissionContext()
    const config = makeEngineConfig([askTool], permCtx, {
      isInteractive: true,
      approvalCallback,
    })

    const engine = new QueryEngine(config)

    const blocks = [
      { id: 'tu_edit2', type: 'tool_use' as const, name: 'FileEdit', input: { file_path: '/tmp/test' } },
    ]

    const parentMessage = { role: 'assistant' as const, content: [] }
    const results = await (engine as any).executeToolBatch(blocks, parentMessage)

    expect(approvalCallback).toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('denied')
  })

  it('denies ask in non-interactive mode without calling callback', async () => {
    const approvalCallback = vi.fn(async () => true)

    const askTool = makeTool({
      name: 'FileEdit',
      checkPermissions: vi.fn(async () => ({ behavior: 'ask' as const })),
    })

    const permCtx = makePermissionContext()
    const config = makeEngineConfig([askTool], permCtx, {
      isInteractive: false,  // Non-interactive
      approvalCallback,
    })

    const engine = new QueryEngine(config)

    const blocks = [
      { id: 'tu_edit3', type: 'tool_use' as const, name: 'FileEdit', input: {} },
    ]

    const parentMessage = { role: 'assistant' as const, content: [] }
    const results = await (engine as any).executeToolBatch(blocks, parentMessage)

    expect(approvalCallback).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('non-interactive')
  })
})
