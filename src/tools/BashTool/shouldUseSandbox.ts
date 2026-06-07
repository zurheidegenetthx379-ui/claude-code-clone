/**
 * Sandbox decision logic for the BashTool.
 *
 * Determines whether a given Bash invocation should execute inside the
 * platform sandbox.  The decision is based on three independent checks
 * evaluated in short-circuit order:
 *
 *   1. **Global availability** – is sandboxing supported and enabled on this
 *      platform with the current dependency set?
 *   2. **Per-call opt-out** – has the caller explicitly set
 *      `dangerouslyDisableSandbox` on this invocation?
 *   3. **Excluded commands** – does the command match a known-safe pattern
 *      that does not need sandboxing?  (Convenience only – NOT a security
 *      boundary.)
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

/** Input received from the LLM for a single BashTool call. */
export interface BashToolInput {
  /** The shell command to execute. */
  command: string;
  /**
   * Per-call opt-out flag.
   *
   * When `true`, the sandbox is bypassed regardless of global settings.
   * The intentionally long name discourages casual use.
   */
  dangerouslyDisableSandbox?: boolean;
}

/** Sandbox-relevant configuration available at tool-invocation time. */
export interface BashToolConfig {
  /** Whether the sandbox subsystem is globally available and enabled. */
  sandboxEnabled: boolean;
  /**
   * Command prefixes or exact strings that should skip sandboxing.
   *
   * IMPORTANT: This list is a convenience optimisation to avoid sandbox
   * overhead for trivially safe commands (e.g. `ls`, `pwd`, `echo`).
   * It is **not** a security boundary – an attacker who controls the
   * command string can trivially bypass prefix matching.
   */
  excludedCommands: string[];
  /**
   * Optional platform-specific check.  Returns `true` when the current
   * platform has all dependencies required to run the sandbox (e.g. the
   * `seatbelt` binary on macOS, `bubblewrap` on Linux).
   */
  isSandboxAvailable?: () => boolean;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Check whether the sandbox subsystem is usable on the current platform.
 *
 * When `config.isSandboxAvailable` is provided it is treated as the
 * authoritative answer (it typically probes for native binaries).
 * Otherwise we fall back to the boolean `config.sandboxEnabled` flag.
 */
function isGlobalSandboxAvailable(config: BashToolConfig): boolean {
  if (typeof config.isSandboxAvailable === 'function') {
    return config.isSandboxAvailable();
  }
  return config.sandboxEnabled;
}

/**
 * Determine whether `command` matches any entry in the excluded-commands
 * list.
 *
 * Matching rules (first match wins):
 * - **Exact match** after trimming and collapsing whitespace.
 * - **Prefix match** – the command starts with `<entry> ` or `<entry>\t`
 *   (i.e. the entry is a complete token, not a substring of a longer word).
 *
 * Examples (with `excludedCommands = ['ls', 'pwd']`):
 *   - `"ls -la"`          -> excluded  (prefix match on "ls")
 *   - `"ls"`              -> excluded  (exact match)
 *   - `"pwd"`             -> excluded  (exact match)
 *   - `"lsof -i :8080"`   -> NOT excluded (no word boundary after "ls")
 *   - `"pwdx 1234"`       -> NOT excluded (no word boundary after "pwd")
 */
function isCommandExcluded(
  command: string,
  excludedCommands: string[],
): boolean {
  if (excludedCommands.length === 0) return false;

  const trimmed = command.trim();
  if (!trimmed) return false;

  // Collapse internal whitespace for consistent matching.
  const normalized = trimmed.replace(/\s+/g, ' ');

  for (const excluded of excludedCommands) {
    const ex = excluded.trim();
    if (!ex) continue;

    // Exact match
    if (normalized === ex) return true;

    // Prefix match with word boundary (space or tab after the token)
    if (normalized.startsWith(ex + ' ') || normalized.startsWith(ex + '\t')) {
      return true;
    }
  }

  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Decide whether the given Bash invocation should run inside the sandbox.
 *
 * Evaluation order (short-circuit):
 *
 * 1. If global sandbox is not available/enabled -> `false`
 *    (no point wrapping in a sandbox that doesn't exist).
 *
 * 2. If the caller set `dangerouslyDisableSandbox: true` -> `false`
 *    (explicit per-call opt-out; the caller accepts the risk).
 *
 * 3. If the command matches an entry in `excludedCommands` -> `false`
 *    (convenience shortcut for trivially safe commands).
 *
 * 4. Otherwise -> `true` (sandbox the command).
 *
 * @returns `true` when the command should be executed inside the sandbox.
 */
export function shouldUseSandbox(
  input: BashToolInput,
  config: BashToolConfig,
): boolean {
  // 1. Global sandbox must be available.
  if (!isGlobalSandboxAvailable(config)) {
    return false;
  }

  // 2. Per-call opt-out (dangerous – caller accepts full responsibility).
  if (input.dangerouslyDisableSandbox === true) {
    return false;
  }

  // 3. Excluded command list (convenience, NOT a security boundary).
  if (isCommandExcluded(input.command, config.excludedCommands)) {
    return false;
  }

  // 4. Default: use the sandbox.
  return true;
}
