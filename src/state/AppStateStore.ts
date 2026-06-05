/**
 * AppStateStore — centralised application state management.
 *
 * Mirrors Claude Code's AppStateStore architecture:
 *  - Observable store with subscribe/notify (observer pattern)
 *  - Immutable reads via shallow-copy snapshots
 *  - Domain-specific mutators for messages, tools, notifications, agents,
 *    and loading state
 *
 * The store is the single source of truth for the REPL UI layer.  React/Ink
 * components subscribe to changes and re-render when state transitions occur.
 */

import { randomUUID } from 'node:crypto'

import type {
  AppState,
  Message,
  ToolInstance,
  AgentIdentity,
  Notification,
} from '../types/index.js'

// ============================================================
// Public Interface
// ============================================================

export interface AppStateStore {
  /** Return an immutable snapshot of the current state. */
  getState(): AppState
  /** Merge a partial update into the state and notify subscribers. */
  setState(partial: Partial<AppState>): void
  /**
   * Register a listener that fires on every state transition.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: AppState) => void): () => void

  // Message operations
  addMessage(message: Message): void
  clearMessages(): void
  getMessages(): Message[]

  // Tool operations
  setTools(tools: ToolInstance[]): void
  getTools(): ToolInstance[]

  // Notification operations
  addNotification(notification: Omit<Notification, 'id' | 'timestamp'>): void
  clearNotifications(): void

  // Agent operations
  setCurrentAgent(agent: AgentIdentity | undefined): void
  getCurrentAgent(): AgentIdentity | undefined

  // Loading state
  setLoading(loading: boolean): void
  isLoading(): boolean
}

// ============================================================
// Default State
// ============================================================

function createDefaultAppState(): AppState {
  return {
    messages: [],
    input: '',
    isLoading: false,
    permissionContext: {
      permissionMode: 'default',
      allowList: [],
      denyList: [],
    },
    tools: [],
    mcpClients: new Map(),
    agents: [],
    currentAgent: undefined,
    sessionId: randomUUID(),
    cwd: process.cwd(),
    compacted: false,
    notifications: [],
  }
}

// ============================================================
// Implementation
// ============================================================

class AppStateStoreImpl implements AppStateStore {
  // ----------------------------------------------------------
  // Internal state
  // ----------------------------------------------------------

  private state: AppState
  private listeners: Set<(state: AppState) => void> = new Set()

  // ----------------------------------------------------------
  // Constructor
  // ----------------------------------------------------------

  constructor(initialState: Partial<AppState>) {
    this.state = {
      ...createDefaultAppState(),
      ...initialState,
    }
  }

  // ==========================================================
  // Core store operations
  // ==========================================================

  getState(): AppState {
    return this.snapshot()
  }

  setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    this.notify()
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ==========================================================
  // Message operations
  // ==========================================================

  /**
   * Append a message to the conversation transcript.
   *
   * The message is shallow-cloned to prevent external mutation of the
   * stored reference.
   */
  addMessage(message: Message): void {
    this.state = {
      ...this.state,
      messages: [...this.state.messages, { ...message }],
    }
    this.notify()
  }

  /**
   * Clear the entire conversation transcript.
   *
   * Used by `/clear` and `/compact` to reset the transcript without
   * recreating the store.
   */
  clearMessages(): void {
    this.state = {
      ...this.state,
      messages: [],
    }
    this.notify()
  }

  /**
   * Return a shallow copy of the messages array.
   *
   * Callers may iterate freely without risk of mutating the store.
   */
  getMessages(): Message[] {
    return [...this.state.messages]
  }

  // ==========================================================
  // Tool operations
  // ==========================================================

  /**
   * Replace the full set of available tools.
   *
   * Typically called once during runtime assembly, or when tools are
   * dynamically added/removed (e.g. MCP reconnection).
   */
  setTools(tools: ToolInstance[]): void {
    this.state = {
      ...this.state,
      tools: [...tools],
    }
    this.notify()
  }

  /**
   * Return the current tool list (shallow copy).
   */
  getTools(): ToolInstance[] {
    return [...this.state.tools]
  }

  // ==========================================================
  // Notification operations
  // ==========================================================

  /**
   * Push a notification onto the notification list.
   *
   * An `id` and `timestamp` are generated automatically.  Notifications
   * are displayed by the REPL status bar and can be dismissed via
   * `clearNotifications()`.
   */
  addNotification(
    notification: Omit<Notification, 'id' | 'timestamp'>,
  ): void {
    const full: Notification = {
      ...notification,
      id: randomUUID(),
      timestamp: Date.now(),
    }

    this.state = {
      ...this.state,
      notifications: [...this.state.notifications, full],
    }
    this.notify()
  }

  /**
   * Clear all notifications.
   */
  clearNotifications(): void {
    this.state = {
      ...this.state,
      notifications: [],
    }
    this.notify()
  }

  // ==========================================================
  // Agent operations
  // ==========================================================

  /**
   * Set or clear the currently active agent identity.
   *
   * When `undefined`, the REPL operates in "default" mode with no
   * agent-specific overrides.
   */
  setCurrentAgent(agent: AgentIdentity | undefined): void {
    this.state = {
      ...this.state,
      currentAgent: agent,
    }
    this.notify()
  }

  /**
   * Return the current agent identity, or `undefined` when no agent is
   * active.
   */
  getCurrentAgent(): AgentIdentity | undefined {
    return this.state.currentAgent
  }

  // ==========================================================
  // Loading state
  // ==========================================================

  /**
   * Toggle the global loading indicator.
   *
   * When `true`, the REPL displays a spinner and suppresses new user
   * input until the query completes.
   */
  setLoading(loading: boolean): void {
    // Avoid unnecessary notifications when the value has not changed.
    if (this.state.isLoading === loading) return

    this.state = {
      ...this.state,
      isLoading: loading,
    }
    this.notify()
  }

  /**
   * Return `true` when a query is in progress.
   */
  isLoading(): boolean {
    return this.state.isLoading
  }

  // ==========================================================
  // Private helpers
  // ==========================================================

  /**
   * Produce an immutable snapshot of the state.
   *
   * Top-level properties are spread into a new object; nested arrays and
   * maps are shallow-copied so that subscribers cannot mutate the store
   * by reference.
   */
  private snapshot(): AppState {
    return {
      ...this.state,
      messages: [...this.state.messages],
      tools: [...this.state.tools],
      agents: [...this.state.agents],
      notifications: [...this.state.notifications],
      mcpClients: new Map(this.state.mcpClients),
    }
  }

  /**
   * Notify every registered listener with a fresh snapshot.
   *
   * Errors thrown by individual listeners are caught and logged so that
   * one misbehaving subscriber cannot break the notification chain.
   */
  private notify(): void {
    const snap = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch (err) {
        console.error(
          '[AppStateStore] Listener error:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  }
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a new AppStateStore pre-populated with the given partial state.
 *
 * Any fields not supplied in `initialState` fall back to sensible defaults
 * (empty messages, no tools, loading = false, etc.).
 *
 * @example
 * ```ts
 * const store = createAppStateStore({
 *   sessionId: 'abc-123',
 *   cwd: '/home/user/project',
 *   permissionContext: { permissionMode: 'acceptEdits', allowList: [], denyList: [] },
 * })
 *
 * store.subscribe(state => console.log('State changed:', state.messages.length, 'messages'))
 * store.addMessage({ id: '1', uuid: '1', role: 'user', content: 'Hello', timestamp: Date.now() })
 * ```
 */
export function createAppStateStore(
  initialState: Partial<AppState>,
): AppStateStore {
  return new AppStateStoreImpl(initialState)
}
