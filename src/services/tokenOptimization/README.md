# Token Optimization 架构设计

## 概览

Token 优化系统采用三层架构，在数据流的不同阶段进行优化：

```
┌─────────────────────────────────────────────────────┐
│                    LLM API                          │
└───────────────────┬──────────────────────────────────┘
                   │ (已优化的小结果)
┌───────────────────▼──────────────────────────────────┐
│              Token Optimization Layer                 │
│  • 实时截断   • 缓存查询   • 智能去重   • 压缩分组   │
└───────────────────┬──────────────────────────────────┘
                   │ (原始工具调用)
┌───────────────────▼──────────────────────────────────┐
│               Tool Execution Layer                    │
│  • Bash 流式处理  • Read 智能摘要  • Git 压缩输出    │
└───────────────────┬──────────────────────────────────┘
                   │ (未经处理的工具输出)
┌───────────────────▼──────────────────────────────────┐
│                  Individual Tools                    │
│  Read, Bash, FileEdit, Git tools, etc.             │
└─────────────────────────────────────────────────────┘
```

## 详细架构

### Layer 1: 工具执行层（Tool Level）

**位置**: `src/tools/[ToolName]/[ToolName].ts`

**职责**:
- 处理单个工具的原始输出
- 执行最基础的优化策略

**实现策略**:
```typescript
// Read 工具示例
class FileReadTool {
  async call(input: FileReadInput) {
    // 1. 检查缓存
    const cached = await this.checkCache(input.file);
    if (cached) return cached.compressedSummary;
    
    // 2. 读取文件
    const content = await fs.readFile(input.file, 'utf-8');
    
    // 3. 应用压缩策略
    const optimized = await this.optimizeContent(content, {
      strategy: this.getCompressionStrategy(input),
      maxSize: this.getMaxSize(input),
    });
    
    // 4. 缓存结果
    await this.cacheResult(input.file, content, optimized);
    
    return optimized;
  }
}
```

### Layer 2: 工具编排层（Orchestration Level）

**位置**: `src/services/tools/toolOrchestration.ts`

**职责**:
- 协调多个工具的结果
- 执行跨工具的优化策略
- 管理上下文状态

**实现策略**:
```typescript
export async function* runTools(...): AsyncGenerator<MessageUpdate> {
  const results: ToolResult[] = [];
  
  for (const update of toolUpdates) {
    // 1. 跨工具去重
    if (!this.isDuplicateResult(update.message)) {
      results.push(update.message);
      
      // 2. 优先级排序
      const sorted = this.sortByPriority(results);
      
      // 3. 智能分组
      const grouped = await this.groupSimilarResults(sorted);
      
      yield {
        message: this.createOptimizedMessage(grouped),
        newContext: currentContext,
      };
    }
  }
}
```

### Layer 3: Token 优化层（Optimization Layer）

**位置**: `src/services/tokenOptimization/`

**职责**:
- 监控全局 token 使用情况
- 执行高级优化策略
- 与 compact 系统协同工作

**实现策略**:
```typescript
class TokenOptimizer {
  async optimizeBeforeAPI(messages: Message[]): Promise<Message[]> {
    // 1. 预测性压缩
    const prediction = await this.predictTokenUsage(messages);
    
    if (prediction.riskLevel === 'HIGH') {
      // 2. 应用渐进式压缩
      const compressed = await this.applyProgressiveCompression(
        messages, 
        prediction.suggestedActions
      );
      
      // 3. 与 compact 系统协调
      if (prediction.needCompact) {
        return await this.coordinateWithCompact(compressed);
      }
      
      return compressed;
    }
    
    return messages;
  }
}
```

## 与现有系统的集成

### 1. 与 Compact 系统的关系

```
Token Optimization ──协调──> Compact System
       │                      │
       └──提供优化后的数据─────┘
```

**协调机制**:
- Token 优化系统在 compact 触发前尽可能减少 token
- 当优化仍不足时，触发 compact 作为最后防线
- Compact 系统可以请求特定区域的进一步压缩

### 2. 实施优先级

**Phase 1 (高影响, 易实现)**:
- Layer 1: Read 工具截断
- Layer 1: Bash 流式处理
- Layer 1: Git 输出压缩

**Phase 2 (中等影响, 中等难度)**:
- Layer 2: 工具结果去重
- Layer 2: 目录结构缓存
- Layer 3: 上下文智能分区

**Phase 3 (高影响, 高难度)**:
- Layer 3: 预测性压缩
- Layer 3: 用户行为学习
- Layer 3: 与 compact 深度集成

## 配置选项

用户可以通过配置文件控制优化策略：

```typescript
// src/services/tokenOptimization/config.ts
export interface TokenOptimizationConfig {
  // 基础策略
  enableReadTruncation: boolean;
  readMaxSize: number;
  enableBashStreaming: boolean;
  bashMaxLines: number;
  
  // 高级策略
  enableDeduplication: boolean;
  enableProgressiveCompression: boolean;
  enablePrediction: boolean;
  
  // 用户偏好
  compressionLevel: 'minimal' | 'balanced' | 'aggressive';
  prioritizeTests: boolean;
  alwaysShowDiff: boolean;
}
```

## 监控与反馈

```typescript
// 实时监控优化效果
interface OptimizationMetrics {
  originalTokens: number;
  optimizedTokens: number;
  savingsPercentage: number;
  cacheHitRate: number;
  compressionRatio: number;
  
  // 按工具类型统计
  byTool: {
    read: { calls: number; avgSavings: number };
    bash: { calls: number; avgSavings: number };
    git: { calls: number; avgSavings: number };
  };
}
```

## 结论

这种三层架构设计确保了：

1. **及时性** - 在工具执行时立即优化
2. **协同性** - 与现有系统无缝集成
3. **可扩展性** - 易于添加新的优化策略
4. **可控性** - 用户可以精细控制优化行为

不建议将优化策略放入 compact 系统，因为：
- compact 是事后处理，时机太晚
- 损失了优化机会
- 与工具层面的优化重复

最佳实践是在数据流的不同阶段进行分层优化，达到最佳效果。