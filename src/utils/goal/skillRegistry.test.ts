/**
 * Tests for skillRegistry — SKILL.md frontmatter scanner
 *
 * Run: bun test src/utils/goal/skillRegistry.test.ts
 */

import { describe, it, expect } from "bun:test"
import { parseFrontmatter, parseTriggers } from "./skillRegistry.js"

// ============================================
// parseFrontmatter
// ============================================

describe("parseFrontmatter", () => {
  it("should parse valid YAML frontmatter", () => {
    const content = `---
name: brainstorming
description: "A brainstorming skill"
trigger: brainstorm, 创意
priority: 51
---

Body content here.`
    const result = parseFrontmatter(content)
    expect(result.name).toBe("brainstorming")
    expect(result.description).toBe("A brainstorming skill")
    expect(result.trigger).toBe("brainstorm, 创意")
    expect(result.priority).toBe("51")
  })

  it("should return empty object for missing frontmatter", () => {
    const content = `# Just a markdown file

No frontmatter here.`
    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })

  it("should return empty object for empty frontmatter", () => {
    const content = `---
---

Body content.`
    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })

  it("should handle missing optional fields gracefully", () => {
    const content = `---
name: minimal-skill
---

Body.`
    const result = parseFrontmatter(content)
    expect(result.name).toBe("minimal-skill")
    expect(result.description).toBeUndefined()
    expect(result.trigger).toBeUndefined()
    expect(result.priority).toBeUndefined()
  })

  it("should strip surrounding double quotes from values", () => {
    const content = `---
name: quoted
description: "Quoted value"
---`
    const result = parseFrontmatter(content)
    expect(result.description).toBe("Quoted value")
  })

  it("should strip surrounding single quotes from values", () => {
    const content = `---
name: single-quoted
description: 'Single quoted'
---`
    const result = parseFrontmatter(content)
    expect(result.description).toBe("Single quoted")
  })

  it("should handle conflicts-with hyphenated key", () => {
    const content = `---
name: design-constraint
conflicts-with: code-analyzer, task-decomposer
---`
    const result = parseFrontmatter(content)
    expect(result["conflicts-with"]).toBe("code-analyzer, task-decomposer")
  })

  it("should not parse content outside frontmatter markers", () => {
    const content = `---
name: skill
---

name: should-not-appear`
    const result = parseFrontmatter(content)
    expect(result.name).toBe("skill")
    expect(Object.keys(result)).toHaveLength(1)
  })
})

// ============================================
// parseTriggers
// ============================================

describe("parseTriggers", () => {
  it("should split comma-separated triggers", () => {
    expect(parseTriggers("brainstorm, 创意, design")).toEqual([
      "brainstorm",
      "创意",
      "design",
    ])
  })

  it("should trim whitespace from each trigger", () => {
    expect(parseTriggers("  brainstorm ,  创意  , design  ")).toEqual([
      "brainstorm",
      "创意",
      "design",
    ])
  })

  it("should return empty array for empty string", () => {
    expect(parseTriggers("")).toEqual([])
  })

  it("should filter empty entries from consecutive commas", () => {
    expect(parseTriggers("brainstorm,,创意,,design")).toEqual([
      "brainstorm",
      "创意",
      "design",
    ])
  })

  it("should handle single trigger without commas", () => {
    expect(parseTriggers("brainstorm")).toEqual(["brainstorm"])
  })

  it("should filter entries that are only whitespace", () => {
    expect(parseTriggers("brainstorm,   , design")).toEqual([
      "brainstorm",
      "design",
    ])
  })
})
