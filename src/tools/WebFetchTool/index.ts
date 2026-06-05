/**
 * WebFetchTool - Fetch web content from a URL and optionally summarise it.
 *
 * Features:
 *   - Uses the native `fetch` API (Node 18+).
 *   - Follows redirects (up to 5) via the built-in redirect handling.
 *   - Enforces a configurable timeout (default 30 s).
 *   - Caps response body size to prevent memory blow-ups (default 5 MiB).
 *   - Strips HTML tags and returns clean text when the response is HTML.
 *   - Optional `prompt` is included in the output as a "summary request"
 *     note so the consuming LLM can act on it (actual summarisation is
 *     handled by the model, not this tool).
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

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000 // 30 seconds
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_OUTPUT_CHARS = 80_000 // ~20k tokens
const USER_AGENT = 'ClaudeCodeClone/1.0 (+https://github.com/claude-code-clone)'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and collapse whitespace, yielding readable plain text.
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

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))

  // Collapse whitespace: multiple spaces -> single space, 3+ newlines -> 2
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
 * Validate and normalise a URL string.  Returns null on failure.
 */
function normalizeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url
  } catch {
    return null
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const WebFetchTool = buildTool({
  name: 'WebFetch',

  description:
    'Fetch the content of a web page by URL. ' +
    'HTML is converted to clean plain text. ' +
    'An optional `prompt` is included as a summary request for the model. ' +
    'Redirects are followed automatically (up to 5). ' +
    'A 30-second timeout and 5 MiB size limit are enforced.',

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP(S) URL to fetch.',
      },
      prompt: {
        type: 'string',
        description:
          'Optional prompt describing what information to extract or summarise from the page.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: true,
  isReadOnly: true,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult> {
    if (!context) return { behavior: 'allow' }

    const rawUrl = typeof input.url === 'string' ? input.url : ''

    // Check deny list against the URL
    if (context.denyList.some((pattern) => rawUrl.includes(pattern))) {
      return { behavior: 'deny', message: 'URL matches deny-list entry.' }
    }

    return { behavior: 'allow' }
  },

  // ── Core execution ────────────────────────────────────────────────────────
  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // ── Validate URL ──────────────────────────────────────────────────────
    const rawUrl = input.url
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { content: 'Error: `url` is required and must be a non-empty string.', isError: true }
    }

    const parsedUrl = normalizeUrl(rawUrl.trim())
    if (!parsedUrl) {
      return {
        content: `Error: Invalid URL "${rawUrl}". Only http:// and https:// URLs are supported.`,
        isError: true,
      }
    }

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''

    onProgress?.({ status: 'fetching' })

    // ── Build abort controller with timeout ───────────────────────────────
    const fetchAbort = new AbortController()
    const timeoutMs = DEFAULT_TIMEOUT_MS

    const timer = setTimeout(() => fetchAbort.abort(), timeoutMs)

    // Also honour the session-level abort signal
    const sessionAbortHandler = () => fetchAbort.abort()
    context.abortController.signal.addEventListener('abort', sessionAbortHandler, { once: true })

    // ── Fetch ─────────────────────────────────────────────────────────────
    let response: Response
    try {
      response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        signal: fetchAbort.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    } catch (err: unknown) {
      clearTimeout(timer)
      context.abortController.signal.removeEventListener('abort', sessionAbortHandler)

      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          content: `Error: Request timed out after ${timeoutMs / 1000}s or was aborted.`,
          isError: true,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error fetching URL: ${msg}`, isError: true }
    }

    clearTimeout(timer)
    context.abortController.signal.removeEventListener('abort', sessionAbortHandler)

    // ── Validate response ─────────────────────────────────────────────────
    if (!response.ok) {
      return {
        content: `Error: HTTP ${response.status} ${response.statusText} for ${parsedUrl.toString()}`,
        isError: true,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10)

    if (contentLength > MAX_BODY_BYTES) {
      return {
        content: `Error: Response too large (${(contentLength / 1024 / 1024).toFixed(1)} MiB, max ${MAX_BODY_BYTES / 1024 / 1024} MiB).`,
        isError: true,
      }
    }

    onProgress?.({ status: 'processing' })

    // ── Read body with size guard ─────────────────────────────────────────
    let body: string
    try {
      // Read as array buffer so we can enforce size
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return {
          content: `Error: Response body exceeded ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB (max ${MAX_BODY_BYTES / 1024 / 1024} MiB).`,
          isError: true,
        }
      }
      body = Buffer.from(buffer).toString('utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error reading response body: ${msg}`, isError: true }
    }

    // ── Process content ───────────────────────────────────────────────────
    let text: string
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
    const isJson = contentType.includes('application/json') || contentType.includes('+json')

    if (isHtml) {
      text = stripHtmlTags(body)
    } else if (isJson) {
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(body)
        text = JSON.stringify(parsed, null, 2)
      } catch {
        text = body // Fall back to raw
      }
    } else {
      text = body
    }

    text = truncateText(text, MAX_OUTPUT_CHARS)

    // ── Build output ──────────────────────────────────────────────────────
    const sections: string[] = []

    sections.push(`Fetched: ${parsedUrl.toString()}`)
    sections.push(`Content-Type: ${contentType}`)

    if (prompt) {
      sections.push(`\nSummary request: "${prompt}"`)
    }

    sections.push(`\n--- Content ---\n${text}`)

    return { content: sections.join('\n') }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'WebFetch',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const url = typeof input.url === 'string' ? input.url : '<unknown>'
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    if (prompt) {
      return `Fetch ${url}\nPrompt: ${prompt.slice(0, 80)}`
    }
    return `Fetch ${url}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      // Show the header lines and first few content lines
      return lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '')
    }
    return '(fetched content available)'
  },
})

export default WebFetchTool
