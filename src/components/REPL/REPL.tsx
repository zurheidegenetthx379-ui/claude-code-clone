/**
 * REPL — main interactive REPL screen component.
 *
 * Built with React + Ink, this component provides the full terminal UI
 * for the AI Coding Agent's interactive mode:
 *
 *  - Scrollable message transcript with role-based colour coding
 *  - Real-time tool call progress and result display
 *  - Slash command dispatch (/help, /clear, /compact, /model, /exit)
 *  - Token count and cost tracking in a persistent status bar
 *  - Loading spinner during model queries
 *  - Ctrl+C abort / Ctrl+D exit handling
 *
 * The component receives a pre-configured QueryEngine and AppStateStore
 * from the replLauncher, which owns all lifecycle concerns (terminal
 * setup, cleanup, exit codes).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'

import type { QueryEngine, QueryResult } from '../../QueryEngine.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type {
  ToolInstance,
  ToolUseBlock,
  ToolResultBlock,
} from '../../types/index.js'
import type { ApprovalBridge, PendingApproval } from '../../utils/ApprovalBridge.js'
import type { CommandContext } from '../../commands.js'
import { executeCommand } from '../../commands.js'
import { MarkdownText } from '../MarkdownText.js'
import { compactConversation } from '../../services/compact/compact.js'
import { generateCompactSummary } from '../../services/compact/aiSummary.js'
import { getEffectiveContextWindowSize } from '../../utils/context.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import type { TranscriptEntry } from '../../utils/sessionStorage.js'

// ============================================================
// Props
// ============================================================

export interface REPLProps {
  /** Pre-configured query engine for model interaction. */
  queryEngine: QueryEngine
  /** Available tool definitions. */
  tools: ToolInstance[]
  /** The system prompt (displayed in /help for context). */
  systemPrompt: string
  /** Application state store (observable). */
  store: AppStateStore
  /** Optional initial prompt to execute on mount. */
  initialPrompt?: string
  /** Approval bridge for interactive tool confirmation. */
  approvalBridge?: ApprovalBridge
}

// ============================================================
// Internal types
// ============================================================

/** A display-ready message entry with optional styling metadata. */
interface DisplayEntry {
  id: string
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error'
  content: string
  toolName?: string
  isError?: boolean
  timestamp: number
}

/** Token / cost accounting for the status bar. */
interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  estimatedCostUsd: number
  turnsCompleted: number
}

// ============================================================
// Colour mapping per role
// ============================================================

const ROLE_COLORS: Record<DisplayEntry['role'], string> = {
  user: 'green',
  assistant: 'white',
  tool_use: 'yellow',
  tool_result: 'gray',
  system: 'cyan',
  error: 'red',
}

const ROLE_LABELS: Record<DisplayEntry['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  tool_use: 'Tool Call',
  tool_result: 'Tool Result',
  system: 'System',
  error: 'Error',
}

// ============================================================
// Slash-command help text
// ============================================================

const HELP_TEXT = `Available commands:
  /help           Show this help message
  /clear          Clear conversation and start fresh
  /compact        Compact conversation history to free context space
  /model [name]   Show or switch the active model
  /init           Create a CLAUDE.md project context file
  /review         Summarize the current conversation
  /doctor         Run environment diagnostics
  /exit           Exit the REPL (also Ctrl+D)
  /tools          List available tools
  /permissions    Show current permission settings
  /abort          Cancel the current query

Keyboard shortcuts:
  Ctrl+C          Abort current query (or exit if idle)
  Ctrl+D          Exit the REPL
  Enter           Submit prompt`

// ============================================================
// Component
// ============================================================

export function REPL(props: REPLProps): React.ReactElement {
  const { queryEngine, tools, systemPrompt: _systemPrompt, store, initialPrompt, approvalBridge } = props
  const { exit } = useApp()

  // ----------------------------------------------------------
  // Local state
  // ----------------------------------------------------------

  const [displayEntries, setDisplayEntries] = useState<DisplayEntry[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [currentModel, setCurrentModel] = useState(
    () => queryEngine.getState().model,
  )

  const [usage, setUsage] = useState<UsageInfo>({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    turnsCompleted: 0,
  })

  // Track whether we have executed the initial prompt already.
  const initialPromptHandled = useRef(false)

  // Ref for throttled streaming text updates (avoids re-render on every token).
  const streamBufferRef = useRef('')
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  /** Append a display entry to the transcript. */
  const addEntry = useCallback(
    (entry: Omit<DisplayEntry, 'id' | 'timestamp'>) => {
      setDisplayEntries(prev => [
        ...prev,
        {
          ...entry,
          id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
          timestamp: Date.now(),
        },
      ])
    },
    [],
  )

  // ----------------------------------------------------------
  // Streaming helpers
  // ----------------------------------------------------------

  /** Flush the current streaming text buffer into a finalized display entry. */
  const commitStreamingText = useCallback(() => {
    const text = streamBufferRef.current
    if (text.length > 0) {
      addEntry({ role: 'assistant', content: text })
    }
    streamBufferRef.current = ''
    setStreamingText(null)
  }, [addEntry])

  // ----------------------------------------------------------
  // Query execution
  // ----------------------------------------------------------

  const executeQuery = useCallback(
    async (prompt: string) => {
      setError(null)
      setIsLoading(true)
      store.setLoading(true)

      // Record user message in display.
      addEntry({ role: 'user', content: prompt })

      // Persist user message to session storage (best-effort).
      const appState = store.getState()
      const userMsgId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
      try {
        sessionStorage.appendEntry({
          type: 'user',
          uuid: userMsgId,
          sessionId: appState.sessionId,
          timestamp: Date.now(),
          content: prompt,
        } as TranscriptEntry, appState.cwd)
      } catch { /* persistence is best-effort */ }

      // Reset streaming state for this query.
      streamBufferRef.current = ''
      setStreamingText('')
      let fullResponseText = ''

      // Throttled streaming text flush (~30fps).
      streamTimerRef.current = setInterval(() => {
        const buf = streamBufferRef.current
        if (buf.length > 0) {
          setStreamingText(buf)
        }
      }, 33)

      // Wire up event listeners for this query cycle.
      const onText = (chunk: string) => {
        streamBufferRef.current += chunk
        fullResponseText += chunk
      }

      const onToolUse = (toolUse: ToolUseBlock) => {
        // Finalize current streaming text before showing tool call.
        commitStreamingText()

        const inputPreview = JSON.stringify(toolUse.input).slice(0, 200)
        addEntry({
          role: 'tool_use',
          content: `${toolUse.name}(${inputPreview})`,
          toolName: toolUse.name,
        })
      }

      const onToolResult = (result: ToolResultBlock) => {
        const preview =
          typeof result.content === 'string'
            ? result.content.slice(0, 300)
            : '[complex result]'
        addEntry({
          role: 'tool_result',
          content: preview,
          isError: result.is_error,
        })
      }

      const onError = (err: Error) => {
        setError(err.message)
      }

      queryEngine.on('text', onText)
      queryEngine.on('tool:use', onToolUse)
      queryEngine.on('tool:result', onToolResult)
      queryEngine.on('error', onError)

      try {
        const result: QueryResult = await queryEngine.run(prompt)

        // Finalize any remaining streaming text.
        commitStreamingText()

        // Persist assistant response to session storage (best-effort).
        if (fullResponseText) {
          try {
            sessionStorage.appendEntry({
              type: 'assistant',
              uuid: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
              sessionId: appState.sessionId,
              timestamp: Date.now(),
              content: fullResponseText,
              parentUuid: userMsgId,
            } as TranscriptEntry, appState.cwd)
          } catch { /* best-effort */ }
        }

        // Stop-reason annotation if non-standard.
        if (result.stopReason && result.stopReason !== 'end_turn') {
          addEntry({
            role: 'system',
            content: `[Stopped: ${result.stopReason}]`,
          })
        }

        // Error display.
        if (result.error) {
          addEntry({
            role: 'error',
            content: result.error.message,
            isError: true,
          })
        }

        // Update usage.
        const engineState = queryEngine.getState()
        setUsage({
          inputTokens: engineState.totalTokens.inputTokens,
          outputTokens: engineState.totalTokens.outputTokens,
          cacheCreationTokens: engineState.totalTokens.cacheCreationTokens,
          cacheReadTokens: engineState.totalTokens.cacheReadTokens,
          estimatedCostUsd: engineState.estimatedCostUsd,
          turnsCompleted: engineState.turnsCompleted,
        })
      } catch (err) {
        commitStreamingText()
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        addEntry({ role: 'error', content: msg, isError: true })
      } finally {
        // Stop the streaming text flush timer.
        if (streamTimerRef.current !== null) {
          clearInterval(streamTimerRef.current)
          streamTimerRef.current = null
        }

        // Clean up event listeners.
        queryEngine.off('text', onText)
        queryEngine.off('tool:use', onToolUse)
        queryEngine.off('tool:result', onToolResult)
        queryEngine.off('error', onError)

        setIsLoading(false)
        store.setLoading(false)
      }
    },
    [queryEngine, store, addEntry, commitStreamingText],
  )

  // ----------------------------------------------------------
  // Slash command handler — delegates to commands.ts registry
  // ----------------------------------------------------------

  const handleSlashCommand = useCallback(
    async (input: string): Promise<boolean> => {
      const trimmed = input.trim()

      // Build CommandContext from engine + store state.
      const engineState = queryEngine.getState()
      const appState = store.getState()
      const savedSessions = await sessionStorage.listSavedSessions(appState.cwd).catch(() => [])

      const commandContext: CommandContext = {
        queryEngine,
        appState: {
          ...appState,
          messages: engineState.messages,
          input: '',
          isLoading: engineState.status === 'running',
        },
        tools,
        cwd: appState.cwd,
        sessionId: appState.sessionId,
        model: engineState.model,
        memoryEnabled: false,
        savedSessions,
        setModel: (newModel: string) => {
          setCurrentModel(newModel)
        },
        sessionTokenUsage: engineState.totalTokens,
        sessionCostUsd: engineState.estimatedCostUsd,
      }

      // Dispatch through the unified command registry.
      const result = await executeCommand(trimmed, commandContext)

      // ── Handle special UI side effects ──────────────────────

      // Exit signal.
      if (result.exit) {
        if (result.text) addEntry({ role: 'system', content: result.text })
        exit()
        return true
      }

      // Clear messages signal (/clear).
      if (result.clearMessages) {
        queryEngine.reset()
        store.clearMessages()
        setDisplayEntries([])
        setError(null)
      }

      // Show text output.
      if (result.text) {
        addEntry({ role: 'system', content: result.text })
      }

      // Show error output.
      if (result.error) {
        addEntry({ role: 'error', content: result.error, isError: true })
      }

      // ── Special post-processing for /compact ──────────────
      const commandName = trimmed.replace(/^\/+/, '').split(/\s+/)[0]!.toLowerCase()

      if (commandName === 'compact' && !result.error) {
        const state = queryEngine.getState()
        if (state.messages.length >= 4) {
          const effectiveWindow = getEffectiveContextWindowSize(state.model)
          const targetTokens = Math.floor(effectiveWindow * 0.5)
          try {
            // Generate AI summary of messages that will be dropped.
            addEntry({ role: 'system', content: 'Generating conversation summary...' })

            const messagesToDrop = state.messages.slice(
              0,
              state.messages.length - Math.max(1, Math.floor(state.messages.length * 0.3)),
            )

            let aiSummary: string | null = null
            try {
              aiSummary = await generateCompactSummary(
                queryEngine.getProvider(),
                messagesToDrop,
              )
            } catch {
              // Fall back to heuristic summary if AI generation fails.
            }

            const { result: compactResult, keptMessages } = compactConversation(
              state.messages,
              {
                targetTokens,
                summary: aiSummary ?? undefined,
              },
            )
            queryEngine.reset()
            queryEngine.loadHistory(keptMessages)
            store.clearMessages()
            setDisplayEntries([])

            const summaryNote = aiSummary ? ' (AI-generated summary)' : ' (heuristic summary)'
            addEntry({
              role: 'system',
              content: `Compacted: removed ${compactResult.messagesRemoved}, kept ${compactResult.messagesKept}. ` +
                `Tokens: ${compactResult.tokenCountBefore} → ${compactResult.tokenCountAfter}${summaryNote}`,
            })
          } catch (err) {
            addEntry({
              role: 'error',
              content: `Compact failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            })
          }
        }
      }

      // ── Special post-processing for /help ─────────────────
      // Toggle the help overlay in addition to showing the command output.
      if (commandName === 'help' || commandName === '?') {
        setShowHelp(false) // Command output already shows help text
      }

      return true
    },
    [queryEngine, store, tools, exit, addEntry],
  )

  // ----------------------------------------------------------
  // Input submission
  // ----------------------------------------------------------

  const onSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed || isLoading) return

      setInputValue('')

      if (trimmed.startsWith('/')) {
        void handleSlashCommand(trimmed)
      } else {
        // Fire-and-forget; the async function manages its own state.
        void executeQuery(trimmed)
      }
    },
    [isLoading, handleSlashCommand, executeQuery],
  )

  // ----------------------------------------------------------
  // Keyboard shortcuts via useInput
  // ----------------------------------------------------------

  useInput((inputChar, key) => {
    // When an approval dialog is shown, capture y/n and ignore everything else.
    if (pendingApproval && approvalBridge) {
      if (inputChar.toLowerCase() === 'y') {
        approvalBridge.respond(true)
        addEntry({ role: 'system', content: `Approved: ${pendingApproval.toolName}` })
        return
      }
      if (inputChar.toLowerCase() === 'n' || (key.ctrl && inputChar.toLowerCase() === 'c')) {
        approvalBridge.respond(false)
        addEntry({ role: 'system', content: `Denied: ${pendingApproval.toolName}` })
        return
      }
      return // Ignore all other keys during approval
    }

    // Ctrl+C: abort current query, or exit if idle.
    if (key.ctrl && inputChar.toLowerCase() === 'c') {
      if (queryEngine.getState().status === 'running') {
        queryEngine.abort()
        addEntry({ role: 'system', content: 'Query aborted (Ctrl+C).' })
      } else {
        exit()
      }
      return
    }

    // Ctrl+D: exit immediately.
    if (key.ctrl && inputChar.toLowerCase() === 'd') {
      exit()
      return
    }
  })

  // ----------------------------------------------------------
  // Initial prompt execution (on mount)
  // ----------------------------------------------------------

  useEffect(() => {
    if (initialPrompt && !initialPromptHandled.current) {
      initialPromptHandled.current = true
      void executeQuery(initialPrompt)
    }
  }, [initialPrompt, executeQuery])

  // ----------------------------------------------------------
  // Synchronise engine state changes into local usage state
  // ----------------------------------------------------------

  useEffect(() => {
    const onState = () => {
      const engineState = queryEngine.getState()
      setUsage({
        inputTokens: engineState.totalTokens.inputTokens,
        outputTokens: engineState.totalTokens.outputTokens,
        cacheCreationTokens: engineState.totalTokens.cacheCreationTokens,
        cacheReadTokens: engineState.totalTokens.cacheReadTokens,
        estimatedCostUsd: engineState.estimatedCostUsd,
        turnsCompleted: engineState.turnsCompleted,
      })
    }

    queryEngine.on('state', onState)
    return () => {
      queryEngine.off('state', onState)
    }
  }, [queryEngine])

  // ----------------------------------------------------------
  // Approval bridge — show confirmation dialog for tool approvals
  // ----------------------------------------------------------

  useEffect(() => {
    if (!approvalBridge) return

    const onRequest = (info: PendingApproval) => {
      setPendingApproval(info)
    }
    const onResponded = () => {
      setPendingApproval(null)
    }

    approvalBridge.on('request', onRequest)
    approvalBridge.on('responded', onResponded)
    return () => {
      approvalBridge.off('request', onRequest)
      approvalBridge.off('responded', onResponded)
    }
  }, [approvalBridge])

  // ----------------------------------------------------------
  // Render: individual display entry
  // ----------------------------------------------------------

  const renderEntry = useCallback(
    (entry: DisplayEntry): React.ReactElement => {
      const color = ROLE_COLORS[entry.role]
      const label = ROLE_LABELS[entry.role]

      return (
        <Box key={entry.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color={color}>
              {label}
            </Text>
            {entry.toolName && (
              <Text dimColor> ({entry.toolName})</Text>
            )}
          </Box>
          <Box paddingLeft={2}>
            {entry.role === 'assistant' ? (
              // Assistant messages get full Markdown rendering (headings,
              // bold/italic, code blocks, lists, etc.) via marked-terminal.
              <MarkdownText>{entry.content}</MarkdownText>
            ) : (
              <Text
                color={entry.isError ? 'red' : color}
                wrap="wrap"
              >
                {entry.content}
              </Text>
            )}
          </Box>
        </Box>
      )
    },
    [],
  )

  // ----------------------------------------------------------
  // Render: status bar
  // ----------------------------------------------------------

  const statusBar = useMemo(() => {
    const tokens = `${usage.inputTokens} in / ${usage.outputTokens} out`
    const cost = `$${usage.estimatedCostUsd.toFixed(4)}`
    const turns = `${usage.turnsCompleted} turns`
    const model = currentModel

    return (
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>
          {model}
        </Text>
        <Text dimColor>
          {tokens} | {cost} | {turns}
        </Text>
      </Box>
    )
  }, [currentModel, usage])

  // ----------------------------------------------------------
  // Render: main layout
  // ----------------------------------------------------------

  return (
    <Box flexDirection="column" width="100%">
      {/* Scrollable message transcript */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {displayEntries.map(renderEntry)}

        {/* Live streaming assistant text */}
        {streamingText !== null && streamingText.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold color="white">
                Assistant
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <MarkdownText>{streamingText}</MarkdownText>
            </Box>
          </Box>
        )}

        {/* Help overlay */}
        {showHelp && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color="cyan">
              Help
            </Text>
            <Text color="white">{HELP_TEXT}</Text>
          </Box>
        )}

        {/* Error banner */}
        {error && !isLoading && (
          <Box
            borderStyle="round"
            borderColor="red"
            paddingX={1}
            marginBottom={1}
          >
            <Text color="red" bold>
              Error:{' '}
            </Text>
            <Text color="red">{error}</Text>
          </Box>
        )}

        {/* Loading indicator */}
        {isLoading && !pendingApproval && (
          <Box marginBottom={1}>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow">
              {streamingText !== null && streamingText.length > 0
                ? ' Generating...'
                : ' Thinking...'}
            </Text>
          </Box>
        )}

        {/* Approval dialog */}
        {pendingApproval && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="yellow"
            paddingX={1}
            paddingY={1}
            marginBottom={1}
          >
            <Text color="yellow" bold>
              Approval Required: {pendingApproval.toolName}
            </Text>
            <Text color="gray">
              {JSON.stringify(pendingApproval.input).slice(0, 300)}
            </Text>
            <Box marginTop={1}>
              <Text color="green" bold>[Y]</Text>
              <Text color="gray"> Approve  </Text>
              <Text color="red" bold>[N]</Text>
              <Text color="gray"> Deny</Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Input area */}
      <Box borderStyle="single" borderColor={pendingApproval ? 'yellow' : isLoading ? 'yellow' : 'green'} paddingX={1}>
        <Text color={pendingApproval ? 'yellow' : isLoading ? 'yellow' : 'green'} bold>
          {pendingApproval ? '  ' : isLoading ? '  ' : '> '}
        </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={onSubmit}
          placeholder={
            pendingApproval ? 'Press Y to approve or N to deny'
            : isLoading ? 'Processing...'
            : 'Type a message or /help'
          }
        />
      </Box>

      {/* Status bar */}
      {statusBar}
    </Box>
  )
}

// ============================================================
// Default export
// ============================================================

export default REPL
