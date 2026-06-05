/**
 * Web mode — Express + WebSocket server for the browser-based UI.
 *
 * Serves a static HTML shell and exposes a WebSocket endpoint for real-time
 * bidirectional communication with the query engine.  Each WebSocket
 * connection receives its own QueryEngine instance so that multiple browser
 * tabs can operate independently.
 *
 * Protocol (JSON over WebSocket):
 *   Client -> Server:
 *     { type: 'message',            content: string }
 *     { type: 'approval:response',  toolUseId: string, approved: boolean }
 *     { type: 'file:tree',          path?: string }
 *     { type: 'file:read',          path: string }
 *     { type: 'sessions:list' }
 *     { type: 'session:resume',     sessionId: string }
 *
 *   Server -> Client:
 *     { type: 'agent:text',              content: string }
 *     { type: 'agent:thinking',          content: string }
 *     { type: 'agent:tool_use',          id, name, input }
 *     { type: 'agent:tool_result',       toolUseId, content, isError }
 *     { type: 'agent:approval_request',  toolUseId, toolName, input }
 *     { type: 'agent:done',              result: { ... } }
 *     { type: 'agent:error',             message: string }
 *     { type: 'file:tree',               path, entries }
 *     { type: 'file:content',            path, content }
 *     { type: 'sessions:list',           sessions }
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'

import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'

// Node v24 + @anthropic-ai/sdk: the SDK internally creates a readline interface
// for CLI progress bars.  In web mode stdin is never read, so silencing stdin
// errors prevents spurious "readline was closed" crashes.
process.stdin.on('error', () => {})

import {
  assembleRuntime,
  createQueryEngine,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../main.js'
import type { AssembledRuntime } from '../main.js'

import type { PermissionMode } from '../types/index.js'
import type { QueryEngine, QueryResult } from '../QueryEngine.js'
import type { ToolUseBlock, ToolResultBlock } from '../types/index.js'

// ============================================================
// Option interface
// ============================================================

export interface WebOptions {
  /** Port to listen on (default: 3000). */
  port?: number
  /** Model override. */
  model?: string
  /** System prompt override (replaces default prompt entirely). */
  systemPrompt?: string
  /** Text appended AFTER the selected base system prompt. */
  appendSystemPrompt?: string
  /** Permission mode. */
  permissionMode?: PermissionMode
  /** Maximum output tokens. */
  maxTokens?: number
  /** Sampling temperature (0-1). */
  temperature?: number
  /** Working directory. */
  cwd: string
  /** Permission allow-list patterns. */
  allowList?: string[]
  /** Permission deny-list patterns. */
  denyList?: string[]
}

// ============================================================
// WebSocket protocol types (server -> client)
// ============================================================

interface WsAgentTextMessage {
  type: 'agent:text'
  content: string
}

interface WsAgentThinkingMessage {
  type: 'agent:thinking'
  content: string
}

interface WsAgentToolUseMessage {
  type: 'agent:tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface WsAgentToolResultMessage {
  type: 'agent:tool_result'
  toolUseId: string
  content: string
  isError: boolean
}

interface WsAgentApprovalRequestMessage {
  type: 'agent:approval_request'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

interface WsAgentDoneMessage {
  type: 'agent:done'
  result: {
    text: string
    stopReason: string
    turnsUsed: number
    tokenUsage: {
      inputTokens: number
      outputTokens: number
    }
    durationMs: number
  }
}

interface WsAgentErrorMessage {
  type: 'agent:error'
  message: string
}

interface WsFileTreeMessage {
  type: 'file:tree'
  path: string
  entries: Array<{ name: string; type: 'file' | 'directory'; size: number }>
}

interface WsFileContentMessage {
  type: 'file:content'
  path: string
  content: string
}

interface WsSessionsListMessage {
  type: 'sessions:list'
  sessions: Array<{ id: string; modified: number; size: number }>
}

type WsServerMessage =
  | WsAgentTextMessage
  | WsAgentThinkingMessage
  | WsAgentToolUseMessage
  | WsAgentToolResultMessage
  | WsAgentApprovalRequestMessage
  | WsAgentDoneMessage
  | WsAgentErrorMessage
  | WsFileTreeMessage
  | WsFileContentMessage
  | WsSessionsListMessage

// ============================================================
// WebSocket protocol types (client -> server)
// ============================================================

interface WsClientMessage {
  type: 'message'
  content: string
}

interface WsClientApprovalResponse {
  type: 'approval:response'
  toolUseId: string
  approved: boolean
}

interface WsClientFileTree {
  type: 'file:tree'
  path?: string
}

interface WsClientFileRead {
  type: 'file:read'
  path: string
}

interface WsClientSessionsList {
  type: 'sessions:list'
}

interface WsClientSessionResume {
  type: 'session:resume'
  sessionId: string
}

type WsIncomingMessage =
  | WsClientMessage
  | WsClientApprovalResponse
  | WsClientFileTree
  | WsClientFileRead
  | WsClientSessionsList
  | WsClientSessionResume

// ============================================================
// Constants
// ============================================================

const DEFAULT_PORT = 3000
const MAX_FILE_READ_SIZE = 1_048_576 // 1 MB

// ============================================================
// Server entry point
// ============================================================

/**
 * Start the Express + WebSocket server for the web UI.
 *
 * Assembles a shared runtime (tools, MCP, system prompt) once at startup,
 * then creates a per-connection QueryEngine for every incoming WebSocket.
 */
export async function startWebServer(options: WebOptions): Promise<void> {
  const port = options.port ?? DEFAULT_PORT

  // ---- Assemble shared runtime ----
  const runtime: AssembledRuntime = await assembleRuntime({
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    permissionMode: options.permissionMode ?? 'default',
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    cwd: options.cwd,
    mcpConfigs: [],
    allowList: options.allowList,
    denyList: options.denyList,
  })

  // ---- Express app ----
  const app = express()

  // Serve the static web UI shell.
  const webRoot = path.join(import.meta.dirname, '..', '..', 'dist', 'web')
  app.use(express.static(webRoot))

  // Fallback: serve index.html for any non-API route so the SPA can handle
  // client-side routing.
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(webRoot, 'index.html'))
  })

  // ---- HTTP server ----
  const server = http.createServer(app)

  // ---- WebSocket server ----
  const wss = new WebSocketServer({ server })

  // Track open connections for graceful shutdown.
  const openConnections = new Set<WebSocket>()

  wss.on('connection', (ws: WebSocket) => {
    openConnections.add(ws)

    // Per-connection engine state (created lazily on first message).
    let engine: QueryEngine | null = null
    // Pending approval promises keyed by toolUseId.
    const pendingApprovals = new Map<string, (approved: boolean) => void>()
    // The most recently created approval promise.  The engine emits
    // tool:approval_needed synchronously before calling approvalCallback,
    // so we capture the promise in the event handler and return it from
    // the callback.
    let latestApprovalPromise: Promise<boolean> | null = null

    // Helper: send a typed message to the client.
    const send = (msg: WsServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    }

    // ---- Wire engine events ----
    const wireEngine = (eng: QueryEngine): void => {
      eng.on('text', (content: string) => {
        send({ type: 'agent:text', content })
      })

      eng.on('thinking', (content: string) => {
        send({ type: 'agent:thinking', content })
      })

      eng.on('tool:use', (block: ToolUseBlock) => {
        send({ type: 'agent:tool_use', id: block.id, name: block.name, input: block.input })
      })

      eng.on('tool:result', (block: ToolResultBlock) => {
        send({
          type: 'agent:tool_result',
          toolUseId: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          isError: !!block.is_error,
        })
      })

      // The engine emits tool:approval_needed and then IMMEDIATELY calls
      // approvalCallback (synchronous sequence in executeToolBatch).  We
      // create the pending promise here so it is ready when the callback
      // fires on the very next line.
      eng.on('tool:approval_needed', (info: { toolUseId: string; toolName: string; input: Record<string, unknown> }) => {
        const promise = new Promise<boolean>((resolve) => {
          pendingApprovals.set(info.toolUseId, resolve)
        })
        latestApprovalPromise = promise

        send({
          type: 'agent:approval_request',
          toolUseId: info.toolUseId,
          toolName: info.toolName,
          input: info.input,
        })
      })

      eng.on('done', (result: QueryResult) => {
        send({
          type: 'agent:done',
          result: {
            text: result.text,
            stopReason: result.stopReason,
            turnsUsed: result.turnsUsed,
            tokenUsage: {
              inputTokens: result.tokenUsage.inputTokens,
              outputTokens: result.tokenUsage.outputTokens,
            },
            durationMs: result.durationMs,
          },
        })
      })

      eng.on('error', (err: Error) => {
        send({ type: 'agent:error', message: err.message })
      })
    }

    // ---- Approval callback ----
    // The engine calls this synchronously right after emitting
    // tool:approval_needed.  The promise was already created and stored
    // by the event handler above, so we simply return it.
    const approvalCallback = (
      _toolName: string,
      _input: Record<string, unknown>,
    ): Promise<boolean> => {
      const promise = latestApprovalPromise
      latestApprovalPromise = null
      return promise ?? Promise.resolve(false)
    }

    // ---- Message handler ----
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let incoming: WsIncomingMessage
      try {
        // ws delivers Buffer on Node.js; ArrayBuffer/Buffer[] are possible
        // in edge cases.  Use proper type guards to narrow the union.
        let text: string
        if (Buffer.isBuffer(raw)) {
          text = raw.toString('utf-8')
        } else if (Array.isArray(raw)) {
          text = Buffer.concat(raw).toString('utf-8')
        } else {
          text = Buffer.from(raw).toString('utf-8')
        }
        incoming = JSON.parse(text) as WsIncomingMessage
      } catch {
        send({ type: 'agent:error', message: 'Invalid JSON message' })
        return
      }

      switch (incoming.type) {
        // ---- User prompt ----
        case 'message': {
          // Lazily create the engine on the first user message so that
          // file-tree / session-list requests do not pay the engine-setup cost.
          if (!engine) {
            engine = createQueryEngine(runtime, {
              silent: true,
              isInteractive: true,
              approvalCallback,
            })
            wireEngine(engine)
          }

          // Reject new prompts while a query is already running.
          if (engine.getState().status === 'running') {
            send({ type: 'agent:error', message: 'A query is already in progress. Please wait.' })
            return
          }

          // Run the query asynchronously.  Errors are forwarded via the
          // engine's 'error' event, but we also catch synchronous throws.
          engine.run(incoming.content).catch((err: unknown) => {
            send({
              type: 'agent:error',
              message: err instanceof Error ? err.message : String(err),
            })
          })
          break
        }

        // ---- Approval response ----
        case 'approval:response': {
          const resolver = pendingApprovals.get(incoming.toolUseId)
          if (resolver) {
            pendingApprovals.delete(incoming.toolUseId)
            resolver(incoming.approved)
          }
          break
        }

        // ---- Directory listing ----
        case 'file:tree': {
          handleFileTree(runtime, incoming.path, send)
          break
        }

        // ---- File read ----
        case 'file:read': {
          handleFileRead(runtime, incoming.path, send)
          break
        }

        // ---- Session list ----
        case 'sessions:list': {
          handleSessionsList(runtime, send)
          break
        }

        // ---- Session resume (acknowledgement only) ----
        case 'session:resume': {
          send({
            type: 'agent:text',
            content: `[web] Session resume requested for "${incoming.sessionId}". This is not yet fully implemented in web mode.`,
          })
          break
        }

        default: {
          // Exhaustiveness check — the switch should cover all WsIncomingMessage variants.
          const _exhaustive: never = incoming
          send({
            type: 'agent:error',
            message: `Unknown message type: ${(_exhaustive as WsIncomingMessage).type}`,
          })
        }
      }
    })

    // ---- Connection close ----
    ws.on('close', () => {
      openConnections.delete(ws)

      // Abort any running query so the API call does not continue orphaned.
      if (engine && engine.getState().status === 'running') {
        engine.abort()
      }

      // Clean up any unresolved approval promises.
      for (const [, resolve] of pendingApprovals) {
        resolve(false)
      }
      pendingApprovals.clear()
    })

    // ---- Connection error ----
    ws.on('error', (err: Error) => {
      console.error(`[web] WebSocket error: ${err.message}`)
      openConnections.delete(ws)
    })
  })

  // ---- Start listening ----
  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.error(`[web] Server listening on http://localhost:${port}`)
      console.error(`[web] Working directory: ${runtime.cwd}`)
      resolve()
    })
  })

  // ---- Graceful shutdown ----
  const shutdown = async (): Promise<void> => {
    console.error('\n[web] Shutting down...')

    // Close all open WebSocket connections.
    for (const ws of openConnections) {
      try {
        ws.close(1001, 'Server shutting down')
      } catch {
        // Best-effort close.
      }
    }
    openConnections.clear()

    // Close the WebSocket server.
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Close the HTTP server.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Disconnect MCP servers.
    try {
      await runtime.mcpManager.disconnectAll()
    } catch (err) {
      console.error(
        '[web] Error disconnecting MCP servers:',
        err instanceof Error ? err.message : String(err),
      )
    }

    console.error('[web] Shutdown complete.')
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch(() => process.exit(1))
  })
  process.on('SIGTERM', () => {
    shutdown().catch(() => process.exit(1))
  })
}

// ============================================================
// File-tree handler
// ============================================================

/**
 * Read a directory listing and send it back to the client.
 *
 * Defaults to `runtime.cwd` when no path is given.  Rejects paths that
 * escape the working directory (path-traversal protection).  Filters out
 * hidden entries (dot-prefixed) and `node_modules`.
 */
async function handleFileTree(
  runtime: AssembledRuntime,
  requestedPath: string | undefined,
  send: (msg: WsServerMessage) => void,
): Promise<void> {
  try {
    const targetDir = requestedPath
      ? path.resolve(requestedPath)
      : runtime.cwd

    // Security: ensure the resolved path is within the working directory.
    if (!isPathWithin(targetDir, runtime.cwd)) {
      send({ type: 'agent:error', message: `Access denied: path is outside the working directory` })
      return
    }

    const entries = await fs.readdir(targetDir, { withFileTypes: true })

    const filtered = entries
      .filter((entry) => {
        // Exclude hidden files/directories (starting with '.').
        if (entry.name.startsWith('.')) return false
        // Exclude node_modules.
        if (entry.name === 'node_modules') return false
        return true
      })
      .map((entry) => ({
        name: entry.name,
        type: (entry.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
        size: entry.isDirectory() ? 0 : 0, // Dirent does not carry size; set to 0.
      }))

    send({ type: 'file:tree', path: targetDir, entries: filtered })
  } catch (err) {
    send({
      type: 'agent:error',
      message: `Failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ============================================================
// File-read handler
// ============================================================

/**
 * Read a file's content and send it to the client.
 *
 * Caps the response at 1 MB to avoid overwhelming the WebSocket.
 */
async function handleFileRead(
  runtime: AssembledRuntime,
  filePath: string,
  send: (msg: WsServerMessage) => void,
): Promise<void> {
  try {
    const resolved = path.resolve(filePath)

    // Security: ensure the path is within the working directory.
    if (!isPathWithin(resolved, runtime.cwd)) {
      send({ type: 'agent:error', message: `Access denied: path is outside the working directory` })
      return
    }

    const stat = await fs.stat(resolved)
    if (stat.size > MAX_FILE_READ_SIZE) {
      send({
        type: 'agent:error',
        message: `File too large (${stat.size} bytes, max ${MAX_FILE_READ_SIZE})`,
      })
      return
    }

    const content = await fs.readFile(resolved, 'utf-8')
    send({ type: 'file:content', path: resolved, content })
  } catch (err) {
    send({
      type: 'agent:error',
      message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ============================================================
// Sessions-list handler
// ============================================================

/**
 * Scan the `.cc-agent/sessions/` directory for `.jsonl` session files and
 * return a summary list to the client.
 */
async function handleSessionsList(
  runtime: AssembledRuntime,
  send: (msg: WsServerMessage) => void,
): Promise<void> {
  try {
    const sessionsDir = path.join(runtime.cwd, '.cc-agent', 'sessions')
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true })

    const sessions = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const fullPath = path.join(sessionsDir, entry.name)
        const id = entry.name.replace(/\.jsonl$/, '')
        return { id, fullPath }
      })

    // Stat each file to get modification time and size.
    const results: Array<{ id: string; modified: number; size: number }> = []
    for (const session of sessions) {
      try {
        const stat = await fs.stat(session.fullPath)
        results.push({
          id: session.id,
          modified: stat.mtimeMs,
          size: stat.size,
        })
      } catch {
        // Skip files that disappeared between readdir and stat.
      }
    }

    // Sort by modification time, newest first.
    results.sort((a, b) => b.modified - a.modified)

    send({ type: 'sessions:list', sessions: results })
  } catch (err) {
    // If the sessions directory does not exist, return an empty list.
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      send({ type: 'sessions:list', sessions: [] })
      return
    }

    send({
      type: 'agent:error',
      message: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

// ============================================================
// Path-security helper
// ============================================================

/**
 * Check whether `target` is equal to or a subdirectory of `root`.
 *
 * Both paths must already be resolved to absolute form.  The comparison
 * uses `path.relative` and checks that the result does not start with `..`.
 */
function isPathWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  // An empty string means target === root, which is allowed.
  // A relative path starting with '..' escapes the root.
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
