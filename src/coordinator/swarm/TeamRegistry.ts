/**
 * Team Registry -- manages swarm team state and member lifecycle.
 *
 * The TeamRegistry is the authoritative store for all team/swarm metadata
 * in the multi-agent coordinator system.  It tracks:
 *
 *  - Team creation and dissolution
 *  - Member registration, status, and heartbeats
 *  - Task assignment and lifecycle (pending -> in_progress -> completed/failed)
 *  - Persistence to `.cc-agent/teams/{teamName}.json`
 *
 * Design notes:
 *  - All mutations are synchronous (in-memory); persistence is explicit via
 *    `persistTeam()` so callers can batch writes.
 *  - Member heartbeats are updated by the agent loop on each turn; stale
 *    heartbeats (> 5 min) can be used to detect crashed agents.
 *  - The registry is process-local -- it is not shared across processes.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { TeamFile, TeamMember, AgentTask } from '../../types/index.js'

// ============================================================
// State Interfaces
// ============================================================

/**
 * Complete in-memory state for a single team.
 */
export interface TeamState {
  /** The team file metadata (name, description, lead, members). */
  team: TeamFile
  /** All tasks registered for this team. */
  tasks: AgentTask[]
  /** Live member states keyed by agentId. */
  activeMembers: Map<string, MemberState>
  /** Timestamp (ms) when the team was created. */
  createdAt: number
}

/**
 * Runtime state for a single team member.
 */
export interface MemberState {
  /** The member metadata from the team file. */
  member: TeamMember
  /** Current operational status. */
  status: 'idle' | 'working' | 'completed' | 'failed'
  /** ID of the task the member is currently working on (if any). */
  currentTaskId?: string
  /** Timestamp of the last heartbeat from this member. */
  lastHeartbeat: number
  /** The member's most recent result (set on completion). */
  result?: string
}

// ============================================================
// Team Registry
// ============================================================

export class TeamRegistry {
  /** All active teams keyed by team name. */
  private teams: Map<string, TeamState> = new Map()

  // ----------------------------------------------------------
  // Team lifecycle
  // ----------------------------------------------------------

  /**
   * Create a new team.
   *
   * The team name is the primary key; creating a team with a name that
   * already exists throws an error.
   *
   * @returns The newly created TeamFile.
   */
  createTeam(options: {
    name: string
    description: string
    leadAgentId: string
    leadSessionId: string
  }): TeamFile {
    if (this.teams.has(options.name)) {
      throw new Error(`Team "${options.name}" already exists.`)
    }

    const now = Date.now()
    const team: TeamFile = {
      name: options.name,
      description: options.description,
      createdAt: now,
      leadAgentId: options.leadAgentId,
      leadSessionId: options.leadSessionId,
      members: [],
    }

    const state: TeamState = {
      team,
      tasks: [],
      activeMembers: new Map(),
      createdAt: now,
    }

    this.teams.set(options.name, state)
    return { ...team }
  }

  // ----------------------------------------------------------
  // Member lifecycle
  // ----------------------------------------------------------

  /**
   * Add a member to an existing team.
   *
   * If `agentId` is not provided, a new UUID is generated automatically.
   * The member is registered in both the team file's member list and the
   * active members map with an initial `idle` status.
   *
   * @returns The complete TeamMember (with agentId).
   */
  addMember(
    teamName: string,
    member: Omit<TeamMember, 'agentId'> & { agentId?: string },
  ): TeamMember {
    const state = this.requireTeam(teamName)
    const agentId = member.agentId ?? randomUUID()

    const fullMember: TeamMember = {
      agentId,
      name: member.name,
      agentType: member.agentType,
      model: member.model,
      color: member.color,
    }

    // Add to team file
    state.team.members.push(fullMember)

    // Add to active members map
    state.activeMembers.set(agentId, {
      member: fullMember,
      status: 'idle',
      lastHeartbeat: Date.now(),
    })

    return { ...fullMember }
  }

  /**
   * Remove a member from a team.
   *
   * Removes the member from both the team file's member list and the
   * active members map.  Returns `true` if the member was found and
   * removed, `false` otherwise.
   */
  removeMember(teamName: string, agentId: string): boolean {
    const state = this.teams.get(teamName)
    if (!state) return false

    const idx = state.team.members.findIndex((m) => m.agentId === agentId)
    if (idx === -1) return false

    state.team.members.splice(idx, 1)
    state.activeMembers.delete(agentId)
    return true
  }

  /**
   * Update a member's operational status.
   *
   * Optionally attach a result string (typically set when transitioning
   * to `completed` or `failed`).
   */
  updateMemberStatus(
    teamName: string,
    agentId: string,
    status: MemberState['status'],
    result?: string,
  ): void {
    const state = this.requireTeam(teamName)
    const memberState = state.activeMembers.get(agentId)
    if (!memberState) {
      throw new Error(
        `Member "${agentId}" not found in team "${teamName}".`,
      )
    }

    memberState.status = status
    memberState.lastHeartbeat = Date.now()
    if (result !== undefined) {
      memberState.result = result
    }
  }

  // ----------------------------------------------------------
  // Team queries
  // ----------------------------------------------------------

  /**
   * Get the current state of a team, or `undefined` if not found.
   */
  getTeam(teamName: string): TeamState | undefined {
    return this.teams.get(teamName)
  }

  /**
   * List all active teams (returns shallow copies of the TeamFile).
   */
  listTeams(): TeamFile[] {
    return Array.from(this.teams.values()).map((s) => ({ ...s.team }))
  }

  // ----------------------------------------------------------
  // Task management
  // ----------------------------------------------------------

  /**
   * Add a task to the team's task list.
   *
   * A new UUID is generated for the task if one is not provided.
   *
   * @returns The complete AgentTask with an id.
   */
  addTask(teamName: string, task: Omit<AgentTask, 'id'>): AgentTask {
    const state = this.requireTeam(teamName)
    const fullTask: AgentTask = {
      id: randomUUID(),
      name: task.name,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      result: task.result,
    }

    state.tasks.push(fullTask)

    // If the task has an assignee, update their current task reference.
    if (fullTask.assignee) {
      const memberState = state.activeMembers.get(fullTask.assignee)
      if (memberState) {
        memberState.currentTaskId = fullTask.id
        memberState.status = 'working'
        memberState.lastHeartbeat = Date.now()
      }
    }

    return { ...fullTask }
  }

  /**
   * Update a task's status and optionally its result.
   *
   * When a task transitions to `completed` or `failed`, the assignee's
   * `currentTaskId` is cleared and their status is updated accordingly.
   */
  updateTask(
    teamName: string,
    taskId: string,
    status: AgentTask['status'],
    result?: string,
  ): void {
    const state = this.requireTeam(teamName)
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) {
      throw new Error(
        `Task "${taskId}" not found in team "${teamName}".`,
      )
    }

    task.status = status
    if (result !== undefined) {
      task.result = result
    }

    // Update the assignee's member state when the task reaches a terminal state.
    if (task.assignee) {
      const memberState = state.activeMembers.get(task.assignee)
      if (memberState && memberState.currentTaskId === taskId) {
        if (status === 'completed') {
          memberState.status = 'completed'
          memberState.currentTaskId = undefined
          memberState.lastHeartbeat = Date.now()
        } else if (status === 'failed') {
          memberState.status = 'failed'
          memberState.currentTaskId = undefined
          memberState.lastHeartbeat = Date.now()
        }
      }
    }
  }

  /**
   * Get all tasks for a team, optionally filtered by status.
   */
  getTasks(teamName: string, status?: AgentTask['status']): AgentTask[] {
    const state = this.requireTeam(teamName)
    if (status) {
      return state.tasks.filter((t) => t.status === status).map((t) => ({ ...t }))
    }
    return state.tasks.map((t) => ({ ...t }))
  }

  // ----------------------------------------------------------
  // Dissolution
  // ----------------------------------------------------------

  /**
   * Dissolve a team: remove all members, clear all tasks, and delete
   * the team from the registry.
   */
  dissolveTeam(teamName: string): void {
    const state = this.teams.get(teamName)
    if (!state) return

    state.team.members = []
    state.tasks = []
    state.activeMembers.clear()
    this.teams.delete(teamName)
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  /**
   * Persist team state to disk as a JSON file at
   * `.cc-agent/teams/{teamName}.json`.
   *
   * The active members map is serialized as a plain object (Maps are not
   * directly JSON-serializable).  Errors during I/O are swallowed
   * (best-effort persistence).
   */
  async persistTeam(teamName: string, projectDir: string): Promise<void> {
    const state = this.teams.get(teamName)
    if (!state) return

    const { mkdir, writeFile } = await import('node:fs/promises')

    const teamsDir = path.join(projectDir, '.cc-agent', 'teams')
    try {
      await mkdir(teamsDir, { recursive: true })
    } catch {
      // Directory creation is best-effort.
    }

    // Serialize the active members map to a plain object.
    const membersRecord: Record<string, MemberState> = {}
    for (const [agentId, memberState] of state.activeMembers) {
      membersRecord[agentId] = { ...memberState }
    }

    const serializable = {
      team: state.team,
      tasks: state.tasks,
      activeMembers: membersRecord,
      createdAt: state.createdAt,
    }

    const filePath = path.join(teamsDir, `${teamName}.json`)
    try {
      await writeFile(filePath, JSON.stringify(serializable, null, 2), 'utf-8')
    } catch {
      // Persistence is best-effort.
    }
  }

  /**
   * Load team state from disk.
   *
   * Reads `.cc-agent/teams/{teamName}.json` and reconstructs the
   * in-memory TeamState.  Returns `undefined` if the file does not
   * exist or cannot be parsed.
   */
  async loadTeam(
    teamName: string,
    projectDir: string,
  ): Promise<TeamState | undefined> {
    const { readFile } = await import('node:fs/promises')
    const filePath = path.join(
      projectDir,
      '.cc-agent',
      'teams',
      `${teamName}.json`,
    )

    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as {
        team: TeamFile
        tasks: AgentTask[]
        activeMembers: Record<string, MemberState>
        createdAt: number
      }

      // Reconstruct the active members Map from the plain object.
      const activeMembers = new Map<string, MemberState>()
      if (parsed.activeMembers) {
        for (const [agentId, memberState] of Object.entries(parsed.activeMembers)) {
          activeMembers.set(agentId, memberState)
        }
      }

      const state: TeamState = {
        team: parsed.team,
        tasks: parsed.tasks ?? [],
        activeMembers,
        createdAt: parsed.createdAt ?? Date.now(),
      }

      this.teams.set(teamName, state)
      return state
    } catch {
      // File does not exist or is invalid -- return undefined.
      return undefined
    }
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  /**
   * Retrieve a team state or throw if it does not exist.
   */
  private requireTeam(teamName: string): TeamState {
    const state = this.teams.get(teamName)
    if (!state) {
      throw new Error(`Team "${teamName}" does not exist.`)
    }
    return state
  }
}
