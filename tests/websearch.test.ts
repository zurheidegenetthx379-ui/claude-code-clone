/**
 * Tests for the WebSearchTool.
 *
 * Tests input validation, permission checking, result parsing,
 * error handling, and the formatting pipeline.  The global fetch
 * API is mocked to prevent real HTTP requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WebSearchTool from '../src/tools/WebSearchTool/index.js'
import type {
  ToolUseContext,
  PermissionContext,
  Message,
  CanUseTool,
} from '../src/types/index.js'

// -- Helpers ------------------------------------------------------------------

function makeContext(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    tools: [],
    permissionContext: {
      permissionMode: 'default',
      allowList: [],
      denyList: [],
    },
    cwd: '/tmp/test',
    sessionId: 'test-session',
    abortController: new AbortController(),
    mcpClients: new Map(),
    appState: {},
    messages: [],
    ...overrides,
  }
}

function makeMessage(): Message {
  return {
    id: 'msg-1',
    uuid: 'uuid-1',
    role: 'user',
    content: 'search for something',
    timestamp: Date.now(),
  }
}

const canUseTool: CanUseTool = async () => ({ behavior: 'allow' })

// -- Mock HTML response -------------------------------------------------------

const MOCK_DUCKDUCKGO_HTML = `
<html>
<body>
<div class="result result__body">
  <a class="result__a" href="https://example.com/page1">Example Page One</a>
  <div class="result__snippet">This is the first search result snippet.</div>
</div>
<div class="result result__body">
  <a class="result__a" href="https://example.com/page2">Example Page Two</a>
  <div class="result__snippet">Second result with useful information.</div>
</div>
<div class="result result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fredirected.com%2Fpage&amp;v=l">Redirected Page</a>
  <div class="result__snippet">This URL was wrapped in a redirect.</div>
</div>
</body>
</html>
`

function mockFetchSuccess(html = MOCK_DUCKDUCKGO_HTML) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from(html).buffer,
  }))
}

function mockFetchError(status: number, statusText: string) {
  return vi.fn(async () => ({
    ok: false,
    status,
    statusText,
  }))
}

function mockFetchNetworkError() {
  return vi.fn(async () => {
    throw new Error('Network failure: connection refused')
  })
}

function _mockFetchTimeout() {
  return vi.fn(async () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  })
}

// -- Tests --------------------------------------------------------------------

describe('WebSearchTool - tool structure', () => {
  it('has the correct name', () => {
    expect(WebSearchTool.name).toBe('WebSearch')
  })

  it('has a non-empty description', () => {
    const desc = typeof WebSearchTool.description === 'function'
      ? WebSearchTool.description()
      : WebSearchTool.description
    expect(typeof desc).toBe('string')
    expect(desc.length).toBeGreaterThan(0)
    expect(desc).toContain('DuckDuckGo')
  })

  it('has a valid input schema', () => {
    expect(WebSearchTool.inputSchema).toBeDefined()
    expect(WebSearchTool.inputSchema.type).toBe('object')
    const props = WebSearchTool.inputSchema.properties as Record<string, unknown>
    expect(props).toBeDefined()
    expect(props.query).toBeDefined()
  })

  it('query is a required field in the schema', () => {
    const required = WebSearchTool.inputSchema.required as string[]
    expect(required).toContain('query')
  })

  it('is concurrency safe', () => {
    expect(WebSearchTool.isConcurrencySafe()).toBe(true)
  })

  it('is read-only', () => {
    expect(WebSearchTool.isReadOnly()).toBe(true)
  })

  it('is enabled by default', () => {
    expect(WebSearchTool.isEnabled()).toBe(true)
  })

  it('returns "WebSearch" as the user-facing name', () => {
    expect(WebSearchTool.userFacingName()).toBe('WebSearch')
  })
})

describe('WebSearchTool - input validation', () => {
  it('returns error when query is missing', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchSuccess() as any
    try {
      const result = await WebSearchTool.call({}, makeContext(), canUseTool, makeMessage())
      expect(result.isError).toBe(true)
      expect(result.content).toContain('query')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error when query is an empty string', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchSuccess() as any
    try {
      const result = await WebSearchTool.call(
        { query: '' },
        makeContext(),
        canUseTool,
        makeMessage(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('query')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error when query is whitespace-only', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchSuccess() as any
    try {
      const result = await WebSearchTool.call(
        { query: '   ' },
        makeContext(),
        canUseTool,
        makeMessage(),
      )
      expect(result.isError).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error when query is not a string', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchSuccess() as any
    try {
      const result = await WebSearchTool.call(
        { query: 12345 },
        makeContext(),
        canUseTool,
        makeMessage(),
      )
      expect(result.isError).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('WebSearchTool - successful search', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns formatted results for a valid query', async () => {
    globalThis.fetch = mockFetchSuccess() as any

    const result = await WebSearchTool.call(
      { query: 'TypeScript tutorial' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    expect(result.isError).toBeUndefined()
    expect(typeof result.content).toBe('string')
    const content = result.content as string
    expect(content).toContain('TypeScript tutorial')
    expect(content).toContain('Example Page One')
    expect(content).toContain('example.com/page1')
  })

  it('includes snippet text in results', async () => {
    globalThis.fetch = mockFetchSuccess() as any

    const result = await WebSearchTool.call(
      { query: 'test query' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    const content = result.content as string
    expect(content).toContain('first search result snippet')
    expect(content).toContain('useful information')
  })

  it('handles DuckDuckGo redirect URLs', async () => {
    globalThis.fetch = mockFetchSuccess() as any

    const result = await WebSearchTool.call(
      { query: 'redirect test' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    const content = result.content as string
    expect(content).toContain('redirected.com')
  })

  it('respects maxResults parameter', async () => {
    globalThis.fetch = mockFetchSuccess() as any

    const result = await WebSearchTool.call(
      { query: 'test', maxResults: 1 },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    const content = result.content as string
    expect(content).toContain('Found 1 result')
  })

  it('caps maxResults at 30', async () => {
    // Generate HTML with 35 results
    let html = '<html><body>'
    for (let i = 0; i < 35; i++) {
      html += `<div class="result result__body">
        <a class="result__a" href="https://example.com/${i}">Result ${i}</a>
        <div class="result__snippet">Snippet ${i}</div>
      </div>`
    }
    html += '</body></html>'

    globalThis.fetch = mockFetchSuccess(html) as any

    const result = await WebSearchTool.call(
      { query: 'test', maxResults: 100 },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    const content = result.content as string
    // Should have at most 30 results
    expect(content).toContain('Found 30 result')
  })

  it('calls onProgress callback', async () => {
    globalThis.fetch = mockFetchSuccess() as any
    const onProgress = vi.fn()

    await WebSearchTool.call(
      { query: 'test' },
      makeContext(),
      canUseTool,
      makeMessage(),
      onProgress,
    )

    expect(onProgress).toHaveBeenCalled()
    const calls = onProgress.mock.calls
    expect(calls.some(c => (c[0] as any).status === 'searching')).toBe(true)
  })
})

describe('WebSearchTool - error handling', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns error on HTTP failure (503)', async () => {
    globalThis.fetch = mockFetchError(503, 'Service Unavailable') as any

    const result = await WebSearchTool.call(
      { query: 'test' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Error')
  })

  it('returns error on network failure', async () => {
    globalThis.fetch = mockFetchNetworkError() as any

    const result = await WebSearchTool.call(
      { query: 'test' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Error')
  })

  it('returns "no results" message for empty search results', async () => {
    // Use a fetch mock that returns an empty HTML page with no result links
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new TextEncoder().encode('<!DOCTYPE html><html><head></head><body></body></html>').buffer,
    })) as any

    const result = await WebSearchTool.call(
      { query: 'xyznonexistentquery123' },
      makeContext(),
      canUseTool,
      makeMessage(),
    )

    expect(result.isError).toBeUndefined()
    const content = result.content as string
    // With no result__a links in the HTML, the parser returns 0 results
    expect(content).toContain('No results found')
  })
})

describe('WebSearchTool - permission checking', () => {
  it('allows by default when no context is provided', async () => {
    const result = await WebSearchTool.checkPermissions({ query: 'test' })
    expect(result.behavior).toBe('allow')
  })

  it('allows when query does not match deny list', async () => {
    const ctx: PermissionContext = {
      permissionMode: 'default',
      allowList: [],
      denyList: ['forbidden-topic'],
    }
    const result = await WebSearchTool.checkPermissions({ query: 'safe topic' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('denies when query matches a deny-list entry', async () => {
    const ctx: PermissionContext = {
      permissionMode: 'default',
      allowList: [],
      denyList: ['forbidden'],
    }
    const result = await WebSearchTool.checkPermissions({ query: 'search for forbidden content' }, ctx)
    expect(result.behavior).toBe('deny')
    expect(result.message).toBeDefined()
  })
})

describe('WebSearchTool - rendering helpers', () => {
  it('renderToolUseMessage formats the search query', () => {
    const msg = WebSearchTool.renderToolUseMessage!({ query: 'TypeScript docs', maxResults: 5 })
    expect(msg).toContain('TypeScript docs')
    expect(msg).toContain('5')
  })

  it('renderToolUseMessage handles missing query', () => {
    const msg = WebSearchTool.renderToolUseMessage!({})
    expect(msg).toContain('<unknown>')
  })

  it('renderToolResultMessage handles string content', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Line ${i}`)
    const msg = WebSearchTool.renderToolResultMessage!({
      content: lines.join('\n'),
    })
    // Should truncate to first 8 lines + "..."
    expect(msg).toContain('...')
  })

  it('renderToolResultMessage handles non-string content', () => {
    const msg = WebSearchTool.renderToolResultMessage!({
      content: [{ type: 'text' as const, text: 'result' }],
    })
    expect(msg).toContain('search results available')
  })
})
