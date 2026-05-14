# Full SDK Decoupling — Remove All External SDK Dependencies

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将主项目（`src/`）中所有对 `@anthropic-ai/sdk`、`@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/mcpb`、`@anthropic-ai/sandbox-runtime` 的 import 全部替换为 `sdk-recovery` 自研模块，并删除 `shims/` 目录及其在 `package.json` 中的依赖。

**Architecture:** sdk-recovery 已经实现了大部分类型定义和兼容层。本计划分为 4 个子系统：(1) SDK 类型系统完善 — 补充缺失的 types 使其覆盖所有 import 路径；(2) 主项目 import 替换 — 批量将 `@anthropic-ai/sdk` import 指向 sdk-recovery；(3) claude-agent-sdk / mcpb / sandbox-runtime 类型自研替代；(4) 删除 shims 并验证构建。

**Tech Stack:** TypeScript, Bun, sdk-recovery (自研 SDK), path alias 或 tsconfig paths

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `sdk-recovery/src/resources/index.ts` | Modify | 补充所有缺失的 SDK 类型导出 |
| `sdk-recovery/src/compat.ts` | Modify | 完善 Anthropic 兼容层（Stream 类型等） |
| `sdk-recovery/src/index.ts` | Modify | 更新导出路径 |
| `sdk-recovery/src/claude-agent-sdk.ts` | Modify | 自研 PermissionMode 等类型替代 shim re-export |
| `sdk-recovery/src/mcpb.ts` | Modify | 自研 McpbManifest 类型替代 shim re-export |
| `sdk-recovery/src/sandbox-runtime.ts` | Modify | 自研 Sandbox 类型替代 shim re-export |
| `tsconfig.json` (root) | Modify | 添加 paths 映射将 `@anthropic-ai/sdk` 指向 sdk-recovery |
| `package.json` (root) | Modify | 删除 `@anthropic-ai/sdk` 等 shim 依赖，添加 `sdk-recovery` alias |
| `src/**` (124 files) | Modify | 无需修改文件内容（通过 tsconfig paths 透明重定向） |
| `shims/sdk` | Delete | 删除 |
| `shims/claude-agent-sdk` | Delete | 删除 |
| `shims/mcpb` | Delete | 删除 |
| `shims/sandbox-runtime` | Delete | 删除 |

---

## 关键设计决策

### 使用 tsconfig `paths` 透明重定向

当前主项目有 124 个文件引用 `@anthropic-ai/sdk`。最安全的做法是不修改这 124 个文件的 import 语句，而是在根 `tsconfig.json` 中使用 `paths` 映射：

```json
{
  "compilerOptions": {
    "paths": {
      "@anthropic-ai/sdk": ["./sdk-recovery/src/compat.ts"],
      "@anthropic-ai/sdk/*": ["./sdk-recovery/src/resources/*"],
      "@anthropic-ai/claude-agent-sdk": ["./sdk-recovery/src/index.ts"],
      "@anthropic-ai/mcpb": ["./sdk-recovery/src/mcpb.ts"],
      "@anthropic-ai/sandbox-runtime": ["./sdk-recovery/src/sandbox-runtime.ts"]
    }
  }
}
```

这样所有现有 import 语句无需修改，编译时自动重定向到 sdk-recovery。

### 为什么不用 barrel export

如果让所有文件改 import（如 `from 'sdk-recovery'`），改动量巨大且容易出错。tsconfig paths 方案：
- 零文件修改（import 语句不变）
- 可逐步迁移（改完一个模块后可以直接 import）
- 回滚容易

---

### Task 1: 完善 sdk-recovery 类型系统

**Files:**
- Modify: `sdk-recovery/src/resources/index.ts`
- Modify: `sdk-recovery/src/utils/anthropic-types.ts`

sdk-recovery 的 `resources/index.ts` 已经导出了大部分类型，但需要补充以下缺失类型（根据 124 个引用文件的 import 分析）：

当前 `resources/index.ts` **已有**：MessageParam, TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, Tool, Usage, BetaMessage, BetaUsage, BetaRawMessageStreamEvent, TextBlockParam, ToolUseBlockParam, ToolResultBlockParam, ImageBlockParam, Base64ImageSource, ContentBlockParam, ContentBlock, ThinkingBlock, ThinkingBlockParam, BetaContentBlock, BetaToolUseBlock, BetaMessageParam, BetaTool, BetaToolUnion, BetaMessageStreamParams, BetaContentBlockParam, BetaImageBlockParam, BetaMessageDeltaUsage, BetaOutputConfig, BetaRequestDocumentBlock, BetaStopReason, BetaToolChoiceAuto, BetaToolChoiceTool, BetaToolResultBlockParam, BetaWebSearchTool20250305, BetaRedactedThinkingBlock, BetaThinkingBlock, BetaJSONOutputFormat, RedactedThinkingBlock, RedactedThinkingBlockParam, Stream

**需要补充的类型**（在 `resources/index.ts` 中添加）：

- [ ] **Step 1: 补充缺失类型到 resources/index.ts**

在 `sdk-recovery/src/resources/index.ts` 末尾添加以下类型：

```typescript
// --- Additional types required by main codebase imports ---

// Beta message types (from beta/messages/messages.mjs)
export type BetaMessage = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<TextBlockParam | ToolUseBlockParam>;
  model: string;
  stop_reason: BetaStopReason;
  stop_sequence: string | null;
  usage: BetaUsage;
};

export type BetaContentBlock = TextBlockParam | ToolUseBlockParam;

// ToolChoice types
export type ToolChoice = 'auto' | 'any' | 'tool';
export type ToolChoiceAuto = { type: 'auto' };
export type ToolChoiceAny = { type: 'any' };
export type ToolChoiceTool = { type: 'tool'; name: string };
export type ToolChoiceNone = { type: 'none' };

// Cache types
export type CacheControlEphemeral = { type: 'ephemeral' };
export type CacheCreation = { type: 'creation' };

// Citation types (simplified stubs — sufficient for type checking)
export type CitationCharLocation = { type: 'char_location'; start_index: number; end_index: number };
export type CitationCharLocationParam = CitationCharLocation;
export type CitationPageLocation = { type: 'page_location'; page_number: number };
export type CitationPageLocationParam = CitationPageLocation;
export type CitationContentBlockLocation = { type: 'content_block_location'; block_index: number };
export type CitationContentBlockLocationParam = CitationContentBlockLocation;
export type CitationsConfig = { enabled: boolean };
export type CitationsConfigParam = CitationsConfig;
export type CitationsDelta = CitationCharLocation;
export type CitationsWebSearchResultLocation = { type: 'web_search_result_location'; url: string };
export type CitationsSearchResultLocation = CitationsWebSearchResultLocation;

// ContentBlockSource types
export type ContentBlockSource = {
  type: 'content_block_source';
  content: ContentBlockSourceContent;
};
export type ContentBlockSourceContent = {
  text?: string;
  citations?: Array<CitationCharLocationParam | CitationPageLocationParam | CitationContentBlockLocationParam>;
};

// Document types
export type DocumentBlock = { type: 'document'; source: { type: 'base64' | 'url'; media_type: string; data?: string; url?: string } };
export type DocumentBlockParam = DocumentBlock;

// Message event types
export type MessageStartEvent = { type: 'message_start'; message: BetaMessage };
export type MessageStopEvent = { type: 'message_stop' };
export type MessageDeltaEvent = { type: 'message_delta'; delta: { stop_reason?: BetaStopReason }; usage: BetaMessageDeltaUsage };
export type MessageStreamEvent = MessageStartEvent | MessageDeltaEvent | MessageStopEvent | RawContentBlockStartEvent | RawContentBlockDeltaEvent | RawContentBlockStopEvent;

// Raw event types
export type RawMessageStartEvent = { type: 'message_start'; message: BetaMessage };
export type RawMessageStopEvent = { type: 'message_stop' };
export type RawMessageDeltaEvent = { type: 'message_delta'; delta: { stop_reason?: BetaStopReason }; usage: BetaMessageDeltaUsage };
export type RawContentBlockStartEvent = { type: 'content_block_start'; index: number; content_block: ContentBlockParam };
export type RawContentBlockDeltaEvent = { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text?: string } | { type: 'input_json_delta'; partial_json?: string } | { type: 'thinking_delta'; thinking?: string; signature?: string } | { type: 'signature_delta'; signature?: string } };
export type RawContentBlockStopEvent = { type: 'content_block_stop'; index: number };
export type RawContentBlockDelta = RawContentBlockDeltaEvent;
export type RawContentBlockStart = RawContentBlockStartEvent;
export type RawContentBlockStop = RawContentBlockStopEvent;

// Delta types
export type TextDelta = { type: 'text_delta'; text: string };
export type ThinkingDelta = { type: 'thinking_delta'; thinking: string; signature: string };
export type InputJSONDelta = { type: 'input_json_delta'; partial_json: string };
export type SignatureDelta = { type: 'signature_delta'; signature: string };

// Tool types
export type ToolUnion = Tool;
export type ToolChoice = 'auto' | 'any' | 'tool';

// StopReason
export type StopReason = BetaStopReason;

// Metadata
export type Metadata = {
  user_id?: string;
  [key: string]: unknown;
};

// Model
export type Model = {
  id: string;
  display_name: string;
  created_at: string;
};

// MessageTokensCount
export type MessageTokensCount = {
  input_tokens: number;
};

// OutputConfig
export type OutputConfig = BetaOutputConfig;

// WebSearch types (simplified)
export type WebSearchResultBlock = { type: 'web_search_result'; url: string; title: string };
export type WebSearchResultBlockParam = WebSearchResultBlock;

// Stream type alias for streaming.mjs import
export type { Stream } from './index.js';
```

- [ ] **Step 2: 在 anthropric-types.ts 中补充 BetaMessage 等类型**

确保 `sdk-recovery/src/utils/anthropic-types.ts` 已包含 BetaMessage, BetaUsage, BetaRawMessageStreamEvent, BetaContentBlock。读取现有文件确认。

- [ ] **Step 3: 验证 sdk-recovery 类型编译**

```bash
cd sdk-recovery && bun run typecheck
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add sdk-recovery/src/resources/index.ts sdk-recovery/src/utils/anthropic-types.ts
git commit -m "feat(sdk-decoupling): add missing SDK types to sdk-recovery resources"
```

---

### Task 2: 完善 sdk-recovery 兼容层 (compat.ts)

**Files:**
- Modify: `sdk-recovery/src/compat.ts`
- Modify: `sdk-recovery/src/utils/error.ts`

当前 compat.ts 已实现了 `Anthropic` 类和错误类型。需要补充：

- [ ] **Step 1: 补充 Stream 导出**

在 `sdk-recovery/src/compat.ts` 中添加 Stream 类型导出：

```typescript
// Add Stream type export (for @anthropic-ai/sdk/streaming.mjs)
export type { Stream } from './resources/index.js';
```

- [ ] **Step 2: 补充 error 导出路径**

`@anthropic-ai/sdk/error` import 需要工作。在 `sdk-recovery/src/` 创建 `error.ts`：

```typescript
// sdk-recovery/src/error.ts
/**
 * Error types — re-export for @anthropic-ai/sdk/error compatibility.
 */
export {
  APIError,
  APIUserAbortError,
  APIRateLimitError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  createAPIError,
  isRetryableError,
} from './utils/error.js';

export type { APIErrorType } from './utils/error.js';
```

- [ ] **Step 3: 验证 compat 导出**

确保以下导出路径都能解析：
- `@anthropic-ai/sdk` → Anthropic, APIError, APIUserAbortError, etc.
- `@anthropic-ai/sdk/error` → APIError, etc.
- `@anthropic-ai/sdk/streaming.mjs` → Stream
- `@anthropic-ai/sdk/resources/index.mjs` → all resource types
- `@anthropic-ai/sdk/resources/beta/messages/messages.mjs` → Beta types
- `@anthropic-ai/sdk/resources/messages.mjs` → message types
- `@anthropic-ai/sdk/client` → Anthropic, ClientOptions

- [ ] **Step 4: Commit**

```bash
git add sdk-recovery/src/compat.ts sdk-recovery/src/error.ts
git commit -m "feat(sdk-decoupling):完善 compat 层 Stream/error 导出"
```

---

### Task 3: 配置 tsconfig paths 透明重定向

**Files:**
- Modify: `tsconfig.json` (root)

- [ ] **Step 1: 在根 tsconfig.json 添加 paths 映射**

读取现有 `tsconfig.json`，在 `compilerOptions` 中添加：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@anthropic-ai/sdk": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/*": ["./sdk-recovery/src/resources/*"],
      "@anthropic-ai/sdk/error": ["./sdk-recovery/src/error.js"],
      "@anthropic-ai/sdk/streaming": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/streaming.mjs": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/client": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/client.js": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/client.mjs": ["./sdk-recovery/src/compat.js"],
      "@anthropic-ai/sdk/resources": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/index.mjs": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/index.js": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/*": ["./sdk-recovery/src/resources/*"],
      "@anthropic-ai/sdk/resources/beta/messages/messages.mjs": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/beta/messages/messages.js": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/beta/messages.js": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/messages.mjs": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/sdk/resources/messages.js": ["./sdk-recovery/src/resources/index.js"],
      "@anthropic-ai/claude-agent-sdk": ["./sdk-recovery/src/index.js"],
      "@anthropic-ai/mcpb": ["./sdk-recovery/src/mcpb.js"],
      "@anthropic-ai/sandbox-runtime": ["./sdk-recovery/src/sandbox-runtime.js"]
    }
  }
}
```

**注意**：`.mjs` 和 `.js` 后缀都需要映射，因为源码中两种写法都有。

- [ ] **Step 2: 验证 TypeScript 解析**

```bash
npx tsc --noEmit --pretty 2>&1 | head -50
```

Expected: 之前关于 `@anthropic-ai/sdk` 的类型错误消失，出现新的关于 sdk-recovery 内部类型的错误（如果有）。

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "feat(sdk-decoupling): add tsconfig paths to redirect @anthropic-ai/* imports to sdk-recovery"
```

---

### Task 4: 自研 claude-agent-sdk 类型（删除 shim re-export）

**Files:**
- Modify: `sdk-recovery/src/claude-agent-sdk.ts`

- [ ] **Step 1: 替换 claude-agent-sdk.ts**

将现有的 shim re-export 替换为自研类型定义：

```typescript
// sdk-recovery/src/claude-agent-sdk.ts
/**
 * Self-developed claude-agent-sdk types.
 * Replaces @anthropic-ai/claude-agent-sdk shim.
 */

/**
 * Permission mode for controlling how tool executions are handled.
 * - 'default' — Standard behavior, prompts for dangerous operations
 * - 'acceptEdits' — Auto-accept file edit operations
 * - 'bypassPermissions' — Bypass all permission checks
 * - 'plan' — Planning mode, no actual tool execution
 * - 'dontAsk' — Don't prompt for permissions, deny if not pre-approved
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
```

**注意**：`PermissionMode` 在主项目中已经由 `src/types/permissions.ts` 和 `src/utils/permissions/PermissionMode.ts` 定义（包含 `'auto'` 和 `'bubble'` 内部模式）。sdk-recovery 导出的是外部可见的子集，与 shim 中的定义一致。

- [ ] **Step 2: Commit**

```bash
git add sdk-recovery/src/claude-agent-sdk.ts
git commit -m "feat(sdk-decoupling): self-develop PermissionMode type, remove claude-agent-sdk shim re-export"
```

---

### Task 5: 自研 mcpb 类型（删除 shim re-export）

**Files:**
- Modify: `sdk-recovery/src/mcpb.ts`

- [ ] **Step 1: 替换 mcpb.ts**

将现有的 shim re-export 替换为自研类型定义：

```typescript
// sdk-recovery/src/mcpb.ts
/**
 * Self-developed MCPB types.
 * Replaces @anthropic-ai/mcpb shim.
 */

/**
 * MCPB manifest type (simplified — covers the fields used in the codebase).
 * Based on @anthropic-ai/mcpb McpbManifestAny.
 */
export interface McpbManifest {
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  repository?: string;
  homepage?: string;
  icon?: string;
  category?: string;
  mcpServers?: Record<string, McpbServerConfig>;
  userConfiguration?: McpbUserConfigurationOption[];
  [key: string]: unknown;
}

export interface McpbServerConfig {
  type?: 'stdio' | 'http' | 'sse' | 'ws';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * User configuration option for MCPB bundles.
 */
export interface McpbUserConfigurationOption {
  name?: string;
  title: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path' | 'secret' | 'file' | 'directory';
  required?: boolean;
  default?: string | number | boolean | string[];
  options?: string[];
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
}
```

- [ ] **Step 2: 验证 mcpb 类型覆盖**

检查 `src/utils/plugins/mcpbHandler.ts` 和 `src/utils/dxt/helpers.ts` 的 import，确保 McpbManifest 类型覆盖所有使用的字段。

- [ ] **Step 3: Commit**

```bash
git add sdk-recovery/src/mcpb.ts
git commit -m "feat(sdk-decoupling): self-develop McpbManifest types, remove mcpb shim re-export"
```

---

### Task 6: 自研 sandbox-runtime 类型（删除 shim re-export）

**Files:**
- Modify: `sdk-recovery/src/sandbox-runtime.ts`

- [ ] **Step 1: 替换 sandbox-runtime.ts**

将现有的 shim re-export 替换为自研类型定义：

```typescript
// sdk-recovery/src/sandbox-runtime.ts
/**
 * Self-developed sandbox-runtime types.
 * Replaces @anthropic-ai/sandbox-runtime shim.
 */

import { z } from 'zod';

/**
 * Sandbox runtime configuration.
 */
export interface SandboxRuntimeConfig {
  enabled?: boolean;
  network?: NetworkConfig;
  filesystem?: FilesystemConfig;
  ignoreViolations?: IgnoreViolationsConfig;
  [key: string]: unknown;
}

export interface NetworkConfig {
  enabled?: boolean;
  allowedHosts?: NetworkHostPattern[];
  blockedHosts?: NetworkHostPattern[];
  [key: string]: unknown;
}

export interface FilesystemConfig {
  readRestrictions?: FsReadRestrictionConfig[];
  writeRestrictions?: FsWriteRestrictionConfig[];
  [key: string]: unknown;
}

export interface IgnoreViolationsConfig {
  filesystem?: boolean;
  network?: boolean;
  [key: string]: unknown;
}

export type NetworkHostPattern = string | RegExp;

export interface FsReadRestrictionConfig {
  path?: string;
  pattern?: string;
  action?: 'block' | 'warn';
  [key: string]: unknown;
}

export interface FsWriteRestrictionConfig {
  path?: string;
  pattern?: string;
  action?: 'block' | 'warn';
  [key: string]: unknown;
}

export interface SandboxViolationEvent {
  type: 'filesystem' | 'network';
  action: 'read' | 'write' | 'connect';
  path?: string;
  host?: string;
  timestamp: string;
  [key: string]: unknown;
}

export type SandboxAskCallback = (event: SandboxViolationEvent) => Promise<'allow' | 'deny' | 'allowAlways'>;

export type SandboxDependencyCheck = {
  name: string;
  available: boolean;
  [key: string]: unknown;
};

/**
 * Zod schema for SandboxRuntimeConfig validation.
 */
export const SandboxRuntimeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.object({
    enabled: z.boolean().optional(),
    allowedHosts: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
    blockedHosts: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
  }).optional(),
  filesystem: z.object({
    readRestrictions: z.array(z.object({
      path: z.string().optional(),
      pattern: z.string().optional(),
      action: z.enum(['block', 'warn']).optional(),
    }).passthrough()).optional(),
    writeRestrictions: z.array(z.object({
      path: z.string().optional(),
      pattern: z.string().optional(),
      action: z.enum(['block', 'warn']).optional(),
    }).passthrough()).optional(),
  }).optional(),
  ignoreViolations: z.object({
    filesystem: z.boolean().optional(),
    network: z.boolean().optional(),
  }).optional(),
}).passthrough();

/**
 * SandboxManager — interface for managing sandboxed processes.
 * This is a type-only stub. The actual implementation uses OS-level sandboxing.
 */
export interface SandboxManager {
  run<T>(fn: () => Promise<T>, config?: Partial<SandboxRuntimeConfig>): Promise<T>;
  getConfig(): SandboxRuntimeConfig;
  updateConfig(config: Partial<SandboxRuntimeConfig>): void;
}

/**
 * SandboxViolationStore — interface for storing and querying violation events.
 */
export interface SandboxViolationStore {
  recordViolation(event: SandboxViolationEvent): Promise<void>;
  getViolations(filter?: { type?: string }): Promise<SandboxViolationEvent[]>;
  clear(): Promise<void>;
}
```

- [ ] **Step 2: 验证 sandbox 类型覆盖**

检查 `src/utils/sandbox/sandbox-adapter.ts` 的 import，确保所有类型都被覆盖。

- [ ] **Step 3: Commit**

```bash
git add sdk-recovery/src/sandbox-runtime.ts
git commit -m "feat(sdk-decoupling): self-develop sandbox-runtime types, remove sandbox-runtime shim re-export"
```

---

### Task 7: 更新 package.json 删除 shim 依赖

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: 从 package.json 中删除 shim 依赖**

删除以下行：

```diff
-    "@anthropic-ai/claude-agent-sdk": "file:./shims/claude-agent-sdk",
-    "@anthropic-ai/mcpb": "file:./shims/mcpb",
-    "@anthropic-ai/sandbox-runtime": "file:./shims/sandbox-runtime",
-    "@anthropic-ai/sdk": "file:./shims/sdk",
```

**不需要添加 sdk-recovery 为依赖**，因为 tsconfig paths 已经处理了模块解析，且 sdk-recovery 的源码会被构建工具直接打包。

- [ ] **Step 2: 重新安装依赖**

```bash
bun install
```

Expected: 不再安装 shims 目录中的包。

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(sdk-decoupling): remove shim dependencies from package.json"
```

---

### Task 8: 删除 shims 目录

**Files:**
- Delete: `shims/sdk/`
- Delete: `shims/claude-agent-sdk/`
- Delete: `shims/mcpb/`
- Delete: `shims/sandbox-runtime/`

**注意**：保留以下 native module shims（它们不是 @anthropic-ai SDK）：
- `shims/ant-computer-use-input`
- `shims/ant-computer-use-mcp`
- `shims/ant-computer-use-swift`
- `shims/color-diff-napi`
- `shims/modifiers-napi`
- `shims/url-handler-napi`
- `shims/ant-claude-for-chrome-mcp`

- [ ] **Step 1: 删除 4 个 SDK shim 目录**

```bash
rm -rf shims/sdk shims/claude-agent-sdk shims/mcpb shims/sandbox-runtime
```

- [ ] **Step 2: 验证构建**

```bash
bun run build:dev 2>&1 | tail -30
```

Expected: 构建成功，无模块解析错误。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(sdk-decoupling): delete @anthropic-ai SDK shim directories"
```

---

### Task 9: 端到端验证

- [ ] **Step 1: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -100
```

Expected: 无 `@anthropic-ai/sdk` 相关错误。如有 sdk-recovery 内部类型问题，记录下来并后续修复。

- [ ] **Step 2: 开发构建**

```bash
bun run build:dev
```

Expected: 构建成功。

- [ ] **Step 3: 生产构建**

```bash
bun run build
```

Expected: 构建成功。

- [ ] **Step 4: 运行 smoke test**

```bash
./cli-dev --version
```

Expected: 输出版本号 `0.4.9`。

- [ ] **Step 5: 最终 commit**

```bash
git add .
git commit -m "chore(sdk-decoupling): full SDK decoupling complete — all external SDK dependencies removed"
```

---

## Phase 交付物

| 交付物 | 状态 |
|--------|------|
| sdk-recovery 类型系统完善 | Task 1 |
| sdk-recovery 兼容层完善 | Task 2 |
| tsconfig paths 透明重定向 | Task 3 |
| PermissionMode 自研类型 | Task 4 |
| McpbManifest 自研类型 | Task 5 |
| Sandbox-runtime 自研类型 | Task 6 |
| 删除 shim 依赖 | Task 7 |
| 删除 shim 目录 | Task 8 |
| 端到端验证通过 | Task 9 |
