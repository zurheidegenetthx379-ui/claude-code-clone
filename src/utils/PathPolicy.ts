import { resolve, relative, normalize } from 'node:path'
import { realpath } from 'node:fs/promises'

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
      // Allow .env.example but not .env
      if (protected_ === '.env' && absSegments.some(s => s.startsWith('.env.'))) continue
      if (protected_ !== '.env') {
        return { allowed: false, reason: `Access denied: path traverses protected directory "${protected_}"`, resolvedPath: resolved }
      }
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
 * Uses path.resolve without realpath — less precise but faster.
 */
export function checkPathAccessSync(
  inputPath: string,
  options: PathPolicyOptions,
): PathCheckResult {
  const cwd = normalize(options.cwd)
  const resolved = resolve(cwd, inputPath)

  const relPath = relative(cwd, resolved)
  for (const protected_ of PROTECTED_PATHS) {
    if (relPath === protected_ || relPath.startsWith(protected_ + '/') || relPath.startsWith(protected_ + '\\')) {
      return { allowed: false, reason: `Access denied: "${protected_}" is a protected path`, resolvedPath: resolved }
    }
    // Also check absolute path segments for protected directories
    const absSegments = resolved.split(/[/\\]/)
    if (absSegments.includes(protected_)) {
      // Allow .env.example but not .env
      if (protected_ === '.env' && absSegments.some(s => s.startsWith('.env.'))) continue
      if (protected_ !== '.env') {
        return { allowed: false, reason: `Access denied: path traverses protected directory "${protected_}"`, resolvedPath: resolved }
      }
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
