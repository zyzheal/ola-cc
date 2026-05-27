/**
 * Token Optimization Types
 *
 * 定义了所有优化策略相关的类型和接口
 */

export interface TokenOptimizationConfig {
  // 全局配置
  enabled: boolean;
  debugMode: boolean;

  // 基础策略配置
  readTruncation: ReadTruncationConfig;
  bashStreaming: BashStreamingConfig;
  gitCompression: GitCompressionConfig;

  // 中级策略配置
  deduplication: DeduplicationConfig;
  smartCache: SmartCacheConfig;
  directoryCache: DirectoryCacheConfig;
  contextOptimization: ContextOptimizationConfig;
  priorityFilter: PriorityFilterConfig;

  // 高级策略配置
  progressiveCompression: ProgressiveCompressionConfig;
  modelOptimization: ModelOptimizationConfig;
  userBehavior: UserBehaviorConfig;
  predictiveOptimization: PredictiveOptimizationConfig;

  // 监控配置
  monitoring: MonitoringConfig;
}

// Read 工具截断配置
export interface ReadTruncationConfig {
  enabled: boolean;
  maxSize: number; // 2000 tokens
  priority: {
    config: TruncationStrategy;
    test: TruncationStrategy;
    source: TruncationStrategy;
    docs: TruncationStrategy;
  };
}

export type TruncationStrategy =
  | 'keep_all'
  | 'keep_signatures'
  | 'summary_only'
  | 'head_tail';

// Bash 流式处理配置
export interface BashStreamingConfig {
  enabled: boolean;
  maxLines: number; // 1000
  maxTokens: number; // 8000
  maxFileSize: number; // 10MB
  immediateTruncate: boolean;
  teeMode: 'failures' | 'always' | 'never';
}

// Git 压缩配置
export interface GitCompressionConfig {
  enabled: boolean;
  status: 'compact' | 'minimal' | 'full';
  diff: 'unified' | 'stat' | 'summary';
  log: 'short' | 'oneline' | 'hash-only';
  commit: 'hash-only' | 'summary' | 'full';
}

// 去重配置
export interface DeduplicationConfig {
  enabled: boolean;
  threshold: number; // 0.8
  historySize: number; // 100
  timeWindow: number; // 300000 // 5分钟
}

// 目录缓存配置
export interface DirectoryCacheConfig {
  enabled: boolean;
  maxSize: number; // 100MB
  ttl: number; // 300000 // 5分钟
  maxDepth: number; // 3
  includeHidden: boolean;
}

// 上下文优化配置
export interface ContextOptimizationConfig {
  enabled: boolean;
  systemPrompt: number; // 2000
  toolsSchema: number; // 3000
  minConversationSpace: number; // 30%
  maxConversationSpace: number; // 保留的最小空间百分比
  maxAttachments: number; // 20%
  maxMemories: number; // 10%
  maxUtilizationRate: number;
  maxHistory: number;
  maxHistorySize: number;
  model?: string;
}

// 优先级过滤器配置
export interface PriorityFilterConfig {
  enabled: boolean;
  criticalPriority: Priority;
  highPriority: Priority;
  mediumPriority: Priority;
  lowPriority: Priority;
  criticalThreshold: number;
}

// 渐进式压缩配置
export interface ProgressiveCompressionConfig {
  enabled: boolean;
  levels: CompressionLevel[];
  riskThresholds: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  targetRatio: number;
  maxRatio: number;
  maxHistorySize: number;
}

// 模型优化配置
export interface ModelOptimizationConfig {
  enabled: boolean;
  modelConfigs: Record<string, ModelSpecificConfig>;
}

export interface ModelSpecificConfig {
  contextWindow: number;
  promptCache: boolean;
  compressionRatio: number;
  preferredStrategies: string[];
}

// 用户行为配置
export interface UserBehaviorConfig {
  enabled: boolean;
  learningRate: number; // 0.1
  maxHistory: number; // 1000
  sensitivityThreshold: number; // 0.3
  prioritizeTests: boolean;
  alwaysShowDiff: boolean;
}

// 预测性优化配置
export interface PredictiveOptimizationConfig {
  enabled: boolean;
  predictionWindow: number; // 5
  confidenceThreshold: number; // 0.8
  maxHistory: number; // 100
  riskThresholds: RiskThresholds;
}

// 智能缓存配置
export interface SmartCacheConfig {
  enabled: boolean;
  maxSize: number;
  defaultTTL: number;
  maxEntries: number;
  compressionEnabled: boolean;
  evictionPolicy: 'lru' | 'lfu' | 'random';
  adaptiveTTL: boolean;
  priorityBased: boolean;
  cleanupInterval: number;
}

// 监控配置
export interface MonitoringConfig {
  enabled: boolean;
  metricsInterval: number; // 60000 // 1分钟
  saveHistory: boolean;
  maxHistorySize: number; // 1000
  reportInterval: number; // 86400000 // 24小时
}

// 优化策略列表
export type OptimizationStrategy =
  | 'read_truncation'
  | 'bash_streaming'
  | 'git_compression'
  | 'directory_cache'
  | 'result_deduplication'
  | 'smart_cache'
  | 'context_optimization'
  | 'priority_filter'
  | 'progressive_compression'
  | 'model_optimization'
  | 'user_behavior_learning'
  | 'predictive_optimization';

// 模型类型
export type ModelType =
  | 'claude-3-opus'
  | 'claude-3-sonnet'
  | 'claude-3-haiku'
  | 'gpt-4'
  | 'gpt-3.5'
  | 'llama'
  | 'mistral';

// 优化工具配置
export interface ToolWithPriority {
  name: string;
  description: string;
  priority: Priority;
  estimatedTokens: number;
  urgency?: 'immediate' | 'high' | 'medium' | 'low';
  dependencies?: string[];
}

// 优化后的模型配置
export interface OptimizedModelConfig {
  modelType: string;
  compressionRatio: number;
  batchSize: number;
  cacheEnabled: boolean;
  strategies: string[];
  contextWindow: number;
  maxTokens: number;
  preferredStrategies: string[];
}

// 行为模式
export interface BehaviorPattern {
  type: string;
  description: string;
  confidence: number;
  parameters: Record<string, any>;
  action: string;
}

// 优化偏好
export interface OptimizationPreference {
  name: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  parameters: Record<string, any>;
}

// 预测
export interface Prediction {
  id: string;
  type: string;
  value: number | Record<string, any>;
  confidence: number;
  timeframe: string;
  factors: Array<{
    name: string;
    impact: string;
    weight: number;
    value: number;
  }>;
  riskLevel?: RiskLevel;
}

// 优化行动
export interface OptimizationAction {
  id: string;
  type: string;
  description: string;
  priority: number;
  parameters: Record<string, any>;
  expectedImpact: Record<string, number>;
  risk: RiskLevel;
  status: 'pending' | 'active' | 'failed' | 'completed';
  createdAt: number;
}

// 类型定义
export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CompressionLevel = 'NONE' | 'LIGHT' | 'MEDIUM' | 'HEAVY';

export interface RiskThresholds {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

// 工具和消息类型扩展
export interface ToolResultOptimization {
  originalContent: string;
  optimizedContent: string;
  savings: number;
  strategy: string;
  confidence: number;
}

export interface OptimizationMetrics {
  timestamp: number;
  originalTokens: number;
  optimizedTokens: number;
  savings: number;
  savingsPercentage: number;
  strategiesUsed: string[];
  processingTime: number;
}

export interface CacheEntry<T = any> {
  key: string;
  value: T;
  timestamp: number;
  accessCount: number;
  size: number;
}

export interface UserBehaviorModel {
  frequentCommands: Map<string, number>;
  preferredFileTypes: string[];
  compressionSensitivity: number;
  workingDirectory: string;
  lastActiveTime: number;
  sessionStart: number;
}

export interface TokenPrediction {
  currentUsage: number;
  projectedUsage: number;
  riskLevel: RiskLevel;
  suggestedActions: string[];
  confidence: number;
}