/**
 * Description validator for skills.
 *
 * Validates that skill descriptions follow the anti-confusion guidelines:
 * 1. Contain an exclusion statement ("does not do X")
 * 2. Contain a scope/context statement ("use when Y")
 *
 * All violations are WARNING level — skills load normally, but developers
 * see guidance on how to improve their descriptions.
 */

import { logForDebugging } from '../utils/debug.js'

/**
 * Regex patterns for exclusion statements.
 * Matches any of these patterns in Chinese or English.
 */
const EXCLUSION_PATTERNS = [
  // Direct negation: "不做/不使用/不负责/不涉及/不是/不直接"
  /不[做使用负责涉及是直接]/,
  // English exclusion: "not responsible", "exclude", "does not handle", contractions
  /not\s+(responsible|for)/i,
  /exclude/i,
  /does\s+not\s+(handle|cover)/i,
  /doesn'?t\s+(handle|cover|include)/i,
  /is\s+not\s+(responsible|for)/i,
  /isn'?t\s+(responsible|for)/i,
  /out(?:side)?\s+(?:the\s+)?scope/i,
  // Delegation: "用 XXX 替代/用 XXX 代替/use XXX instead/转交/交给/delegate to"
  /用.+替代/,
  /用.+代替/,
  /use\s+.+\s+instead/i,
  /转交/,
  /交给/,
  /delegate\s+to/i,
]

/**
 * Regex patterns for scope/context statements.
 */
const SCOPE_PATTERNS = [
  // Chinese scope: "当/当用户/使用场景/适用于"
  /当/,
  /使用场景/,
  /适用于/,
  // English scope: "use when", "when user"
  /use\s+when/i,
  /when\s+(the\s+)?user/i,
  // Trigger declaration: "Trigger:" / "触发:" / "触发词:"
  /trigger\s*:/i,
  /触发[词]?：?/,
]

export type DescriptionValidationResult = {
  hasExclusion: boolean
  hasScope: boolean
  suggestions: string[]
}

/**
 * Validate a skill description. Returns results with suggestions.
 */
export function validateDescription(
  description: string,
  whenToUse: string | undefined,
  skillName: string,
): DescriptionValidationResult {
  const result: DescriptionValidationResult = {
    hasExclusion: false,
    hasScope: false,
    suggestions: [],
  }

  // Check exclusion patterns
  for (const pattern of EXCLUSION_PATTERNS) {
    if (pattern.test(description)) {
      result.hasExclusion = true
      break
    }
  }

  // Check scope patterns in description
  for (const pattern of SCOPE_PATTERNS) {
    if (pattern.test(description)) {
      result.hasScope = true
      break
    }
  }

  // when_to_use field counts as scope coverage
  if (!result.hasScope && whenToUse && whenToUse.length > 0) {
    result.hasScope = true
  }

  // Generate suggestions
  if (!result.hasExclusion) {
    result.suggestions.push(
      `Description lacks an exclusion statement (what this skill does NOT do). ` +
        `Consider adding phrases like "不做XXX", "use XXX instead", or "转交 XXX".`,
    )
  }
  if (!result.hasScope) {
    result.suggestions.push(
      `Description lacks a scope statement (when to use this skill). ` +
        `Consider adding "当...", "适用于...", "Trigger:", or filling the when_to_use field.`,
    )
  }

  // Log warnings
  if (result.suggestions.length > 0) {
    logForDebugging(
      `[description validator] Skill '${skillName}': ${result.suggestions.join(' ')}`,
      { level: 'warn' },
    )
  }

  return result
}
