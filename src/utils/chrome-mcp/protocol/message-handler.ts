/**
 * 消息处理器
 * 
 * 处理双协议消息的路由和分发
 * 支持 OLA 协议和 mcp-chrome 协议
 */

import { Logger } from '../utils/logger';
import { RequestTracker } from './request-tracker';
import { ToolNameMapper } from '../tools/name-mapper';
import { OlaMessageType, McpChromeMessageType, getProtocolForMessage } from '../constants/message-types';
import type { ChromeMcpMessage, ToolCallRequest, ToolCallResponse } from '../types';

/** 消息处理器回调 */
export type MessageHandlerCallback = {
  /** 处理工具调用 */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  
  /** 处理工具响应 */
  onToolResponse?: (response: ToolCallResponse) => void;
  
  /** 处理连接状态变化 */
  onConnectionChange?: (connected: boolean) => void;
  
  /** 处理心跳 Ping */
  onHeartbeatPing?: () => void;
  
  /** 处理启动请求 */
  onStart?: (payload?: unknown) => Promise<void>;
  
  /** 处理停止请求 */
  onStop?: () => Promise<void>;
};

/** 消息处理器配置 */
export interface MessageHandlerConfig {
  /** 请求跟踪器 */
  requestTracker: RequestTracker;
  
  /** 日志器 */
  logger?: Logger;
}

/** 消息处理结果 */
export interface MessageProcessResult {
  /** 是否成功处理 */
  success: boolean;
  
  /** 是否需要发送响应 */
  needsResponse: boolean;
  
  /** 响应消息（如果需要） */
  response?: ChromeMcpMessage;
  
  /** 错误信息（如果失败） */
  error?: string;
}

/** 消息处理器 */
export class MessageHandler {
  private requestTracker: RequestTracker;
  private logger: Logger;
  private callback: MessageHandlerCallback | null = null;
  
  constructor(config: MessageHandlerConfig) {
    this.requestTracker = config.requestTracker;
    this.logger = config.logger || new Logger({ prefix: '[MessageHandler]' });
  }
  
  /** 设置消息处理回调 */
  setCallback(callback: MessageHandlerCallback): void {
    this.callback = callback;
  }
  
  /**
   * 处理接收到的消息
   */
  async handleMessage(message: ChromeMcpMessage): Promise<MessageProcessResult> {
    const protocol = getProtocolForMessage(message.type);
    
    this.logger.debug(
      `Handling message: type=${message.type}, protocol=${protocol}`
    );
    
    try {
      switch (message.type) {
        // ===== 共有消息类型 =====
        case OlaMessageType.START:
        case McpChromeMessageType.START:
          return await this.handleStart(message);
        
        case OlaMessageType.STOP:
        case McpChromeMessageType.STOP:
          return await this.handleStop(message);
        
        case OlaMessageType.PING:
        case McpChromeMessageType.PING:
        case McpChromeMessageType.PING_NATIVE:
          return this.handlePing(message);
        
        case OlaMessageType.ERROR:
        case McpChromeMessageType.ERROR:
        case McpChromeMessageType.ERROR_FROM_NATIVE_HOST:
          return this.handleError(message);
        
        // ===== OLA 协议消息 =====
        case OlaMessageType.TOOL_REQUEST:
          return await this.handleOlaToolRequest(message);
        
        case OlaMessageType.TOOL_RESPONSE:
          return this.handleOlaToolResponse(message);
        
        case OlaMessageType.MCP_CONNECTED:
        case OlaMessageType.MCP_DISCONNECTED:
          return this.handleConnectionChange(message);
        
        case OlaMessageType.NOTIFICATION:
          return this.handleNotification(message);
        
        // ===== mcp-chrome 协议消息 =====
        case McpChromeMessageType.CALL_TOOL:
        case McpChromeMessageType.EXECUTE_TOOL:
          return await this.handleMcpChromeToolCall(message);
        
        case McpChromeMessageType.RESPONSE_TO_REQUEST_ID:
          return this.handleMcpChromeToolResponse(message);
        
        case McpChromeMessageType.PROCESS_DATA:
          return this.handleProcessData(message);
        
        case McpChromeMessageType.CONNECT_NATIVE:
        case McpChromeMessageType.ENSURE_NATIVE:
          return this.handleConnectNative(message);
        
        case McpChromeMessageType.DISCONNECT_NATIVE:
          return this.handleDisconnectNative(message);
        
        case McpChromeMessageType.HEARTBEAT_PING:
          return this.handleHeartbeatPing(message);
        
        case McpChromeMessageType.HEARTBEAT_PONG:
          return this.handleHeartbeatPong(message);
        
        default:
          this.logger.warn(`Unknown message type: ${message.type}`);
          return {
            success: false,
            needsResponse: true,
            response: {
              type: OlaMessageType.ERROR,
              error: `Unknown message type: ${message.type}`,
            },
          };
      }
    } catch (error) {
      this.logger.error(
        `Error handling message: ${error instanceof Error ? error.message : String(error)}`
      );
      
      return {
        success: false,
        needsResponse: true,
        response: {
          type: OlaMessageType.ERROR,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  
  /** 处理启动请求 */
  private async handleStart(message: ChromeMcpMessage): Promise<MessageProcessResult> {
    this.logger.info('START message received');
    
    if (this.callback?.onStart) {
      await this.callback.onStart((message as any).payload);
    }
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.SERVER_STARTED,
        payload: { mode: 'socket' },
      },
    };
  }
  
  /** 处理停止请求 */
  private async handleStop(message: ChromeMcpMessage): Promise<MessageProcessResult> {
    this.logger.info('STOP message received');
    
    if (this.callback?.onStop) {
      await this.callback.onStop();
    }
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.SERVER_STOPPED,
      },
    };
  }
  
  /** 处理 Ping 请求 */
  private handlePing(message: ChromeMcpMessage): MessageProcessResult {
    return {
      success: true,
      needsResponse: true,
      response: {
        type: OlaMessageType.PONG,
      },
    };
  }
  
  /** 处理错误消息 */
  private handleError(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.error(
      `Error message received: ${(message as any).error || (message as any).payload}`
    );
    
    return {
      success: false,
      needsResponse: false,
    };
  }
  
  /** 处理 OLA 工具请求 */
  private async handleOlaToolRequest(message: ChromeMcpMessage): Promise<MessageProcessResult> {
    const olaMsg = message as any;
    const methodName = olaMsg.method;
    
    if (!methodName) {
      return {
        success: false,
        needsResponse: true,
        response: {
          type: OlaMessageType.ERROR,
          error: 'Missing method in tool_request',
        },
      };
    }
    
    this.logger.debug(`OLA tool request: ${methodName}`);
    
    if (!this.callback?.onToolCall) {
      return {
        success: false,
        needsResponse: true,
        response: {
          type: OlaMessageType.ERROR,
          error: 'No tool call handler registered',
        },
      };
    }
    
    // 转换工具名称并调用
    const normalizedName = ToolNameMapper.normalize(methodName);
    const result = await this.callback.onToolCall({
      name: normalizedName,
      args: olaMsg.params,
    });
    
    return {
      success: result.success,
      needsResponse: true,
      response: {
        type: OlaMessageType.TOOL_RESPONSE,
        ...result,
      },
    };
  }
  
  /** 处理 OLA 工具响应 */
  private handleOlaToolResponse(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.debug('OLA tool response received');
    
    if (this.callback?.onToolResponse) {
      this.callback.onToolResponse(message as any);
    }
    
    return {
      success: true,
      needsResponse: false,
    };
  }
  
  /** 处理连接状态变化 */
  private handleConnectionChange(message: ChromeMcpMessage): MessageProcessResult {
    const connected = message.type === OlaMessageType.MCP_CONNECTED;
    this.logger.info(`MCP client ${connected ? 'connected' : 'disconnected'}`);
    
    if (this.callback?.onConnectionChange) {
      this.callback.onConnectionChange(connected);
    }
    
    return {
      success: true,
      needsResponse: false,
    };
  }
  
  /** 处理通知消息 */
  private handleNotification(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.debug('Notification received');
    
    // 通知消息通常不需要响应
    return {
      success: true,
      needsResponse: false,
    };
  }
  
  /** 处理 mcp-chrome 工具调用 */
  private async handleMcpChromeToolCall(message: ChromeMcpMessage): Promise<MessageProcessResult> {
    const mcpMsg = message as any;
    const requestId = mcpMsg.requestId;
    const payload = mcpMsg.payload || {};
    const toolName = payload.name || mcpMsg.method;
    const toolArgs = payload.args || mcpMsg.params || {};
    
    if (!toolName) {
      return {
        success: false,
        needsResponse: true,
        response: {
          type: McpChromeMessageType.RESPONSE_TO_REQUEST_ID,
          responseToRequestId: requestId,
          payload: {
            status: 'error',
            error: 'Missing tool name',
          },
        },
      };
    }
    
    this.logger.debug(`mcp-chrome tool request: ${toolName}, requestId: ${requestId}`);
    
    if (!this.callback?.onToolCall) {
      return {
        success: false,
        needsResponse: true,
        response: {
          type: McpChromeMessageType.RESPONSE_TO_REQUEST_ID,
          responseToRequestId: requestId,
          payload: {
            status: 'error',
            error: 'No tool call handler registered',
          },
        },
      };
    }
    
    try {
      // 调用工具
      const result = await this.callback.onToolCall({
        name: toolName,
        args: toolArgs,
        requestId,
      });
      
      return {
        success: result.success,
        needsResponse: true,
        response: {
          type: McpChromeMessageType.RESPONSE_TO_REQUEST_ID,
          responseToRequestId: requestId,
          payload: result,
        },
      };
    } catch (error) {
      return {
        success: false,
        needsResponse: true,
        response: {
          type: McpChromeMessageType.RESPONSE_TO_REQUEST_ID,
          responseToRequestId: requestId,
          payload: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
  
  /** 处理 mcp-chrome 工具响应 */
  private handleMcpChromeToolResponse(message: ChromeMcpMessage): MessageProcessResult {
    const mcpMsg = message as any;
    const requestId = mcpMsg.responseToRequestId;
    const payload = mcpMsg.payload;
    
    this.logger.debug(`mcp-chrome tool response: requestId=${requestId}`);
    
    if (payload?.status === 'error') {
      this.requestTracker.rejectResponse(requestId, payload.error || 'Unknown error');
    } else {
      this.requestTracker.resolveResponse(requestId, payload);
    }
    
    return {
      success: true,
      needsResponse: false,
    };
  }
  
  /** 处理数据处理请求 */
  private handleProcessData(message: ChromeMcpMessage): MessageProcessResult {
    const mcpMsg = message as any;
    const requestId = mcpMsg.requestId;
    
    this.logger.debug('PROCESS_DATA received');
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.PROCESS_DATA_RESPONSE,
        responseToRequestId: requestId,
        payload: {
          status: 'success',
          data: mcpMsg.payload,
        },
      },
    };
  }
  
  /** 处理连接 Native Host 请求 */
  private handleConnectNative(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.info('CONNECT_NATIVE/ENSURE_NATIVE received');
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.SERVER_STARTED,
        payload: { mode: 'socket' },
      },
    };
  }
  
  /** 处理断开 Native Host 请求 */
  private handleDisconnectNative(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.info('DISCONNECT_NATIVE received');
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.SERVER_STOPPED,
      },
    };
  }
  
  /** 处理心跳 Ping */
  private handleHeartbeatPing(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.debug('HEARTBEAT_PING received');
    
    if (this.callback?.onHeartbeatPing) {
      this.callback.onHeartbeatPing();
    }
    
    return {
      success: true,
      needsResponse: true,
      response: {
        type: McpChromeMessageType.HEARTBEAT_PONG,
      },
    };
  }
  
  /** 处理心跳 Pong */
  private handleHeartbeatPong(message: ChromeMcpMessage): MessageProcessResult {
    this.logger.debug('HEARTBEAT_PONG received');
    
    return {
      success: true,
      needsResponse: false,
    };
  }
}
