#!/usr/bin/env node
/**
 * Chrome Native Host - 可选 HTTP Server 架构
 * 
 * 启动模式:
 * 1. 轻量模式 (默认): 仅 Unix Domain Socket，服务 Claude Code CLI
 * 2. HTTP 模式 (可选): Socket + HTTP Server，支持多 AI 客户端
 * 
 * 启用方式:
 * - CLI 参数: --chrome-native-host [--http] [--http-port 12306]
 * - 环境变量: CLAUDE_CHROME_HTTP=1
 * - 配置文件: ~/.claude.json → chromeMcp.httpServer.enabled
 */

import { stdin, stdout } from 'process'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'net'
import { unlinkSync, rmdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

// ============================================================================
// 常量定义
// ============================================================================

const VERSION = '1.0.0'
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024 // 16MB
const MAX_PENDING_REQUESTS = 100
const HEARTBEAT_INTERVAL_MS = 30000
const HEARTBEAT_TIMEOUT_MS = 10000
const MAX_MESSAGES_PER_TICK = 100

const DEFAULT_HTTP_PORT = 12306
const DEFAULT_HTTP_HOST = '127.0.0.1'

// 消息类型枚举（兼容两种协议）
enum NativeMessageType {
  // OLA claude-in-chrome 协议
  START = 'start',
  STOP = 'stop',
  PING = 'ping',
  PONG = 'pong',
  CALL_TOOL = 'call_tool',
  TOOL_RESPONSE = 'tool_response',
  NOTIFICATION = 'notification',
  ERROR = 'error',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  MCP_CONNECTED = 'mcp_connected',
  MCP_DISCONNECTED = 'mcp_disconnected',
  HEARTBEAT_PING = 'heartbeat_ping',
  HEARTBEAT_PONG = 'heartbeat_pong',
  REQUEST_CANCELLED = 'request_cancelled',
  // mcp-chrome 协议
  STARTED = 'started',
  STOPPED = 'stopped',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
  EXECUTE_TOOL = 'EXECUTE_TOOL',
  TOOL_REQUEST = 'tool_request',
  RESPONSE_TO_REQUEST_ID = 'responseToRequestId',
}

// 超时配置
const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  TOOL_CALL_TIMEOUT: 120000,
} as const

// ============================================================================
// 类型定义
// ============================================================================

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason?: any) => void
  timeoutId: NodeJS.Timeout
  messageType: string
  messagePayload: any
}

interface HeartbeatState {
  lastSentTime: number
  lastReceivedTime: number
  pendingPong: boolean
  intervalId: NodeJS.Timeout | null
}

interface HttpServerConfig {
  enabled: boolean
  port: number
  host: string
  corsOrigins: (string | RegExp)[]
}

interface ChromeMessage {
  type: string
  method?: string
  params?: unknown
  payload?: any
  requestId?: string
  responseToRequestId?: string
  error?: string
  id?: number
}

// ============================================================================
// 配置解析
// ============================================================================

function parseHttpConfig(): HttpServerConfig {
  // 1. CLI 参数
  const args = process.argv.slice(2)
  const hasHttpFlag = args.includes('--http')
  const httpPortArg = args.find(a => a.startsWith('--http-port=')) || args.find((_, i) => args[i-1] === '--http-port')
  const httpHostArg = args.find(a => a.startsWith('--http-host=')) || args.find((_, i) => args[i-1] === '--http-host')
  const corsArg = args.find(a => a.startsWith('--cors-origins=')) || args.find((_, i) => args[i-1] === '--cors-origins')

  // 2. 环境变量
  const envHttp = process.env.CLAUDE_CHROME_HTTP === '1' || process.env.CLAUDE_CHROME_HTTP === 'true'
  const envHttpPort = process.env.CLAUDE_CHROME_HTTP_PORT
  const envHttpHost = process.env.CLAUDE_CHROME_HTTP_HOST
  const envCorsOrigins = process.env.CLAUDE_CHROME_CORS_ORIGINS
  const envMode = process.env.CLAUDE_CHROME_MODE // 'full' or 'light'

  // 3. 优先级: CLI > 环境变量 > 默认值
  const enabled = hasHttpFlag || envHttp || envMode === 'full'
  const port = parseInt(httpPortArg?.split('=')[1] || envHttpPort || String(DEFAULT_HTTP_PORT), 10)
  const host = httpHostArg?.split('=')[1] || envHttpHost || DEFAULT_HTTP_HOST
  
  // CORS 白名单解析
  const corsOrigins: (string | RegExp)[] = [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    'http://127.0.0.1',
  ]
  
  if (corsArg || envCorsOrigins) {
    const origins = (corsArg?.split('=')[1] || envCorsOrigins || '').split(',')
    for (const origin of origins) {
      const trimmed = origin.trim()
      if (trimmed) {
        corsOrigins.push(trimmed === '*' ? /.*/ : trimmed)
      }
    }
  }

  return { enabled, port, host, corsOrigins }
}

// ============================================================================
// HTTP Server 实现 (MCP over HTTP + SSE)
// ============================================================================

class ChromeHttpServer {
  private server: HttpServer | null = null
  private sseClients: Map<string, ServerResponse> = new Map()
  private mcpMessageHandler: ((message: any) => void) | null = null

  constructor(
    private config: HttpServerConfig,
    private nativeHost: NativeMessagingHost,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.on('error', (err) => {
        console.error(`[HTTP Server] Error: ${err}`)
        reject(err)
      })

      this.server.listen(this.config.port, this.config.host, () => {
        console.error(`[HTTP Server] Listening on ${this.config.host}:${this.config.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    // 关闭所有 SSE 连接
    for (const [id, res] of this.sseClients) {
      res.end()
      this.sseClients.delete(id)
    }

    if (this.server) {
      return new Promise(resolve => {
        this.server!.close(() => resolve())
      })
    }
  }

  setMcpMessageHandler(handler: (message: any) => void): void {
    this.mcpMessageHandler = handler
  }

  broadcastToSse(message: any): void {
    const data = JSON.stringify(message)
    for (const [id, res] of this.sseClients) {
      try {
        res.write(`data: ${data}\n\n`)
      } catch {
        this.sseClients.delete(id)
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const origin = req.headers.origin

    // CORS 检查
    if (origin) {
      const allowed = this.config.corsOrigins.some(pattern => {
        if (pattern instanceof RegExp) return pattern.test(origin)
        return pattern === origin
      })

      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      } else {
        res.writeHead(403)
        res.end('CORS origin not allowed')
        return
      }
    }

    // OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // SSE 连接
    if (url.pathname === '/sse' && req.method === 'GET') {
      this.handleSse(req, res)
      return
    }

    // MCP 消息端点
    if (url.pathname === '/mcp' && req.method === 'POST') {
      this.handleMcpMessage(req, res)
      return
    }

    // 健康检查
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        version: VERSION,
        mode: 'http',
        pendingRequests: this.nativeHost.getPendingRequestsCount(),
      }))
      return
    }

    // 默认 404
    res.writeHead(404)
    res.end('Not Found')
  }

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    const clientId = uuidv4()
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    // 发送初始事件
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)

    this.sseClients.set(clientId, res)
    console.error(`[HTTP Server] SSE client connected: ${clientId}`)

    res.on('close', () => {
      this.sseClients.delete(clientId)
      console.error(`[HTTP Server] SSE client disconnected: ${clientId}`)
    })
  }

  private handleMcpMessage(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const message = JSON.parse(body)
        
        // 转发到 Native Host
        if (this.mcpMessageHandler) {
          this.mcpMessageHandler(message)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted' }))
      } catch (error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
  }
}

// ============================================================================
// Unix Socket Server 实现 (轻量模式)
// ============================================================================

class UnixSocketServer {
  private server: NetServer | null = null
  private mcpClients = new Map<number, { socket: Socket; buffer: Buffer }>()
  private nextClientId = 1

  constructor(
    private socketPath: string,
    private nativeHost: NativeMessagingHost,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createNetServer(socket => this.handleMcpClient(socket))

      this.server.on('error', err => {
        console.error(`[Socket Server] Error: ${err}`)
        reject(err)
      })

      this.server.listen(this.socketPath, () => {
        console.error(`[Socket Server] Listening on ${this.socketPath}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const [, client] of this.mcpClients) {
      client.socket.destroy()
    }
    this.mcpClients.clear()

    if (this.server) {
      return new Promise(resolve => {
        this.server!.close(() => resolve())
      })
    }
  }

  broadcastToClients(message: any): void {
    const data = Buffer.from(JSON.stringify(message), 'utf-8')
    const lengthBuffer = Buffer.alloc(4)
    lengthBuffer.writeUInt32LE(data.length, 0)
    const msg = Buffer.concat([lengthBuffer, data])

    for (const [id, client] of this.mcpClients) {
      try {
        client.socket.write(msg)
      } catch (e) {
        console.error(`[Socket Server] Failed to send to client ${id}: ${e}`)
      }
    }
  }

  private handleMcpClient(socket: Socket): void {
    const clientId = this.nextClientId++
    const client = { socket, buffer: Buffer.alloc(0) }
    this.mcpClients.set(clientId, client)

    console.error(`[Socket Server] MCP client ${clientId} connected`)

    // 通知 Native Host
    this.nativeHost.sendMessage({ type: NativeMessageType.MCP_CONNECTED })

    socket.on('data', (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data])

      while (client.buffer.length >= 4) {
        const length = client.buffer.readUInt32LE(0)

        if (length === 0 || length > MAX_MESSAGE_SIZE) {
          console.error(`[Socket Server] Invalid message length: ${length}`)
          socket.destroy()
          return
        }

        if (client.buffer.length < 4 + length) break

        const messageBytes = client.buffer.slice(4, 4 + length)
        client.buffer = client.buffer.slice(4 + length)

        try {
          const message = JSON.parse(messageBytes.toString('utf-8'))
          // 转发到 Chrome Extension
          this.nativeHost.sendMessage({
            type: NativeMessageType.CALL_TOOL,
            method: message.method,
            params: message.params,
          })
        } catch (e) {
          console.error(`[Socket Server] Failed to parse message: ${e}`)
        }
      }
    })

    socket.on('close', () => {
      this.mcpClients.delete(clientId)
      console.error(`[Socket Server] MCP client ${clientId} disconnected`)
      this.nativeHost.sendMessage({ type: NativeMessageType.MCP_DISCONNECTED })
    })
  }
}

// ============================================================================
// Native Messaging Host 核心
// ============================================================================

class NativeMessagingHost {
  private pendingRequests: Map<string, PendingRequest> = new Map()
  private heartbeatState: HeartbeatState = {
    lastSentTime: 0,
    lastReceivedTime: Date.now(),
    pendingPong: false,
    intervalId: null,
  }
  private isShuttingDown = false
  private httpServer: ChromeHttpServer | null = null
  private socketServer: UnixSocketServer | null = null
  private mode: 'http' | 'socket' = 'socket'

  constructor(
    private httpConfig: HttpServerConfig,
    private socketPath: string,
  ) {}

  async start(): Promise<void> {
    console.error(`[NativeMessagingHost] Starting in ${this.httpConfig.enabled ? 'HTTP' : 'Socket'} mode`)

    // 启动消息处理
    this.setupMessageHandling()
    this.startHeartbeat()

    // 根据配置启动对应的服务器
    if (this.httpConfig.enabled) {
      this.mode = 'http'
      this.httpServer = new ChromeHttpServer(this.httpConfig, this)
      await this.httpServer.start()
    } else {
      this.mode = 'socket'
      this.socketServer = new UnixSocketServer(this.socketPath, this)
      await this.socketServer.start()
    }

    console.error(`[NativeMessagingHost] Started successfully in ${this.mode} mode`)
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    console.error('[NativeMessagingHost] Stopping...')

    this.stopHeartbeat()

    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error('Native host is shutting down'))
    }
    this.pendingRequests.clear()

    // 停止服务器
    if (this.httpServer) {
      await this.httpServer.stop()
    }
    if (this.socketServer) {
      await this.socketServer.stop()
    }

    console.error('[NativeMessagingHost] Stopped')
  }

  sendMessage(message: any): void {
    try {
      const messageString = JSON.stringify(message)
      const messageBuffer = Buffer.from(messageString, 'utf-8')
      const headerBuffer = Buffer.alloc(4)
      headerBuffer.writeUInt32LE(messageBuffer.length, 0)
      const fullBuffer = Buffer.concat([headerBuffer, messageBuffer])

      stdout.write(fullBuffer)
    } catch (error) {
      console.error(`[NativeMessagingHost] Failed to send message: ${error}`)
    }
  }

  sendRequestToExtensionAndWait(
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.isShuttingDown) {
        reject(new Error('Native host is shutting down'))
        return
      }

      if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
        reject(new Error('Too many pending requests'))
        return
      }

      const requestId = uuidv4()

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        this.sendMessage({
          type: NativeMessageType.REQUEST_CANCELLED,
          requestId,
          reason: `Request timed out after ${timeoutMs}ms`,
        })
        reject(new Error(`Request timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        messageType,
        messagePayload,
      })

      this.sendMessage({
        type: messageType,
        payload: messagePayload,
        requestId,
      })
    })
  }

  getPendingRequestsCount(): number {
    return this.pendingRequests.size
  }

  // ============================================================================
  // 消息处理
  // ============================================================================

  private setupMessageHandling(): void {
    let buffer = Buffer.alloc(0)
    let expectedLength = -1

    const processAvailable = async () => {
      let processed = 0
      while (processed < MAX_MESSAGES_PER_TICK) {
        if (expectedLength === -1) {
          if (buffer.length < 4) break
          expectedLength = buffer.readUInt32LE(0)
          buffer = buffer.subarray(4)

          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE) {
            this.sendError(`Invalid message length: ${expectedLength}`, 'INVALID_MESSAGE_LENGTH')
            expectedLength = -1
            buffer = Buffer.alloc(0)
            break
          }
        }

        if (buffer.length < expectedLength) break

        const messageBuffer = buffer.subarray(0, expectedLength)
        buffer = buffer.subarray(expectedLength)
        expectedLength = -1
        processed++

        try {
          const message = JSON.parse(messageBuffer.toString('utf-8'))
          await this.handleMessage(message)
        } catch (error) {
          this.sendError(`Failed to parse message: ${error}`, 'PARSE_ERROR')
        }
      }

      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable)
      }
    }

    stdin.on('readable', () => {
      let chunk
      while ((chunk = stdin.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk])
        processAvailable().catch(err => {
          console.error(`[NativeMessagingHost] Error in processAvailable: ${err}`)
        })
      }
    })

    stdin.on('end', () => {
      console.error('[NativeMessagingHost] stdin ended - Chrome extension disconnected')
      this.cleanup()
    })

    stdin.on('error', err => {
      console.error(`[NativeMessagingHost] stdin error: ${err}`)
      this.cleanup()
    })
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object') {
      this.sendError('Invalid message format', 'INVALID_FORMAT')
      return
    }

    // 更新心跳状态
    this.heartbeatState.lastReceivedTime = Date.now()
    this.heartbeatState.pendingPong = false

    // 处理响应（mcp-chrome 协议的 requestId 响应）
    if (message.responseToRequestId) {
      this.handleResponse(message)
      return
    }

    // 处理指令
    switch (message.type) {
      // ===== OLA claude-in-chrome 协议 =====
      case NativeMessageType.START:
        console.error(`[NativeMessagingHost] START message received`)
        this.sendMessage({
          type: NativeMessageType.SERVER_STARTED,
          payload: { mode: this.mode },
        })
        break

      case NativeMessageType.STOP:
        console.error('[NativeMessagingHost] STOP message received')
        await this.stop()
        this.sendMessage({ type: NativeMessageType.SERVER_STOPPED })
        break

      case NativeMessageType.PING:
        this.sendMessage({ type: NativeMessageType.PONG })
        break

      case NativeMessageType.TOOL_RESPONSE:
        // 转发给 MCP Clients
        if (this.mode === 'socket' && this.socketServer) {
          this.socketServer.broadcastToClients(message)
        } else if (this.mode === 'http' && this.httpServer) {
          this.httpServer.broadcastToSse(message)
        }
        break

      // ===== mcp-chrome 协议 =====
      case NativeMessageType.CALL_TOOL:
        // Extension 自发起的工具调用（带 requestId）
        if (message.requestId) {
          console.error(`[NativeMessagingHost] CALL_TOOL: ${message.payload?.name}`)
          this.handleCallToolWithRequestId(message)
        }
        break

      case NativeMessageType.EXECUTE_TOOL:
        // Extension 自执行工具命令
        if (message.requestId) {
          console.error(`[NativeMessagingHost] EXECUTE_TOOL: ${message.payload?.name}`)
          this.handleCallToolWithRequestId(message)
        }
        break

      case NativeMessageType.PROCESS_DATA:
        // 处理数据请求（mcp-chrome 协议）
        if (message.requestId) {
          console.error(`[NativeMessagingHost] PROCESS_DATA received`)
          this.sendMessage({
            responseToRequestId: message.requestId,
            payload: {
              status: 'success',
              message: 'Data processed',
              data: message.payload,
            },
          })
        }
        break

      case NativeMessageType.CONNECT_NATIVE:
      case NativeMessageType.ENSURE_NATIVE:
        // 连接请求（mcp-chrome 协议）
        console.error(`[NativeMessagingHost] ${message.type} received`)
        this.sendMessage({
          type: NativeMessageType.SERVER_STARTED,
          payload: { mode: this.mode, port: this.httpConfig.port },
        })
        break

      case NativeMessageType.PING_NATIVE:
        // 心跳检测（mcp-chrome 协议）
        this.sendMessage({
          type: NativeMessageType.PONG,
          connected: true,
          autoConnectEnabled: true,
        })
        break

      case NativeMessageType.DISCONNECT_NATIVE:
        // 断开连接（mcp-chrome 协议）
        console.error('[NativeMessagingHost] DISCONNECT_NATIVE received')
        this.sendMessage({ type: NativeMessageType.SERVER_STOPPED })
        break

      // ===== 通用消息 =====
      case NativeMessageType.TOOL_REQUEST:
        // OLA 协议：来自 MCP Client 的工具请求
        console.error(`[NativeMessagingHost] TOOL_REQUEST: ${message.method}`)
        // 转发给 Chrome Extension
        this.sendMessage({
          type: NativeMessageType.TOOL_REQUEST,
          method: message.method,
          params: message.params,
        })
        break

      default:
        console.error(`[NativeMessagingHost] Unknown message type: ${message.type}`)
    }
  }

  private handleResponse(message: any): void {
    const requestId = message.responseToRequestId
    const pending = this.pendingRequests.get(requestId)

    if (pending) {
      clearTimeout(pending.timeoutId)
      this.pendingRequests.delete(requestId)

      if (message.error) {
        pending.reject(new Error(message.error))
      } else {
        pending.resolve(message.payload)
      }
    }
  }

  /**
   * 处理带 requestId 的工具调用（mcp-chrome 协议）
   */
  private async handleCallToolWithRequestId(message: any): Promise<void> {
    const requestId = message.requestId
    const payload = message.payload || {}
    const toolName = payload.name || message.method
    const toolArgs = payload.args || message.params || {}

    console.error(`[NativeMessagingHost] Handling tool: ${toolName}`)

    try {
      // 转发给 Chrome Extension（使用 mcp-chrome 协议格式）
      this.sendMessage({
        type: NativeMessageType.CALL_TOOL,
        requestId,
        payload: {
          name: toolName,
          args: toolArgs,
        },
      })

      // 注意：实际响应会通过 handleResponse 方法处理
      // 这里不等待响应，因为 Extension 会异步返回结果
    } catch (error) {
      this.sendMessage({
        responseToRequestId: requestId,
        payload: {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  // ============================================================================
  // 心跳机制
  // ============================================================================

  private startHeartbeat(): void {
    this.heartbeatState.intervalId = setInterval(() => {
      if (this.isShuttingDown) {
        this.stopHeartbeat()
        return
      }

      const now = Date.now()
      const timeSinceLastReceived = now - this.heartbeatState.lastReceivedTime

      if (timeSinceLastReceived > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
        console.error('[NativeMessagingHost] Heartbeat timeout - connection may be dead, not exiting (will rely on stdin close)')
        this.stopHeartbeat()
        return
      }

      if (!this.heartbeatState.pendingPong) {
        this.heartbeatState.lastSentTime = now
        this.heartbeatState.pendingPong = true
        this.sendMessage({ type: NativeMessageType.HEARTBEAT_PING })
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatState.intervalId) {
      clearInterval(this.heartbeatState.intervalId)
      this.heartbeatState.intervalId = null
    }
  }

  // ============================================================================
  // 清理
  // ============================================================================

  private sendError(errorMessage: string, code?: string): void {
    console.error(`[NativeMessagingHost] ERROR: ${errorMessage} (${code || 'unknown'})`)
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST,
      payload: { success: false, error: errorMessage, code: code || 'UNKNOWN_ERROR' },
    })
  }

  private cleanup(): void {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    console.error('[NativeMessagingHost] Cleanup called')
    this.stopHeartbeat()

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error('Native host is shutting down or Chrome disconnected'))
    }
    this.pendingRequests.clear()

    // Clean up socket file
    try {
      const username = process.env.USER || process.env.USERNAME || 'default'
      const socketDir = `/tmp/claude-mcp-browser-bridge-${username}`
      const socketFile = join(socketDir, `${process.pid}.sock`)
      unlinkSync(socketFile)
      console.error(`[NativeMessagingHost] Removed socket: ${socketFile}`)
      // Remove directory if empty
      const remaining = readdirSync(socketDir)
      if (remaining.length === 0) {
        rmdirSync(socketDir)
        console.error(`[NativeMessagingHost] Removed empty socket directory: ${socketDir}`)
      }
    } catch (e) {
      // Ignore cleanup errors - socket may already be gone
    }

    process.exit(0)
  }
}

// ============================================================================
// 启动入口
// ============================================================================

async function main(): Promise<void> {
  console.error('[NativeMessagingHost] ======================================================')
  console.error('[NativeMessagingHost] Chrome Native Host starting...')
  console.error('[NativeMessagingHost] PID:', process.pid)
  console.error('[NativeMessagingHost] Node.js:', process.version)
  console.error('[NativeMessagingHost] Platform:', process.platform)
  console.error('[NativeMessagingHost] ======================================================')

  // 解析配置
  const httpConfig = parseHttpConfig()
  const socketPath = `/tmp/claude-mcp-browser-bridge-${process.env.USER || 'default'}/${process.pid}.sock`

  // 创建并启动 Native Host
  const nativeHost = new NativeMessagingHost(httpConfig, socketPath)

  try {
    await nativeHost.start()
    console.error(`[NativeMessagingHost] Running in ${httpConfig.enabled ? 'HTTP' : 'Socket'} mode`)
  } catch (error) {
    console.error(`[NativeMessagingHost] FATAL: Failed to start: ${error}`)
    process.exit(1)
  }

  // 信号处理
  process.on('SIGINT', () => {
    console.error('[NativeMessagingHost] SIGINT received')
    nativeHost.stop().then(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    console.error('[NativeMessagingHost] SIGTERM received')
    nativeHost.stop().then(() => process.exit(0))
  })

  process.on('uncaughtException', error => {
    console.error(`[NativeMessagingHost] Uncaught exception: ${error}`)
    process.exit(1)
  })

  process.on('unhandledRejection', reason => {
    console.error(`[NativeMessagingHost] Unhandled rejection: ${reason}`)
  })

  // stdin 关闭时退出
  stdin.on('end', () => {
    console.error('[NativeMessagingHost] stdin ended, exiting')
    nativeHost.stop().then(() => process.exit(0))
  })
}

main().catch(error => {
  console.error(`[NativeMessagingHost] Fatal error: ${error}`)
  process.exit(1)
})
