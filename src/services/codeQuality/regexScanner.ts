/**
 * Regex-based code quality scanner.
 *
 * A lightweight scanner that runs after code changes to catch common quality
 * issues without requiring full AST parsing. Each check consists of a regex
 * pattern, file glob scope, and severity level.
 *
 * Usage:
 *   const results = await runQualityScan({
 *     checks: ['empty-catch-block'],  // empty = all checks
 *     paths: ['src/services/*.ts'],   // empty = default (all ts/tsx)
 *   })
 */

import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'

// -- Types

export interface ScanResult {
  file: string
  line: number
  column: number
  check: string
  message: string
  severity: 'error' | 'warning' | 'info'
  fix?: string
}

export interface ScannerConfig {
  checks: string[]
  paths: string[]
}

// -- Check Definitions

type CheckDefinition = {
  name: string
  pattern: RegExp
  globs: string[]
  severity: 'error' | 'warning' | 'info'
  message: string
  fix?: string
  /**
   * Optional filter function for post-processing matches.
   * Returns true to keep the match, false to discard it.
   */
  filter?: (content: string, matchIndex: number) => boolean
}

const CHECKS: CheckDefinition[] = [
  {
    name: 'hardcoded-hex-color',
    pattern: /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/,
    globs: ['**/*.{tsx,css}'],
    severity: 'warning',
    message: 'Hardcoded hex color found. Consider using a design token or CSS variable.',
    fix: 'Replace hex color with a design token reference (e.g., var(--color-primary)).',
    filter: (content, index) => {
      // Discard matches inside comments (before OR after on the same line)
      const before = content.slice(Math.max(0, index - 100), index)
      const lastLineBefore = before.split('\n').pop() ?? ''
      if (/\b(\/\/|\/\*|\*)\s*$/.test(lastLineBefore) || /\/\/\s*.*#/.test(lastLineBefore)) return false
      // Also check after the match on the same line — if the match is preceded by // on the same line, skip
      const lineStart = content.lastIndexOf('\n', index)
      const lineEnd = content.indexOf('\n', index)
      const fullLine = content.slice(lineStart < 0 ? 0 : lineStart + 1, lineEnd < 0 ? undefined : lineEnd)
      const commentIdx = fullLine.indexOf('//')
      if (commentIdx >= 0) {
        const matchInContent = fullLine.indexOf('#', fullLine.indexOf('#') >= 0 ? 0 : -1)
        // If the hex color appears after // on the same line, it's in a comment
        const afterComment = fullLine.slice(commentIdx)
        if (afterComment.match(/#[0-9a-fA-F]{6}/)) return false
      }
      return true
    },
  },
  {
    name: 'console-log',
    pattern: /console\.(log|info|debug)\s*\(/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'warning',
    message: 'console.log/info/debug in source code. Remove before shipping.',
    fix: 'Remove or replace with a proper logging utility.',
  },
  {
    name: 'unhandled-promise',
    pattern: /new Promise\s*[<(]/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'error',
    message: 'Promise created without visible error handling (no surrounding try/catch or .catch()).',
    fix: 'Wrap in try/catch or append .catch() to handle rejections.',
  },
  {
    name: 'unhandled-fetch',
    pattern: /(?<!\/\/.*)\bfetch\s*\(/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'error',
    message: 'fetch() call without visible error handling (no surrounding try/catch or .catch()).',
    fix: 'Wrap fetch in try/catch or append .catch() to handle network errors.',
  },
  {
    name: 'direct-process-env',
    pattern: /process\.env\.([A-Z_]+)/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'info',
    message: 'Direct process.env access without fallback (?? operator).',
    fix: 'Add a fallback: process.env.VAR ?? "default".',
    filter: (content, index) => {
      // Check if the env access is followed by ?? (nullish coalescing)
      const match = content.slice(index).match(/process\.env\.[A-Z_]+/)
      if (!match) return true
      const afterMatch = content.slice(index + match.index! + match[0].length)
      // If followed by optional whitespace then ??, it's a safe access
      return !/^\s*\?\?/.test(afterMatch)
    },
  },
  {
    name: 'empty-catch-block',
    pattern: /catch\s*\([^)]*\)\s*\{[\s\r\n]*\}/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'error',
    message: 'Empty catch block swallows errors silently.',
    fix: 'Log the error, rethrow, or handle it explicitly.',
  },
  {
    name: 'magic-number',
    pattern: /\b\d{5,}\b/,
    globs: ['src/**/*.{ts,tsx}'],
    severity: 'info',
    message: 'Magic number detected. Consider defining a named constant.',
    fix: 'Define a const with a descriptive name (e.g., const MS_PER_DAY = 86400000).',
    filter: (content, index) => {
      const match = content.slice(index).match(/^\d+/)
      if (!match) return false
      const num = parseInt(match[0], 10)
      if (isNaN(num) || num < 10000) return false
      // Check if there's a comment on the same line before the number
      const before = content.slice(Math.max(0, index - 120), index)
      const lastLineBefore = before.split('\n').pop() ?? ''
      if (/(\/\/|\/\*|\*\/)/.test(lastLineBefore)) return false
      // Also check if there's a comment after the number on the same line
      const lineEnd = content.indexOf('\n', index + match[0].length)
      const restOfLine = content.slice(index + match[0].length, lineEnd < 0 ? undefined : lineEnd)
      if (/(\/\/|\/\*)/.test(restOfLine)) return false
      return true
    },
  },
]

// -- Exclusion Rules

/**
 * File paths or basenames to always skip regardless of glob.
 */
const EXCLUDE_PATTERNS = [
  /\/node_modules\//,
  /\/\.(git|next|output|cache|vite|dist)\//,
  /\.d\.ts$/,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
]

function shouldExcludeFile(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(filePath))
}

// -- Utilities

/**
 * Compute the 1-based line and column from a string index.
 */
function indexToLineColumn(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  }
}

/**
 * Simple glob-style matcher for file paths.
 * Supports: *, **, {a,b}, and literal segments.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize slashes
  const p = pattern.replace(/\\/g, '/')
  const f = filePath.replace(/\\/g, '/')

  // Step 1: Replace brace groups {a,b} with placeholders before escaping
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

  return new RegExp(`^${temp}$`).test(f)
}

/**
 * Recursively walk a directory and return file paths.
 */
async function walkDir(dir: string): Promise<string[]> {
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
      // Skip excluded directories
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
async function resolveGlobPattern(pattern: string): Promise<string[]> {
  // If the pattern is an absolute path to an existing file, return it directly
  if (pattern.startsWith('/')) {
    try {
      const stat = await fs.stat(pattern)
      if (stat.isFile()) return [pattern]
      // If it's a directory, walk it
      if (stat.isDirectory()) {
        const files = await walkDir(pattern)
        return files.filter(f => !shouldExcludeFile(f))
      }
    }
    catch {
      // File doesn't exist, return empty
      return []
    }
  }

  // Treat as a glob pattern
  const root = process.cwd()

  // Extract the directory prefix (everything before the first * or {)
  const prefixMatch = pattern.match(/^([^{*]+)/)
  const prefix = prefixMatch ? prefixMatch[1] : '.'
  const searchDir = join(root, prefix)

  const allFiles = await walkDir(searchDir)

  // Filter files that match the glob pattern
  const relFiles = allFiles.map(f => relative(root, f).replace(/\\/g, '/'))
  return relFiles.filter(f => matchGlob(pattern, f)).map(f => join(root, f))
}

/**
 * Resolve file paths: if paths is empty, use default.
 */
function resolvePaths(paths: string[]): string[] {
  if (paths.length > 0) return paths
  return ['src/**/*.{ts,tsx}']
}

/**
 * Filter checks by name. Empty checks array means all checks.
 */
function resolveChecks(checks: string[]): CheckDefinition[] {
  if (checks.length === 0) return CHECKS
  const names = new Set(checks)
  return CHECKS.filter(c => names.has(c.name))
}

/**
 * Read file content.
 */
async function readFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8')
  }
  catch {
    return null
  }
}

// -- Core Scan Logic

/**
 * Determine which checks apply to a given file based on glob patterns.
 */
function getApplicableChecks(
  filePath: string,
  checks: CheckDefinition[],
): CheckDefinition[] {
  const relPath = relative(process.cwd(), filePath).replace(/\\/g, '/')

  return checks.filter(check =>
    check.globs.some(g => matchGlob(g, relPath)),
  )
}

async function scanFile(
  filePath: string,
  checks: CheckDefinition[],
): Promise<ScanResult[]> {
  const content = await readFile(filePath)
  if (content === null) return []

  const results: ScanResult[] = []

  // Filter applicable checks for this file
  const applicableChecks = getApplicableChecks(filePath, checks)
  if (applicableChecks.length === 0) return []

  for (const check of applicableChecks) {
    // Skip excluded files (test files, etc.)
    if (shouldExcludeFile(filePath)) continue

    // Ensure 'g' flag for multiple matches
    const flags = check.pattern.flags.includes('g')
      ? check.pattern.flags
      : check.pattern.flags + 'g'
    const regex = new RegExp(check.pattern.source, flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(content)) !== null) {
      const idx = match.index

      // Apply filter if present
      if (check.filter && !check.filter(content, idx)) continue

      const { line, column } = indexToLineColumn(content, idx)
      results.push({
        file: filePath,
        line,
        column,
        check: check.name,
        message: check.message,
        severity: check.severity,
        fix: check.fix,
      })
    }
  }

  return results
}

/**
 * Run a quality scan over the specified paths using the specified checks.
 *
 * @param config - Optional configuration. When omitted, runs all checks over
 *                 the default paths (all ts/tsx under src/).
 * @returns Array of scan results sorted by file then line number.
 */
export async function runQualityScan(config?: ScannerConfig): Promise<ScanResult[]> {
  const checks = resolveChecks(config?.checks ?? [])
  const paths = resolvePaths(config?.paths ?? [])

  // Collect all matching files
  const fileSet = new Set<string>()
  for (const pattern of paths) {
    const files = await resolveGlobPattern(pattern)
    for (const f of files) {
      if (!shouldExcludeFile(f)) {
        fileSet.add(f)
      }
    }
  }

  const allResults: ScanResult[] = []
  for (const file of fileSet) {
    const results = await scanFile(file, checks)
    allResults.push(...results)
  }

  // Sort by file, then line, then column
  allResults.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })

  return allResults
}

/**
 * Return all available check definitions (for documentation / UI listing).
 */
export function getAvailableChecks(): Array<{
  name: string
  severity: 'error' | 'warning' | 'info'
  message: string
  globs: string[]
}> {
  return CHECKS.map(c => ({
    name: c.name,
    severity: c.severity,
    message: c.message,
    globs: c.globs,
  }))
}
