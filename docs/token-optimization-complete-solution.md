# Token 优化完整解决方案

> 基于 rtk-ai/rtk 项目分析，为 ola-cc 定制的 12 项 token 优化策略及实施方案

---

## 📋 方案概览

### 核心目标
- **总体节省目标**: 40-60% token 消耗
- **实施方式**: 三层混合架构
- **预计周期**: 9-13 周

### 系统架构
```
┌─────────────────────────────────────────────────────┐
│                    LLM API                          │
└───────────────────┬──────────────────────────────────┘
                   │ (已优化的小结果)
┌───────────────────▼──────────────────────────────────┐
│         Token Optimization Layer (高级策略)           │
│  • 预测性压缩  • 用户学习  • 个性化优化  • 模型适配    │
└───────────────────┬──────────────────────────────────┘
                   │ (经过协调优化的结果)
┌───────────────────▼──────────────────────────────────┐
│             Tool Orchestration Layer (中间层)        │
│  • 跨工具去重  • 内容分组  • 优先级排序  • 缓存管理   │
└───────────────────┬──────────────────────────────────┘
                   │ (单个工具优化后的结果)
┌───────────────────▼──────────────────────────────────┐
│               Tool Execution Layer (基础层)          │
│  • Read截断  • Bash流式  • Git压缩  • 实时缓存       │
└───────────────────┬──────────────────────────────────┘
                   │ (原始工具输出)
┌───────────────────▼──────────────────────────────────┐
│                  Individual Tools                    │
│  Read, Bash, FileEdit, Git tools, etc.             │
└─────────────────────────────────────────────────────┘
```

---

## 🎯 12 项 Token 优化策略详解

### Phase 1: 基础优化（2-3 周，预期节省 60-80%）

#### 策略 1: Read 工具智能截断
**实现位置**: `src/tools/FileReadTool/FileReadTool.ts`
```typescript
interface SmartTruncationConfig {
  strategy: 'head-tail' | 'summary-only' | 'key-signatures';
  maxSize: number; // 默认 2000 tokens
  priority: {
    configFiles: 'KEEP_ALL',
    testFiles: 'KEEP_SIGNATURES', 
    sourceFiles: 'KEEP_IMPORTS',
    docs: 'SUMMARY_ONLY'
  };
}

// 实现示例
export class FileReadTool {
  async call(input: FileReadInput): Promise<ToolResult> {
    // 1. 优先从缓存获取
    const cached = await this.smartCache.get(input.file);
    if (cached && !this.isStale(cached)) {
      return this.createResult(cached.compressed);
    }
    
    // 2. 读取文件
    const content = await this.readFile(input.file);
    
    // 3. 智能截断
    const truncated = await this.truncateSmart(content, {
      strategy: this.determineStrategy(input),
      maxSize: this.getOptimalSize(input),
    });
    
    // 4. 更新缓存
    await this.smartCache.set(input.file, {
      original: content,
      compressed: truncated,
      timestamp: Date.now(),
      size: content.length,
    });
    
    return this.createResult(truncated);
  }
}
```

#### 策略 2: Bash 输出流式处理
**实现位置**: `src/tools/BashTool/BashTool.ts`
```typescript
interface StreamingConfig {
  maxLines: number; // 默认 1000
  maxTokens: number; // 默认 8000
  maxFileSize: number; // 默认 10MB
  immediateTruncate: boolean; // 立即截断
  teeMode: 'failures' | 'always' | 'never'; // 保存完整输出
}

// 实现示例
export class BashTool {
  async call(input: BashToolInput): Promise<ToolResult> {
    return new Promise((resolve) => {
      let output = '';
      let lineCount = 0;
      let tokenCount = 0;
      
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        shell: true,
      });
      
      // 实时监控输出
      child.stdout.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        const chunkLines = chunkStr.split('\n');
        
        // 流式截断逻辑
        for (const line of chunkLines) {
          if (this.shouldKeepLine(line, lineCount, tokenCount)) {
            output += line + '\n';
            lineCount++;
            tokenCount += this.estimateTokens(line);
            
            // 达到阈值时截断
            if (lineCount > this.config.maxLines || 
                tokenCount > this.config.maxTokens) {
              this.truncateAndSave(output, input.command);
              resolve(this.createOptimizedResult(output));
              return;
            }
          }
        }
      });
      
      child.on('close', (code) => {
        if (lineCount <= this.config.maxLines) {
          // 未触发截断，直接返回
          resolve(this.createOptimizedResult(output));
        }
        // 已截断的情况在 truncateAndSave 中处理
      });
    });
  }
}
```

#### 策略 3: Git 命令输出压缩
**实现位置**: `src/tools/shared/gitOperations.ts` 新增
```typescript
interface GitCompressionConfig {
  status: 'compact' | 'minimal' | 'full';
  diff: 'unified' | 'stat' | 'summary';
  log: 'short' | 'oneline' | 'hash-only';
  commit: 'hash-only' | 'summary' | 'full';
}

// 实现示例
class GitCompressor {
  async compressStatus(rawOutput: string): Promise<string> {
    const patterns = {
      modified: /modified:\s+(.+)/g,
      added: /new file:\s+(.+)/g,
      deleted: /deleted:\s+(.+)/g,
      untracked: /\?\?\s+(.+)/g,
    };
    
    const result: string[] = ['Git status summary:'];
    let count = 0;
    
    // 提取并计数
    if (patterns.modified.test(rawOutput)) {
      const modified = rawOutput.match(patterns.modified)?.map(m => m.split(':')[1].trim()) || [];
      result.push(`Modified: ${modified.length} files`);
      count += modified.length;
    }
    
    if (patterns.added.test(rawOutput)) {
      const added = rawOutput.match(patterns.added)?.map(m => m.split(':')[1].trim()) || [];
      result.push(`Added: ${added.length} files`);
      count += added.length;
    }
    
    result.push(`Total changes: ${count} files`);
    
    // 如果文件数很少，显示具体文件
    if (count <= 5) {
      const files = [...rawOutput.matchAll(/\?\?\s+(.+)/g)].map(m => m[1]);
      result.push('Untracked:', ...files);
    }
    
    return result.join('\n');
  }
  
  async compressDiff(rawOutput: string): Promise<string> {
    // 只保留文件的修改统计
    const stats = rawOutput.match(/^(\+\+\+|---|\s*\d+\s+\w+|\s*\d+\,\d+\s+\w+)/gm);
    if (!stats) return 'No changes';
    
    const fileNames = [...new Set(
      rawOutput.match(/^@@\s+-\d+,\d+\s+\+(\d+,\d+)?\s+@@/gm)?.map(m => {
        const match = m.match(/@@\s+\+([0-9]+)/);
        return match ? `File at line ${match[1]}` : 'Unknown file';
      }) || []
    )];
    
    return [
      'Changed files:',
      ...fileNames.slice(0, 5), // 最多显示5个文件
      fileNames.length > 5 ? `... and ${fileNames.length - 5} more` : ''
    ].join('\n');
  }
}
```

#### 策略 4: 文件缓存机制
**实现位置**: `src/utils/smartCache/`
```typescript
interface SmartCacheConfig {
  maxSize: number; // 100MB
  ttl: number; // 5分钟
  compression: 'gzip' | 'lz4';
  maxSizePerFile: number; // 1MB
}

class SmartFileCache {
  private cache = new Map<string, CacheEntry>();
  
  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.config.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry;
  }
  
  async set(key: string, data: FileData): Promise<void> {
    // 检查大小
    if (this.cache.size >= this.config.maxSize) {
      await this.evictLRU();
    }
    
    // 压缩数据
    const compressed = await this.compress(data);
    
    this.cache.set(key, {
      key,
      data: compressed,
      originalSize: data.size,
      compressedSize: compressed.length,
      timestamp: Date.now(),
      accessCount: 0,
    });
  }
  
  private async compress(data: FileData): Promise<Buffer> {
    if (this.config.compression === 'gzip') {
      return gzipSync(data.content);
    }
    // 其他压缩算法...
  }
}
```

### Phase 2: 中级优化（3-4 周，预期节省 30-50%）

#### 策略 5: 工具结果智能去重
**实现位置**: `src/services/tools/toolOrchestration.ts`
```typescript
class ResultDeduplicator {
  private similarityCache = new Map<string, string[]>();
  
  async isDuplicate(newResult: Message, history: Message[]): Promise<boolean> {
    // 1. 精确匹配
    const exactMatch = history.find(h => 
      h.type === 'user' && h.content === newResult.content
    );
    if (exactMatch) return true;
    
    // 2. 命令相同且输出相似
    const command = this.extractCommand(newResult);
    const similarHistory = this.getSimilarCommandResults(command, history);
    
    for (const hist of similarHistory) {
      if (await this.calculateSimilarity(newResult, hist) > 0.8) {
        return true;
      }
    }
    
    // 3. 保存相似结果索引
    this.saveSimilarityIndex(command, newResult);
    
    return false;
  }
  
  private async calculateSimilarity(a: Message, b: Message): Promise<number> {
    // 使用简单的文本相似度算法
    const textA = this.normalizeText(a.content);
    const textB = this.normalizeText(b.content);
    
    // 计算共同词的比例
    const wordsA = new Set(textA.split(/\s+/));
    const wordsB = new Set(textB.split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return intersection.size / union.size;
  }
}
```

#### 策略 6: 目录结构缓存
**实现位置**: `src/services/directoryCache/`
```typescript
interface DirectoryCacheEntry {
  path: string;
  structure: string;
  fileCount: number;
  lastModified: number;
  hash: string;
  changeCount: number;
}

class DirectoryCache {
  private cache = new Map<string, DirectoryCacheEntry>();
  
  async getStructure(dir: string): Promise<string> {
    const entry = await this.getEntry(dir);
    if (entry && !await this.hasChanged(dir, entry)) {
      return entry.structure;
    }
    
    const newStructure = await this.buildStructure(dir);
    await this.updateEntry(dir, newStructure);
    return newStructure;
  }
  
  private async buildStructure(dir: string): Promise<string> {
    const tree = await this.listFiles(dir);
    const sorted = tree.sort();
    
    // 构建简洁的目录结构
    const structure: string[] = [`${dir}/`];
    
    for (const item of sorted) {
      const relative = path.relative(dir, item);
      const depth = relative.split('/').length;
      
      // 限制深度显示
      if (depth <= 3) {
        structure.push('  '.repeat(depth) + path.basename(item));
        if (depth === 3 && this.isDirectory(item)) {
          structure.push('    ...');
        }
      }
    }
    
    return structure.join('\n');
  }
}
```

#### 策略 7: 上下文智能分区
**实现位置**: `src/services/contextOptimizer/`
```typescript
interface ContextAllocation {
  systemPrompt: number; // 2000 tokens
  toolsSchema: number;   // 3000 tokens
  conversation: number;  // 动态
  attachments: number;   // 动态
  memories: number;      // 动态
}

class ContextOptimizer {
  async optimize(messages: Message[], toolCalls: ToolUseBlock[]): Promise<Message[]> {
    // 1. 计算当前使用情况
    const current = this.calculateUsage(messages);
    const available = this.getAvailableTokens();
    
    // 2. 动态调整分配
    const allocation = this.calculateOptimalAllocation(current, available, toolCalls);
    
    // 3. 应用压缩策略
    const optimized = await this.applyCompression(messages, allocation);
    
    // 4. 保存优化结果
    this.saveOptimizationResult(current, allocation);
    
    return optimized;
  }
  
  private calculateOptimalAllocation(current: Usage, available: number, toolCalls: ToolUseBlock[]): ContextAllocation {
    const { toolsSchema, memories } = current;
    
    // 计算对话需要的空间（至少保留30%）
    const conversationSpace = Math.max(available * 0.3, this.minConversationSpace);
    
    // 根据即将到来的工具调用预留空间
    const upcomingTools = this.estimateUpcomingToolCalls(toolCalls);
    const upcomingSpace = upcomingTools.reduce((sum, call) => sum + this.estimateToolSize(call), 0);
    
    return {
      systemPrompt: 2000,
      toolsSchema: Math.min(toolsSchema, available * 0.2),
      conversation: conversationSpace,
      attachments: Math.max(0, available * 0.2),
      memories: Math.max(0, available * 0.1),
    };
  }
}
```

#### 策略 8: 优先级内容保留
**实现位置**: `src/services/priorityFilter/`
```typescript
interface ContentPriority {
  CRITICAL: number;   // 必须保留
  HIGH: number;       // 重要保留
  MEDIUM: number;     // 可选保留
  LOW: number;        // 可丢弃
}

class PriorityFilter {
  private priorityRules = new Map<string, (content: string) => Priority>();
  
  constructor() {
    this.setupRules();
  }
  
  setupRules() {
    // Git 相关规则
    this.priorityRules.set('git status', (content) => {
      if (content.includes('error:') || content.includes('fatal:')) {
        return Priority.CRITICAL;
      }
      return Priority.HIGH;
    });
    
    // 测试结果规则
    this.priorityRules.set('test', (content) => {
      if (content.includes('FAILED') || content.includes('ERROR')) {
        return Priority.CRITICAL;
      }
      if (content.includes('PASS') || content.includes('ok')) {
        return Priority.MEDIUM;
      }
      return Priority.LOW;
    });
    
    // 文件类型规则
    this.priorityRules.set('file', (content) => {
      if (this.isConfigFile(content)) return Priority.CRITICAL;
      if (this.isTestFile(content)) return Priority.HIGH;
      if (this.isDocFile(content)) return Priority.LOW;
      return Priority.MEDIUM;
    });
  }
  
  async filterByPriority(messages: Message[]): Promise<Message[]> {
    const filtered: Message[] = [];
    
    for (const message of messages) {
      const priority = this.determinePriority(message);
      const shouldKeep = this.shouldKeepBasedOnPriority(priority);
      
      if (shouldKeep) {
        filtered.push(this.applyPriorityCompression(message, priority));
      }
    }
    
    return filtered;
  }
}
```

### Phase 3: 高级优化（4-6 周，预期节省 20-40%）

#### 策略 9: 渐进式压缩
**实现位置**: `src/services/progressiveCompression/`
```typescript
interface CompressionLevel {
  NONE: { ratio: 0, action: 'no_compression' };
  LIGHT: { ratio: 0.5, action: 'minimal_changes' };
  MEDIUM: { ratio: 0.7, action: 'aggressive_summarization' };
  HEAVY: { ratio: 0.9, action: 'extreme_compression' };
}

class ProgressiveCompressor {
  async compress(content: string, riskLevel: RiskLevel): Promise<string> {
    switch (riskLevel) {
      case 'LOW':
        return this.lightCompression(content);
      case 'MEDIUM':
        return this.mediumCompression(content);
      case 'HIGH':
        return this.heavyCompression(content);
      case 'CRITICAL':
        return this.extremeCompression(content);
    }
  }
  
  private mediumCompression(content: string): string {
    // 保留关键信息，移除次要内容
    const lines = content.split('\n');
    const filtered = lines.filter(line => {
      // 保留错误、警告、关键信息
      if (line.includes('ERROR:') || line.includes('WARNING:')) return true;
      if (line.includes('===') || line.includes('---')) return true;
      // 保留每块的第一行
      if (line.trim() && !lines.some(l => l.trim() && l.indexOf(line) > 0)) return true;
      
      // 移除空行和注释
      return line.trim() && !line.trim().startsWith('//');
    });
    
    return filtered.join('\n');
  }
}
```

#### 策略 10: 模型特定优化
**实现位置**: `src/services/modelOptimization/`
```typescript
interface ModelSpecificConfig {
  claude: {
    contextWindow: number;
    promptCache: boolean;
    compressionRatio: number;
    preferredStrategies: string[];
  };
  opus: {
    contextWindow: number;
    promptCache: boolean;
    compressionRatio: number;
    preferredStrategies: string[];
  };
  sonnet: {
    contextWindow: number;
    promptCache: boolean;
    compressionRatio: number;
    preferredStrategies: string[];
  };
  haiku: {
    contextWindow: number;
    promptCache: boolean;
    compressionRatio: number;
    preferredStrategies: string[];
  };
}

class ModelOptimizer {
  private config: ModelSpecificConfig;
  
  constructor(model: string) {
    this.config = this.getModelConfig(model);
  }
  
  applyOptimization(content: string): string {
    // 根据模型特性调整压缩策略
    switch (this.config.compressionRatio) {
      case 0.5: // Haiku - 高压缩比
        return this.aggressiveCompression(content);
      case 0.65: // Sonnet - 中等压缩比
        return this.balancedCompression(content);
      case 0.7: // Opus - 适度压缩
        return this.lightCompression(content);
      case 0.6: // Claude - 平衡压缩
        return this.adaptiveCompression(content);
    }
  }
}
```

#### 策略 11: 用户行为学习
**实现位置**: `src/services/userBehavior/`
```typescript
interface UserBehaviorModel {
  frequentCommands: Map<string, number>;
  preferredFileTypes: string[];
  compressionSensitivity: number; // 0-1
  alwaysShowDiff: boolean;
  prioritizeTests: boolean;
  workingDirectory: string;
  lastActiveTime: number;
}

class UserBehaviorLearner {
  private behavior: UserBehaviorModel;
  private sessionStart = Date.now();
  
  constructor() {
    this.loadBehavior();
  }
  
  learnFromToolCall(tool: ToolUseBlock, result: Message): void {
    // 记录命令频率
    const toolName = tool.name;
    this.behavior.frequentCommands.set(
      toolName,
      (this.behavior.frequentCommands.get(toolName) || 0) + 1
    );
    
    // 分析文件类型偏好
    if (tool.name === 'Read' && tool.input.file) {
      const fileType = this.getFileType(tool.input.file);
      if (!this.behavior.preferredFileTypes.includes(fileType)) {
        this.behavior.preferredFileTypes.push(fileType);
      }
    }
    
    // 学习压缩敏感度
    if (tool.name === 'diff' && result.content.includes('View full output')) {
      this.behavior.compressionSensitivity = Math.max(
        this.behavior.compressionSensitivity - 0.1,
        0
      );
    }
    
    this.saveBehavior();
  }
  
  getPersonalizedStrategy(toolName: string): Strategy {
    // 根据用户行为推荐个性化策略
    if (this.behavior.prioritizeTests && toolName.includes('test')) {
      return 'keep_full_output';
    }
    
    if (this.behavior.alwaysShowDiff && toolName === 'diff') {
      return 'show_changes_only';
    }
    
    if (this.behavior.compressionSensitivity < 0.3) {
      return 'aggressive_compression';
    }
    
    return 'balanced';
  }
}
```

#### 策略 12: 预测性压缩
**实现位置**: `src/services/predictiveOptimization/`
```typescript
interface TokenPrediction {
  currentUsage: number;
  projectedUsage: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  suggestedActions: string[];
  confidence: number; // 0-1
}

class PredictiveOptimizer {
  private history: TokenUsageHistory[] = [];
  
  async predictTokenUsage(upcomingCalls: ToolUseBlock[]): Promise<TokenPrediction> {
    // 1. 分析历史趋势
    const trend = this.analyzeUsageTrend();
    
    // 2. 预测 upcoming calls 的 token 使用
    const upcomingTokens = this.predictUpcomingUsage(upcomingCalls, trend);
    
    // 3. 计算总使用量
    const currentUsage = this.getCurrentUsage();
    const projectedUsage = currentUsage + upcomingTokens;
    
    // 4. 评估风险
    const riskLevel = this.assessRisk(projectedUsage);
    
    // 5. 生成建议
    const suggestedActions = this.generateSuggestions(riskLevel, upcomingCalls);
    
    return {
      currentUsage,
      projectedUsage,
      riskLevel,
      suggestedActions,
      confidence: this.calculateConfidence(trend),
    };
  }
  
  private async applyPredictiveActions(actions: string[]): Promise<Message[]> {
    const results: Message[] = [];
    
    for (const action of actions) {
      switch (action) {
        case 'apply_aggressive_compression':
          results.push(await this.applyAggressiveCompression());
          break;
        case 'reduce_history_depth':
          results.push(await this.reduceHistoryDepth());
          break;
        case 'defer_non_critical_tools':
          results.push(await this.deferNonCriticalTools());
          break;
      }
    }
    
    return results;
  }
}
```

---

## 🚀 实施路线图

### Phase 1: 基础优化（Week 1-3）

| 任务 | 工期 | 优先级 | 实施位置 |
|------|------|--------|----------|
| Read 工具智能截断 | 4天 | P0 | FileReadTool |
| Bash 输出流式处理 | 5天 | P0 | BashTool |
| Git 命令压缩 | 3天 | P0 | gitOperations |
| 文件缓存机制 | 4天 | P1 | smartCache |

### Phase 2: 中级优化（Week 4-7）

| 任务 | 工期 | 优先级 | 实施位置 |
|------|------|--------|----------|
| 工具结果去重 | 5天 | P1 | toolOrchestration |
| 目录结构缓存 | 4天 | P1 | directoryCache |
| 上下文智能分区 | 6天 | P2 | contextOptimizer |
| 优先级内容保留 | 5天 | P2 | priorityFilter |

### Phase 3: 高级优化（Week 8-13）

| 任务 | 工期 | 优先级 | 实施位置 |
|------|------|--------|----------|
| 渐进式压缩 | 5天 | P2 | progressiveCompression |
| 模型特定优化 | 4天 | P3 | modelOptimization |
| 用户行为学习 | 6天 | P3 | userBehavior |
| 预测性压缩 | 7天 | P3 | predictiveOptimization |

---

## ⚙️ 配置系统

### 全局配置
```typescript
// src/services/tokenOptimization/config.ts
export interface TokenOptimizationConfig {
  // 启用开关
  enabled: boolean;
  debugMode: boolean;
  
  // 基础策略配置
  readTruncation: {
    enabled: boolean;
    maxSize: number;
    priority: {
      config: 'keep_all' | 'keep_signatures' | 'summary_only';
      test: 'keep_all' | 'keep_signatures' | 'summary_only';
      source: 'keep_all' | 'keep_signatures' | 'summary_only';
      docs: 'keep_all' | 'keep_signatures' | 'summary_only';
    };
  };
  
  bashStreaming: {
    enabled: boolean;
    maxLines: number;
    maxTokens: number;
    teeMode: 'failures' | 'always' | 'never';
  };
  
  // 高级策略配置
  deduplication: {
    enabled: boolean;
    threshold: number;
    historySize: number;
  };
  
  userBehavior: {
    enabled: boolean;
    learningRate: number;
    maxHistory: number;
  };
  
  // 监控配置
  monitoring: {
    enabled: boolean;
    metricsInterval: number;
    saveHistory: boolean;
  };
}
```

### 用户个性化配置
```json
{
  "compressionLevel": "balanced",
  "prioritizeTests": true,
  "alwaysShowDiff": false,
  "fileTypes": {
    "*.ts": "keep_signatures",
    "*.js": "keep_signatures",
    "*.md": "summary_only",
    "*.json": "keep_all"
  },
  "commands": {
    "git status": "compact",
    "git diff": "show_changes",
    "ls": "head_tail"
  }
}
```

---

## 📊 监控与报告

### 实时指标
```typescript
interface OptimizationMetrics {
  // 总体指标
  totalSaved: number;
  totalProcessed: number;
  savingsPercentage: number;
  
  // 按策略统计
  byStrategy: {
    readTruncation: { calls: number; saved: number; avgReduction: number };
    bashStreaming: { calls: number; saved: number; avgReduction: number };
    gitCompression: { calls: number; saved: number; avgReduction: number };
    deduplication: { calls: number; saved: number; avgReduction: number };
  };
  
  // 按文件类型统计
  byFileType: Record<string, { processed: number; saved: number }>;
  
  // 用户行为
  userStats: {
    mostUsedCommands: string[];
    avgCompressionSensitivity: number;
    preferredStrategies: string[];
  };
}
```

### 报告生成
```typescript
class OptimizationReporter {
  generateDailyReport(): Report {
    return {
      date: new Date().toISOString(),
      metrics: this.collectMetrics(),
      insights: this.generateInsights(),
      recommendations: this.generateRecommendations(),
    };
  }
  
  private generateInsights(): Insight[] {
    const insights: Insight[] = [];
    
    // 分析节省最多的策略
    const bestStrategy = this.findBestPerformingStrategy();
    insights.push({
      type: 'strategy_effectiveness',
      message: `Best performing strategy: ${bestStrategy.name} with ${bestStrategy.savingsRate}% savings`,
    });
    
    // 分析用户模式
    const userPattern = this.analyzeUserPattern();
    insights.push({
      type: 'user_behavior',
      message: `User prefers ${userPattern.preferredStrategy} for ${userPattern.toolType} tools`,
    });
    
    return insights;
  }
}
```

---

## 🔧 技术实现细节

### 性能考虑
1. **缓存策略**：使用 LRU 缓存，避免内存泄漏
2. **异步处理**：所有优化策略都采用非阻塞设计
3. **并行处理**：多个工具的压缩可以并行执行
4. **懒加载**：只在需要时加载优化策略

### 错误处理
```typescript
class OptimizationError extends Error {
  constructor(strategy: string, reason: string) {
    super(`Optimization failed for ${strategy}: ${reason}`);
    this.name = 'OptimizationError';
  }
}

// 降级策略
class FallbackHandler {
  async handleFailure(strategy: string, input: any): Promise<any> {
    try {
      // 尝试备选策略
      return await this.alternativeStrategy(input);
    } catch (error) {
      // 最终降级到原始输出
      return this.rawOutput(input);
    }
  }
}
```

### 测试策略
```typescript
describe('Token Optimization', () => {
  describe('Read Tool Truncation', () => {
    it('should truncate large files', async () => {
      const largeContent = 'x'.repeat(10000);
      const result = await fileReadTool.call({ file: 'large.ts' });
      
      expect(result.content.length).toBeLessThan(2000);
      expect(result.content).toContain('[... truncated]');
    });
    
    it('should preserve critical sections', async () => {
      const configContent = `
        // Important config
        export const config = {
          key: 'value',
          timeout: 5000
        };
      `;
      
      const result = await fileReadTool.call({ file: 'config.ts' });
      expect(result.content).toContain('export const config');
    });
  });
});
```

---

## 🎯 成功标准

### 量化指标
- **Token 节省率**: 40-60% 的平均节省
- **性能影响**: 每个工具增加延迟 < 100ms
- **内存使用**: 缓存占用 < 100MB
- **错误率**: 优化失败率 < 0.1%

### 质量指标
- **信息保留率**: 关键信息保留率 > 95%
- **用户体验**: 无感知的优化过程
- **兼容性**: 与现有功能 100% 兼容

---

## 📝 总结

这个三层混合架构的 token 优化方案提供了：

1. **及时性**: 在工具执行时立即优化，不等待 compact
2. **全面性**: 覆盖所有关键的工具和场景
3. **智能性**: 基于用户行为和上下文动态调整
4. **可控性**: 用户可以精细控制优化行为

通过 12 项具体策略的实施，预计可以实现 40-60% 的 token 节省，同时保持系统的稳定性和性能。

---

*方案版本: 1.0*  
*创建日期: 2026-05-26*  
*基于 rtk-ai/rtk v0.28.2 分析*