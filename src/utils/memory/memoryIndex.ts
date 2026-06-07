/**
 * MEMORY.md index scoring — C1: retention-based entry selection
 *
 * Parses MEMORY.md index lines, scores each entry by the referenced file's
 * retention score, and returns the top-N entries sorted by score (descending).
 *
 * Entry format: `- [Title](file.md) — description`
 * Non-entry lines (headers, blank lines, warnings) are preserved as-is.
 */

import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { parseFrontmatter } from '../frontmatterParser.js'
import { computeRetention } from './retention.js'
import { parseMemoryType } from '../../memdir/memoryTypes.js'

export interface MemoryIndexEntry {
  /** Original line text */
  line: string
  /** Parsed filename (e.g., "user_role.md") */
  filename: string | null
  /** Retention score (0-1), null for non-entry lines */
  score: number | null
  /** Whether this is a memory entry (vs header/blank/warning) */
  isEntry: boolean
}

/**
 * Regex to match MEMORY.md entry lines.
 * Format: `- [Title](filename.md) — description` or `- [Title](filename.md)`
 * The filename may include subdirectory paths (e.g., "subdir/file.md").
 */
const ENTRY_REGEX = /^- \[.+?\]\(([^)]+\.md)\)/

/**
 * Parse MEMORY.md content into scored entries.
 *
 * For each entry line, reads the referenced file's frontmatter to determine
 * its type, then computes a retention score. Non-entry lines get score null.
 *
 * @param content - Raw MEMORY.md content
 * @param memoryDir - Path to the memory directory
 * @returns Array of parsed entries with scores
 */
export async function parseAndScoreEntries(
  content: string,
  memoryDir: string,
): Promise<MemoryIndexEntry[]> {
  const lines = content.split('\n')
  const entries: MemoryIndexEntry[] = []

  for (const line of lines) {
    const match = line.match(ENTRY_REGEX)
    if (!match) {
      entries.push({ line, filename: null, score: null, isEntry: false })
      continue
    }

    const filename = match[1]!
    let score: number | null = null

    try {
      const filePath = join(memoryDir, filename)
      const [fileContent, fileStats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ])

      const { frontmatter } = parseFrontmatter(fileContent, filePath)
      const memType = parseMemoryType(frontmatter.type)
      const daysSinceCreation =
        (Date.now() - fileStats.mtimeMs) / (24 * 60 * 60 * 1000)

      const retention = computeRetention({
        type: memType ?? 'fact',
        daysSinceCreation,
      })

      score = retention.score
    } catch {
      // File not found or unreadable — assign lowest score
      score = 0
    }

    entries.push({ line, filename, score, isEntry: true })
  }

  return entries
}

/**
 * Select the top-N MEMORY.md lines by retention score.
 *
 * Entry lines are ranked by score and the top `maxLines` are kept.
 * Non-entry lines (headers, blank lines, section markers) are always kept
 * as context, but do not count toward the limit.
 *
 * @param entries - Parsed entries from parseAndScoreEntries
 * @param maxLines - Maximum number of entry lines to keep (default: 200)
 * @returns Selected lines in their original order
 */
export function selectTopEntries(
  entries: MemoryIndexEntry[],
  maxLines: number = 200,
): string[] {
  // Separate entries from non-entries
  const entryIndices = entries
    .map((e, i) => ({ ...e, index: i }))
    .filter(e => e.isEntry)

  // Sort by score descending, take top maxLines
  const topIndices = new Set(
    entryIndices
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxLines)
      .map(e => e.index),
  )

  // Reconstruct: keep non-entries always, keep top entries
  return entries
    .filter((e, i) => !e.isEntry || topIndices.has(i))
    .map(e => e.line)
}
