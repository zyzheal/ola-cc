import { basename, dirname, isAbsolute, join, sep } from 'path'
import { readdir, realpath } from 'fs/promises'
import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'
import ignore from 'ignore'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

/**
 * Match a filename against a glob pattern.
 * Supports: *, ?, [abc], [a-z], {a,b}, **
 * Uses simple recursive matching — no external dependencies.
 */
function matchGlob(pattern: string, name: string): boolean {
  // Exact match
  if (pattern === name) return true
  // Single wildcard: *.ts matches foo.ts
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1) // .ts
    return name.endsWith(ext)
  }
  // Suffix wildcard: *bar matches foobar
  if (pattern.startsWith('*') && !pattern.includes('**')) {
    const suffix = pattern.slice(1)
    return name.endsWith(suffix)
  }
  // Prefix wildcard: foo* matches foobar
  if (pattern.endsWith('*') && !pattern.includes('**')) {
    const prefix = pattern.slice(0, -1)
    return name.startsWith(prefix)
  }
  // ** matches anything (including path separators in BFS we handle dirs separately)
  if (pattern === '**') return true
  // **/*.ts pattern
  if (pattern.startsWith('**/')) {
    const rest = pattern.slice(3)
    // If rest contains no more **, match against basename
    if (!rest.includes('**')) {
      return matchGlob(rest, name)
    }
  }
  // Fallback: simple contains check for patterns with *
  if (pattern.includes('*')) {
    const parts = pattern.split('*')
    let pos = 0
    for (const part of parts) {
      if (!part) continue
      const idx = name.indexOf(part, pos)
      if (idx === -1) return false
      pos = idx + part.length
    }
    return true
  }
  // Literal match
  return pattern === name
}

/**
 * Convert glob pattern to a predicate function that tests filenames.
 * Handles common patterns: *.ext, double-star patterns, directory matches, etc.
 */
function globToPredicate(pattern: string): (name: string, relativePath: string) => boolean {
  // Normalize pattern
  const normalized = pattern.replace(/\\/g, '/')

  // **/* or ** — match everything
  if (normalized === '**' || normalized === '**/*') {
    return () => true
  }

  // **/*.ext — match any file with extension anywhere in tree
  if (normalized.startsWith('**/')) {
    const rest = normalized.slice(3)
    if (!rest.includes('/')) {
      // Pattern like **/*.ts — only match against filename
      return (name, _relativePath) => matchGlob(rest, name)
    }
    // Pattern like **/dir/*.ts — match against full relative path
    return (_name, relativePath) => {
      const norm = relativePath.replace(/\\/g, '/')
      return matchGlob(rest, norm.split('/').pop() || '') || matchGlob(rest, norm)
    }
  }

  // dir/** — match any file under dir/
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3)
    return (_name, relativePath) => {
      const norm = relativePath.replace(/\\/g, '/')
      return norm.startsWith(prefix + '/')
    }
  }

  // Simple pattern like *.ts, src/**/*.ts
  if (!normalized.includes('/')) {
    // Match against filename only
    return (name, _relativePath) => matchGlob(normalized, name)
  }

  // Pattern with directory component: src/*.ts
  return (_name, relativePath) => {
    const norm = relativePath.replace(/\\/g, '/')
    return matchGlob(normalized, norm) || matchGlob(normalized, norm.split('/').pop() || '')
  }
}

/**
 * Check if a directory entry is a hidden file/directory.
 */
function isHidden(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

/**
 * BFS filesystem walk — replaces ripgrep --files for glob pattern matching.
 *
 * This is faster than spawning ripgrep because it avoids process fork overhead
 * and works entirely in-process with Node.js fs APIs.
 *
 * @param searchDir - Root directory to walk from
 * @param filePredicate - Function to test if a file matches the glob pattern
 * @param ig - Ignore instance for .gitignore filtering
 * @param includeHidden - Whether to include hidden files/directories
 * @param maxResults - Maximum number of results to collect
 * @param abortSignal - AbortSignal for cancellation
 */
async function bfsWalk(
  searchDir: string,
  filePredicate: (name: string, relativePath: string) => boolean,
  ig: ReturnType<typeof ignore>,
  includeHidden: boolean,
  maxResults: number,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const results: string[] = []
  // BFS queue: [absolutePath, relativePath]
  const queue: Array<[string, string]> = [[searchDir, '']]

  // Track visited directories to avoid symlink loops
  const visited = new Set<string>()
  const realSearchDir = searchDir

  while (queue.length > 0) {
    if (abortSignal.aborted) break
    if (results.length >= maxResults) break

    const [currentDir, relativeDir] = queue.shift()!

    // Avoid infinite symlink loops
    let realPath: string
    try {
      realPath = await realpath(currentDir)
    } catch {
      continue
    }
    if (visited.has(realPath)) continue
    visited.add(realPath)

    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      // Permission denied or not a directory — skip
      continue
    }

    // Sort entries for deterministic order (matches ripgrep's default behavior)
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (abortSignal.aborted) break
      if (results.length >= maxResults) break

      const name = entry.name

      // Skip . and ..
      if (name === '.' || name === '..') continue

      // Hidden files/dirs
      if (!includeHidden && isHidden(name)) continue

      const absPath = join(currentDir, name)
      const relPath = relativeDir ? join(relativeDir, name) : name

      // Normalize for ignore matching
      const normalizedRel = relPath.replace(/\\/g, '/')

      // Check ignore patterns
      if (ig.ignores(normalizedRel)) continue

      // Also check the basename for simple patterns
      if (ig.ignores(name + '/')) continue

      if (entry.isDirectory()) {
        // Don't follow symlinked directories at top level (avoid traversing node_modules etc.)
        if (entry.isSymbolicLink()) continue
        queue.push([absPath, relPath])
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (filePredicate(name, relPath)) {
          results.push(absPath)
        }
      }
    }
  }

  return results
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )

  // Build ignore instance
  const ig = ignore()

  // Default: ignore .git directory (ripgrep behavior)
  ig.add('.git/')
  ig.add('.git')
  ig.add('.svn/')
  ig.add('.svn')

  // Read .gitignore if it exists and user hasn't disabled it
  const noIgnore = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE || 'true')
  if (!noIgnore) {
    try {
      const { readFile } = await import('fs/promises')
      const gitignorePath = join(searchDir, '.gitignore')
      const gitignoreContent = await readFile(gitignorePath, 'utf-8')
      ig.add(gitignoreContent)
    } catch {
      // No .gitignore or can't read — continue without it
    }
  }

  // Add user-specified ignore patterns
  for (const pattern of ignorePatterns) {
    ig.add(pattern)
  }

  // Exclude orphaned plugin version directories
  for (const exclusion of await getGlobExclusionsForPluginCache(searchDir)) {
    ig.add(exclusion)
  }

  // Build file matching predicate
  const includeHidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')
  const filePredicate = globToPredicate(searchPattern)

  // Walk with BFS — collect enough results to handle offset + limit
  const allPaths = await bfsWalk(
    searchDir,
    filePredicate,
    ig,
    includeHidden,
    offset + limit + 1, // +1 to detect truncation
    abortSignal,
  )

  const truncated = allPaths.length > offset + limit
  const files = allPaths.slice(offset, offset + limit)

  return { files, truncated }
}
