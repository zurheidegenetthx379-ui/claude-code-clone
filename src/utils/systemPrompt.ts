/**
 * Priority-based system prompt assembly.
 *
 * Mirrors Claude Code's `systemPrompt.ts`: given a set of competing prompt
 * sources (override, coordinator, agent definition, user customisation,
 * and the built-in default), this module selects the winning prompt
 * according to a strict priority ladder and optionally appends a tail
 * fragment.
 *
 * Priority ladder (highest wins):
 *   0. `overrideSystemPrompt`   – full replacement (testing / harness use)
 *   1. `coordinatorSystemPrompt`– active when coordinator / swarm mode is on
 *   2. `agentSystemPrompt`      – from the current agent's definition file
 *   3. `customSystemPrompt`     – user-provided via CLI flag or config file
 *   4. `defaultSystemPrompt`    – from `getSystemPrompt()` (the standard path)
 *
 * Regardless of which source wins, `appendSystemPrompt` (if set) is
 * *always* concatenated to the end.
 */

import {
  getSystemPrompt,
  resolveSystemPromptSections,
  clearSystemPromptSections,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../constants/prompts.js'
import type { SystemPromptSection } from '../constants/prompts.js'
import type { ToolInstance, AgentDefinition } from '../types/index.js'

// ============================================================
// Types
// ============================================================

/**
 * A resolved system prompt ready for consumption by the API layer.
 *
 * `content`    – the full prompt string (joined from `sections`).
 * `sections`   – the individual section strings before joining; useful for
 *                callers that want to inject the sections into an array
 *                message format or apply their own cache boundaries.
 * `hasDynamicBoundary` – whether the dynamic-boundary sentinel was present
 *                in the raw section array (callers may use this to decide
 *                how much of the prompt to cache at the API level).
 */
export interface SystemPrompt {
  content: string
  sections: string[]
  hasDynamicBoundary: boolean
}

/**
 * A prompt source may be supplied as a plain string, a sync/async factory,
 * or a pre-resolved array of sections (matching the shape returned by
 * `resolveSystemPromptSections`).
 */
export type PromptSource =
  | string
  | (() => string | Promise<string>)
  | Array<SystemPromptSection | string>

/**
 * Options accepted by `buildEffectiveSystemPrompt`.
 *
 * Every field except `tools` is optional; the function gracefully degrades
 * when sources are omitted.
 */
export interface BuildPromptOptions {
  /** Tool instances available in the current session. */
  tools: ToolInstance[]

  /** Model identifier forwarded to `getSystemPrompt`. */
  model: string

  /**
   * Priority 0 – Complete override.
   * When set, this string replaces the entire system prompt (all other
   * sources except `appendSystemPrompt` are ignored).
   */
  overrideSystemPrompt?: PromptSource

  /**
   * Priority 1 – Coordinator / swarm-mode prompt.
   * Only considered when `isCoordinatorMode` is true.
   */
  coordinatorSystemPrompt?: PromptSource

  /** Whether coordinator mode is currently active. */
  isCoordinatorMode?: boolean

  /**
   * Priority 2 – Agent definition.
   * When an agent definition is supplied (or `agentDefinition` has a
   * `prompt` field), its prompt is used.
   */
  agentDefinition?: AgentDefinition

  /**
   * Priority 3 – User-provided custom prompt.
   * This REPLACES the default prompt (it does NOT merge with it).
   */
  customSystemPrompt?: PromptSource

  /**
   * Priority 4 – Explicit default prompt.
   * If omitted, the default is computed via `getSystemPrompt()`.
   */
  defaultSystemPrompt?: PromptSource

  /**
   * Tail fragment – ALWAYS appended to the winning prompt regardless of
   * which source was selected.
   */
  appendSystemPrompt?: string

  /** Extra directories to pass through to `getSystemPrompt`. */
  additionalDirs?: string[]

  /** Connected MCP clients to pass through to `getSystemPrompt`. */
  mcpClients?: Map<string, unknown>
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Resolve a `PromptSource` into a plain string.
 *
 * - `string` → returned as-is.
 * - `function` → called (may be async); result is awaited.
 * - `Array<SystemPromptSection | string>` → resolved through
 *   `resolveSystemPromptSections` and joined.
 */
async function resolvePromptSource(
  source: PromptSource | undefined,
): Promise<string | null> {
  if (source === undefined || source === null) {
    return null
  }

  if (typeof source === 'string') {
    return source
  }

  if (typeof source === 'function') {
    return await source()
  }

  if (Array.isArray(source)) {
    const resolved = await resolveSystemPromptSections(source)
    return resolved.join('\n\n')
  }

  // Unreachable in well-typed code; guard defensively.
  return null
}

/**
 * Build the default system prompt by delegating to `getSystemPrompt` and
 * resolving the resulting section array.
 *
 * Returns both the joined string and the individual sections so the caller
 * can inspect the boundary position.
 */
async function buildDefaultPrompt(
  options: BuildPromptOptions,
): Promise<{ content: string; sections: string[] }> {
  const rawSections = await getSystemPrompt(
    options.tools,
    options.model,
    options.additionalDirs,
    options.mcpClients,
  )

  const sections = await resolveSystemPromptSections(rawSections)
  const content = sections.join('\n\n')

  return { content, sections }
}

// ============================================================
// Public API
// ============================================================

/**
 * Assemble the effective system prompt according to the priority ladder.
 *
 * ```
 * Priority 0  overrideSystemPrompt        ← wins if present
 * Priority 1  coordinatorSystemPrompt     ← wins if coordinator mode is on
 * Priority 2  agentSystemPrompt           ← wins if agent definition has a prompt
 * Priority 3  customSystemPrompt          ← wins if user supplied one
 * Priority 4  defaultSystemPrompt         ← always available as fallback
 * ```
 *
 * After the winning source is resolved, `appendSystemPrompt` (if set) is
 * concatenated with a double-newline separator.
 *
 * @param options - Prompt sources and session context.
 * @returns The final assembled `SystemPrompt`.
 */
export async function buildEffectiveSystemPrompt(
  options: BuildPromptOptions,
): Promise<SystemPrompt> {
  let content: string
  let sections: string[]
  let hasDynamicBoundary = false

  // ---- Priority 0: full override ----
  const override = await resolvePromptSource(options.overrideSystemPrompt)
  if (override !== null) {
    content = override
    sections = [content]
    // Override is a plain string — no dynamic boundary.
  } else {
    // ---- Priority 1: coordinator prompt (only when coordinator mode is active) ----
    if (options.isCoordinatorMode) {
      const coordinator = await resolvePromptSource(options.coordinatorSystemPrompt)
      if (coordinator !== null) {
        content = coordinator
        sections = [content]
      } else {
        // Coordinator mode is on but no coordinator prompt supplied — fall through.
        ;({ content, sections } = await selectFromRemainingPriorities(options))
      }
    } else {
      ;({ content, sections } = await selectFromRemainingPriorities(options))
    }
  }

  // Detect whether the dynamic boundary sentinel is present in the sections.
  hasDynamicBoundary = sections.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  // ---- Append tail (always) ----
  if (options.appendSystemPrompt) {
    content = content + '\n\n' + options.appendSystemPrompt
    sections = [...sections, options.appendSystemPrompt]
  }

  return { content, sections, hasDynamicBoundary }
}

/**
 * Walk priorities 2 → 4 to find the winning prompt source.
 *
 * Extracted as a helper to keep `buildEffectiveSystemPrompt` readable.
 */
async function selectFromRemainingPriorities(
  options: BuildPromptOptions,
): Promise<{ content: string; sections: string[] }> {
  // ---- Priority 2: agent definition prompt ----
  if (options.agentDefinition?.prompt) {
    const agentPrompt = options.agentDefinition.prompt
    return { content: agentPrompt, sections: [agentPrompt] }
  }

  // ---- Priority 3: custom (user-provided) prompt ----
  const custom = await resolvePromptSource(options.customSystemPrompt)
  if (custom !== null) {
    return { content: custom, sections: [custom] }
  }

  // ---- Priority 4: explicit default OR computed default ----
  const explicitDefault = await resolvePromptSource(options.defaultSystemPrompt)
  if (explicitDefault !== null) {
    return { content: explicitDefault, sections: [explicitDefault] }
  }

  // Compute the default from `getSystemPrompt`.
  return await buildDefaultPrompt(options)
}

/**
 * Re-export `clearSystemPromptSections` as a convenience so callers that
 * use `buildEffectiveSystemPrompt` do not need to import from
 * `constants/prompts` directly when they want to invalidate the cache.
 */
export { clearSystemPromptSections }
