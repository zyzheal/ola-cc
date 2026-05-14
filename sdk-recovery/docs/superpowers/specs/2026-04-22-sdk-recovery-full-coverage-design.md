# SDK-Recovery 完全覆盖架构设计

**日期**: 2026-04-22
**状态**: 待审阅
**目标**: 以 v2 直连为主构建完整的自研 Agent SDK，替代 @anthropic-ai/sdk

---

## 1. 架构总览

### 1.1 设计原则

- 以 v2 LocalRuntime 为主路径，CLIRuntime (v1) 仅作为过渡兼容层
- Core 层提供最小共享基础组件，Runtime 层保持独立
- 渐进式替代：每增强一个 v2 能力，就减少一分对 CLI 的依赖
- 最终形态：纯自研、无需 CLI 依赖的 Agent SDK

### 1.2 分层架构

```
SDK API 层（对外统一接口）
├── query(params)        → Query          (v1: CLI 子进程模式)
├── createSession(opts)  → SDKSession     (v2: 直连模式)
├── tool(name, schema, handler)           → MCP 工具定义器
└── startup(opts)        → WarmQuery      (预热初始化)

┌─────────────────────────────────────────────────────┐
│                  Core（共享基础组件）                  │
│                                                     │
│  Types              类型契约（拆分为 4 文件）          │
│  ToolRegistry       工具注册 + AJV 校验               │
│  MCP                Model Context Protocol 支持       │
│  MultiProvider      Anthropic / OpenAI / Proxy       │
│  Hooks              27 种事件 Hook 链                 │
│  EventBus           Hook 事件分发机制                  │
│  MessageNormalizer  消息序列校正（解决 C1/C3 bug）     │
│                                                     │
├─────────────────────────────────────────────────────┤
│              Runtime（可插拔，独立演进）               │
│                                                     │
│  LocalRuntime (v2)          CLIRuntime (v1)         │
│  ┌────────────────────┐     ┌──────────────────┐    │
│  │ AgentLoop           │     │ ProcessTransport │    │
│  │ ├─ ToolExecutor     │     │ ├─ NDJSON parser  │    │
│  │ ├─ StreamingCtrl    │     │ ├─ Hook chain     │    │
│  │ └─ ErrorRecovery    │     │ └─ Heartbeat      │    │
│  │ SessionManager      │     └──────────────────┘    │
│  │ ContextManager      │                             │
│  │ PromptEngine        │                             │
│  │ Permissions         │                             │
│  │ Security            │                             │
│  │ ConfigLoader        │                             │
│  └────────────────────┘                              │
└─────────────────────────────────────────────────────┘

Phase 3+（Core 层扩展）:
├── Sandbox     (文件/网络隔离)
├── Subagent    (子代理编排)
├── Memory      (跨会话记忆 + CLAUDE.md)
└── Plugin      (插件生命周期)
```

### 1.3 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| API 入口 | query() 和 createSession() 分离 | v1/v2 语义不同，不伪装统一 |
| Security 归属 | LocalRuntime 而非 Core | v1 CLI 自带安全，Core 层 Security 主要服务 v2 |
| PromptEngine 归属 | LocalRuntime 而非 Core | 仅 v2 使用，v1 prompt 由 CLI 构建 |
| Permissions 归属 | LocalRuntime 而非 Core | v1 权限在 CLI 内部，v2 才需要独立实现 |
| MessageNormalizer 归属 | Core | 不依赖运行时，v1 也需要消息校正（I2 问题） |

---

## 2. 组件详细设计

### 2.1 Core 层组件

#### Types（类型契约）

**现状**: `types.ts` 794 行单文件，包含所有类型定义。

**拆分方案**:

| 文件 | 职责 | 行数估算 |
|------|------|---------|
| `types/sdk-messages.ts` | SDK 消息类型、Query/Session 接口 | ~350 |
| `types/hooks.ts` | Hook 事件类型、输入/输出结构 | ~120 |
| `types/config.ts` | Options/Settings/Provider 配置类型 | ~200 |
| `types/index.ts` | 统一导出 | ~30 |

**拆分原则**: 按使用场景拆分，不改变任何类型定义内容。

#### ToolRegistry（工具注册）

- 工具注册、AJV schema 校验、黑白名单过滤
- 现有实现 95 行，基本完整
- 需补充：动态工具注入、tool result 标准化

#### MCP（MCP 协议支持）

- `createSdkMcpServer()` + `tool()` 定义器
- 现有实现 56 行，基本完整
- 依赖：`@modelcontextprotocol/sdk`、`zod/v4`

#### MultiProvider（多 Provider 适配）

- Anthropic / OpenAI-compatible / Anthropic-Proxy 三种 Provider
- `protocol.ts` 381 行，包含 Provider 接口 + AnthropicProvider + OpenAIProvider
- 自动检测 Provider（基于 baseURL），支持显式指定

#### Hooks（Hook 事件链）

- 27 种 Hook 事件类型定义（types 中已有）
- transport 端 hook_trigger 处理已有实现
- 需补充：Core 层 EventBus 事件分发机制

#### MessageNormalizer（消息序列校正）

**新增组件**，专门解决以下阻断性 bug：

- **C1**: 确保 assistant tool_use 消息在 tool_result 之前添加到上下文
- **C3**: 确保 compact 后不破坏 tool_use/tool_result 配对
- **I2**: 修复 denial 消息格式（tool_use 和 tool_result 分离到不同消息）

**接口**:

```typescript
interface MessageNormalizer {
  /** 确保消息序列符合 Anthropic API 规范 */
  normalizeSequence(messages: MessageParam[]): MessageParam[];

  /** 安全压缩，保留 tool_use/tool_result 配对 */
  safeCompact(messages: MessageParam[], keepFirst: number, keepLast: number): MessageParam[];

  /** 修复 denial 消息格式 */
  createDenialMessage(toolUse: ToolUseBlock, reason: string): MessageParam;
}
```

### 2.2 LocalRuntime (v2) 组件

#### AgentLoop（对话循环）

- 核心引擎：tool_use → tool_result → next turn 循环
- 内部子模块：
  - **ToolExecutor**: 工具执行，从 ToolRegistry 获取并执行
  - **StreamingCtrl**: Token-by-token 流式输出控制
  - **ErrorRecovery**: API 失败后的降级策略（当前只有重试）

**当前问题**（v2-api.ts 419 行）:
- C1: 缺少 assistant tool_use 消息持久化（阻断性）
- 缺少流式输出接入
- 成本计算硬编码

#### SessionManager（会话管理）

- 创建/恢复/关闭/持久化 session
- 依赖 SessionStore 进行文件持久化
- 需修复：并发写安全（I6）

#### ContextManager（上下文管理）

- 消息历史管理、token 估算、上下文压缩
- 需修复：ensureToolResultPairs 空操作（C3）
- 需增强：智能压缩策略（摘要生成、tool chain 合并）

#### PromptEngine（系统提示构建）

- 12 段系统提示结构
- 现有实现 299 行，基本完整
- 需补充：CLAUDE.md/内存加载指令、dynamic sections

#### Permissions（权限决策）

- 权限模式管理（default/acceptEdits/bypassPermissions/plan/dontAsk/auto）
- 规则管理（addRules/replaceRules/removeRules）
- v2 专属：v1 的权限在 CLI 内部

#### Security（安全检查）

- 命令黑名单（25+ 模式）、路径限制
- v2 专属：为 v2 的工具执行提供安全检查
- 需增强：白名单机制、跨平台沙箱

#### ConfigLoader（配置加载）

**新增组件**：
- 加载 `.claude/settings.json`、环境变量、CLAUDE.md
- 合并为统一配置对象
- 当前 `env-builder.ts` 只处理序列化到环境变量，不处理加载

### 2.3 CLIRuntime (v1) 组件

#### ProcessTransport（子进程管理）

- 启动 CLI 子进程、stdin/stdout 通信、心跳保活
- 现有实现 647 行，基本完整（85%）
- 需修复：I1 竞态条件、I2 denial 消息格式

#### NDJSON（协议解析）

- NDJSON 流解析器，处理 chunked 输出
- 现有实现 49 行，完整

#### Heartbeat（心跳保活）

- 检测 CLI 子进程是否挂起
- 集成在 ProcessTransport 中，60s 超时
- 需改进：可配置超时

---

## 3. 已知 Bug 修复方案

| Bug | 严重度 | 位置 | 修复方案 | 负责组件 |
|-----|--------|------|---------|---------|
| **C1** | Critical | v2-api.ts:281-299 | AgentLoop 在执行工具后，先将 assistant tool_use 消息添加到上下文，再添加 tool_result | AgentLoop + MessageNormalizer |
| **C3** | Critical | context-manager.ts:146-162 | 重写 ensureToolResultPairs，扫描 orphan tool_result，补充对应的 tool_use 消息 | ContextManager + MessageNormalizer |
| **I1** | Important | processTransport.ts:161-185 | stdin.write 前检查进程状态，write 后添加回调处理失败 | ProcessTransport |
| **I2** | Important | processTransport.ts:472-498 | denial 消息分离：tool_use 在 assistant 消息，tool_result 在 user 消息 | MessageNormalizer |
| **I3** | Important | v2-api.ts:239-241 | 从 Provider 配置中获取价格表，而非硬编码 | AgentLoop |
| **I6** | Important | session/store.ts:113-125 | 使用原子操作或锁保护并发写入 | SessionManager |

---

## 4. 模块拆分与成本

### 4.1 分层成本估算

| 层级 | 当前行数 | 目标行数 | 开发天数 |
|------|---------|---------|---------|
| Core 层（现有需完善） | ~1600 | ~2000 | 5 天 |
| LocalRuntime 增强 | ~1700 | ~3500 | 16 天 |
| LocalRuntime 新增 | 0 | ~3000 | 20 天 |
| CLIRuntime 修复 | ~700 | ~700 | 3 天 |
| **合计** | ~4000 | ~9200 | **~44 天** |

### 4.2 实施阶段

成本层级与阶段的映射关系：

| 阶段 | 包含的成本项 | 天数 | 里程碑 |
|------|-------------|------|--------|
| **Phase 1** | CLIRuntime 修复(I1/I2) + Core 层(MessageNormalizer) + 项目基础设施 | 7 天 | v2 可运行基础对话（C1/C3 修复） |
| **Phase 2** | Core 层(Types 拆分) + LocalRuntime 增强(AgentLoop 流式/成本/Session并发安全) + 组件拆分(v2-api.ts → AgentLoop/SessionManager) | 10 天 | v2 支持流式输出 |
| **Phase 3** | LocalRuntime 新增(Subagent + Memory + Sandbox) | 15 天 | 完整 Agent 能力 |
| **Phase 4** | LocalRuntime 新增(Plugin + Skill) + LocalRuntime 优化(ConfigLoader + 测试 + 文档) | 12 天 | 生产就绪（npm 发布 + 测试覆盖 >80% + Phase 1-3 全部功能通过验收） |

---

## 5. 依赖与约束

### 5.1 外部依赖

- `@modelcontextprotocol/sdk` — MCP 协议
- `zod/v4` — Schema 校验
- `ajv` — JSON Schema 校验（ToolRegistry）

### 5.2 构建约束

- 需要 package.json、tsconfig.json、构建脚本
- 输出格式：ESM + CJS 双格式
- Node.js 兼容：>= 18.0.0

### 5.3 兼容目标

- API 签名与 @anthropic-ai/sdk 完全一致（选项 C）
- 额外能力：多 Provider、自研 Sandbox、Subagent 编排

### 5.4 SDK 入口文件结构

```typescript
// src/index.ts — 统一导出
export { query } from './query';
export { unstable_v2_createSession, unstable_v2_resumeSession, unstable_v2_prompt } from './v2-api';
export { tool, createSdkMcpServer } from './mcp-tools';
export { startup } from './utils/session-store';
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './types';
export { AbortError, InMemorySessionStore } from './types';

// Re-export all types from types/
export * from './types';
```

**包导出配置**（package.json）:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```
