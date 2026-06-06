/**
 * C++ Include Directory Discovery
 *
 * Discovers C++ include directories from:
 * 1. compile_commands.json (preferred) — parses -I and -isystem flags
 * 2. Heuristic fallback — checks convention dirs and dirs with .h/.hpp files
 *
 * Migrated from codegraph/src/resolution/import-resolver.ts lines 332-486.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'

// ============================================================
// Cache
// ============================================================

const cppIncludeDirCache = new Map<string, string[]>()

// ============================================================
// Public API
// ============================================================

/**
 * Load C++ include directories for a project.
 * Returns paths relative to projectRoot.
 */
export function loadCppIncludeDirs(projectRoot: string): string[] {
  const cached = cppIncludeDirCache.get(projectRoot)
  if (cached !== undefined) return cached

  const dirs = loadCppIncludeDirsFromCompileDB(projectRoot)
    ?? loadCppIncludeDirsHeuristic(projectRoot)

  cppIncludeDirCache.set(projectRoot, dirs)
  return dirs
}

/**
 * Clear the include directory cache (for testing).
 */
export function clearCppIncludeDirCache(): void {
  cppIncludeDirCache.clear()
}

// ============================================================
// compile_commands.json parser
// ============================================================

/**
 * Try to load include directories from compile_commands.json.
 * Returns null if no compilation database is found (so the heuristic
 * fallback can run). Returns an array (possibly empty) otherwise.
 */
export function loadCppIncludeDirsFromCompileDB(projectRoot: string): string[] | null {
  const candidates = [
    join(projectRoot, 'compile_commands.json'),
    join(projectRoot, 'build', 'compile_commands.json'),
    join(projectRoot, 'cmake-build-debug', 'compile_commands.json'),
    join(projectRoot, 'cmake-build-release', 'compile_commands.json'),
    join(projectRoot, 'out', 'compile_commands.json'),
  ]

  let dbPath: string | undefined
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        dbPath = c
        break
      }
    } catch {
      // ignore
    }
  }
  if (!dbPath) return null

  try {
    const content = readFileSync(dbPath, 'utf-8')
    const entries = JSON.parse(content) as Array<{
      directory: string
      command?: string
      arguments?: string[]
    }>
    if (!Array.isArray(entries)) return null

    const dirSet = new Set<string>()
    for (const entry of entries) {
      const dir = entry.directory || projectRoot
      const args = entry.arguments || (entry.command ? shlexSplit(entry.command) : [])
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        let includeDir: string | undefined
        // -I<dir> (no space)
        if (arg.startsWith('-I') && arg.length > 2) {
          includeDir = arg.substring(2)
        }
        // -isystem <dir> (space-separated)
        else if ((arg === '-isystem' || arg === '-I') && i + 1 < args.length) {
          includeDir = args[i + 1]!
          i++ // skip next arg
        }
        if (includeDir) {
          // Normalize: resolve relative to the compilation directory
          const absPath = isAbsolute(includeDir)
            ? includeDir
            : resolve(dir, includeDir)
          const relPath = relative(projectRoot, absPath).replace(/\\/g, '/')
          // Skip system directories and paths outside the project
          if (!relPath.startsWith('..') && relPath.length > 0 && !isAbsolute(relPath)) {
            dirSet.add(relPath)
          }
        }
      }
    }
    return Array.from(dirSet)
  } catch {
    return null
  }
}

// ============================================================
// Heuristic fallback
// ============================================================

/**
 * Heuristic include directory discovery when no compile_commands.json exists.
 * Checks common convention directories and scans top-level dirs for headers.
 */
export function loadCppIncludeDirsHeuristic(projectRoot: string): string[] {
  const dirs: string[] = []
  const conventionDirs = ['include', 'src', 'lib', 'api', 'inc']

  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      // Convention directories
      if (conventionDirs.includes(name.toLowerCase())) {
        dirs.push(name)
        continue
      }
      // Any top-level directory containing .h or .hpp files
      try {
        const subFiles = readdirSync(join(projectRoot, name))
        if (subFiles.some(f => /\.(h|hpp|hxx|hh)$/i.test(f))) {
          dirs.push(name)
        }
      } catch {
        // ignore permission errors
      }
    }
  } catch {
    // ignore
  }

  return dirs
}

// ============================================================
// shlexSplit — minimal shell argument splitter
// ============================================================

/**
 * Minimal shlex-style split for compiler command strings.
 * Handles double-quoted and single-quoted arguments.
 */
export function shlexSplit(cmd: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < cmd.length) {
    // Skip whitespace
    while (i < cmd.length && /\s/.test(cmd[i]!)) i++
    if (i >= cmd.length) break

    // Read a single argument (may contain embedded quotes like -I"path")
    let arg = ''
    while (i < cmd.length && !/\s/.test(cmd[i]!)) {
      const ch = cmd[i]!
      if (ch === '"') {
        i++ // skip opening quote
        while (i < cmd.length && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < cmd.length) { i++; arg += cmd[i] }
          else { arg += cmd[i] }
          i++
        }
        if (i < cmd.length) i++ // skip closing quote
      } else if (ch === "'") {
        i++ // skip opening quote
        while (i < cmd.length && cmd[i] !== "'") { arg += cmd[i]; i++ }
        if (i < cmd.length) i++ // skip closing quote
      } else {
        arg += ch
        i++
      }
    }
    if (arg.length > 0) result.push(arg)
  }
  return result
}
