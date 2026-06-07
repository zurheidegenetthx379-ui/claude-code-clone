/**
 * Command Guard configuration adapter.
 *
 * Translates high-level application settings and permission contexts into
 * low-level runtime configurations that govern filesystem access,
 * network rules, and platform-specific command guard behaviour.
 *
 * NOTE: This module provides heuristic pre-flight checks, NOT OS-level
 * sandboxing.  Shell commands can bypass pattern-based detection via
 * variables, scripts, or interpreters.  For true isolation, use containers
 * or OS-level sandboxing (e.g., Docker, Firejail, Seatbelt).
 */

import path from 'node:path';
import os from 'node:os';

// ─── Type Definitions ────────────────────────────────────────────────────────

/** A single filesystem rule inside the sandbox. */
export interface FilesystemRule {
  /** Absolute glob or directory path this rule applies to. */
  path: string;
  /** Whether writes to this path are permitted inside the sandbox. */
  allowWrite: boolean;
  /** Whether reads from this path are permitted inside the sandbox. */
  allowRead: boolean;
}

/** A single network rule inside the sandbox. */
export interface NetworkRule {
  /** Hostname or wildcard pattern (e.g. `*.github.com`). */
  host: string;
  /** Whether outbound connections to this host are allowed. */
  allow: boolean;
}

/** Fully-resolved runtime configuration consumed by the sandbox engine. */
export interface SandboxRuntimeConfig {
  /** Whether sandboxing should be active for this invocation. */
  enabled: boolean;
  /** Ordered list of filesystem access rules (first match wins). */
  filesystemRules: FilesystemRule[];
  /** Ordered list of network access rules (first match wins). */
  networkRules: NetworkRule[];
  /** Absolute path to the sandbox root (usually the project root). */
  rootPath: string;
  /** Absolute path to a writable temp directory inside the sandbox. */
  tempDir: string;
}

/** High-level sandbox settings persisted in user/project configuration. */
export interface SandboxSettings {
  /** Master toggle for sandboxing. */
  enabled: boolean;
  /** Platforms on which sandboxing should be active (e.g. `['linux', 'darwin']`). */
  enabledPlatforms: string[];
  /** Explicit filesystem allow/deny lists from the settings file. */
  filesystem?: {
    allowWrite?: string[];
    denyWrite?: string[];
    allowRead?: string[];
    denyRead?: string[];
  };
  /** Explicit network allow/deny lists from the settings file. */
  network?: {
    allow?: string[];
    deny?: string[];
  };
  /** Whether git bare-repo escape prevention should be enforced. */
  protectGitInternals?: boolean;
}

/** Runtime permission context derived from the active permission mode. */
export interface PermissionContext {
  /** The current working directory (project root). */
  cwd: string;
  /** Domains the agent is allowed to fetch via WebFetch. */
  allowedFetchDomains?: string[];
  /** Whether WebFetch is permitted at all. */
  webFetchEnabled?: boolean;
  /** Additional path-level permission overrides. */
  additionalPermissions?: {
    allowWrite?: string[];
    denyWrite?: string[];
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CC_AGENT_DIR = '.cc-agent';
const SKILLS_SUBDIR = 'skills';

/**
 * Git internal paths that must never be writable inside the sandbox.
 * Protecting these prevents a sandboxed process from corrupting or
 * weaponising the repository (e.g. via malicious hooks or ref manipulation).
 */
const GIT_PROTECTED_INTERNALS: readonly string[] = [
  'HEAD',
  'objects',
  'refs',
  'hooks',
  'config',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
];

// ─── Platform detection ──────────────────────────────────────────────────────

/**
 * Return `true` when the host OS matches one of the `enabledPlatforms`.
 * An empty list is treated as "all platforms enabled".
 */
function isPlatformSupported(enabledPlatforms: string[]): boolean {
  if (enabledPlatforms.length === 0) return true;
  const current = os.platform(); // 'linux' | 'darwin' | 'win32' | …
  return enabledPlatforms.includes(current);
}

// ─── Path normalisation ──────────────────────────────────────────────────────

/**
 * Normalise a rule path for consistent matching.
 *
 * - Absolute paths are returned as-is.
 * - Relative paths are resolved against `basePath`.
 */
function normalizeRulePath(p: string, basePath: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(basePath, p));
}

/**
 * The two path semantics the adapter must reconcile:
 *
 * 1. **Permission rules** (from {@link PermissionContext.additionalPermissions})
 *    are expressed relative to the project / working directory.
 * 2. **Sandbox filesystem settings** (from {@link SandboxSettings.filesystem})
 *    may contain absolute paths *or* paths relative to the user's home
 *    directory.
 *
 * Both are normalised to absolute paths before being merged into the final
 * rule set.
 */
function resolvePermissionPaths(
  paths: string[],
  basePath: string,
): string[] {
  return paths.map(p => normalizeRulePath(p, basePath));
}

function resolveSettingsPaths(
  paths: string[],
  _basePath: string,
): string[] {
  // Settings paths: absolute ones stay, relative ones resolve from home.
  return paths.map(p => {
    if (path.isAbsolute(p)) return path.normalize(p);
    return path.normalize(path.join(os.homedir(), p));
  });
}

// ─── Filesystem rule construction ────────────────────────────────────────────

/**
 * Build the complete, ordered list of {@link FilesystemRule}s:
 *
 * - `allowWrite` defaults: current directory (`.`) and the OS temp directory.
 * - `denyWrite` defaults: settings dir (`~/.cc-agent/skills/`) and project
 *   skills dir (`.cc-agent/skills/`).
 * - Git bare-repo escape prevention: deny writes to `.git/HEAD`,
 *   `.git/objects`, `.git/refs`, `.git/hooks`, `.git/config`, etc.
 * - User-configured allow/deny lists are layered on top.
 */
function buildFilesystemRules(
  cwd: string,
  settings: SandboxSettings,
  permissionContext: PermissionContext,
): FilesystemRule[] {
  const rules: FilesystemRule[] = [];
  const tempDir = os.tmpdir();

  // ── Default deny rules (evaluated first – deny takes priority) ──

  // Protect .cc-agent/skills directories (user + project)
  const protectedWritePaths: string[] = [
    path.join(os.homedir(), CC_AGENT_DIR, SKILLS_SUBDIR),
    path.join(cwd, CC_AGENT_DIR, SKILLS_SUBDIR),
  ];

  for (const p of protectedWritePaths) {
    rules.push({ path: p, allowWrite: false, allowRead: true });
  }

  // ── Git bare-repo escape prevention ──
  if (settings.protectGitInternals !== false) {
    const gitDir = path.join(cwd, '.git');
    for (const internal of GIT_PROTECTED_INTERNALS) {
      rules.push({
        path: path.join(gitDir, internal),
        allowWrite: false,
        allowRead: true,
      });
    }
  }

  // ── Settings-level deny-write overrides ──
  if (settings.filesystem?.denyWrite) {
    for (const p of resolveSettingsPaths(settings.filesystem.denyWrite, cwd)) {
      rules.push({ path: p, allowWrite: false, allowRead: true });
    }
  }

  // ── Settings-level deny-read overrides ──
  if (settings.filesystem?.denyRead) {
    for (const p of resolveSettingsPaths(settings.filesystem.denyRead, cwd)) {
      rules.push({ path: p, allowWrite: false, allowRead: false });
    }
  }

  // ── Permission-context deny-write (project-relative paths) ──
  if (permissionContext.additionalPermissions?.denyWrite) {
    for (const p of resolvePermissionPaths(
      permissionContext.additionalPermissions.denyWrite,
      cwd,
    )) {
      rules.push({ path: p, allowWrite: false, allowRead: true });
    }
  }

  // ── Default allow-write rules ──

  // Project root (relative `.` resolved to cwd)
  rules.push({ path: cwd, allowWrite: true, allowRead: true });

  // OS temp directory
  rules.push({ path: tempDir, allowWrite: true, allowRead: true });

  // ── Settings-level allow-write overrides ──
  if (settings.filesystem?.allowWrite) {
    for (const p of resolveSettingsPaths(
      settings.filesystem.allowWrite,
      cwd,
    )) {
      rules.push({ path: p, allowWrite: true, allowRead: true });
    }
  }

  // ── Settings-level allow-read overrides ──
  if (settings.filesystem?.allowRead) {
    for (const p of resolveSettingsPaths(
      settings.filesystem.allowRead,
      cwd,
    )) {
      rules.push({ path: p, allowWrite: false, allowRead: true });
    }
  }

  // ── Permission-context allow-write (project-relative paths) ──
  if (permissionContext.additionalPermissions?.allowWrite) {
    for (const p of resolvePermissionPaths(
      permissionContext.additionalPermissions.allowWrite,
      cwd,
    )) {
      rules.push({ path: p, allowWrite: true, allowRead: true });
    }
  }

  return rules;
}

// ─── Network rule construction ───────────────────────────────────────────────

/**
 * Derive network rules from the permission context's WebFetch settings.
 *
 * - If `webFetchEnabled` is explicitly `false`, all outbound traffic is
 *   denied.
 * - If `allowedFetchDomains` is provided, each domain becomes an allow rule
 *   with a default-deny fallback.
 * - Otherwise all traffic is allowed.
 */
function buildNetworkRules(
  settings: SandboxSettings,
  permissionContext: PermissionContext,
): NetworkRule[] {
  const rules: NetworkRule[] = [];

  // ── WebFetch-derived rules ──

  if (permissionContext.webFetchEnabled === false) {
    // WebFetch completely disabled – deny everything by default.
    rules.push({ host: '*', allow: false });
    return rules;
  }

  if (
    permissionContext.allowedFetchDomains &&
    permissionContext.allowedFetchDomains.length > 0
  ) {
    // Allowlist mode: specific domains only.
    for (const domain of permissionContext.allowedFetchDomains) {
      rules.push({ host: domain, allow: true });
    }
    // Implicit default-deny for unmatched hosts.
    rules.push({ host: '*', allow: false });
    return rules;
  }

  // ── Settings-level network rules ──

  if (settings.network?.allow) {
    for (const host of settings.network.allow) {
      rules.push({ host, allow: true });
    }
  }

  if (settings.network?.deny) {
    for (const host of settings.network.deny) {
      rules.push({ host, allow: false });
    }
  }

  // Default: allow all outbound traffic.
  if (rules.length === 0) {
    rules.push({ host: '*', allow: true });
  }

  return rules;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert high-level {@link SandboxSettings} and a {@link PermissionContext}
 * into a fully-resolved {@link SandboxRuntimeConfig} that the sandbox engine
 * can consume directly.
 *
 * The function reconciles two distinct path semantics:
 *
 * 1. **Permission-context paths** – always relative to the project cwd.
 * 2. **Settings paths** – may be absolute or relative to the user's home.
 *
 * Both are normalised to absolute paths in the resulting rule set.
 */
export function convertToSandboxRuntimeConfig(
  settings: SandboxSettings,
  permissionContext: PermissionContext,
): SandboxRuntimeConfig {
  const { cwd } = permissionContext;
  const enabled = isSandboxingEnabled(settings);

  if (!enabled) {
    return {
      enabled: false,
      filesystemRules: [],
      networkRules: [],
      rootPath: cwd,
      tempDir: os.tmpdir(),
    };
  }

  const filesystemRules = buildFilesystemRules(cwd, settings, permissionContext);
  const networkRules = buildNetworkRules(settings, permissionContext);

  return {
    enabled: true,
    filesystemRules,
    networkRules,
    rootPath: cwd,
    tempDir: os.tmpdir(),
  };
}

/**
 * Determine whether sandboxing should be active based on the platform,
 * the master enabled flag, and the `enabledPlatforms` allowlist.
 *
 * All three conditions must hold:
 * 1. `settings.enabled` is `true`.
 * 2. The current OS platform is listed in `enabledPlatforms` (or the list is
 *    empty, meaning "all platforms").
 */
export function isSandboxingEnabled(settings: SandboxSettings): boolean {
  if (!settings.enabled) return false;
  return isPlatformSupported(settings.enabledPlatforms);
}
