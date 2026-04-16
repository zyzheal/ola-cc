/**
 * 超时配置常量
 */

/** 超时配置 */
export const TIMEOUTS = {
  /** 默认请求超时（毫秒） */
  DEFAULT_REQUEST: 15000,
  
  /** 扩展请求超时（毫秒） */
  EXTENSION_REQUEST: 20000,
  
  /** 工具调用超时（毫秒） */
  TOOL_CALL: 120000,
  
  /** 心跳间隔（毫秒） */
  HEARTBEAT_INTERVAL: 30000,
  
  /** 心跳超时（毫秒） */
  HEARTBEAT_TIMEOUT: 10000,
  
  /** 连接超时（毫秒） */
  CONNECTION: 30000,
  
  /** 关闭超时（毫秒） */
  SHUTDOWN: 5000,
} as const;

/** 最大消息大小（16MB） */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/** 最大待处理请求数 */
export const MAX_PENDING_REQUESTS = 100;

/** 最大消息处理批次 */
export const MAX_MESSAGES_PER_TICK = 100;

/** Socket 文件权限 */
export const SOCKET_FILE_MODE = 0o600;

/** Socket 目录权限 */
export const SOCKET_DIR_MODE = 0o700;
