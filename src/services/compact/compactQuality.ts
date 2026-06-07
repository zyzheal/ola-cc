/**
 * Compact quality validation — C3: quality feedback with auto-retry
 *
 * Validates compact summary quality after streaming completes. If quality
 * is below threshold, signals retry using the existing retry counter.
 *
 * Quality dimensions:
 * 1. Length ratio: summary should be 5-50% of original
 * 2. Information density: key entities/terms should be preserved (CJK-aware)
 * 3. Structure: summary should have coherent sentences, not fragments
 *
 * P2 fix: CJK-aware tokenization for density scoring (was split(/\s+/))
 * P3 fix: sigmoid length penalty for very short summaries
 *
 * Controlled by OLA_CC_COMPACT_QUALITY env var (default: disabled).
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logEvent } from '../analytics/index.js'
import { tokenizeCJK } from '../../utils/tokenizer.js'

/** Quality score thresholds */
const QUALITY_THRESHOLDS = {
  /** Minimum acceptable quality score (0-1) */
  minScore: 0.3,
  /** Length ratio: summary / original */
  minLengthRatio: 0.05,
  maxLengthRatio: 0.50,
  /** Minimum sentence count for structural coherence */
  minSentences: 2,
  /** Minimum average sentence length (chars) */
  minAvgSentenceLength: 20,
} as const

/** P3: Sigmoid penalty constants for short-text density */
const SIGMOID_MIN_TOKENS = 10   // Below this, density penalty kicks in
const SIGMOID_K = 2             // Steepness of the sigmoid curve

export interface QualityResult {
  /** Overall quality score 0-1 */
  score: number
  /** Whether quality passes threshold */
  passes: boolean
  /** Breakdown for debugging */
  breakdown: {
    lengthRatio: number
    lengthScore: number
    densityScore: number
    structureScore: number
  }
  /** Human-readable reason if failing */
  reason?: string
}

/**
 * Check if compact quality validation is enabled.
 */
export function isCompactQualityEnabled(): boolean {
  return isEnvTruthy(process.env.OLA_CC_COMPACT_QUALITY)
}

/**
 * P3: Sigmoid penalty for very short text.
 * Returns 1.0 for normal-length text, approaches 0 for very short text.
 */
function sigmoidLengthPenalty(tokenCount: number): number {
  if (tokenCount >= SIGMOID_MIN_TOKENS) return 1.0
  const x = Math.log2(Math.max(1, tokenCount)) - Math.log2(SIGMOID_MIN_TOKENS)
  return 1 / (1 + Math.exp(-SIGMOID_K * x))
}

/**
 * Score the quality of a compact summary.
 *
 * @param summary - The compact summary text
 * @param originalTokenCount - Approximate token count of original messages
 * @param summaryTokenCount - Approximate token count of summary
 * @returns QualityResult with score and breakdown
 */
export function scoreCompactQuality(
  summary: string,
  originalTokenCount: number,
  summaryTokenCount: number,
): QualityResult {
  // 1. Length ratio score
  const lengthRatio =
    originalTokenCount > 0 ? summaryTokenCount / originalTokenCount : 0
  let lengthScore: number
  if (
    lengthRatio >= QUALITY_THRESHOLDS.minLengthRatio &&
    lengthRatio <= QUALITY_THRESHOLDS.maxLengthRatio
  ) {
    // In sweet spot — full score
    lengthScore = 1.0
  } else if (lengthRatio < QUALITY_THRESHOLDS.minLengthRatio) {
    // Too compressed — penalize proportionally
    lengthScore = lengthRatio / QUALITY_THRESHOLDS.minLengthRatio
  } else {
    // Too verbose — penalize proportionally
    lengthScore = Math.max(
      0,
      1 - (lengthRatio - QUALITY_THRESHOLDS.maxLengthRatio) / 0.5,
    )
  }

  // 2. Information density score (P2: CJK-aware tokenization)
  const tokens = tokenizeCJK(summary)
  const uniqueTokens = new Set(tokens)
  const uniqueRatio = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0
  // High unique ratio = good diversity; low = repetitive filler
  let densityScore = Math.min(1, uniqueRatio * 1.5)
  // P3: Apply sigmoid penalty for very short text
  densityScore *= sigmoidLengthPenalty(tokens.length)

  // 3. Structure score (P2: also split on newlines for markdown-style summaries)
  const sentences = summary
    .split(/[.!?。！？]\s*|\n/)
    .filter(s => s.trim().length > 0)
  const sentenceCount = sentences.length
  const avgSentenceLength =
    sentenceCount > 0 ? summary.length / sentenceCount : 0

  let structureScore = 1.0
  if (sentenceCount < QUALITY_THRESHOLDS.minSentences) {
    structureScore *= sentenceCount / QUALITY_THRESHOLDS.minSentences
  }
  if (avgSentenceLength < QUALITY_THRESHOLDS.minAvgSentenceLength) {
    structureScore *=
      avgSentenceLength / QUALITY_THRESHOLDS.minAvgSentenceLength
  }
  structureScore = Math.max(0, Math.min(1, structureScore))

  // Weighted average
  const score = lengthScore * 0.3 + densityScore * 0.4 + structureScore * 0.3
  const passes = score >= QUALITY_THRESHOLDS.minScore

  let reason: string | undefined
  if (!passes) {
    const reasons: string[] = []
    if (lengthScore < 0.5)
      reasons.push(
        `length ratio ${(lengthRatio * 100).toFixed(1)}% (expected 5-50%)`,
      )
    if (densityScore < 0.5)
      reasons.push(`low information density (${densityScore.toFixed(2)})`)
    if (structureScore < 0.5)
      reasons.push(
        `poor structure (${sentenceCount} sentences, avg ${avgSentenceLength.toFixed(0)} chars)`,
      )
    reason = reasons.join('; ')
  }

  return { score, passes, breakdown: { lengthRatio, lengthScore, densityScore, structureScore }, reason }
}

/**
 * Validate compact quality and log telemetry.
 * Returns true if quality passes, false if retry is needed.
 *
 * @param summary - The compact summary text
 * @param originalTokenCount - Approximate token count of original messages
 * @param summaryTokenCount - Approximate token count of summary
 */
export function validateCompactQuality(
  summary: string,
  originalTokenCount: number,
  summaryTokenCount: number,
): boolean {
  if (!isCompactQualityEnabled()) return true

  const result = scoreCompactQuality(
    summary,
    originalTokenCount,
    summaryTokenCount,
  )

  logEvent('tengu_compact_quality', {
    score: result.score,
    passes: result.passes,
    lengthRatio: result.breakdown.lengthRatio,
    lengthScore: result.breakdown.lengthScore,
    densityScore: result.breakdown.densityScore,
    structureScore: result.breakdown.structureScore,
    reason: result.reason ?? '',
  })

  if (!result.passes) {
    logForDebugging(
      `[compactQuality] Quality below threshold: score=${result.score.toFixed(3)}, reason=${result.reason}`,
      { level: 'warn' },
    )
  }

  return result.passes
}
