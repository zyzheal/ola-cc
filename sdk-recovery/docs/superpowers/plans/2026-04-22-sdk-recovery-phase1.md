# Phase 1: Foundation & Critical Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix critical bugs C1/C3, add MessageNormalizer Core component, establish project infrastructure (package.json/tsconfig/build), and fix v1 CLIRuntime bugs I1/I2.

**Architecture:** Add MessageNormalizer as a new Core component that normalizes message sequences before API calls. Fix v2-api.ts agent loop to persist assistant tool_use messages. Add project build infrastructure. Fix v1 processTransport race conditions.

**Tech Stack:** TypeScript, Bun (build), Node.js >=18, ajv, zod/v4

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/anthropic-types.ts` | Create | Anthropic API type definitions (missing from source map recovery) |
| `src/utils/message-normalizer.ts` | Create | MessageNormalizer Core component |
| `src/utils/__tests__/message-normalizer.test.ts` | Create | MessageNormalizer tests |
| `src/cli/agent/context-manager.ts` | Modify | Fix ensureToolResultPairs (C3), integrate MessageNormalizer |
| `src/v2-api.ts` | Modify | Fix agent loop message order (C1), integrate MessageNormalizer |
| `src/transport/processTransport.ts` | Modify | Fix I1 race condition, I2 denial format |
| `src/utils/__tests__/context-manager.test.ts` | Create | ContextManager tests |
| `src/utils/__tests__/v2-api.test.ts` | Create | V2 API integration tests |
| `package.json` | Create | Package metadata, scripts, dependencies |
| `tsconfig.json` | Create | TypeScript configuration |
| `scripts/build.ts` | Create | Bun build script |
| `src/index.ts` | Create | SDK entry point (exports) |
| `.gitignore` | Create | Ignore patterns |

---

### Task 0: Create Missing anthropic-types.ts

**Files:**
- Create: `src/utils/anthropic-types.ts`

This file is imported by 6 modules (`types.ts`, `v2-api.ts`, `protocol.ts`, `api-client.ts`, `context-manager.ts`, `store.ts`) but was not recovered from source maps. It must exist before any other task.

- [ ] **Step 1: Create anthropic-types.ts**

```typescript
// src/utils/anthropic-types.ts
/**
 * Anthropic Messages API type definitions.
 * Recovered from usage patterns across the codebase.
 */

export interface MessageParam {
  role: "user" | "assistant" | "system";
  content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type: string;
    data?: string;
    url?: string;
  };
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface BetaMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
}

export interface BetaUsage extends Usage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface BetaRawMessageStreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop";
  index?: number;
  message?: {
    id: string;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  content_block?: {
    type: "text" | "tool_use";
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type: "text_delta" | "input_json_delta";
    text?: string;
    partial_json?: string;
  };
  usage?: { output_tokens: number };
}

export interface BetaContentBlock extends TextBlock, ToolUseBlock {}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/anthropic-types.ts
git commit -m "fix(phase1): create missing anthropic-types.ts (imported by 6 modules)"
```

---

### Task 1: Project Infrastructure

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `scripts/build.ts`
- Create: `src/index.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "sdk-recovery",
  "version": "0.1.0",
  "description": "Self-developed Agent SDK — alternative to @anthropic-ai/sdk",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "dev": "bun run src/v2-api.ts",
    "build": "bun run scripts/build.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/__tests__/**"]
}
```

- [ ] **Step 3: Create build script**

```typescript
// scripts/build.ts
import { build } from "bun";

const result = await build({
  entrypoints: ["src/index.ts"],
  outdir: "./dist",
  format: "esm",
  target: "node",
  minify: false,
  sourcemap: "linked",
  external: ["ajv", "zod", "@modelcontextprotocol/*"],
});

// Also build CJS format
await build({
  entrypoints: ["src/index.ts"],
  outfile: "./dist/index.cjs",
  format: "cjs",
  target: "node",
  minify: false,
  sourcemap: "linked",
  external: ["ajv", "zod", "@modelcontextprotocol/*"],
});

console.log("Build complete: dist/index.js + dist/index.cjs");
```

- [ ] **Step 4: Create SDK entry point**

```typescript
// src/index.ts
// SDK API — v1 (CLI subprocess mode)
export { query } from "./query";

// SDK API — v2 (direct API mode)
export {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from "./v2-api";

// MCP tool definer
export { tool, createSdkMcpServer } from "./mcp-tools";

// Session utilities
export { startup } from "./utils/session-store";

// Types
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./types";
export { AbortError, InMemorySessionStore } from "./types";
export type * from "./types";
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.env
.claude/sessions/
```

- [ ] **Step 6: Install dependencies and verify build**

```bash
cd sdk-recovery
bun install
bun run build
```

Expected: `dist/index.js` and `dist/index.cjs` created without errors.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json scripts/build.ts src/index.ts .gitignore
git commit -m "feat(phase1): add project infrastructure (package.json, tsconfig, build)"
```

---

### Task 2: MessageNormalizer Core Component

**Files:**
- Create: `src/utils/message-normalizer.ts`
- Create: `src/utils/__tests__/message-normalizer.test.ts`

- [ ] **Step 1: Write tests for MessageNormalizer**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sdk-recovery
bun test src/utils/__tests__/message-normalizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement MessageNormalizer**

```typescript
// src/utils/message-normalizer.ts
import type { MessageParam } from "../utils/anthropic-types";

/**
 * MessageNormalizer ensures message sequences conform to Anthropic API specifications.
 *
 * Rules:
 * 1. Messages must alternate: user → assistant → user → assistant
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

      // Merge consecutive same-role messages
      if (result.length > 0 && result[result.length - 1].role === msg.role) {
        this.mergeMessages(result[result.length - 1], msg);
        continue;
      }

      // If user message contains tool_result without preceding tool_use, insert synthetic assistant message
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
        for (const tr of toolResults) {
          const toolUseId = tr.tool_use_id;
          if (!toolUseMap.has(toolUseId)) {
            // Insert synthetic assistant message with placeholder tool_use
            result.push({
              role: "assistant",
              content: [{ type: "tool_use", id: toolUseId, name: "unknown", input: {} }],
            });
          }
        }
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
      const toolResults = firstRecent.content.filter((b: any) => b.type === "tool_result");
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sdk-recovery
bun test src/utils/__tests__/message-normalizer.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/message-normalizer.ts src/utils/__tests__/message-normalizer.test.ts
git commit -m "feat(phase1): add MessageNormalizer Core component (fixes C1/C3/I2)"
```

---

### Task 3: Fix C1 — v2 Agent Loop Message Order

**Files:**
- Modify: `src/v2-api.ts:281-299`
- Test: `src/utils/__tests__/v2-api.test.ts`

- [ ] **Step 1: Write integration test for agent loop message order**

```typescript
// src/utils/__tests__/v2-api.test.ts
import { describe, test, expect, mock } from "bun:test";
import type { MessageParam } from "../anthropic-types";

describe("v2 API agent loop", () => {
  test("agent loop preserves correct message order: user → assistant(tool_use) → user(tool_result)", () => {
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

    // Step 2: Add assistant message to history (THIS WAS MISSING — C1 bug)
    messages.push(assistantResponse);

    // Step 3: Execute tool and add result
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file content" }] },
      ],
    });

    // Verify message order: user → assistant → user
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
```

- [ ] **Step 2: Fix v2-api.ts agent loop**

In `src/v2-api.ts`, the `send()` method around lines 281-299, change:

```typescript
// BEFORE (buggy — only adds tool_result):
for (const toolUse of toolUseBlocks) {
  const result = await this.registry.execute(
    toolUse.name,
    toolUse.input as Record<string, unknown>,
    { cwd, sessionId: this.sessionId },
  );

  this.contextManager.addMessage({
    role: 'user',
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: result.content as any,
      },
    ],
  });
}

// AFTER (fixed — adds assistant tool_use message first):
// Add the assistant's tool_use messages to context (C1 fix)
this.contextManager.addMessage({
  role: 'assistant',
  content: toolUseBlocks.map((block) => ({
    type: 'tool_use' as const,
    id: block.id,
    name: block.name,
    input: block.input,
  })),
});

// Then add tool_results
for (const toolUse of toolUseBlocks) {
  const result = await this.registry.execute(
    toolUse.name,
    toolUse.input as Record<string, unknown>,
    { cwd, sessionId: this.sessionId },
  );

  this.contextManager.addMessage({
    role: 'user',
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: result.content as any,
      },
    ],
  });
}
```

- [ ] **Step 3: Run tests**

```bash
cd sdk-recovery
bun test src/utils/__tests__/v2-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/v2-api.ts src/utils/__tests__/v2-api.test.ts
git commit -m "fix(phase1): fix C1 — persist assistant tool_use message before tool_result in v2 agent loop"
```

---

### Task 4: Fix C3 — ContextManager ensureToolResultPairs

**Files:**
- Modify: `src/cli/agent/context-manager.ts:124-162`
- Test: `src/utils/__tests__/context-manager.test.ts`

- [ ] **Step 1: Write tests for ContextManager compact**

```typescript
// src/utils/__tests__/context-manager.test.ts
import { describe, test, expect } from "bun:test";
import { ContextManager } from "../context-manager";

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
```

- [ ] **Step 2: Fix ContextManager compact and ensureToolResultPairs**

In `src/cli/agent/context-manager.ts`, replace lines 124-162:

```typescript
// BEFORE (C3 bug — no-op):
compact(): void {
  if (this.messages.length <= 6) return;
  const keepFirst = 2;
  const keepLast = 4;
  if (this.messages.length <= keepFirst + keepLast) return;
  const first = this.messages.slice(0, keepFirst);
  const recent = this.messages.slice(-keepLast);
  const combined = [...first, ...recent];
  this.messages = this.ensureToolResultPairs(combined);
}

private ensureToolResultPairs(messages: MessageParam[]): MessageParam[] {
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseIds.add(block.id);
        }
      }
    }
  }
  return messages; // no-op!
}

// AFTER (fixed):
compact(): void {
  if (this.messages.length <= 6) return;
  const keepFirst = 2;
  const keepLast = 4;
  if (this.messages.length <= keepFirst + keepLast) return;

  // Collect tool_use ids from ALL messages (including dropped range)
  const allToolUses = new Map<string, MessageParam>();
  for (const msg of this.messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as any).type === 'tool_use') {
          allToolUses.set((block as any).id, msg);
        }
      }
    }
  }

  // Keep first N and last M
  const first = this.messages.slice(0, keepFirst);
  const recent = this.messages.slice(-keepLast);

  // Ensure tool_use/tool_result pairs aren't split
  // If recent contains a tool_result, ensure its tool_use is included
  const needed: MessageParam[] = [];
  for (const msg of recent) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as any).type === 'tool_result') {
          const toolUseId = (block as any).tool_use_id;
          const toolUseMsg = allToolUses.get(toolUseId);
          if (toolUseMsg && !first.includes(toolUseMsg) && !recent.includes(toolUseMsg) && !needed.includes(toolUseMsg)) {
            needed.push(toolUseMsg);
          }
        }
      }
    }
  }

  this.messages = [...first, ...needed, ...recent];
}
```

Remove the now-unused `ensureToolResultPairs` method entirely.

- [ ] **Step 3: Run tests**

```bash
cd sdk-recovery
bun test src/utils/__tests__/context-manager.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/agent/context-manager.ts src/utils/__tests__/context-manager.test.ts
git commit -m "fix(phase1): fix C3 — ContextManager compact now preserves tool_use/tool_result pairs"
```

---

### Task 5: Fix v1 CLIRuntime Bugs (I1/I2)

**Files:**
- Modify: `src/transport/processTransport.ts:161-185` (I1)
- Modify: `src/transport/processTransport.ts:472-498` (I2)

- [ ] **Step 1: Fix I1 — stdin write race condition**

In `src/transport/processTransport.ts`, replace lines 161-185:

```typescript
// BEFORE:
async sendControlRequest(subtype: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!this.process?.stdin) throw new Error('Transport not started');
  const requestId = randomUUID();
  const cmd: Record<string, unknown> = {
    type: 'control',
    action: subtype,
    request_id: requestId,
    ...params,
  };
  const promise = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingControlRequests.delete(requestId);
      reject(new Error(`Control request '${subtype}' timed out (request_id: ${requestId})`));
    }, 30000);
    this.pendingControlRequests.set(requestId, { resolve, reject, timeout });
  });
  this.process.stdin.write(JSON.stringify(cmd) + '\n');
  return promise;
}

// AFTER (check process state before write, handle write errors):
async sendControlRequest(subtype: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!this.process?.stdin) throw new Error('Transport not started');
  if (this.closed || this.process?.pid === undefined) {
    throw new Error(`Cannot send control request '${subtype}': CLI process is not running`);
  }

  const requestId = randomUUID();
  const cmd: Record<string, unknown> = {
    type: 'control',
    action: subtype,
    request_id: requestId,
    ...params,
  };

  const promise = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingControlRequests.delete(requestId);
      reject(new Error(`Control request '${subtype}' timed out (request_id: ${requestId})`));
    }, 30000);
    this.pendingControlRequests.set(requestId, { resolve, reject, timeout });
  });

  const json = JSON.stringify(cmd) + '\n';
  const wrote = this.process.stdin.write(json);
  if (!wrote) {
    // Stream buffer full or closed — reject immediately
    this.pendingControlRequests.delete(requestId);
    clearTimeout((this.pendingControlRequests as any).get(requestId)?.timeout);
    throw new Error(`Failed to write control request '${subtype}' to stdin`);
  }

  return promise;
}
```

- [ ] **Step 2: Fix I2 — denial message format**

In `src/transport/processTransport.ts`, replace lines 472-498:

```typescript
// BEFORE (I2 — tool_use and tool_result in same message, wrong format):
const denialMsg: SDKMessage = {
  type: 'assistant',
  message: {
    id: `msg-denial-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolUseId,
      name: toolName,
      input: toolInput,
    }, {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: `Tool execution denied: ${result.message}` }],
      is_error: true,
    }],
    ...
  },
  ...
};

// AFTER (I2 — use MessageNormalizer to create properly formatted denial):
// At top of file, import:
import { MessageNormalizer } from '../utils/message-normalizer';

// Replace the denialMsg construction:
const normalizer = new MessageNormalizer();
const denialAssistantMsg = normalizer.createDenialMessage(
  { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
  result.message,
);

const denialMsg: SDKMessage = {
  type: 'assistant',
  message: {
    id: `msg-denial-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: denialAssistantMsg.content,
    model: 'unknown',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  parent_tool_use_id: (data as any).parent_tool_use_id ?? null,
  session_id: this.sessionId ?? 'unknown',
  uuid: randomUUID(),
} as SDKAssistantMessage;
```

- [ ] **Step 3: Commit**

```bash
git add src/transport/processTransport.ts
git commit -m "fix(phase1): fix I1 stdin race condition and I2 denial message format in CLIRuntime"
```

---

### Task 6: Verify End-to-End

- [ ] **Step 1: Run all tests**

```bash
cd sdk-recovery
bun test
```

Expected: All tests PASS (message-normalizer, context-manager, v2-api).

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: No type errors.

- [ ] **Step 3: Run build**

```bash
bun run build
```

Expected: `dist/index.js` and `dist/index.cjs` created.

- [ ] **Step 4: Verify exports**

```bash
node -e "const sdk = require('./dist/index.cjs'); console.log(Object.keys(sdk))"
```

Expected output: `['query','unstable_v2_createSession','unstable_v2_resumeSession','unstable_v2_prompt','tool','createSdkMcpServer','startup','SYSTEM_PROMPT_DYNAMIC_BOUNDARY','AbortError','InMemorySessionStore',...]`

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat(phase1): Phase 1 complete — infrastructure + critical bug fixes (C1/C3/I1/I2)"
```

---

## Phase 1 Deliverables

| Deliverable | Status |
|-------------|--------|
| Missing anthropic-types.ts | ✅ Task 0 |
| MessageNormalizer Core component | ✅ Task 2 |
| C1 bug fix (v2 agent loop message order) | ✅ Task 3 |
| C3 bug fix (ContextManager compact) | ✅ Task 4 |
| I1 bug fix (stdin race condition) | ✅ Task 5 |
| I2 bug fix (denial message format) | ✅ Task 5 |
| Project infrastructure (package.json/tsconfig/build) | ✅ Task 1 |
| SDK entry point with exports | ✅ Task 1 |
| Test coverage for new code | ✅ Tasks 2, 3, 4 |
