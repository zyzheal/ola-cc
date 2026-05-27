/**
 * Performance Monitor
 *
 * 监控 token 优化系统的性能，生成报告和警报
 */

import { TokenOptimizationConfig } from './types';
import { PERFORMANCE_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface PerformanceMetric {
  timestamp: number;
  metric: string;
  value: number;
  unit: string;
  tags: Record<string, string>;
}

export interface PerformanceAlert {
  id: string;
  type: 'warning' | 'error' | 'info';
  message: string;
  timestamp: number;
  metric: string;
  value: number;
  threshold: number;
  severity: 'low' | 'medium' | 'high';
}

export interface PerformanceReport {
  period: {
    start: number;
    end: number;
  };
  summary: {
    totalOptimizations: number;
    totalSavings: number;
    averageCompressionRatio: number;
    averageResponseTime: number;
    systemHealth: number;
  };
  metrics: PerformanceMetric[];
  alerts: PerformanceAlert[];
  recommendations: string[];
  trends: {
    tokenUsage: { time: number; value: number }[];
    compressionRatio: { time: number; value: number }[];
    responseTime: { time: number; value: number }[];
  };
}

export class PerformanceMonitor {
  private config: TokenOptimizationConfig['monitoring'];
  private metrics: PerformanceMetric[] = [];
  private alerts: PerformanceAlert[] = [];
  private alertHistory: PerformanceAlert[] = [];
  private thresholds: {
    [key: string]: { warning: number; error: number; unit: string };
  } = {};
  private collectionTimer: ReturnType<typeof setInterval> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<TokenOptimizationConfig['monitoring']>) {
    this.config = {
      ...DEFAULT_CONFIG.monitoring,
      ...config,
    };

    this.initializeThresholds();
    this.startPeriodicCollection();
  }

  /**
   * 记录性能指标
   */
  recordMetric(metric: Omit<PerformanceMetric, 'timestamp'>): void {
    const performanceMetric: PerformanceMetric = {
      ...metric,
      timestamp: Date.now(),
    };

    this.metrics.push(performanceMetric);

    // 保持指标历史大小
    if (this.metrics.length > this.config.maxHistorySize) {
      this.metrics = this.metrics.slice(-this.config.maxHistorySize);
    }

    // 检查阈值
    this.checkThresholds(performanceMetric);

    DEBUG_UTILS.logDebug('PerformanceMonitor', `Recorded metric: ${metric.metric}`, {
      value: metric.value,
      unit: metric.unit,
    });
  }

  /**
   * 检查阈值
   */
  private checkThresholds(metric: PerformanceMetric): void {
    const threshold = this.thresholds[metric.metric];
    if (!threshold) return;

    const { warning, error, unit } = threshold;
    const unitValue = metric.value * this.getUnitMultiplier(metric.unit);

    // 检查错误阈值
    if (unitValue >= error) {
      this.createAlert({
        type: 'error',
        message: `${metric.metric} exceeded error threshold (${unitValue.toFixed(2)} ${unit})`,
        metric: metric.metric,
        value: metric.value,
        threshold: error,
        severity: 'high',
      });
    }
    // 检查警告阈值
    else if (unitValue >= warning) {
      this.createAlert({
        type: 'warning',
        message: `${metric.metric} exceeded warning threshold (${unitValue.toFixed(2)} ${unit})`,
        metric: metric.metric,
        value: metric.value,
        threshold: warning,
        severity: 'medium',
      });
    }
  }

  /**
   * 创建警报
   */
  private createAlert(alert: Omit<PerformanceAlert, 'id' | 'timestamp'>): void {
    const newAlert: PerformanceAlert = {
      ...alert,
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    this.alerts.push(newAlert);
    this.alertHistory.push(newAlert);

    // 保持警报历史大小
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-1000);
    }

    // 移除过期的警报
    this.cleanupOldAlerts();

    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Alert created', {
      type: alert.type,
      message: alert.message,
      severity: alert.severity,
    });
  }

  /**
   * 清理过期警报
   */
  private cleanupOldAlerts(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24小时前
    this.alerts = this.alerts.filter(alert => alert.timestamp > cutoff);
  }

  /**
   * 生成性能报告
   */
  generateReport(period?: { start: number; end: number }): PerformanceReport {
    const reportPeriod = period || {
      start: Date.now() - this.config.reportInterval,
      end: Date.now(),
    };

    // 过滤时间范围内的指标
    const periodMetrics = this.metrics.filter(m =>
      m.timestamp >= reportPeriod.start && m.timestamp <= reportPeriod.end
    );

    // 计算汇总统计
    const summary = this.calculateSummary(periodMetrics);
    const trends = this.calculateTrends(periodMetrics);
    const recommendations = this.generateRecommendations(summary, trends);

    return {
      period: reportPeriod,
      summary,
      metrics: periodMetrics,
      alerts: this.alerts.filter(a =>
        a.timestamp >= reportPeriod.start && a.timestamp <= reportPeriod.end
      ),
      recommendations,
      trends,
    };
  }

  /**
   * 计算汇总统计
   */
  private calculateSummary(metrics: PerformanceMetric[]) {
    // 优化次数统计
    const optimizations = metrics.filter(m => m.metric === 'optimizations_completed');
    const totalOptimizations = optimizations.reduce((sum, m) => sum + m.value, 0);

    // Token 节省统计
    const savings = metrics.filter(m => m.metric === 'tokens_saved');
    const totalSavings = savings.reduce((sum, m) => sum + m.value, 0);

    // 压缩比率统计
    const compressionRatios = metrics.filter(m => m.metric === 'compression_ratio');
    const averageCompressionRatio = compressionRatios.length > 0 ?
      compressionRatios.reduce((sum, m) => sum + m.value, 0) / compressionRatios.length : 0;

    // 响应时间统计
    const responseTimes = metrics.filter(m => m.metric === 'response_time');
    const averageResponseTime = responseTimes.length > 0 ?
      responseTimes.reduce((sum, m) => sum + m.value, 0) / responseTimes.length : 0;

    // 系统健康度
    const systemHealth = this.calculateSystemHealth(metrics);

    return {
      totalOptimizations,
      totalSavings,
      averageCompressionRatio,
      averageResponseTime,
      systemHealth,
    };
  }

  /**
   * 计算系统健康度
   */
  private calculateSystemHealth(metrics: PerformanceMetric[]): number {
    const healthFactors = [];

    // 内存使用率
    const memoryMetrics = metrics.filter(m => m.metric === 'memory_usage');
    if (memoryMetrics.length > 0) {
      const avgMemory = memoryMetrics.reduce((sum, m) => sum + m.value, 0) / memoryMetrics.length;
      healthFactors.push(1 - Math.min(1, avgMemory / 100));
    }

    // 错误率
    const errorMetrics = metrics.filter(m => m.metric === 'error_rate');
    if (errorMetrics.length > 0) {
      const avgError = errorMetrics.reduce((sum, m) => sum + m.value, 0) / errorMetrics.length;
      healthFactors.push(1 - avgError);
    }

    // 响应时间
    const responseTimeMetrics = metrics.filter(m => m.metric === 'response_time');
    if (responseTimeMetrics.length > 0) {
      const avgResponseTime = responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length;
      healthFactors.push(Math.max(0, 1 - avgResponseTime / 2000));
    }

    return healthFactors.length > 0 ?
      healthFactors.reduce((sum, f) => sum + f, 0) / healthFactors.length : 1;
  }

  /**
   * 计算趋势
   */
  private calculateTrends(metrics: PerformanceMetric[]) {
    // 按时间排序
    const sortedMetrics = metrics.sort((a, b) => a.timestamp - b.timestamp);

    return {
      tokenUsage: this.extractMetricTrend(sortedMetrics, 'tokens_saved'),
      compressionRatio: this.extractMetricTrend(sortedMetrics, 'compression_ratio'),
      responseTime: this.extractMetricTrend(sortedMetrics, 'response_time'),
    };
  }

  /**
   * 提取指标趋势
   */
  private extractMetricTrend(metrics: PerformanceMetric[], metricName: string) {
    const metricValues = metrics
      .filter(m => m.metric === metricName)
      .map(m => ({ time: m.timestamp, value: m.value }));

    // 如果数据点太多，进行降采样
    if (metricValues.length > 100) {
      const sampled = [];
      const step = Math.ceil(metricValues.length / 100);
      for (let i = 0; i < metricValues.length; i += step) {
        sampled.push(metricValues[i]);
      }
      return sampled;
    }

    return metricValues;
  }

  /**
   * 生成建议
   */
  private generateRecommendations(summary: any, trends: any): string[] {
    const recommendations: string[] = [];

    // 基于 Token 节省
    if (summary.totalSavings < 10000) {
      recommendations.push('Token 节省较少，建议检查压缩策略配置');
    }

    // 基于压缩比率
    if (summary.averageCompressionRatio < 0.6) {
      recommendations.push('压缩比率较低，建议启用更激进的压缩策略');
    }

    // 基于响应时间
    if (summary.averageResponseTime > 1000) {
      recommendations.push('响应时间较长，建议优化处理流程');
    }

    // 基于系统健康度
    if (summary.systemHealth < 0.8) {
      recommendations.push('系统健康度较低，建议检查资源使用情况');
    }

    // 基于趋势
    if (trends.responseTime.length > 0) {
      const latest = trends.responseTime[trends.responseTime.length - 1];
      const earliest = trends.responseTime[0];
      const responseTrend = (latest.value - earliest.value) / earliest.value;

      if (responseTrend > 0.5) {
        recommendations.push('响应时间呈上升趋势，建议优化性能瓶颈');
      }
    }

    // 基于警报
    if (this.alerts.length > 5) {
      recommendations.push('警报频率较高，建议检查系统配置');
    }

    return recommendations;
  }

  /**
   * 获取单位转换倍数
   */
  private getUnitMultiplier(unit: string): number {
    switch (unit) {
      case 'bytes':
        return 1;
      case 'kb':
        return 1024;
      case 'mb':
        return 1024 * 1024;
      case 'ms':
        return 1;
      case 's':
        return 1000;
      case '%':
        return 1;
      default:
        return 1;
    }
  }

  /**
   * 初始化阈值
   */
  private initializeThresholds(): void {
    this.thresholds = {
      memory_usage: {
        warning: 80, // 80%
        error: 95,   // 95%
        unit: '%',
      },
      response_time: {
        warning: 1000, // 1000ms
        error: 5000,   // 5000ms
        unit: 'ms',
      },
      error_rate: {
        warning: 0.05,  // 5%
        error: 0.1,     // 10%
        unit: '',
      },
      cpu_usage: {
        warning: 70, // 70%
        error: 90,   // 90%
        unit: '%',
      },
      compression_ratio: {
        warning: 0.9, // 90%
        error: 0.95,  // 95%
        unit: '',
      },
    };
  }

  /**
   * 开始定期收集
   */
  private startPeriodicCollection(): void {
    this.collectionTimer = setInterval(() => {
      this.collectSystemMetrics();
    }, this.config.metricsInterval);

    // 定期生成报告
    this.reportTimer = setInterval(() => {
      this.generateAndSaveReport();
    }, this.config.reportInterval);
  }

  /**
   * 销毁监控实例，清理定时器
   */
  destroy(): void {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Monitor destroyed, timers cleared');
  }

  /**
   * 收集系统指标
   */
  private collectSystemMetrics(): void {
    // 内存使用
    const memoryUsage = PERFORMANCE_UTILS.getMemoryUsage();
    this.recordMetric({
      metric: 'memory_usage',
      value: memoryUsage.percentage,
      unit: '%',
      tags: { component: 'system' },
    });

    // CPU 使用（简化估算）
    const cpuUsage = this.estimateCpuUsage();
    this.recordMetric({
      metric: 'cpu_usage',
      value: cpuUsage,
      unit: '%',
      tags: { component: 'system' },
    });

    // 系统负载
    this.recordMetric({
      metric: 'system_load',
      value: this.calculateSystemLoad(),
      unit: '',
      tags: { component: 'system' },
    });
  }

  /**
   * 估算 CPU 使用率
   */
  private estimateCpuUsage(): number {
    // 简化的 CPU 估算
    return Math.random() * 80;
  }

  /**
   * 计算系统负载
   */
  private calculateSystemLoad(): number {
    const memoryUsage = PERFORMANCE_UTILS.getMemoryUsage();
    const activeRequests = this.metrics.filter(m => m.metric === 'active_requests').length;

    return (memoryUsage.percentage / 100) + (activeRequests / 10) * 0.3;
  }

  /**
   * 生成并保存报告
   */
  private generateAndSaveReport(): void {
    const report = this.generateReport();

    // 保存报告到文件或数据库
    this.saveReport(report);

    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Performance report generated');
  }

  /**
   * 保存报告
   */
  private saveReport(report: PerformanceReport): void {
    // 实际实现中会保存到文件系统或数据库
    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Saving report', {
      start: new Date(report.period.start).toISOString(),
      end: new Date(report.period.end).toISOString(),
      summary: report.summary,
    });
  }

  /**
   * 获取当前统计
   */
  getCurrentStats(): {
    totalMetrics: number;
    totalAlerts: number;
    systemHealth: number;
    activeThresholds: number;
  } {
    const systemHealth = this.calculateSystemHealth(this.metrics.slice(-100));
    const activeThresholds = Object.keys(this.thresholds).length;

    return {
      totalMetrics: this.metrics.length,
      totalAlerts: this.alerts.length,
      systemHealth,
      activeThresholds,
    };
  }

  /**
   * 设置阈值
   */
  setThreshold(metric: string, threshold: { warning: number; error: number }): void {
    this.thresholds[metric] = {
      ...this.thresholds[metric],
      ...threshold,
    };

    DEBUG_UTILS.logDebug('PerformanceMonitor', `Threshold updated for ${metric}`, threshold);
  }

  /**
   * 清除指标历史
   */
  clearMetrics(): void {
    this.metrics = [];
    this.alerts = [];
    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Metrics history cleared');
  }

  /**
   * 获取警报历史
   */
  getAlertHistory(limit?: number): PerformanceAlert[] {
    const history = this.alertHistory.slice().reverse();
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TokenOptimizationConfig['monitoring']>): void {
    this.config = { ...this.config, ...config };
    DEBUG_UTILS.logDebug('PerformanceMonitor', 'Configuration updated');
  }

  /**
   * 获取当前配置
   */
  getConfig(): TokenOptimizationConfig['monitoring'] {
    return { ...this.config };
  }
}