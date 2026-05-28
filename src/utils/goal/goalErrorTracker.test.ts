/**
 * Tests for goalErrorTracker — 统一错误追踪系统
 *
 * Run: bun test src/utils/goal/goalErrorTracker.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  createTracker,
  recordError,
  resetCategory,
  resetOnProgress,
  shouldPause,
  getErrorCount,
  DEFAULT_THRESHOLDS,
} from "./goalErrorTracker.js";
import type { UnifiedErrorTracker, ErrorCategory } from "./goalErrorTracker.js";

// ============================================
// 辅助函数
// ============================================

/** 将 tracker 序列化再反序列化，验证 JSON 兼容性 */
function roundTrip(tracker: UnifiedErrorTracker): UnifiedErrorTracker {
  return JSON.parse(JSON.stringify(tracker)) as UnifiedErrorTracker;
}

/** 将指定类别的计数推到刚好触发暂停 */
function pushToThreshold(tracker: UnifiedErrorTracker, category: ErrorCategory): void {
  const threshold = DEFAULT_THRESHOLDS[category];
  for (let i = 0; i < threshold; i++) {
    recordError(tracker, category);
  }
}

// ============================================
// 测试
// ============================================

describe("goalErrorTracker", () => {
  describe("createTracker — 初始状态", () => {
    it("should initialize all category counts to zero", () => {
      const tracker = createTracker();
      expect(getErrorCount(tracker, "runtime_exception")).toBe(0);
      expect(getErrorCount(tracker, "dead_turn")).toBe(0);
      expect(getErrorCount(tracker, "critical_analysis")).toBe(0);
    });

    it("should initialize recoveryLayer to FIX_RETRY", () => {
      const tracker = createTracker();
      expect(tracker.recoveryLayer).toBe("FIX_RETRY");
    });

    it("should initialize fullRestartUsed to false", () => {
      const tracker = createTracker();
      expect(tracker.fullRestartUsed).toBe(false);
    });

    it("should not pause with no errors", () => {
      const tracker = createTracker();
      expect(shouldPause(tracker)).toBe(false);
    });
  });

  describe("recordError + shouldPause", () => {
    it("should pause after 3 runtime_exceptions", () => {
      const tracker = createTracker();
      pushToThreshold(tracker, "runtime_exception");
      expect(shouldPause(tracker)).toBe(true);
    });

    it("should not pause after 2 runtime_exceptions", () => {
      const tracker = createTracker();
      recordError(tracker, "runtime_exception");
      recordError(tracker, "runtime_exception");
      expect(shouldPause(tracker)).toBe(false);
    });

    it("should pause after 5 dead_turns", () => {
      const tracker = createTracker();
      pushToThreshold(tracker, "dead_turn");
      expect(shouldPause(tracker)).toBe(true);
    });

    it("should not pause after 4 dead_turns", () => {
      const tracker = createTracker();
      for (let i = 0; i < 4; i++) {
        recordError(tracker, "dead_turn");
      }
      expect(shouldPause(tracker)).toBe(false);
    });

    it("should pause after 3 critical_analyses", () => {
      const tracker = createTracker();
      pushToThreshold(tracker, "critical_analysis");
      expect(shouldPause(tracker)).toBe(true);
    });

    it("should not pause after 2 critical_analyses", () => {
      const tracker = createTracker();
      recordError(tracker, "critical_analysis");
      recordError(tracker, "critical_analysis");
      expect(shouldPause(tracker)).toBe(false);
    });

    it("should pause when any single category hits threshold", () => {
      const tracker = createTracker();
      // Push runtime_exception to threshold while others are below
      recordError(tracker, "dead_turn");
      recordError(tracker, "critical_analysis");
      pushToThreshold(tracker, "runtime_exception");
      expect(shouldPause(tracker)).toBe(true);
    });
  });

  describe("getErrorCount", () => {
    it("should return correct count after multiple recordError calls", () => {
      const tracker = createTracker();
      recordError(tracker, "runtime_exception");
      recordError(tracker, "runtime_exception");
      expect(getErrorCount(tracker, "runtime_exception")).toBe(2);
      expect(getErrorCount(tracker, "dead_turn")).toBe(0);
    });
  });

  describe("resetCategory", () => {
    it("should reset only the specified category", () => {
      const tracker = createTracker();
      recordError(tracker, "runtime_exception");
      recordError(tracker, "runtime_exception");
      recordError(tracker, "dead_turn");

      resetCategory(tracker, "runtime_exception");

      expect(getErrorCount(tracker, "runtime_exception")).toBe(0);
      expect(getErrorCount(tracker, "dead_turn")).toBe(1);
    });
  });

  describe("resetOnProgress", () => {
    it("should reset dead_turn and runtime_exception but NOT critical_analysis", () => {
      const tracker = createTracker();
      recordError(tracker, "runtime_exception");
      recordError(tracker, "runtime_exception");
      recordError(tracker, "dead_turn");
      recordError(tracker, "dead_turn");
      recordError(tracker, "dead_turn");
      recordError(tracker, "critical_analysis");
      recordError(tracker, "critical_analysis");

      resetOnProgress(tracker);

      expect(getErrorCount(tracker, "runtime_exception")).toBe(0);
      expect(getErrorCount(tracker, "dead_turn")).toBe(0);
      expect(getErrorCount(tracker, "critical_analysis")).toBe(2);
    });

    it("should allow shouldPause to return false after resetting below-threshold categories", () => {
      const tracker = createTracker();
      pushToThreshold(tracker, "runtime_exception");
      expect(shouldPause(tracker)).toBe(true);

      resetOnProgress(tracker);
      expect(shouldPause(tracker)).toBe(false);
    });
  });

  describe("recoveryLayer tracking", () => {
    it("should allow setting recoveryLayer", () => {
      const tracker = createTracker();
      tracker.recoveryLayer = "SKILL_RETRY";
      expect(tracker.recoveryLayer).toBe("SKILL_RETRY");

      tracker.recoveryLayer = "FULL_RESTART";
      expect(tracker.recoveryLayer).toBe("FULL_RESTART");
    });

    it("should allow setting fullRestartUsed", () => {
      const tracker = createTracker();
      tracker.fullRestartUsed = true;
      expect(tracker.fullRestartUsed).toBe(true);
    });
  });

  describe("JSON serialization (Record, not Map)", () => {
    it("should survive JSON round-trip", () => {
      const tracker = createTracker();
      recordError(tracker, "runtime_exception");
      recordError(tracker, "dead_turn");
      recordError(tracker, "dead_turn");
      recordError(tracker, "critical_analysis");
      tracker.recoveryLayer = "SKILL_RETRY";
      tracker.fullRestartUsed = true;

      const restored = roundTrip(tracker);

      expect(restored.categories.runtime_exception.count).toBe(1);
      expect(restored.categories.dead_turn.count).toBe(2);
      expect(restored.categories.critical_analysis.count).toBe(1);
      expect(restored.recoveryLayer).toBe("SKILL_RETRY");
      expect(restored.fullRestartUsed).toBe(true);
    });

    it("should preserve thresholds after round-trip", () => {
      const tracker = createTracker();
      const restored = roundTrip(tracker);

      expect(restored.categories.runtime_exception.threshold).toBe(3);
      expect(restored.categories.dead_turn.threshold).toBe(5);
      expect(restored.categories.critical_analysis.threshold).toBe(3);
    });

    it("serialized form should be plain object (not Map)", () => {
      const tracker = createTracker();
      const serialized = JSON.stringify(tracker);
      const parsed = JSON.parse(serialized);

      // Verify it's a plain Record, not a Map
      expect(parsed.categories).toHaveProperty("runtime_exception");
      expect(parsed.categories).toHaveProperty("dead_turn");
      expect(parsed.categories).toHaveProperty("critical_analysis");
      expect(typeof parsed.categories.runtime_exception.count).toBe("number");
    });
  });
});
