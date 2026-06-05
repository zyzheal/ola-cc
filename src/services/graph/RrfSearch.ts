/**
 * RrfSearch — Reciprocal Rank Fusion for hybrid search
 *
 * Fuses results from FTS5 (text), BM25 (weighted text), and
 * graph-based signals into a single ranked list.
 *
 * RRF formula: score(d) = sum(1 / (k + rank_i(d))) across all ranking signals.
 *
 * F-82: RRF Hybrid Search Fusion
 */

import type { FtsSearch, SearchResult } from './FtsSearch.js'
import type { GraphStore } from './GraphStore.js'

// ============================================================
// Case pattern detection
// ============================================================

/** Detect naming convention of query to boost matching kinds */
function detectCasePattern(query: string): 'pascal' | 'snake' | 'camel' | 'none' {
  const trimmed = query.trim()
  if (!trimmed) return 'none'

  // PascalCase: starts with uppercase, no underscores, has lowercase after
  if (/^[A-Z][a-z]/.test(trimmed) && !trimmed.includes('_')) return 'pascal'

  // snake_case: contains underscores
  if (trimmed.includes('_')) return 'snake'

  // camelCase: starts with lowercase, no underscores, has uppercase
  if (/^[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) && !trimmed.includes('_')) return 'camel'

  return 'none'
}

/** Get kind boosts based on naming convention */
function getKindBoosts(query: string): Map<string, number> {
  const pattern = detectCasePattern(query)
  const boosts = new Map<string, number>()

  switch (pattern) {
    case 'pascal':
      boosts.set('class', 2.0)
      boosts.set('interface', 2.0)
      boosts.set('type', 1.5)
      break
    case 'snake':
      boosts.set('function', 2.0)
      boosts.set('method', 2.0)
      boosts.set('variable', 1.5)
      break
    case 'camel':
      boosts.set('method', 2.0)
      boosts.set('property', 1.5)
      break
  }

  return boosts
}

// ============================================================
// RrfSearch
// ============================================================

export class RrfSearch {
  constructor(
    private fts: FtsSearch,
    private store: GraphStore,
    private k: number = 60, // RRF constant
  ) {}

  /**
   * Fuse FTS5 + BM25 + graph-based signals using RRF.
   *
   * Signals:
   *  1. FTS5 text relevance (default rank)
   *  2. BM25 weighted relevance
   *  3. Graph signal: PageRank-like in-degree as tiebreaker
   *  4. Kind-based boosting from naming convention
   */
  search(query: string, limit = 20): SearchResult[] {
    // Signal 1: FTS5 basic search
    const ftsResults = this.fts.search(query, limit * 3)
    // Signal 2: BM25 weighted search
    const bm25Results = this.fts.searchWithBM25(query, limit * 3)

    // Build rank maps: id → 1-based rank
    const ftsRank = new Map<string, number>()
    ftsResults.forEach((r, i) => ftsRank.set(r.id, i + 1))

    const bm25Rank = new Map<string, number>()
    bm25Results.forEach((r, i) => bm25Rank.set(r.id, i + 1))

    // Collect all unique IDs
    const allIds = new Set<string>([...ftsRank.keys(), ...bm25Rank.keys()])

    // Kind boosts from naming convention
    const kindBoosts = getKindBoosts(query)

    // Compute RRF scores
    const rrfScores = new Map<string, number>()
    const resultMap = new Map<string, SearchResult>()

    for (const id of allIds) {
      let score = 0

      // Signal 1: FTS5 rank
      const fR = ftsRank.get(id)
      if (fR !== undefined) score += 1 / (this.k + fR)

      // Signal 2: BM25 rank
      const bR = bm25Rank.get(id)
      if (bR !== undefined) score += 1 / (this.k + bR)

      // Signal 3: Graph signal — in-degree as proxy for importance
      const inDegree = this.store.getInDegree(id)
      if (inDegree > 0) {
        // Treat in-degree as a rank signal (rank = 1/(1+log(inDegree)))
        const graphRank = Math.max(1, Math.floor(1 + Math.log2(inDegree)))
        score += 1 / (this.k + graphRank)
      }

      // Signal 4: Kind-based boost
      const meta = this.store.getNode(id)
      if (meta) {
        const kindBoost = kindBoosts.get(meta.kind) ?? 1.0
        score *= kindBoost

        resultMap.set(id, {
          id,
          name: meta.name,
          kind: meta.kind,
          file: meta.file,
          line: meta.line,
          score,
        })
      } else {
        // Use result from FTS or BM25 for metadata
        const src = ftsResults.find(r => r.id === id) ?? bm25Results.find(r => r.id === id)
        if (src) {
          resultMap.set(id, { ...src, score })
        }
      }

      rrfScores.set(id, score)
    }

    // Sort by RRF score descending, return top N
    return [...resultMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}
