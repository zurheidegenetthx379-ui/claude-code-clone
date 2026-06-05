/**
 * Tests for the QueryEngine — headless / SDK execution engine.
 *
 * The API client is injected via the `apiClient` config option, which makes
 * it straightforward to mock.  Private methods (collectModelResponse,
 * calculateCost) are tested indirectly through the public run() and getState()
 * methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryEngine } from '../src/QueryEngine.js'
import type {
  QueryEngineConfig,
  QueryResult,
} from '../src/QueryEngine.js'
import type {
  StreamEvent,
  ToolInstance,
  PermissionContext,
  HookDefinition,
} from '../src/types/index.js'
import type { TokenUsage } from '../src/services/api/claude.js'

// -- Helpers ------------------------------------------------------------------

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  requestCount: 0,
}

function makePermissionContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    permissionMode: 'default',
    allowList: [],
    denyList: [],
    ...overrides,
  }
}

function makeTool(overrides: Partial<ToolInstance> = {}): ToolInstance {
  return {
    name: 'MockTool',
    description: 'A mock tool',
    inputSchema: { type: 'object', properties: {} },
    call: vi.fn(async () => ({ content: 'tool result' })),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    checkPermissions: vi.fn(async () => ({ behavior: 'allow' as const })),
    isEnabled: () => true,
    userFacingName: () => 'MockTool',
    ...overrides,
  }
}

function createMockApiClient(streamEvents: StreamEvent[] = []) {
  const usage: TokenUsage = { ...DEFAULT_USAGE }
  return {
    stream: vi.fn(async function* () {
      for (const event of streamEvents) {
        yield event
      }
    }),
    getUsage: vi.fn(() => ({ ...usage })),
    resetUsage: vi.fn(() => {
      usage.inputTokens = 0
      usage.outputTokens = 0
      usage.cacheCreationTokens = 0
      usage.cacheReadTokens = 0
      usage.requestCount = 0
    }),
    countTokens: vi.fn(async () => 42),
    _usage: usage,
  }
}

function makeConfig(overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  return {
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a test assistant.',
    tools: [],
    permissionContext: makePermissionContext(),
    cwd: '/tmp/test',
    sessionId: 'test-session-001',
    apiClient: createMockApiClient([
      { type: 'text', content: 'Hello!' },
      { type: 'done', stopReason: 'end_turn' },
    ]) as any,
    ...overrides,
  }
}

// -- Tests --------------------------------------------------------------------

describe('QueryEngine constructor', () => {
  it('creates an engine in idle state', () => {
    const engine = new QueryEngine(makeConfig())
    const state = engine.getState()
    expect(state.status).toBe('idle')
    expect(state.turnsCompleted).toBe(0)
    expect(state.estimatedCostUsd).toBe(0)
    expect(state.messages).toEqual([])
  })

  it('uses the provided model name', () => {
    const engine = new QueryEngine(makeConfig({ model: 'claude-test-model' }))
    expect(engine.getState().model).toBe('claude-test-model')
  })

  it('uses the provided session ID', () => {
    const engine = new QueryEngine(makeConfig({ sessionId: 'my-session' }))
    expect(engine.getState().sessionId).toBe('my-session')
  })
})

describe('QueryEngine.run', () => {
  it('returns a QueryResult with text from the model response', async () => {
    const mockClient = createMockApiClient([
      { type: 'text', content: 'Hello, ' },
      { type: 'text', content: 'world!' },
      { type: 'done', stopReason: 'end_turn' },
    ])
    const config = makeConfig({ apiClient: mockClient as any })
    const engine = new QueryEngine(config)

    const result = await engine.run('Say hello')
    expect(result.text).toBe('Hello, world!')
    expect(result.stopReason).toBe('end_turn')
  })

  it('transitions to idle state after completion', async () => {
    const engine = new QueryEngine(makeConfig())
    await engine.run('test')
    expect(engine.getState().status).toBe('idle')
  })

  it('throws when called while already running', async () => {
    // Create a client whose stream hangs until aborted
    const hangingClient = createMockApiClient([])
    let resolveStream: (() => void) | null = null
    hangingClient.stream = vi.fn(() => {
      return (async function* () {
        await new Promise<void>(resolve => { resolveStream = resolve })
        yield { type: 'text' as const, content: 'late' }
        yield { type: 'done' as const, stopReason: 'end_turn' }
      })()
    }) as any

    const engine = new QueryEngine(makeConfig({ apiClient: hangingClient as any }))
    const firstRun = engine.run('first').catch(() => {})

    // Give it a tick to enter "running" state
    await new Promise(resolve => setTimeout(resolve, 20))

    // Second run should reject because engine is already running
    await expect(engine.run('second')).rejects.toThrow(/already in progress/i)

    // Clean up: resolve the hanging stream so the first run can complete
    resolveStream?.()
    await firstRun
  }, 15000)

  it('emits "done" event with the QueryResult', async () => {
    const engine = new QueryEngine(makeConfig())
    const doneListener = vi.fn()
    engine.on('done', doneListener)

    await engine.run('test')

    expect(doneListener).toHaveBeenCalledTimes(1)
    const result = doneListener.mock.calls[0]![0] as QueryResult
    expect(result.text).toBeDefined()
    expect(typeof result.durationMs).toBe('number')
  })

  it('emits "text" events for streamed text', async () => {
    const mockClient = createMockApiClient([
      { type: 'text', content: 'chunk1' },
      { type: 'text', content: 'chunk2' },
      { type: 'done', stopReason: 'end_turn' },
    ])
    const engine = new QueryEngine(makeConfig({ apiClient: mockClient as any }))
    const textListener = vi.fn()
    engine.on('text', textListener)

    await engine.run('test')

    expect(textListener).toHaveBeenCalledTimes(2)
    expect(textListener.mock.calls[0]![0]).toBe('chunk1')
    expect(textListener.mock.calls[1]![0]).toBe('chunk2')
  })

  it('emits "thinking" events for thinking blocks', async () => {
    const mockClient = createMockApiClient([
      { type: 'thinking', content: 'Let me think...' },
      { type: 'text', content: 'Here is my answer' },
      { type: 'done', stopReason: 'end_turn' },
    ])
    const engine = new QueryEngine(makeConfig({ apiClient: mockClient as any }))
    const thinkingListener = vi.fn()
    engine.on('thinking', thinkingListener)

    await engine.run('test')

    expect(thinkingListener).toHaveBeenCalledTimes(1)
    expect(thinkingListener.mock.calls[0]![0]).toBe('Let me think...')
  })

  it('adds user message and assistant response to the transcript', async () => {
    const engine = new QueryEngine(makeConfig())
    await engine.run('Hello there')

    const state = engine.getState()
    // Should have at least 2 messages: user + assistant
    expect(state.messages.length).toBeGreaterThanOrEqual(2)
    expect(state.messages[0]!.role).toBe('user')
    expect(state.messages[0]!.content).toBe('Hello there')
    expect(state.messages[1]!.role).toBe('assistant')
  })
})

describe('QueryEngine.run - tool execution', () => {
  it('executes a tool when the model requests it', async () => {
    const tool = makeTool({ name: 'Calculator' })
    const mockClient = createMockApiClient([
      { type: 'tool_use', toolUse: { type: 'tool_use', id: 'tu-1', name: 'Calculator', input: { x: 1 } } },
      { type: 'tool_input_delta', index: 1, partialJson: '{"x":1}' },
      { type: 'done', stopReason: 'end_turn' },
    ])

    // On second call (after tool result), return plain text
    let callCount = 0
    mockClient.stream = vi.fn(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'tu-1', name: 'Calculator', input: {} } }
        yield { type: 'tool_input_delta', index: 1, partialJson: '{"x":1}' }
        yield { type: 'done', stopReason: 'end_turn' }
      } else {
        yield { type: 'text', content: 'The result is 42' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }) as any

    const engine = new QueryEngine(makeConfig({
      apiClient: mockClient as any,
      tools: [tool],
    }))

    const result = await engine.run('Calculate something')
    expect(tool.call).toHaveBeenCalled()
    expect(result.text).toBe('The result is 42')
  })

  it('returns error result for unknown tools', async () => {
    const mockClient = createMockApiClient([])
    let callCount = 0
    mockClient.stream = vi.fn(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'tu-1', name: 'NonExistent', input: {} } }
        yield { type: 'done', stopReason: 'end_turn' }
      } else {
        yield { type: 'text', content: 'Done' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }) as any

    const engine = new QueryEngine(makeConfig({ apiClient: mockClient as any }))
    const result = await engine.run('test')
    // Engine should continue even with unknown tool
    expect(result.text).toBe('Done')
  })
})

describe('QueryEngine.abort', () => {
  it('transitions state to aborting when called during a run', async () => {
    const hangingClient = createMockApiClient([])
    hangingClient.stream = vi.fn(() => {
      return (async function* () {
        await new Promise(resolve => setTimeout(resolve, 5000))
      })()
    }) as any

    const engine = new QueryEngine(makeConfig({ apiClient: hangingClient as any }))
    const runPromise = engine.run('test').catch(() => {})

    await new Promise(resolve => setTimeout(resolve, 10))
    engine.abort()

    // State should transition through aborting
    // After abort completes, it settles to idle
    await runPromise
    expect(['idle', 'aborting']).toContain(engine.getState().status)
  })

  it('does nothing when not running', () => {
    const engine = new QueryEngine(makeConfig())
    expect(engine.getState().status).toBe('idle')
    engine.abort() // should not throw
    expect(engine.getState().status).toBe('idle')
  })
})

describe('QueryEngine.reset', () => {
  it('clears the message transcript', async () => {
    const engine = new QueryEngine(makeConfig())
    await engine.run('Hello')
    expect(engine.getState().messages.length).toBeGreaterThan(0)

    engine.reset()
    expect(engine.getState().messages.length).toBe(0)
    expect(engine.getState().status).toBe('idle')
  })

  it('resets turns completed to 0', async () => {
    const engine = new QueryEngine(makeConfig())
    await engine.run('Hello')

    engine.reset()
    expect(engine.getState().turnsCompleted).toBe(0)
  })
})

describe('QueryEngine.loadHistory', () => {
  it('loads pre-existing messages into the engine', () => {
    const engine = new QueryEngine(makeConfig())
    const messages = [
      { id: 'm1', uuid: 'u1', role: 'user' as const, content: 'Hi', timestamp: 1 },
      { id: 'm2', uuid: 'u2', role: 'assistant' as const, content: 'Hello!', timestamp: 2 },
    ]

    engine.loadHistory(messages)
    expect(engine.getState().messages.length).toBe(2)
    expect(engine.getState().messages[0]!.content).toBe('Hi')
  })

  it('replaces any previous transcript', async () => {
    const engine = new QueryEngine(makeConfig())
    await engine.run('first message')

    const newMessages = [
      { id: 'n1', uuid: 'nu1', role: 'user' as const, content: 'new', timestamp: 100 },
    ]
    engine.loadHistory(newMessages)
    expect(engine.getState().messages.length).toBe(1)
    expect(engine.getState().messages[0]!.content).toBe('new')
  })
})

describe('QueryEngine.getUsage', () => {
  it('delegates to the API client getUsage', () => {
    const mockClient = createMockApiClient([])
    mockClient._usage.inputTokens = 500
    mockClient._usage.outputTokens = 200

    const engine = new QueryEngine(makeConfig({ apiClient: mockClient as any }))
    const usage = engine.getUsage()
    expect(usage.inputTokens).toBe(500)
    expect(usage.outputTokens).toBe(200)
  })
})

describe('QueryEngine event subscription', () => {
  it('on() registers a listener that fires on events', async () => {
    const engine = new QueryEngine(makeConfig())
    const listener = vi.fn()
    engine.on('state', listener)

    await engine.run('test')
    expect(listener).toHaveBeenCalled()
  })

  it('once() registers a listener that fires only once', async () => {
    const engine = new QueryEngine(makeConfig())
    const listener = vi.fn()
    engine.once('done', listener)

    await engine.run('first')
    await engine.run('second')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('off() removes a registered listener', async () => {
    const engine = new QueryEngine(makeConfig())
    const listener = vi.fn()
    engine.on('state', listener)
    engine.off('state', listener)

    await engine.run('test')
    expect(listener).not.toHaveBeenCalled()
  })

  it('removeAllListeners clears all listeners for an event', async () => {
    const engine = new QueryEngine(makeConfig())
    const l1 = vi.fn()
    const l2 = vi.fn()
    engine.on('done', l1)
    engine.on('done', l2)
    engine.removeAllListeners('done')

    await engine.run('test')
    expect(l1).not.toHaveBeenCalled()
    expect(l2).not.toHaveBeenCalled()
  })
})

describe('QueryEngine cost calculation (indirect)', () => {
  it('starts with zero estimated cost', () => {
    const engine = new QueryEngine(makeConfig())
    expect(engine.getState().estimatedCostUsd).toBe(0)
  })

  it('returns a valid QueryResult with costUsd field', async () => {
    const engine = new QueryEngine(makeConfig())
    const result = await engine.run('test')
    expect(typeof result.costUsd).toBe('number')
    expect(result.costUsd).toBeGreaterThanOrEqual(0)
  })

  it('returns duration in the QueryResult', async () => {
    const engine = new QueryEngine(makeConfig())
    const result = await engine.run('test')
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('QueryEngine.runMultiTurn', () => {
  it('merges incoming messages without duplicating existing ones', async () => {
    const engine = new QueryEngine(makeConfig())

    const messages = [
      { id: 'm1', uuid: 'u1', role: 'user' as const, content: 'Hello', timestamp: 1 },
    ]

    await engine.runMultiTurn(messages)
    // The engine should have the user message + assistant response
    const state = engine.getState()
    expect(state.messages.length).toBeGreaterThanOrEqual(2)
    expect(state.messages[0]!.id).toBe('m1')
  })
})
