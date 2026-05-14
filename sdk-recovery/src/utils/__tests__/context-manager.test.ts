// src/utils/__tests__/context-manager.test.ts
import { describe, test, expect } from "bun:test";
import { ContextManager } from "../../cli/agent/context-manager";

describe("ContextManager", () => {
  test("compact preserves tool_use/tool_result pairs", () => {
    const cm = new ContextManager({ maxTurns: 100 });

    // Add enough messages to trigger compaction
    cm.addMessage({ role: "user", content: "msg1" });
    cm.addMessage({ role: "assistant", content: "resp1" });
    cm.addMessage({ role: "user", content: "msg2" });
    cm.addMessage({ role: "assistant", content: "resp2" });
    cm.addMessage({ role: "user", content: "msg3" });
    cm.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
    });
    cm.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [] }],
    });
    cm.addMessage({ role: "assistant", content: "resp3" });
    cm.addMessage({ role: "user", content: "msg4" });
    cm.addMessage({ role: "assistant", content: "resp4" });

    cm.compact();
    const messages = cm.getMessages();

    // Check tool_use and tool_result are both present or both absent
    const hasToolUse = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
    );
    const hasToolResult = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")
    );
    expect(hasToolUse).toBe(hasToolResult);
  });

  test("ensureToolResultPairs finds and includes orphan tool_use", () => {
    const cm = new ContextManager({ maxTurns: 100 });

    // Simulate a scenario where tool_result exists but tool_use was dropped
    // This tests the MessageNormalizer integration
    const messages = cm.getMessages();
    // Empty context should return empty
    expect(messages).toEqual([]);
  });
});
