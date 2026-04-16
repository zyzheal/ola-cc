/**
 * 请求跟踪器
 * 
 * 管理带 requestId 的请求/响应模式
 * 支持超时、取消和清理
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger';
import { TIMEOUTS, MAX_PENDING_REQUESTS } from '../constants/timeouts';

/** 待处理请求 */
interface PendingRequest {
  /** 解析函数 */
  resolve: (value: unknown) => void;
  
  /** 拒绝函数 */
  reject: (reason?: Error) => void;
  
  /** 超时定时器 ID */
  timeoutId: NodeJS.Timeout;
  
  /** 请求创建时间 */
  createdAt: number;
  
  /** 请求类型 */
  type: string;
  
  /** 请求负载 */
  payload?: unknown;
}

/** 请求跟踪器配置 */
export interface RequestTrackerConfig {
  /** 默认超时时间（毫秒） */
  defaultTimeout?: number;
  
  /** 最大待处理请求数 */
  maxPending?: number;
  
  /** 日志器 */
  logger?: Logger;
}

/** 请求跟踪器 */
export class RequestTracker {
  private pendingRequests = new Map<string, PendingRequest>();
  private config: Required<RequestTrackerConfig>;
  
  constructor(config?: RequestTrackerConfig) {
    this.config = {
      defaultTimeout: config?.defaultTimeout || TIMEOUTS.DEFAULT_REQUEST,
      maxPending: config?.maxPending || MAX_PENDING_REQUESTS,
      logger: config?.logger || new Logger({ prefix: '[RequestTracker]' }),
    };
  }
  
  /** 获取待处理请求数 */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }
  
  /** 创建新请求 */
  createRequest(
    type: string,
    payload?: unknown,
    timeoutMs?: number,
  ): { requestId: string; promise: Promise<unknown> } {
    // 检查是否超过最大待处理请求数
    if (this.pendingRequests.size >= this.config.maxPending) {
      throw new Error(
        `Too many pending requests (${this.pendingRequests.size}), maximum is ${this.config.maxPending}`
      );
    }
    
    const requestId = uuidv4();
    const timeout = timeoutMs ?? this.config.defaultTimeout;
    
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeRequest(requestId);
        reject(new Error(`Request timed out after ${timeout}ms: ${type}`));
      }, timeout);
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        createdAt: Date.now(),
        type,
        payload,
      });
      
      this.config.logger.debug(
        `Request created: ${requestId} (${type}), timeout: ${timeout}ms`
      );
    });
    
    return { requestId, promise };
  }
  
  /** 处理响应 */
  resolveResponse(responseToRequestId: string, payload: unknown): boolean {
    const pending = this.pendingRequests.get(responseToRequestId);
    if (!pending) {
      this.config.logger.warn(
        `Received response for unknown request: ${responseToRequestId}`
      );
      return false;
    }
    
    this.removeRequest(responseToRequestId);
    pending.resolve(payload);
    
    this.config.logger.debug(
      `Request resolved: ${responseToRequestId}`
    );
    
    return true;
  }
  
  /** 处理错误响应 */
  rejectResponse(responseToRequestId: string, error: Error | string): boolean {
    const pending = this.pendingRequests.get(responseToRequestId);
    if (!pending) {
      this.config.logger.warn(
        `Received error response for unknown request: ${responseToRequestId}`
      );
      return false;
    }
    
    this.removeRequest(responseToRequestId);
    
    const err = error instanceof Error ? error : new Error(error);
    pending.reject(err);
    
    this.config.logger.debug(
      `Request rejected: ${responseToRequestId}, error: ${err.message}`
    );
    
    return true;
  }
  
  /** 取消请求 */
  cancelRequest(requestId: string, reason?: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    
    this.removeRequest(requestId);
    pending.reject(new Error(reason || 'Request cancelled'));
    
    this.config.logger.debug(
      `Request cancelled: ${requestId}, reason: ${reason || 'unknown'}`
    );
    
    return true;
  }
  
  /** 移除请求（内部方法） */
  private removeRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(requestId);
    }
  }
  
  /** 清理所有待处理请求 */
  cleanup(reason?: string): void {
    const count = this.pendingRequests.size;
    
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason || 'Request tracker cleaned up'));
    }
    
    this.pendingRequests.clear();
    
    this.config.logger.info(
      `Cleaned up ${count} pending requests, reason: ${reason || 'unknown'}`
    );
  }
  
  /** 获取待处理请求状态（用于调试） */
  getPendingRequestsInfo(): Array<{
    requestId: string;
    type: string;
    age: number;
    payload?: unknown;
  }> {
    const now = Date.now();
    return Array.from(this.pendingRequests.entries()).map(([id, req]) => ({
      requestId: id,
      type: req.type,
      age: now - req.createdAt,
      payload: req.payload,
    }));
  }
}
