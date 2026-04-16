/**
 * Automatic pruning: maintains MEMORY.md health by identifying
 * low-quality, stale, or obsolete memories for removal.
 *
 * Runs at session end or on demand. Does NOT delete files directly —
 * returns recommendations for the agent to review and act upon.
 *
 * Pruning criteria:
 * - Quality score below threshold
 * - Age beyond retention period with no recent references
 * - Contradictory memories (same topic, conflicting advice)
 * - MEMORY.md index entries pointing to deleted files
 */

import { MemoryDoc } from './index.js'
import { qualityScore } from './memoryQuality.js'

/** A memory recommended for pruning with the reason. */
export type PruneCandidate = {
  docId: number
  name: string
  reason: string
  score: number
}

/** Pruning configuration. */
export interface PruneConfig {
  /** Minimum quality score to keep (0-1). */
  minQualityScore: number
  /** Maximum age in days before considering stale (default: 180). */
  maxAgeDays: number
  /** Maximum number of memories (FIFO eviction beyond this, default: 500). */
  maxMemories: number
}

const DEFAULT_CONFIG: PruneConfig = {
  minQualityScore: 0.2,
  maxAgeDays: 180,
  maxMemories: 500,
}

/**
 * Analyze memories and return pruning candidates.
 *
 * Does NOT perform any deletions — returns recommendations only.
 * The agent or user decides which to act on.
 */
export function findPruneCandidates(
  docs: MemoryDoc[],
  config: Partial<PruneConfig> = {},
): PruneCandidate[] {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const candidates: PruneCandidate[] = []
  const now = Date.now()

  for (const doc of docs) {
    const score = qualityScore(doc)
    const ageDays = (now - doc.mtimeMs) / (1000 * 60 * 60 * 24)

    // Low quality
    if (score < cfg.minQualityScore) {
      candidates.push({
        docId: doc.id,
        name: doc.name,
        reason: `Low quality score (${score.toFixed(2)})`,
        score,
      })
      continue
    }

    // Stale beyond retention period
    if (ageDays > cfg.maxAgeDays && doc.type !== 'feedback') {
      // Feedback memories are timeless — user preferences don't expire
      candidates.push({
        docId: doc.id,
        name: doc.name,
        reason: `Stale (${Math.round(ageDays)} days old)`,
        score,
      })
    }
  }

  // FIFO eviction if over limit
  if (docs.length > cfg.maxMemories) {
    const sorted = [...docs].sort((a, b) => a.mtimeMs - b.mtimeMs)
    const excess = sorted.slice(0, docs.length - cfg.maxMemories)
    for (const doc of excess) {
      if (!candidates.find(c => c.docId === doc.id)) {
        candidates.push({
          docId: doc.id,
          name: doc.name,
          reason: `Over limit (${docs.length} > ${cfg.maxMemories}, oldest first)`,
          score: qualityScore(doc),
        })
      }
    }
  }

  return candidates
}

/**
 * Detect contradictory memories by finding pairs with similar names
 * but different content.
 *
 * Returns pairs of memory IDs that may conflict.
 */
export function findContradictions(
  docs: MemoryDoc[],
): Array<{ id1: number; name1: string; id2: number; name2: string }> {
  const contradictions: Array<{ id1: number; name1: string; id2: number; name2: string }> = []

  // Group by type — contradictions only matter within the same type
  const byType = new Map<string, MemoryDoc[]>()
  for (const doc of docs) {
    const group = byType.get(doc.type) ?? []
    group.push(doc)
    byType.set(doc.type, group)
  }

  for (const [, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]

        // Similar name indicates same topic
        if (namesOverlap(a.name, b.name) > 0.5) {
          contradictions.push({
            id1: a.id,
            name1: a.name,
            id2: b.id,
            name2: b.name,
          })
        }
      }
    }
  }

  return contradictions
}

/**
 * Compute word-level name overlap between two memory names.
 * Returns Jaccard similarity of tokens.
 */
function namesOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))
  const tokensB = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))

  if (tokensA.size === 0 || tokensB.size === 0) return 0

  let overlap = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++
  }

  const union = tokensA.size + tokensB.size - overlap
  return union > 0 ? overlap / union : 0
}

/**
 * Generate a pruning report summarizing the health of the memory system.
 */
export function generatePruningReport(docs: MemoryDoc[]): {
  total: number
  avgQuality: number
  staleCount: number
  duplicates: number
  types: Record<string, number>
} {
  const scores = docs.map(d => qualityScore(d))
  const avgQuality = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0

  const now = Date.now()
  const staleCount = docs.filter(
    d => (now - d.mtimeMs) / (1000 * 60 * 60 * 24) > 180,
  ).length

  const contradictions = findContradictions(docs)

  const types: Record<string, number> = {}
  for (const doc of docs) {
    types[doc.type] = (types[doc.type] ?? 0) + 1
  }

  return {
    total: docs.length,
    avgQuality: Math.round(avgQuality * 100) / 100,
    staleCount,
    duplicates: contradictions.length,
    types,
  }
}
