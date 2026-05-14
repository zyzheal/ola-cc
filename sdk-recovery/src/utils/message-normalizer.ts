// src/utils/message-normalizer.ts
import type { MessageParam, ToolResultBlock } from "../utils/anthropic-types";

/**
 * MessageNormalizer ensures message sequences conform to Anthropic API specifications.
 *
 * Rules:
 * 1. Messages must alternate: user -> assistant -> user -> assistant
 * 2. tool_result (user) must be preceded by tool_use (assistant) with matching id
 * 3. tool_use (assistant) must be followed by tool_result (user)
 */
export class MessageNormalizer {
  /**
   * Normalize a message sequence to ensure it conforms to API requirements.
   * Inserts missing assistant tool_use messages before orphan tool_results.
   * Merges consecutive same-role messages.
   */
  normalizeSequence(messages: MessageParam[]): MessageParam[] {
    if (messages.length === 0) return messages;

    const result: MessageParam[] = [];

    // Collect all tool_use ids from assistant messages
    const toolUseMap = new Map<string, { tool_use_id: string; name: string; input: Record<string, unknown> }>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === "tool_use") {
            toolUseMap.set((block as any).id, {
              tool_use_id: (block as any).id,
              name: (block as any).name,
              input: (block as any).input ?? {},
            });
          }
        }
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // If user message contains tool_result without preceding tool_use, insert synthetic assistant message
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
        for (const tr of toolResults) {
          if (!toolUseMap.has(tr.tool_use_id)) {
            // Insert synthetic assistant message with placeholder tool_use
            result.push({
              role: "assistant",
              content: [{ type: "tool_use", id: tr.tool_use_id, name: "unknown", input: {} }],
            });
          }
        }
      }

      // Merge consecutive same-role messages
      if (result.length > 0 && result[result.length - 1].role === msg.role) {
        this.mergeMessages(result[result.length - 1], msg);
        continue;
      }

      result.push(msg);
    }

    return result;
  }

  /**
   * Compact messages while preserving tool_use/tool_result pairs.
   * Keeps first N and last M messages, but ensures pairs aren't split.
   */
  safeCompact(messages: MessageParam[], keepFirst: number = 2, keepLast: number = 4): MessageParam[] {
    if (messages.length <= keepFirst + keepLast) return messages;

    const first = messages.slice(0, keepFirst);
    const recent = messages.slice(-keepLast);

    // If first of recent is a tool_result, find and include its tool_use
    const firstRecent = recent[0];
    if (firstRecent.role === "user" && Array.isArray(firstRecent.content)) {
      const toolResults = firstRecent.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
      for (const tr of toolResults) {
        const toolUseId = tr.tool_use_id;
        // Find the corresponding tool_use in the dropped range
        const toolUseMsg = this.findToolUseById(messages.slice(keepFirst, -keepLast), toolUseId);
        if (toolUseMsg && !first.includes(toolUseMsg) && !recent.includes(toolUseMsg)) {
          first.push(toolUseMsg);
        }
      }
    }

    // Merge and deduplicate
    return this.mergeConsecutiveSameRole([...first, ...recent]);
  }

  /**
   * Create a properly formatted denial message.
   * Returns a MessageParam with tool_use followed by tool_result in the same message
   * (this is the format Anthropic expects for denials).
   */
  createDenialMessage(
    toolUse: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> },
    reason: string
  ): MessageParam {
    return {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input },
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [{ type: "text", text: `Tool execution denied: ${reason}` }],
          is_error: true,
        },
      ],
    };
  }

  /** Private helpers */

  private mergeMessages(target: MessageParam, source: MessageParam): void {
    if (typeof target.content === "string" && typeof source.content === "string") {
      target.content += "\n" + source.content;
    } else if (Array.isArray(target.content) && Array.isArray(source.content)) {
      target.content.push(...source.content);
    } else if (typeof target.content === "string" && Array.isArray(source.content)) {
      target.content = [{ type: "text", text: target.content }, ...source.content];
    } else if (Array.isArray(target.content) && typeof source.content === "string") {
      target.content.push({ type: "text", text: source.content });
    }
  }

  private findToolUseById(messages: MessageParam[], toolUseId: string): MessageParam | undefined {
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === "tool_use" && (block as any).id === toolUseId) {
            return msg;
          }
        }
      }
    }
    return undefined;
  }

  private mergeConsecutiveSameRole(messages: MessageParam[]): MessageParam[] {
    const result: MessageParam[] = [];
    for (const msg of messages) {
      if (result.length > 0 && result[result.length - 1].role === msg.role) {
        this.mergeMessages(result[result.length - 1], msg);
      } else {
        result.push(msg);
      }
    }
    return result;
  }
}
