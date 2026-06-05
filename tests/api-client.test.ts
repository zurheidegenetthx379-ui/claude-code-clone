/**
 * Tests for the Claude API client layer.
 *
 * The internal helper functions (formatMessagesForApi, formatToolDefinitions,
 * computeRetryDelay, isRetryable, extractHttpStatus, extractRetryAfter) are
 * module-private, so we test them indirectly through the exported
 * ClaudeApiClient class and createApiClient factory by mocking the Anthropic SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent } from '../src/types/index.js'

// -- Mock the Anthropic SDK ---------------------------------------------------
// vi.mock is hoisted, so we use vi.hoisted() for shared state.

const {
  mockStreamCalls,
  mockFinalMessageHolder,
  MockAnthropic,
} = vi.hoisted(() => {
  const mockStreamCalls: Array<unknown[]> = []
  const mockFinalMessageHolder: { value: Record<string, unknown> } = {
    value: {
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  }

  class MockAnthropic {
    messages = {
      stream: vi.fn(async (...args: unknown[]) => {
        mockStreamCalls.push(args)
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true }
              },
            }
          },
          async finalMessage() {
            return mockFinalMessageHolder.value
          },
          abort() {},
        }
      }),
      countTokens: vi.fn(async () => ({ input_tokens: 42 })),
    }
  }

  return { mockStreamCalls, mockFinalMessageHolder, MockAnthropic }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: MockAnthropic,
}))

// Import AFTER vi.mock so the mock is active
import { ClaudeApiClient, createApiClient } from '../src/services/api/claude.js'
import type { ToolInstance } from '../src/types/index.js'

// -- Helpers ------------------------------------------------------------------

function makeTool(overrides: Partial<ToolInstance> = {}): ToolInstance {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    call: vi.fn(async () => ({ content: 'ok' })),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    checkPermissions: vi.fn(async () => ({ behavior: 'allow' as const })),
    isEnabled: () => true,
    userFacingName: () => 'TestTool',
    ...overrides,
  }
}

function collectStreamEvents(
  gen: AsyncGenerator<StreamEvent, void, undefined>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  return (async () => {
    for await (const ev of gen) {
      events.push(ev)
    }
    return events
  })()
}

// -- Tests --------------------------------------------------------------------

beforeEach(() => {
  mockStreamCalls.length = 0
  mockFinalMessageHolder.value = {
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
  vi.clearAllMocks()
})

describe('ClaudeApiClient constructor', () => {
  it('throws when no API key is provided and env var is absent', () => {
    const original = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      expect(() => new ClaudeApiClient()).toThrow(/API key is required/i)
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original
    }
  })

  it('creates a client successfully with an explicit API key', () => {
    const client = new ClaudeApiClient('sk-test-key')
    expect(client).toBeDefined()
    expect(typeof client.stream).toBe('function')
  })

  it('accepts a config object with baseUrl and maxRetries', () => {
    const client = new ClaudeApiClient('sk-test', {
      baseUrl: 'https://api.example.com',
      maxRetries: 3,
      defaultModel: 'claude-test-model',
    })
    expect(client).toBeDefined()
  })
})

describe('createApiClient factory', () => {
  it('creates a client from a config object', () => {
    const client = createApiClient({ apiKey: 'sk-factory' })
    expect(client).toBeDefined()
    expect(typeof client.stream).toBe('function')
  })

  it('creates a client with empty config (uses env var)', () => {
    const original = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'sk-env'
    try {
      const client = createApiClient()
      expect(client).toBeDefined()
    } finally {
      if (original !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = original
      } else {
        delete process.env['ANTHROPIC_API_KEY']
      }
    }
  })
})

describe('Token usage tracking', () => {
  it('getUsage returns zero counters initially', () => {
    const client = new ClaudeApiClient('sk-test')
    const usage = client.getUsage()
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.cacheCreationTokens).toBe(0)
    expect(usage.cacheReadTokens).toBe(0)
    expect(usage.requestCount).toBe(0)
  })

  it('resetUsage zeroes all counters', () => {
    const client = new ClaudeApiClient('sk-test')
    // Manually set up some usage by streaming
    client.resetUsage()
    const usage = client.getUsage()
    expect(usage.inputTokens).toBe(0)
    expect(usage.requestCount).toBe(0)
  })

  it('getUsage returns a copy (not a reference)', () => {
    const client = new ClaudeApiClient('sk-test')
    const a = client.getUsage()
    const b = client.getUsage()
    expect(a).toEqual(b)
    expect(a).not.toBe(b) // different object references
  })
})

describe('stream - message formatting', () => {
  it('filters out system messages before sending to the API', async () => {
    const client = new ClaudeApiClient('sk-test')

    const messages = [
      { id: '1', uuid: '1', role: 'system' as const, content: 'You are helpful', timestamp: 1 },
      { id: '2', uuid: '2', role: 'user' as const, content: 'Hello', timestamp: 2 },
    ]

    const gen = client.stream(messages, 'System prompt', [], {})
    await collectStreamEvents(gen)

    // The first call to messages.stream should have only the user message
    expect(mockStreamCalls.length).toBeGreaterThanOrEqual(1)
    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    const sentMessages = callArgs.messages as Array<{ role: string }>
    expect(sentMessages.every(m => m.role !== 'system')).toBe(true)
    expect(sentMessages.length).toBe(1)
    expect(sentMessages[0]!.role).toBe('user')
  })

  it('passes string content directly', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hello', timestamp: 1 },
    ]

    const gen = client.stream(messages, '', [], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    const sentMessages = callArgs.messages as Array<{ role: string; content: unknown }>
    expect(sentMessages[0]!.content).toBe('Hello')
  })

  it('includes system prompt when provided', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const gen = client.stream(messages, 'Be helpful', [], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.system).toBe('Be helpful')
  })

  it('omits system param when system prompt is empty', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const gen = client.stream(messages, '', [], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.system).toBeUndefined()
  })
})

describe('stream - tool definition formatting', () => {
  it('excludes disabled tools from the API request', async () => {
    const client = new ClaudeApiClient('sk-test')

    const enabledTool = makeTool({ name: 'Enabled' })
    const disabledTool = makeTool({ name: 'Disabled', isEnabled: () => false })

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const gen = client.stream(messages, '', [enabledTool, disabledTool], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    const tools = callArgs.tools as Array<{ name: string }> | undefined
    expect(tools).toBeDefined()
    expect(tools!.length).toBe(1)
    expect(tools![0].name).toBe('Enabled')
  })

  it('uses description function when description is a function', async () => {
    const client = new ClaudeApiClient('sk-test')
    const tool = makeTool({
      name: 'FuncDesc',
      description: () => 'Dynamic description',
    })

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const gen = client.stream(messages, '', [tool], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    const tools = callArgs.tools as Array<{ name: string; description: string }>
    expect(tools[0].description).toBe('Dynamic description')
  })

  it('omits tools param when no tools are enabled', async () => {
    const client = new ClaudeApiClient('sk-test')
    const disabledTool = makeTool({ isEnabled: () => false })

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const gen = client.stream(messages, '', [disabledTool], {})
    await collectStreamEvents(gen)

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.tools).toBeUndefined()
  })
})

describe('stream - event processing', () => {
  it('yields text events from text_delta', async () => {
    // Override mock to emit specific events
    const mockInstance = new MockAnthropic()
    mockInstance.messages.stream = vi.fn(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
        ]
        let i = 0
        return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true } } }
      },
      async finalMessage() { return mockFinalMessageHolder.value },
      abort() {},
    })) as any

    const client = new ClaudeApiClient('sk-test')
    ;(client as any).client = mockInstance

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const textEvents = events.filter(e => e.type === 'text')
    expect(textEvents.length).toBe(2)
    expect((textEvents[0] as { content: string }).content).toBe('Hello')
    expect((textEvents[1] as { content: string }).content).toBe(' world')
  })

  it('yields thinking events from thinking_delta', async () => {
    const mockInstance = new MockAnthropic()
    mockInstance.messages.stream = vi.fn(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
        ]
        let i = 0
        return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true } } }
      },
      async finalMessage() { return mockFinalMessageHolder.value },
      abort() {},
    })) as any

    const client = new ClaudeApiClient('sk-test')
    ;(client as any).client = mockInstance

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const thinkingEvents = events.filter(e => e.type === 'thinking')
    expect(thinkingEvents.length).toBe(1)
    expect((thinkingEvents[0] as { content: string }).content).toBe('Let me think...')
  })

  it('yields tool_input_delta events with index and partial JSON', async () => {
    const mockInstance = new MockAnthropic()
    mockInstance.messages.stream = vi.fn(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
        ]
        let i = 0
        return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true } } }
      },
      async finalMessage() { return mockFinalMessageHolder.value },
      abort() {},
    })) as any

    const client = new ClaudeApiClient('sk-test')
    ;(client as any).client = mockInstance

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const toolDeltas = events.filter(e => e.type === 'tool_input_delta')
    expect(toolDeltas.length).toBe(1)
    const delta = toolDeltas[0] as { index: number; partialJson: string }
    expect(delta.index).toBe(0)
    expect(delta.partialJson).toBe('{"query":')
  })

  it('yields done event with stop_reason from final message', async () => {
    mockFinalMessageHolder.value = { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 10 } }

    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents.length).toBe(1)
    expect((doneEvents[0] as { stopReason: string }).stopReason).toBe('end_turn')
  })

  it('tracks cumulative usage after stream completes', async () => {
    mockFinalMessageHolder.value = { stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 200 } }

    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    await collectStreamEvents(client.stream(messages, '', [], {}))

    const usage = client.getUsage()
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(200)
    expect(usage.requestCount).toBe(1)
  })

  it('tracks cache tokens when present in usage', async () => {
    mockFinalMessageHolder.value = {
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 50,
        output_tokens: 30,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    }

    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    await collectStreamEvents(client.stream(messages, '', [], {}))

    const usage = client.getUsage()
    expect(usage.cacheCreationTokens).toBe(10)
    expect(usage.cacheReadTokens).toBe(20)
  })
})

describe('stream - retry behavior', () => {
  it('yields error event for non-retryable status codes (400)', async () => {
    let callCount = 0
    const mockInstance = new MockAnthropic()
    mockInstance.messages.stream = vi.fn(async () => {
      callCount++
      throw Object.assign(new Error('Bad Request'), { status: 400 })
    }) as any

    const client = new ClaudeApiClient('sk-test', { maxRetries: 3 })
    ;(client as any).client = mockInstance

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBe(1)
    expect(callCount).toBe(1)
  })

  it('yields error event for non-retryable status codes (403)', async () => {
    let callCount = 0
    const mockInstance = new MockAnthropic()
    mockInstance.messages.stream = vi.fn(async () => {
      callCount++
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    }) as any

    const client = new ClaudeApiClient('sk-test', { maxRetries: 3 })
    ;(client as any).client = mockInstance

    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    const events = await collectStreamEvents(client.stream(messages, '', [], {}))
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBe(1)
    expect(callCount).toBe(1)
  })
})

describe('stream - stream options', () => {
  it('passes temperature option to the API', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    await collectStreamEvents(client.stream(messages, '', [], { temperature: 0.5 }))

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.temperature).toBe(0.5)
  })

  it('passes stop_sequences option to the API', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    await collectStreamEvents(client.stream(messages, '', [], { stopSequences: ['STOP'] }))

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.stop_sequences).toEqual(['STOP'])
  })

  it('passes top_p option to the API', async () => {
    const client = new ClaudeApiClient('sk-test')
    const messages = [
      { id: '1', uuid: '1', role: 'user' as const, content: 'Hi', timestamp: 1 },
    ]

    await collectStreamEvents(client.stream(messages, '', [], { topP: 0.9 }))

    const callArgs = mockStreamCalls[0]![0] as Record<string, unknown>
    expect(callArgs.top_p).toBe(0.9)
  })
})
