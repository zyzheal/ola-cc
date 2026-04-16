/**
 * 心跳机制
 * 
 * 定期发送心跳消息检测连接健康状态
 * 支持超时检测和自动重连触发
 */

import { Logger } from '../utils/logger';
import { TIMEOUTS } from '../constants/timeouts';

/** 心跳状态 */
export interface HeartbeatState {
  /** 最后发送心跳的时间 */
  lastSentTime: number;
  
  /** 最后接收响应的时间 */
  lastReceivedTime: number;
  
  /** 是否等待 pong 响应 */
  pendingPong: boolean;
  
  /** 心跳定时器 ID */
  intervalId: NodeJS.Timeout | null;
  
  /** 连续失败次数 */
  consecutiveFailures: number;
}

/** 心跳配置 */
export interface HeartbeatConfig {
  /** 心跳间隔（毫秒） */
  interval?: number;
  
  /** 心跳超时（毫秒） */
  timeout?: number;
  
  /** 最大连续失败次数 */
  maxFailures?: number;
  
  /** 日志器 */
  logger?: Logger;
}

/** 心跳回调 */
export type HeartbeatCallback = {
  /** 发送心跳 Ping */
  onSendPing: () => void;
  
  /** 连接超时（需要重连） */
  onTimeout: () => void;
  
  /** 连接恢复 */
  onRecover?: () => void;
};

/** 心跳管理器 */
export class HeartbeatManager {
  private state: HeartbeatState;
  private config: Required<HeartbeatConfig>;
  private callbacks: HeartbeatCallback | null = null;
  
  constructor(config?: HeartbeatConfig) {
    this.config = {
      interval: config?.interval || TIMEOUTS.HEARTBEAT_INTERVAL,
      timeout: config?.timeout || TIMEOUTS.HEARTBEAT_TIMEOUT,
      maxFailures: config?.maxFailures || 3,
      logger: config?.logger || new Logger({ prefix: '[Heartbeat]' }),
    };
    
    this.state = {
      lastSentTime: 0,
      lastReceivedTime: Date.now(),
      pendingPong: false,
      intervalId: null,
      consecutiveFailures: 0,
    };
  }
  
  /** 启动心跳 */
  start(callbacks: HeartbeatCallback): void {
    if (this.state.intervalId) {
      this.config.logger.warn('Heartbeat already running, ignoring start call');
      return;
    }
    
    this.callbacks = callbacks;
    
    this.state.intervalId = setInterval(() => {
      this.tick();
    }, this.config.interval);
    
    this.config.logger.info(
      `Heartbeat started, interval: ${this.config.interval}ms, timeout: ${this.config.timeout}ms`
    );
  }
  
  /** 停止心跳 */
  stop(): void {
    if (this.state.intervalId) {
      clearInterval(this.state.intervalId);
      this.state.intervalId = null;
    }
    
    this.callbacks = null;
    this.state.pendingPong = false;
    this.state.consecutiveFailures = 0;
    
    this.config.logger.info('Heartbeat stopped');
  }
  /** 心跳滴答（内部方法） */
  private tick(): void {
    const now = Date.now();
    const timeSinceLastReceived = now - this.state.lastReceivedTime;
    
    // 检查是否超时
    if (timeSinceLastReceived > this.config.interval + this.config.timeout) {
      this.state.consecutiveFailures++;
      
      this.config.logger.warn(
        `Heartbeat timeout (${this.state.consecutiveFailures}/${this.config.maxFailures}), ` +
        `last received: ${Math.round(timeSinceLastReceived / 1000)}s ago`
      );
      
      if (this.state.consecutiveFailures >= this.config.maxFailures) {
        this.config.logger.error('Heartbeat max failures reached, triggering timeout callback');
        this.callbacks?.onTimeout();
      }
      
      return;
    }
    
    // 发送心跳 Ping
    if (!this.state.pendingPong) {
      this.state.lastSentTime = now;
      this.state.pendingPong = true;
      this.callbacks?.onSendPing();
      
      this.config.logger.debug('Heartbeat ping sent');
    }
  }
  
  /** 收到心跳响应（Pong） */
  onPongReceived(): void {
    this.state.lastReceivedTime = Date.now();
    this.state.pendingPong = false;
    
    if (this.state.consecutiveFailures > 0) {
      this.config.logger.info(
        `Heartbeat recovered after ${this.state.consecutiveFailures} failures`
      );
      this.state.consecutiveFailures = 0;
      this.callbacks?.onRecover?.();
    }
  }
  
  /** 收到任何消息（更新最后接收时间） */
  onMessageReceived(): void {
    this.state.lastReceivedTime = Date.now();
  }
  
  /** 获取心跳状态 */
  getState(): HeartbeatState {
    return { ...this.state };
  }
  
  /** 获取连接健康状态 */
  isHealthy(): boolean {
    const now = Date.now();
    const timeSinceLastReceived = now - this.state.lastReceivedTime;
    return timeSinceLastReceived < this.config.interval + this.config.timeout;
  }
  
  /** 获取最后接收时间距今（秒） */
  getTimeSinceLastReceived(): number {
    return Math.round((Date.now() - this.state.lastReceivedTime) / 1000);
  }
}
