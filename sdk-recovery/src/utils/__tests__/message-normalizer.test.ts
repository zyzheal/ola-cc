// src/utils/__tests__/message-normalizer.test.ts
import { describe, test, expect } from "bun:test";
import { MessageNormalizer } from "../message-normalizer";
import type { MessageParam } from "../../utils/anthropic-types";

describe("MessageNormalizer", () => {
  const normalizer = new MessageNormalizer();

  describe("normalizeSequence", () => {
    test("passes valid alternating user/assistant sequence through", () => {
      const messages: MessageParam[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      expect(normalizer.normalizeSequence(messages)).toEqual(messages);
    });

    test("inserts missing assistant message before orphan tool_result", () => {
      // tool_result without preceding tool_use in assistant message
      const messages: MessageParam[] = [
        { role: "user", content: "run tool" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ];
      const result = normalizer.normalizeSequence(messages);
      // Should have an assistant tool_use message before the tool_result
      const assistantMsg = result.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBeDefined();
      if (Array.isArray(assistantMsg!.content)) {
        expect(
          assistantMsg!.content.some(
            (b: any) => b.type === "tool_use" && b.id === "tool-1"
          )
        ).toBe(true);
      }
    });
  });

  describe("safeCompact", () => {
    test("keeps tool_use/tool_result pairs together", () => {
      const messages: MessageParam[] = [
        { role: "user", content: "msg1" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [] },
          ],
        },
        { role: "user", content: "msg2" },
        { role: "assistant", content: "done" },
      ];
      const compacted = normalizer.safeCompact(messages, 1, 2);
      // tool_use + tool_result pair should not be split
      const hasToolUse = compacted.some(
        (m: MessageParam) =>
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === "tool_use")
      );
      const hasToolResult = compacted.some(
        (m: MessageParam) =>
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === "tool_result")
      );
      // Either both present or both absent (kept as a pair)
      expect(hasToolUse).toBe(hasToolResult);
    });
  });

  describe("createDenialMessage", () => {
    test("creates properly formatted denial with separate tool_use and tool_result", () => {
      const toolUse = {
        type: "tool_use" as const,
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
      };
      const result = normalizer.createDenialMessage(toolUse, "not allowed");

      // Should return a MessageParam with tool_use in assistant content
      expect(result.role).toBe("assistant");
      expect(Array.isArray(result.content)).toBe(true);
      if (Array.isArray(result.content)) {
        expect(result.content[0]).toEqual({
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "ls" },
        });
        expect(result.content[1]).toEqual({
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "Tool execution denied: not allowed" }],
          is_error: true,
        });
      }
    });
  });
});
