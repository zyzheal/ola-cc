/**
 * Adaptive compression sizer — B3: Kneedle information saturation detection
 *
 * Instead of fixed truncation thresholds, uses the Kneedle algorithm to find
 * the optimal compression point where information loss starts to increase
 * rapidly (the "elbow" in the information curve).
 *
 * The algorithm:
 * 1. Compute information density at multiple compression levels
 * 2. Normalize both axes to [0, 1]
 * 3. Find the point maximizing (y_norm - x_norm) — the "knee"
 * 4. Use that point as the optimal compression target
 *
 * Controlled by OLA_CC_ADAPTIVE_COMPRESS env var (default: disabled).
 *
 * Based on the Kneedle algorithm from:
 * "Finding a 'Kneedle' in a Haystack" (Satopaa et al., 2011)
 */

import { isEnvTruthy } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

/** Information density sample at a compression level */
export interface DensitySample {
  /** Compression level (0 = no compression, 1 = maximum compression) */
  compressionLevel: number
  /** Information density score (0-1, higher = more information retained) */
  density: number
}

/** Result of Kneedle analysis */
export interface KneedleResult {
  /** Optimal compression level (0-1) */
  optimalLevel: number
  /** Information density at the optimal point */
  densityAtOptimal: number
  /** All samples used for analysis */
  samples: DensitySample[]
  /** Whether a clear knee was found */
  kneeFound: boolean
}

/**
 * Check if adaptive compression is enabled.
 */
export function isAdaptiveCompressEnabled(): boolean {
  return isEnvTruthy(process.env.OLA_CC_ADAPTIVE_COMPRESS)
}

/**
 * Compute information density for a text at a given compression level.
 *
 * Uses a simplified heuristic: count unique meaningful tokens as a proxy
 * for information content. At higher compression levels, more tokens are
 * removed, reducing density.
 *
 * @param text - The text to analyze
 * @param level - Compression level (0-1)
 * @returns Information density score (0-1)
 */
export function computeDensity(text: string, level: number): number {
  if (!text || level <= 0) return 1.0
  if (level >= 1) return 0

  // Tokenize: split by whitespace, filter short tokens
  const tokens = text.split(/\s+/).filter(t => t.length > 2)
  if (tokens.length === 0) return 0

  // Simulate compression by removing tokens proportionally
  // Higher-frequency tokens (more unique) are kept longer
  const uniqueTokens = new Map<string, number>()
  for (const token of tokens) {
    const lower = token.toLowerCase()
    uniqueTokens.set(lower, (uniqueTokens.get(lower) ?? 0) + 1)
  }

  // Sort by frequency (descending) — rare tokens are removed first
  const sorted = [...uniqueTokens.entries()].sort((a, b) => b[1] - a[1])

  // At compression level L, keep top (1-L) fraction of unique tokens
  const keepCount = Math.max(1, Math.round(sorted.length * (1 - level)))
  const keptTokens = new Set(sorted.slice(0, keepCount).map(([t]) => t))

  // Count how many original tokens are retained
  let retained = 0
  for (const token of tokens) {
    if (keptTokens.has(token.toLowerCase())) retained++
  }

  return retained / tokens.length
}

/**
 * Run Kneedle analysis to find optimal compression level.
 *
 * Samples information density at multiple compression levels, then finds
 * the "elbow" point where the rate of information loss accelerates.
 *
 * @param text - The text to compress
 * @param sampleCount - Number of samples to take (default: 10)
 * @returns KneedleResult with optimal level and samples
 */
export function findOptimalCompression(
  text: string,
  sampleCount: number = 10,
): KneedleResult {
  // Step 1: Sample density at multiple levels
  const samples: DensitySample[] = []
  for (let i = 0; i <= sampleCount; i++) {
    const level = i / sampleCount
    const density = computeDensity(text, level)
    samples.push({ compressionLevel: level, density })
  }

  // Step 2: Normalize both axes to [0, 1]
  const maxLevel = 1.0
  const minDensity = Math.min(...samples.map(s => s.density))
  const maxDensity = Math.max(...samples.map(s => s.density))
  const densityRange = maxDensity - minDensity || 1

  const normalized = samples.map(s => ({
    x: s.compressionLevel / maxLevel,
    y: (s.density - minDensity) / densityRange,
  }))

  // Step 3: Find the knee — maximum (y_norm - x_norm)
  // This is the point where the curve deviates most from the diagonal
  let maxDiff = -Infinity
  let kneeIndex = 0

  for (let i = 0; i < normalized.length; i++) {
    const diff = normalized[i]!.y - normalized[i]!.x
    if (diff > maxDiff) {
      maxDiff = diff
      kneeIndex = i
    }
  }

  // Step 4: Check if a clear knee was found
  // A clear knee means the difference is significant (> 0.1)
  const kneeFound = maxDiff > 0.1

  const optimalLevel = samples[kneeIndex]!.compressionLevel
  const densityAtOptimal = samples[kneeIndex]!.density

  // If no clear knee found, use a conservative default
  const finalLevel = kneeFound ? optimalLevel : 0.3

  logForDebugging(
    `[adaptiveSizer] Kneedle: optimal=${finalLevel.toFixed(2)}, density=${densityAtOptimal.toFixed(3)}, kneeFound=${kneeFound}, maxDiff=${maxDiff.toFixed(3)}`,
  )

  return {
    optimalLevel: finalLevel,
    densityAtOptimal,
    samples,
    kneeFound,
  }
}

/**
 * Compute optimal token budget for compression.
 *
 * Uses Kneedle analysis to determine how much to compress, then converts
 * the compression level to a target token count.
 *
 * @param text - The text to compress
 * @param currentTokens - Current token count
 * @param minTokens - Minimum acceptable token count
 * @param maxTokens - Maximum token count
 * @returns Optimal target token count
 */
export function computeOptimalTokenBudget(
  text: string,
  currentTokens: number,
  minTokens: number = 1000,
  maxTokens: number = 50_000,
): number {
  if (!isAdaptiveCompressEnabled()) {
    return maxTokens
  }

  const result = findOptimalCompression(text)

  // Convert compression level to token budget
  // level 0 = keep all (currentTokens)
  // level 1 = keep nothing (minTokens)
  const budget = Math.round(
    currentTokens * (1 - result.optimalLevel) + minTokens * result.optimalLevel,
  )

  // Clamp to bounds
  return Math.max(minTokens, Math.min(maxTokens, budget))
}
