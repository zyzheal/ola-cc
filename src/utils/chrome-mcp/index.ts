/**
 * Chrome MCP 工具库
 * 
 * 双协议兼容的 Chrome MCP 实现
 * 支持 OLA 协议和 mcp-chrome 协议
 */

// 类型导出
export type {
  // 消息类型
  BaseMessage,
  OlaMessage,
  McpChromeMessage,
  ChromeMcpMessage,
  
  // 工具类型
  ToolDefinition,
  ToolCallRequest,
  ToolCallResponse,
  ToolResult,
  
  // 配置类型
  NativeHostConfig,
  
  // 状态类型
  ConnectionStatus,
  HealthStatus,
} from './types';

// 常量导出
export {
  OlaMessageType,
  McpChromeMessageType,
  PROTOCOL_MAP,
  getProtocolForMessage,
} from './constants/message-types';

export {
  TIMEOUTS,
  MAX_MESSAGE_SIZE,
  MAX_PENDING_REQUESTS,
  MAX_MESSAGES_PER_TICK,
  SOCKET_FILE_MODE,
  SOCKET_DIR_MODE,
} from './constants/timeouts';

export {
  HTTP_DEFAULTS,
  SOCKET_DEFAULTS,
  NATIVE_MESSAGING_DEFAULTS,
  EXTENSION_IDS,
  getAllowedExtensionIds,
  getExtensionOrigin,
  getAllowedExtensionOrigins,
} from './constants/defaults';

// 协议层导出
export { RequestTracker } from './protocol/request-tracker';
export type { RequestTrackerConfig } from './protocol/request-tracker';

export { HeartbeatManager } from './protocol/heartbeat';
export type { HeartbeatConfig, HeartbeatState, HeartbeatCallback } from './protocol/heartbeat';

export { MessageHandler } from './protocol/message-handler';
export type { MessageHandlerConfig, MessageHandlerCallback, MessageProcessResult } from './protocol/message-handler';

export { NativeHost, createNativeHost } from './protocol/native-host';

// 工具层导出
export { ToolNameMapper } from './tools/name-mapper';
export { ToolRegistry, createToolRegistry } from './tools/registry';
export type { ToolRegistryConfig, ToolExecutor } from './tools/registry';
export { ToolListCache, createToolListCache } from './tools/cache';
export type { ToolListCacheConfig } from './tools/cache';

// 工具函数导出
export { Logger, createLogger, defaultLogger, LogLevel } from './utils/logger';
export type { LoggerConfig } from './utils/logger';

export {
  ChromeMcpError,
  ErrorCode,
  createError,
  isRetryableError,
  getHttpStatusCode,
  ErrorHandler,
} from './utils/error-handler';
export type { ErrorDetails } from './utils/error-handler';

export { MessageValidator, ParamsValidator } from './utils/validators';
export type { ValidationResult } from './utils/validators';

// 版本信息
export const VERSION = '1.0.0';
