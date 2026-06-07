/**
 * Memory retention scoring — ported from AgentMemory retention.ts
 *
 * Implements the retention decay formula:
 *   retention = min(1, salience * exp(-λ*t) + σ * Σ(1/max(0.01, days)))
 *
 * Key corrections from v6 review (B1):
 * - λ = 0.5 (not 0.005 — original has zero decay for 1-3 hour sessions)
 * - σ = 0.3 (reinforcement coefficient)
 * - singularity fix: 1/max(0.01, days) prevents division by zero
 * - boost total cap: min(boost, MAX_BOOST) prevents runaway reinforcement
 *
 * Salience weights by memory type (from AgentMemory TYPE_SALIENCE):
 */

/** Salience weights per memory type */
export const TYPE_SALIENCE: Record<string, number> = {
  architecture: 0.90,
  preference:   0.85,
  pattern:      0.80,
  user:         0.80,
  feedback:     0.70,
  bug:          0.70,
  project:      0.65,
  workflow:     0.60,
  reference:    0.50,
  fact:         0.50,
}

/** Retention tiers */
export const RETENTION_TIERS = {
  hot:       0.70,
  warm:      0.40,
  cold:      0.15,
  evictable: 0,
} as const

export type RetentionTier = keyof typeof RETENTION_TIERS

/** Default retention parameters */
const DEFAULT_PARAMS = {
  lambda: 0.5,        // Decay rate (v6 corrected: 0.5 not 0.005)
  sigma: 0.3,         // Reinforcement coefficient
  maxBoost: 0.5,      // Maximum total reinforcement boost (B1-2 fix)
  maxAccessWindow: 30, // Only count accesses within last N days
} as const

export interface RetentionInput {
  /** Memory type (key into TYPE_SALIENCE) */
  type: string
  /** Days since memory was created */
  daysSinceCreation: number
  /** Timestamps of recent accesses (epoch ms) */
  accessTimestamps?: number[]
  /** Override default params */
  params?: Partial<typeof DEFAULT_PARAMS>
}

export interface RetentionResult {
  /** Retention score in [0, 1] */
  score: number
  /** Retention tier */
  tier: RetentionTier
  /** Breakdown for debugging */
  breakdown: {
    salience: number
    decayFactor: number
    reinforcementBoost: number
    rawScore: number
  }
}

/**
 * Compute retention score for a memory entry.
 *
 * Formula: retention = min(1, salience * exp(-λ*t) + σ * Σ(1/max(0.01, days)))
 *
 * @returns RetentionResult with score, tier, and breakdown
 */
export function computeRetention(input: RetentionInput): RetentionResult {
  const p = { ...DEFAULT_PARAMS, ...input.params }
  const salience = TYPE_SALIENCE[input.type] ?? TYPE_SALIENCE.fact

  // Decay: salience * exp(-λ * days)
  const decayFactor = Math.exp(-p.lambda * input.daysSinceCreation)
  const decayedSalience = salience * decayFactor

  // Reinforcement: σ * Σ(1/max(0.01, daysSinceAccess_i))
  let boost = 0
  if (input.accessTimestamps && input.accessTimestamps.length > 0) {
    const now = Date.now()
    const windowMs = p.maxAccessWindow * 24 * 60 * 60 * 1000

    for (const ts of input.accessTimestamps) {
      const daysSince = (now - ts) / (24 * 60 * 60 * 1000)
      // Only count accesses within the window
      if (daysSince > p.maxAccessWindow) continue
      // Singularity fix: 1/max(0.01, days) prevents division by zero
      boost += 1 / Math.max(0.01, daysSince)
    }

    boost *= p.sigma
    // B1-2 fix: cap total boost to prevent runaway reinforcement
    boost = Math.min(boost, p.maxBoost)
  }

  const rawScore = decayedSalience + boost
  const score = Math.min(1, Math.max(0, rawScore))

  return {
    score,
    tier: getTier(score),
    breakdown: {
      salience,
      decayFactor,
      reinforcementBoost: boost,
      rawScore,
    },
  }
}

/**
 * Classify a retention score into a tier.
 */
export function getTier(score: number): RetentionTier {
  if (score >= RETENTION_TIERS.hot) return 'hot'
  if (score >= RETENTION_TIERS.warm) return 'warm'
  if (score >= RETENTION_TIERS.cold) return 'cold'
  return 'evictable'
}
