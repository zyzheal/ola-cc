/**
 * Tests for goalToolTier — L3 tool hierarchy for ANALYZE phase
 *
 * Run: bun test src/utils/goal/goalToolTier.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test"
import {
  createToolTierState,
  resetTaskCounters,
  isDebounced,
  isAtLimit,
  recordCall,
  computeAnalysisPlan,
  formatL3Results,
  gateAnalyze,
  buildCodegraphQuery,
  buildGrokQuery,
  executeProactiveAnalysis,
} from "./goalToolTier.js"
import type { ToolTierState, L3Results } from "./goalToolTier.js"

describe("ToolTierState", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should create initial state", () => {
    expect(state.codegraphCallCount).toBe(0)
    expect(state.grokCallCount).toBe(0)
    expect(state.currentTaskId).toBe("")
    expect(state.isFirstAnalyze).toBe(true)
    expect(state.lastCallTime.size).toBe(0)
  })

  it("should reset counters on task switch", () => {
    state.codegraphCallCount = 2
    state.grokCallCount = 1
    state.currentTaskId = "task-1"
    state.isFirstAnalyze = false

    resetTaskCounters(state, "task-2")

    expect(state.codegraphCallCount).toBe(0)
    expect(state.grokCallCount).toBe(0)
    expect(state.currentTaskId).toBe("task-2")
    expect(state.isFirstAnalyze).toBe(true)
  })

  it("should NOT reset counters for same task", () => {
    state.codegraphCallCount = 1
    state.currentTaskId = "task-1"

    resetTaskCounters(state, "task-1")

    expect(state.codegraphCallCount).toBe(1)
  })
})

describe("isDebounced", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should return false when never called", () => {
    expect(isDebounced(state, "codegraph")).toBe(false)
  })

  it("should return true within debounce window", () => {
    state.lastCallTime.set("codegraph", Date.now())
    expect(isDebounced(state, "codegraph")).toBe(true)
  })

  it("should return false after debounce window", () => {
    state.lastCallTime.set("codegraph", Date.now() - 31_000)
    expect(isDebounced(state, "codegraph")).toBe(false)
  })

  it("should debounce independently per tool", () => {
    state.lastCallTime.set("codegraph", Date.now())
    expect(isDebounced(state, "codegraph")).toBe(true)
    expect(isDebounced(state, "grok")).toBe(false)
  })
})

describe("isAtLimit", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should not be at limit initially", () => {
    expect(isAtLimit(state, "codegraph")).toBe(false)
    expect(isAtLimit(state, "grok")).toBe(false)
  })

  it("should be at limit when codegraph calls >= 2", () => {
    state.codegraphCallCount = 2
    expect(isAtLimit(state, "codegraph")).toBe(true)
  })

  it("should be at limit when grok calls >= 1", () => {
    state.grokCallCount = 1
    expect(isAtLimit(state, "grok")).toBe(true)
  })

  it("should not be at limit below threshold", () => {
    state.codegraphCallCount = 1
    expect(isAtLimit(state, "codegraph")).toBe(false)
  })
})

describe("recordCall", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should increment codegraph count", () => {
    recordCall(state, "codegraph")
    expect(state.codegraphCallCount).toBe(1)
    expect(state.lastCallTime.has("codegraph")).toBe(true)
  })

  it("should increment grok count", () => {
    recordCall(state, "grok")
    expect(state.grokCallCount).toBe(1)
    expect(state.lastCallTime.has("grok")).toBe(true)
  })

  it("should clear isFirstAnalyze flag", () => {
    expect(state.isFirstAnalyze).toBe(true)
    recordCall(state, "codegraph")
    expect(state.isFirstAnalyze).toBe(false)
  })
})

describe("gateAnalyze", () => {
  it("should fail when no L3 results", () => {
    const result = gateAnalyze(undefined)
    expect(result.passed).toBe(false)
    expect(result.l3CallCount).toBe(0)
  })

  it("should fail when no successful L3 calls", () => {
    const results: L3Results = {
      results: [{ tool: "codegraph", operation: "codegraph_context", data: "", success: false, elapsedMs: 100 }],
      codegraphCalls: 0,
      grokCalls: 0,
      degraded: true,
      degradeReason: "timeout",
    }
    const result = gateAnalyze(results)
    expect(result.passed).toBe(false)
    expect(result.l3CallCount).toBe(0)
    expect(result.details).toContain("degraded")
  })

  it("should pass with 1 codegraph call", () => {
    const results: L3Results = {
      results: [{ tool: "codegraph", operation: "codegraph_context", data: "data", success: true, elapsedMs: 100 }],
      codegraphCalls: 1,
      grokCalls: 0,
      degraded: false,
    }
    const result = gateAnalyze(results)
    expect(result.passed).toBe(true)
    expect(result.l3CallCount).toBe(1)
  })

  it("should pass with 1 grok call", () => {
    const results: L3Results = {
      results: [{ tool: "grok", operation: "grok_chat", data: "answer", success: true, elapsedMs: 200 }],
      codegraphCalls: 0,
      grokCalls: 1,
      degraded: false,
    }
    const result = gateAnalyze(results)
    expect(result.passed).toBe(true)
    expect(result.l3CallCount).toBe(1)
  })

  it("should pass with mixed calls", () => {
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: "data", success: true, elapsedMs: 100 },
        { tool: "grok", operation: "grok_chat", data: "answer", success: true, elapsedMs: 200 },
      ],
      codegraphCalls: 1,
      grokCalls: 1,
      degraded: false,
    }
    const result = gateAnalyze(results)
    expect(result.passed).toBe(true)
    expect(result.l3CallCount).toBe(2)
  })
})

describe("computeAnalysisPlan", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should plan codegraph_context on first ANALYZE", () => {
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix the auth bug")
    expect(plan.codegraphOps).toContain("codegraph_context")
    expect(plan.grokOps).toContain("grok_chat")
  })

  it("should plan codegraph_search on subsequent ANALYZE", () => {
    state.isFirstAnalyze = false
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix the auth bug")
    expect(plan.codegraphOps).toContain("codegraph_search")
    expect(plan.grokOps).toContain("grok_chat")
  })

  it("should plan codegraph_impact on FIX phase", () => {
    const plan = computeAnalysisPlan(state, "FIX", "edit auth module")
    expect(plan.codegraphOps).toContain("codegraph_impact")
    expect(plan.grokOps).toEqual([])
  })

  it("should skip codegraph when debounced", () => {
    state.lastCallTime.set("codegraph", Date.now())
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix bug")
    expect(plan.codegraphOps).toEqual([])
  })

  it("should skip codegraph when at limit", () => {
    state.codegraphCallCount = 2
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix bug")
    expect(plan.codegraphOps).toEqual([])
  })

  it("should skip grok when at limit", () => {
    state.grokCallCount = 1
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix bug")
    expect(plan.grokOps).toEqual([])
  })

  it("should skip all for REVIEW/SKILL/VERIFY phases", () => {
    const plan = computeAnalysisPlan(state, "REVIEW", "review code")
    expect(plan.codegraphOps).toEqual([])
    expect(plan.grokOps).toEqual([])
  })

  it("should include reason", () => {
    const plan = computeAnalysisPlan(state, "ANALYZE", "fix bug")
    expect(plan.reason).toContain("L3 proactive")
  })
})

describe("formatL3Results", () => {
  it("should return empty string for no results", () => {
    const results: L3Results = {
      results: [],
      codegraphCalls: 0,
      grokCalls: 0,
      degraded: false,
    }
    expect(formatL3Results(results)).toBe("")
  })

  it("should format successful results", () => {
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: "some data", success: true, elapsedMs: 150 },
      ],
      codegraphCalls: 1,
      grokCalls: 0,
      degraded: false,
    }
    const formatted = formatL3Results(results)
    expect(formatted).toContain("L3 Analysis Context")
    expect(formatted).toContain("[CodeGraph]")
    expect(formatted).toContain("some data")
    expect(formatted).toContain("150ms")
  })

  it("should skip failed results", () => {
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: "", success: false, elapsedMs: 100 },
        { tool: "grok", operation: "grok_chat", data: "answer", success: true, elapsedMs: 200 },
      ],
      codegraphCalls: 0,
      grokCalls: 1,
      degraded: true,
      degradeReason: "CodeGraph error",
    }
    const formatted = formatL3Results(results)
    expect(formatted).not.toContain("codegraph_context")
    expect(formatted).toContain("[Grok]")
    expect(formatted).toContain("Degraded")
  })

  it("should return empty for all-failure results (no degradation)", () => {
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: "", success: false, elapsedMs: 100 },
      ],
      codegraphCalls: 0,
      grokCalls: 0,
      degraded: false,
    }
    expect(formatL3Results(results)).toBe("")
  })

  it("should include degradation note even with all failures", () => {
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: "", success: false, elapsedMs: 100 },
      ],
      codegraphCalls: 0,
      grokCalls: 0,
      degraded: true,
      degradeReason: "timeout",
    }
    const formatted = formatL3Results(results)
    expect(formatted).toContain("Degraded")
  })

  it("should truncate long results", () => {
    const longData = "x".repeat(3000)
    const results: L3Results = {
      results: [
        { tool: "codegraph", operation: "codegraph_context", data: longData, success: true, elapsedMs: 100 },
      ],
      codegraphCalls: 1,
      grokCalls: 0,
      degraded: false,
    }
    const formatted = formatL3Results(results)
    expect(formatted.length).toBeLessThan(2500)
    expect(formatted).toContain("truncated")
  })
})

describe("buildCodegraphQuery", () => {
  it("should build context query for codegraph_context", () => {
    const q = buildCodegraphQuery("fix the auth login bug", "codegraph_context")
    expect(q.query).toBe("fix the auth login bug")
    expect(q.maxNodes).toBe(10)
    expect(q.format).toBe("json")
  })

  it("should extract keywords for codegraph_search", () => {
    const q = buildCodegraphQuery("fix the authentication module", "codegraph_search")
    expect(q.query).toBeTruthy()
    expect(q.maxNodes).toBe(10)
  })

  it("should extract symbol for codegraph_impact", () => {
    const q = buildCodegraphQuery("modify AuthService.login method", "codegraph_impact")
    expect(q.symbol).toBeTruthy()
    expect(q.depth).toBe(2)
  })

  it("should handle empty task description", () => {
    const q = buildCodegraphQuery("", "codegraph_search")
    expect(q.query).toBe("code") // fallback keyword
  })
})

describe("buildGrokQuery", () => {
  it("should truncate long descriptions", () => {
    const long = "x".repeat(1000)
    const q = buildGrokQuery(long)
    expect(q.length).toBeLessThanOrEqual(500)
  })

  it("should pass short descriptions as-is", () => {
    const q = buildGrokQuery("fix auth bug")
    expect(q).toBe("fix auth bug")
  })
})

describe("executeProactiveAnalysis", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  it("should call codegraph and grok on first ANALYZE", async () => {
    const cgCalls: string[] = []
    const grokCalls: string[] = []

    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix the auth bug",
      async (op, _params) => { cgCalls.push(op); return '{"nodes":[]}' },
      async (op, _params) => { grokCalls.push(op); return "analysis result" },
    )

    expect(cgCalls).toContain("codegraph_context")
    expect(grokCalls).toContain("grok_chat")
    expect(results.codegraphCalls).toBe(1)
    expect(results.grokCalls).toBe(1)
    expect(results.degraded).toBe(false)
  })

  it("should degrade when codegraph caller not provided", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      undefined,
      async () => "ok",
    )

    expect(results.degraded).toBe(true)
    expect(results.degradeReason).toContain("codegraph caller not available")
  })

  it("should degrade when grok caller not provided", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => '{"nodes":[]}',
      undefined,
    )

    expect(results.degraded).toBe(true)
    expect(results.degradeReason).toContain("grok caller not available")
  })

  it("should handle codegraph timeout", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => new Promise(resolve => setTimeout(() => resolve("{}"), 20_000)),
      async () => "ok",
    )

    // Should not hang — timeout triggers degradation
    expect(results.results.length).toBeGreaterThan(0)
    expect(results.degraded).toBe(true)
  }, 15000)

  it("should handle codegraph error gracefully", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => { throw new Error("init failed") },
      async () => "ok",
    )

    expect(results.degraded).toBe(true)
    expect(results.degradeReason).toContain("init failed")
  })

  it("should NOT record call on failure (preserves quota)", async () => {
    await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => { throw new Error("fail") },
      async () => "ok",
    )

    // CodeGraph call failed → should NOT count against quota
    expect(state.codegraphCallCount).toBe(0)
    // Grok call succeeded → should count
    expect(state.grokCallCount).toBe(1)
  })

  it("should respect debounce", async () => {
    const cgCalls: string[] = []

    // First call
    await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async (op) => { cgCalls.push(op); return "{}" },
      async () => "ok",
    )

    // Second call immediately (debounced)
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async (op) => { cgCalls.push(op); return "{}" },
      async () => "ok",
    )

    // Second call should be debounced for grok (already called once)
    expect(results.grokCalls).toBe(0)
  })

  it("should respect per-task limits", async () => {
    // Exhaust codegraph limit
    state.codegraphCallCount = 2
    state.lastCallTime.set("codegraph", Date.now() - 31_000) // past debounce

    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => "{}",
      async () => "ok",
    )

    expect(results.codegraphCalls).toBe(0)
  })

  it("should call codegraph twice across two ANALYZE turns", async () => {
    // First turn
    const r1 = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => '{"nodes":[]}',
      async () => "ok",
    )
    expect(r1.codegraphCalls).toBe(1)
    expect(state.codegraphCallCount).toBe(1)

    // Clear debounce for second turn
    state.lastCallTime.delete("codegraph")
    state.lastCallTime.delete("grok")

    // Second turn
    const r2 = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      async () => '{"nodes":[]}',
      async () => "ok",
    )
    expect(r2.codegraphCalls).toBe(1)
    expect(state.codegraphCallCount).toBe(2)
  })

  it("should reset limits on task switch", async () => {
    // Exhaust limits for task-1
    state.codegraphCallCount = 2
    state.grokCallCount = 1
    state.currentTaskId = "task-1"

    // Switch to task-2
    resetTaskCounters(state, "task-2")

    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "new task",
      async () => '{"nodes":[]}',
      async () => "ok",
    )

    // Should be able to call again after task switch
    expect(results.codegraphCalls).toBe(1)
    expect(results.grokCalls).toBe(1)
  })

  it("should do nothing for non-ANALYZE/FIX phases", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "REVIEW",
      "review code",
      async () => "{}",
      async () => "ok",
    )

    expect(results.results.length).toBe(0)
    expect(results.codegraphCalls).toBe(0)
    expect(results.grokCalls).toBe(0)
  })

  it("should degrade when both callers unavailable", async () => {
    const results = await executeProactiveAnalysis(
      state,
      "ANALYZE",
      "fix bug",
      undefined,
      undefined,
    )

    expect(results.degraded).toBe(true)
    // Results include failed entries for each attempted call
    expect(results.results.every(r => !r.success)).toBe(true)
    expect(results.codegraphCalls).toBe(0)
    expect(results.grokCalls).toBe(0)
  })
})
