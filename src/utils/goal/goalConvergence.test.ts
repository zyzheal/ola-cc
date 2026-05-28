/**
 * Tests for goalConvergence — 3D convergence detection
 *
 * Run: bun test src/utils/goal/goalConvergence.test.ts
 */

import { describe, it, expect } from "bun:test"
import {
  computeInformationGain,
  computeQualityScore,
  computeChangeMagnitude,
  checkConvergence,
  updateConvergenceState,
  tokenize,
} from "./goalConvergence.js"
import type { TurnRecord } from "../../commands/goal/types.js"

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    wallStartMs: Date.now(),
    wallEndMs: Date.now() + 1000,
    toolCallsSummary: [],
    outputSummary: "",
    hadObservableChanges: false,
    ...overrides,
  }
}

describe("tokenize", () => {
  it("should tokenize English text", () => {
    const tokens = tokenize("build successful all tests pass")
    expect(tokens.has("build")).toBe(true)
    expect(tokens.has("successful")).toBe(true)
    expect(tokens.has("tests")).toBe(true)
    expect(tokens.has("pass")).toBe(true)
  })

  it("should remove stop words", () => {
    const tokens = tokenize("the quick brown fox")
    expect(tokens.has("the")).toBe(false)
    expect(tokens.has("quick")).toBe(true)
  })

  it("should tokenize Chinese text with bigrams", () => {
    const tokens = tokenize("重构认证模块")
    expect(tokens.has("重构")).toBe(true)
    expect(tokens.has("认证")).toBe(true)
    expect(tokens.has("模块")).toBe(true)
    // unigrams also present
    expect(tokens.has("重")).toBe(true)
    expect(tokens.has("构")).toBe(true)
  })

  it("should handle mixed Chinese/English", () => {
    const tokens = tokenize("修复 auth 模块的 bug")
    expect(tokens.has("修复")).toBe(true)
    expect(tokens.has("auth")).toBe(true)
    expect(tokens.has("bug")).toBe(true)
  })

  it("should return empty set for empty input", () => {
    const tokens = tokenize("")
    expect(tokens.size).toBe(0)
  })

  it("should filter single characters (except Chinese)", () => {
    const tokens = tokenize("a bb ccc")
    expect(tokens.has("a")).toBe(false) // stop word
    expect(tokens.has("bb")).toBe(true)
    expect(tokens.has("ccc")).toBe(true)
  })
})

describe("computeInformationGain", () => {
  it("should return 1.0 for first turn", () => {
    const gain = computeInformationGain(makeTurn(), undefined)
    expect(gain).toBe(1.0)
  })

  it("should return low gain for identical turns", () => {
    const prev = makeTurn({ toolCallsSummary: ["Read"], outputSummary: "same text here" })
    const curr = makeTurn({ toolCallsSummary: ["Read"], outputSummary: "same text here" })
    const gain = computeInformationGain(curr, prev)
    expect(gain).toBeLessThan(0.3)
  })

  it("should return high gain for novel tools", () => {
    const prev = makeTurn({ toolCallsSummary: ["Read"], hadObservableChanges: false })
    const curr = makeTurn({ toolCallsSummary: ["Edit", "Bash"], hadObservableChanges: true })
    const gain = computeInformationGain(curr, prev)
    expect(gain).toBeGreaterThan(0.5)
  })

  it("should handle both empty outputs as 0 novelty", () => {
    const prev = makeTurn({ outputSummary: "" })
    const curr = makeTurn({ outputSummary: "" })
    const gain = computeInformationGain(curr, prev)
    // outputNovelty=0, toolNovelty depends, observable depends
    expect(gain).toBeLessThan(0.5)
  })

  it("should handle one empty output as max novelty", () => {
    const prev = makeTurn({ outputSummary: "some text here" })
    const curr = makeTurn({ outputSummary: "" })
    const gain = computeInformationGain(curr, prev)
    expect(gain).toBeGreaterThan(0)
  })

  it("should weight observable changes", () => {
    const prev = makeTurn({ hadObservableChanges: false, toolCallsSummary: ["Read"] })
    const withChanges = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Read"] })
    const withoutChanges = makeTurn({ hadObservableChanges: false, toolCallsSummary: ["Read"] })
    const gainWith = computeInformationGain(withChanges, prev)
    const gainWithout = computeInformationGain(withoutChanges, prev)
    expect(gainWith).toBeGreaterThan(gainWithout)
  })
})

describe("computeQualityScore", () => {
  it("should score build errors low", () => {
    const turn = makeTurn({ outputSummary: "build failed: syntax error" })
    const score = computeQualityScore(turn, "code_change")
    // buildScore=0 (build failed matches), testScore=60 (no signal), reviewScore=100, regressionScore=100
    // 0.30*0 + 0.35*60 + 0.20*100 + 0.15*100 = 0+21+20+15 = 56
    expect(score).toBeLessThan(60)
  })

  it("should not confuse 'no error' with error", () => {
    const turn = makeTurn({ outputSummary: "no error found, all tests pass" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeGreaterThan(80)
  })

  it("should score 'no errors' as success", () => {
    const turn = makeTurn({ outputSummary: "compiled successfully, 0 errors" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeGreaterThan(80)
  })

  it("should return optimistic default for empty output", () => {
    const turn = makeTurn({ outputSummary: "" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeGreaterThanOrEqual(50)
    expect(score).toBeLessThanOrEqual(80)
  })

  it("should detect regression", () => {
    const turn = makeTurn({ outputSummary: "regression detected, previously working code broke" })
    const score = computeQualityScore(turn, "refactoring")
    // regressionScore=0, but default build=70/test=60 pull total up
    // refactoring: 0.25*70 + 0.40*60 + 0.20*100 + 0.15*0 = 17.5+24+20+0 = 61.5→62
    // The key assertion: score is lower than the no-regression baseline (77)
    expect(score).toBeLessThan(70)
  })

  it("should weight differently per scenario", () => {
    const turn = makeTurn({ outputSummary: "all tests pass" })
    const codeScore = computeQualityScore(turn, "code_change")
    const docScore = computeQualityScore(turn, "doc_writing")
    expect(codeScore).not.toBe(docScore)
  })

  it("should detect test success", () => {
    const turn = makeTurn({ outputSummary: "all tests pass, 0 failing" })
    const score = computeQualityScore(turn, "code_change")
    // buildScore=70 (no signal), testScore=100 (matches "all tests pass" + "0 failing")
    // 0.30*70 + 0.35*100 + 0.20*100 + 0.15*100 = 21+35+20+15 = 91
    expect(score).toBeGreaterThan(80)
  })

  it("should detect test failure", () => {
    const turn = makeTurn({ outputSummary: "test failed: assertion error in auth.test.ts" })
    const score = computeQualityScore(turn, "code_change")
    // buildScore=70, testScore=0 (test failed), reviewScore=100, regressionScore=100
    // 0.30*70 + 0.35*0 + 0.20*100 + 0.15*100 = 21+0+20+15 = 56
    expect(score).toBeLessThan(60)
  })
})

describe("computeChangeMagnitude", () => {
  it("should return 0 when no observable changes", () => {
    const turn = makeTurn({ hadObservableChanges: false })
    expect(computeChangeMagnitude(turn)).toBe(0)
  })

  it("should score Write higher than Edit", () => {
    const writeTurn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Write"] })
    const editTurn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    expect(computeChangeMagnitude(writeTurn)).toBeGreaterThan(computeChangeMagnitude(editTurn))
  })

  it("should score multiple tools higher than single", () => {
    const single = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    const multi = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit", "Write", "Bash"] })
    expect(computeChangeMagnitude(multi)).toBeGreaterThan(computeChangeMagnitude(single))
  })

  it("should return 0-100 range", () => {
    const heavy = makeTurn({
      hadObservableChanges: true,
      toolCallsSummary: ["Write", "Write", "Write", "Edit", "Edit", "Bash", "Bash"],
    })
    const score = computeChangeMagnitude(heavy)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

describe("checkConvergence", () => {
  it("should not converge with insufficient data", () => {
    const state = { informationGains: [0.5], qualityScores: [80], changeMagnitudes: [10], round: 1 }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge when IG low + quality high + stable", () => {
    const state = {
      informationGains: [0.1, 0.1],
      qualityScores: [80, 82],
      changeMagnitudes: [2, 1],
      round: 4,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("info_gain_stable")
  })

  it("should not converge when quality below 80", () => {
    const state = {
      informationGains: [0.1, 0.1],
      qualityScores: [60, 62],
      changeMagnitudes: [2, 1],
      round: 4,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge at max_rounds with high quality", () => {
    const state = {
      // IG last 2: 0.3, 0.2 — both >= 0.15 → info_gain_stable=false
      informationGains: [0.5, 0.4, 0.3, 0.3, 0.2],
      qualityScores: [80, 82, 85, 83, 84],
      // CM last: 5 >= 3 → changesMinimal=false
      changeMagnitudes: [10, 8, 5, 3, 5],
      round: 5,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds")
  })

  it("should report max_rounds_low_quality when quality below 80 at max", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.3, 0.3, 0.2],
      qualityScores: [50, 55, 60, 58, 62],
      changeMagnitudes: [10, 8, 5, 3, 2],
      round: 5,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds_low_quality")
  })

  it("should not converge on changesMinimal without hasHadChanges", () => {
    const state = {
      informationGains: [0.3, 0.3],
      qualityScores: [80, 82],
      changeMagnitudes: [0, 0],
      round: 3,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge on changesMinimal when hasHadChanges=true", () => {
    const state = {
      informationGains: [0.3, 0.3],
      qualityScores: [80, 82],
      changeMagnitudes: [5, 0],
      round: 3,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("changes_minimal")
  })

  it("should adapt window size to maxRounds", () => {
    const state = {
      // IG last 2: 0.3, 0.3 — both >= 0.15 → info_gain_stable=false
      informationGains: [0.5, 0.3, 0.3],
      qualityScores: [80, 82, 85],
      // CM last: 5 >= 3 → changesMinimal=false
      changeMagnitudes: [10, 5, 5],
      round: 3,
    }
    const result = checkConvergence(state, 3)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds")
  })
})

describe("updateConvergenceState", () => {
  it("should increment round and push values", () => {
    const state = { informationGains: [], qualityScores: [], changeMagnitudes: [], round: 0 }
    const turn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    updateConvergenceState(state, turn, undefined, "code_change", 5)
    expect(state.round).toBe(1)
    expect(state.informationGains.length).toBe(1)
    expect(state.qualityScores.length).toBe(1)
    expect(state.changeMagnitudes.length).toBe(1)
  })

  it("should trim to window size", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.3, 0.2, 0.1],
      qualityScores: [80, 82, 85, 83, 84],
      changeMagnitudes: [10, 8, 5, 3, 2],
      round: 5,
    }
    const turn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Read"] })
    updateConvergenceState(state, turn, makeTurn(), "code_change", 5)
    expect(state.informationGains.length).toBe(5)
    expect(state.round).toBe(6)
  })

  it("should use min(5, maxRounds) as window", () => {
    const state = { informationGains: [], qualityScores: [], changeMagnitudes: [], round: 0 }
    // maxRounds=3, so window should be 3
    for (let i = 0; i < 4; i++) {
      const turn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
      updateConvergenceState(state, turn, i > 0 ? makeTurn() : undefined, "code_change", 3)
    }
    expect(state.informationGains.length).toBe(3) // trimmed to window
    expect(state.round).toBe(4)
  })
})
