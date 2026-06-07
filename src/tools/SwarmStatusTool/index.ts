/**
 * SwarmStatusTool — Query multi-agent team status and worker results.
 *
 * Available only when coordinator mode is active. Exposes:
 *   - Running/completed background agent tasks
 *   - Team member status (idle, working, completed, failed)
 *   - Pending and completed tasks
 *   - Unread mailbox messages from workers
 *
 * This tool is the coordinator's feedback loop — it polls the swarm
 * infrastructure to surface worker progress and results.
 */

import { buildTool } from '../../Tool.js'
import type {
  ToolResult,
  ToolUseContext,
  Message,
  CanUseTool,
  ToolProgressData,
} from '../../types/index.js'
import type { TeamRegistry } from '../../coordinator/swarm/TeamRegistry.js'
import type { FileMailbox } from '../../coordinator/swarm/FileMailbox.js'
import type { BackgroundTaskRegistry } from '../../coordinator/swarm/BackgroundTaskRegistry.js'

const SwarmStatusTool = buildTool({
  name: 'SwarmStatus',

  description:
    'Check the status of all agent workers, tasks, and unread messages. ' +
    'Use this to monitor background agent progress and retrieve their results.',

  inputSchema: {
    type: 'object',
    properties: {
      team_name: {
        type: 'string',
        description: 'Team name to query (default: "default").',
      },
    },
    additionalProperties: false,
  },

  isConcurrencySafe: true,
  isReadOnly: true,

  async checkPermissions(): Promise<{ behavior: 'allow' }> {
    return { behavior: 'allow' }
  },

  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    _onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    const teamName = (input.team_name as string) || 'default'

    const teamRegistry = context.appState['teamRegistry'] as TeamRegistry | undefined
    const fileMailbox = context.appState['fileMailbox'] as FileMailbox | undefined
    const bgTaskRegistry = context.appState['backgroundTaskRegistry'] as BackgroundTaskRegistry | undefined

    if (!teamRegistry && !bgTaskRegistry) {
      return {
        content: 'Multi-agent mode is not active. Set CLAUDE_CODE_COORDINATOR_MODE=1 to enable.',
        isError: true,
      }
    }

    const sections: string[] = []

    // ── Team members ─────────────────────────────────────────────────────
    if (teamRegistry) {
      try {
        const teamState = teamRegistry.getTeam(teamName)
        if (teamState) {
          const members = teamState.team.members
          const activeMembers = teamState.activeMembers
          if (members.length > 0) {
            const memberLines = members.map((m) => {
              const state = activeMembers.get(m.agentId)
              const status = state?.status ?? 'idle'
              return `  ${m.name} (${m.agentId}) — ${status}${m.agentType ? ` [${m.agentType}]` : ''}`
            })
            sections.push(`Team "${teamName}" (${members.length} members):\n${memberLines.join('\n')}`)
          } else {
            sections.push(`Team "${teamName}": no members yet.`)
          }

          // ── Tasks ───────────────────────────────────────────────────────
          const tasks = teamRegistry.getTasks(teamName)
          if (tasks && tasks.length > 0) {
            const taskLines = tasks.map((t) => {
              const assignee = t.assignee ? ` → ${t.assignee}` : ''
              const result = t.result ? `\n    Result: ${String(t.result).slice(0, 200)}` : ''
              return `  ${t.name} [${t.status}]${assignee}${result}`
            })
            sections.push(`Tasks (${tasks.length}):\n${taskLines.join('\n')}`)
          }
        } else {
          sections.push(`Team "${teamName}" not found.`)
        }
      } catch (err) {
        sections.push(`Team query error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── Background tasks ─────────────────────────────────────────────────
    if (bgTaskRegistry) {
      try {
        const allTasks = bgTaskRegistry.listTasks()
        if (allTasks.length > 0) {
          const bgLines = allTasks.map((t: any) => {
            const elapsed = t.startedAt
              ? `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s`
              : '?'
            return `  ${t.agentId} [${t.status}] — ${t.description ?? 'unknown'} (${elapsed})`
          })
          sections.push(`Background agents (${allTasks.length}):\n${bgLines.join('\n')}`)
        }
      } catch {
        // listTasks may not exist on older versions
      }
    }

    // ── Mailbox messages ─────────────────────────────────────────────────
    if (fileMailbox) {
      try {
        const leadSessionId = context.appState['sessionId'] as string | undefined
        if (leadSessionId) {
          const messages = await fileMailbox.receive(leadSessionId)
          if (messages && messages.length > 0) {
            const msgLines = messages.map((m: any) => {
              const preview = typeof m.payload === 'string'
                ? m.payload.slice(0, 200)
                : JSON.stringify(m.payload).slice(0, 200)
              return `  [${m.type}] from ${m.from}: ${preview}`
            })
            sections.push(`Unread messages (${messages.length}):\n${msgLines.join('\n')}`)
          }
        }
      } catch {
        // Mailbox read failure is non-fatal
      }
    }

    if (sections.length === 0) {
      return {
        content: 'No active agents, tasks, or messages.',
        isError: false,
      }
    }

    return {
      content: sections.join('\n\n'),
      isError: false,
    }
  },

  userFacingName: () => 'SwarmStatus',

  renderToolUseMessage(): string {
    return 'Checking swarm status...'
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      const lines = result.content.split('\n')
      if (lines.length <= 15) return result.content
      return lines.slice(0, 15).join('\n') + `\n... (${lines.length - 15} more lines)`
    }
    return '(swarm status available)'
  },
})

export default SwarmStatusTool
