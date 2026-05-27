/**
 * Tests for goal memory management (P0-01, P0-02, P0-03 fixes)
 *
 * Run: bun test src/utils/goal/goalMemory.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  checkBudgetThreshold,
  disposeGoalMemory,
  checkMemoryIfNeeded,
  getGoalMemoryDebugInfo,
} from "./goalMemory.js";
import type { Goal } from "../../commands/goal/types.js";
import { ThreadGoalStatus } from "../../commands/goal/types.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "test-goal-1",
    threadId: "test-thread-1",
    objective: "Test objective",
    status: ThreadGoalStatus.Active,
    tokenBudget: 100000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalApiTokens: 0,
    totalApiWallMs: 0,
    mode: "standard",
    autoEdit: false,
    ...overrides,
  };
}

describe("BudgetMonitor — P0-03 冷却期", () => {
  beforeEach(() => {
    // Clear internal state before each test
    disposeGoalMemory("test-goal-1");
    disposeGoalMemory("test-goal-2");
  });

  it("should not trigger when no budget limit", () => {
    const goal = makeGoal({ tokenBudget: null });
    const result = checkBudgetThreshold(goal);
    expect(result.shouldCompact).toBe(false);
  });

  it("should not trigger below 70% threshold", () => {
    const goal = makeGoal({ tokensUsed: 69000 }); // 69%
    const result = checkBudgetThreshold(goal);
    expect(result.shouldCompact).toBe(false);
  });

  it("should trigger at 70% budget usage", () => {
    const goal = makeGoal({ tokensUsed: 70000 }); // 70%
    const result = checkBudgetThreshold(goal);
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toContain("budget at 70.0%");
  });

  it("should not trigger again during cooldown period", () => {
    const goal = makeGoal({ tokensUsed: 70000 });

    // First call: triggers
    const r1 = checkBudgetThreshold(goal);
    expect(r1.shouldCompact).toBe(true);

    // Subsequent calls during cooldown: should not trigger
    for (let i = 0; i < 5; i++) {
      const result = checkBudgetThreshold(goal);
      expect(result.shouldCompact).toBe(false);
      expect(result.reason).toContain("cooldown");
    }
  });

  it("should not trigger after cooldown if budget growth is too small", () => {
    const goal = makeGoal({ tokensUsed: 70000 });

    // First trigger
    checkBudgetThreshold(goal);

    // Exhaust cooldown (5 turns)
    for (let i = 0; i < 5; i++) {
      checkBudgetThreshold(goal);
    }

    // Budget increased only 2% (less than 10% min delta)
    goal.tokensUsed = 72000;
    const result = checkBudgetThreshold(goal);
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toContain("delta too small");
  });

  it("should trigger after cooldown if budget growth >= 10%", () => {
    const goal = makeGoal({ tokensUsed: 70000 });

    // First trigger at 70%
    const r1 = checkBudgetThreshold(goal);
    expect(r1.shouldCompact).toBe(true);

    // Exhaust cooldown (5 turns)
    for (let i = 0; i < 5; i++) {
      checkBudgetThreshold(goal);
    }

    // Budget increased 15% (>= 10% min delta)
    goal.tokensUsed = 85000;
    const result = checkBudgetThreshold(goal);
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toContain("budget at 85.0%");
  });
});

describe("checkMemoryIfNeeded — unified entry + P1-04 fallback", () => {
  beforeEach(() => {
    disposeGoalMemory("test-goal-1");
  });

  it("should return shouldCompact=false when budget below threshold", () => {
    const goal = makeGoal({ tokensUsed: 50000 });
    const result = checkMemoryIfNeeded(goal);
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("should return shouldCompact=true with reason budget_threshold", () => {
    const goal = makeGoal({ tokensUsed: 75000 });
    const result = checkMemoryIfNeeded(goal);
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe("budget_threshold");
    expect(result.message).toContain("budget at");
  });

  it("should not crash on error (P1-04 fallback)", () => {
    // Passing an invalid goal to test graceful degradation
    const invalidGoal = makeGoal({ tokenBudget: 0 });
    const result = checkMemoryIfNeeded(invalidGoal);
    // Should return shouldCompact: false rather than throwing
    expect(result.shouldCompact).toBe(false);
  });
});

describe("SessionMCRegistry — P0-01 lifecycle", () => {
  const { SessionMCRegistry } = require("../../services/compact/cachedMicrocompact.js");

  beforeEach(() => {
    SessionMCRegistry.dispose("test-goal-1");
    SessionMCRegistry.dispose("test-goal-2");
  });

  it("should create isolated instances per goal", () => {
    const state1 = SessionMCRegistry.getOrCreate("test-goal-1");
    const state2 = SessionMCRegistry.getOrCreate("test-goal-2");

    expect(state1.cacheId).not.toBe(state2.cacheId);
    expect(state1.toolResults).not.toBe(state2.toolResults);
  });

  it("should return same instance for same goalId", () => {
    const s1 = SessionMCRegistry.getOrCreate("test-goal-1");
    const s2 = SessionMCRegistry.getOrCreate("test-goal-1");
    expect(s1).toBe(s2);
  });

  it("should dispose instance on goal completion", () => {
    SessionMCRegistry.getOrCreate("test-goal-1");
    expect(SessionMCRegistry.size).toBe(1);

    SessionMCRegistry.dispose("test-goal-1");
    expect(SessionMCRegistry.size).toBe(0);
  });

  it("should cleanup idle instances", () => {
    SessionMCRegistry.getOrCreate("test-goal-1");
    SessionMCRegistry.getOrCreate("test-goal-2");
    expect(SessionMCRegistry.size).toBe(2);

    // Manually set lastAccessAt to simulate old instances
    // (can't rely on time passing in fast tests)
    const registry = (SessionMCRegistry as any).registry as Map<string, any>;
    for (const instance of registry.values()) {
      instance.lastAccessAt = Date.now() - 100000; // 100s ago
    }

    // Cleanup with 50s max idle — should remove all
    SessionMCRegistry.cleanup(50 * 1000);
    expect(SessionMCRegistry.size).toBe(0);
  });
});

describe("disposeGoalMemory — integration", () => {
  const { SessionMCRegistry } = require("../../services/compact/cachedMicrocompact.js");

  beforeEach(() => {
    disposeGoalMemory("test-goal-1");
    disposeGoalMemory("test-goal-2");
    SessionMCRegistry.dispose("test-goal-1");
    SessionMCRegistry.dispose("test-goal-2");
  });

  it("should clear both goal state and SessionMCRegistry", () => {
    // Create states
    checkBudgetThreshold(makeGoal({ id: "test-goal-1", tokensUsed: 10000 }));
    SessionMCRegistry.getOrCreate("test-goal-1");

    expect(getGoalMemoryDebugInfo("test-goal-1")).not.toBeNull();
    expect(SessionMCRegistry.size).toBe(1);

    // Dispose
    disposeGoalMemory("test-goal-1");

    expect(getGoalMemoryDebugInfo("test-goal-1")).toBeNull();
    expect(SessionMCRegistry.size).toBe(0);
  });
});
