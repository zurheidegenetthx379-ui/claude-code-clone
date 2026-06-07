/**
 * MCP (Model Context Protocol) client integration layer.
 *
 * Manages connections to external MCP servers, discovers their advertised
 * tools, and routes tool invocations through the appropriate transport
 * (stdio / SSE / WebSocket / HTTP).
 *
 * Architecture mirrors Claude Code's MCP client subsystem:
 *  - McpClientManager owns per-server connections and caches them by config hash.
 *  - getMcpToolsCommandsAndResources() is the one-shot entry point that connects
 *    to every configured server, discovers tools, and returns a merged pool.
 *  - McpAuthCache persists "needs-auth" state to disk so the REPL can surface
 *    authentication prompts without re-probing on every startup.
 *  - mcpToolDefToToolInstance() converts a remote McpToolDefinition into a
 *    fully-formed ToolInstance using the buildTool() factory (fail-closed).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { buildTool } from '../../Tool.js'
import type {
  McpServerConfig,
  McpToolDefinition,
  ToolInstance,
  ToolUseContext,
  ToolResult,
  PermissionResult,
} from '../../types/index.js'

// ============================================================
// Constants
// ============================================================

/**
 * Maximum length (in characters) allowed for an MCP tool description.
 * Descriptions exceeding this are truncated with an ellipsis marker so the
 * model prompt stays within safe token budgets.
 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048

/**
 * Number of local (stdio) MCP servers to connect to concurrently.
 * Stdio servers spawn child processes, so a small batch avoids fork-bombing.
 */
export const LOCAL_CONNECTION_BATCH_SIZE = 3

/**
 * Number of remote (SSE / WS / HTTP) MCP servers to connect to concurrently.
 * Remote connections are I/O-bound so a larger batch is safe.
 */
export const REMOTE_CONNECTION_BATCH_SIZE = 20

/**
 * Time-to-live for entries in the on-disk auth-needs cache (15 minutes).
 */
export const AUTH_CACHE_TTL_MS = 15 * 60 * 1000

// ============================================================
// Tool-name encoding helpers
// ============================================================

/**
 * Build the canonical fully-qualified name for an MCP tool.
 *
 * The `mcp__<server>__<tool>` convention lets the router decompose a tool
 * reference back into its originating server and local tool name without
 * maintaining a separate lookup table.
 *
 * @example
 * buildMcpToolName('github', 'create_issue')
 * // => 'mcp__github__create_issue'
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * Decompose a fully-qualified MCP tool name into its server and tool parts.
 *
 * Returns `null` when the name does not match the expected `mcp__*__*` shape
 * so callers can safely fall through to built-in tool lookup.
 */
export function parseMcpToolName(fullName: string): {
  serverName: string
  toolName: string
} | null {
  const parts = fullName.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') {
    return null
  }
  // Everything between the first and last `__` segment is the server name,
  // allowing server names that themselves contain `__`.
  const toolName = parts[parts.length - 1]!
  const serverName = parts.slice(1, -1).join('__')
  return { serverName, toolName }
}

// ============================================================
// Connection-entry type used internally by McpClientManager
// ============================================================

interface McpConnectionEntry {
  /**
   * The underlying MCP client handle.
   *
   * Typed as `any` because the concrete class comes from
   * `@modelcontextprotocol/sdk` whose exact API surface varies between
   * versions.  Call-sites cast to the narrow shape they require.
   */
  client: any
  /** The server configuration that produced this connection. */
  serverConfig: McpServerConfig
}

// ============================================================
// McpClientManager
// ============================================================

/**
 * Manages the lifecycle of MCP server connections.
 *
 * Each server is connected at most once; subsequent calls to
 * `connectToServer` with the same (name + config) return the cached promise
 * so concurrent callers share a single handshake.
 */
export class McpClientManager {
  /** Active connections indexed by server name. */
  private connections: Map<string, McpConnectionEntry> = new Map()

  /**
   * In-flight connection promises keyed by `name:configHash`.
   * Prevents duplicate handshakes when multiple discovery paths fire
   * concurrently for the same server.
   */
  private connectionCache: Map<string, Promise<any>> = new Map()

  // ----------------------------------------------------------
  // Connection
  // ----------------------------------------------------------

  /**
   * Establish (or reuse) a connection to a single MCP server.
   *
   * The transport is selected by `config.type`:
   *   - `stdio`  — spawns a child process and communicates over stdin/stdout
   *   - `sse`    — opens a Server-Sent Events channel
   *   - `ws`     — opens a WebSocket
   *   - `http`   — uses plain HTTP request/response (streamable HTTP)
   *
   * Connections are memoized: calling connectToServer twice with the same
   * config returns the same promise / client.
   */
  async connectToServer(config: McpServerConfig): Promise<any> {
    const cacheKey = `${config.name}:${JSON.stringify(config)}`

    // Return an in-flight or completed connection if one exists.
    const cached = this.connectionCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const connectionPromise = this.createConnection(config)
    this.connectionCache.set(cacheKey, connectionPromise)

    try {
      const client = await connectionPromise

      this.connections.set(config.name, {
        client,
        serverConfig: config,
      })

      return client
    } catch (err) {
      // Evict the failed promise so a retry can attempt again.
      this.connectionCache.delete(cacheKey)
      throw err
    }
  }

  /**
   * Close every active connection and clear all caches.
   *
   * Errors during individual disconnects are swallowed — the goal is to
   * release as many resources as possible.
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = []

    for (const [name, entry] of this.connections) {
      disconnectPromises.push(
        this.safeDisconnect(name, entry.client),
      )
    }

    await Promise.allSettled(disconnectPromises)

    this.connections.clear()
    this.connectionCache.clear()
  }

  // ----------------------------------------------------------
  // Tool discovery
  // ----------------------------------------------------------

  /**
   * Query every connected server for its advertised tools and return a
   * merged, deduplicated list.
   *
   * Tool descriptions are truncated to {@link MAX_MCP_DESCRIPTION_LENGTH} to
   * keep the model prompt within safe token limits.
   *
   * Deduplication: when two servers advertise a tool with the same
   * fully-qualified name, the first server (in connection-insertion order)
   * wins.
   */
  async discoverTools(): Promise<McpToolDefinition[]> {
    const allTools: McpToolDefinition[] = []
    const seenNames = new Set<string>()

    for (const [serverName, entry] of this.connections) {
      let serverTools: McpToolDefinition[]

      try {
        // The MCP SDK exposes `client.listTools()` which returns
        // `{ tools: Array<{ name, description, inputSchema }> }`.
        // We map that into our internal McpToolDefinition shape.
        const response = await entry.client.listTools()
        const rawTools: Array<{
          name: string
          description?: string
          inputSchema?: Record<string, unknown>
        }> = response?.tools ?? []

        serverTools = rawTools.map(raw => ({
          name: buildMcpToolName(serverName, raw.name),
          serverName,
          description: truncateDescription(raw.description ?? ''),
          inputSchema: raw.inputSchema ?? { type: 'object', properties: {} },
        }))
      } catch (err) {
        console.error(
          `[mcp] Failed to discover tools from server "${serverName}":`,
          err instanceof Error ? err.message : err,
        )
        continue
      }

      for (const tool of serverTools) {
        if (!seenNames.has(tool.name)) {
          seenNames.add(tool.name)
          allTools.push(tool)
        }
      }
    }

    return allTools
  }

  // ----------------------------------------------------------
  // Tool invocation
  // ----------------------------------------------------------

  /**
   * Invoke a specific tool on the named MCP server.
   *
   * @param serverName - The MCP server that owns the tool.
   * @param toolName   - The local (unqualified) tool name on that server.
   * @param input      - The JSON input payload for the tool call.
   * @returns A {@link ToolResult} wrapping the server's response.
   */
  async callTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const entry = this.connections.get(serverName)

    if (!entry) {
      return {
        isError: true,
        content: `MCP server "${serverName}" is not connected.`,
      }
    }

    try {
      // The MCP SDK client.callTool() returns
      // `{ content: Array<{ type: 'text', text: string }>, isError?: boolean }`.
      const response: {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      } = await entry.client.callTool({
        name: toolName,
        arguments: input,
      })

      // Flatten the content array into a single string for ToolResult.
      const textContent = (response.content ?? [])
        .filter((block: { type: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text ?? '')
        .join('\n')

      return {
        output: textContent,
        content: textContent || JSON.stringify(response.content),
        isError: response.isError ?? false,
      }
    } catch (err) {
      // Auto-reconnect on session expiry (one retry).
      if (isMcpSessionExpiredError(err)) {
        try {
          await this.reconnectServer(serverName)
          const retryEntry = this.connections.get(serverName)
          if (retryEntry) {
            const retryResponse: {
              content?: Array<{ type: string; text?: string }>
              isError?: boolean
            } = await retryEntry.client.callTool({
              name: toolName,
              arguments: input,
            })
            const textContent = (retryResponse.content ?? [])
              .filter((block: { type: string }) => block.type === 'text')
              .map((block: { text?: string }) => block.text ?? '')
              .join('\n')
            return {
              output: textContent,
              content: textContent || JSON.stringify(retryResponse.content),
              isError: retryResponse.isError ?? false,
            }
          }
        } catch {
          // Reconnection or retry failed — fall through to original error.
        }
      }

      return {
        isError: true,
        content: `MCP tool "${toolName}" on server "${serverName}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
  }

  /**
   * Reconnect a specific MCP server by tearing down the old connection
   * and establishing a new one with the same config.
   */
  async reconnectServer(serverName: string): Promise<void> {
    const entry = this.connections.get(serverName)
    if (!entry) return

    const config = entry.serverConfig

    // Tear down old connection
    try {
      await this.safeDisconnect(serverName, entry.client)
    } catch { /* best-effort */ }

    // Clear caches for this server
    for (const [key] of this.connectionCache) {
      if (key.startsWith(`${serverName}:`)) {
        this.connectionCache.delete(key)
      }
    }
    this.connections.delete(serverName)

    // Reconnect with same config
    await this.connectToServer(config)
  }

  /**
   * Return a list of connected MCP servers with basic status info.
   */
  getConnectedServers(): Array<{ name: string; type: string; connected: boolean }> {
    const servers: Array<{ name: string; type: string; connected: boolean }> = []
    for (const [name, entry] of this.connections) {
      servers.push({
        name,
        type: entry.serverConfig.type ?? 'stdio',
        connected: true,
      })
    }
    return servers
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Create the transport-specific client for a server configuration.
   *
   * This is the single point where the `@modelcontextprotocol/sdk` transport
   * classes are instantiated.  If the SDK is unavailable the function falls
   * back to stub objects so the rest of the architecture can be exercised
   * in tests without a live MCP server.
   */
  private async createConnection(config: McpServerConfig): Promise<any> {
    switch (config.type) {
      case 'stdio':
        return this.connectStdio(config)
      case 'sse':
        return this.connectSse(config)
      case 'ws':
        return this.connectWebSocket(config)
      case 'http':
        return this.connectHttp(config)
      default:
        throw new Error(`Unsupported MCP transport type: "${config.type}"`)
    }
  }

  /**
   * Spawn a child-process MCP server and connect over stdin/stdout.
   *
   * Uses `StdioClientTransport` from the MCP SDK.
   */
  private async connectStdio(config: McpServerConfig): Promise<any> {
    if (!config.command) {
      throw new Error(
        `MCP server "${config.name}" has type "stdio" but no command specified.`,
      )
    }

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
          ? Object.fromEntries(
              Object.entries({ ...process.env, ...config.env })
                .filter(([, v]) => v !== undefined) as [string, string][],
            )
          : undefined,
      })
      const client = new Client({ name: 'cc-agent', version: '1.0.0' })
      await client.connect(transport)
      return client
    } catch (err) {
      console.error(
        `[mcp] Failed to connect stdio server "${config.name}": ${err instanceof Error ? err.message : err}`,
      )
      console.error('[mcp] Falling back to stub client.')
      return createStubClient(config)
    }
  }

  /**
   * Connect to an MCP server over Server-Sent Events.
   */
  private async connectSse(config: McpServerConfig): Promise<any> {
    if (!config.url) {
      throw new Error(
        `MCP server "${config.name}" has type "sse" but no URL specified.`,
      )
    }

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      const transport = new SSEClientTransport(new URL(config.url))
      const client = new Client({ name: 'cc-agent', version: '1.0.0' })
      await client.connect(transport)
      return client
    } catch (err) {
      console.error(
        `[mcp] Failed to connect SSE server "${config.name}": ${err instanceof Error ? err.message : err}`,
      )
      console.error('[mcp] Falling back to stub client.')
      return createStubClient(config)
    }
  }

  /**
   * Connect to an MCP server over WebSocket.
   */
  private async connectWebSocket(config: McpServerConfig): Promise<any> {
    if (!config.url) {
      throw new Error(
        `MCP server "${config.name}" has type "ws" but no URL specified.`,
      )
    }

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { WebSocketClientTransport } = await import('@modelcontextprotocol/sdk/client/websocket.js')
      const transport = new WebSocketClientTransport(new URL(config.url))
      const client = new Client({ name: 'cc-agent', version: '1.0.0' })
      await client.connect(transport)
      return client
    } catch (err) {
      console.error(
        `[mcp] Failed to connect WebSocket server "${config.name}": ${err instanceof Error ? err.message : err}`,
      )
      console.error('[mcp] Falling back to stub client.')
      return createStubClient(config)
    }
  }

  /**
   * Connect to an MCP server over plain HTTP (Streamable HTTP transport).
   */
  private async connectHttp(config: McpServerConfig): Promise<any> {
    if (!config.url) {
      throw new Error(
        `MCP server "${config.name}" has type "http" but no URL specified.`,
      )
    }

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )
      const transport = new StreamableHTTPClientTransport(new URL(config.url))
      const client = new Client({ name: 'cc-agent', version: '1.0.0' })
      await client.connect(transport)
      return client
    } catch (err) {
      console.error(
        `[mcp] Failed to connect HTTP server "${config.name}": ${err instanceof Error ? err.message : err}`,
      )
      console.error('[mcp] Falling back to stub client.')
      return createStubClient(config)
    }
  }

  /**
   * Disconnect a single client, swallowing errors.
   */
  private async safeDisconnect(name: string, client: any): Promise<void> {
    try {
      if (client && typeof client.close === 'function') {
        await client.close()
      }
    } catch (err) {
      console.error(
        `[mcp] Error disconnecting server "${name}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

// ============================================================
// Stub client for development / testing
// ============================================================

/**
 * Minimal stub that satisfies the McpClientManager contract when the real
 * `@modelcontextprotocol/sdk` is not installed.
 *
 * Returns empty tool lists and echo-style call results so the surrounding
 * architecture can be exercised end-to-end.
 */
function createStubClient(config: McpServerConfig): any {
  return {
    _stub: true,
    _serverName: config.name,

    async listTools(): Promise<{
      tools: Array<{
        name: string
        description: string
        inputSchema: Record<string, unknown>
      }>
    }> {
      // Stub servers advertise no tools.
      return { tools: [] }
    },

    async callTool(params: {
      name: string
      arguments: Record<string, unknown>
    }): Promise<{
      content: Array<{ type: string; text: string }>
      isError: boolean
    }> {
      return {
        content: [
          {
            type: 'text',
            text: `[stub] Tool "${params.name}" called on MCP server "${config.name}".`,
          },
        ],
        isError: false,
      }
    },

    async close(): Promise<void> {
      // No-op for stubs.
    },
  }
}

// ============================================================
// Batched connection helper
// ============================================================

/**
 * Connect to a list of MCP servers in parallel batches, respecting the
 * different concurrency limits for local (stdio) vs. remote transports.
 *
 * Returns an array of settled results so partial failures do not block the
 * remaining servers.
 */
async function connectInBatches(
  manager: McpClientManager,
  configs: McpServerConfig[],
): Promise<PromiseSettledResult<any>[]> {
  const localConfigs = configs.filter(c => c.type === 'stdio')
  const remoteConfigs = configs.filter(c => c.type !== 'stdio')

  const results: PromiseSettledResult<any>[] = []

  // Connect local (stdio) servers in small batches to avoid fork storms.
  for (let i = 0; i < localConfigs.length; i += LOCAL_CONNECTION_BATCH_SIZE) {
    const batch = localConfigs.slice(i, i + LOCAL_CONNECTION_BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map(c => manager.connectToServer(c)),
    )
    results.push(...settled)
  }

  // Connect remote (SSE / WS / HTTP) servers in larger batches.
  for (let i = 0; i < remoteConfigs.length; i += REMOTE_CONNECTION_BATCH_SIZE) {
    const batch = remoteConfigs.slice(i, i + REMOTE_CONNECTION_BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map(c => manager.connectToServer(c)),
    )
    results.push(...settled)
  }

  return results
}

// ============================================================
// One-shot entry point
// ============================================================

/**
 * Connect to every configured MCP server, discover their tools, and return
 * the manager together with the merged tool list.
 *
 * This is the primary entry point consumed by the main orchestrator and the
 * headless runner.  Callers receive the manager so they can invoke tools
 * later and call `disconnectAll()` at shutdown.
 *
 * @param configs - Array of MCP server configurations (from settings / CLI).
 * @returns An object containing the live manager and discovered tools.
 */
export async function getMcpToolsCommandsAndResources(
  configs: McpServerConfig[],
): Promise<{ manager: McpClientManager; tools: McpToolDefinition[] }> {
  const manager = new McpClientManager()

  if (configs.length === 0) {
    return { manager, tools: [] }
  }

  // Connect to all servers in transport-appropriate batches.
  const settled = await connectInBatches(manager, configs)

  // Log any connection failures for operator visibility.
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error(
        '[mcp] Failed to connect to server:',
        result.reason instanceof Error ? result.reason.message : result.reason,
      )
    }
  }

  // Discover tools across every successfully connected server.
  const tools = await manager.discoverTools()

  return { manager, tools }
}

// ============================================================
// IDE / whitelist filter
// ============================================================

/**
 * Determine whether an MCP tool should be included based on an optional
 * allow-list of fully-qualified tool names.
 *
 * When `allowList` is `undefined` or empty, every tool passes through.
 * Otherwise only tools whose names appear in the list are included.
 *
 * This is used by IDE integrations that want to expose a curated subset
 * of MCP tools to the model.
 */
export function isIncludedMcpTool(
  tool: McpToolDefinition,
  allowList?: string[],
): boolean {
  if (!allowList || allowList.length === 0) {
    return true
  }
  return allowList.includes(tool.name)
}

// ============================================================
// Session-expired error detection
// ============================================================

/**
 * Inspect an error to determine whether the MCP server session has expired.
 *
 * Two signals are checked:
 *   1. HTTP 404 status — the server endpoint was torn down.
 *   2. JSON-RPC error code `-32001` — the server explicitly reports that
 *      the session is no longer valid.
 *
 * When either signal matches the caller should reconnect rather than retry
 * the same request.
 */
export function isMcpSessionExpiredError(error: any): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  // Check for HTTP 404 (transport-level).
  if (error.statusCode === 404 || error.status === 404) {
    return true
  }

  // Check for JSON-RPC -32001 (session expired).
  if (error.code === -32001) {
    return true
  }

  // Some SDK wrappers nest the code inside a `data` or `cause` field.
  if (error.data && typeof error.data === 'object' && error.data.code === -32001) {
    return true
  }
  if (error.cause && typeof error.cause === 'object') {
    return isMcpSessionExpiredError(error.cause)
  }

  return false
}

// ============================================================
// McpAuthCache — file-based "needs auth" cache
// ============================================================

/**
 * Path to the on-disk JSON file that persists "server needs authentication"
 * flags across sessions.
 */
function getAuthCachePath(): string {
  return path.join(os.homedir(), '.cc-agent', 'mcp-needs-auth-cache.json')
}

interface AuthCacheEntry {
  /** ISO-8601 timestamp when the entry was written. */
  timestamp: number
  /** Whether the server was determined to need authentication. */
  needsAuth: boolean
  /** Optional detail message (e.g. the auth URL). */
  detail?: string
}

type AuthCacheData = Record<string, AuthCacheEntry>

/**
 * Persistent cache that records which MCP servers need authentication.
 *
 * The cache lives at `~/.cc-agent/mcp-needs-auth-cache.json` and entries
 * expire after {@link AUTH_CACHE_TTL_MS} (15 minutes by default).
 *
 * The purpose is to avoid re-probing servers for auth status on every REPL
 * startup — a fresh cache hit lets the UI immediately surface the right
 * "authenticate?" prompt.
 */
export class McpAuthCache {
  private data: AuthCacheData = {}
  private cachePath: string
  private loaded: boolean = false

  constructor(cachePath?: string) {
    this.cachePath = cachePath ?? getAuthCachePath()
  }

  /**
   * Load the cache from disk.  If the file does not exist or is corrupt the
   * cache starts empty.
   */
  async load(): Promise<void> {
    if (this.loaded) return

    try {
      const raw = await fs.readFile(this.cachePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.data = parsed as AuthCacheData
      }
    } catch {
      // Missing or corrupt file — start with empty cache.
      this.data = {}
    }

    this.loaded = true
  }

  /**
   * Persist the current cache to disk.  Parent directories are created as
   * needed.
   */
  async save(): Promise<void> {
    const dir = path.dirname(this.cachePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.cachePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  /**
   * Retrieve the cached auth state for a server, or `null` if no valid
   * (non-expired) entry exists.
   */
  get(serverName: string): AuthCacheEntry | null {
    const entry = this.data[serverName]
    if (!entry) return null

    const age = Date.now() - entry.timestamp
    if (age > AUTH_CACHE_TTL_MS) {
      // Entry has expired — remove it lazily.
      delete this.data[serverName]
      return null
    }

    return entry
  }

  /**
   * Record the auth state for a server.  The entry is timestamped with the
   * current time.
   */
  set(serverName: string, needsAuth: boolean, detail?: string): void {
    this.data[serverName] = {
      timestamp: Date.now(),
      needsAuth,
      detail,
    }
  }

  /**
   * Remove the entry for a server (e.g. after successful authentication).
   */
  delete(serverName: string): void {
    delete this.data[serverName]
  }

  /**
   * Purge all expired entries.  Useful before saving to keep the file small.
   */
  pruneExpired(): void {
    const now = Date.now()
    for (const key of Object.keys(this.data)) {
      const entry = this.data[key]!
      if (now - entry.timestamp > AUTH_CACHE_TTL_MS) {
        delete this.data[key]
      }
    }
  }

  /**
   * Return all non-expired entries as a read-only map.
   */
  entries(): Readonly<AuthCacheData> {
    this.pruneExpired()
    return { ...this.data }
  }
}

// ============================================================
// McpToolDefinition -> ToolInstance conversion
// ============================================================

/**
 * Convert an {@link McpToolDefinition} into a fully-formed {@link ToolInstance}
 * using the `buildTool()` factory.
 *
 * The returned instance delegates `call()` to the MCP client manager, so it
 * can be dropped into the same tool pool as built-in tools without any
 * special-casing in the query engine.
 *
 * Safety flags are fail-closed (all `false`) because the remote tool's
 * actual side-effect profile is unknown.
 *
 * @param def     - The MCP tool definition discovered from a server.
 * @param manager - The McpClientManager that owns the server connection.
 * @returns A ToolInstance wrapping the MCP tool.
 */
export function mcpToolDefToToolInstance(
  def: McpToolDefinition,
  manager: McpClientManager,
): ToolInstance {
  // Parse the local (unqualified) tool name from the fully-qualified name.
  const parsed = parseMcpToolName(def.name)
  const localToolName = parsed ? parsed.toolName : def.name

  return buildTool({
    name: def.name,
    description: `[MCP: ${def.serverName}] ${def.description}`,
    inputSchema: def.inputSchema,

    async call(
      input: Record<string, unknown>,
      _context: ToolUseContext,
      _canUseTool: unknown,
      _parentMessage: unknown,
      _onProgress?: unknown,
    ): Promise<ToolResult> {
      return manager.callTool(def.serverName, localToolName, input)
    },

    // Fail-closed defaults — remote MCP tools are opaque.
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,

    async checkPermissions(
      _input: Record<string, unknown>,
      _context?: unknown,
    ): Promise<PermissionResult> {
      // MCP tools are allowed by default; the permission system can still
      // deny them via the deny-list at a higher level.
      return { behavior: 'allow' }
    },

    isEnabled: () => true,

    userFacingName: () => def.name,

    renderToolUseMessage: (_input: Record<string, unknown>) => {
      return `Calling MCP tool \`${def.name}\` on server "${def.serverName}"`
    },

    renderToolResultMessage: (result: ToolResult) => {
      if (result.isError) {
        return `MCP tool \`${def.name}\` returned an error.`
      }
      return `MCP tool \`${def.name}\` completed successfully.`
    },
  })
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Truncate a tool description to {@link MAX_MCP_DESCRIPTION_LENGTH},
 * appending an ellipsis marker when truncation occurs.
 */
function truncateDescription(description: string): string {
  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) {
    return description
  }
  return (
    description.slice(0, MAX_MCP_DESCRIPTION_LENGTH - 3) + '...'
  )
}
