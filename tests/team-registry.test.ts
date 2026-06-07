import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { TeamRegistry } from '../src/coordinator/swarm/TeamRegistry.js'

describe('TeamRegistry', () => {
  let registry: TeamRegistry

  beforeEach(() => {
    registry = new TeamRegistry()
  })

  // ── createTeam ───────────────────────────────────────────────────────────

  describe('createTeam', () => {
    it('creates a team and returns the TeamFile', () => {
      const team = registry.createTeam({
        name: 'alpha',
        description: 'Alpha team',
        leadAgentId: 'lead-1',
        leadSessionId: 'session-1',
      })
      expect(team.name).toBe('alpha')
      expect(team.description).toBe('Alpha team')
      expect(team.leadAgentId).toBe('lead-1')
      expect(team.leadSessionId).toBe('session-1')
      expect(team.members).toEqual([])
      expect(typeof team.createdAt).toBe('number')
    })

    it('stores the team so it can be retrieved via getTeam', () => {
      registry.createTeam({
        name: 'alpha',
        description: 'Alpha team',
        leadAgentId: 'lead-1',
        leadSessionId: 'session-1',
      })
      const state = registry.getTeam('alpha')
      expect(state).toBeDefined()
      expect(state!.team.name).toBe('alpha')
    })

    it('throws an error when creating a team with a duplicate name', () => {
      registry.createTeam({
        name: 'alpha',
        description: 'First',
        leadAgentId: 'lead-1',
        leadSessionId: 'session-1',
      })
      expect(() =>
        registry.createTeam({
          name: 'alpha',
          description: 'Duplicate',
          leadAgentId: 'lead-2',
          leadSessionId: 'session-2',
        }),
      ).toThrow(/already exists/)
    })

    it('lists created teams via listTeams', () => {
      registry.createTeam({ name: 'a', description: '', leadAgentId: 'l1', leadSessionId: 's1' })
      registry.createTeam({ name: 'b', description: '', leadAgentId: 'l2', leadSessionId: 's2' })
      const teams = registry.listTeams()
      expect(teams).toHaveLength(2)
      expect(teams.map(t => t.name).sort()).toEqual(['a', 'b'])
    })
  })

  // ── addMember / removeMember ─────────────────────────────────────────────

  describe('addMember / removeMember', () => {
    it('adds a member to a team', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker 1',
        agentType: 'coder',
        model: 'gpt-4',
      })
      expect(member.name).toBe('Worker 1')
      expect(member.agentType).toBe('coder')
      expect(member.model).toBe('gpt-4')
      expect(typeof member.agentId).toBe('string')
      expect(member.agentId.length).toBeGreaterThan(0)
    })

    it('adds a member with a provided agentId', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        agentId: 'custom-id',
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      expect(member.agentId).toBe('custom-id')
    })

    it('registers member in the team members list and active members map', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const state = registry.getTeam('alpha')!
      expect(state.team.members).toHaveLength(1)
      expect(state.team.members[0]!.agentId).toBe(member.agentId)
      expect(state.activeMembers.has(member.agentId)).toBe(true)
      expect(state.activeMembers.get(member.agentId)!.status).toBe('idle')
    })

    it('removes a member and returns true', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const removed = registry.removeMember('alpha', member.agentId)
      expect(removed).toBe(true)

      const state = registry.getTeam('alpha')!
      expect(state.team.members).toHaveLength(0)
      expect(state.activeMembers.has(member.agentId)).toBe(false)
    })

    it('returns false when removing a non-existent member', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      expect(registry.removeMember('alpha', 'nonexistent')).toBe(false)
    })

    it('returns false when removing from a non-existent team', () => {
      expect(registry.removeMember('nonexistent', 'agent-1')).toBe(false)
    })

    it('throws when adding a member to a non-existent team', () => {
      expect(() =>
        registry.addMember('nonexistent', { name: 'W', agentType: 'coder', model: 'gpt-4' }),
      ).toThrow(/does not exist/)
    })
  })

  // ── addTask / updateTask / getTasks ──────────────────────────────────────

  describe('addTask / updateTask / getTasks', () => {
    it('adds a task to a team', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const task = registry.addTask('alpha', {
        name: 'Fix bug',
        description: 'Fix the login bug',
        status: 'pending',
      })
      expect(task.name).toBe('Fix bug')
      expect(task.description).toBe('Fix the login bug')
      expect(task.status).toBe('pending')
      expect(typeof task.id).toBe('string')
    })

    it('assigns a task to a member and updates their status to working', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const task = registry.addTask('alpha', {
        name: 'Fix bug',
        description: 'Fix it',
        status: 'pending',
        assignee: member.agentId,
      })
      const state = registry.getTeam('alpha')!
      const memberState = state.activeMembers.get(member.agentId)!
      expect(memberState.currentTaskId).toBe(task.id)
      expect(memberState.status).toBe('working')
    })

    it('updates task status and result', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const task = registry.addTask('alpha', {
        name: 'Fix bug',
        description: 'Fix it',
        status: 'pending',
      })
      registry.updateTask('alpha', task.id, 'completed', 'Bug fixed successfully')
      const tasks = registry.getTasks('alpha')
      const updated = tasks.find(t => t.id === task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.result).toBe('Bug fixed successfully')
    })

    it('clears assignee currentTaskId when task completes', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const task = registry.addTask('alpha', {
        name: 'Fix bug',
        description: '',
        status: 'pending',
        assignee: member.agentId,
      })
      registry.updateTask('alpha', task.id, 'completed')
      const state = registry.getTeam('alpha')!
      const memberState = state.activeMembers.get(member.agentId)!
      expect(memberState.status).toBe('completed')
      expect(memberState.currentTaskId).toBeUndefined()
    })

    it('sets member status to failed when task fails', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const task = registry.addTask('alpha', {
        name: 'Fix bug',
        description: '',
        status: 'pending',
        assignee: member.agentId,
      })
      registry.updateTask('alpha', task.id, 'failed', 'Out of memory')
      const state = registry.getTeam('alpha')!
      const memberState = state.activeMembers.get(member.agentId)!
      expect(memberState.status).toBe('failed')
      expect(memberState.currentTaskId).toBeUndefined()
    })

    it('throws when updating a non-existent task', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      expect(() => registry.updateTask('alpha', 'nonexistent', 'completed')).toThrow(/not found/)
    })

    it('filters tasks by status', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      registry.addTask('alpha', { name: 'T1', description: '', status: 'pending' })
      registry.addTask('alpha', { name: 'T2', description: '', status: 'in_progress' })
      registry.addTask('alpha', { name: 'T3', description: '', status: 'pending' })

      const pending = registry.getTasks('alpha', 'pending')
      expect(pending).toHaveLength(2)
      expect(pending.every(t => t.status === 'pending')).toBe(true)

      const inProgress = registry.getTasks('alpha', 'in_progress')
      expect(inProgress).toHaveLength(1)

      const all = registry.getTasks('alpha')
      expect(all).toHaveLength(3)
    })

    it('throws when adding a task to a non-existent team', () => {
      expect(() =>
        registry.addTask('nonexistent', { name: 'T', description: '', status: 'pending' }),
      ).toThrow(/does not exist/)
    })
  })

  // ── updateMemberStatus ───────────────────────────────────────────────────

  describe('updateMemberStatus', () => {
    it('updates member status from idle to working', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      registry.updateMemberStatus('alpha', member.agentId, 'working')
      const state = registry.getTeam('alpha')!
      expect(state.activeMembers.get(member.agentId)!.status).toBe('working')
    })

    it('updates member status to completed with a result', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      registry.updateMemberStatus('alpha', member.agentId, 'completed', 'All tests pass')
      const state = registry.getTeam('alpha')!
      const ms = state.activeMembers.get(member.agentId)!
      expect(ms.status).toBe('completed')
      expect(ms.result).toBe('All tests pass')
    })

    it('updates lastHeartbeat timestamp', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      const before = Date.now()
      registry.updateMemberStatus('alpha', member.agentId, 'working')
      const state = registry.getTeam('alpha')!
      const hb = state.activeMembers.get(member.agentId)!.lastHeartbeat
      expect(hb).toBeGreaterThanOrEqual(before)
    })

    it('throws for a non-existent member', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      expect(() =>
        registry.updateMemberStatus('alpha', 'nonexistent', 'working'),
      ).toThrow(/not found/)
    })

    it('throws for a non-existent team', () => {
      expect(() =>
        registry.updateMemberStatus('nonexistent', 'agent-1', 'working'),
      ).toThrow(/does not exist/)
    })
  })

  // ── dissolveTeam ─────────────────────────────────────────────────────────

  describe('dissolveTeam', () => {
    it('completely removes a team from the registry', () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'lead', leadSessionId: 's' })
      registry.addMember('alpha', { name: 'W', agentType: 'coder', model: 'gpt-4' })
      registry.addTask('alpha', { name: 'T', description: '', status: 'pending' })

      registry.dissolveTeam('alpha')

      expect(registry.getTeam('alpha')).toBeUndefined()
      expect(registry.listTeams()).toHaveLength(0)
    })

    it('does nothing when dissolving a non-existent team', () => {
      expect(() => registry.dissolveTeam('nonexistent')).not.toThrow()
    })

    it('allows creating a new team with the same name after dissolution', () => {
      registry.createTeam({ name: 'alpha', description: 'v1', leadAgentId: 'l', leadSessionId: 's' })
      registry.dissolveTeam('alpha')
      const team = registry.createTeam({ name: 'alpha', description: 'v2', leadAgentId: 'l', leadSessionId: 's' })
      expect(team.description).toBe('v2')
    })
  })

  // ── persistTeam / loadTeam ───────────────────────────────────────────────

  describe('persistTeam / loadTeam', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `team-registry-test-${randomUUID()}`)
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('persists and loads team data (round-trip)', async () => {
      registry.createTeam({ name: 'alpha', description: 'Test team', leadAgentId: 'lead', leadSessionId: 's' })
      const member = registry.addMember('alpha', {
        agentId: 'agent-1',
        name: 'Worker',
        agentType: 'coder',
        model: 'gpt-4',
      })
      registry.addTask('alpha', { name: 'Task 1', description: 'Do it', status: 'pending' })
      registry.updateMemberStatus('alpha', member.agentId, 'working')

      await registry.persistTeam('alpha', tmpDir)

      // Load into a fresh registry
      const newRegistry = new TeamRegistry()
      const loaded = await newRegistry.loadTeam('alpha', tmpDir)

      expect(loaded).toBeDefined()
      expect(loaded!.team.name).toBe('alpha')
      expect(loaded!.team.description).toBe('Test team')
      expect(loaded!.team.members).toHaveLength(1)
      expect(loaded!.team.members[0]!.agentId).toBe('agent-1')
      expect(loaded!.tasks).toHaveLength(1)
      expect(loaded!.tasks[0]!.name).toBe('Task 1')
      expect(loaded!.activeMembers.has('agent-1')).toBe(true)
      expect(loaded!.activeMembers.get('agent-1')!.status).toBe('working')
    })

    it('writes the file to the expected location', async () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'l', leadSessionId: 's' })
      await registry.persistTeam('alpha', tmpDir)

      const filePath = path.join(tmpDir, '.cc-agent', 'teams', 'alpha.json')
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.team.name).toBe('alpha')
    })

    it('returns undefined when loading a non-existent team', async () => {
      const result = await registry.loadTeam('nonexistent', tmpDir)
      expect(result).toBeUndefined()
    })

    it('loaded team is stored in the new registry and retrievable', async () => {
      registry.createTeam({ name: 'alpha', description: '', leadAgentId: 'l', leadSessionId: 's' })
      await registry.persistTeam('alpha', tmpDir)

      const newRegistry = new TeamRegistry()
      await newRegistry.loadTeam('alpha', tmpDir)
      expect(newRegistry.getTeam('alpha')).toBeDefined()
    })
  })
})
