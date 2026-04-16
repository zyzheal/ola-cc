/**
 * Native Host 核心实现
 * 
 * 双协议兼容的 Native Host 实现
 * 支持 OLA 协议和 mcp-chrome 协议
 */

import { stdin, stdout } from 'process';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'net';
import { mkdir, chmod, unlink, rmdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { platform, tmpdir, userInfo } from 'os';

import { Logger, LogLevel } from '../utils/logger';
import { RequestTracker } from './request-tracker';
import { HeartbeatManager } from './heartbeat';
import { MessageHandler } from './message-handler';
import { ToolNameMapper } from '../tools/name-mapper';
import { OlaMessageType, McpChromeMessageType } from '../constants/message-types';
import { TIMEOUTS, MAX_MESSAGE_SIZE, MAX_MESSAGES_PER_TICK, SOCKET_FILE_MODE, SOCKET_DIR_MODE } from '../constants/timeouts';
import { HTTP_DEFAULTS, SOCKET_DEFAULTS } from '../constants/defaults';
import type { NativeHostConfig, ConnectionStatus, HealthStatus, ChromeMcpMessage, ToolCallRequest, ToolCallResponse } from '../types';

/** 默认配置 */
const DEFAULT_CONFIG: Required<NativeHostConfig> = {
  httpEnabled: false,
  httpPort: HTTP_DEFAULTS.PORT,
  httpHost: HTTP_DEFAULTS.HOST,
  corsOrigins: HTTP_DEFAULTS.CORS_ORIGINS,
  socketPath: '',
  heartbeatInterval: TIMEOUTS.HEARTBEAT_INTERVAL,
  heartbeatTimeout: TIMEOUTS.HEARTBEAT_TIMEOUT,
  requestTimeout: TIMEOUTS.DEFAULT_REQUEST,
  maxPendingRequests: 100,
  logLevel: 'info',
};

/** Native Host 类 */
export class NativeHost {
  private config: Required<NativeHostConfig>;
  private logger: Logger;
  private requestTracker: RequestTracker;
  private heartbeatManager: HeartbeatManager;
  private messageHandler: MessageHandler;
  
  // Socket 服务器
  private socketServer: NetServer | null = null;
  private socketPath: string = '';
  private mcpClients = new Map<number, { socket: Socket; buffer: Buffer }>();
  private nextClientId = 1;
  
  // 运行状态
  private running = false;
  private shuttingDown = false;
  private startTime = Date.now();
  private lastError: string | null = null;
  
  // 回调函数
  private onToolCallCallback: ((request: ToolCallRequest) => Promise<ToolCallResponse>) | null = null;
  private onConnectionChangeCallback: ((connected: boolean) => void) | null = null;
  
  constructor(config?: NativeHostConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 初始化日志器
    this.logger = new Logger({
      prefix: '[NativeHost]',
      level: LogLevel[this.config.logLevel.toUpperCase() as keyof typeof LogLevel] || LogLevel.INFO,
    });
    
    // 初始化请求跟踪器
    this.requestTracker = new RequestTracker({
      defaultTimeout: this.config.requestTimeout,
      maxPending: this.config.maxPendingRequests,
      logger: this.logger.child('RequestTracker'),
    });
    
    // 初始化心跳管理器
    this.heartbeatManager = new HeartbeatManager({
      interval: this.config.heartbeatInterval,
      timeout: this.config.heartbeatTimeout,
      logger: this.logger.child('Heartbeat'),
    });
    
    // 初始化消息处理器
    this.messageHandler = new MessageHandler({
      requestTracker: this.requestTracker,
      logger: this.logger.child('MessageHandler'),
    });
    
    // 设置消息处理回调
    this.messageHandler.setCallback({
      onToolCall: async (request) => {
        if (this.onToolCallCallback) {
          return await this.onToolCallCallback(request);
        }
        return {
          success: false,
          error: 'No tool call callback registered',
        };
      },
      onToolResponse: (response) => {
        this.forwardToMcpClients(response);
      },
      onConnectionChange: (connected) => {
        this.onConnectionChangeCallback?.(connected);
      },
      onHeartbeatPing: () => {
        this.sendToExtension({ type: McpChromeMessageType.HEARTBEAT_PONG });
      },
      onStart: async () => {
        this.logger.info('START message processed');
      },
      onStop: async () => {
        await this.stop();
      },
    });
  }
  
  /** 设置工具调用回调 */
  setOnToolCallCallback(callback: (request: ToolCallRequest) => Promise<ToolCallResponse>): void {
    this.onToolCallCallback = callback;
  }
  
  /** 设置连接状态变化回调 */
  setOnConnectionChangeCallback(callback: (connected: boolean) => void): void {
    this.onConnectionChangeCallback = callback;
  }
  
  /** 启动 Native Host */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Native Host already running');
      return;
    }
    
    this.logger.info('Starting Native Host...');
    
    try {
      // 初始化 Socket 路径
      this.socketPath = this.config.socketPath || this.getDefaultSocketPath();
      
      // 创建 Socket 目录
      if (platform() !== 'win32') {
        const socketDir = join(this.socketPath, '..');
        await mkdir(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
        await chmod(socketDir, SOCKET_DIR_MODE);
      }
      
      // 清理旧的 Socket 文件
      if (platform() !== 'win32') {
        await this.cleanupStaleSockets();
      }
      
      // 启动 Socket 服务器
      await this.startSocketServer();
      
      // 启动消息读取
      this.startMessageReading();
      
      // 启动心跳
      this.heartbeatManager.start({
        onSendPing: () => {
          this.sendToExtension({ type: McpChromeMessageType.HEARTBEAT_PING });
        },
        onTimeout: () => {
          this.logger.error('Heartbeat timeout - connection appears dead');
          this.lastError = 'Heartbeat timeout';
        },
        onRecover: () => {
          this.logger.info('Heartbeat recovered');
          this.lastError = null;
        },
      });
      
      this.running = true;
      this.startTime = Date.now();
      
      this.logger.info(`Native Host started, socket: ${this.socketPath}`);
    } catch (error) {
      this.logger.error(`Failed to start Native Host: ${error}`);
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  
  /** 停止 Native Host */
  async stop(): Promise<void> {
    if (!this.running || this.shuttingDown) {
      return;
    }
    
    this.shuttingDown = true;
    this.logger.info('Stopping Native Host...');
    
    try {
      // 停止心跳
      this.heartbeatManager.stop();
      
      // 清理所有 MCP 客户端连接
      for (const [, client] of this.mcpClients) {
        client.socket.destroy();
      }
      this.mcpClients.clear();
      
      // 关闭 Socket 服务器
      if (this.socketServer) {
        await new Promise<void>(resolve => {
          this.socketServer!.close(() => resolve());
        });
        this.socketServer = null;
      }
      
      // 清理 Socket 文件
      if (platform() !== 'win32' && this.socketPath) {
        try {
          await unlink(this.socketPath);
          this.logger.debug('Socket file cleaned up');
        } catch {
          // 忽略错误
        }
      }
      
      // 清理请求跟踪器
      this.requestTracker.cleanup('Native Host stopping');
      
      this.running = false;
      this.shuttingDown = false;
      
      this.logger.info('Native Host stopped');
    } catch (error) {
      this.logger.error(`Error stopping Native Host: ${error}`);
      this.shuttingDown = false;
    }
  }
  
  /** 获取连接状态 */
  getConnectionStatus(): ConnectionStatus {
    return {
      connected: this.running,
      extensionConnected: this.heartbeatManager.isHealthy(),
      mcpClientConnected: this.mcpClients.size > 0,
      lastHeartbeat: this.heartbeatManager.getState().lastReceivedTime,
      pendingRequests: this.requestTracker.pendingCount,
      mode: 'socket',
    };
  }
  
  /** 获取健康状态 */
  getHealthStatus(): HealthStatus {
    return {
      status: this.lastError ? 'error' : (this.heartbeatManager.isHealthy() ? 'ok' : 'degraded'),
      version: '1.0.0',
      mode: 'socket',
      pendingRequests: this.requestTracker.pendingCount,
      uptime: Date.now() - this.startTime,
      lastError: this.lastError || undefined,
    };
  }
  
  /** 发送消息到扩展 */
  sendToExtension(message: ChromeMcpMessage): void {
    try {
      const messageString = JSON.stringify(message);
      const messageBuffer = Buffer.from(messageString, 'utf-8');
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(messageBuffer.length, 0);
      const fullBuffer = Buffer.concat([headerBuffer, messageBuffer]);
      
      stdout.write(fullBuffer);
      
      this.logger.debug(`Sent to extension: type=${message.type}`);
    } catch (error) {
      this.logger.error(`Failed to send to extension: ${error}`);
    }
  }
  
  /** 转发消息到所有 MCP 客户端 */
  private forwardToMcpClients(message: ChromeMcpMessage): void {
    if (this.mcpClients.size === 0) {
      this.logger.debug('No MCP clients to forward to');
      return;
    }
    
    const data = Buffer.from(JSON.stringify(message), 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(data.length, 0);
    const msg = Buffer.concat([lengthBuffer, data]);
    
    for (const [id, client] of this.mcpClients) {
      try {
        client.socket.write(msg);
      } catch (e) {
        this.logger.error(`Failed to send to MCP client ${id}: ${e}`);
      }
    }
    
    this.logger.debug(`Forwarded to ${this.mcpClients.size} MCP clients: type=${message.type}`);
  }
  
  /** 启动 Socket 服务器 */
  private async startSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socketServer = createNetServer(socket => this.handleMcpClient(socket));
      
      this.socketServer.on('error', err => {
        this.logger.error(`Socket server error: ${err}`);
        reject(err);
      });
      
      this.socketServer.listen(this.socketPath, () => {
        this.logger.info(`Socket server listening on ${this.socketPath}`);
        
        // 设置 Socket 文件权限
        if (platform() !== 'win32') {
          chmod(this.socketPath, SOCKET_FILE_MODE).catch(() => {
            this.logger.warn('Failed to set socket permissions');
          });
        }
        
        resolve();
      });
    });
  }
  
  /** 处理 MCP 客户端连接 */
  private handleMcpClient(socket: Socket): void {
    const clientId = this.nextClientId++;
    const client = { socket, buffer: Buffer.alloc(0) };
    this.mcpClients.set(clientId, client);
    
    this.logger.info(`MCP client ${clientId} connected, total: ${this.mcpClients.size}`);
    
    // 通知扩展有新连接
    this.sendToExtension({ type: OlaMessageType.MCP_CONNECTED });
    
    const CLIENT_GC_THRESHOLD = 5 * 1024 * 1024; // 5MB per client

    socket.on('data', (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data]);

      // 处理完整消息
      while (client.buffer.length >= 4) {
        const length = client.buffer.readUInt32LE(0);

        if (length === 0 || length > MAX_MESSAGE_SIZE) {
          this.logger.error(`Invalid message length from MCP client ${clientId}: ${length}`);
          socket.destroy();
          return;
        }

        if (client.buffer.length < 4 + length) {
          break; // 等待更多数据
        }

        const messageBytes = client.buffer.slice(4, 4 + length);
        client.buffer = client.buffer.slice(4 + length);

        try {
          const message = JSON.parse(messageBytes.toString('utf-8')) as ChromeMcpMessage;
          this.logger.debug(`Received from MCP client ${clientId}: type=${message.type}`);

          // 转发到扩展
          this.sendToExtension(message);
        } catch (e) {
          this.logger.error(`Failed to parse message from MCP client ${clientId}: ${e}`);
        }
      }

      // Compact client buffer periodically to prevent memory bloat
      if (client.buffer.length > CLIENT_GC_THRESHOLD) {
        client.buffer = Buffer.from(client.buffer);
      }
    });
    
    socket.on('error', err => {
      this.logger.error(`MCP client ${clientId} error: ${err}`);
    });
    
    socket.on('close', () => {
      // 显式清理客户端 buffer 以释放内存
      client.buffer = Buffer.alloc(0);
      this.mcpClients.delete(clientId);
      this.logger.info(`MCP client ${clientId} disconnected, total: ${this.mcpClients.size}`);

      // 通知扩展连接断开
      this.sendToExtension({ type: OlaMessageType.MCP_DISCONNECTED });
    });
  }
  
  /** 开始读取消息（从 stdin） */
  private startMessageReading(): void {
    let buffer: Buffer | null = null;
    let expectedLength = -1;
    let totalProcessed = 0;
    const GC_THRESHOLD = 10 * 1024 * 1024; // 10MB

    const processAvailable = async () => {
      if (!buffer || buffer.length === 0) {
        return;
      }

      let processed = 0;
      while (processed < MAX_MESSAGES_PER_TICK) {
        if (expectedLength === -1) {
          if (buffer.length < 4) break;
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.subarray(4);

          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE) {
            this.logger.error(`Invalid message length: ${expectedLength}`);
            this.sendToExtension({
              type: OlaMessageType.ERROR,
              error: `Invalid message length: ${expectedLength}`,
            });
            expectedLength = -1;
            buffer = null;
            totalProcessed = 0;
            break;
          }
        }

        if (buffer.length < expectedLength) break;

        const messageBuffer = buffer.subarray(0, expectedLength);
        buffer = buffer.subarray(expectedLength);
        expectedLength = -1;
        processed++;
        totalProcessed += expectedLength;

        try {
          const message = JSON.parse(messageBuffer.toString('utf-8')) as ChromeMcpMessage;
          this.heartbeatManager.onMessageReceived();

          const result = await this.messageHandler.handleMessage(message);

          if (result.needsResponse && result.response) {
            this.sendToExtension(result.response);
          }
        } catch (error) {
          this.logger.error(`Failed to parse message: ${error}`);
          this.sendToExtension({
            type: OlaMessageType.ERROR,
            error: `Failed to parse message: ${error}`,
          });
        }
      }

      // Compact buffer periodically to prevent memory bloat
      if (buffer && buffer.length > GC_THRESHOLD) {
        buffer = Buffer.from(buffer);
        totalProcessed = 0;
      }

      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable);
      }
    };

    stdin.on('data', (chunk: Buffer) => {
      buffer = buffer ? Buffer.concat([buffer, chunk]) : chunk;
      processAvailable().catch(err => {
        this.logger.error(`Error in processAvailable: ${err}`);
      });
    });

    stdin.on('end', () => {
      this.logger.info('stdin ended - Chrome extension disconnected');
      buffer = null;
      this.stop().catch(() => {});
    });

    stdin.on('error', err => {
      this.logger.error(`stdin error: ${err}`);
      buffer = null;
      this.stop().catch(() => {});
    });
  }
  
  /** 获取默认 Socket 路径 */
  private getDefaultSocketPath(): string {
    const username = this.getUsername();
    const socketDir = `${SOCKET_DEFAULTS.DIR_TEMPLATE}-${username}`;
    return join(socketDir, `${process.pid}${SOCKET_DEFAULTS.FILE_EXTENSION}`);
  }
  
  /** 获取用户名 */
  private getUsername(): string {
    try {
      return userInfo().username || 'default';
    } catch {
      return process.env.USER || process.env.USERNAME || 'default';
    }
  }
  
  /** 清理过期的 Socket 文件 */
  private async cleanupStaleSockets(): Promise<void> {
    const socketDir = join(this.socketPath, '..');
    
    try {
      const files = await readdir(socketDir);
      for (const file of files) {
        if (!file.endsWith(SOCKET_DEFAULTS.FILE_EXTENSION)) continue;
        
        const pid = parseInt(file.replace(SOCKET_DEFAULTS.FILE_EXTENSION, ''), 10);
        if (isNaN(pid)) continue;
        
        try {
          process.kill(pid, 0);
          // 进程还在运行，保留 Socket
        } catch {
          // 进程已退出，删除过期 Socket
          const socketFile = join(socketDir, file);
          await unlink(socketFile).catch(() => {});
          this.logger.debug(`Removed stale socket: ${socketFile}`);
        }
      }
    } catch {
      // 忽略目录读取错误
    }
  }
}

/** 创建 Native Host 实例 */
export function createNativeHost(config?: NativeHostConfig): NativeHost {
  return new NativeHost(config);
}
