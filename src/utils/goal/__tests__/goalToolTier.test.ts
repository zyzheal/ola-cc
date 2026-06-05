import { describe, it, expect, beforeEach } from "bun:test"
import {
  createToolTierState,
  isDebounced,
  recordCall,
  resetTaskCounters,
  isAtLimit,
  computeAnalysisPlan,
  gateAnalyze,
  formatL3Results,
  type ToolTierState,
} from "../goalToolTier.js"

describe("goalToolTier", () => {
  let state: ToolTierState

  beforeEach(() => {
    state = createToolTierState()
  })

  describe("createToolTierState", () => {
    it("initializes with empty maps and zero counts", () => {
      expect(state.lastCallTime.size).toBe(0)
      expect(state.opLastCallTime.size).toBe(0)
      expect(state.codegraphCallCount).toBe(0)
      expect(state.grokCallCount).toBe(0)
      expect(state.currentTaskId).toBe("")
      expect(state.isFirstAnalyze).toBe(true)
    })
  })

  describe("isDebounced — per-operation", () => {
    it("returns false when no calls recorded", () => {
      expect(isDebounced(state, "codegraph_pagerank")).toBe(false)
    })

    it("returns true for operation called within DEBOUNCE_MS", () => {
      recordCall(state, "codegraph", "codegraph_pagerank")
      expect(isDebounced(state, "codegraph_pagerank")).toBe(true)
    })

    it("returns false for different operation on same tool", () => {
      recordCall(state, "codegraph", "codegraph_pagerank")
      expect(isDebounced(state, "codegraph_scc")).toBe(false)
    })

    it("returns true for tool-level debounce even without operation", () => {
      recordCall(state, "codegraph")
      expect(isDebounced(state, "codegraph")).toBe(true)
    })

    it("per-operation takes priority over per-tool", () => {
      // Record tool-level call
      recordCall(state, "codegraph")
      // Record specific operation
      recordCall(state, "codegraph", "codegraph_context")

      // Both tool and operation should be debounced
      expect(isDebounced(state, "codegraph")).toBe(true)
      expect(isDebounced(state, "codegraph_context")).toBe(true)

      // Different operation should NOT be debounced (no per-op record, and
      // per-tool "codegraph" key doesn't match "codegraph_search")
      expect(isDebounced(state, "codegraph_search")).toBe(false)
    })
  })

  describe("recordCall — per-operation", () => {
    it("records both tool and operation when operation provided", () => {
      recordCall(state, "codegraph", "codegraph_pagerank")

      expect(state.lastCallTime.has("codegraph")).toBe(true)
      expect(state.opLastCallTime.has("codegraph_pagerank")).toBe(true)
      expect(state.codegraphCallCount).toBe(1)
    })

    it("records only tool when operation omitted", () => {
      recordCall(state, "grok")

      expect(state.lastCallTime.has("grok")).toBe(true)
      expect(state.opLastCallTime.size).toBe(0)
      expect(state.grokCallCount).toBe(1)
    })

    it("caps opLastCallTime at MAX_TRACKED_TOOLS", () => {
      // Fill beyond limit
      for (let i = 0; i < 25; i++) {
        recordCall(state, "codegraph", `op_${i}`)
      }
      expect(state.opLastCallTime.size).toBeLessThanOrEqual(20)
    })

    it("increments call counts correctly", () => {
      recordCall(state, "codegraph", "op1")
      recordCall(state, "codegraph", "op2")
      recordCall(state, "grok", "grok_chat")

      expect(state.codegraphCallCount).toBe(2)
      expect(state.grokCallCount).toBe(1)
    })

    it("clears isFirstAnalyze flag", () => {
      expect(state.isFirstAnalyze).toBe(true)
      recordCall(state, "codegraph", "codegraph_context")
      expect(state.isFirstAnalyze).toBe(false)
    })
  })

  describe("resetTaskCounters", () => {
    it("clears opLastCallTime on task switch", () => {
      recordCall(state, "codegraph", "codegraph_pagerank")
      recordCall(state, "grok", "grok_chat")

      resetTaskCounters(state, "new-task")

      expect(state.opLastCallTime.size).toBe(0)
      expect(state.codegraphCallCount).toBe(0)
      expect(state.grokCallCount).toBe(0)
      expect(state.isFirstAnalyze).toBe(true)
      expect(state.currentTaskId).toBe("new-task")
    })

    it("does not reset if same task ID", () => {
      state.currentTaskId = "task-1"
      recordCall(state, "codegraph", "op1")

      resetTaskCounters(state, "task-1")

      // Should NOT have been reset
      expect(state.opLastCallTime.size).toBe(1)
      expect(state.codegraphCallCount).toBe(1)
    })
  })

  describe("isDebounced — time expiry", () => {
    it("returns false after DEBOUNCE_MS has elapsed", () => {
      // Manually set an old timestamp
      state.opLastCallTime.set("codegraph_pagerank", Date.now() - 31_000)
      state.lastCallTime.set("codegraph", Date.now() - 31_000)

      expect(isDebounced(state, "codegraph_pagerank")).toBe(false)
      expect(isDebounced(state, "codegraph")).toBe(false)
    })
  })

  describe("isAtLimit", () => {
    it("returns false when under limit", () => {
      expect(isAtLimit(state, "codegraph")).toBe(false)
      expect(isAtLimit(state, "grok")).toBe(false)
    })

    it("returns true when codegraph reaches max (2)", () => {
      recordCall(state, "codegraph", "op1")
      recordCall(state, "codegraph", "op2")
      expect(isAtLimit(state, "codegraph")).toBe(true)
    })

    it("returns true when grok reaches max (1)", () => {
      recordCall(state, "grok", "grok_chat")
      expect(isAtLimit(state, "grok")).toBe(true)
    })
  })

  describe("computeAnalysisPlan", () => {
    it("skips debounced operations in ANALYZE phase", () => {
      recordCall(state, "codegraph", "codegraph_context")
      recordCall(state, "grok", "grok_chat")

      const plan = computeAnalysisPlan(state, "ANALYZE", "fix the bug")
      expect(plan.codegraphOps).toHaveLength(0)
      expect(plan.grokOps).toHaveLength(0)
      expect(plan.reason).toContain("debounced or at limit")
    })

    it("returns codegraph_context on first ANALYZE", () => {
      const plan = computeAnalysisPlan(state, "ANALYZE", "fix the bug")
      expect(plan.codegraphOps).toContain("codegraph_context")
    })

    it("returns codegraph_search on subsequent ANALYZE", () => {
      state.isFirstAnalyze = false
      const plan = computeAnalysisPlan(state, "ANALYZE", "fix the bug")
      expect(plan.codegraphOps).toContain("codegraph_search")
    })

    it("returns codegraph_impact in FIX phase", () => {
      const plan = computeAnalysisPlan(state, "FIX", "fix the bug")
      expect(plan.codegraphOps).toContain("codegraph_impact")
    })
  })

  describe("gateAnalyze", () => {
    it("fails when no results", () => {
      expect(gateAnalyze(undefined).passed).toBe(false)
    })

    it("passes with at least 1 successful call", () => {
      const result = gateAnalyze({
        results: [],
        codegraphCalls: 1,
        grokCalls: 0,
        degraded: false,
      })
      expect(result.passed).toBe(true)
    })

    it("fails when no successful calls and not degraded", () => {
      const result = gateAnalyze({
        results: [],
        codegraphCalls: 0,
        grokCalls: 0,
        degraded: false,
      })
      expect(result.passed).toBe(false)
      expect(result.details).toBe("No successful L3 calls")
    })
  })

  describe("formatL3Results", () => {
    it("returns empty string for no results", () => {
      expect(formatL3Results({ results: [], codegraphCalls: 0, grokCalls: 0, degraded: false })).toBe("")
    })

    it("formats successful results with headers", () => {
      const output = formatL3Results({
        results: [
          { tool: "codegraph", operation: "codegraph_pagerank", data: "some data", success: true, elapsedMs: 100 },
        ],
        codegraphCalls: 1,
        grokCalls: 0,
        degraded: false,
      })
      expect(output).toContain("[CodeGraph]")
      expect(output).toContain("codegraph_pagerank")
      expect(output).toContain("some data")
    })

    it("returns empty when results array is empty even if degraded", () => {
      const output = formatL3Results({
        results: [],
        codegraphCalls: 0,
        grokCalls: 0,
        degraded: true,
        degradeReason: "timeout",
      })
      // formatL3Results returns "" early when results array is empty
      expect(output).toBe("")
    })

    it("includes degrade note when degraded with failed results", () => {
      const output = formatL3Results({
        results: [
          { tool: "codegraph", operation: "codegraph_pagerank", data: "", success: false, elapsedMs: 100 },
        ],
        codegraphCalls: 0,
        grokCalls: 0,
        degraded: true,
        degradeReason: "timeout",
      })
      expect(output).toContain("Degraded")
      expect(output).toContain("timeout")
    })
  })
})
