/**
 * Command Guard — pre-flight command validation and risk classification.
 *
 * Validates filesystem access, network rules, and environment sanitization
 * before a command is spawned, providing heuristic pre-flight checks.
 *
 * NOTE: This module provides heuristic pre-flight checks, NOT OS-level
 * sandboxing.  Shell commands can bypass pattern-based detection via
 * variables, scripts, or interpreters.  For true isolation, use containers
 * or OS-level sandboxing (e.g., Docker, Firejail, Seatbelt).
 */

import path from 'node:path'
import minimatch from 'minimatch'
import type {
  FilesystemRule,
  NetworkRule,
  SandboxRuntimeConfig,
} from './sandbox-adapter.js'

// ── Risk Level ────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

/**
 * Classify the risk level of a shell command based on its content.
 * Used by 'auto' sandbox mode to decide whether sandboxing is needed.
 *
 * Classification tiers:
 * - **critical**: Destructive system-level operations (rm -rf /, mkfs, dd if=,
 *   chmod 777 /, curl|sh, sudo, passwd, etc.)
 * - **high**: Writes outside cwd, network commands (curl, wget, nc, ssh, scp),
 *   git push --force, sensitive env manipulation
 * - **medium**: File write commands (cp, mv, tee, >, >>), package managers
 *   (npm, pip, cargo), compilers
 * - **low**: Read-only commands (ls, cat, head, tail, pwd, echo, which, grep,
 *   find, git status, git log)
 */
export function classifyCommandRisk(command: string): RiskLevel {
  const trimmed = command.trim()
  const lower = trimmed.toLowerCase()
  // Collapse runs of whitespace to a single space for consistent matching.
  const normalized = lower.replace(/\s+/g, ' ')

  // ── Critical patterns ─────────────────────────────────────────────────

  // rm -rf /  (and variants like rm -rf /*, rm -rf ~, rm -rf ~/*)
  if (/\brm\s+(-\w+\s+)*\/(\s|$|\*)/.test(normalized)) return 'critical'
  if (/\brm\s+(-\w+\s+)*(~|~\/)/.test(normalized)) return 'critical'

  // Destructive low-level operations
  if (/\bmkfs\b/.test(normalized)) return 'critical'
  if (/\bdd\s+.*\bif=/.test(normalized)) return 'critical'

  // chmod 777 on system directories
  if (/\bchmod\s+(\d*7\d*\d*|[rwx]+)\s+(\/|\/etc|\/usr|\/var|\/bin|\/sbin)(\s|$)/.test(normalized)) return 'critical'

  // Remote-code-execution via piped shell
  if (/\b(curl|wget)\b.*\|\s*(ba)?sh/.test(normalized)) return 'critical'
  if (/\b(curl|wget)\b.*\|\s*sudo/.test(normalized)) return 'critical'

  // Privilege escalation
  if (/\bsudo\b/.test(normalized)) return 'critical'
  if (/\bsu\s/.test(normalized)) return 'critical'
  if (/\bpasswd\b/.test(normalized)) return 'critical'

  // chown on system directories
  if (/\bchown\b.*\s(\/etc|\/usr|\/var|\/bin|\/sbin)(\s|$)/.test(normalized)) return 'critical'

  // ── High patterns ─────────────────────────────────────────────────────

  // Force push
  if (/\bgit\s+push\b.*--force/.test(normalized)) return 'high'
  if (/\bgit\s+push\b.*-f\b/.test(normalized)) return 'high'

  // Sensitive environment variable manipulation
  if (/\bexport\s+(aws_|github_token|ssh_|gpg_|home|secret|api_key|token|password)/.test(normalized)) return 'high'
  if (/\bunset\s+(home|path|ssh_|gpg_|aws_|github_token|secret)/.test(normalized)) return 'high'

  // Network commands
  if (/\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|sftp|ftp)\s/.test(normalized)) return 'high'

  // ── Medium patterns ───────────────────────────────────────────────────

  // File write commands
  if (/\b(cp|mv|tee)\s/.test(normalized)) return 'medium'
  if (/\brm\s/.test(normalized)) return 'medium'
  if (/>\s*\S/.test(normalized)) return 'medium'
  if (/>>\s*\S/.test(normalized)) return 'medium'
  if (/\bmkdir\s/.test(normalized)) return 'medium'
  if (/\bchmod\s/.test(normalized)) return 'medium'
  if (/\bchown\s/.test(normalized)) return 'medium'
  if (/\btouch\s/.test(normalized)) return 'medium'
  if (/\btruncate\s/.test(normalized)) return 'medium'

  // Package managers
  if (/\b(npm|yarn|pnpm|bun)\s/.test(normalized)) return 'medium'
  if (/\b(pip|pip3|pipenv|poetry)\s/.test(normalized)) return 'medium'
  if (/\b(cargo|go|rustc|make|cmake)\s/.test(normalized)) return 'medium'
  if (/\b(apt|apt-get|yum|dnf|pacman|brew)\s/.test(normalized)) return 'medium'
  if (/\b(gem|bundle|composer|nuget|dotnet)\s/.test(normalized)) return 'medium'

  // Compilers / interpreters that produce output files
  if (/\b(gcc|g\+\+|clang|tsc|javac|kotlinc|swiftc)\s/.test(normalized)) return 'medium'

  // ── Low patterns ──────────────────────────────────────────────────────

  return 'low'
}

// ── Sandbox Mode ────────────────────────────────────────────────────────────

/**
 * SandboxMode controls when sandboxing is applied:
 * - 'always': every command is sandboxed regardless of risk
 * - 'never': sandboxing is completely disabled
 * - 'auto': sandbox is applied based on classifyCommandRisk (medium+ gets sandboxed)
 */
export type SandboxMode = 'always' | 'never' | 'auto'

/**
 * Determine whether a command should be sandboxed given the current mode.
 *
 * - `'always'`: returns `true` for every command.
 * - `'never'`: returns `false` for every command.
 * - `'auto'`: returns `true` when {@link classifyCommandRisk} classifies the
 *   command as `'medium'`, `'high'`, or `'critical'`.
 */
export function shouldEnforceSandbox(command: string, mode: SandboxMode): boolean {
  switch (mode) {
    case 'always':
      return true
    case 'never':
      return false
    case 'auto': {
      const risk = classifyCommandRisk(command)
      return risk !== 'low'
    }
  }
}

// ── Filesystem Validation ────────────────────────────────────────────────

/**
 * Check whether `filePath` falls under a rule's path scope.
 *
 * Supports three matching strategies (in evaluation order):
 * 1. **Exact match** — the normalized paths are identical.
 * 2. **Prefix / descendant match** — `filePath` is a sub-path of `rulePath`.
 * 3. **Glob match** — `rulePath` contains glob meta-characters and is
 *    evaluated via `minimatch`.
 */
function pathMatchesRule(filePath: string, rulePath: string): boolean {
  const normalizedFile = path.normalize(filePath)
  const normalizedRule = path.normalize(rulePath)

  // 1. Exact match
  if (normalizedFile === normalizedRule) return true

  // 2. Descendant match — ensure boundary is on a separator to avoid
  //    false positives (e.g. /foo matching /foobar).
  const ruleWithSep = normalizedRule.endsWith(path.sep)
    ? normalizedRule
    : normalizedRule + path.sep

  if (normalizedFile.startsWith(ruleWithSep)) return true

  // 3. Glob match — minimatch handles both glob patterns and plain paths
  //    correctly, so we delegate all remaining cases to it.
  return minimatch(normalizedFile, normalizedRule)
}

/**
 * Check if a file path is permitted for reading/writing based on sandbox rules.
 * Uses first-match-wins semantics on the ordered rule list: the first rule
 * whose path scope covers `filePath` determines the outcome.
 *
 * When no rule matches, access is **denied** (fail-closed).
 */
export function validateFileAccess(
  filePath: string,
  rules: FilesystemRule[],
  accessType: 'read' | 'write',
): { allowed: boolean; matchedRule?: FilesystemRule } {
  const absPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(filePath)

  for (const rule of rules) {
    if (pathMatchesRule(absPath, rule.path)) {
      const allowed = accessType === 'read' ? rule.allowRead : rule.allowWrite
      return { allowed, matchedRule: rule }
    }
  }

  // No matching rule — deny by default (fail-closed).
  return { allowed: false }
}

/**
 * Best-effort extraction of file paths from a shell command string.
 *
 * Handles common patterns:
 *   - `cp src dst`, `mv src dst`, `rm file`
 *   - `cat file`, `head file`, `tail file`, `less file`
 *   - `echo > file`, `cmd >> file`
 *   - Flag arguments: `--file=path`, `-o path`
 *   - Quoted paths (single and double quotes are stripped)
 *
 * **NOT** a security boundary — this is a heuristic for pre-flight warnings.
 * A command can always access paths via mechanisms this function does not
 * detect (subshells, variable expansion, etc.).
 */
export function extractFilePaths(command: string): string[] {
  const paths: string[] = []
  const trimmed = command.trim()
  if (!trimmed) return paths

  // Strip inline comments (naive — doesn't handle # inside quotes)
  const withoutComments = trimmed.replace(/#.*$/, '').trim()

  // Helper: decide whether a token looks like a file path.
  const looksLikePath = (token: string): boolean => {
    if (!token || token.startsWith('-')) return false
    if (token.startsWith('$')) return false // variable expansion
    if (token.startsWith('{') || token.startsWith('(')) return false
    if (token === '|' || token === ';' || token === '&&' || token === '||') return false
    if (token === '>' || token === '>>' || token === '<' || token === '<<') return false
    if (/^https?:\/\//i.test(token)) return false
    if (/^\d+$/.test(token)) return false
    if (token.includes('=')) return false
    return (
      token.includes('/') ||
      token.includes('\\') ||
      token.includes('.') ||
      token.includes('~')
    )
  }

  // ── Extract redirect targets ──
  const redirectRe = />{1,2}\s*(['"]?)([^\s;|&'"]+)\1/g
  let redirectMatch: RegExpExecArray | null
  while ((redirectMatch = redirectRe.exec(withoutComments)) !== null) {
    paths.push(redirectMatch[2]!)
  }

  // ── Extract from specific command patterns ──
  // Remove redirects so they don't interfere with token parsing.
  const cleaned = withoutComments.replace(/>[\s]*['"]?[^\s;|&'"]+['"]?/g, '')

  // Split on shell operators, preserving each segment.
  const segments = cleaned.split(/\s*(?:&&|\|\||\||;)\s*/)

  for (const segment of segments) {
    const tokens = tokenizeShell(segment.trim())
    if (tokens.length === 0) continue

    const cmd = tokens[0]!.toLowerCase()

    // Two-operand commands: <cmd> [flags] <src> <dst>
    if (['cp', 'mv', 'ln', 'rsync', 'scp', 'diff', 'cmp'].includes(cmd)) {
      const args = tokens.slice(1).filter(t => !t.startsWith('-'))
      paths.push(...args)
      continue
    }

    // Single-or-multiple operand commands
    if (['rm', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat',
         'wc', 'touch', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp',
         'readlink', 'realpath', 'basename', 'dirname'].includes(cmd)) {
      const args = tokens.slice(1).filter(t => !t.startsWith('-'))
      paths.push(...args)
      continue
    }

    // Commands with flag-based paths
    if (cmd === 'tar') {
      for (let i = 1; i < tokens.length; i++) {
        if ((tokens[i] === '-f' || tokens[i] === '--file') && i + 1 < tokens.length) {
          paths.push(tokens[++i]!)
        } else if (tokens[i]!.startsWith('--file=')) {
          paths.push(tokens[i]!.split('=')[1]!)
        }
      }
      continue
    }

    if (cmd === 'find') {
      // find <path> [expression...]
      if (tokens.length > 1 && !tokens[1]!.startsWith('-')) {
        paths.push(tokens[1]!)
      }
      continue
    }

    if (cmd === 'grep' || cmd === 'rg' || cmd === 'ag') {
      // grep [options] pattern [files...]
      const nonFlagArgs = tokens.slice(1).filter(t => !t.startsWith('-'))
      // Skip first non-flag arg (the pattern)
      paths.push(...nonFlagArgs.slice(1))
      continue
    }

    if (['git', 'npm', 'yarn', 'pip', 'pip3', 'cargo', 'make',
         'docker', 'echo', 'pwd', 'which', 'where', 'ls', 'll',
         'export', 'unset', 'env'].includes(cmd)) {
      // Generally don't extract paths from these.
      continue
    }

    // ── Generic: collect path-like tokens ──
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!

      // --flag=value
      if (token.startsWith('--') && token.includes('=')) {
        const value = token.split('=').slice(1).join('=')
        if (value && looksLikePath(value)) {
          paths.push(value)
        }
        continue
      }

      // -o path  (common short-flag-with-argument pattern)
      if (token === '-o' && i + 1 < tokens.length) {
        paths.push(tokens[++i]!)
        continue
      }

      if (looksLikePath(token)) {
        paths.push(token)
      }
    }
  }

  // Clean up: strip quotes and glob suffixes
  return paths
    .map(p => p.replace(/^['"]|['"]$/g, ''))
    .filter(p => p.length > 0)
}

/**
 * Tokenize a shell command segment respecting single/double-quoted strings.
 * Backslash-escaped characters inside double quotes are preserved.
 */
function tokenizeShell(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\' && !inSingle) {
      escaped = true
      continue
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

/**
 * Validate all file paths in a command against the filesystem rules.
 *
 * For each extracted path, determines whether the access type (read or write)
 * is permitted.  Returns a list of violations (paths that would be denied).
 */
export function validateCommandPaths(
  command: string,
  rules: FilesystemRule[],
): { violations: Array<{ path: string; access: 'read' | 'write'; rule?: FilesystemRule }> } {
  const filePaths = extractFilePaths(command)
  const violations: Array<{ path: string; access: 'read' | 'write'; rule?: FilesystemRule }> = []

  // Heuristic: decide whether the command writes to a given path.
  const lowerCmd = command.trim().toLowerCase()
  const writeCommands = new Set([
    'cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp',
    'tee', 'truncate', 'ln', 'rsync', 'scp',
  ])
  const firstToken = lowerCmd.split(/\s+/)[0] ?? ''
  const isWriteCommand = writeCommands.has(firstToken)

  for (const filePath of filePaths) {
    // For cp/mv the last path is the destination (write); others are reads.
    // This is a simplification — for now treat all paths from write commands
    // as write access and all others as read access.
    const access = isWriteCommand ? 'write' : 'read'
    const result = validateFileAccess(filePath, rules, access)
    if (!result.allowed) {
      violations.push({ path: filePath, access, rule: result.matchedRule })
    }
  }

  return { violations }
}

// ── Network Validation ──────────────────────────────────────────────────

/**
 * Check if a network connection to a host is permitted.
 *
 * Rules are evaluated in order (first-match-wins).  Matching supports:
 * - Exact host comparison
 * - Wildcard patterns via `minimatch` (e.g. `*.github.com`)
 * - The universal wildcard `*` (matches everything)
 *
 * When no rule matches, access is **denied** (fail-closed).
 */
export function validateNetworkAccess(
  host: string,
  rules: NetworkRule[],
): { allowed: boolean; matchedRule?: NetworkRule } {
  const normalizedHost = host.toLowerCase().trim()

  for (const rule of rules) {
    // Universal wildcard
    if (rule.host === '*') {
      return { allowed: rule.allow, matchedRule: rule }
    }

    // Exact match
    if (rule.host.toLowerCase() === normalizedHost) {
      return { allowed: rule.allow, matchedRule: rule }
    }

    // Glob match (e.g. *.github.com)
    if (minimatch(normalizedHost, rule.host.toLowerCase())) {
      return { allowed: rule.allow, matchedRule: rule }
    }
  }

  // No matching rule — deny by default (fail-closed).
  return { allowed: false }
}

// ── Environment Sanitization ────────────────────────────────────────────

/**
 * Environment variables that must be stripped from sandboxed processes
 * to prevent git bare-repo escape and other attacks.
 *
 * Categories:
 * - **GIT_***: Prevents git bare-repo escape where a malicious repo sets
 *   GIT_DIR/GIT_WORK_TREE to redirect git operations outside the sandbox.
 * - **LD_PRELOAD / DYLD_INSERT_LIBRARIES**: Prevents dynamic linker injection
 *   of malicious shared libraries into the sandboxed process.
 * - **NODE_OPTIONS / PYTHONPATH / etc.**: Prevents interpreter-level code
 *   injection via auto-loaded modules or runtime flags.
 */
export const DANGEROUS_ENV_VARS: readonly string[] = [
  // Git bare-repo escape vectors
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  // Dynamic linker injection
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  // Path override
  'PATH_OVERRIDE',
  // Interpreter injection
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PERL5LIB',
  'RUBYLIB',
] as const

/**
 * Sanitize environment variables for a sandboxed process.
 *
 * 1. Removes all {@link DANGEROUS_ENV_VARS} entries.
 * 2. Optionally restricts `PATH` to a safe set of system directories
 *    (when `options.restrictPath` is `true`).
 *
 * Returns a new object — the original `env` is never mutated.
 */
export function sanitizeEnvironment(
  env: Record<string, string | undefined>,
  options?: { restrictPath?: boolean; allowedPaths?: string[] },
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  const dangerousSet = new Set(DANGEROUS_ENV_VARS)

  for (const [key, value] of Object.entries(env)) {
    // Strip dangerous env vars
    if (dangerousSet.has(key)) continue
    // Skip undefined values
    if (value === undefined) continue
    sanitized[key] = value
  }

  // Optionally restrict PATH to safe system directories
  if (options?.restrictPath) {
    const isWindows = process.platform === 'win32'
    const defaultSafePaths = isWindows
      ? [
          'C:\\Windows\\System32',
          'C:\\Windows',
          'C:\\Windows\\System32\\Wbem',
        ]
      : [
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/local/sbin',
          '/usr/sbin',
          '/sbin',
        ]

    const safePaths = options.allowedPaths ?? defaultSafePaths
    sanitized['PATH'] = safePaths.join(path.delimiter)
  }

  return sanitized
}

// ── Git Protection ───────────────────────────────────────────────────────

/**
 * Check if a command attempts to access or modify git internal paths.
 *
 * Examines extracted file paths and raw command text for references to
 * the `.git` directory's protected internals (HEAD, objects, refs, hooks,
 * config, packed-refs, FETCH_HEAD, ORIG_HEAD, MERGE_HEAD, rebase-merge,
 * rebase-apply).
 *
 * Returns the list of protected git paths the command would touch.
 */
export function detectGitInternalAccess(
  command: string,
  gitDir: string,
): { accessesInternals: boolean; touchedPaths: string[] } {
  const normalizedGitDir = path.normalize(gitDir)
  const filePaths = extractFilePaths(command)
  const touchedPaths: string[] = []

  // Protected sub-paths inside the git directory.
  const gitInternalNames = [
    'HEAD', 'objects', 'refs', 'hooks', 'config', 'packed-refs',
    'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD',
    'rebase-merge', 'rebase-apply',
  ]

  for (const filePath of filePaths) {
    const normalized = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(filePath)

    if (normalized.startsWith(normalizedGitDir + path.sep) || normalized === normalizedGitDir) {
      // Check if the path touches a protected internal.
      const relative = path.relative(normalizedGitDir, normalized)
      const topSegment = relative.split(path.sep)[0] ?? ''

      if (gitInternalNames.includes(topSegment)) {
        touchedPaths.push(normalized)
      }
    }
  }

  // Also scan the raw command text for .git/ internal path references.
  // This catches cases where the path is not extracted as a standalone token
  // (e.g. embedded in a string argument or a variable).
  const lower = command.toLowerCase()
  for (const internal of gitInternalNames) {
    // Match both forward-slash and backslash variants for cross-platform safety.
    const patterns = [
      `.git/${internal.toLowerCase()}`,
      `.git\\${internal.toLowerCase()}`,
    ]
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        const fullPath = path.join(normalizedGitDir, internal)
        if (!touchedPaths.includes(fullPath)) {
          touchedPaths.push(fullPath)
        }
      }
    }
  }

  return {
    accessesInternals: touchedPaths.length > 0,
    touchedPaths,
  }
}

// ── Full Pre-flight Check ────────────────────────────────────────────────

export interface SandboxCheckResult {
  /** Whether the command is allowed to proceed. */
  allowed: boolean
  /** Human-readable reasons for the decision. */
  reasons: string[]
  /** Sanitized environment variables to use for the spawn (when sandboxed). */
  sanitizedEnv?: Record<string, string>
  /** The risk level classification of the command. */
  riskLevel: RiskLevel
}

/**
 * Run all sandbox pre-flight checks on a command before spawning.
 * Combines filesystem, network, git, and environment sanitization checks.
 *
 * Returns a {@link SandboxCheckResult} with:
 * - `allowed: true` + `sanitizedEnv` — the command may proceed; use the
 *   sanitized env for `child_process.spawn`.
 * - `allowed: false` + `reasons` — the command must be blocked; display
 *   the reasons to the user.
 */
export function runSandboxChecks(
  command: string,
  config: SandboxRuntimeConfig,
): SandboxCheckResult {
  // When sandboxing is not enabled, allow everything.
  if (!config.enabled) {
    return {
      allowed: true,
      reasons: [],
      riskLevel: classifyCommandRisk(command),
    }
  }

  const reasons: string[] = []
  const riskLevel = classifyCommandRisk(command)

  // ── Block critical-risk commands outright ──
  if (riskLevel === 'critical') {
    reasons.push(
      'Command classified as critical risk and is blocked by the sandbox.',
    )
    return { allowed: false, reasons, riskLevel }
  }

  // ── Git internal access check ──
  const gitDir = path.join(config.rootPath, '.git')
  const gitCheck = detectGitInternalAccess(command, gitDir)
  if (gitCheck.accessesInternals) {
    reasons.push(
      `Command accesses protected git internals: ${gitCheck.touchedPaths.join(', ')}`,
    )
  }

  // ── Filesystem path validation ──
  const filePaths = extractFilePaths(command)
  const isWriteCmd = /^(cp|mv|rm|touch|mkdir|rmdir|chmod|chown|chgrp|tee|truncate|ln)\b/i.test(command.trim())

  for (const filePath of filePaths) {
    const accessType = isWriteCmd ? 'write' : 'read'
    const result = validateFileAccess(filePath, config.filesystemRules, accessType)
    if (!result.allowed) {
      reasons.push(
        `File access denied: ${filePath} (${accessType})` +
        (result.matchedRule ? ` — blocked by rule: ${result.matchedRule.path}` : ''),
      )
    }
  }

  // ── Network access validation ──
  const networkCommands = /\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|sftp|ftp)\s+([^\s-][^\s]*)/i
  const netMatch = networkCommands.exec(command)
  if (netMatch) {
    const host = netMatch[2]!.split(':')[0]!
    if (host && !host.startsWith('-') && !host.startsWith('/')) {
      const netResult = validateNetworkAccess(host, config.networkRules)
      if (!netResult.allowed) {
        reasons.push(`Network access denied: ${host}`)
      }
    }
  }

  // ── Environment sanitization (always applied when sandboxed) ──
  const sanitizedEnv = sanitizeEnvironment(process.env as Record<string, string | undefined>)

  return {
    allowed: reasons.length === 0,
    reasons,
    sanitizedEnv,
    riskLevel,
  }
}
