import { resolve, relative, normalize } from 'node:path'
import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

/** Directories and files that are always off-limits. */
const PROTECTED_PATHS = [
  '.git',
  '.env',
  '.env.local',
  '.env.production',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  'credentials',
  '.npmrc',
  '.netrc',
]

export interface PathPolicyOptions {
  /** Working directory — all relative paths resolve against this. */
  cwd: string
  /** Additional allowed directories beyond cwd. */
  allowedDirs?: string[]
  /** If true, paths outside cwd are allowed (default: false). */
  allowOutsideCwd?: boolean
}

export interface PathCheckResult {
  allowed: boolean
  reason?: string
  resolvedPath: string
}

/**
 * Unified path boundary enforcement for all file-accessing tools.
 *
 * Rules:
 * 1. Resolve symlinks via realpath
 * 2. Must be within cwd or an explicitly allowed directory
 * 3. Protected paths (.git, .env, credentials, etc.) are always denied
 */
export async function checkPathAccess(
  inputPath: string,
  options: PathPolicyOptions,
): Promise<PathCheckResult> {
  const cwd = normalize(options.cwd)
  let resolved: string

  try {
    resolved = await realpath(resolve(cwd, inputPath))
  } catch {
    // File may not exist yet (e.g., FileWrite) — resolve without realpath
    resolved = resolve(cwd, inputPath)
  }

  // Check protected paths
  const relPath = relative(cwd, resolved)
  for (const protected_ of PROTECTED_PATHS) {
    if (relPath === protected_ || relPath.startsWith(protected_ + '/') || relPath.startsWith(protected_ + '\\')) {
      return { allowed: false, reason: `Access denied: "${protected_}" is a protected path`, resolvedPath: resolved }
    }
    // Also check absolute protected paths
    const absSegments = resolved.split(/[/\\]/)
    if (absSegments.includes(protected_)) {
      if (protected_ === '.env') {
        // Allow .env.example / .env.production.example but deny bare .env
        const hasBareEnv = absSegments.some(s => s === '.env')
        if (hasBareEnv) {
          return { allowed: false, reason: `Access denied: path contains protected file ".env"`, resolvedPath: resolved }
        }
        // Segment is a .env.* variant (e.g. .env.example) — allow
        continue
      }
      return { allowed: false, reason: `Access denied: path traverses protected directory "${protected_}"`, resolvedPath: resolved }
    }
  }

  // Check cwd boundary
  if (options.allowOutsideCwd) {
    return { allowed: true, resolvedPath: resolved }
  }

  const isWithinCwd = resolved === cwd || resolved.startsWith(cwd + '/') || resolved.startsWith(cwd + '\\')
  if (isWithinCwd) {
    return { allowed: true, resolvedPath: resolved }
  }

  // Check additional allowed dirs
  if (options.allowedDirs) {
    for (const dir of options.allowedDirs) {
      const normDir = normalize(resolve(dir))
      if (resolved === normDir || resolved.startsWith(normDir + '/') || resolved.startsWith(normDir + '\\')) {
        return { allowed: true, resolvedPath: resolved }
      }
    }
  }

  return { allowed: false, reason: `Path "${resolved}" is outside the allowed workspace "${cwd}"`, resolvedPath: resolved }
}

/**
 * Synchronous version for use in checkPermissions (which may not be async in all tools).
 * Uses realpathSync to resolve symlinks, falling back to path.resolve if the file doesn't exist.
 */
export function checkPathAccessSync(
  inputPath: string,
  options: PathPolicyOptions,
): PathCheckResult {
  const cwd = normalize(options.cwd)
  const raw = resolve(cwd, inputPath)

  // Resolve symlinks to prevent symlink-based cwd escape.
  let resolved: string
  try {
    resolved = realpathSync(raw)
  } catch {
    // File may not exist yet (e.g., write targets) — use unresolved path.
    resolved = raw
  }

  const relPath = relative(cwd, resolved)
  for (const protected_ of PROTECTED_PATHS) {
    if (relPath === protected_ || relPath.startsWith(protected_ + '/') || relPath.startsWith(protected_ + '\\')) {
      return { allowed: false, reason: `Access denied: "${protected_}" is a protected path`, resolvedPath: resolved }
    }
    // Also check absolute path segments for protected directories
    const absSegments = resolved.split(/[/\\]/)
    if (absSegments.includes(protected_)) {
      if (protected_ === '.env') {
        // Allow .env.example / .env.production.example but deny bare .env
        const hasBareEnv = absSegments.some(s => s === '.env')
        if (hasBareEnv) {
          return { allowed: false, reason: `Access denied: path contains protected file ".env"`, resolvedPath: resolved }
        }
        // Segment is a .env.* variant (e.g. .env.example) — allow
        continue
      }
      return { allowed: false, reason: `Access denied: path traverses protected directory "${protected_}"`, resolvedPath: resolved }
    }
  }

  if (options.allowOutsideCwd) {
    return { allowed: true, resolvedPath: resolved }
  }

  const isWithinCwd = resolved === cwd || resolved.startsWith(cwd + '/') || resolved.startsWith(cwd + '\\')
  if (isWithinCwd) {
    return { allowed: true, resolvedPath: resolved }
  }

  if (options.allowedDirs) {
    for (const dir of options.allowedDirs) {
      const normDir = normalize(resolve(dir))
      if (resolved === normDir || resolved.startsWith(normDir + '/') || resolved.startsWith(normDir + '\\')) {
        return { allowed: true, resolvedPath: resolved }
      }
    }
  }

  return { allowed: false, reason: `Path "${resolved}" is outside the allowed workspace "${cwd}"`, resolvedPath: resolved }
}
