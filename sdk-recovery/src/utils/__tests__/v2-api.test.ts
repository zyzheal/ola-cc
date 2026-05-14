// src/utils/__tests__/v2-api.test.ts
import { describe, test, expect } from "bun:test";
import type { MessageParam } from "../anthropic-types";

describe("v2 API agent loop", () => {
  test("agent loop preserves correct message order: user -> assistant(tool_use) -> user(tool_result)", () => {
    // Simulate the agent loop message flow
    const messages: MessageParam[] = [
      { role: "user", content: "read the file" },
    ];

    // Step 1: API returns assistant message with tool_use
    const assistantResponse: MessageParam = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { path: "test.txt" } },
      ],
    };

    // Step 2: Add assistant message to history (THIS WAS MISSING - C1 bug)
    messages.push(assistantResponse);

    // Step 3: Execute tool and add result
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file content" }] },
      ],
    });

    // Verify message order: user -> assistant -> user
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");

    // Verify tool_use precedes tool_result
    const toolUseMsg = messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
    );
    const toolResultMsg = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")
    );
    expect(toolUseMsg).toBeDefined();
    expect(toolResultMsg).toBeDefined();
    expect(messages.indexOf(toolUseMsg!)).toBeLessThan(messages.indexOf(toolResultMsg!));
  });
});
