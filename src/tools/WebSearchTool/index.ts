/**
 * WebSearchTool - Search the web using DuckDuckGo and return relevant results.
 *
 * Features:
 *   - Uses DuckDuckGo HTML search API (no API key required).
 *   - Parses HTML response to extract result titles, URLs, and snippets.
 *   - Enforces a configurable timeout (default 30 s).
 *   - Caps response body size to prevent memory blow-ups (default 5 MiB).
 *   - Returns clean, formatted search results.
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

const DEFAULT_TIMEOUT_MS = 30_000 // 30 seconds
const MAX_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_OUTPUT_CHARS = 80_000 // ~20k tokens
const DEFAULT_MAX_RESULTS = 10
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// --- Types ---------------------------------------------------------------------

interface SearchResult {
  title: string
  url: string
  snippet: string
}

// --- Helpers -------------------------------------------------------------------

/**
 * Decode common HTML entities in a string.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

/**
 * Strip all HTML tags from a string and decode entities.
 */
function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely (including content)
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')

  // Replace block-level closing tags with newlines for readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|table)>/gi, '\n')

  // Replace <br> variants with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n')

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode HTML entities
  text = decodeHtmlEntities(text)

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

/**
 * Truncate text to a maximum character count, appending a notice.
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n... (content truncated)'
}

/**
 * Normalise a timeout value.
 */
function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(value, MAX_TIMEOUT_MS)
}

/**
 * Perform a DuckDuckGo HTML search and parse the results.
 */
async function performSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<SearchResult[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

  const fetchAbort = new AbortController()
  const timer = setTimeout(() => fetchAbort.abort(), timeoutMs)

  // Link to the parent abort signal
  const parentAbortHandler = () => fetchAbort.abort()
  abortSignal.addEventListener('abort', parentAbortHandler, { once: true })

  let response: Response
  try {
    response = await fetch(searchUrl, {
      method: 'GET',
      signal: fetchAbort.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
  } catch (err: unknown) {
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', parentAbortHandler)

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `Search request timed out after ${timeoutMs / 1000}s or was aborted.`,
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Search request failed: ${msg}`)
  }

  clearTimeout(timer)
  abortSignal.removeEventListener('abort', parentAbortHandler)

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from DuckDuckGo search`,
    )
  }

  // Read body with size guard
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error(
      `Response body exceeded ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB ` +
        `(max ${MAX_BODY_BYTES / 1024 / 1024} MiB).`,
    )
  }

  const html = Buffer.from(buffer).toString('utf-8')
  return parseSearchResults(html, maxResults)
}

/**
 * Parse DuckDuckGo HTML search results page and extract result data.
 *
 * DuckDuckGo HTML format:
 *   <div class="result results-links results-links--main result--url">
 *     <a class="result__a" href="...">Title</a>
 *     <div class="result__snippet">Snippet text</div>
 *   </div>
 */
function parseSearchResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Match each result block
  // DuckDuckGo wraps results in elements with class "result" and "result__body"
  const resultBlockRegex =
    /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result__body|$)/gi

  let blockMatch: RegExpExecArray | null
  while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1] ?? ''

    // Extract title and URL from result__a link
    const linkMatch = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!linkMatch) continue

    const rawUrl = linkMatch[1] ?? ''
    const title = stripHtmlTags(linkMatch[2] ?? '').trim()

    // DuckDuckGo sometimes wraps URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded_url>&...
    let url = rawUrl
    if (rawUrl.includes('uddg=')) {
      try {
        const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl)
        if (uddgMatch && uddgMatch[1]) {
          url = decodeURIComponent(uddgMatch[1])
        }
      } catch {
        // Use raw URL if decoding fails
      }
    }

    // Extract snippet from result__snippet
    const snippetMatch =
      /<[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(block)
    const snippet = snippetMatch
      ? stripHtmlTags(snippetMatch[1] ?? '').trim()
      : ''

    if (title && url) {
      results.push({ title, url, snippet })
    }
  }

  // Fallback: if the structured parsing missed results, try a broader regex
  if (results.length === 0) {
    const fallbackRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
    let fallbackMatch: RegExpExecArray | null
    while (
      (fallbackMatch = fallbackRegex.exec(html)) !== null &&
      results.length < maxResults
    ) {
      const rawUrl = fallbackMatch[1] ?? ''
      const title = stripHtmlTags(fallbackMatch[2] ?? '').trim()

      let url = rawUrl
      if (rawUrl.includes('uddg=')) {
        try {
          const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl)
          if (uddgMatch && uddgMatch[1]) {
            url = decodeURIComponent(uddgMatch[1])
          }
        } catch {
          // Use raw URL if decoding fails
        }
      }

      // Try to find a snippet near this link
      const afterLinkPos = fallbackMatch.index + fallbackMatch[0].length
      const snippetRegion = html.slice(afterLinkPos, afterLinkPos + 500)
      const snippetMatch =
        /<[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(snippetRegion)
      const snippet = snippetMatch
        ? stripHtmlTags(snippetMatch[1] ?? '').trim()
        : ''

      if (title && url) {
        results.push({ title, url, snippet })
      }
    }
  }

  return results
}

/**
 * Format search results into a human-readable string.
 */
function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for query: "${query}"`
  }

  const sections: string[] = []
  sections.push(`Search results for: "${query}"`)
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

// --- Tool Definition -----------------------------------------------------------

const WebSearchTool = buildTool({
  name: 'WebSearch',

  description:
    'Search the web using DuckDuckGo and return relevant results. ' +
    'Useful for finding information, documentation, articles, and more. ' +
    'No API key is required. Results include titles, URLs, and snippets.',

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

  // -- Safety flags -------------------------------------------------------------
  isConcurrencySafe: true,
  isReadOnly: true,

  // -- Permission check ---------------------------------------------------------
  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }

    const query = typeof input.query === 'string' ? input.query : ''

    // Check deny list against the query
    if (context.denyList.some((pattern) => query.includes(pattern))) {
      return { behavior: 'deny', message: 'Search query matches deny-list entry.' }
    }

    return { behavior: 'allow' }
  },

  // -- Core execution -----------------------------------------------------------
  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // Validate query
    const query = input.query
    if (typeof query !== 'string' || query.trim() === '') {
      return {
        content: 'Error: `query` is required and must be a non-empty string.',
        isError: true,
      }
    }

    // Validate maxResults
    let maxResults = DEFAULT_MAX_RESULTS
    if (typeof input.maxResults === 'number' && input.maxResults > 0) {
      maxResults = Math.min(Math.floor(input.maxResults), 30)
    }

    onProgress?.({ status: 'searching' })

    const timeoutMs = normalizeTimeout(undefined)

    // Perform the search
    let results: SearchResult[]
    try {
      results = await performSearch(
        query.trim(),
        maxResults,
        timeoutMs,
        context.abortController.signal,
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error performing web search: ${msg}`, isError: true }
    }

    onProgress?.({ status: 'formatting results' })

    // Format and return results
    const formatted = formatResults(query.trim(), results)
    const output = truncateText(formatted, MAX_OUTPUT_CHARS)

    return { content: output }
  },

  // -- Rendering helpers --------------------------------------------------------

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
      // Show the header and first few results
      return lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '')
    }
    return '(search results available)'
  },
})

export default WebSearchTool
