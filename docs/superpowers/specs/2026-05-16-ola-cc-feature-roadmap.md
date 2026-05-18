# ola-cc 功能增强路线图设计

## 概述

本文档描述了 ola-cc（Claude Code 分支）相对于上游 Claude Code (2.1.89-2.1.143) 缺失/不完整功能的增强设计方案。

## 背景

通过对上游 CHANGELOG 的深度分析和本地代码审查，识别出以下需要实现的功能：

- 完全缺失：Daemon/Worker 系统、Agent View、Reactive Compact 等
- 部分实现：工具选择性能、启动性能、插件系统增强
- 优化空间：压缩系统、工具执行、权限检查

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      ola-cc CLI                             │
├─────────────────────────────────────────────────────────────┤
│  Entry (cli.tsx)  │  Main Loop  │  Tools  │  Commands      │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌──────────────┐
│  Compact      │   │  Tool System    │   │  Plugin      │
│  System       │   │  (优化空间大)    │   │  System      │
└───────────────┘   └─────────────────┘   └──────────────┘
        │                     │                     │
   Reactive/Cached       两阶段精排           skillOverrides
   Microcompact          Hook并行化            Token Cost
```

## 子项目依赖关系

```
P1 快速见效 ──┬──► P2 压缩系统 ──► P4 启动优化
              │         │
              │         └──────► P3 工具性能
              │                    │
              └────────────────────┼──► P5 插件增强
                                   │
                                   ▼
                              P6 Daemon/Worker (基础)
                                   │
                                   ▼
                              P7 Agent View
```

## 阶段详细设计

### Phase 1: 快速见效 (1-2周)

#### P1.1 工具查找 Map 化

**当前问题**: `findToolByName` O(n) 线性搜索

**解决方案**:
```typescript
class ToolRegistry {
  private toolMap: Map<string, Tool>

  constructor(tools: Tools) {
    this.toolMap = new Map()
    for (const tool of tools) {
      this.toolMap.set(tool.name, tool)
      tool.aliases?.forEach(alias => this.toolMap.set(alias, tool))
    }
  }

  find(name: string): Tool | undefined {
    return this.toolMap.get(name)
  }
}
```

**文件**: `src/Tool.ts`, `src/services/tools/toolExecution.ts`

#### P1.2 权限规则索引

**当前问题**: 每次工具调用都遍历所有权限规则

**解决方案**:
```typescript
class PermissionIndex {
  private byToolName: Map<string, PermissionRule[]>
  private byPath: Map<string, PermissionRule[]>

  buildIndex(rules: PermissionRule[]) {
    this.byToolName = groupBy(rules, 'tool')
    this.byPath = groupBy(rules, 'pathPattern')
  }
}
```

**文件**: `src/utils/permissions/permissionSetup.ts`

#### P1.3 Compact Prompt 补充

**当前问题**: 缺少"保护敏感用户指令"提示词

**解决方案**: 在 `services/compact/prompt.ts` 中添加敏感指令保护提示

**文件**: `src/services/compact/prompt.ts`

---

### Phase 2: 压缩系统 + 工具性能 (2-3周)

#### P2.1 Reactive Compact

**功能**: 当 API 返回 413 (prompt too long) 时，自动触发响应式压缩，从原始溢出大小开始逐步剥离最旧消息

**接口**:
```typescript
export interface ReactiveCompactConfig {
  maxRetries: number           // 默认 3
  initialOverflowMultiplier: number  // 1.2 从 120% 开始
  minMessagesToKeep: number    // 最少保留最近 N 条
}

export async function tryReactiveCompact(
  messages: Message[],
  overflowSize: number
): Promise<CompactResult>

export async function runReactiveCompactOnPTL(
  messages: Message[],
  error: PromptTooLongError
): Promise<ReconstructedMessages>
```

**文件**: `src/services/compact/reactiveCompact.ts`

#### P2.2 Cached Microcompact

**功能**: 使用 API cache_editing 功能清理 tool results，不影响缓存前缀

**接口**:
```typescript
export interface CachedMCState {
  cacheId: string
  toolResults: Map<string, ToolResultEntry>
}

export function isCachedMicrocompactEnabled(): boolean
export function isModelSupportedForCacheEditing(): boolean
export function createCacheEditsBlock(state: CachedMCState): CacheEditsBlock
```

**文件**: `src/services/compact/cachedMicrocompact.ts`

#### P2.3 两阶段工具精排

**功能**: 先用 name+hint 粗筛，再对 top-K 调用完整 prompt()

**接口**:
```typescript
export interface ToolRankerConfig {
  phase1MaxCandidates: number  // 默认 30
  phase2FinalCount: number     // 默认 25
  alwaysIncludeTools: string[] // 核心工具
}

export async function rankToolsTwoPhase(
  tools: Tools,
  query: string,
  config: ToolRankerConfig
): Promise<Tools>
```

**文件**: `src/services/api/toolRanker.ts`

#### P2.4 Hook 并行化

**功能**: 无依赖的 Pre/Post Hook 并行执行

**接口**:
```typescript
interface HookDependency {
  after?: string[]
  before?: string[]
}

async function runPreToolUseHooksParallel(hooks: Hook[], toolUse: ToolUseContext) {
  const independent = hooks.filter(h => !h.dependencies)
  await Promise.all(independent.map(h => runHook(h, toolUse)))
}
```

**文件**: `src/services/tools/toolHooks.ts`

---

### Phase 3: 启动优化 + 插件增强 (1-2周)

#### P3.1 启动 Lazy Import

**功能**: MCP/Telemetry/迁移等模块改为动态导入

**需要改造的文件**:
- `src/main.tsx` - 180+ 静态 import
- `src/tools.ts` - 60+ 工具全量加载
- `src/commands.ts` - 60+ 命令全量加载

#### P3.2 skillOverrides 配置

**功能**: 支持技能覆盖配置 (off/user-invocable-only/name-only)

**接口**:
```typescript
interface SkillOverridesConfig {
  mode: 'off' | 'user-invocable-only' | 'name-only'
  hiddenSkills?: string[]
}
```

**文件**: `src/utils/config.ts`, `src/skills/`

#### P3.3 Plugin Token Cost

**功能**: 插件级 per-turn token 成本估算

**接口**:
```typescript
interface PluginCostEstimate {
  pluginId: string
  perTurnTokens: number
  perInvocationTokens: number
}
```

**文件**: `src/utils/analyzeContext.ts`

---

### Phase 4: Daemon/Worker 系统 (3-4周)

#### 核心组件

| 组件 | 功能 | 文件 |
|------|------|------|
| Daemon 主进程 | 常驻后台，管理会话生命周期 | `src/daemon/main.ts` |
| Worker 进程 | 执行实际任务 | `src/daemon/worker.ts` |
| Warm-spare 池 | 预热备用 worker | `src/daemon/warmSpare.ts` |
| 会话管理 | 后台会话状态存储 | `src/daemon/sessionManager.ts` |
| BG CLI 命令 | ps/logs/attach/kill | `src/cli/bg.ts` |

#### 接口设计

```typescript
interface DaemonConfig {
  port: number
  maxWorkers: number
  warmSpareCount: number
  idleTimeoutMs: number
  socketPath: string
}

class Daemon {
  async start(config: DaemonConfig): Promise<void>
  async stop(): Promise<void>
  async dispatchWork(input: WorkItem): Promise<WorkResult>
}

class Worker {
  async initialize(): Promise<void>
  async execute(input: WorkItem): Promise<WorkResult>
  async retire(): Promise<void>
}
```

#### CLI 接口

```bash
claude --bg "帮我重构代码"  # 后台执行
claude ps                    # 列出后台会话
claude logs <id>             # 查看日志
claude attach <id>           # 附加会话
claude kill <id>             # 终止会话
```

---

### Phase 5: Agent View (2周)

#### 组件结构

```
AgentViewScreen
  ├── AgentList (会话列表)
  │     ├── WorkingSection
  │     ├── BlockedSection
  │     └── CompletedSection
  ├── AgentDetail (详情面板)
  ├── DispatchForm (新建会话)
  └── Settings (配置)
```

#### 接口

```typescript
interface AgentSession {
  id: string
  title: string
  status: 'working' | 'blocked' | 'completed' | 'failed'
  model: string
  startedAt: Date
  lastActivity: Date
  isBackground: boolean
}

interface AgentViewConfig {
  defaultModel?: string
  defaultEffort?: 'low' | 'medium' | 'high'
  sessionRetentionDays: number
}
```

---

## 开发规范

1. **TypeScript 严格模式** - 启用 `strict: true`
2. **测试覆盖** - 核心逻辑单元测试 > 80%
3. **Feature Flag** - 所有 P6/P7 功能通过 gate 控制
4. **日志规范** - 使用现有 `logForDebugging` 模式
5. **错误处理** - 所有 async 函数必须 try-catch

## 交付检查清单

| 阶段 | 检查项 |
|------|--------|
| P1 | 工具查找 < 1ms, 权限检查 < 5ms, Compact prompt 完整 |
| P2 | 413 自动触发, 连续失败熔断, Cache editing 正常 |
| P3 | 工具选择 < 50ms, Hook 不阻塞工具 |
| P4 | 启动时间减少 > 30%, 后台命令正常 |
| P5 | skillOverrides 生效, Token cost 显示 |
| P6 | --bg/ps/logs/attach/kill 正常, warm-spare 预热 |
| P7 | agents 显示所有会话, 可附加后台会话 |

## 时间线

| 阶段 | 周期 | 人力 |
|------|------|------|
| Phase 1 | 1-2 周 | 1 人 |
| Phase 2 | 2-3 周 | 2 人并行 |
| Phase 3 | 1-2 周 | 2 人并行 |
| Phase 4 | 3-4 周 | 2-3 人 |
| Phase 5 | 2 周 | 1-2 人 |

**总计: 约 10-14 周**

## 实施状态

| 阶段 | 状态 | 完成时间 |
|------|------|----------|
| Phase 1: 快速见效 | ✅ 完成 | 2026-05-16 |
| Phase 2: 压缩系统 | ✅ 完成 | 2026-05-16 |
| Phase 3: 插件增强 | ✅ 完成 (P3.1 懒加载, P3.2 Skill Overrides) | 2026-05-17 |
| Phase 4: Daemon/Worker | ✅ 完成 | 2026-05-17 |
| Phase 5: Agent View | ✅ 完成 | 2026-05-17 |
| 附加: Warm Spare Pool | ✅ 完成 | 2026-05-17 |

### Phase 3 详细实现 (启动优化 + 插件增强)
- [x] P3.1 启动懒加载 - 转换 telemetry/context metrics/tips 为动态导入
- [x] P3.2 Skill Overrides - settings.json 中 per-skill 禁用/描述覆盖/模型覆盖

### Phase 4 详细实现
- [x] 文件注册表 (`src/daemon/sessionRegistry.ts`)
- [x] BG CLI 命令 (`src/cli/bg.ts`) - ps/logs/attach/kill/--bg
- [x] Worker 进程 (`src/daemon/bgWorker.ts`)
- [x] Daemon 主进程 (`src/daemon/main.ts`)
- [x] Socket 服务器 (`src/daemon/socketServer.ts`)
- [x] IPC 协议 (`src/daemon/protocol.ts`)
- [x] 客户端通信 (`src/services/daemon/client.ts`)
- [x] 功能标志集成 (`scripts/build.ts`)
- [x] CLI 入口集成 (`src/entrypoints/cli.tsx`)

### 附加: Warm Spare Pool
- [x] 预热备用 Worker 池管理 (`src/daemon/warmPool.ts`)
- [x] Warm Worker 进程 (`src/daemon/warmWorker.ts`)
- [x] 协议扩展 - get_warm_pool_status, set_warm_pool_size
- [x] CLI 入口 --warm-worker (`src/entrypoints/cli.tsx`)

### Phase 5 详细实现
- [x] 会话查看 TUI (`src/components/agents/BgSessionView.tsx`)
- [x] /sessions 命令 (`src/commands/sessions/`)
- [x] 命令注册 (`src/commands.ts`)

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Daemon 进程管理 | 高 | 使用 Bun.spawn + IPC |
| Warm-spare 内存泄漏 | 中 | 定期回收 + 监控 |
| 多 Worker 并发冲突 | 高 | 文件系统锁 |
| Agent View 状态同步 | 中 | WebSocket 推送 |