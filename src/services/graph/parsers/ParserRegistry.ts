/**
 * ParserRegistry — manages file parsers and dispatches parsing.
 *
 * Scans a project directory for files matching registered parsers,
 * then parses each file and returns merged results.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import type { FileParser, ParserResult } from './types.js'

export class ParserRegistry {
  private parsers: FileParser[] = []
  private extensionMap = new Map<string, FileParser[]>()
  private patternMap = new Map<string, FileParser[]>()

  register(parser: FileParser): void {
    this.parsers.push(parser)

    // Index by extension
    for (const ext of parser.extensions) {
      const normalized = ext.startsWith('.') ? ext : `.${ext}`
      const existing = this.extensionMap.get(normalized) ?? []
      existing.push(parser)
      this.extensionMap.set(normalized, existing)
    }

    // Index by file name pattern
    if (parser.filePatterns) {
      for (const pattern of parser.filePatterns) {
        const existing = this.patternMap.get(pattern) ?? []
        existing.push(parser)
        this.patternMap.set(pattern, existing)
      }
    }
  }

  /**
   * Parse a single file using the appropriate parser(s).
   */
  parse(filePath: string, content?: string): ParserResult | null {
    const ext = extname(filePath).toLowerCase()
    const name = basename(filePath)

    // Try file name patterns first (e.g., 'Dockerfile')
    const patternParsers = this.patternMap.get(name)
    if (patternParsers) {
      for (const parser of patternParsers) {
        const fileContent = content ?? this.readFile(filePath)
        if (fileContent !== null) {
          const result = parser.parse(filePath, fileContent)
          if (result) return result
        }
      }
    }

    // Try extension-based parsers
    const extParsers = this.extensionMap.get(ext)
    if (extParsers) {
      for (const parser of extParsers) {
        const fileContent = content ?? this.readFile(filePath)
        if (fileContent !== null) {
          const result = parser.parse(filePath, fileContent)
          if (result) return result
        }
      }
    }

    return null
  }

  /**
   * Scan project directory and parse all matching files.
   * Skips node_modules, .git, dist, build directories.
   */
  parseAll(projectRoot: string, maxFiles = 500): ParserResult[] {
    const results: ParserResult[] = []
    const skipDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next',
      '__pycache__', '.codegraph', '.understand-anything',
      '.cache', 'coverage', '.turbo',
    ])

    const walk = (dir: string, depth: number) => {
      if (depth > 8 || results.length >= maxFiles) return

      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return // Permission denied or similar
      }

      for (const entry of entries) {
        if (results.length >= maxFiles) break
        if (entry.startsWith('.') && entry !== '.github') continue

        const fullPath = join(dir, entry)

        let stat
        try {
          stat = statSync(fullPath)
        } catch {
          continue
        }

        if (stat.isDirectory()) {
          if (!skipDirs.has(entry)) {
            walk(fullPath, depth + 1)
          }
          continue
        }

        if (!stat.isFile()) continue

        // Check if any parser handles this file
        const ext = extname(entry).toLowerCase()
        const hasExtParser = this.extensionMap.has(ext)
        const hasPatternParser = this.patternMap.has(entry)

        if (!hasExtParser && !hasPatternParser) continue

        // For CI files, check they're in .github/workflows
        if (ext === '.yml' || ext === '.yaml') {
          const relPath = fullPath.slice(projectRoot.length)
          // Only parse workflow YAML files, not all YAML
          if (!relPath.includes('.github/workflows') &&
              !relPath.includes('docker-compose') &&
              !relPath.includes('docker-compose.')) {
            // Still try generic YAML for specific patterns
            const content = this.readFile(fullPath)
            if (content) {
              const result = this.parse(fullPath, content)
              if (result) results.push(result)
            }
            continue
          }
        }

        const content = this.readFile(fullPath)
        if (content) {
          const result = this.parse(fullPath, content)
          if (result) results.push(result)
        }
      }
    }

    walk(projectRoot, 0)
    return results
  }

  private readFile(filePath: string): string | null {
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  }
}
