/**
 * 消息验证器
 * 
 * 验证消息格式和内容的合法性
 */

import { ChromeMcpError, ErrorCode } from './error-handler';
import { MAX_MESSAGE_SIZE } from '../constants/timeouts';
import type { ChromeMcpMessage } from '../types';

/** 验证结果 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean;
  
  /** 错误消息（如果无效） */
  error?: string;
  
  /** 验证后的消息（如果有效） */
  message?: ChromeMcpMessage;
}

/** 消息验证器 */
export class MessageValidator {
  /** 验证消息格式 */
  static validateMessage(raw: unknown): ValidationResult {
    // 检查是否为对象
    if (!raw || typeof raw !== 'object') {
      return {
        valid: false,
        error: 'Invalid message format: not an object',
      };
    }
    
    const message = raw as Record<string, unknown>;
    
    // 检查 type 字段
    if (!message.type || typeof message.type !== 'string') {
      return {
        valid: false,
        error: 'Invalid message format: missing or invalid type field',
      };
    }
    
    return {
      valid: true,
      message: message as ChromeMcpMessage,
    };
  }
  
  /** 验证工具调用请求 */
  static validateToolCallRequest(message: ChromeMcpMessage): ValidationResult {
    const msg = message as Record<string, unknown>;
    
    // OLA 协议：检查 method 字段
    if (msg.method && typeof msg.method === 'string') {
      return {
        valid: true,
        message,
      };
    }
    
    // mcp-chrome 协议：检查 payload.name 字段
    if (msg.payload && typeof msg.payload === 'object') {
      const payload = msg.payload as Record<string, unknown>;
      if (payload.name && typeof payload.name === 'string') {
        return {
          valid: true,
          message,
        };
      }
    }
    
    return {
      valid: false,
      error: 'Invalid tool call request: missing tool name',
    };
  }
  
  /** 验证工具响应 */
  static validateToolResponse(message: ChromeMcpMessage): ValidationResult {
    const msg = message as Record<string, unknown>;
    
    // 检查是否有响应数据
    if (msg.data || msg.payload || msg.result) {
      return {
        valid: true,
        message,
      };
    }
    
    return {
      valid: false,
      error: 'Invalid tool response: missing response data',
    };
  }
  
  /** 验证 requestId 格式 */
  static validateRequestId(requestId: unknown): boolean {
    return typeof requestId === 'string' && requestId.length > 0;
  }
  
  /** 验证端口号 */
  static validatePort(port: unknown): boolean {
    if (typeof port !== 'number') {
      return false;
    }
    return Number.isInteger(port) && port > 0 && port <= 65535;
  }
  
  /** 验证 URL */
  static validateUrl(url: unknown): boolean {
    if (typeof url !== 'string') {
      return false;
    }
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
  
  /** 验证消息大小 */
  static validateMessageSize(message: ChromeMcpMessage): ValidationResult {
    const json = JSON.stringify(message);
    const size = Buffer.byteLength(json, 'utf-8');
    
    if (size > MAX_MESSAGE_SIZE) {
      return {
        valid: false,
        error: `Message too large: ${size} bytes (max: ${MAX_MESSAGE_SIZE})`,
      };
    }
    
    return {
      valid: true,
      message,
    };
  }
  
  /** 完整验证消息 */
  static validate(raw: unknown): ValidationResult {
    // 1. 验证基本格式
    const formatResult = this.validateMessage(raw);
    if (!formatResult.valid) {
      return formatResult;
    }
    
    const message = formatResult.message!;
    
    // 2. 验证消息大小
    const sizeResult = this.validateMessageSize(message);
    if (!sizeResult.valid) {
      return sizeResult;
    }
    
    // 3. 根据消息类型进行特定验证
    switch (message.type) {
      case 'tool_request':
      case 'call_tool':
      case 'EXECUTE_TOOL':
        return this.validateToolCallRequest(message);
      
      case 'tool_response':
      case 'responseToRequestId':
        return this.validateToolResponse(message);
      
      default:
        // 其他消息类型，只验证基本格式
        return {
          valid: true,
          message,
        };
    }
  }
  
  /** 验证并抛出错误 */
  static validateOrThrow(raw: unknown): ChromeMcpMessage {
    const result = this.validate(raw);
    
    if (!result.valid) {
      throw new ChromeMcpError({
        code: ErrorCode.INVALID_FORMAT,
        message: result.error || 'Unknown validation error',
      });
    }
    
    return result.message!;
  }
}

/** 参数验证器 */
export class ParamsValidator {
  /** 验证必填参数 */
  static required(params: Record<string, unknown>, ...keys: string[]): ValidationResult {
    for (const key of keys) {
      if (params[key] === undefined || params[key] === null) {
        return {
          valid: false,
          error: `Missing required parameter: ${key}`,
        };
      }
    }
    
    return { valid: true };
  }
  
  /** 验证参数类型 */
  static type(params: Record<string, unknown>, key: string, expectedType: string): ValidationResult {
    const value = params[key];
    
    if (value === undefined || value === null) {
      return { valid: true }; // 可选参数
    }
    
    if (typeof value !== expectedType) {
      return {
        valid: false,
        error: `Invalid type for ${key}: expected ${expectedType}, got ${typeof value}`,
      };
    }
    
    return { valid: true };
  }
  
  /** 验证字符串参数 */
  static string(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
  }): ValidationResult {
    const required = options?.required ?? false;
    
    if (!required && (params[key] === undefined || params[key] === null)) {
      return { valid: true };
    }
    
    const result = this.type(params, key, 'string');
    if (!result.valid) {
      return result;
    }
    
    const value = params[key] as string;
    
    if (options?.minLength !== undefined && value.length < options.minLength) {
      return {
        valid: false,
        error: `${key} too short: minimum length is ${options.minLength}`,
      };
    }
    
    if (options?.maxLength !== undefined && value.length > options.maxLength) {
      return {
        valid: false,
        error: `${key} too long: maximum length is ${options.maxLength}`,
      };
    }
    
    if (options?.pattern && !options.pattern.test(value)) {
      return {
        valid: false,
        error: `${key} does not match required pattern`,
      };
    }
    
    return { valid: true };
  }
  
  /** 验证数字参数 */
  static number(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
  }): ValidationResult {
    const required = options?.required ?? false;
    
    if (!required && (params[key] === undefined || params[key] === null)) {
      return { valid: true };
    }
    
    const result = this.type(params, key, 'number');
    if (!result.valid) {
      return result;
    }
    
    const value = params[key] as number;
    
    if (options?.integer !== undefined && options.integer && !Number.isInteger(value)) {
      return {
        valid: false,
        error: `${key} must be an integer`,
      };
    }
    
    if (options?.min !== undefined && value < options.min) {
      return {
        valid: false,
        error: `${key} too small: minimum value is ${options.min}`,
      };
    }
    
    if (options?.max !== undefined && value > options.max) {
      return {
        valid: false,
        error: `${key} too large: maximum value is ${options.max}`,
      };
    }
    
    return { valid: true };
  }
  
  /** 验证布尔参数 */
  static boolean(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
  }): ValidationResult {
    const required = options?.required ?? false;
    
    if (!required && (params[key] === undefined || params[key] === null)) {
      return { valid: true };
    }
    
    return this.type(params, key, 'boolean');
  }
  
  /** 验证对象参数 */
  static object(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
  }): ValidationResult {
    const required = options?.required ?? false;
    
    if (!required && (params[key] === undefined || params[key] === null)) {
      return { valid: true };
    }
    
    return this.type(params, key, 'object');
  }
  
  /** 验证数组参数 */
  static array(params: Record<string, unknown>, key: string, options?: {
    required?: boolean;
    minItems?: number;
    maxItems?: number;
  }): ValidationResult {
    const required = options?.required ?? false;
    
    if (!required && (params[key] === undefined || params[key] === null)) {
      return { valid: true };
    }
    
    const result = this.type(params, key, 'object');
    if (!result.valid) {
      return result;
    }
    
    const value = params[key];
    if (!Array.isArray(value)) {
      return {
        valid: false,
        error: `${key} must be an array`,
      };
    }
    
    if (options?.minItems !== undefined && value.length < options.minItems) {
      return {
        valid: false,
        error: `${key} too few items: minimum is ${options.minItems}`,
      };
    }
    
    if (options?.maxItems !== undefined && value.length > options.maxItems) {
      return {
        valid: false,
        error: `${key} too many items: maximum is ${options.maxItems}`,
      };
    }
    
    return { valid: true };
  }
}
