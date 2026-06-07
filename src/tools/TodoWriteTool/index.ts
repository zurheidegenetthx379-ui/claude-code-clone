/**
 * TodoWriteTool - Create and manage a structured task list.
 *
 * Semantics:
 *   - Accepts an array of todo items with content, status, and activeForm.
 *   - Stores them on the context's appState under the `todos` key.
 *   - Returns a formatted summary of the updated todo list.
 *
 * This tool enables the model to track multi-step tasks and display
 * progress to the user.
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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format the todo list into a human-readable summary.
 */
function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list is empty.'
  }

  const lines: string[] = []
  const completedCount = todos.filter(t => t.status === 'completed').length
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length
  const pendingCount = todos.filter(t => t.status === 'pending').length

  lines.push(`Todo list (${completedCount} completed, ${inProgressCount} in progress, ${pendingCount} pending):`)
  lines.push('')

  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i]!
    const statusIcon = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'
    const text = todo.status === 'in_progress' ? todo.activeForm : todo.content
    lines.push(`  ${statusIcon} ${i + 1}. ${text}`)
  }

  return lines.join('\n')
}

/**
 * Validate that an item has the required shape of a TodoItem.
 */
function isValidTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== 'object' || item === null) return false
  const obj = item as Record<string, unknown>
  return (
    typeof obj.content === 'string' &&
    typeof obj.activeForm === 'string' &&
    (obj.status === 'pending' || obj.status === 'in_progress' || obj.status === 'completed')
  )
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const TodoWriteTool = buildTool({
  name: 'TodoWrite',

  description:
    'Create or update a structured todo list for tracking multi-step tasks. ' +
    'Each item requires: content (description), status (pending/in_progress/completed), ' +
    'and activeForm (present-tense description shown while in progress). ' +
    'The full list replaces any previous todo list.',

  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list of todo items.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Description of the task.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the task.',
            },
            activeForm: {
              type: 'string',
              description: 'Present-tense description shown while the task is in progress (e.g. "Running tests").',
            },
          },
          required: ['content', 'status', 'activeForm'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: true,
  isReadOnly: false,
  isDestructive: false,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    _input: Record<string, unknown>,
    _context?: PermissionContext,
  ): Promise<PermissionResult> {
    // Todo management is always allowed — it only modifies in-memory state.
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
    // ── Validate inputs ───────────────────────────────────────────────────
    const rawTodos = input.todos
    if (!Array.isArray(rawTodos)) {
      return { content: 'Error: `todos` must be an array.', isError: true }
    }

    const todos: TodoItem[] = []
    for (let i = 0; i < rawTodos.length; i++) {
      const item = rawTodos[i]
      if (!isValidTodoItem(item)) {
        return {
          content: `Error: Item at index ${i} is not a valid todo. Required fields: content (string), status (pending|in_progress|completed), activeForm (string).`,
          isError: true,
        }
      }
      todos.push(item)
    }

    onProgress?.({ status: 'updating' })

    // ── Store on appState ─────────────────────────────────────────────────
    context.appState.todos = todos

    onProgress?.({ status: 'done', progress: 1 })

    return {
      content: formatTodoList(todos),
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'TodoWrite',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return `Update todo list (${todos.length} items)`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      return lines.slice(0, 8).join('\n')
    }
    return '(todo list updated)'
  },
})

export default TodoWriteTool
