import { realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'
import {
  PathTraversalError,
  realpathDeepestExisting,
  sanitizePathKey,
  validatePathKey,
  validateWritePath,
} from './security.js'

/**
 * Whether team memory features are enabled.
 * Team memory is a subdirectory of auto memory, so it requires auto memory
 * to be enabled.
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)
}

/**
 * Returns the team memory path: <memoryBase>/projects/<sanitized-project-root>/memory/team/
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * Returns the team memory entrypoint: <memoryBase>/projects/<sanitized-project-root>/memory/team/MEMORY.md
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

/**
 * Check if a resolved absolute path is within the real team memory directory.
 * Uses path.resolve() to convert relative paths and eliminate traversal segments.
 * Does NOT resolve symlinks — for write validation use validateTeamMemWritePath().
 */
export function isTeamMemPath(filePath: string): boolean {
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * Validate that an absolute file path is safe for writing to the team memory directory.
 * Returns the resolved absolute path if valid.
 * Throws PathTraversalError if the path contains injection vectors or escapes via symlink.
 */
export async function validateTeamMemWritePath(
  filePath: string,
): Promise<string> {
  return validateWritePath(filePath, getTeamMemPath())
}

/**
 * Validate a relative path key from the server against the team memory directory.
 * Returns the resolved absolute path.
 * Throws PathTraversalError if the key is malicious.
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  return validatePathKey(relativeKey, getTeamMemPath())
}

/**
 * Check if a file path is within the team memory directory and team memory is enabled.
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}

// Re-export for callers that still import these directly
export { PathTraversalError }

/**
 * Check whether a real (symlink-resolved) path is within the real team
 * memory directory. Both sides are realpath'd so the comparison is between
 * canonical filesystem locations.
 */
export async function isRealPathWithinTeamDir(
  realCandidate: string,
): Promise<boolean> {
  let realTeamDir: string
  try {
    realTeamDir = await realpath(getTeamMemPath().replace(/[/\\]+$/, ''))
  } catch (e: unknown) {
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return true
    }
    return false
  }
  const { isRealPathWithinDir } = await import('./security.js')
  return isRealPathWithinDir(realCandidate, realTeamDir)
}
