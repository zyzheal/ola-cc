// src/commands/goal/taskOrchestrator/config.ts

// 并行策略配置
export const MAX_SIMPLE_PARALLEL = 5;
export const MAX_MEDIUM_PARALLEL = 3;
export const DEFAULT_MAX_PARALLEL = 3;

// 超时配置
export const TASK_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟
export const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

// 重试配置
export const DEFAULT_RETRY_COUNT = 1;

// 复杂度阈值
export const COMPLEXITY_THRESHOLDS = {
  simple: { maxTokens: 1000, maxTools: 2 },
  medium: { maxTokens: 5000, maxTools: 5 },
  complex: { maxTokens: 10000, maxTools: 10 }, // 超过 medium 即为 complex
};

export interface OrchestratorConfig {
  maxParallel: number;
  strategy: 'all' | 'smart' | 'auto';
  timeoutMs: number;
  retryCount: number;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  maxParallel: DEFAULT_MAX_PARALLEL,
  strategy: 'smart',
  timeoutMs: TASK_TIMEOUT_MS,
  retryCount: DEFAULT_RETRY_COUNT,
};