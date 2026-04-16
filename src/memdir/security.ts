/**
 * Path security primitives for memory directories.
 *
 * Extracted from teamMemPaths.ts so all memory components (auto, team,
 * agent, global) share a single security boundary.
 *
 * Provides:
 * - PathTraversalError — typed rejection for malicious paths
 * - sanitizePathKey — validates relative path keys from remote sources
 * - realpathDeepestExisting — symlink-resolving ancestor walk
 * - validateWritePath — two-pass write path validation
 */

import { lstat, realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getErrnoCode } from '../utils/errors.js'

/**
 * Error thrown when a path validation detects a traversal or injection attempt.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * Sanitize a relative path key by rejecting dangerous patterns.
 * Checks for null bytes, URL-encoded traversals, and other injection vectors.
 * Returns the sanitized string or throws PathTraversalError.
 */
export function sanitizePathKey(key: string): string {
  // Null bytes can truncate paths in C-based syscalls
  if (key.includes('\0')) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`)
  }
  // URL-encoded traversals (e.g. %2e%2e%2f = ../)
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    // Malformed percent-encoding — not valid URL-encoding
    decoded = key
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`)
  }
  // Unicode normalization attacks: fullwidth ．．／ (U+FF0E U+FF0F) normalize
  // to ASCII ../ under NFKC.
  const normalized = key.normalize('NFKC')
  if (
    normalized !== key &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError(
      `Unicode-normalized traversal in path key: "${key}"`,
    )
  }
  // Reject backslashes (Windows path separator used as traversal vector)
  if (key.includes('\\')) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`)
  }
  // Reject absolute paths
  if (key.startsWith('/')) {
    throw new PathTraversalError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * Resolve symlinks for the deepest existing ancestor of a path.
 *
 * The target file may not exist yet (we may be about to create it), so we
 * walk up the directory tree until realpath() succeeds, then rejoin the
 * non-existing tail onto the resolved ancestor.
 *
 * SECURITY: path.resolve() does NOT resolve symlinks. An attacker who can
 * place a symlink inside teamDir pointing outside (e.g. to
 * ~/.ssh/authorized_keys) would pass a resolve()-based containment check.
 * Using realpath() on the deepest existing ancestor ensures we compare the
 * actual filesystem location.
 */
export async function realpathDeepestExisting(
  absolutePath: string,
): Promise<string> {
  const tail: string[] = []
  let current = absolutePath
  // Loop terminates when we reach the filesystem root (dirname('/') === '/').
  for (
    let parent = dirname(current);
    current !== parent;
    parent = dirname(current)
  ) {
    try {
      const realCurrent = await realpath(current)
      return tail.length === 0
        ? realCurrent
        : join(realCurrent, ...tail.reverse())
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // Could be truly non-existent OR a dangling symlink whose target
        // doesn't exist. lstat distinguishes.
        try {
          const st = await lstat(current)
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink detected (target does not exist): "${current}"`,
            )
          }
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr
          }
          // lstat also failed — safe to walk up.
        }
      } else if (code === 'ELOOP') {
        throw new PathTraversalError(
          `Symlink loop detected in path: "${current}"`,
        )
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        throw new PathTraversalError(
          `Cannot verify path containment (${code}): "${current}"`,
        )
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  return absolutePath
}

/**
 * Check whether a real (symlink-resolved) path is within the real
 * target directory. Both sides are realpath'd so the comparison is
 * between canonical filesystem locations.
 */
export async function isRealPathWithinDir(
  realCandidate: string,
  realTargetDir: string,
): Promise<boolean> {
  if (realCandidate === realTargetDir) {
    return true
  }
  // Prefix-attack protection: require separator after the prefix so that
  // "/foo/team-evil" doesn't match "/foo/team".
  return realCandidate.startsWith(realTargetDir + sep)
}

/**
 * Two-pass write path validation:
 * 1. String-level containment via resolve()
 * 2. Symlink resolution via realpathDeepestExisting
 *
 * Returns the resolved absolute path if valid.
 * Throws PathTraversalError if the path contains injection vectors,
 * escapes the directory via .. segments, or escapes via a symlink.
 */
export async function validateWritePath(
  filePath: string,
  targetDir: string,
): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`)
  }
  // First pass: normalize .. segments and check string-level containment.
  const resolvedPath = resolve(filePath)
  // targetDir already ends with sep from the caller
  if (!resolvedPath.startsWith(targetDir)) {
    throw new PathTraversalError(
      `Path escapes target directory: "${filePath}"`,
    )
  }
  // Second pass: resolve symlinks on the deepest existing ancestor.
  const realPath = await realpathDeepestExisting(resolvedPath)
  const realTargetDir = await realpath(targetDir.replace(/[/\\]+$/, ''))
  if (!(await isRealPathWithinDir(realPath, realTargetDir))) {
    throw new PathTraversalError(
      `Path escapes target directory via symlink: "${filePath}"`,
    )
  }
  return resolvedPath
}

/**
 * Validate a relative path key from a remote source against a target directory.
 * Sanitizes the key, joins with the target dir, resolves symlinks, and
 * verifies containment. Returns the resolved absolute path.
 */
export async function validatePathKey(
  relativeKey: string,
  targetDir: string,
): Promise<string> {
  sanitizePathKey(relativeKey)
  const fullPath = join(targetDir, relativeKey)
  // First pass: normalize .. segments and check string-level containment.
  const resolvedPath = resolve(fullPath)
  if (!resolvedPath.startsWith(targetDir)) {
    throw new PathTraversalError(
      `Key escapes target directory: "${relativeKey}"`,
    )
  }
  // Second pass: resolve symlinks and verify real containment.
  const realPath = await realpathDeepestExisting(resolvedPath)
  const realTargetDir = await realpath(targetDir.replace(/[/\\]+$/, ''))
  if (!(await isRealPathWithinDir(realPath, realTargetDir))) {
    throw new PathTraversalError(
      `Key escapes target directory via symlink: "${relativeKey}"`,
    )
  }
  return resolvedPath
}
