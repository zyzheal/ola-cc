/**
 * Shared glob matching and file utilities for code quality scanners.
 *
 * Consolidates duplicate implementations from regexScanner, astChecker,
 * and regressionChecker into a single cached, reusable module.
 */

import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'

// -- Exclusion Rules

const EXCLUDE_PATTERNS = [
  /\/node_modules\//,
  /\/\.(git|next|output|cache|vite|dist)\//,
  /\.d\.ts$/,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
]

export function shouldExcludeFile(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(filePath))
}

// -- Cached Glob Matching

const globRegexCache = new Map<string, RegExp>()

function compileGlob(pattern: string): RegExp {
  let cached = globRegexCache.get(pattern)
  if (cached) return cached

  const p = pattern.replace(/\\/g, '/')

  // Step 1: Replace brace groups {a,b} with placeholders
  let braceCount = 0
  const braces: string[] = []
  let temp = p.replace(/\{([^}]+)\}/g, (_match, inner) => {
    const replacement = `__BRACE_${braceCount}__`
    braces.push(`(${inner.replace(/,/g, '|')})`)
    braceCount++
    return replacement
  })

  // Step 2: Escape regex special chars
  temp = temp.replace(/[.+?^$()[\]\\]/g, '\\$&')

  // Step 3: Apply glob patterns
  temp = temp
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*/g, '[^/]*')

  // Step 4: Restore brace groups
  for (let i = 0; i < braces.length; i++) {
    temp = temp.replace(`__BRACE_${i}__`, braces[i])
  }

  cached = new RegExp(`^${temp}$`)
  globRegexCache.set(pattern, cached)
  return cached
}

/**
 * Simple glob-style matcher for file paths.
 * Supports: *, **, {a,b}, and literal segments.
 * Results are cached per pattern to avoid repeated RegExp compilation.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const f = filePath.replace(/\\/g, '/')
  return compileGlob(pattern).test(f)
}

// -- Directory Walking

/**
 * Recursively walk a directory and return file paths.
 */
export async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  }
  catch {
    return []
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (shouldExcludeFile(fullPath + '/')) continue
      results.push(...await walkDir(fullPath))
    }
    else if (entry.isFile()) {
      results.push(fullPath)
    }
  }

  return results
}

/**
 * Resolve a glob pattern or direct file path to actual file paths.
 * Accepts glob patterns (e.g. "src/*.ts") or absolute file paths.
 */
export async function resolveGlobPattern(pattern: string): Promise<string[]> {
  if (pattern.startsWith('/')) {
    try {
      const stat = await fs.stat(pattern)
      if (stat.isFile()) return [pattern]
      if (stat.isDirectory()) {
        const files = await walkDir(pattern)
        return files.filter(f => !shouldExcludeFile(f))
      }
    }
    catch {
      return []
    }
  }

  const root = process.cwd()
  const prefixMatch = pattern.match(/^([^{*]+)/)
  const prefix = prefixMatch ? prefixMatch[1] : '.'
  const searchDir = join(root, prefix)

  const allFiles = await walkDir(searchDir)
  const relFiles = allFiles.map(f => relative(root, f).replace(/\\/g, '/'))
  return relFiles.filter(f => matchGlob(pattern, f)).map(f => join(root, f))
}
