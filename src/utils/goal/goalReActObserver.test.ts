/**
 * Tests for goalReActObserver — ReAct phase inference + quality signals
 *
 * Run: bun test src/utils/goal/goalReActObserver.test.ts
 */

import { describe, it, expect } from "bun:test"
import {
  inferReActPhases,
  extractQualitySignals,
  observeTurn,
  TOOL_PHASE_MAP,
} from "./goalReActObserver.js"
import type { ReActPhase } from "./goalReActObserver.js"

describe("TOOL_PHASE_MAP", () => {
  it("should map ANALYZE tools correctly", () => {
    expect(TOOL_PHASE_MAP["Read"]).toBe("ANALYZE")
    expect(TOOL_PHASE_MAP["Glob"]).toBe("ANALYZE")
    expect(TOOL_PHASE_MAP["Grep"]).toBe("ANALYZE")
    expect(TOOL_PHASE_MAP["codegraph"]).toBe("ANALYZE")
    expect(TOOL_PHASE_MAP["grok"]).toBe("ANALYZE")
  })

  it("should map SKILL tools correctly", () => {
    expect(TOOL_PHASE_MAP["Skill"]).toBe("SKILL")
    expect(TOOL_PHASE_MAP["SkillTool"]).toBe("SKILL")
  })

  it("should map REVIEW tools correctly", () => {
    expect(TOOL_PHASE_MAP["Agent"]).toBe("REVIEW")
    expect(TOOL_PHASE_MAP["AgentTool"]).toBe("REVIEW")
  })

  it("should map FIX tools correctly", () => {
    expect(TOOL_PHASE_MAP["Edit"]).toBe("FIX")
    expect(TOOL_PHASE_MAP["Write"]).toBe("FIX")
    expect(TOOL_PHASE_MAP["FileEdit"]).toBe("FIX")
    expect(TOOL_PHASE_MAP["FileWrite"]).toBe("FIX")
  })

  it("should map VERIFY tools correctly", () => {
    expect(TOOL_PHASE_MAP["Bash"]).toBe("VERIFY")
  })

  it("should map TodoWrite to ANALYZE and update_goal to VERIFY", () => {
    expect(TOOL_PHASE_MAP["TodoWrite"]).toBe("ANALYZE")
    expect(TOOL_PHASE_MAP["update_goal"]).toBe("VERIFY")
  })
})

describe("inferReActPhases", () => {
  it("should determine mainPhase by frequency", () => {
    // 3 ANALYZE tools vs 1 FIX tool → mainPhase = ANALYZE
    const result = inferReActPhases(["Read", "Glob", "Grep", "Edit"])
    expect(result.mainPhase).toBe("ANALYZE")
    expect(result.phases).toContain("ANALYZE")
    expect(result.phases).toContain("FIX")
  })

  it("should return mainPhase as null for empty tool calls", () => {
    const result = inferReActPhases([])
    expect(result.mainPhase).toBeNull()
    expect(result.phases).toEqual([])
    expect(result.phaseTools.size).toBe(0)
  })

  it("should default unknown tools to ANALYZE", () => {
    const result = inferReActPhases(["SomeUnknownTool", "AnotherUnknown"])
    expect(result.mainPhase).toBe("ANALYZE")
    expect(result.phases).toEqual(["ANALYZE"])
    expect(result.phaseTools.get("ANALYZE")).toEqual([
      "SomeUnknownTool",
      "AnotherUnknown",
    ])
  })

  it("should populate phaseTools map correctly", () => {
    const result = inferReActPhases(["Read", "Edit", "Bash", "Grep", "Edit"])
    expect(result.phaseTools.get("ANALYZE")).toEqual(["Read", "Grep"])
    expect(result.phaseTools.get("FIX")).toEqual(["Edit", "Edit"])
    expect(result.phaseTools.get("VERIFY")).toEqual(["Bash"])
  })

  it("should handle single tool call", () => {
    const result = inferReActPhases(["Bash"])
    expect(result.mainPhase).toBe("VERIFY")
    expect(result.phases).toEqual(["VERIFY"])
    expect(result.phaseTools.get("VERIFY")).toEqual(["Bash"])
  })

  it("should handle all five phases in one turn", () => {
    const result = inferReActPhases([
      "Read",     // ANALYZE
      "Skill",    // SKILL
      "Agent",    // REVIEW
      "Edit",     // FIX
      "Bash",     // VERIFY
    ])
    expect(result.phases).toHaveLength(5)
    expect(result.phaseTools.size).toBe(5)
    // All phases have 1 tool each, first sorted = ANALYZE
    expect(result.mainPhase).toBe("ANALYZE")
  })

  it("should pick FIX as mainPhase when FIX tools dominate", () => {
    const result = inferReActPhases(["Read", "Edit", "Write", "FileEdit"])
    expect(result.mainPhase).toBe("FIX")
  })
})

describe("extractQualitySignals", () => {
  it("should detect errors", () => {
    const signals = extractQualitySignals("Build failed with error in module")
    expect(signals.hasErrors).toBe(true)
  })

  it("should detect success", () => {
    const signals = extractQualitySignals("Build completed successfully")
    expect(signals.hasSuccess).toBe(true)
  })

  it("should detect progress", () => {
    const signals = extractQualitySignals("Created new file and fixed the bug")
    expect(signals.hasProgress).toBe(true)
  })

  it('should NOT treat "no error" as an error', () => {
    const signals = extractQualitySignals("Build finished with no error")
    expect(signals.hasErrors).toBe(false)
  })

  it('should NOT treat "no errors" as an error', () => {
    const signals = extractQualitySignals("Compilation complete, no errors found")
    expect(signals.hasErrors).toBe(false)
  })

  it("should still detect real errors even with negation elsewhere", () => {
    const signals = extractQualitySignals("no errors in build, but runtime error occurred")
    expect(signals.hasErrors).toBe(true)
  })

  it("should be case insensitive", () => {
    const signals = extractQualitySignals("ERROR: Build FAILED")
    expect(signals.hasErrors).toBe(true)
  })

  it("should return all false for empty output", () => {
    const signals = extractQualitySignals("")
    expect(signals.hasErrors).toBe(false)
    expect(signals.hasSuccess).toBe(false)
    expect(signals.hasProgress).toBe(false)
  })

  it("should handle undefined-like input gracefully", () => {
    const signals = extractQualitySignals(null as unknown as string)
    expect(signals.hasErrors).toBe(false)
    expect(signals.hasSuccess).toBe(false)
    expect(signals.hasProgress).toBe(false)
  })

  it("should detect all signal types independently", () => {
    const signals = extractQualitySignals(
      "error in test, but build complete and updated the config",
    )
    expect(signals.hasErrors).toBe(true)
    expect(signals.hasSuccess).toBe(true)
    expect(signals.hasProgress).toBe(true)
  })

  it("should detect 'all tests pass' as success", () => {
    const signals = extractQualitySignals("All tests pass, no issues found")
    expect(signals.hasSuccess).toBe(true)
  })

  it("should detect 'build complete' as success", () => {
    const signals = extractQualitySignals("Build complete in 3.2s")
    expect(signals.hasSuccess).toBe(true)
  })
})

describe("observeTurn", () => {
  it("should combine phase inference and quality signals", () => {
    const obs = observeTurn(
      ["Read", "Grep", "Edit", "Bash"],
      "Build completed successfully, updated the config",
    )
    expect(obs.mainPhase).toBe("ANALYZE") // Read + Grep = 2, Edit = 1, Bash = 1
    expect(obs.phases).toContain("ANALYZE")
    expect(obs.phases).toContain("FIX")
    expect(obs.phases).toContain("VERIFY")
    expect(obs.qualitySignals.hasErrors).toBe(false)
    expect(obs.qualitySignals.hasSuccess).toBe(true)
    expect(obs.qualitySignals.hasProgress).toBe(true)
  })

  it("should handle empty inputs", () => {
    const obs = observeTurn([], "")
    expect(obs.mainPhase).toBeNull()
    expect(obs.phases).toEqual([])
    expect(obs.qualitySignals.hasErrors).toBe(false)
    expect(obs.qualitySignals.hasSuccess).toBe(false)
    expect(obs.qualitySignals.hasProgress).toBe(false)
  })

  it("should handle error case with phase detection", () => {
    const obs = observeTurn(
      ["Read", "Edit", "Bash"],
      "Build failed with syntax error",
    )
    expect(obs.mainPhase).toBe("ANALYZE") // each phase has 1 tool
    expect(obs.qualitySignals.hasErrors).toBe(true)
    expect(obs.qualitySignals.hasSuccess).toBe(false)
  })
})
