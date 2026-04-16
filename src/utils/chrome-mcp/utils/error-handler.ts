/**
 * 错误处理器
 * 
 * 提供统一的错误处理和错误码定义
 */

/** 错误码枚举 */
export enum ErrorCode {
  // 通用错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_MESSAGE_LENGTH = 'INVALID_MESSAGE_LENGTH',
  PARSE_ERROR = 'PARSE_ERROR',
  HANDLER_ERROR = 'HANDLER_ERROR',
  
  // 连接错误
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  SOCKET_ERROR = 'SOCKET_ERROR',
  TIMEOUT = 'TIMEOUT',
  
  // 工具错误
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  INVALID_PARAMETERS = 'INVALID_PARAMETERS',
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',
  
  // 请求错误
  REQUEST_FAILED = 'REQUEST_FAILED',
  REQUEST_CANCELLED = 'REQUEST_CANCELLED',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  
  // 服务器错误
  SERVER_START_ERROR = 'SERVER_START_ERROR',
  SERVER_STOP_ERROR = 'SERVER_STOP_ERROR',
  SERVER_ALREADY_RUNNING = 'SERVER_ALREADY_RUNNING',
  SERVER_NOT_RUNNING = 'SERVER_NOT_RUNNING',
  
  // Native Host 错误
  NATIVE_HOST_NOT_AVAILABLE = 'NATIVE_HOST_NOT_AVAILABLE',
  NATIVE_DISCONNECTED = 'NATIVE_DISCONNECTED',
  NATIVE_CONNECTION_FAILED = 'NATIVE_CONNECTION_FAILED',
  
  // 文件操作错误
  FILE_OPERATION_ERROR = 'FILE_OPERATION_ERROR',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_ACCESS_DENIED = 'FILE_ACCESS_DENIED',
  
  // 权限错误
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
}

/** 错误详情 */
export interface ErrorDetails {
  /** 错误码 */
  code: ErrorCode;
  
  /** 错误消息 */
  message: string;
  
  /** 原始错误（如果有） */
  cause?: Error;
  
  /** 额外上下文信息 */
  context?: Record<string, unknown>;
  
  /** 是否可重试 */
  retryable?: boolean;
  
  /** 错误发生时间 */
  timestamp?: number;
}

/** 标准化错误类 */
export class ChromeMcpError extends Error {
  /** 错误码 */
  public readonly code: ErrorCode;
  
  /** 错误详情 */
  public readonly details: ErrorDetails;
  
  constructor(details: ErrorDetails | string, cause?: Error) {
    const message = typeof details === 'string' ? details : details.message;
    super(message);
    
    this.name = 'ChromeMcpError';
    
    if (typeof details === 'string') {
      this.code = ErrorCode.UNKNOWN_ERROR;
      this.details = {
        code: this.code,
        message: details,
        cause,
        timestamp: Date.now(),
      };
    } else {
      this.code = details.code;
      this.details = {
        ...details,
        cause: details.cause || cause,
        timestamp: details.timestamp || Date.now(),
      };
    }
    
    // 保持正确的堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChromeMcpError);
    }
  }
  
  /** 转换为 JSON */
  toJSON(): ErrorDetails {
    return {
      code: this.code,
      message: this.message,
      cause: this.details.cause ? {
        name: this.details.cause.name,
        message: this.details.cause.message,
      } : undefined,
      context: this.details.context,
      retryable: this.details.retryable,
      timestamp: this.details.timestamp,
    };
  }
  
  /** 转换为字符串 */
  toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

/** 创建错误工厂函数 */
export function createError(
  code: ErrorCode,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
    retryable?: boolean;
  }
): ChromeMcpError {
  return new ChromeMcpError({
    code,
    message,
    cause: options?.cause,
    context: options?.context,
    retryable: options?.retryable,
  });
}

/** 错误码到 HTTP 状态码映射 */
export const ERROR_CODE_TO_HTTP_STATUS: Record<ErrorCode, number> = {
  // 通用错误
  [ErrorCode.UNKNOWN_ERROR]: 500,
  [ErrorCode.INVALID_FORMAT]: 400,
  [ErrorCode.INVALID_MESSAGE_LENGTH]: 400,
  [ErrorCode.PARSE_ERROR]: 400,
  [ErrorCode.HANDLER_ERROR]: 500,
  
  // 连接错误
  [ErrorCode.CONNECTION_FAILED]: 503,
  [ErrorCode.CONNECTION_LOST]: 503,
  [ErrorCode.SOCKET_ERROR]: 500,
  [ErrorCode.TIMEOUT]: 504,
  
  // 工具错误
  [ErrorCode.TOOL_NOT_FOUND]: 404,
  [ErrorCode.TOOL_EXECUTION_FAILED]: 500,
  [ErrorCode.INVALID_PARAMETERS]: 400,
  [ErrorCode.TOOL_TIMEOUT]: 504,
  
  // 请求错误
  [ErrorCode.REQUEST_FAILED]: 500,
  [ErrorCode.REQUEST_CANCELLED]: 499,
  [ErrorCode.TOO_MANY_REQUESTS]: 429,
  [ErrorCode.REQUEST_TIMEOUT]: 504,
  
  // 服务器错误
  [ErrorCode.SERVER_START_ERROR]: 500,
  [ErrorCode.SERVER_STOP_ERROR]: 500,
  [ErrorCode.SERVER_ALREADY_RUNNING]: 409,
  [ErrorCode.SERVER_NOT_RUNNING]: 503,
  
  // Native Host 错误
  [ErrorCode.NATIVE_HOST_NOT_AVAILABLE]: 503,
  [ErrorCode.NATIVE_DISCONNECTED]: 503,
  [ErrorCode.NATIVE_CONNECTION_FAILED]: 503,
  
  // 文件操作错误
  [ErrorCode.FILE_OPERATION_ERROR]: 500,
  [ErrorCode.FILE_NOT_FOUND]: 404,
  [ErrorCode.FILE_ACCESS_DENIED]: 403,
  
  // 权限错误
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.AUTHENTICATION_FAILED]: 401,
};

/** 错误码到重试策略映射 */
export const ERROR_CODE_RETRYABLE: Record<ErrorCode, boolean> = {
  // 通用错误
  [ErrorCode.UNKNOWN_ERROR]: false,
  [ErrorCode.INVALID_FORMAT]: false,
  [ErrorCode.INVALID_MESSAGE_LENGTH]: false,
  [ErrorCode.PARSE_ERROR]: false,
  [ErrorCode.HANDLER_ERROR]: false,
  
  // 连接错误
  [ErrorCode.CONNECTION_FAILED]: true,
  [ErrorCode.CONNECTION_LOST]: true,
  [ErrorCode.SOCKET_ERROR]: true,
  [ErrorCode.TIMEOUT]: true,
  
  // 工具错误
  [ErrorCode.TOOL_NOT_FOUND]: false,
  [ErrorCode.TOOL_EXECUTION_FAILED]: true,
  [ErrorCode.INVALID_PARAMETERS]: false,
  [ErrorCode.TOOL_TIMEOUT]: true,
  
  // 请求错误
  [ErrorCode.REQUEST_FAILED]: true,
  [ErrorCode.REQUEST_CANCELLED]: false,
  [ErrorCode.TOO_MANY_REQUESTS]: true,
  [ErrorCode.REQUEST_TIMEOUT]: true,
  
  // 服务器错误
  [ErrorCode.SERVER_START_ERROR]: false,
  [ErrorCode.SERVER_STOP_ERROR]: false,
  [ErrorCode.SERVER_ALREADY_RUNNING]: false,
  [ErrorCode.SERVER_NOT_RUNNING]: false,
  
  // Native Host 错误
  [ErrorCode.NATIVE_HOST_NOT_AVAILABLE]: true,
  [ErrorCode.NATIVE_DISCONNECTED]: true,
  [ErrorCode.NATIVE_CONNECTION_FAILED]: true,
  
  // 文件操作错误
  [ErrorCode.FILE_OPERATION_ERROR]: true,
  [ErrorCode.FILE_NOT_FOUND]: false,
  [ErrorCode.FILE_ACCESS_DENIED]: false,
  
  // 权限错误
  [ErrorCode.PERMISSION_DENIED]: false,
  [ErrorCode.AUTHENTICATION_FAILED]: false,
};

/** 检查错误是否可重试 */
export function isRetryableError(error: ChromeMcpError | Error): boolean {
  if (error instanceof ChromeMcpError) {
    return ERROR_CODE_RETRYABLE[error.code] ?? false;
  }
  return false;
}

/** 获取错误对应的 HTTP 状态码 */
export function getHttpStatusCode(error: ChromeMcpError | Error): number {
  if (error instanceof ChromeMcpError) {
    return ERROR_CODE_TO_HTTP_STATUS[error.code] ?? 500;
  }
  return 500;
}

/** 错误处理工具函数 */
export class ErrorHandler {
  /** 捕获错误并转换为 ChromeMcpError */
  static capture(error: unknown, context?: Record<string, unknown>): ChromeMcpError {
    if (error instanceof ChromeMcpError) {
      return error;
    }
    
    if (error instanceof Error) {
      return new ChromeMcpError({
        code: ErrorCode.UNKNOWN_ERROR,
        message: error.message,
        cause: error,
        context,
      });
    }
    
    return new ChromeMcpError({
      code: ErrorCode.UNKNOWN_ERROR,
      message: String(error),
      context,
    });
  }
  
  /** 安全执行异步函数 */
  static async safeExecute<T>(
    fn: () => Promise<T>,
    fallback?: T
  ): Promise<{ success: true; data: T } | { success: false; error: ChromeMcpError }> {
    try {
      const data = await fn();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: ErrorHandler.capture(error),
      };
    }
  }
  
  /** 带重试的执行 */
  static async executeWithRetry<T>(
    fn: () => Promise<T>,
    options?: {
      maxRetries?: number;
      retryDelay?: number;
      onRetry?: (attempt: number, error: ChromeMcpError) => void;
    }
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    const retryDelay = options?.retryDelay ?? 1000;
    
    let lastError: ChromeMcpError | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = ErrorHandler.capture(error);
        
        if (!isRetryableError(lastError) || attempt === maxRetries) {
          throw lastError;
        }
        
        options?.onRetry?.(attempt + 1, lastError);
        
        // 等待重试延迟
        await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
      }
    }
    
    throw lastError!;
  }
}
