/**
 * Token Optimization Service
 *
 * 基于 rtk-ai/rtk 项目的优化策略，为 ola-cc 提供多层级的 token 优化
 *
 * 架构层次：
 * 1. Tool Level - 工具执行时立即优化
 * 2. Orchestration Level - 多工具结果协调优化
 * 3. Optimization Level - 高级优化策略
 */

// =============================================
// 主优化控制器
// =============================================
export { TokenOptimizer } from './TokenOptimizer';
export { PerformanceMonitor } from './PerformanceMonitor';

// =============================================
// Tool Level 优化 (工具级)
// =============================================
export { SmartReadTruncator } from './SmartReadTruncator';
export { BashStreamingProcessor } from './BashStreamingProcessor';
export { GitCompressor } from './GitCompressor';
export { DirectoryCache } from './DirectoryCache';

// =============================================
// Orchestration Level 优化 (协调级)
// =============================================
export { ResultDeduplicator } from './ResultDeduplicator';
export { SmartCache } from './SmartCache';
export { ContextOptimizer } from './ContextOptimizer';
export { PriorityFilter } from './PriorityFilter';

// =============================================
// Advanced Level 优化 (高级级)
// =============================================
export { ProgressiveCompressor } from './ProgressiveCompressor';
export { ModelOptimizer } from './ModelOptimizer';
export { UserBehaviorLearner } from './UserBehaviorLearner';
export { PredictiveOptimizer } from './PredictiveOptimizer';

// =============================================
// 配置类型
// =============================================
export type { TokenOptimizationConfig } from './types';
export type { CompressionLevel, Priority, RiskLevel } from './types';

// =============================================
// 工具和常量
// =============================================
export { OPTIMIZATION_STRATEGIES, DEFAULT_CONFIG } from './constants';
export { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, CACHE_UTILS, PERFORMANCE_UTILS, DEBUG_UTILS } from './utils';
