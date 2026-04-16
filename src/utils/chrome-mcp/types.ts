/**
 * Chrome MCP 类型定义
 * 
 * 定义双协议兼容的类型系统
 */

// ============================================================================
// 消息类型枚举（双协议）
// ============================================================================

/** OLA 协议消息类型 */
export enum OlaMessageType {
  START = 'start',
  STOP = 'stop',
  PING = 'ping',
  PONG = 'pong',
  TOOL_REQUEST = 'tool_request',
  TOOL_RESPONSE = 'tool_response',
  NOTIFICATION = 'notification',
  ERROR = 'error',
  MCP_CONNECTED = 'mcp_connected',
  MCP_DISCONNECTED = 'mcp_disconnected',
}

/** mcp-chrome 协议消息类型 */
export enum McpChromeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
  EXECUTE_TOOL = 'EXECUTE_TOOL',
  RESPONSE_TO_REQUEST_ID = 'responseToRequestId',
  REQUEST_CANCELLED = 'request_cancelled',
  HEARTBEAT_PING = 'heartbeat_ping',
  HEARTBEAT_PONG = 'heartbeat_pong',
}

/** 统一消息类型（双协议兼容） */
export type UnifiedMessageType = OlaMessageType | McpChromeMessageType;

// ============================================================================
// 消息接口
// ============================================================================

/** 基础消息接口 */
export interface BaseMessage {
  type: string;
}

/** OLA 协议消息 */
export interface OlaMessage extends BaseMessage {
  type: OlaMessageType;
  method?: string;
  params?: unknown;
  data?: unknown;
  error?: string;
}

/** mcp-chrome 协议消息 */
export interface McpChromeMessage extends BaseMessage {
  type: McpChromeMessageType;
  requestId?: string;
  responseToRequestId?: string;
  payload?: unknown;
  error?: string;
}

/** 统一消息类型 */
export type ChromeMcpMessage = OlaMessage | McpChromeMessage;

// ============================================================================
// 工具相关类型
// ============================================================================

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** 工具调用请求 */
export interface ToolCallRequest {
  name: string;
  args?: Record<string, unknown>;
  requestId?: string;
}

/** 工具调用响应 */
export interface ToolCallResponse {
  requestId?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** 工具执行结果 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ============================================================================
// 配置类型
// ============================================================================

/** Native Host 配置 */
export interface NativeHostConfig {
  /** 是否启用 HTTP Server */
  httpEnabled?: boolean;
  /** HTTP 端口 */
  httpPort?: number;
  /** HTTP 绑定地址 */
  httpHost?: string;
  /** CORS 白名单 */
  corsOrigins?: (string | RegExp)[];
  /** Socket 路径 */
  socketPath?: string;
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number;
  /** 心跳超时（毫秒） */
  heartbeatTimeout?: number;
  /** 请求超时（毫秒） */
  requestTimeout?: number;
  /** 最大待处理请求数 */
  maxPendingRequests?: number;
  /** 日志级别 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/** 默认配置 */
export const DEFAULT_CONFIG: Required<NativeHostConfig> = {
  httpEnabled: false,
  httpPort: 12306,
  httpHost: '127.0.0.1',
  corsOrigins: [/^chrome-extension:\/\//, /^moz-extension:\/\//, 'http://127.0.0.1'],
  socketPath: '',
  heartbeatInterval: 30000,
  heartbeatTimeout: 10000,
  requestTimeout: 60000,
  maxPendingRequests: 100,
  logLevel: 'info',
};

// ============================================================================
// 状态类型
// ============================================================================

/** 连接状态 */
export interface ConnectionStatus {
  /** 是否已连接 */
  connected: boolean;
  /** 扩展是否已连接 */
  extensionConnected: boolean;
  /** MCP Client 是否已连接 */
  mcpClientConnected: boolean;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 待处理请求数 */
  pendingRequests: number;
  /** 运行模式 */
  mode: 'socket' | 'http';
}

/** 健康状态 */
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  mode: 'socket' | 'http';
  pendingRequests: number;
  uptime: number;
  lastError?: string;
}
