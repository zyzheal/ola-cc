/**
 * Token Optimization Constants
 *
 * 定义了所有优化策略的默认配置和常量
 */

import type { TokenOptimizationConfig } from './types';

// 默认配置
export const DEFAULT_CONFIG: TokenOptimizationConfig = {
  enabled: true,
  debugMode: false,

  readTruncation: {
    enabled: true,
    maxSize: 2000,
    priority: {
      config: 'keep_all',
      test: 'keep_signatures',
      source: 'keep_signatures',
      docs: 'summary_only',
    },
  },

  bashStreaming: {
    enabled: true,
    maxLines: 1000,
    maxTokens: 8000,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    immediateTruncate: true,
    teeMode: 'failures',
  },

  gitCompression: {
    enabled: true,
    status: 'compact',
    diff: 'summary',
    log: 'oneline',
    commit: 'hash-only',
  },

  deduplication: {
    enabled: true,
    threshold: 0.8,
    historySize: 100,
    timeWindow: 5 * 60 * 1000, // 5分钟
  },

  smartCache: {
    enabled: true,
    maxSize: 50 * 1024 * 1024, // 50MB
    defaultTTL: 5 * 60 * 1000, // 5分钟
    maxEntries: 1000,
    compressionEnabled: true,
    evictionPolicy: 'lru',
    adaptiveTTL: true,
    priorityBased: true,
    cleanupInterval: 60 * 1000, // 1分钟
  },

  directoryCache: {
    enabled: true,
    maxSize: 100 * 1024 * 1024, // 100MB
    ttl: 5 * 60 * 1000, // 5分钟
    maxDepth: 3,
    includeHidden: false,
  },

  contextOptimization: {
    enabled: true,
    systemPrompt: 2000,
    toolsSchema: 3000,
    minConversationSpace: 30,
    maxConversationSpace: 30,
    maxAttachments: 20,
    maxMemories: 10,
    maxUtilizationRate: 0.8,
    maxHistory: 50,
    maxHistorySize: 1000,
  },

  priorityFilter: {
    enabled: true,
    criticalPriority: 'CRITICAL',
    highPriority: 'HIGH',
    mediumPriority: 'MEDIUM',
    lowPriority: 'LOW',
    criticalThreshold: 3,
  },

  progressiveCompression: {
    enabled: true,
    levels: ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY'],
    riskThresholds: {
      low: 0.6,
      medium: 0.8,
      high: 0.9,
      critical: 0.95,
    },
    targetRatio: 0.7,
    maxRatio: 0.95,
    maxHistorySize: 500,
  },

  modelOptimization: {
    enabled: true,
    modelConfigs: {
      claude: {
        contextWindow: 200000,
        promptCache: true,
        compressionRatio: 0.6,
        preferredStrategies: ['balanced_compression', 'context_partition'],
      },
      opus: {
        contextWindow: 200000,
        promptCache: true,
        compressionRatio: 0.7,
        preferredStrategies: ['light_compression', 'priority_filter'],
      },
      sonnet: {
        contextWindow: 200000,
        promptCache: true,
        compressionRatio: 0.65,
        preferredStrategies: ['adaptive_compression', 'smart_truncation'],
      },
      haiku: {
        contextWindow: 32000,
        promptCache: false,
        compressionRatio: 0.8,
        preferredStrategies: ['aggressive_compression', 'summary_only'],
      },
    },
  },

  userBehavior: {
    enabled: true,
    learningRate: 0.1,
    maxHistory: 1000,
    sensitivityThreshold: 0.3,
    prioritizeTests: true,
    alwaysShowDiff: false,
  },

  predictiveOptimization: {
    enabled: true,
    predictionWindow: 5,
    confidenceThreshold: 0.8,
    maxHistory: 100,
    riskThresholds: {
      low: 0.5,
      medium: 0.7,
      high: 0.9,
      critical: 0.95,
    },
  },

  monitoring: {
    enabled: true,
    metricsInterval: 60 * 1000, // 1分钟
    saveHistory: true,
    maxHistorySize: 1000,
    reportInterval: 24 * 60 * 60 * 1000, // 24小时
  },
};

// 优化策略列表
export const OPTIMIZATION_STRATEGIES = [
  'read_truncation',
  'bash_streaming',
  'git_compression',
  'smart_cache',
  'result_deduplication',
  'directory_cache',
  'context_optimization',
  'priority_filter',
  'progressive_compression',
  'model_optimization',
  'user_behavior_learning',
  'predictive_optimization',
] as const;

// 文件类型正则
export const FILE_TYPE_PATTERNS = {
  config: /\.(json|yaml|yml|toml|ini|conf|config)$/,
  test: /\.(test\.spec\.[tj]s|test\.ts|test\.js|spec\.[tj]s|test\.md)$/,
  source: /\.(ts|tsx|js|jsx|rs|go|py|java|cpp|c|h)$/,
  docs: /\.(md|txt|rst|doc|docx)$/,
  types: /\.(d\.ts)$/,
} as const;

// Git 命令正则
export const GIT_COMMAND_PATTERNS = {
  status: /^git\s+status/,
  diff: /^git\s+diff/,
  log: /^git\s+log/,
  add: /^git\s+add/,
  commit: /^git\s+commit/,
  push: /^git\s+push/,
  pull: /^git\s+pull/,
} as const;

// 特殊文件模式
export const SPECIAL_PATTERNS = {
  largeFile: /^node_modules\/|\.log$|\.tmp$/,
  sensitive: /password|secret|key|token/i,
  binary: /\.(bin|exe|dll|so|dylib)$/,
} as const;

// 压缩级别配置
export const COMPRESSION_LEVELS = {
  NONE: {
    ratio: 0,
    maxRetries: 0,
    fallback: 'original',
  },
  LIGHT: {
    ratio: 0.5,
    maxRetries: 1,
    fallback: 'original',
  },
  MEDIUM: {
    ratio: 0.7,
    maxRetries: 2,
    fallback: 'light',
  },
  HEAVY: {
    ratio: 0.9,
    maxRetries: 3,
    fallback: 'medium',
  },
} as const;

// Token 估计系数
export const TOKEN_ESTIMATION = {
  avgTokensPerLine: 10,
  avgTokensPerWord: 1.3,
  overheadPerTool: 100, // 工具调用开销
  overheadPerAttachment: 50, // 附件开销
} as const;

// 性能阈值
export const PERFORMANCE_THRESHOLDS = {
  maxProcessingTime: 100, // ms
  maxMemoryUsage: 100 * 1024 * 1024, // 100MB
  maxCacheSize: 500 * 1024 * 1024, // 500MB
  maxConcurrentOps: 10,
} as const;