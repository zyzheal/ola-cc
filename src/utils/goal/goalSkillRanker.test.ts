/**
 * Tests for goalSkillRanker — scenario-aware skill ranking
 *
 * Run: bun test src/utils/goal/goalSkillRanker.test.ts
 */

import { describe, it, expect } from "bun:test"
import { rankSkills, scoreSkill, extractTerms } from "./goalSkillRanker.js"
import type { SkillMetadata } from "./skillRegistry.js"
import type { ScenarioConfig } from "./goalScenario.js"

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    path: "/test/path",
    description: "A test skill for testing",
    triggers: ["test"],
    priority: 5,
    conflictsWith: [],
    lastModified: Date.now(),
    ...overrides,
  }
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    type: "code_change",
    phases: [],
    maxRoundsPerTask: 5,
    convergenceThreshold: 5,
    requiredTools: [],
    preferredSkills: [],
    skillAffinity: {},
    ...overrides,
  }
}

describe("extractTerms", () => {
  it("should extract lowercase terms", () => {
    const terms = extractTerms("Fix the Auth Module Bug")
    expect(terms).toContain("fix")
    expect(terms).toContain("auth")
    expect(terms).toContain("module")
    expect(terms).toContain("bug")
  })

  it("should filter stop words", () => {
    const terms = extractTerms("the quick brown fox")
    expect(terms).not.toContain("the")
    expect(terms).toContain("quick")
    expect(terms).toContain("brown")
    expect(terms).toContain("fox")
  })

  it("should handle empty query", () => {
    const terms = extractTerms("")
    expect(terms).toEqual([])
  })

  it("should handle Chinese text", () => {
    const terms = extractTerms("修复认证模块")
    expect(terms).toContain("修复认证模块")
  })
})

describe("scoreSkill", () => {
  it("should score name match highly", () => {
    const skill = makeSkill({ name: "systematic-debugging" })
    const score = scoreSkill(skill, ["debugging"], makeScenario())
    expect(score).toBeGreaterThan(50)
  })

  it("should score trigger match", () => {
    const skill = makeSkill({ triggers: ["debug", "fix"] })
    const score = scoreSkill(skill, ["debug"], makeScenario())
    expect(score).toBeGreaterThan(10)
  })

  it("should score description match", () => {
    const skill = makeSkill({ description: "helps with debugging code" })
    const score = scoreSkill(skill, ["debugging"], makeScenario())
    expect(score).toBeGreaterThan(5)
  })

  it("should apply scenario affinity bonus", () => {
    const skill = makeSkill({ name: "systematic-debugging" })
    const scenario = makeScenario({ type: "troubleshooting" })
    const score = scoreSkill(skill, ["unrelated"], scenario)
    // affinity 1.0 * 40 = 40
    expect(score).toBeGreaterThan(30)
  })

  it("should include priority bonus", () => {
    const highPriority = makeSkill({ priority: 10 })
    const lowPriority = makeSkill({ priority: 1 })
    const s1 = scoreSkill(highPriority, [], makeScenario())
    const s2 = scoreSkill(lowPriority, [], makeScenario())
    expect(s1).toBeGreaterThan(s2)
  })

  it("should return 0 for no matches", () => {
    const skill = makeSkill({ name: "unrelated", description: "nothing", triggers: [] })
    const score = scoreSkill(skill, ["xyz"], makeScenario())
    // Only priority bonus remains
    expect(score).toBe((5 / 10) * 20)
  })
})

describe("rankSkills", () => {
  it("should return skills sorted by score descending", () => {
    const skills = [
      makeSkill({ name: "low-match" }),
      makeSkill({ name: "systematic-debugging" }),
      makeSkill({ name: "test-driven-development" }),
    ]
    const scenario = makeScenario({ type: "troubleshooting" })
    const ranked = rankSkills("debug the crash", skills, scenario, 3)
    expect(ranked[0].skill.name).toBe("systematic-debugging")
  })

  it("should respect limit", () => {
    const skills = Array.from({ length: 20 }, (_, i) =>
      makeSkill({ name: `skill-${i}` }),
    )
    const ranked = rankSkills("test", skills, makeScenario(), 5)
    expect(ranked.length).toBeLessThanOrEqual(5)
  })

  it("should handle empty query", () => {
    const skills = [makeSkill()]
    const ranked = rankSkills("", skills, makeScenario(), 5)
    expect(ranked.length).toBe(1)
  })

  it("should handle empty skills list", () => {
    const ranked = rankSkills("test", [], makeScenario(), 5)
    expect(ranked).toEqual([])
  })

  it("should rank TDD higher in code_change scenario", () => {
    const skills = [
      makeSkill({ name: "test-driven-development" }),
      makeSkill({ name: "brainstorming" }),
    ]
    const scenario = makeScenario({ type: "code_change" })
    const ranked = rankSkills("implement feature", skills, scenario, 2)
    expect(ranked[0].skill.name).toBe("test-driven-development")
  })

  it("should rank brainstorming higher in design_improve scenario", () => {
    const skills = [
      makeSkill({ name: "test-driven-development" }),
      makeSkill({ name: "brainstorming" }),
    ]
    const scenario = makeScenario({ type: "design_improve" })
    const ranked = rankSkills("design approach", skills, scenario, 2)
    expect(ranked[0].skill.name).toBe("brainstorming")
  })
})
