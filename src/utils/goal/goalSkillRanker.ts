/**
 * Independent skill ranking — BM25-style scoring with scenario affinity.
 * Pure function, no side effects. Results injected into continuation prompt.
 */

import type { SkillMetadata } from "./skillRegistry.js"
import type { ScenarioConfig } from "./goalScenario.js"
import { SKILL_SCENARIO_AFFINITY } from "./goalScenario.js"

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall",
  "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "not", "or", "and", "but", "if", "then", "so",
])

export interface RankedSkill {
  skill: SkillMetadata
  score: number
}

export function extractTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

export function scoreSkill(
  skill: SkillMetadata,
  terms: string[],
  scenario: ScenarioConfig,
): number {
  let score = 0
  const nameLower = skill.name.toLowerCase()
  const descLower = skill.description.toLowerCase()

  // name match (weight 100)
  if (terms.some(t => nameLower.includes(t))) score += 100

  // trigger match (weight 12)
  for (const trigger of skill.triggers) {
    if (terms.some(t => trigger.toLowerCase().includes(t))) score += 12
  }

  // description match (weight 8)
  if (terms.some(t => descLower.includes(t))) score += 8

  // scenario affinity (weight 40)
  const affinity = SKILL_SCENARIO_AFFINITY[skill.name]?.[scenario.type] ?? 0
  score += affinity * 40

  // priority bonus
  score += (skill.priority / 10) * 20

  return score
}

export function rankSkills(
  query: string,
  availableSkills: SkillMetadata[],
  scenario: ScenarioConfig,
  limit: number = 5,
): RankedSkill[] {
  const terms = extractTerms(query)
  return availableSkills
    .map(skill => ({ skill, score: scoreSkill(skill, terms, scenario) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// Affinity matrix imported from goalScenario.ts (single source of truth)
