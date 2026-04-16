/**
 * Chrome Native Host - 入口文件
 * 
 * 使用新的 chrome-mcp 架构实现
 * 双协议兼容（OLA + mcp-chrome）
 */

import { createNativeHost, Logger, LogLevel } from '../chrome-mcp/index.js';
import type { ToolCallRequest, ToolCallResponse } from '../chrome-mcp/types.js';

const logger = new Logger({ prefix: '[ChromeNativeHost]', level: LogLevel.INFO });

/**
 * 运行 Chrome Native Host
 * 
 * 这是 CLI --chrome-native-host 参数的入口点
 */
export async function runChromeNativeHost(): Promise<void> {
  logger.info('Initializing Chrome Native Host...');
  
  // 创建 Native Host 实例
  const nativeHost = createNativeHost({
    logLevel: 'info',
  });
  
  // 设置工具调用回调
  nativeHost.setOnToolCallCallback(async (request: ToolCallRequest): Promise<ToolCallResponse> => {
    try {
      logger.debug(`Tool call: ${request.name}`);
      
      // 这里应该调用实际的扩展工具执行逻辑
      // 目前返回占位响应
      return {
        success: true,
        data: {
          content: [{ type: 'text', text: `Tool ${request.name} executed successfully` }],
        },
      };
    } catch (error) {
      logger.error(`Tool call failed: ${request.name}, error: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  
  // 设置连接状态变化回调
  nativeHost.setOnConnectionChangeCallback((connected: boolean) => {
    logger.info(`MCP client ${connected ? 'connected' : 'disconnected'}`);
  });
  
  // 启动 Native Host
  try {
    await nativeHost.start();
    logger.info('Chrome Native Host started successfully');
  } catch (error) {
    logger.error(`Failed to start Chrome Native Host: ${error}`);
    process.exit(1);
  }
  
  // 优雅关闭
  const shutdown = async () => {
    logger.info('Shutting down Chrome Native Host...');
    await nativeHost.stop();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error}`);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
  });
}
