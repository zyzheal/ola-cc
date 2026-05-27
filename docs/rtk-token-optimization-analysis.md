# RTK Token 优化策略分析报告

> 基于对 rtk-ai/rtk 项目的深度分析，为 ola-cc 提供优化的 token 消耗策略

---

## 执行摘要

RTK (Rust Token Killer) 是一个高性能 CLI 代理工具，通过四种核心策略将 LLM token 消耗减少 60-90%。本报告分析了 RTK 的核心技术，并为 ola-cc 提供了 12 项可落地的 token 优化策略。

---

## 一、RTK 核心技术分析

### 1.1 RTK 工作原理

```
Without RTK:                          With RTK:

Claude --git status-->  shell  -->  git  Claude --git status-->  RTK  -->  git
  ^                                    ^        ^                |        |
  |        ~2,000 tokens (raw)        |        |   ~200 tokens    | filter  |
  +------------------------------------+        +------- (filtered) +--------+
```

### 1.2 四大核心策略

| 策略 | 实现方式 | 效果 |
|------|----------|------|
| **智能过滤** | 移除噪音（注释、空行、样板代码） | 减少 40-60% |
| **分组聚合** | 按目录分组文件、按类型分组错误 | 减少 30-50% |
| **智能截断** | 保留关键上下文，移除冗余 | 减少 20-40% |
| **去重压缩** | 合并重复日志行，使用计数 | 减少 10-30% |

---

## 二、RTK Token 节省数据

### 2.1 常见命令节省统计

| 命令类型 | 频次 | 标准 tokens | RTK tokens | 节省率 |
|----------|------|------------|------------|--------|
| `ls` / `tree` | 10x | 2,000 | 400 | -80% |
| `cat` / `read` | 20x | 40,000 | 12,000 | -70% |
| `grep` / `rg` | 8x | 16,000 | 3,200 | -80% |
| `git status` | 10x | 3,000 | 600 | -80% |
| `git diff` | 5x | 10,000 | 2,500 | -75% |
| `git log` | 5x | 2,500 | 500 | -80% |
| `git add/commit/push` | 8x | 1,600 | 120 | -92% |
| `cargo test` / `npm test` | 5x | 25,000 | 2,500 | -90% |
| `ruff check` | 3x | 3,000 | 600 | -80% |
| **总计** | | **~118,000** | **~23,900** | **-80%** |

---

## 三、为 ola-cc 定制的 12 项 Token 优化策略

### 3.1 命令输出优化（P0 紧急）

#### 策略 1: Read 工具智能截断
**目标**: 将文件读取输出从完整内容改为摘要版本
```typescript
// 当前
Read.readFile -> 完整文件内容 (可达 10K+ tokens)

// 优化后
Read.readFile -> 智能摘要：
- 显示文件开头/结尾各 50 行
- 中间用 "[... 500 lines omitted ...]" 占位
- 显示关键函数签名和导入
```
**预期节省**: 70-90%

#### 策略 2: Bash 输出流式处理
**目标**: 对大型命令输出实时截断，避免全量加载
```typescript
// 当前
Bash.execute -> 等待完整输出 -> 截断

// 优化后
Bash.execute -> 流式读取 -> 达到阈值自动截断
- 实时监控输出行数
- 触发阈值后截断并保存完整日志到临时文件
- 提供 "View full output" 按钮
```
**预期节省**: 80-95%

#### 策略 3: Git 输出压缩
**目标**: 对 git 相关命令进行 RTK 级别的优化
```typescript
// git status
当前: 50+ 行详细状态
优化: "M 3 files, A 2, D 1, ? 5"

// git log --oneline
当前: 每行完整 commit 信息
优化: "commit123: feat(): Add X commit456: fix(): Resolve Y"

// git diff
当前: 完整 diff
优化: 只显示修改的文件和摘要统计
```
**预期节省**: 75-85%

### 3.2 工具结果缓存优化（P1 重要）

#### 策略 4: Read 文件缓存
**目标**: 避免重复读取相同文件
```typescript
// 实现文件缓存机制
interface FileCache {
  [filePath]: {
    content: string,
    version: number, // file modification time
    compressedSummary: string,
    tokenCount: number,
  }
}

// 优先从缓存读取
if (cache[file] && cache[file].version === fs.statSync(file).mtimeMs) {
  return cache[file].compressedSummary;
}
```
**预期节省**: 40-60%（重复文件读取场景）

#### 策略 5: 工具结果智能去重
**目标**: 检测并合并相似的命令输出
```typescript
// 示例：多次 git status 检查
// 第1次: "modified: src/utils/model.ts"
// 第2次: "modified: src/utils/model.ts (unchanged)"
// 第3次: "modified: src/utils/model.ts"

// 合并为:
// Git changes overview:
// • src/utils/model.ts (appeared 3 times, no changes since last check)
// • src/services/api/claude.ts (appeared 1 time)
```
**预期节省**: 30-50%（相似命令重复执行）

#### 策略 6: 目录结构缓存
**目标**: 缓存目录列表，避免重复的 `ls` 调用
```typescript
// 实现目录缓存
interface DirCache {
  [dirPath]: {
    structure: string,
    lastChecked: number,
    hasChanges: boolean,
  }
}

// 智能判断目录是否变化
if (timeSinceLastCheck < 300000 && !hasChanges) {
  return cachedStructure;
}
```
**预期节省**: 50-70%（频繁目录浏览）

### 3.3 智能上下文管理（P1 重要）

#### 策略 7: 上下文窗口智能分区
**目标**: 根据不同类型的内容动态调整上下文分配
```typescript
interface ContextAllocation {
  systemPrompt: number,    // 固定 2K
  toolsSchema: number,     // 可变，但上限 3K
  conversation: number,   // 动态计算，保留 30% 空间
  fileAttachments: number,  // 按需分配，最多占 20%
  memories: number,         // 最多占 15%
}

// 智能调整
function optimizeContextAllocation() {
  const availableTokens = getTotalAvailableTokens();
  
  // 文件较多时，压缩每个文件的内容
  if (fileCount > 10) {
    perFileSize = Math.min(perFileSize, 200);
  }
  
  // 对话历史较长时，更激进的压缩
  if (messageCount > 50) {
    compressionRatio = Math.max(compressionRatio, 0.7);
  }
}
```
**预期节省**: 25-40%（整体 token 使用）

#### 策略 8: 优先级内容保留
**目标**: 智能判断内容重要性，优先保留关键信息
```typescript
interface ContentPriority {
  CRITICAL: number,   // 必须保留
  HIGH: number,       // 重要保留
  MEDIUM: number,     // 可选保留
  LOW: number,        // 可丢弃
}

// 内容分类规则
function classifyContent(content: string): Priority {
  // 文件内容
  if (isTestFile(content)) return Priority.HIGH;
  if (isConfigFile(content)) return Priority.CRITICAL;
  if (isDocumentation(content)) return Priority.LOW;
  
  // 命令输出
  if (isGitStatus(content)) return Priority.HIGH;
  if (hasErrors(content)) return Priority.CRITICAL;
  
  // 默认
  return Priority.MEDIUM;
}
```
**预期节省**: 20-35%（智能丢弃低价值内容）

#### 策略 9: 渐进式压缩
**目标**: 根据压力程度动态调整压缩级别
```typescript
interface CompressionLevel {
  NONE: "No compression",
  LIGHT: "Minimal changes",
  MEDIUM: "Aggressive summarization", 
  HEAVY: "Extreme compression"
}

// 动态选择
function determineCompressionLevel(usage: TokenUsage): CompressionLevel {
  const percentage = usage.used / usage.total;
  
  if (percentage > 0.9) return CompressionLevel.HEAVY;
  if (percentage > 0.8) return CompressionLevel.MEDIUM;
  if (percentage > 0.7) return CompressionLevel.LIGHT;
  return CompressionLevel.NONE;
}
```
**预期节省**: 15-30%（按需压缩）

### 3.4 高级优化策略（P2 可选）

#### 策略 10: 模型特定优化
**目标**: 根据不同模型的特点进行针对性优化
```typescript
interface ModelOptimization {
  claude: {
    contextWindow: 200000,
    promptCache: true,
    compressionRatio: 0.6,
  },
  opus: {
    contextWindow: 200000,
    promptCache: true,
    compressionRatio: 0.7,
  },
  sonnet: {
    contextWindow: 200000,
    promptCache: true,
    compressionRatio: 0.65,
  },
  haiku: {
    contextWindow: 32000,
    promptCache: false,
    compressionRatio: 0.8,
  }
}

function applyModelSpecificOptimizations(model: string) {
  const config = modelOptimizations[model];
  // 应用特定于模型的配置
}
```
**预期节省**: 10-20%（模型特定优化）

#### 策略 11: 用户行为学习
**目标**: 基于用户的使用模式动态调整策略
```typescript
interface UserBehaviorModel {
  frequentCommands: Map<string, number>,
  preferredFileTypes: string[],
  compressionSensitivity: number, // 0-1
  alwaysShowDiff: boolean,
  prioritizeTests: boolean,
}

// 动态调整
function learnFromUserBehavior(toolCall: ToolCall) {
  // 记录命令使用频率
  userBehavior.frequentCommands.set(
    toolCall.tool, 
    (userBehavior.frequentCommands.get(toolCall.tool) || 0) + 1
  );
  
  // 学习文件类型偏好
  if (toolCall.tool === 'Read') {
    const fileType = getFileType(toolCall.input.file);
    if (!userBehavior.preferredFileTypes.includes(fileType)) {
      userBehavior.preferredFileTypes.push(fileType);
    }
  }
}
```
**预期节省**: 15-25%（个性化优化）

#### 策略 12: 预测性压缩
**目标**: 预测未来 token 使用，提前进行压缩
```typescript
interface TokenPrediction {
  currentUsage: number,
  projectedUsage: number,
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  suggestedActions: string[],
}

// 预测算法
function predictTokenUsage(): TokenPrediction {
  // 基于历史趋势预测
  const trend = analyzeTokenUsageTrend();
  const upcomingCalls = getUpcomingToolCalls();
  
  const projected = calculateExpectedTokens(trend, upcomingCalls);
  
  return {
    currentUsage: getCurrentUsage(),
    projectedUsage: projected,
    riskLevel: calculateRiskLevel(projected),
    suggestedActions: suggestActions(projected),
  };
}
```
**预期节省**: 20-30%（预防性优化）

---

## 四、实施路线图

### Phase 1: 基础优化（2-3 周）
1. 实现 Read 工具智能截断
2. 实现 Bash 输出流式处理
3. 实现 Git 命令压缩
4. 建立基础缓存机制

### Phase 2: 中级优化（3-4 周）
1. 实现工具结果去重
2. 实现目录结构缓存
3. 实现上下文智能分区
4. 实现优先级内容保留

### Phase 3: 高级优化（4-6 周）
1. 实现渐进式压缩
2. 实现模型特定优化
3. 实现用户行为学习
4. 实现预测性压缩

---

## 五、预期效果评估

### 5.1 Token 节省预期

| 优化策略 | 覆盖场景 | 预期节省 | 实施复杂度 |
|----------|----------|----------|------------|
| Read 截断 | 文件读取 | 70-90% | 低 |
| Bash 流式处理 | 大型命令输出 | 80-95% | 中 |
| Git 压缩 | Git 操作 | 75-85% | 中 |
| 文件缓存 | 重复文件读取 | 40-60% | 低 |
| 内容去重 | 重复命令 | 30-50% | 高 |
| 目录缓存 | 频繁浏览 | 50-70% | 低 |
| 上下文分区 | 所有场景 | 25-40% | 高 |
| 优先级保留 | 所有场景 | 20-35% | 中 |
| 渐进压缩 | 压力场景 | 15-30% | 中 |
| 模型优化 | 多模型 | 10-20% | 中 |
| 用户学习 | 个性化 | 15-25% | 高 |
| 预测压缩 | 前瞻性 | 20-30% | 高 |

**总体预期节省**: 40-60%

### 5.2 性能指标改进

| 指标 | 当前目标 | 优化后目标 | 提升幅度 |
|------|----------|------------|----------|
| 平均每轮 tokens | ~50K | ~25K | -50% |
| 上下文压缩频率 | 手动触发 | 自动+智能 | +300% |
| 重复命令效率 | 100% | 300% | +200% |
| 大文件处理速度 | 慢 | 快 | +150% |
| 命令响应时间 | 正常 | 优化 | -30% |

---

## 六、建议与注意事项

### 6.1 实施建议

1. **渐进式实施**: 从高收益、低复杂度的策略开始
2. **用户可控**: 提供 "show full output" 选项，让用户决定
3. **向后兼容**: 不影响现有功能，仅在后台优化
4. **监控反馈**: 建立节省效果监控，让用户看到收益

### 6.2 技术考虑

1. **性能影响**: 缓存和压缩会增加少量 CPU 开销
2. **内存使用**: 缓存机制需要合理管理内存使用
3. **准确性**: 确保压缩不丢失关键信息
4. **模型差异**: 不同模型对压缩的容忍度不同

### 6.3 用户体验

1. **透明度**: 让用户知道哪些内容被压缩了
2. **控制权**: 允许用户自定义压缩级别
3. **可视化**: 展示 token 节省统计
4. **文档**: 清楚说明各策略的效果

---

## 七、与现有系统的整合

### 7.1 与 Compact 系统的关系

这些优化策略与现有的 compact 系统是互补关系：

- **Compact**: 处理整个对话历史的压缩
- **Token 优化**: 处理单个工具调用的输出压缩
- **协同作用**: Token 优化减轻 compact 的压力，compact 系统在必要时进行最后一道防线

### 7.2 实现位置建议

```typescript
// src/services/tokenOptimization/
├── compression/     // 各种压缩策略实现
├── caching/        // 缓存机制
├── prediction/     // 预测算法
└── learning/       // 用户行为学习
```

---

*报告生成时间: 2026-05-26*  
*基于 rtk-ai/rtk v0.28.2 分析*