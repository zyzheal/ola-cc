/**
 * Independent skill ranking — BM25-style scoring with scenario affinity.
 * Pure function, no side effects. Results injected into continuation prompt.
 */

import type { SkillMetadata } from "./skillRegistry.js"
import type { ScenarioConfig } from "./goalScenario.js"

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

/** 17 skills × 5 scenarios affinity matrix from design doc §4.3 */
const SKILL_SCENARIO_AFFINITY: Record<string, Record<string, number>> = {
  "systematic-debugging":         { code_change: 0.3, doc_writing: 0.0, troubleshooting: 1.0, design_improve: 0.1, refactoring: 0.3 },
  "brainstorming":                { code_change: 0.4, doc_writing: 0.3, troubleshooting: 0.1, design_improve: 1.0, refactoring: 0.2 },
  "test-driven-development":      { code_change: 0.9, doc_writing: 0.0, troubleshooting: 0.5, design_improve: 0.1, refactoring: 0.8 },
  "verification-before-completion": { code_change: 0.8, doc_writing: 0.4, troubleshooting: 0.6, design_improve: 0.3, refactoring: 0.8 },
  "requesting-code-review":       { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.7 },
  "writing-plans":                { code_change: 0.5, doc_writing: 0.5, troubleshooting: 0.2, design_improve: 0.8, refactoring: 0.6 },
  "executing-plans":              { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.6 },
  "design-constraint":            { code_change: 0.5, doc_writing: 0.2, troubleshooting: 0.2, design_improve: 0.9, refactoring: 0.7 },
  "design-doc-reviewer":          { code_change: 0.2, doc_writing: 0.8, troubleshooting: 0.1, design_improve: 0.9, refactoring: 0.3 },
  "code-design-analyzer":         { code_change: 0.4, doc_writing: 0.1, troubleshooting: 0.5, design_improve: 0.8, refactoring: 0.8 },
  "task-decomposer":              { code_change: 0.6, doc_writing: 0.3, troubleshooting: 0.3, design_improve: 0.7, refactoring: 0.5 },
  "orion-deep-audit":             { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.8, design_improve: 0.4, refactoring: 0.7 },
  "orion-repairing":              { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.7, design_improve: 0.1, refactoring: 0.4 },
  "orion-reviewing":              { code_change: 0.6, doc_writing: 0.2, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.6 },
  "feature-dev:feature-dev":      { code_change: 0.9, doc_writing: 0.1, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.4 },
  "simplify":                     { code_change: 0.3, doc_writing: 0.0, troubleshooting: 0.2, design_improve: 0.2, refactoring: 0.9 },
  "docs-navigator":               { code_change: 0.1, doc_writing: 0.7, troubleshooting: 0.0, design_improve: 0.4, refactoring: 0.1 },
}
