/**
 * Core type definitions for the AI Coding Agent
 * Mirrors Claude Code's type architecture
 */

// ============================================================
// Message Types
// ============================================================

export type Role = 'user' | 'assistant' | 'system'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

export interface Message {
  id: string
  uuid: string
  role: Role
  content: string | ContentBlock[]
  timestamp: number
  parentUuid?: string
  isMeta?: boolean
  model?: string
}

export interface TranscriptMessage extends Message {
  type: 'user' | 'assistant' | 'attachment' | 'system'
}

// ============================================================
// Entry Types (Session Storage)
// ============================================================

export type EntryType =
  | 'user'
  | 'assistant'
  | 'attachment'
  | 'system'
  | 'summary'
  | 'custom-title'
  | 'tag'
  | 'agent-setting'
  | 'agent-name'
  | 'agent-color'
  | 'mode'
  | 'worktree-state'
  | 'pr-link'
  | 'content-replacement'
  | 'progress'

export interface SessionEntry {
  type: EntryType
  uuid: string
  timestamp: number
  parentUuid?: string
  sessionId: string
}

// ============================================================
// Permission Types
// ============================================================

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionResult {
  behavior: PermissionBehavior
  updatedInput?: Record<string, unknown>
  message?: string
}

export interface PermissionContext {
  permissionMode: PermissionMode
  allowList: string[]
  denyList: string[]
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

// ============================================================
// Tool Types
// ============================================================

export interface ToolProgressData {
  status?: string
  progress?: number
  total?: number
}

export interface ToolResult<Output = unknown> {
  output?: Output
  content?: string | ContentBlock[]
  isError?: boolean
  contextModifier?: ContextModifier
  attachment?: Attachment
}

export interface ContextModifier {
  type: string
  data: unknown
}

export interface Attachment {
  type: string
  content: string
}

export interface ToolUseContext {
  tools: ToolInstance[]
  permissionContext: PermissionContext
  cwd: string
  sessionId: string
  abortController: AbortController
  mcpClients: Map<string, unknown>
  appState: Record<string, unknown>
  messages: Message[]
  renderedSystemPrompt?: string
}

export interface ToolInstance {
  name: string
  description: string | (() => string)
  inputSchema: Record<string, unknown>
  call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    canUseTool: CanUseTool,
    parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult>
  isConcurrencySafe(input?: Record<string, unknown>): boolean
  isReadOnly(input?: Record<string, unknown>): boolean
  isDestructive(input?: Record<string, unknown>): boolean
  checkPermissions(
    input: Record<string, unknown>,
    context?: PermissionContext,
  ): Promise<PermissionResult>
  isEnabled(): boolean
  prompt?(tools: ToolInstance[]): string
  userFacingName(input?: Record<string, unknown>): string
  interruptBehavior?(): 'block' | 'cancel' | 'allow'
  requiresUserInteraction?(): boolean
  renderToolUseMessage?(input: Record<string, unknown>): string
  renderToolResultMessage?(result: ToolResult): string
}

export type CanUseTool = (
  tool: ToolInstance,
  input: Record<string, unknown>,
) => Promise<PermissionResult>

// ============================================================
// Query Types
// ============================================================

export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolUse: ToolUseBlock }
  | { type: 'tool_input_delta'; index: number; partialJson: string }
  | { type: 'tool_result'; toolResult: ToolResultBlock }
  | { type: 'thinking'; content: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: Error }

export interface QueryOptions {
  messages: Message[]
  systemPrompt: string
  tools: ToolInstance[]
  model?: string
  maxTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  permissionContext: PermissionContext
  cwd: string
  sessionId: string
}

// ============================================================
// Memory Types
// ============================================================

export interface MemoryFile {
  path: string
  name: string
  description: string
  content: string
  mtimeMs: number
}

export interface MemoryConfig {
  memoryBase: string
  autoMemoryEnabled: boolean
  maxEntrypointLines: number
  maxEntrypointBytes: number
}

export interface SessionMemoryState {
  filePath: string
  lastUpdated: number
  tokenCount: number
}

// ============================================================
// Agent Types
// ============================================================

export interface AgentDefinition {
  name: string
  description: string
  prompt: string
  model?: string
  tools?: string[]
  memory?: boolean
  effort?: 'low' | 'medium' | 'high'
}

export interface AgentIdentity {
  agentId: string
  agentName: string
  agentType: string
  color?: string
  model: string
}

export interface AgentTask {
  id: string
  name: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  assignee?: string
  result?: string
}

// ============================================================
// MCP Types
// ============================================================

export interface McpServerConfig {
  name: string
  type: 'stdio' | 'sse' | 'ws' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export interface McpToolDefinition {
  name: string
  serverName: string
  description: string
  inputSchema: Record<string, unknown>
}

// ============================================================
// Skill Types
// ============================================================

export interface SkillDefinition {
  name: string
  description: string | string[]
  content: string
  whenToUse?: string
  allowedTools?: string[]
  model?: string
  effort?: 'low' | 'medium' | 'high'
  userInvocable: boolean
  paths?: string[]
  context?: 'inline' | 'fork'
  shell?: 'bash' | 'powershell'
  loadedFrom: 'skills' | 'bundled' | 'mcp'
  dir: string
}

export interface SkillCommand {
  name: string
  type: 'prompt'
  description: string
  getPrompt(args: string, context: ToolUseContext): Promise<ContentBlock[]>
  skill: SkillDefinition
}

// ============================================================
// Sandbox Types
// ============================================================

/**
 * Controls when sandboxing is applied to shell commands:
 * - `'always'`: every command is sandboxed regardless of risk
 * - `'never'`: sandboxing is completely disabled
 * - `'auto'`: sandbox is applied based on command risk classification
 *             (medium and above get sandboxed)
 */
export type SandboxMode = 'always' | 'never' | 'auto'

export interface SandboxConfig {
  enabled: boolean
  /** When sandboxing is applied: 'always', 'never', or 'auto'. */
  mode: SandboxMode
  failIfUnavailable: boolean
  filesystem: {
    allowWrite: string[]
    denyWrite: string[]
    allowRead: string[]
    denyRead: string[]
  }
  network: {
    allowDomains: string[]
    denyAll: boolean
  }
}

export interface SandboxRuntimeConfig {
  filesystem: SandboxConfig['filesystem']
  network: SandboxConfig['network']
  excludedCommands: string[]
}

// ============================================================
// Session Types
// ============================================================

export interface SessionState {
  sessionId: string
  projectDir: string
  cwd: string
  startedAt: number
  messages: Message[]
  compacted: boolean
  metadata: SessionMetadata
}

export interface SessionMetadata {
  title?: string
  tag?: string
  agentName?: string
  agentColor?: string
  mode?: string
}

// ============================================================
// App State
// ============================================================

export interface AppState {
  messages: Message[]
  input: string
  isLoading: boolean
  permissionContext: PermissionContext
  tools: ToolInstance[]
  mcpClients: Map<string, unknown>
  agents: AgentDefinition[]
  currentAgent?: AgentIdentity
  sessionId: string
  cwd: string
  compacted: boolean
  notifications: Notification[]
}

export interface Notification {
  id: string
  type: 'info' | 'warning' | 'error' | 'success'
  message: string
  timestamp: number
}

// ============================================================
// Context Window Types
// ============================================================

export interface ContextWindowConfig {
  windowSize: number
  reservedForSummary: number
  maxOutputTokens: number
  escalatedMaxTokens: number
  autoCompactBuffer: number
}

// ============================================================
// Team / Swarm Types
// ============================================================

export interface TeamFile {
  name: string
  description: string
  createdAt: number
  leadAgentId: string
  leadSessionId: string
  members: TeamMember[]
}

export interface TeamMember {
  agentId: string
  name: string
  agentType: string
  model: string
  color?: string
}

// ============================================================
// Background Task Info (external-facing)
// ============================================================

/**
 * External-facing summary of a background agent task.
 *
 * This is a lightweight DTO suitable for serialization in tool results
 * and progress notifications.  The full `BackgroundTask` type (with its
 * AbortController) lives in `coordinator/swarm/BackgroundTaskRegistry.ts`.
 */
export interface BackgroundTaskInfo {
  agentId: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  result?: string
  error?: string
}

// ============================================================
// Mailbox Message Info (external-facing)
// ============================================================

/**
 * External-facing representation of a mailbox message.
 *
 * Mirrors `MailboxMessage` from `coordinator/swarm/FileMailbox.ts` but
 * lives in the shared types module so consumers do not need to import
 * from the swarm internals.
 */
export interface MailboxMessageInfo {
  id: string
  from: string
  to: string
  type: 'task' | 'result' | 'status' | 'error' | 'ping'
  payload: unknown
  timestamp: number
  read: boolean
}

// ============================================================
// Compact Types
// ============================================================

export interface CompactResult {
  summary: string
  messagesKept: number
  messagesRemoved: number
  tokenCountBefore: number
  tokenCountAfter: number
}

// ============================================================
// Hook Types
// ============================================================

export interface HookDefinition {
  event: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd'
  matcher?: string
  handler: string
}

export interface HookResult {
  decision?: PermissionBehavior
  message?: string
  modifiedInput?: Record<string, unknown>
}
