/**
 * 消息类型枚举
 * 
 * 定义双协议兼容的消息类型
 */

/**
 * OLA 协议消息类型
 * 用于当前系统与 MCP Server 之间的通信
 */
export enum OlaMessageType {
  /** 启动 Native Host */
  START = 'start',
  /** 停止 Native Host */
  STOP = 'stop',
  /** 心跳请求 */
  PING = 'ping',
  /** 心跳响应 */
  PONG = 'pong',
  /** 工具请求（MCP → Extension） */
  TOOL_REQUEST = 'tool_request',
  /** 工具响应（Extension → MCP） */
  TOOL_RESPONSE = 'tool_response',
  /** 通知消息 */
  NOTIFICATION = 'notification',
  /** 错误消息 */
  ERROR = 'error',
  /** MCP Client 已连接 */
  MCP_CONNECTED = 'mcp_connected',
  /** MCP Client 已断开 */
  MCP_DISCONNECTED = 'mcp_disconnected',
}

/**
 * mcp-chrome 协议消息类型
 * 用于与 mcp-chrome 扩展之间的通信
 */
export enum McpChromeMessageType {
  /** 启动 HTTP Server */
  START = 'start',
  /** Server 已启动 */
  STARTED = 'started',
  /** 停止 Server */
  STOP = 'stop',
  /** Server 已停止 */
  STOPPED = 'stopped',
  /** 心跳请求 */
  PING = 'ping',
  /** 心跳响应 */
  PONG = 'pong',
  /** 错误消息 */
  ERROR = 'error',
  /** 数据处理请求 */
  PROCESS_DATA = 'process_data',
  /** 数据处理响应 */
  PROCESS_DATA_RESPONSE = 'process_data_response',
  /** 工具调用请求 */
  CALL_TOOL = 'call_tool',
  /** 工具调用响应 */
  CALL_TOOL_RESPONSE = 'call_tool_response',
  /** Server 已启动 */
  SERVER_STARTED = 'server_started',
  /** Server 已停止 */
  SERVER_STOPPED = 'server_stopped',
  /** Native Host 错误 */
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  /** 连接 Native Host */
  CONNECT_NATIVE = 'connectNative',
  /** 确保 Native Host 连接 */
  ENSURE_NATIVE = 'ensure_native',
  /** Ping Native Host */
  PING_NATIVE = 'ping_native',
  /** 断开 Native Host */
  DISCONNECT_NATIVE = 'disconnect_native',
  /** 执行工具（扩展自调用） */
  EXECUTE_TOOL = 'EXECUTE_TOOL',
  /** 请求响应（带 requestId） */
  RESPONSE_TO_REQUEST_ID = 'responseToRequestId',
  /** 请求已取消 */
  REQUEST_CANCELLED = 'request_cancelled',
  /** 心跳 Ping */
  HEARTBEAT_PING = 'heartbeat_ping',
  /** 心跳 Pong */
  HEARTBEAT_PONG = 'heartbeat_pong',
}

/**
 * 统一消息类型
 * 兼容两种协议的消息类型
 */
export type UnifiedMessageType = OlaMessageType | McpChromeMessageType;

/**
 * 消息类型映射表
 * 用于判断消息属于哪种协议
 */
export const PROTOCOL_MAP = {
  // OLA 协议独有
  [OlaMessageType.TOOL_REQUEST]: 'ola' as const,
  [OlaMessageType.TOOL_RESPONSE]: 'both' as const,
  [OlaMessageType.NOTIFICATION]: 'ola' as const,
  [OlaMessageType.MCP_CONNECTED]: 'both' as const,
  [OlaMessageType.MCP_DISCONNECTED]: 'both' as const,
  
  // mcp-chrome 协议独有
  [McpChromeMessageType.STARTED]: 'mcp-chrome' as const,
  [McpChromeMessageType.STOPPED]: 'mcp-chrome' as const,
  [McpChromeMessageType.PROCESS_DATA]: 'mcp-chrome' as const,
  [McpChromeMessageType.PROCESS_DATA_RESPONSE]: 'mcp-chrome' as const,
  [McpChromeMessageType.CALL_TOOL]: 'mcp-chrome' as const,
  [McpChromeMessageType.CALL_TOOL_RESPONSE]: 'mcp-chrome' as const,
  [McpChromeMessageType.SERVER_STARTED]: 'mcp-chrome' as const,
  [McpChromeMessageType.SERVER_STOPPED]: 'mcp-chrome' as const,
  [McpChromeMessageType.ERROR_FROM_NATIVE_HOST]: 'mcp-chrome' as const,
  [McpChromeMessageType.CONNECT_NATIVE]: 'mcp-chrome' as const,
  [McpChromeMessageType.ENSURE_NATIVE]: 'mcp-chrome' as const,
  [McpChromeMessageType.PING_NATIVE]: 'mcp-chrome' as const,
  [McpChromeMessageType.DISCONNECT_NATIVE]: 'mcp-chrome' as const,
  [McpChromeMessageType.EXECUTE_TOOL]: 'mcp-chrome' as const,
  [McpChromeMessageType.RESPONSE_TO_REQUEST_ID]: 'mcp-chrome' as const,
  [McpChromeMessageType.REQUEST_CANCELLED]: 'mcp-chrome' as const,
  [McpChromeMessageType.HEARTBEAT_PING]: 'mcp-chrome' as const,
  [McpChromeMessageType.HEARTBEAT_PONG]: 'mcp-chrome' as const,
  
  // 两种协议共有
  [OlaMessageType.START]: 'both' as const,
  [OlaMessageType.STOP]: 'both' as const,
  [OlaMessageType.PING]: 'both' as const,
  [OlaMessageType.PONG]: 'both' as const,
  [OlaMessageType.ERROR]: 'both' as const,
} as const;

/**
 * 判断消息类型属于哪种协议
 */
export function getProtocolForMessage(type: string): 'ola' | 'mcp-chrome' | 'both' | 'unknown' {
  return (PROTOCOL_MAP as any)[type] || 'unknown';
}
