/**
 * TodoReadTool - Read the current todo list.
 *
 * Semantics:
 *   - Reads the todo list stored in the context's appState (under `todos`).
 *   - Returns a formatted summary of all items.
 *   - No input parameters required.
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
import type { TodoItem } from '../TodoWriteTool/index.js'

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

// ─── Tool Definition ────────────────────────────────────────────────────────

const TodoReadTool = buildTool({
  name: 'TodoRead',

  description:
    'Read the current todo list. Returns a formatted summary of all tracked tasks ' +
    'including their content, status, and active form. Use this to review the current ' +
    'task state before updating with TodoWrite.',

  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: true,
  isReadOnly: true,
  isDestructive: false,

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    _input: Record<string, unknown>,
    _context?: PermissionContext,
  ): Promise<PermissionResult> {
    // Reading todos is always allowed — no side effects.
    return { behavior: 'allow' }
  },

  // ── Core execution ────────────────────────────────────────────────────────
  async call(
    _input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    _onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // ── Read from appState ────────────────────────────────────────────────
    const rawTodos = context.appState.todos

    if (!Array.isArray(rawTodos)) {
      return {
        content: 'Todo list is empty. Use TodoWrite to create one.',
      }
    }

    const todos = rawTodos as TodoItem[]
    return {
      content: formatTodoList(todos),
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'TodoRead',

  renderToolUseMessage(_input: Record<string, unknown>): string {
    return 'Read todo list'
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      return lines.slice(0, 8).join('\n')
    }
    return '(todo list read)'
  },
})

export default TodoReadTool
