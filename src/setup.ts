/**
 * Runtime Environment Setup
 *
 * Initializes the working directory, session memory, configuration directories,
 * project-level settings, file watchers, and git integration for a new agent
 * session.  Mirrors Claude Code's setup.ts architecture:
 *
 *  1. Resolve and validate the working directory.
 *  2. Bootstrap session-scoped memory (per-session markdown file).
 *  3. Ensure the global config tree exists (~/.cc-agent, skills, logs, etc.).
 *  4. Load project-level configuration from <cwd>/.cc-agent/settings.json.
 *  5. Start a chokidar watcher on the settings file for live reloads.
 *  6. Take an initial git worktree snapshot (placeholder for diff engine).
 *  7. Append `.cc-agent/` to the project's `.gitignore` if missing.
 *
 * Each step is wrapped in a try/catch so that a single failure does not
 * prevent the rest of the pipeline from completing.  Errors are logged as
 * warnings and the session continues with safe defaults.
 */

import { mkdir, readFile, writeFile, access, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'chokidar'

import type {
  MemoryConfig,
  PermissionMode,
} from './types/index.js'

// ============================================================
// Constants
// ============================================================

/** Top-level configuration directory name inside the user's home. */
export const CONFIG_DIR_NAME = '.cc-agent'

/** Sub-directories created under the global config root. */
const CONFIG_SUBDIRS = [
  'skills',
  'logs',
  'sessions',
  'agents',
  'hooks',
  'mcp',
] as const

/** Project-level settings file relative to the project root. */
const PROJECT_SETTINGS_PATH = join(CONFIG_DIR_NAME, 'settings.json')

/** Line appended to .gitignore to exclude the agent config directory. */
const GITIGNORE_ENTRY = '.cc-agent/'

/** Debounce interval (ms) for settings-file change notifications. */
const SETTINGS_WATCH_DEBOUNCE_MS = 300

// ============================================================
// Types
// ============================================================

/**
 * Options accepted by the top-level {@link setup} function.
 */
export interface SetupOptions {
  /**
   * Working directory for the session.  Will be resolved to an absolute path
   * and validated to exist.  Defaults to `process.cwd()`.
   */
  cwd?: string

  /**
   * Explicit session identifier.  When omitted a new UUID is generated.
   */
  sessionId?: string

  /**
   * Permission mode for the session (forwarded to downstream consumers).
   */
  permissionMode?: PermissionMode

  /**
   * Whether the session memory subsystem should be enabled.
   * @default true
   */
  enableMemory?: boolean

  /**
   * Override the default memory configuration.
   */
  memoryConfig?: Partial<MemoryConfig>

  /**
   * When `true`, settings-file changes are watched and hot-reloaded.
   * @default true
   */
  watchSettings?: boolean

  /**
   * When `true`, verbose diagnostic messages are emitted during setup.
   * @default false
   */
  verbose?: boolean
}

/**
 * The fully-initialized context returned by {@link setup}.  Every downstream
 * subsystem receives this object so it has access to the resolved working
 * directory, session ID, merged settings, and the settings watcher handle.
 */
export interface SetupContext {
  /** Resolved absolute path to the working directory. */
  cwd: string

  /** Unique session identifier (UUID). */
  sessionId: string

  /** Absolute path to the global config directory (~/.cc-agent). */
  configDir: string

  /** Merged project-level settings (empty object when no settings file exists). */
  settings: ProjectSettings

  /** Whether the session memory subsystem was successfully initialized. */
  memoryEnabled: boolean

  /** The active chokidar watcher for the project settings file, or `null`. */
  settingsWatcher: FSWatcher | null

  /** Path to the project-level settings file. */
  settingsFilePath: string

  /** Timestamp (epoch ms) when setup completed. */
  setupCompletedAt: number
}

/**
 * Shape of the project-level settings file (<cwd>/.cc-agent/settings.json).
 *
 * All fields are optional so the file can contain any subset.
 */
export interface ProjectSettings {
  /** Model override for this project (e.g. "claude-sonnet-4-20250514"). */
  model?: string

  /** Custom system prompt appended to the default. */
  systemPrompt?: string

  /** Permission mode override. */
  permissionMode?: PermissionMode

  /** Memory subsystem configuration. */
  memory?: Partial<MemoryConfig>

  /** MCP server configurations to auto-connect. */
  mcpServers?: Array<{
    name: string
    type: 'stdio' | 'sse' | 'ws' | 'http'
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
  }>

  /** Hook definitions for this project. */
  hooks?: Array<{
    event: string
    matcher?: string
    handler: string
  }>

  /** Allow additional keys for forward compatibility. */
  [key: string]: unknown
}

// ============================================================
// Logging Helpers
// ============================================================

function logVerbose(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(`[setup] ${message}`)
  }
}

function logWarning(step: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.warn(`[setup] Warning: ${step} failed — ${detail}. Continuing with defaults.`)
}

// ============================================================
// Step 1 — Set and Validate Working Directory
// ============================================================

/**
 * Resolve the given `cwd` to an absolute path and verify it points to an
 * existing directory.  Throws when the path does not exist or is not a
 * directory.
 *
 * This is a pure path-resolution helper that does not perform I/O.  Use
 * {@link validateCwd} for the async existence check.
 *
 * @param cwd — raw working directory (may be relative or `undefined`).
 * @returns Resolved absolute path.
 */
export function setCwd(cwd?: string): string {
  const candidate = cwd ? (isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)) : process.cwd()
  return resolve(candidate)
}

/**
 * Validate that the resolved path exists and is a directory.
 *
 * @param resolvedCwd — absolute path from {@link setCwd}.
 * @throws When the path does not exist or is not a directory.
 */
async function validateCwd(resolvedCwd: string): Promise<void> {
  try {
    const stats = await stat(resolvedCwd)
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedCwd}`)
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new Error(`Working directory does not exist: ${resolvedCwd}`)
    }
    throw err
  }
}

// ============================================================
// Step 2 — Initialize Session Memory
// ============================================================

/**
 * Initialize the session memory subsystem.
 *
 * Session memory maintains a per-session markdown file inside the project's
 * `.session-memory/` directory that is periodically rewritten as the
 * conversation progresses.
 *
 * @param sessionId  — unique session identifier.
 * @param cwd        — resolved working directory.
 * @param enabled    — whether memory is enabled.
 * @param config     — optional memory configuration overrides.
 * @returns `true` when memory was successfully initialized.
 */
export async function initSessionMemory(
  sessionId: string,
  cwd: string,
  enabled: boolean,
  config?: Partial<MemoryConfig>,
): Promise<boolean> {
  if (!enabled) {
    return false
  }

  const memoryBase = config?.memoryBase ?? join(cwd, '.session-memory')

  try {
    await mkdir(memoryBase, { recursive: true })

    // Write a stub MEMORY.md if it does not exist so downstream consumers
    // always have a file to read.
    const entrypointPath = join(memoryBase, 'MEMORY.md')
    try {
      await access(entrypointPath, fsConstants.F_OK)
    } catch {
      await writeFile(
        entrypointPath,
        `# Session Memory\n\n*Initialized for session ${sessionId}.*\n`,
        'utf-8',
      )
    }

    return true
  } catch {
    return false
  }
}

// ============================================================
// Step 3 — Ensure Config Directories
// ============================================================

/**
 * Create the global configuration directory tree under the user's home
 * directory.  The layout mirrors Claude Code's:
 *
 * ```
 * ~/.cc-agent/
 *   skills/
 *   logs/
 *   sessions/
 *   agents/
 *   hooks/
 *   mcp/
 * ```
 *
 * @returns Absolute path to the global config directory.
 */
export async function ensureConfigDirs(): Promise<string> {
  const configDir = join(homedir(), CONFIG_DIR_NAME)

  await mkdir(configDir, { recursive: true })

  for (const sub of CONFIG_SUBDIRS) {
    await mkdir(join(configDir, sub), { recursive: true })
  }

  return configDir
}

// ============================================================
// Step 4 — Load Project Config
// ============================================================

/**
 * Load project-level configuration from `<cwd>/.cc-agent/settings.json`.
 *
 * Returns an empty object when the file does not exist or cannot be parsed.
 * Malformed JSON triggers a warning but does not throw.
 *
 * @param cwd — resolved working directory.
 * @returns Parsed settings object.
 */
export async function loadProjectConfig(cwd: string): Promise<ProjectSettings> {
  const settingsPath = join(cwd, PROJECT_SETTINGS_PATH)

  try {
    const raw = await readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as ProjectSettings

    // Basic validation — settings must be a plain object.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[setup] Project settings at ${settingsPath} is not a JSON object. Using defaults.`)
      return {}
    }

    return parsed
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // No settings file — that is perfectly fine.
      return {}
    }
    logWarning('loadProjectConfig', err)
    return {}
  }
}

// ============================================================
// Step 5 — Settings File Watcher
// ============================================================

/**
 * Start a chokidar watcher on the project settings file so that changes
 * are hot-reloaded without restarting the session.
 *
 * The returned watcher emits `'change'` events that consumers can subscribe
 * to.  A debounce is applied so rapid edits (e.g. vim auto-save) only
 * trigger a single reload.
 *
 * @param cwd      — resolved working directory.
 * @param onChange — callback invoked with the new settings when the file changes.
 * @returns The chokidar `FSWatcher` instance, or `null` if watching is disabled.
 */
export function startSettingsWatcher(
  cwd: string,
  onChange: (settings: ProjectSettings) => void,
): FSWatcher | null {
  const settingsPath = join(cwd, PROJECT_SETTINGS_PATH)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const watcher = watch(settingsPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  })

  watcher.on('change', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null
      // Re-read the file asynchronously.
      readFile(settingsPath, 'utf-8')
        .then((raw) => {
          const parsed = JSON.parse(raw) as ProjectSettings
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            onChange(parsed)
          }
        })
        .catch((err) => {
          logWarning('settingsWatcher reload', err)
        })
    }, SETTINGS_WATCH_DEBOUNCE_MS)
  })

  watcher.on('error', (err) => {
    logWarning('settingsWatcher', err)
  })

  return watcher
}

// ============================================================
// Step 6 — Git Worktree Snapshot (Placeholder)
// ============================================================

/**
 * Take an initial snapshot of the git worktree state.
 *
 * This is a placeholder for the full diff engine integration.  The snapshot
 * captures the current HEAD ref and working-tree status so that later stages
 * can compute incremental diffs for context injection.
 *
 * Currently a no-op that returns immediately.  The full implementation will
 * shell out to `git diff HEAD` and cache the output.
 *
 * @param _cwd — resolved working directory (unused in placeholder).
 */
export async function initWorktreeSnapshot(_cwd: string): Promise<void> {
  // Placeholder — the full implementation will:
  //  1. Run `git rev-parse HEAD` to capture the current commit.
  //  2. Run `git diff --stat HEAD` to get a working-tree summary.
  //  3. Store the result in a session-scoped cache for later comparison.
  //
  // For now, this is intentionally a no-op so the setup pipeline exercises
  // the call site without depending on git being available.
}

// ============================================================
// Step 7 — Ensure .gitignore Entry
// ============================================================

/**
 * Ensure the project's `.gitignore` file contains the `.cc-agent/` entry so
 * that agent configuration and session data are not accidentally committed.
 *
 * - If `.gitignore` does not exist, it is created with the entry.
 * - If it exists but the entry is missing, the entry is appended.
 * - If the entry already exists, the file is left untouched.
 *
 * @param cwd — resolved working directory.
 */
export async function ensureGitIgnore(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore')

  let existing = ''
  try {
    existing = await readFile(gitignorePath, 'utf-8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logWarning('ensureGitIgnore read', err)
      return
    }
    // File does not exist — we will create it below.
  }

  // Check for the entry (with and without trailing slash).
  const lines = existing.split('\n')
  const hasEntry = lines.some(
    (line) => line.trim() === GITIGNORE_ENTRY || line.trim() === '.cc-agent',
  )

  if (hasEntry) {
    return
  }

  // Append the entry, ensuring a blank separator line when the file has
  // existing content that does not end with a newline.
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  const addition = `${separator}\n# AI Coding Agent configuration\n${GITIGNORE_ENTRY}\n`

  try {
    await writeFile(gitignorePath, existing + addition, 'utf-8')
  } catch (err) {
    logWarning('ensureGitIgnore write', err)
  }
}

// ============================================================
// Top-Level Setup Function
// ============================================================

/**
 * Run the full runtime environment setup sequence.
 *
 * Each step is executed in order.  Individual step failures are caught,
 * logged as warnings, and do not prevent subsequent steps from running.
 * The returned {@link SetupContext} contains safe defaults for any step
 * that failed.
 *
 * @param options — setup configuration options.
 * @returns Fully initialized setup context.
 */
export async function setup(options: SetupOptions = {}): Promise<SetupContext> {
  const {
    cwd: rawCwd,
    sessionId: explicitSessionId,
    enableMemory = true,
    memoryConfig,
    watchSettings = true,
    verbose = false,
  } = options

  const sessionId = explicitSessionId ?? randomUUID()

  // ── Step 1: Set and validate working directory ──────────────────────────
  let cwd: string
  try {
    cwd = setCwd(rawCwd)
    await validateCwd(cwd)
    logVerbose(verbose, `Working directory resolved to ${cwd}`)
  } catch (err) {
    // Working directory is critical — re-throw with a clearer message.
    throw new Error(
      `[setup] Failed to resolve working directory: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ── Step 2: Initialize session memory ───────────────────────────────────
  let memoryEnabled = false
  try {
    memoryEnabled = await initSessionMemory(sessionId, cwd, enableMemory, memoryConfig)
    logVerbose(verbose, `Session memory ${memoryEnabled ? 'enabled' : 'disabled'}`)
  } catch (err) {
    logWarning('initSessionMemory', err)
  }

  // ── Step 3: Ensure config directories ───────────────────────────────────
  let configDir: string
  try {
    configDir = await ensureConfigDirs()
    logVerbose(verbose, `Config directories ensured at ${configDir}`)
  } catch (err) {
    logWarning('ensureConfigDirs', err)
    configDir = join(homedir(), CONFIG_DIR_NAME)
  }

  // ── Step 4: Load project config ─────────────────────────────────────────
  let settings: ProjectSettings
  try {
    settings = await loadProjectConfig(cwd)
    logVerbose(verbose, `Project settings loaded (${Object.keys(settings).length} keys)`)
  } catch (err) {
    logWarning('loadProjectConfig', err)
    settings = {}
  }

  // ── Step 5: Start settings watcher ──────────────────────────────────────
  let settingsWatcher: FSWatcher | null = null
  const settingsFilePath = join(cwd, PROJECT_SETTINGS_PATH)

  if (watchSettings) {
    try {
      settingsWatcher = startSettingsWatcher(cwd, (newSettings) => {
        // Mutate the context's settings in-place so all references see the
        // update without needing to re-read the context.
        Object.keys(settings).forEach((k) => delete settings[k])
        Object.assign(settings, newSettings)
        logVerbose(verbose, 'Project settings hot-reloaded')
      })
      logVerbose(verbose, 'Settings file watcher started')
    } catch (err) {
      logWarning('startSettingsWatcher', err)
    }
  }

  // ── Step 6: Initialize git worktree snapshot ────────────────────────────
  try {
    await initWorktreeSnapshot(cwd)
    logVerbose(verbose, 'Git worktree snapshot initialized')
  } catch (err) {
    logWarning('initWorktreeSnapshot', err)
  }

  // ── Step 7: Ensure .gitignore entry ─────────────────────────────────────
  try {
    await ensureGitIgnore(cwd)
    logVerbose(verbose, '.gitignore entry ensured')
  } catch (err) {
    logWarning('ensureGitIgnore', err)
  }

  // ── Done ────────────────────────────────────────────────────────────────
  return {
    cwd,
    sessionId,
    configDir,
    settings,
    memoryEnabled,
    settingsWatcher,
    settingsFilePath,
    setupCompletedAt: Date.now(),
  }
}
