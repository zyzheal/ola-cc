/**
 * Project-level import-path alias loading.
 *
 * Reads `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json`
 * at the project root and converts the patterns into a form the
 * import-resolver can consult.
 *
 * Migrated from codegraph/src/resolution/path-aliases.ts — pure file-system utility.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../../utils/debug.js'

/** A single alias pattern from `compilerOptions.paths`. */
export interface AliasPattern {
  /** The literal prefix before `*` (or the whole pattern if no `*`). */
  prefix: string
  /** The literal suffix after `*` (almost always empty). */
  suffix: string
  /** Whether the pattern contains a `*` wildcard. */
  hasWildcard: boolean
  /**
   * Replacement templates. When `hasWildcard` is true, `*` in the
   * replacement is filled with the captured wildcard portion of the
   * import path. Stored relative to {@link AliasMap.baseUrl}.
   */
  replacements: string[]
}

export interface AliasMap {
  /** Absolute path. The directory `compilerOptions.paths` is rooted at. */
  baseUrl: string
  /**
   * Patterns ordered by specificity: longer prefix first, then literal-
   * before-wildcard, so the resolver tries the most-specific match.
   */
  patterns: AliasPattern[]
}

/**
 * Strip JSONC comments + trailing commas so a tsconfig with the usual
 * VS Code-style annotations parses cleanly.
 */
function stripJsonc(src: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < src.length) {
    const ch = src[i]!
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]!
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

interface RawTsconfig {
  compilerOptions?: {
    baseUrl?: string
    paths?: Record<string, string[]>
  }
}

function readTsconfigLike(filePath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    logForDebugging('path-aliases: failed to parse', { filePath, err: String(err) })
    return null
  }
}

function splitWildcard(pattern: string): {
  prefix: string
  suffix: string
  hasWildcard: boolean
} {
  const star = pattern.indexOf('*')
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false }
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    hasWildcard: true,
  }
}

/**
 * Load aliases for `projectRoot`. Returns `null` when no tsconfig /
 * jsconfig is present or when the file has no usable `paths`.
 */
export function loadProjectAliases(projectRoot: string): AliasMap | null {
  const candidates = ['tsconfig.json', 'jsconfig.json']
  let raw: RawTsconfig | null = null
  let usedFile: string | null = null
  for (const name of candidates) {
    const p = path.join(projectRoot, name)
    if (fs.existsSync(p)) {
      raw = readTsconfigLike(p)
      if (raw) {
        usedFile = name
        break
      }
    }
  }
  if (!raw) return null

  const co = raw.compilerOptions ?? {}
  const baseUrlRel = co.baseUrl ?? '.'
  const baseUrl = path.resolve(projectRoot, baseUrlRel)

  const paths = co.paths
  if (!paths || typeof paths !== 'object') {
    return null
  }

  const patterns: AliasPattern[] = []
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue
    const filtered = targets.filter((t): t is string => typeof t === 'string')
    if (filtered.length === 0) continue
    const { prefix, suffix, hasWildcard } = splitWildcard(pattern)
    patterns.push({ prefix, suffix, hasWildcard, replacements: filtered })
  }

  if (patterns.length === 0) return null

  // Specificity sort: longer prefix first; literal patterns before wildcard
  patterns.sort((a, b) => {
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1
    return 0
  })

  logForDebugging('path-aliases loaded', {
    file: usedFile,
    baseUrl,
    patternCount: patterns.length,
  })

  return { baseUrl, patterns }
}

/**
 * Resolve an import path through an {@link AliasMap}. Returns the list
 * of candidate filesystem paths (relative to `projectRoot`), in the
 * priority order defined by tsconfig. Returns `[]` when no alias matches.
 */
export function applyAliases(
  importPath: string,
  aliases: AliasMap,
  projectRoot: string
): string[] {
  for (const pat of aliases.patterns) {
    if (!importPath.startsWith(pat.prefix)) continue
    if (pat.suffix && !importPath.endsWith(pat.suffix)) continue

    let captured = ''
    if (pat.hasWildcard) {
      captured = importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length)
    } else if (importPath !== pat.prefix) {
      continue
    }

    const out: string[] = []
    for (const target of pat.replacements) {
      const filled = pat.hasWildcard ? target.replace('*', captured) : target
      const absolute = path.resolve(aliases.baseUrl, filled)
      const relative = path.relative(projectRoot, absolute)
      if (relative.startsWith('..')) continue
      out.push(relative.replace(/\\/g, '/'))
    }
    return out
  }
  return []
}
