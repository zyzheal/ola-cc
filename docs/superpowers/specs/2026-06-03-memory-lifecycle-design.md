# 记忆生命周期系统设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code
**Priority**: P0/P1
**Effort**: L

---

## 1. 概述

claude-code 的后台记忆管理三件套：ExtractMemories → AutoDream → MagicDocs，构成完整的"会话记忆 → 持久化 → 整合 → 活文档"生命周期。

> **注意**: ola-cc 已集成 ExtractMemories、AutoDream、MagicDocs 三个系统（源码位于 `src/services/extractMemories/`、`src/services/autoDream/`、`src/services/MagicDocs/`）。本文档聚焦于尚未集成的增量功能：openclaude 快照同步（§5）和 oh-my-claudecode 深度合并算法（§6）。

---

## 2. ExtractMemories 自动记忆提取 (P0)

**Source**: `/Users/heal/claude-code/src/services/extractMemories/` (4 files, 613+155 LOC)

### 2.1 核心机制

每轮对话结束时，从当前会话 transcript 中提取持久记忆，写入 `~/.claude/projects/<path>/memory/`。

```
stopHook → executeExtractMemories() → runForkedAgent() → 写入 memory files
```

### 2.2 状态机

```typescript
// 闭包维护的可变状态
lastMemoryMessageUuid    // 游标，标记上次处理到的消息
inProgress               // 防止重叠运行
turnsSinceLastExtraction // 节流计数器
pendingContext           // trailing run 暂存
inFlightExtractions      // 未完成 Promise 集合
```

### 2.3 执行流程

1. 检查前置条件：非子代理、feature flag、auto-memory 启用、非远程模式
2. 如果正在运行，暂存 context 用于 trailing run
3. 计算 `newMessageCount`（自上次游标以来的可见消息数）
4. **互斥检查**：`hasMemoryWritesSince()` — 主代理已写记忆则跳过
5. 扫描已有记忆文件生成 manifest
6. `runForkedAgent()` 执行，`maxTurns: 5`，`skipTranscript: true`
7. 成功后推进游标；失败时游标不动，下次重试

### 2.4 工具权限

```
允许: REPL, Read, Grep, Glob（无限制）
允许: Bash（仅 isReadOnly 命令）
允许: Edit/Write（仅 isAutoMemPath 路径）
拒绝: 其他一切
```

### 2.5 Prompt 设计

四类分类法：
- `user` — 用户角色、偏好、知识
- `feedback` — 行为指导（正面+负面）
- `project` — 项目状态、决策、进度
- `reference` — 外部资源指针

不保存规则：代码模式（可从代码推导）、调试方案（修复已在代码中）、git 历史。

### 2.6 Cache 共享

使用 `createCacheSafeParams` 共享父对话的 prompt cache，工具保留但通过 callback 拒绝，保证 cache key 匹配。

### 2.7 Integration

| File | Operation |
|------|-----------|
| `src/services/extractMemories/` | **New** — 4 files |
| `src/query/stopHooks.ts` | Modify — 添加 `executeExtractMemories()` 调用 |
| `src/utils/backgroundHousekeeping.ts` | Modify — 添加 `initExtractMemories()` |

---

## 3. AutoDream 后台记忆整合 (P1)

**Source**: `/Users/heal/claude-code/src/services/autoDream/` (4 files, 327+66 LOC)

### 3.1 核心机制

当时间门控（24h）和会话门控（5 sessions）同时满足时，fork 子 agent 执行 4 阶段记忆整合。

### 3.2 四重门控

按代价从低到高依次检查：

| 门控 | 检查项 | 成本 |
|------|--------|------|
| 总开关 | 非 KAIROS、非远程、auto-memory 启用 | 极低 |
| 时间门控 | lock 文件 mtime 距今 >= 24h | 低（文件 stat） |
| 扫描节流 | 距上次扫描 >= 10min | 低（内存比较） |
| 会话门控 | 自上次整理以来会话数 >= 5 | 中（目录扫描） |
| 锁门控 | 文件锁获取成功 | 低（文件锁） |

### 3.3 整合 Prompt 四阶段

1. **Orient**: `ls` 内存目录，读取 MEMORY.md，浏览已有主题文件
2. **Gather recent signal**: 按优先级搜索（daily logs > 已有记忆 > transcript grep）
3. **Consolidate**: 写入/更新记忆文件，合并重复、转换相对日期、删除矛盾
4. **Prune and index**: 更新 MEMORY.md 索引，保持 < 200 行 / ~25KB

### 3.4 Integration

| File | Operation |
|------|-----------|
| `src/services/autoDream/` | **New** — 4 files |
| `src/query/stopHooks.ts` | Modify — 添加 `executeAutoDream()` 调用 |
| `src/utils/backgroundHousekeeping.ts` | Modify — 添加 `initAutoDream()` |

---

## 4. MagicDocs 自更新文档 (P1)

**Source**: `/Users/heal/claude-code/src/services/MagicDocs/` (2 files, 255 LOC)

### 4.1 核心机制

标记有 `# MAGIC DOC: [title]` 的 markdown 文件被自动跟踪，对话空闲时 fork 子 agent 更新。

### 4.2 双阶段触发

1. **检测阶段**：FileReadTool hook → 正则匹配 `# MAGIC DOC: [title]` → 注册到 `trackedMagicDocs` Map
2. **更新阶段**：post-sampling hook → 对话空闲（最后 turn 无 tool calls）→ 遍历 tracked docs → 逐个更新

### 4.3 单文档更新流程

1. 克隆 FileStateCache 并删除目标文件缓存
2. 读取文件最新内容，不可访问则从 tracking 移除
3. 重新检测 header（文件可能已被编辑移除）
4. 构建更新 prompt
5. `runAgent()` 执行，仅允许 Edit 工具且仅限目标文件路径

### 4.4 安全约束

- 仅允许 Edit 工具修改被跟踪文件
- 使用 `runAgent`（非 `runForkedAgent`），带 `forkContextMessages` 共享上下文
- 仅 `USER_TYPE === 'ant'` 时生效（可放开）

### 4.5 Integration

| File | Operation |
|------|-----------|
| `src/services/MagicDocs/` | **New** — 2 files |
| `src/utils/backgroundHousekeeping.ts` | Modify — 添加 `initMagicDocs()` |

---

## 5. openclaude 快照同步机制 (P1)

**Source**: `/Users/heal/openclaude/src/tools/AgentTool/agentMemorySnapshot.ts` (ola-cc 已集成)

### 5.1 核心机制

openclaude 的 AgentMemory 支持快照同步，通过项目级快照目录（`.ola-cc/agent-memory-snapshots/<agentType>/`）实现快照→本地的记忆复制。同步元数据仅记录 `{ syncedFrom: string }`（快照时间戳），**无 hash 比对、无增量逻辑**——每次同步都是全量替换。

### 5.2 同步协议

```typescript
// 首次加载 — 本地无记忆文件时
initializeFromSnapshot(agentType, scope, snapshotTimestamp):
  1. 读取快照目录下所有文件（排除 snapshot.json）
  2. 全量复制到本地 memory 目录
  3. 写入 .snapshot-synced.json { syncedFrom: snapshotTimestamp }

// 全量替换 — 快照比本地记录更新时
replaceFromSnapshot(agentType, scope, snapshotTimestamp):
  1. 删除本地所有 .md 文件
  2. 从快照目录全量复制（与 initializeFromSnapshot 相同逻辑）
  3. 更新 .snapshot-synced.json { syncedFrom: snapshotTimestamp }

// 检查快照状态
checkAgentMemorySnapshot(agentType, scope):
  1. 读取快照的 snapshot.json 获取 updatedAt 时间戳
  2. 如果本地无 .md 文件 → action: 'initialize'
  3. 如果 .snapshot-synced.json 不存在或快照时间更新 → action: 'prompt-update'
  4. 否则 → action: 'none'

// 跳过同步（用户拒绝更新时）
markSnapshotSynced(agentType, scope, snapshotTimestamp):
  仅写入 .snapshot-synced.json，不修改本地文件
```

### 5.3 关键函数签名

```typescript
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>

export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>

export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{ action: 'none' | 'initialize' | 'prompt-update'; snapshotTimestamp?: string }>

export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>
```

### 5.4 同步策略特点

- **全量替换**：不做增量比对，每次同步删除旧文件后复制全部快照文件
- **时间戳门控**：通过 `.snapshot-synced.json.syncedFrom` 与 `snapshot.json.updatedAt` 比较判断是否需要更新
- **用户确认**：`checkAgentMemorySnapshot` 返回 `'prompt-update'` 时，由 UI 层询问用户是否接受更新
- **LRU 追踪**：通过 `getSnapshotDirForAgent()` 按 agentType 隔离快照目录

### 5.5 安全约束

- 快照目录基于项目路径（`<cwd>/.ola-cc/agent-memory-snapshots/<agentType>/`）
- 同步操作不合并内容，仅全量替换（避免冲突）
- `.snapshot-synced.json` 记录同步时间戳用于审计

### 5.6 Integration

| File | Operation |
|------|-----------|
| `src/tools/AgentTool/agentMemorySnapshot.ts` | **New** — 5 个导出函数，~198 LOC |
| `src/tools/AgentTool/agentMemory.ts` | Modify — 启动时调用 `checkAgentMemorySnapshot()` |

**具体集成点 — agentMemory.ts 的 loadMemory()**：

```typescript
// 在 agentMemory.ts 的 loadMemory() 中添加
import { checkAgentMemorySnapshot, initializeFromSnapshot, replaceFromSnapshot } from './agentMemorySnapshot.js'

export async function loadMemory(agentType: string, scope: AgentMemoryScope): Promise<AgentMemory> {
  // 快照同步：检查快照状态
  const snapshot = await checkAgentMemorySnapshot(agentType, scope)
  if (snapshot.action === 'initialize' && snapshot.snapshotTimestamp) {
    await initializeFromSnapshot(agentType, scope, snapshot.snapshotTimestamp)
  }
  // 'prompt-update' 由 UI 层处理，调用 replaceFromSnapshot()

  // 原有逻辑：读取本地 memory 文件
  const files = await glob(`${getAgentMemoryDir(agentType, scope)}/**/*.md`)
  // ...
}
```

**调用时序**：`loadMemory()` 在 AgentTool 初始化时调用（`agentMemory.ts` 的 `getOrCreateMemory()`），快照同步必须在本地文件读取之前完成，确保本地 memory 包含最新的快照内容。

---

## 6. oh-my-claudecode 深度合并算法 (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/lib/project-memory-merge.ts`

### 6.1 核心机制

确定性的记忆合并算法，按字段类型差异化处理，比 LLM 判断更可预测。**硬编码 switch-case 策略**，无 options 参数——所有合并规则在 `mergeArrays()` 函数内按字段名分发。

### 6.2 合并策略

```typescript
// 签名：无 options 参数，仅 base + incoming
deepMerge<T>(base: T, incoming: Partial<T>): T:
  // 普通对象: 递归深度合并（incoming 的 keys 遍历 base）
  // 数组: 按字段名 switch-case 分发到不同的 mergeArrays 策略
  // 标量/null/undefined: incoming 覆盖 base（last-write-wins）
  // 安全过滤: 跳过 __proto__/constructor/prototype 键
```

### 6.3 mergeArrays 字段策略（硬编码 switch-case）

| 字段 | keyFn | resolve 策略 | 说明 |
|------|-------|-------------|------|
| `customNotes` | `${note.category}::${note.content}` | 时间戳较新的胜出 `(b.timestamp >= a.timestamp ? b : a)` | 不是简单的 "source 优先" |
| `userDirectives` | `d.directive`（不是 `d.text`） | 时间戳较新的胜出 `(b.timestamp >= a.timestamp ? b : a)` | keyFn 是 `directive` 字段 |
| `hotPaths` | `hp.path` | `Math.max(a.accessCount, b.accessCount)` + `Math.max(a.lastAccessed, b.lastAccessed)` | 取两个字段的 max 值合并 |
| `languages` / `frameworks` | `item.name` | incoming 覆盖 base `(_a, b) => b` | 简单覆盖 |
| `workspaces` / `mainDirectories` / `keyFiles` / `markers` | — | 标量数组 union（JSON 序列化去重） | 字符串并集 |
| 其他字段（default） | — | 标量数组 union（JSON 序列化去重） | JSON.stringify 去重 |

**注意**：`learnedSkills` 字段不存在于实际代码的 switch-case 中。

### 6.4 mergeByKey 通用函数

```typescript
function mergeByKey<T>(
  base: T[],
  incoming: T[],
  keyFn: (item: T) => string,
  resolve: (base: T, incoming: T) => T,
): T[]
// 逻辑: 用 Map<key, item> 合并，base 先入 map，incoming 遇到同 key 调 resolve 决定胜负
```

### 6.5 mergeProjectMemory 顶层入口

```typescript
export function mergeProjectMemory(
  existing: ProjectMemory,
  incoming: Partial<ProjectMemory>,
): ProjectMemory
// 内部调用 deepMerge，然后强制设置 merged.lastScanned = incoming.lastScanned ?? existing.lastScanned
```

### 6.6 Integration

| File | Operation |
|------|-----------|
| `src/lib/project-memory-merge.ts` | **New** — ~219 LOC |
| `src/tools/AgentTool/agentMemory.ts` | Modify — 使用深度合并替代全量替换 |

**具体集成点 — agentMemory.ts 的 saveMemory()**：

```typescript
// 在 agentMemory.ts 的 saveMemory() 中替换全量写入
import { mergeProjectMemory } from '../../lib/project-memory-merge.js'

export async function saveMemory(memoryDir: string, newMemory: AgentMemory): Promise<void> {
  // 读取现有 memory（如果存在）
  const existingMemory = await loadMemory(memoryDir).catch(() => null)

  if (existingMemory) {
    // 深度合并：incoming 覆盖 base，数组按字段策略去重
    const merged = mergeProjectMemory(existingMemory, newMemory)
    await writeMemoryFiles(memoryDir, merged)
  } else {
    // 首次写入：直接写入
    await writeMemoryFiles(memoryDir, newMemory)
  }
}
```

**合并策略说明**：
- `customNotes` / `userDirectives`：时间戳较新的胜出（不是简单的 source 优先）
- `hotPaths`：取 `accessCount` 和 `lastAccessed` 的 `Math.max` 值合并
- `languages` / `frameworks`：按 `name` 去重，incoming 覆盖
- 字符串数组（workspaces 等）：JSON 序列化去重取并集
- 普通对象：递归深度合并
- 标量/null/undefined：incoming 覆盖 base（last-write-wins）

---

## 7. 架构师视角

### 7.1 共享基础设施

三系统共享：
- `backgroundHousekeeping.ts` 初始化入口
- `stopHooks.ts` 触发点
- `createAutoMemCanUseTool` 工具权限
- `runForkedAgent` 执行框架

### 7.2 状态管理对比

| 系统 | 状态模型 | 持久化 | 并发控制 |
|------|---------|--------|---------|
| ExtractMemories | 闭包 + 游标 | 游标在内存中（重启重置） | `inProgress` flag |
| AutoDream | 闭包 + 锁文件 | lock 文件 mtime | 文件锁 |
| MagicDocs | 模块级 Map | 无（每次重建） | `sequential()` 包装 |

### 7.3 ola-cc 集成建议

优先集成 ExtractMemories（P0），因为它是最基础的能力：
1. 实现 `createAutoMemCanUseTool` 工具权限系统
2. 在 stopHooks 中添加记忆提取触发
3. 实现 forked agent 执行框架（或复用现有 AgentTool）
4. AutoDream 和 MagicDocs 可在 ExtractMemories 稳定后追加

---

## 8. 产品经理视角

### 8.1 用户价值

| 功能 | 解决的痛点 | 用户感知 |
|------|-----------|---------|
| ExtractMemories | "每次新会话都要重新解释上下文" | 自动记住用户偏好和项目知识 |
| AutoDream | "记忆文件越来越多，互相矛盾" | 定期自动整理，保持一致性 |
| MagicDocs | "文档总是过时" | 标记 MAGIC DOC 后文档自动更新 |

### 8.2 竞品对比

| 能力 | claude-code | ola-cc 当前 | 差距 |
|------|------------|------------|------|
| 自动记忆提取 | ✅ 每轮自动 | ✅ ExtractMemories 已集成 | 快照同步待补充 |
| 记忆整合 | ✅ AutoDream | ✅ AutoDream 已集成 | 深度合并待补充 |
| 活文档 | ✅ MagicDocs | ✅ MagicDocs 已集成 | 无 |
| 快照同步 | ✅ agentMemorySnapshot | ❌ 未集成 | **增量缺失** |
| 深度合并算法 | ✅ deepMerge | ❌ 全量替换 | **增量缺失** |

---

## 9. 算法工程师视角

### 9.1 Token 效率

- ExtractMemories 使用 `maxTurns: 5` 限制子代理执行
- `newMessageCount` 增量计算避免全量扫描
- manifest 格式化避免重复创建已有记忆
- `skipIndex=true` 模式可跳过 MEMORY.md 更新节省 1 turn

### 9.2 Cache 优化

```typescript
// 关键设计：保留工具但拒绝调用，保证 cache key 匹配
canUseTool: async () => ({ behavior: 'deny', message: 'Tools not allowed' })
// 而不是 tools: []，后者会改变 cache key
```

### 9.3 可靠性设计

- 游标机制：失败时游标不动，下次重试
- trailing run：执行期间到达的新请求不会丢失
- drain 机制：graceful shutdown 等待 in-flight 完成
- 互斥检查：主代理已写记忆则跳过，避免重复

---

## 10. Feature Flags 与向后兼容

### 10.1 Feature Flag 表

| Flag 名称 | 控制功能 | 默认值 | 环境变量覆盖 |
|-----------|---------|--------|-------------|
| `MEMORY_SNAPSHOT_SYNC` | openclaude 快照同步（§5） | `off` | `OLA_CC_MEMORY_SNAPSHOT_SYNC=1` |
| `MEMORY_DEEP_MERGE` | oh-my-claudecode 深度合并（§6） | `off` | `OLA_CC_MEMORY_DEEP_MERGE=1` |

### 10.2 降级策略

| Flag 状态 | 快照同步行为 | 深度合并行为 |
|-----------|-------------|-------------|
| `MEMORY_SNAPSHOT_SYNC=off` | 跳过 `initializeFromSnapshot()` 调用，仅读取本地 memory 文件 | N/A |
| `MEMORY_DEEP_MERGE=off` | N/A | `saveMemory()` 使用现有全量替换逻辑，不调用 `deepMerge()` |
| 两者均 `off` | 完全回退到当前 ola-cc 行为：本地 memory 读取 + 全量写入 | 同左 |

**降级实现**：

```typescript
// agentMemory.ts — Feature gate 包装
import { isFeatureEnabled } from '../../utils/featureFlags.js'

export async function loadMemory(memoryDir: string): Promise<AgentMemory> {
  // 快照同步：仅在 flag 启用时执行
  if (isFeatureEnabled('MEMORY_SNAPSHOT_SYNC') && process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    await initializeFromSnapshot(
      process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
      memoryDir
    )
  }
  // 原有逻辑不变
  const files = await glob(`${memoryDir}/**/*.md`)
  // ...
}

export async function saveMemory(memoryDir: string, newMemory: AgentMemory): Promise<void> {
  if (isFeatureEnabled('MEMORY_DEEP_MERGE')) {
    const existingMemory = await loadMemory(memoryDir).catch(() => null)
    if (existingMemory) {
      const merged = deepMerge(existingMemory, newMemory, { /* ... */ })
      await writeMemoryFiles(memoryDir, merged)
      return
    }
  }
  // 降级路径：全量替换（原有行为）
  await writeMemoryFiles(memoryDir, newMemory)
}
```

### 10.3 环境变量覆盖

| 环境变量 | 作用 | 示例 |
|---------|------|------|
| `OLA_CC_MEMORY_SNAPSHOT_SYNC` | 强制启用/禁用快照同步 | `=1` 启用, `=0` 禁用 |
| `OLA_CC_MEMORY_DEEP_MERGE` | 强制启用/禁用深度合并 | `=1` 启用, `=0` 禁用 |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程快照目录路径 | `/mnt/shared/claude-memory` |

**优先级**: 环境变量 > Feature flag 默认值 > 代码内默认值（`off`）

---

## 11. LOC 估算

| 模块 | 新增文件 | 预估 LOC | 复杂度 | 说明 |
|------|---------|---------|--------|------|
| §5 快照同步 | `agentMemorySnapshot.ts` | ~200 | M | 含全量复制、时间戳比对、4 个导出函数（check/initialize/replace/markSynced） |
| §6 深度合并 | `project-memory-merge.ts` | ~220 | M | 含 `deepMerge` 递归、5 种 switch-case 策略（customNotes/userDirectives/hotPaths/languages+frameworks/strings）、标量数组去重 |
| §5 Integration | `agentMemory.ts` 修改 | ~30 | S | `loadMemory()` 添加 2 行 gate + 调用 |
| §6 Integration | `agentMemory.ts` 修改 | ~40 | S | `saveMemory()` 添加 gate + 合并分支 |
| Feature flags | `featureFlags.ts` 修改 | ~10 | XS | 添加 2 个 flag 定义 |
| **合计** | — | **~500** | — | — |

---

## 12. 实施路线图

| Phase | 功能 | 优先级 | 依赖 | 难度 |
|-------|------|--------|------|------|
| Phase 1 | openclaude 快照同步（§5） | P1 | 现有 ExtractMemories | M |
| Phase 2 | oh-my-claudecode 深度合并算法（§6） | P1 | 现有 AutoDream | M |

---

## 13. 安全工程师视角

### 13.1 记忆文件权限控制

记忆文件包含用户偏好、项目决策等敏感信息，必须严格控制文件权限：

```typescript
// agentMemory.ts — 写入记忆文件后设置权限
import { chmod } from 'fs/promises'

async function writeMemoryFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 })  // 仅 owner 可读写
}

// 目录创建时设置权限
async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })  // 仅 owner 可访问
}
```

**权限矩阵**：

| 路径 | 权限 | 说明 |
|------|------|------|
| `~/.claude/projects/<path>/memory/` | `0o700` | 记忆目录，仅 owner |
| `~/.claude/projects/<path>/memory/*.md` | `0o600` | 记忆文件，仅 owner 读写 |
| `.snapshot-synced.json` | `0o600` | 同步元数据，仅 owner |

### 13.2 快照目录白名单校验

远程快照目录必须在白名单路径内，防止路径遍历攻击：

```typescript
// agentMemorySnapshot.ts — 快照目录校验
import { isWhitelistedPath } from '../singularity/storage.js'

async function validateSnapshotDir(snapshotDir: string): Promise<boolean> {
  // 1. 路径规范化（防止 ../../../ 遍历）
  const resolved = path.resolve(snapshotDir)

  // 2. 白名单校验
  if (!isWhitelistedPath(resolved)) {
    logger.warn(`Snapshot dir not whitelisted: ${resolved}`)
    return false
  }

  // 3. 符号链接检查（防止符号链接逃逸）
  const realPath = await fs.realpath(resolved).catch(() => null)
  if (!realPath || realPath !== resolved) {
    logger.warn(`Snapshot dir is a symlink: ${resolved} -> ${realPath}`)
    return false
  }

  return true
}
```

### 13.3 敏感信息过滤

记忆提取时必须过滤敏感信息，防止 API key、密码等被持久化：

```typescript
// ExtractMemories prompt 中添加过滤规则
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[a-z0-9_-]{16,}['"]?/gi,
  /(?:sk-|pk-|rk-)[a-z0-9]{20,}/gi,  // OpenAI/Stripe/各种 API key 前缀
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,  // 私钥
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,  // 密码
]

function filterSensitiveContent(content: string): string {
  let filtered = content
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, '[REDACTED]')
  }
  return filtered
}
```

**过滤时机**：
- ExtractMemories 提取记忆时（prompt 中明确指示 LLM 不提取敏感信息 + 后处理过滤）
- saveMemory 写入前（兜底过滤）
- 快照同步复制文件时（扫描并过滤）

### 13.4 安全审计日志

所有记忆读写操作记录审计日志，用于异常检测：

```typescript
// 审计事件类型
interface MemoryAuditEvent {
  timestamp: number
  operation: 'read' | 'write' | 'sync' | 'merge' | 'prune'
  path: string
  source: 'extractMemories' | 'autoDream' | 'snapshot' | 'manual'
  bytesWritten?: number
  filesAffected?: number
}
```
