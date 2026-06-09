/**
 * Hybrid relevance scorer with adaptive alpha tuning.
 *
 * Design based on Headroom's HybridScorer pattern:
 * - BM25-style term frequency scoring with k1/b normalization
 * - Adaptive alpha: query content analysis adjusts keyword vs semantic weight
 * - Long-token bonus for UUIDs, hashes, and technical identifiers
 * - BM25-only fallback (no embedding dependency)
 *
 * Integrated into toolRanker.ts for improved tool selection relevance.
 */

// ── BM25 Configuration (calibrated against Headroom) ──

/** Term frequency saturation parameter. Higher = more reward for repeated terms. */
const BM25_K1 = 1.5

/** Document length normalization. 0 = no normalization, 1 = full normalization. */
const BM25_B = 0.75

/** Maximum score for normalization to [0, 1] range. */
const BM25_MAX_SCORE = 10.0

/** Bonus for long technical tokens (UUIDs, hashes, etc.) */
const LONG_TOKEN_BONUS = 0.3

/** Minimum token length to qualify for long-token bonus. */
const LONG_TOKEN_MIN_LENGTH = 8

// ── Adaptive Alpha Thresholds ──

/**
 * Alpha controls the blend: score = alpha * keywordScore + (1-alpha) * semanticScore
 * Higher alpha = more weight on keyword/BM25 matching.
 *
 * Headroom's adaptive logic:
 * - UUID-heavy queries → 0.85 (keywords are precise for exact IDs)
 * - Numeric ID queries → 0.75 (numbers match well by keyword)
 * - Hostname queries → 0.6 (hostnames are semi-semantic)
 * - Default → 0.5 (balanced)
 */
const ALPHA_DEFAULT = 0.5
const ALPHA_UUID = 0.85
const ALPHA_NUMERIC_ID = 0.75
const ALPHA_HOSTNAME = 0.6

// ── Pattern Detection ──

/** UUID pattern: 8-4-4-4-12 hex */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Numeric ID pattern: standalone numbers ≥ 3 digits (issue numbers, PIDs, etc.) */
const NUMERIC_ID_PATTERN = /\b\d{3,}\b/

/** Hostname pattern: word.word.tld or IP addresses */
const HOSTNAME_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i

/** Hex hash pattern: 16+ hex chars (SHA, MD5 prefixes, etc.) */
const HEX_HASH_PATTERN = /\b[0-9a-f]{16,}\b/i

// ── Types ──

export interface ScoringContext {
  /** Query terms extracted from user input */
  queryTerms: string[]
  /** Pre-compiled regex patterns per term */
  termPatterns: Map<string, RegExp>
  /** Average document length in the corpus (for BM25 normalization) */
  avgDocLength: number
}

export interface HybridScore {
  /** Final blended score */
  score: number
  /** Keyword/BM25 component */
  keywordScore: number
  /** Adaptive alpha used for this query */
  alpha: number
  /** Detected query characteristics */
  queryType: 'uuid' | 'numeric' | 'hostname' | 'mixed' | 'default'
}

// ── Query Analysis ──

/**
 * Analyze query content to determine adaptive alpha.
 * Mirrors Headroom's per-query alpha adjustment logic.
 */
export function analyzeQueryAlpha(query: string): {
  alpha: number
  queryType: HybridScore['queryType']
} {
  const hasUUID = UUID_PATTERN.test(query)
  const hasNumericID = NUMERIC_ID_PATTERN.test(query)
  const hasHostname = HOSTNAME_PATTERN.test(query)

  if (hasUUID && !hasNumericID && !hasHostname) {
    return { alpha: ALPHA_UUID, queryType: 'uuid' }
  }
  if (hasNumericID && !hasUUID && !hasHostname) {
    return { alpha: ALPHA_NUMERIC_ID, queryType: 'numeric' }
  }
  if (hasHostname && !hasUUID && !hasNumericID) {
    return { alpha: ALPHA_HOSTNAME, queryType: 'hostname' }
  }
  if (hasUUID || hasNumericID || hasHostname) {
    // Multiple types detected — use weighted average偏向 keyword
    return { alpha: 0.7, queryType: 'mixed' }
  }
  return { alpha: ALPHA_DEFAULT, queryType: 'default' }
}

// ── BM25 Scoring ──

/**
 * Compute BM25 score for a document against query terms.
 *
 * BM25 formula per term:
 *   idf(term) = ln((N - df + 0.5) / (df + 0.5) + 1)
 *   tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl/avgdl))
 *   score += idf * tf_norm
 *
 * Simplified for tool ranking (we don't have corpus-wide df):
 * - Treat each tool as a document
 * - Use binary presence (0/1) for df since we don't track corpus stats
 * - Focus on term frequency in tool name + description
 */
export function computeBM25Score(
  text: string,
  queryTerms: string[],
  termPatterns: Map<string, RegExp>,
  docLength: number,
  avgDocLength: number,
): number {
  if (queryTerms.length === 0 || text.length === 0) return 0

  let score = 0
  const textLower = text.toLowerCase()

  for (const term of queryTerms) {
    const pattern = termPatterns.get(term)
    if (!pattern) continue

    // Count term frequency without allocating new RegExp per call.
    // Use indexOf + word boundary check (matches the pre-compiled pattern's intent).
    let tf = 0
    let pos = 0
    const termLower = term.toLowerCase()
    while (pos < textLower.length) {
      const idx = textLower.indexOf(termLower, pos)
      if (idx === -1) break
      // Word boundary check: same logic as extractTerms' pattern
      const beforeOk = idx === 0 || !/[a-z0-9_]/.test(textLower[idx - 1]!)
      const afterIdx = idx + termLower.length
      const afterOk =
        afterIdx >= textLower.length || !/[a-z0-9_]/.test(textLower[afterIdx]!)
      if (beforeOk && afterOk) tf++
      pos = idx + 1
    }
    if (tf === 0) continue

    // Simplified IDF: assume term appears in ~30% of documents
    // This gives a reasonable boost for rare terms
    const N = 100 // Assumed corpus size
    const df = 30  // Assumed document frequency
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)

    // TF normalization with BM25 parameters
    const tfNorm =
      (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength)))

    score += idf * tfNorm

    // Long-token bonus for technical identifiers
    if (term.length >= LONG_TOKEN_MIN_LENGTH && HEX_HASH_PATTERN.test(term)) {
      score += LONG_TOKEN_BONUS
    }
  }

  return score
}

/**
 * Normalize BM25 score to [0, 1] range.
 */
export function normalizeBM25Score(score: number): number {
  return Math.min(1.0, score / BM25_MAX_SCORE)
}

// ── Hybrid Scorer ──

/**
 * Compute hybrid relevance score for a tool.
 *
 * Since ola-cc doesn't have embedding infrastructure, this uses
 * BM25-only scoring with adaptive alpha prepared for future
 * embedding integration.
 *
 * The alpha value is computed but currently only affects score
 * normalization — when embeddings are added, the blend formula
 * becomes: alpha * bm25 + (1-alpha) * embedding
 */
export function computeHybridScore(
  toolText: string,
  context: ScoringContext,
): HybridScore {
  const { queryTerms, termPatterns, avgDocLength } = context
  const queryStr = queryTerms.join(' ')

  // Analyze query for adaptive alpha
  const { alpha, queryType } = analyzeQueryAlpha(queryStr)

  // Compute BM25 score
  const docLength = toolText.length
  const rawBM25 = computeBM25Score(
    toolText,
    queryTerms,
    termPatterns,
    docLength,
    avgDocLength,
  )
  const keywordScore = normalizeBM25Score(rawBM25)

  // BM25-only mode: score = keywordScore
  // When embeddings are available: score = alpha * keywordScore + (1-alpha) * embeddingScore
  const score = keywordScore

  return { score, keywordScore, alpha, queryType }
}

// ── Utility: Average Document Length ──

/**
 * Compute average document length across a corpus of tool texts.
 * Used for BM25 length normalization.
 */
export function computeAverageDocLength(texts: string[]): number {
  if (texts.length === 0) return 1
  const totalLength = texts.reduce((sum, t) => sum + t.length, 0)
  return Math.max(1, totalLength / texts.length)
}
