/**
 * Tests for the hook runner system.
 *
 * Tests the exported functions from src/services/hooks/hookRunner.ts:
 * - loadHooks: hook configuration loading from .cc-agent/ directory
 * - findMatchingHooks: glob pattern matching on tool names
 * - executeHook: hook handler execution via child_process
 * - runHooks: multiple hook execution and aggregation
 * - aggregateHookResults: decision aggregation across multiple hooks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadHooks,
  findMatchingHooks,
  executeHook,
  runHooks,
  aggregateHookResults,
} from '../src/services/hooks/hookRunner.js'
import type { HookDefinition, HookResult } from '../src/types/index.js'

// -- Helpers ------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hooks-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeHooksFile(hooks: unknown[], filename = 'hooks.json'): void {
  const dir = join(tempDir, '.cc-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), JSON.stringify(hooks))
}

function writeSettingsFile(settings: Record<string, unknown>): void {
  const dir = join(tempDir, '.cc-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
}

// -- loadHooks ----------------------------------------------------------------

describe('loadHooks', () => {
  it('returns empty array when no hooks are configured', async () => {
    const hooks = await loadHooks(tempDir)
    expect(hooks).toEqual([])
  })

  it('loads hooks from .cc-agent/hooks.json (array format)', async () => {
    writeHooksFile([
      { event: 'PreToolUse', matcher: 'Bash', handler: 'echo test' },
      { event: 'PostToolUse', handler: 'echo done' },
    ])

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(2)
    expect(hooks[0]!.event).toBe('PreToolUse')
    expect(hooks[0]!.matcher).toBe('Bash')
    expect(hooks[0]!.handler).toBe('echo test')
    expect(hooks[1]!.event).toBe('PostToolUse')
  })

  it('loads hooks from .cc-agent/hooks.json (object with hooks array)', async () => {
    writeHooksFile([]) // Create empty file first
    const dir = join(tempDir, '.cc-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: [
        { event: 'SessionStart', handler: 'echo started' },
      ],
    }))

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(1)
    expect(hooks[0]!.event).toBe('SessionStart')
  })

  it('falls back to .cc-agent/settings.json when hooks.json is absent', async () => {
    writeSettingsFile({
      hooks: [
        { event: 'SessionEnd', handler: 'echo goodbye' },
      ],
    })

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(1)
    expect(hooks[0]!.event).toBe('SessionEnd')
  })

  it('skips invalid hook entries silently', async () => {
    writeHooksFile([
      { event: 'PreToolUse', handler: 'echo valid' },
      null,
      { event: 'InvalidEvent', handler: 'echo bad' },
      { handler: 'no event' },
      { event: 'PostToolUse', handler: '' },
      { event: 'PostToolUse', handler: 'echo also valid' },
    ])

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(2)
    expect(hooks[0]!.handler).toBe('echo valid')
    expect(hooks[1]!.handler).toBe('echo also valid')
  })

  it('handles malformed JSON gracefully', async () => {
    const dir = join(tempDir, '.cc-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hooks.json'), '{ invalid json }}}')

    const hooks = await loadHooks(tempDir)
    expect(hooks).toEqual([])
  })

  it('accepts all four valid event types', async () => {
    writeHooksFile([
      { event: 'PreToolUse', handler: 'echo pre' },
      { event: 'PostToolUse', handler: 'echo post' },
      { event: 'SessionStart', handler: 'echo start' },
      { event: 'SessionEnd', handler: 'echo end' },
    ])

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(4)
    const events = hooks.map(h => h.event)
    expect(events).toContain('PreToolUse')
    expect(events).toContain('PostToolUse')
    expect(events).toContain('SessionStart')
    expect(events).toContain('SessionEnd')
  })

  it('hooks.json takes priority over settings.json', async () => {
    writeHooksFile([
      { event: 'PreToolUse', handler: 'echo from-hooks' },
    ])
    writeSettingsFile({
      hooks: [
        { event: 'PreToolUse', handler: 'echo from-settings' },
      ],
    })

    const hooks = await loadHooks(tempDir)
    expect(hooks.length).toBe(1)
    expect(hooks[0]!.handler).toBe('echo from-hooks')
  })
})

// -- findMatchingHooks --------------------------------------------------------

describe('findMatchingHooks', () => {
  const hooks: HookDefinition[] = [
    { event: 'PreToolUse', matcher: 'Bash', handler: 'pre-bash' },
    { event: 'PreToolUse', matcher: 'File*', handler: 'pre-file' },
    { event: 'PreToolUse', handler: 'pre-all' },
    { event: 'PostToolUse', matcher: 'Bash', handler: 'post-bash' },
    { event: 'SessionStart', handler: 'session-start' },
    { event: 'SessionEnd', handler: 'session-end' },
  ]

  it('matches hooks by exact event type', () => {
    const matches = findMatchingHooks(hooks, 'PreToolUse', 'Bash')
    expect(matches.length).toBe(2) // pre-bash (exact match) and pre-all (no matcher = all tools)
  })

  it('matches hooks with glob patterns using minimatch', () => {
    const matches = findMatchingHooks(hooks, 'PreToolUse', 'FileRead')
    // pre-file (File* matches FileRead) and pre-all (no matcher = all)
    expect(matches.length).toBe(2)
    expect(matches.map(m => m.handler)).toContain('pre-file')
    expect(matches.map(m => m.handler)).toContain('pre-all')
  })

  it('hooks without a matcher match all tool names', () => {
    const matches = findMatchingHooks(hooks, 'PreToolUse', 'WebSearch')
    // Only pre-all matches (no glob match for Bash or File*)
    expect(matches.length).toBe(1)
    expect(matches[0]!.handler).toBe('pre-all')
  })

  it('does not match hooks with different events', () => {
    const matches = findMatchingHooks(hooks, 'PostToolUse', 'Bash')
    expect(matches.length).toBe(1)
    expect(matches[0]!.handler).toBe('post-bash')
  })

  it('SessionStart hooks always match regardless of matcher', () => {
    const sessionHooks: HookDefinition[] = [
      { event: 'SessionStart', matcher: 'Bash', handler: 'start-with-matcher' },
      { event: 'SessionStart', handler: 'start-without-matcher' },
    ]
    const matches = findMatchingHooks(sessionHooks, 'SessionStart')
    expect(matches.length).toBe(2)
  })

  it('SessionEnd hooks always match regardless of matcher', () => {
    const matches = findMatchingHooks(hooks, 'SessionEnd')
    expect(matches.length).toBe(1)
    expect(matches[0]!.handler).toBe('session-end')
  })

  it('returns empty array when no hooks match', () => {
    const matches = findMatchingHooks(hooks, 'PostToolUse', 'WebSearch')
    expect(matches.length).toBe(0)
  })

  it('returns empty array for empty hooks array', () => {
    const matches = findMatchingHooks([], 'PreToolUse', 'Bash')
    expect(matches.length).toBe(0)
  })
})

// -- executeHook --------------------------------------------------------------

describe('executeHook', () => {
  it('executes a handler and parses JSON stdout', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32'
        ? 'echo {"decision":"allow","message":"ok"}'
        : "echo '{\"decision\":\"allow\",\"message\":\"ok\"}'",
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    expect(result.decision).toBe('allow')
    expect(result.message).toBe('ok')
  }, 15000)

  it('returns empty result when handler produces no output', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32' ? 'rem' : 'true',
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    // Empty result means "no opinion"
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  }, 15000)

  it('returns empty result when handler produces invalid JSON', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32'
        ? 'echo not json'
        : 'echo "not json"',
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    // Invalid JSON is treated as no-op
    expect(result).toBeDefined()
    expect(result.decision).toBeUndefined()
  }, 15000)

  it('returns empty result when handler fails to start', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: 'nonexistent_command_xyz_12345',
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    expect(result).toBeDefined()
    expect(result.decision).toBeUndefined()
  }, 15000)

  it('extracts modifiedInput from JSON output', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32'
        ? 'echo {"decision":"allow","modifiedInput":{"key":"value"}}'
        : "echo '{\"decision\":\"allow\",\"modifiedInput\":{\"key\":\"value\"}}'",
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash', input: { key: 'original' } },
      tempDir,
    )

    expect(result.modifiedInput).toEqual({ key: 'value' })
  }, 15000)

  it('parses "deny" decision correctly', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32'
        ? 'echo {"decision":"deny","message":"blocked"}'
        : "echo '{\"decision\":\"deny\",\"message\":\"blocked\"}'",
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    expect(result.decision).toBe('deny')
    expect(result.message).toBe('blocked')
  }, 15000)

  it('parses "ask" decision correctly', async () => {
    const hook: HookDefinition = {
      event: 'PreToolUse',
      handler: process.platform === 'win32'
        ? 'echo {"decision":"ask","message":"please confirm"}'
        : "echo '{\"decision\":\"ask\",\"message\":\"please confirm\"}'",
    }

    const result = await executeHook(
      hook,
      { event: 'PreToolUse', toolName: 'Bash' },
      tempDir,
    )

    expect(result.decision).toBe('ask')
  }, 15000)
})

// -- runHooks -----------------------------------------------------------------

describe('runHooks', () => {
  it('returns empty array when no hooks match', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', handler: 'echo post' },
    ]
    const results = await runHooks(hooks, 'PreToolUse', { toolName: 'Bash' }, tempDir)
    expect(results).toEqual([])
  })

  it('executes all matching hooks in order', async () => {
    const handler = process.platform === 'win32'
      ? 'echo {"decision":"allow"}'
      : "echo '{\"decision\":\"allow\"}'"

    const hooks: HookDefinition[] = [
      { event: 'PreToolUse', handler },
      { event: 'PreToolUse', handler },
    ]

    const results = await runHooks(hooks, 'PreToolUse', { toolName: 'Bash' }, tempDir)
    expect(results.length).toBe(2)
  }, 15000)

  it('catches errors from individual hooks without crashing', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PreToolUse', handler: 'nonexistent_cmd_xyz_99' },
    ]

    // Should not throw
    const results = await runHooks(hooks, 'PreToolUse', { toolName: 'Bash' }, tempDir)
    expect(results.length).toBe(1)
    expect(results[0]).toBeDefined()
  }, 15000)
})

// -- aggregateHookResults -----------------------------------------------------

describe('aggregateHookResults', () => {
  it('returns empty object for empty results array', () => {
    const result = aggregateHookResults([])
    expect(result).toEqual({})
  })

  it('returns allow when all hooks allow', () => {
    const results: HookResult[] = [
      { decision: 'allow' },
      { decision: 'allow' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.decision).toBe('allow')
  })

  it('returns deny when ANY hook denies (deny takes priority)', () => {
    const results: HookResult[] = [
      { decision: 'allow' },
      { decision: 'deny', message: 'Blocked!' },
      { decision: 'allow' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.decision).toBe('deny')
  })

  it('returns ask when no deny but at least one ask', () => {
    const results: HookResult[] = [
      { decision: 'allow' },
      { decision: 'ask', message: 'Please confirm' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.decision).toBe('ask')
  })

  it('deny takes priority over ask', () => {
    const results: HookResult[] = [
      { decision: 'ask', message: 'confirm?' },
      { decision: 'deny', message: 'blocked!' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.decision).toBe('deny')
  })

  it('concatenates messages from all hooks', () => {
    const results: HookResult[] = [
      { decision: 'allow', message: 'first' },
      { decision: 'allow', message: 'second' },
      { decision: 'allow', message: 'third' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.message).toContain('first')
    expect(aggregated.message).toContain('second')
    expect(aggregated.message).toContain('third')
  })

  it('uses the first modifiedInput found', () => {
    const results: HookResult[] = [
      { decision: 'allow', modifiedInput: { key: 'first' } },
      { decision: 'allow', modifiedInput: { key: 'second' } },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.modifiedInput).toEqual({ key: 'first' })
  })

  it('returns undefined message when no hooks provide messages', () => {
    const results: HookResult[] = [
      { decision: 'allow' },
    ]
    const aggregated = aggregateHookResults(results)
    expect(aggregated.message).toBeUndefined()
  })

  it('handles results with only empty objects', () => {
    const results: HookResult[] = [{}, {}, {}]
    const aggregated = aggregateHookResults(results)
    // With no decisions at all, result is 'allow'
    expect(aggregated.decision).toBe('allow')
  })
})
