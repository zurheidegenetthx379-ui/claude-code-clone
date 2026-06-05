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
import { compactConversation } from '../../services/compact/compact.js'
import { getEffectiveContextWindowSize } from '../../utils/context.js'

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
  const { queryEngine, tools, systemPrompt: _systemPrompt, store, initialPrompt } = props
  const { exit } = useApp()

  // ----------------------------------------------------------
  // Local state
  // ----------------------------------------------------------

  const [displayEntries, setDisplayEntries] = useState<DisplayEntry[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
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
  // Query execution
  // ----------------------------------------------------------

  const executeQuery = useCallback(
    async (prompt: string) => {
      setError(null)
      setIsLoading(true)
      store.setLoading(true)

      // Record user message in display.
      addEntry({ role: 'user', content: prompt })

      // Accumulate streamed text in a buffer so we can show a single
      // "assistant" entry when the response completes.
      let assistantTextBuffer = ''
      const toolEntries: Array<{
        type: 'tool_use' | 'tool_result'
        entry: Omit<DisplayEntry, 'id' | 'timestamp'>
      }> = []

      // Wire up event listeners for this query cycle.
      const onText = (chunk: string) => {
        assistantTextBuffer += chunk
      }

      const onToolUse = (toolUse: ToolUseBlock) => {
        const inputPreview = JSON.stringify(toolUse.input).slice(0, 200)
        toolEntries.push({
          type: 'tool_use',
          entry: {
            role: 'tool_use',
            content: `${toolUse.name}(${inputPreview})`,
            toolName: toolUse.name,
          },
        })
      }

      const onToolResult = (result: ToolResultBlock) => {
        const preview =
          typeof result.content === 'string'
            ? result.content.slice(0, 300)
            : '[complex result]'
        toolEntries.push({
          type: 'tool_result',
          entry: {
            role: 'tool_result',
            content: preview,
            isError: result.is_error,
          },
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

        // Flush accumulated entries into the display.
        // 1. Assistant text (if any).
        if (assistantTextBuffer.length > 0) {
          addEntry({ role: 'assistant', content: assistantTextBuffer })
        }

        // 2. Interleaved tool calls and results.
        for (const te of toolEntries) {
          addEntry(te.entry)
        }

        // 3. Stop-reason annotation if non-standard.
        if (result.stopReason && result.stopReason !== 'end_turn') {
          addEntry({
            role: 'system',
            content: `[Stopped: ${result.stopReason}]`,
          })
        }

        // 4. Error display.
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
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        addEntry({ role: 'error', content: msg, isError: true })
      } finally {
        // Clean up event listeners.
        queryEngine.off('text', onText)
        queryEngine.off('tool:use', onToolUse)
        queryEngine.off('tool:result', onToolResult)
        queryEngine.off('error', onError)

        setIsLoading(false)
        store.setLoading(false)
      }
    },
    [queryEngine, store, addEntry],
  )

  // ----------------------------------------------------------
  // Slash command handler
  // ----------------------------------------------------------

  const handleSlashCommand = useCallback(
    (input: string): boolean => {
      const [command, ...rest] = input.slice(1).split(/\s+/)
      const args = rest.join(' ')

      switch (command) {
        case 'help':
          setShowHelp(prev => !prev)
          return true

        case 'clear':
          queryEngine.reset()
          store.clearMessages()
          setDisplayEntries([])
          setError(null)
          addEntry({ role: 'system', content: 'Conversation cleared.' })
          return true

        case 'compact': {
          const state = queryEngine.getState()
          if (state.messages.length === 0) {
            addEntry({ role: 'system', content: 'No messages to compact.' })
            return true
          }
          addEntry({ role: 'system', content: 'Compacting conversation history...' })
          try {
            const model = state.model || 'claude-sonnet-4-20250514'
            const effectiveWindow = getEffectiveContextWindowSize(model)
            const targetTokens = Math.floor(effectiveWindow * 0.5)
            const { result, keptMessages } = compactConversation(
              state.messages,
              { targetTokens },
            )
            queryEngine.reset()
            queryEngine.loadHistory(keptMessages)
            store.clearMessages()
            setDisplayEntries([])
            addEntry({
              role: 'system',
              content: `Compacted: removed ${result.messagesRemoved}, kept ${result.messagesKept}. ` +
                `Tokens: ${result.tokenCountBefore} → ${result.tokenCountAfter}`,
            })
          } catch (err) {
            addEntry({
              role: 'error',
              content: `Compact failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            })
          }
          return true
        }

        case 'model':
          if (args) {
            setCurrentModel(args)
            addEntry({
              role: 'system',
              content: `Model switched to: ${args}`,
            })
          } else {
            addEntry({
              role: 'system',
              content: `Current model: ${currentModel}`,
            })
          }
          return true

        case 'exit':
        case 'quit':
        case 'q':
          exit()
          return true

        case 'tools': {
          const lines = tools.map(t => {
            const desc =
              typeof t.description === 'function'
                ? t.description()
                : t.description
            return `  - ${t.name}: ${desc.slice(0, 80)}`
          })
          addEntry({
            role: 'system',
            content: `Available tools (${tools.length}):\n${lines.join('\n')}`,
          })
          return true
        }

        case 'permissions':
          addEntry({
            role: 'system',
            content: `Permission mode: ${store.getState().permissionContext.permissionMode}`,
          })
          return true

        case 'abort':
          if (queryEngine.getState().status === 'running') {
            queryEngine.abort()
            addEntry({ role: 'system', content: 'Query aborted.' })
          } else {
            addEntry({
              role: 'system',
              content: 'No query in progress.',
            })
          }
          return true

        default:
          addEntry({
            role: 'error',
            content: `Unknown command: /${command}. Type /help for available commands.`,
            isError: true,
          })
          return true
      }
    },
    [queryEngine, store, tools, currentModel, exit, addEntry],
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
        handleSlashCommand(trimmed)
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
            <Text
              color={entry.isError ? 'red' : color}
              wrap="wrap"
            >
              {entry.content}
            </Text>
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
        {isLoading && (
          <Box marginBottom={1}>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow"> Thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input area */}
      <Box borderStyle="single" borderColor={isLoading ? 'yellow' : 'green'} paddingX={1}>
        <Text color={isLoading ? 'yellow' : 'green'} bold>
          {isLoading ? '  ' : '> '}
        </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={onSubmit}
          placeholder={isLoading ? 'Processing...' : 'Type a message or /help'}
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
