/**
 * Compact quality validation — C3: quality feedback with auto-retry
 *
 * Validates compact summary quality after streaming completes. If quality
 * is below threshold, signals retry using the existing retry counter.
 *
 * Quality dimensions:
 * 1. Length ratio: summary should be 5-50% of original
 * 2. Information density: key entities/terms should be preserved
 * 3. Structure: summary should have coherent sentences, not fragments
 *
 * Controlled by OLA_CC_COMPACT_QUALITY env var (default: disabled).
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logEvent } from '../analytics/index.js'

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

  // 2. Information density score
  // Check that summary contains meaningful content, not just filler
  const words = summary.split(/\s+/).filter(w => w.length > 2)
  const uniqueWords = new Set(words.map(w => w.toLowerCase()))
  const uniqueRatio = words.length > 0 ? uniqueWords.size / words.length : 0
  // High unique ratio = good diversity; low = repetitive filler
  const densityScore = Math.min(1, uniqueRatio * 1.5)

  // 3. Structure score
  // Summary should have coherent sentences
  const sentences = summary
    .split(/[.!?。！？]\s+/)
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
