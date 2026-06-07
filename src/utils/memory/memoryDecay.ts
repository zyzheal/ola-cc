/**
 * Memory decay sweep — ported from AgentMemory lesson-decay-sweep
 *
 * Periodically scans memory files, computes retention scores, and:
 * 1. Removes evictable memories (retention < 0.15)
 * 2. Updates `last-decayed-at` frontmatter field (B5 fix)
 *
 * B5 key correction: uses `lastDecayedAt || createdAt` as decay baseline,
 * NOT `updatedAt` (which resets on save, making memories never decay).
 *
 * P0 fix: access-timestamps are now parsed from frontmatter and passed
 * to computeRetention() for reinforcement boost calculation.
 *
 * Controlled by OLA_CC_RETENTION_DECAY env var (default: disabled).
 */

import { readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { parseFrontmatter } from '../frontmatterParser.js'
import { computeRetention, type RetentionResult } from './retention.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'

/** Minimum hours between decay sweeps (B5: cooldown period) */
const DECAY_COOLDOWN_HOURS = 1

/** Retention threshold below which memories are evicted */
const EVICTION_THRESHOLD = 0.15

/** Max access timestamps to keep in frontmatter (prevents unbounded growth) */
const MAX_ACCESS_TIMESTAMPS = 20

export interface DecaySweepResult {
  scanned: number
  evicted: number
  updated: number
  errors: number
}

/**
 * Check if memory decay is enabled via env var.
 */
export function isDecayEnabled(): boolean {
  return isEnvTruthy(process.env.OLA_CC_RETENTION_DECAY)
}

/**
 * Parse a date string from frontmatter, returning epoch ms or undefined.
 */
function parseDateField(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

/**
 * Parse access-timestamps from frontmatter.
 * Format: comma-separated epoch ms values (e.g., "1717000000000,1717100000000")
 */
export function parseAccessTimestamps(raw: string | null | undefined): number[] {
  if (!raw || typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(s => {
      const n = Number(s.trim())
      return Number.isFinite(n) && n > 0 ? n : 0
    })
    .filter(n => n > 0)
}

/**
 * Inject or append an access-timestamp to frontmatter content.
 * Appends `now` epoch ms to the `access-timestamps` field.
 * Keeps at most MAX_ACCESS_TIMESTAMPS most recent timestamps.
 */
export function appendAccessTimestamp(
  content: string,
  now: number,
): string {
  const tsLine = (existing: string) => {
    const timestamps = parseAccessTimestamps(existing)
    timestamps.push(now)
    const trimmed = timestamps.slice(-MAX_ACCESS_TIMESTAMPS)
    return `access-timestamps: '${trimmed.join(',')}'`
  }

  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('\n---', 4)
    if (endIdx !== -1) {
      const fmContent = content.slice(4, endIdx)
      if (fmContent.includes('access-timestamps:')) {
        const updated = fmContent.replace(
          /access-timestamps:\s*['"]?([^'"\n]*)['"]?/m,
          (_, existing) => tsLine(existing),
        )
        return `---\n${updated}\n---${content.slice(endIdx + 4)}`
      }
      return `---\n${fmContent}\naccess-timestamps: '${now}'\n---${content.slice(endIdx + 4)}`
    }
  }

  return `---\naccess-timestamps: '${now}'\n---\n${content}`
}

/**
 * Compute the decay baseline for a memory file.
 *
 * B5 fix: use `lastDecayedAt || createdAt` (file birth time), NOT `updatedAt`.
 * mtimeMs changes on every save, which would reset the decay clock.
 *
 * @param lastDecayedAt - From frontmatter `last-decayed-at`
 * @param mtimeMs - File modification time (fallback)
 * @returns Epoch ms to use as decay baseline
 */
export function computeDecayBaseline(
  lastDecayedAt: string | null | undefined,
  mtimeMs: number,
): number {
  const parsed = parseDateField(lastDecayedAt)
  if (parsed !== undefined) return parsed
  // Fallback to mtimeMs (best available proxy for creation time)
  return mtimeMs
}

/**
 * Check if enough time has passed since the last decay sweep.
 * B5: 1-hour cooldown prevents excessive writes.
 */
export function shouldRunDecaySweep(lastDecayedAt: string | null | undefined): boolean {
  if (!lastDecayedAt) return true
  const last = parseDateField(lastDecayedAt)
  if (last === undefined) return true
  const hoursSince = (Date.now() - last) / (60 * 60 * 1000)
  return hoursSince >= DECAY_COOLDOWN_HOURS
}

/**
 * Inject `last-decayed-at` into frontmatter content.
 * Preserves existing frontmatter structure.
 */
function injectDecayTimestamp(
  content: string,
  timestamp: string,
): string {
  const lastDecayedLine = `last-decayed-at: '${timestamp}'`

  if (content.startsWith('---\n')) {
    // Has frontmatter — inject before closing ---
    const endIdx = content.indexOf('\n---', 4)
    if (endIdx !== -1) {
      const fmContent = content.slice(4, endIdx)
      // Check if last-decayed-at already exists
      if (fmContent.includes('last-decayed-at:')) {
        // Replace existing
        const updated = fmContent.replace(
          /last-decayed-at:.*$/m,
          lastDecayedLine,
        )
        return `---\n${updated}\n---${content.slice(endIdx + 4)}`
      }
      // Append to frontmatter
      return `---\n${fmContent}\n${lastDecayedLine}\n---${content.slice(endIdx + 4)}`
    }
  }

  // No frontmatter — prepend
  return `---\n${lastDecayedLine}\n---\n${content}`
}

/**
 * Run a decay sweep on all memory files in a directory.
 *
 * For each .md file (excluding MEMORY.md):
 * 1. Parse frontmatter to get type, lastDecayedAt, and accessTimestamps
 * 2. Compute retention score using retention.ts (with reinforcement boost)
 * 3. If retention < 0.15 → delete file (evictable)
 * 4. Otherwise → update last-decayed-at in frontmatter
 *
 * @param memoryDir - Path to memory directory
 * @returns Sweep result summary
 */
export async function runDecaySweep(memoryDir: string): Promise<DecaySweepResult> {
  const { readdir } = await import('fs/promises')
  const { basename } = await import('path')
  const { parseMemoryType } = await import('../../memdir/memoryTypes.js')

  const result: DecaySweepResult = { scanned: 0, evicted: 0, updated: 0, errors: 0 }

  let entries: string[]
  try {
    entries = await readdir(memoryDir, { recursive: true })
  } catch {
    return result
  }

  const mdFiles = entries.filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')

  for (const relativePath of mdFiles) {
    const filePath = join(memoryDir, relativePath)
    result.scanned++

    try {
      const content = await readFile(filePath, 'utf-8')
      const { frontmatter } = parseFrontmatter(content, filePath)
      const memType = parseMemoryType(frontmatter.type)
      const lastDecayedAt = frontmatter['last-decayed-at'] as string | null

      // Check cooldown — skip if recently decayed
      if (!shouldRunDecaySweep(lastDecayedAt)) {
        continue
      }

      // Get mtime for baseline calculation
      const { stat } = await import('fs/promises')
      const stats = await stat(filePath)
      const baseline = computeDecayBaseline(lastDecayedAt, stats.mtimeMs)
      const daysSinceBaseline = (Date.now() - baseline) / (24 * 60 * 60 * 1000)

      // P0 fix: parse access timestamps from frontmatter for reinforcement boost
      const accessTimestamps = parseAccessTimestamps(
        frontmatter['access-timestamps'] as string | null,
      )

      // Compute retention (now with access-based reinforcement)
      const retention: RetentionResult = computeRetention({
        type: memType ?? 'fact',
        daysSinceCreation: daysSinceBaseline,
        accessTimestamps: accessTimestamps.length > 0 ? accessTimestamps : undefined,
      })

      if (retention.score < EVICTION_THRESHOLD) {
        // Evict: remove file and its MEMORY.md entry
        await unlink(filePath)
        result.evicted++
        logForDebugging(
          `[memoryDecay] Evicted ${relativePath}: retention=${retention.score.toFixed(3)} (${retention.tier})`,
        )
      } else {
        // Update last-decayed-at timestamp
        const now = new Date().toISOString()
        const updatedContent = injectDecayTimestamp(content, now)
        if (updatedContent !== content) {
          await writeFile(filePath, updatedContent, 'utf-8')
          result.updated++
        }
      }
    } catch {
      result.errors++
    }
  }

  return result
}
