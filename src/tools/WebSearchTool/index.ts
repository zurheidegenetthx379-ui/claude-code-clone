/**
 * WebSearchTool - Search the web and return relevant results.
 *
 * Multi-engine architecture with automatic fallback:
 *   1. Bing (default primary — reliable from China, good international coverage)
 *   2. DuckDuckGo HTML (fallback — may be blocked in some regions)
 *   3. SearXNG (optional — configurable via CC_SEARXNG_URL env var)
 *
 * Configuration via environment variables:
 *   CC_SEARCH_ENGINE    — "bing" | "duckduckgo" | "searxng" (default: "bing")
 *   CC_SEARXNG_URL      — base URL of a SearXNG instance (e.g. "https://searx.be")
 *   CC_BING_MARKET     — Bing market code (default: "en-US")
 */

import { buildTool } from '../../Tool.js'
import type {
  ToolResult,
  ToolUseContext,
  Message,
  CanUseTool,
  ToolProgressData,
  PermissionResult,
  PermissionContext,
} from '../../types/index.js'

// --- Constants -----------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_OUTPUT_CHARS = 80_000 // ~20k tokens
const DEFAULT_MAX_RESULTS = 10
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

type SearchEngine = 'bing' | 'duckduckgo' | 'searxng'

// --- Types ---------------------------------------------------------------------

interface SearchResult {
  title: string
  url: string
  snippet: string
}

// --- Helpers -------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&\w+;/g, ' ')
}

function stripHtmlTags(html: string): string {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|table)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeHtmlEntities(text)
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n... (content truncated)'
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(value, MAX_TIMEOUT_MS)
}

/**
 * Perform an HTTP GET with timeout and abort linking.
 */
async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<Response> {
  const fetchAbort = new AbortController()
  const timer = setTimeout(() => fetchAbort.abort(), timeoutMs)

  const parentAbortHandler = () => fetchAbort.abort()
  abortSignal.addEventListener('abort', parentAbortHandler, { once: true })

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: fetchAbort.signal,
      redirect: 'follow',
      headers,
    })
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', parentAbortHandler)
    return response
  } catch (err: unknown) {
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', parentAbortHandler)

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Search request timed out after ${timeoutMs / 1000}s or was aborted.`)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Search request failed: ${msg}`)
  }
}

// ===========================================================================
// Bing Search Engine
// ===========================================================================

async function searchBing(
  query: string,
  maxResults: number,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  const market = process.env['CC_BING_MARKET'] || 'en-US'
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${market.split('-')[0]}&count=${maxResults}`

  const response = await fetchWithTimeout(
    searchUrl,
    {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': `${market},${market.split('-')[0]};q=0.9,en;q=0.8`,
    },
    timeoutMs,
    abortSignal,
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from Bing`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error(`Response body exceeded ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB`)
  }

  const html = Buffer.from(buffer).toString('utf-8')
  return parseBingResults(html, maxResults)
}

/**
 * Parse Bing search results HTML.
 *
 * Bing result structure:
 *   <li class="b_algo" ...>
 *     <h2><a href="url">Title</a></h2>
 *     <p>Snippet text</p>
 *   </li>
 */
function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Extract via h2 > a pattern (most reliable across Bing variants)
  const h2Regex = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi
  let match: RegExpExecArray | null

  while ((match = h2Regex.exec(html)) !== null && results.length < maxResults) {
    const url = match[1] ?? ''
    const title = stripHtmlTags(match[2] ?? '').trim()

    // Find snippet: look for <p> or <div class="b_caption"> after the h2
    const afterPos = match.index + match[0].length
    const snippetArea = html.slice(afterPos, afterPos + 1500)

    // Try <p> tag first
    let snippet = ''
    const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(snippetArea)
    if (pMatch) {
      snippet = stripHtmlTags(pMatch[1] ?? '').trim()
    } else {
      // Try b_caption div
      const captionMatch = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(snippetArea)
      if (captionMatch) {
        const innerP = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(captionMatch[1] ?? '')
        if (innerP) {
          snippet = stripHtmlTags(innerP[1] ?? '').trim()
        }
      }
    }

    if (title && url) {
      results.push({ title, url, snippet })
    }
  }

  // Fallback: broader link extraction if h2 approach missed results
  if (results.length === 0) {
    const fallbackRegex = /<a[^>]*class="[^"]*tilk[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let fbMatch: RegExpExecArray | null
    while ((fbMatch = fallbackRegex.exec(html)) !== null && results.length < maxResults) {
      const url = fbMatch[1] ?? ''
      const title = stripHtmlTags(fbMatch[2] ?? '').trim()
      if (title && url && !url.includes('bing.com')) {
        results.push({ title, url, snippet: '' })
      }
    }
  }

  return results
}

// ===========================================================================
// DuckDuckGo Search Engine (fallback)
// ===========================================================================

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

  const response = await fetchWithTimeout(
    searchUrl,
    {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs,
    abortSignal,
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from DuckDuckGo`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error(`Response body exceeded ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB`)
  }

  const html = Buffer.from(buffer).toString('utf-8')
  return parseDDGResults(html, maxResults)
}

function parseDDGResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const resultBlockRegex =
    /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?<\/div>\s*<\/div>)/gi

  let blockMatch: RegExpExecArray | null
  while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1] ?? ''
    const linkMatch = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!linkMatch) continue

    const rawUrl = linkMatch[1] ?? ''
    const title = stripHtmlTags(linkMatch[2] ?? '').trim()

    let url = rawUrl
    if (rawUrl.includes('uddg=')) {
      try {
        const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl)
        if (uddgMatch?.[1]) url = decodeURIComponent(uddgMatch[1])
      } catch { /* use raw */ }
    }

    const snippetMatch =
      /<[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(block)
    const snippet = snippetMatch
      ? stripHtmlTags(snippetMatch[1] ?? '').trim()
      : ''

    if (title && url) results.push({ title, url, snippet })
  }

  return results
}

// ===========================================================================
// SearXNG Search Engine (optional, user-configured)
// ===========================================================================

async function searchSearXNG(
  query: string,
  maxResults: number,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  const baseUrl = process.env['CC_SEARXNG_URL']
  if (!baseUrl) {
    throw new Error('SearXNG engine selected but CC_SEARXNG_URL is not set.')
  }

  const searchUrl = `${baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&categories=general`

  const response = await fetchWithTimeout(
    searchUrl,
    {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    timeoutMs,
    abortSignal,
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from SearXNG`)
  }

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  const results: SearchResult[] = []

  for (const r of (data.results ?? [])) {
    if (results.length >= maxResults) break
    if (r.title && r.url) {
      results.push({
        title: r.title,
        url: r.url,
        snippet: (r.content ?? '').slice(0, 300),
      })
    }
  }

  return results
}

// ===========================================================================
// Engine dispatcher with automatic fallback
// ===========================================================================

function getConfiguredEngine(): SearchEngine {
  const env = (process.env['CC_SEARCH_ENGINE'] ?? 'bing').toLowerCase().trim()
  if (env === 'duckduckgo' || env === 'ddg') return 'duckduckgo'
  if (env === 'searxng') return 'searxng'
  return 'bing'
}

/**
 * Try the configured engine first, then fall back to alternatives.
 * Returns results from the first engine that succeeds.
 */
async function performSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<{ results: SearchResult[]; engine: string }> {
  const primary = getConfiguredEngine()

  // Build ordered engine list: primary first, then fallbacks
  const engines: Array<{ name: SearchEngine; fn: typeof searchBing }> = []

  if (primary === 'bing') {
    engines.push({ name: 'bing', fn: searchBing })
    engines.push({ name: 'duckduckgo', fn: searchDuckDuckGo })
  } else if (primary === 'duckduckgo') {
    engines.push({ name: 'duckduckgo', fn: searchDuckDuckGo })
    engines.push({ name: 'bing', fn: searchBing })
  } else {
    engines.push({ name: 'searxng', fn: searchSearXNG as typeof searchBing })
    engines.push({ name: 'bing', fn: searchBing })
    engines.push({ name: 'duckduckgo', fn: searchDuckDuckGo })
  }

  const errors: string[] = []
  let emptyResults = false

  for (const { name, fn } of engines) {
    if (abortSignal.aborted) break
    try {
      const results = await fn(query, maxResults, timeoutMs, abortSignal)
      if (results.length > 0) {
        return { results, engine: name }
      }
      // Engine succeeded but returned no results — this is NOT an error
      emptyResults = true
      errors.push(`${name}: returned 0 results`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${name}: ${msg}`)
    }
  }

  // If any engine succeeded but found nothing, return empty (not an error)
  if (emptyResults) {
    return { results: [], engine: 'none' }
  }

  // All engines threw errors
  throw new Error(
    `All search engines failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
  )
}

// ===========================================================================
// Result formatting
// ===========================================================================

function formatResults(query: string, results: SearchResult[], engine: string): string {
  if (results.length === 0) {
    return `No results found for query: "${query}"`
  }

  const sections: string[] = []
  sections.push(`Search results for: "${query}" (via ${engine})`)
  sections.push(`Found ${results.length} result(s):\n`)

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    sections.push(`${i + 1}. ${r.title}`)
    sections.push(`   URL: ${r.url}`)
    if (r.snippet) {
      sections.push(`   ${r.snippet}`)
    }
    sections.push('')
  }

  return sections.join('\n')
}

// ===========================================================================
// Tool Definition
// ===========================================================================

const WebSearchTool = buildTool({
  name: 'WebSearch',

  description:
    'Search the web and return relevant results. ' +
    'Uses Bing as the primary engine (configurable via CC_SEARCH_ENGINE env). ' +
    'Supports automatic fallback across Bing, DuckDuckGo, and SearXNG. ' +
    'Results include titles, URLs, and snippets. ' +
    'Works from China and can access international knowledge.',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to execute.',
      },
      maxResults: {
        type: 'number',
        description:
          'Maximum number of results to return (default: 10, max: 30).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  isConcurrencySafe: true,
  isReadOnly: true,

  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }

    const query = typeof input.query === 'string' ? input.query : ''
    if (context.denyList.some((pattern) => query.includes(pattern))) {
      return { behavior: 'deny', message: 'Search query matches deny-list entry.' }
    }

    return { behavior: 'allow' }
  },

  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    const query = input.query
    if (typeof query !== 'string' || query.trim() === '') {
      return {
        content: 'Error: `query` is required and must be a non-empty string.',
        isError: true,
      }
    }

    let maxResults = DEFAULT_MAX_RESULTS
    if (typeof input.maxResults === 'number' && input.maxResults > 0) {
      maxResults = Math.min(Math.floor(input.maxResults), 30)
    }

    onProgress?.({ status: 'searching' })

    const timeoutMs = normalizeTimeout(undefined)

    let results: SearchResult[]
    let engine: string
    try {
      const searchResult = await performSearch(
        query.trim(),
        maxResults,
        timeoutMs,
        context.abortController.signal,
      )
      results = searchResult.results
      engine = searchResult.engine
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error performing web search: ${msg}`, isError: true }
    }

    onProgress?.({ status: 'formatting results' })

    const formatted = formatResults(query.trim(), results, engine)
    const output = truncateText(formatted, MAX_OUTPUT_CHARS)

    return { content: output }
  },

  userFacingName: () => 'WebSearch',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const query = typeof input.query === 'string' ? input.query : '<unknown>'
    const maxResults =
      typeof input.maxResults === 'number' ? input.maxResults : DEFAULT_MAX_RESULTS
    return `Search: "${query}" (max ${maxResults} results)`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      return lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '')
    }
    return '(search results available)'
  },
})

export default WebSearchTool
