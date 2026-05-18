import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isThirdPartyProvider } from '../../utils/model/providers.js'

/**
 * Resolve the model to use for context compaction.
 *
 * Strategy:
 * 1. If kill-switch enabled, use main loop model
 * 2. If third-party provider (DashScope, DeepSeek, etc.), use main loop model
 *    (their endpoints don't support arbitrary Claude model names)
 * 3. If main loop is already using Sonnet or Haiku, use it directly
 * 4. Otherwise, use OLA_CC_COMPACT_MODEL env var if set, falling back to main loop model
 *
 * This avoids hardcoding specific Claude model names which may not be available
 * on third-party proxy endpoints.
 */
export function resolveCompactModel(
  mainLoopModel: string,
): { model: string; reason: string } {
  // Kill-switch: disable routing if user explicitly opted out
  const useMainModel = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_use_main_model',
    false,
  )
  if (useMainModel) {
    return { model: mainLoopModel, reason: 'kill-switch' }
  }

  // Third-party providers (DashScope, DeepSeek, etc.) don't support arbitrary
  // Claude model names — use the main loop model directly
  if (isThirdPartyProvider()) {
    return { model: mainLoopModel, reason: 'third-party-provider' }
  }

  // If main loop is already using Sonnet or Haiku, no routing needed
  const lower = mainLoopModel.toLowerCase()
  if (lower.includes('sonnet') || lower.includes('haiku')) {
    return { model: mainLoopModel, reason: 'already-cheap' }
  }

  // User-provided compact model override, or fall back to main loop model
  const compactModel = process.env.OLA_CC_COMPACT_MODEL
  if (compactModel) {
    return { model: compactModel, reason: 'env-override' }
  }

  // Default: use the same model as the main loop
  return { model: mainLoopModel, reason: 'default-to-main' }
}

/**
 * Generate a slimmed-down compact prompt for simple contexts.
 *
 * The default BASE_COMPACT_PROMPT is ~2500 tokens with detailed analysis
 * instructions. For simple conversations (few tool calls, clear requests),
 * we can use a shorter prompt that saves 1-2K tokens per compaction.
 */
export function selectCompactPrompt(opts: {
  toolCallCount: number
  messageCount: number
  hasComplexRequest: boolean
}): 'detailed' | 'slim' {
  // Use slim prompt when conversation is simple
  if (
    opts.toolCallCount <= 3 &&
    opts.messageCount <= 6 &&
    !opts.hasComplexRequest
  ) {
    return 'slim'
  }
  return 'detailed'
}

/**
 * Slim compact prompt (~800 tokens vs ~2500 for detailed).
 */
export const SLIM_COMPACT_PROMPT = `Summarize this conversation for context compression.

Include:
- What the user asked for
- What files were read/modified (with full paths)
- Key decisions and outcomes
- Current task status and next steps

Omit:
- Intermediate reasoning that led to correct conclusions
- Failed tool calls that were immediately retried
- Repetitive messages

Format your summary as a concise <summary> block covering the points above.`
