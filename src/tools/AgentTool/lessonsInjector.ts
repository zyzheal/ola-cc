/**
 * Lessons injector — A1: inject relevant lessons into agent system prompt
 *
 * Reads lessons from the LearningSystem's contrast analysis and formats
 * them as a prompt section to be appended to the agent's system prompt.
 *
 * Controlled by OLA_CC_LESSONS_INJECT env var (default: disabled).
 * Depends on OLA_CC_LESSON_DECAY for stale lesson filtering.
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { LearningSystem } from './LearningSystem.js'

/**
 * Check if lessons injection is enabled.
 */
export function isLessonsInjectEnabled(): boolean {
  return isEnvTruthy(process.env.OLA_CC_LESSONS_INJECT)
}

/**
 * Load lessons for a given skill/agent type and format as prompt text.
 *
 * Creates a LearningSystem instance, loads execution history from disk,
 * runs contrast analysis, and formats the result as a prompt section.
 *
 * @param skill - The skill/agent type to get lessons for
 * @returns Formatted lessons string, or empty string if no lessons available
 */
export function loadLessonsPrompt(skill: string): string {
  try {
    const ls = new LearningSystem({ enablePersistence: true })
    ls.loadFromDisk(skill)

    const contrast = ls.contrastAnalysis(skill)

    if (!contrast.delta) {
      return ''
    }

    const parts: string[] = []

    if (contrast.delta.uniqueToWinners.length > 0) {
      parts.push(
        `## Successful Patterns (from ${contrast.delta.winnerCount} successful executions)`,
        ...contrast.delta.uniqueToWinners.map(s => `- ${s}`),
      )
    }

    if (contrast.delta.uniqueToLosers.length > 0) {
      parts.push(
        `## Patterns to Avoid (from ${contrast.delta.loserCount} failed executions)`,
        ...contrast.delta.uniqueToLosers.map(s => `- ${s}`),
      )
    }

    if (parts.length === 0) {
      return ''
    }

    return [
      '',
      '## Execution History Lessons',
      contrast.insight,
      '',
      ...parts,
      '',
      'Apply these lessons to improve your approach. Prefer patterns from successful executions and avoid patterns from failures.',
    ].join('\n')
  } catch {
    // Lessons loading failure should never block agent execution
    return ''
  }
}
