import { describe, it, expect, afterEach } from 'vitest'
import {
  isCoordinatorMode,
  formatWorkerResult,
  formatPhaseTransition,
  formatTaskPlan,
  WORKFLOW_PHASES,
} from '../src/coordinator/coordinatorMode.js'

const ENV_VAR = 'CLAUDE_CODE_COORDINATOR_MODE'

// ── isCoordinatorMode ────────────────────────────────────────────────────────

describe('isCoordinatorMode', () => {
  afterEach(() => {
    delete process.env[ENV_VAR]
  })

  it('returns false when env var is not set', () => {
    delete process.env[ENV_VAR]
    expect(isCoordinatorMode()).toBe(false)
  })

  it('returns false when env var is empty string', () => {
    process.env[ENV_VAR] = ''
    expect(isCoordinatorMode()).toBe(false)
  })

  it('returns true when env var is "1"', () => {
    process.env[ENV_VAR] = '1'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('returns true when env var is "true"', () => {
    process.env[ENV_VAR] = 'true'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('returns true when env var is "yes"', () => {
    process.env[ENV_VAR] = 'yes'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('returns true when env var is "on"', () => {
    process.env[ENV_VAR] = 'on'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('is case-insensitive', () => {
    process.env[ENV_VAR] = 'TRUE'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('is case-insensitive for YES', () => {
    process.env[ENV_VAR] = 'YES'
    expect(isCoordinatorMode()).toBe(true)
  })

  it('returns false for unrecognized values like "no"', () => {
    process.env[ENV_VAR] = 'no'
    expect(isCoordinatorMode()).toBe(false)
  })

  it('returns false for "0"', () => {
    process.env[ENV_VAR] = '0'
    expect(isCoordinatorMode()).toBe(false)
  })

  it('returns false for "false"', () => {
    process.env[ENV_VAR] = 'false'
    expect(isCoordinatorMode()).toBe(false)
  })

  it('returns false for arbitrary strings', () => {
    process.env[ENV_VAR] = 'banana'
    expect(isCoordinatorMode()).toBe(false)
  })
})

// ── formatWorkerResult ───────────────────────────────────────────────────────

describe('formatWorkerResult', () => {
  it('formats a basic worker result as XML', () => {
    const result = formatWorkerResult('agent-123', 'completed', 'Fixed the bug')
    expect(result).toContain('<task-notification>')
    expect(result).toContain('</task-notification>')
    expect(result).toContain('<task-id>agent-123</task-id>')
    expect(result).toContain('<status>completed</status>')
    expect(result).toContain('<result>Fixed the bug</result>')
    expect(result).toContain('<summary>')
  })

  it('escapes XML special characters in the result', () => {
    const result = formatWorkerResult('agent-1', 'completed', 'Use <div> & "quotes"')
    expect(result).toContain('&lt;div&gt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&quot;quotes&quot;')
  })

  it('escapes XML special characters in the agent ID', () => {
    const result = formatWorkerResult('agent<1>', 'completed', 'done')
    expect(result).toContain('<task-id>agent&lt;1&gt;</task-id>')
  })

  it('includes all valid worker statuses', () => {
    const statuses = ['completed', 'failed', 'in_progress', 'cancelled', 'timeout'] as const
    for (const status of statuses) {
      const result = formatWorkerResult('agent', status, 'output')
      expect(result).toContain(`<status>${status}</status>`)
    }
  })

  it('generates a summary from the first line of the result', () => {
    const result = formatWorkerResult('agent', 'completed', 'First line\nSecond line')
    expect(result).toContain('<summary>First line</summary>')
  })

  it('truncates long summaries', () => {
    const longLine = 'A'.repeat(200)
    const result = formatWorkerResult('agent', 'completed', longLine)
    // Summary should be truncated to ~120 chars (then escaped, which doesn't change 'A')
    expect(result).toContain('...')
  })

  it('handles empty result string', () => {
    const result = formatWorkerResult('agent', 'completed', '')
    expect(result).toContain('<summary>No output</summary>')
    expect(result).toContain('<result></result>')
  })
})

// ── formatPhaseTransition ────────────────────────────────────────────────────

describe('formatPhaseTransition', () => {
  it('formats transition from one phase to another', () => {
    const result = formatPhaseTransition(WORKFLOW_PHASES.RESEARCH, WORKFLOW_PHASES.SYNTHESIS)
    expect(result).toContain('[Phase Transition: Research -> Synthesis]')
  })

  it('formats entering a phase from null (initial)', () => {
    const result = formatPhaseTransition(null, WORKFLOW_PHASES.RESEARCH)
    expect(result).toContain('[Entering Phase: Research]')
    expect(result).not.toContain('->')
  })

  it('includes reason when provided', () => {
    const result = formatPhaseTransition(
      WORKFLOW_PHASES.IMPLEMENTATION,
      WORKFLOW_PHASES.VERIFICATION,
      'All tasks completed',
    )
    expect(result).toContain('[Phase Transition: Implementation -> Verification]')
    expect(result).toContain('Reason: All tasks completed')
  })

  it('does not include reason line when reason is not provided', () => {
    const result = formatPhaseTransition(WORKFLOW_PHASES.RESEARCH, WORKFLOW_PHASES.SYNTHESIS)
    expect(result).not.toContain('Reason:')
  })

  it('formats all phase transitions correctly', () => {
    const phases = Object.values(WORKFLOW_PHASES)
    for (const from of phases) {
      for (const to of phases) {
        const result = formatPhaseTransition(from, to)
        expect(result).toContain(`[Phase Transition: ${from} -> ${to}]`)
      }
    }
  })
})

// ── formatTaskPlan ───────────────────────────────────────────────────────────

describe('formatTaskPlan', () => {
  it('formats a list of tasks', () => {
    const result = formatTaskPlan([
      { id: '1', description: 'Fix login bug', workerType: 'coder' },
      { id: '2', description: 'Update docs', workerType: 'writer' },
    ])
    expect(result).toContain('**Fix login bug**')
    expect(result).toContain('**Update docs**')
    expect(result).toContain('[coder]')
    expect(result).toContain('[writer]')
    expect(result).toContain('1.')
    expect(result).toContain('2.')
  })

  it('shows dependencies when present', () => {
    const result = formatTaskPlan([
      { id: '1', description: 'Research', workerType: 'researcher' },
      { id: '2', description: 'Implement', workerType: 'coder', dependencies: ['1'] },
    ])
    expect(result).toContain('(depends on: 1)')
  })

  it('shows multiple dependencies', () => {
    const result = formatTaskPlan([
      { id: '1', description: 'A', workerType: 'coder' },
      { id: '2', description: 'B', workerType: 'coder' },
      { id: '3', description: 'C', workerType: 'coder', dependencies: ['1', '2'] },
    ])
    expect(result).toContain('(depends on: 1, 2)')
  })

  it('does not show dependencies when there are none', () => {
    const result = formatTaskPlan([
      { id: '1', description: 'Solo task', workerType: 'coder' },
    ])
    expect(result).not.toContain('depends on')
  })

  it('does not show dependencies when dependencies array is empty', () => {
    const result = formatTaskPlan([
      { id: '1', description: 'Solo task', workerType: 'coder', dependencies: [] },
    ])
    expect(result).not.toContain('depends on')
  })

  it('returns header-only string for empty task list', () => {
    const result = formatTaskPlan([])
    expect(result).toBe('## Task Plan\n')
  })

  it('numbers tasks sequentially starting from 1', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: String(i + 1),
      description: `Task ${i + 1}`,
      workerType: 'coder',
    }))
    const result = formatTaskPlan(tasks)
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`${i}. **Task ${i}**`)
    }
  })
})
