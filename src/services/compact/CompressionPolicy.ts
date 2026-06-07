/**
 * Compression policy — C4: tier-based compression strategy
 *
 * Different users/sessions need different compression aggressiveness:
 * - Free tier: aggressive compression (lower buffer)
 * - Paid tier: conservative compression (higher buffer)
 * - Long-session: priority on not exceeding limits
 *
 * Controlled by OLA_CC_COMPRESSION_POLICY env var (default: disabled).
 *
 * Priority chain:
 * 1. OLA_CC_AUTO_COMPACT_WINDOW env var (highest)
 * 2. GrowthBook auto_compact_buffer_tokens
 * 3. CompressionPolicy per-tier calculation
 * 4. Hardcoded 40K default (lowest)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

/** Compression tiers */
export type CompressionTier = 'free' | 'paid' | 'long-session'

/** Policy configuration per tier */
interface TierConfig {
  /** Buffer tokens before auto-compact triggers */
  bufferTokens: number
  /** Maximum token count for compact output */
  maxCompactTokens: number
  /** Whether to use aggressive micro-compact */
  aggressiveMicroCompact: boolean
}

/** Default tier configurations */
const TIER_CONFIGS: Record<CompressionTier, TierConfig> = {
  free: {
    bufferTokens: 20_000,
    maxCompactTokens: 30_000,
    aggressiveMicroCompact: true,
  },
  paid: {
    bufferTokens: 60_000,
    maxCompactTokens: 50_000,
    aggressiveMicroCompact: false,
  },
  'long-session': {
    bufferTokens: 40_000,
    maxCompactTokens: 40_000,
    aggressiveMicroCompact: false,
  },
}

/** Default fallback values (when policy is disabled) */
export const DEFAULT_BUFFER_TOKENS = 40_000
export const DEFAULT_MAX_COMPACT_TOKENS = 50_000

/**
 * Check if compression policy is enabled.
 */
export function isCompressionPolicyEnabled(): boolean {
  return isEnvTruthy(process.env.OLA_CC_COMPRESSION_POLICY)
}

/**
 * Detect the compression tier for the current session.
 *
 * @param sessionAge - Session age in minutes
 * @param messageCount - Number of messages in conversation
 * @param isPaidUser - Whether user is on a paid tier
 * @returns The detected compression tier
 */
export function detectTier(
  sessionAge: number,
  messageCount: number,
  isPaidUser: boolean,
): CompressionTier {
  // Long-session detection: >60 minutes or >100 messages
  if (sessionAge > 60 || messageCount > 100) {
    return 'long-session'
  }

  return isPaidUser ? 'paid' : 'free'
}

/**
 * Get buffer tokens from the compression policy.
 *
 * Falls back through the priority chain:
 * 1. envOverride (from OLA_CC_AUTO_COMPACT_WINDOW)
 * 2. growthBookValue (from GrowthBook feature flag)
 * 3. Policy per-tier calculation
 * 4. Hardcoded default
 *
 * @param tier - The compression tier
 * @param envOverride - Value from OLA_CC_AUTO_COMPACT_WINDOW env var
 * @param growthBookValue - Value from GrowthBook feature flag
 * @returns Buffer token count
 */
export function getPolicyBufferTokens(
  tier: CompressionTier,
  envOverride?: number,
  growthBookValue?: number,
): number {
  // Priority 1: env var override
  if (envOverride !== undefined && envOverride > 0) {
    return envOverride
  }

  // Priority 2: GrowthBook value
  if (growthBookValue !== undefined && growthBookValue > 0) {
    return growthBookValue
  }

  // Priority 3: Policy per-tier
  if (isCompressionPolicyEnabled()) {
    return TIER_CONFIGS[tier].bufferTokens
  }

  // Priority 4: hardcoded default
  return DEFAULT_BUFFER_TOKENS
}

/**
 * Get max compact tokens from the compression policy.
 *
 * @param tier - The compression tier
 * @returns Maximum compact output tokens
 */
export function getPolicyMaxCompactTokens(tier: CompressionTier): number {
  if (!isCompressionPolicyEnabled()) {
    return DEFAULT_MAX_COMPACT_TOKENS
  }
  return TIER_CONFIGS[tier].maxCompactTokens
}

/**
 * Check if aggressive micro-compact should be used.
 *
 * @param tier - The compression tier
 * @returns Whether to use aggressive micro-compact
 */
export function shouldUseAggressiveMicroCompact(tier: CompressionTier): boolean {
  if (!isCompressionPolicyEnabled()) {
    return false
  }
  return TIER_CONFIGS[tier].aggressiveMicroCompact
}

/**
 * Get the full policy for a tier (for debugging/logging).
 */
export function getPolicyConfig(tier: CompressionTier): TierConfig {
  return { ...TIER_CONFIGS[tier] }
}
