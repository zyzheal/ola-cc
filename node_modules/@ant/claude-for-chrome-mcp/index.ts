/**
 * @ant/claude-for-chrome-mcp
 * 
 * MCP Server implementation for Claude in Chrome browser automation.
 * Provides tools for interacting with web pages through Chrome extension.
 * 
 * Architecture:
 * - MCP Server (this module) communicates with Native Host via Unix Domain Socket
 * - Native Host bridges between MCP Server and Chrome Extension
 * - Chrome Extension executes browser tools
 */

import {
  McpServer,
  type Transport,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { connect as netConnect, type Socket } from 'net'
import { z } from 'zod'

// ============================================================================
// Types
// ============================================================================

export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan'

export type Logger = {
  silly?(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type BridgeConfig = {
  url: string
  getUserId: () => Promise<string>
  getOAuthToken: () => Promise<string>
  devUserId?: string
}

export type ClaudeForChromeContext = {
  serverName?: string
  logger?: Logger
  socketPath?: string
  getSocketPaths?: () => string[]
  clientTypeId?: string
  onAuthenticationError?: () => void
  onToolCallDisconnected?: () => string
  onExtensionPaired?: (deviceId: string, name: string) => void
  getPersistedDeviceId?: () => string | undefined
  bridgeConfig?: BridgeConfig
  initialPermissionMode?: PermissionMode
  callAnthropicMessages?: (req: {
    model: string
    max_tokens: number
    system: string
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
    stop_sequences?: string[]
    signal?: AbortSignal
  }) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    stop_reason: string | null
    usage?: { input_tokens: number; output_tokens: number }
  }>
  trackEvent?: (eventName: string, metadata?: Record<string, unknown>) => void
}

export type BrowserToolDefinition = {
  name: string
  description: string
  inputSchema: z.ZodType
  execute: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}

// ============================================================================
// Browser Tools Definitions
// ============================================================================

const ToolResultSchema = z.object({
  content: z.array(z.object({
    type: z.string(),
    text: z.string(),
  })),
  isError: z.boolean().optional(),
})

function createBrowserTool(
  name: string,
  description: string,
  inputSchema: z.ZodObject<any>,
): BrowserToolDefinition {
  return {
    name,
    description,
    inputSchema,
    execute: async (_args: Record<string, unknown>) => {
      // Implementation will be provided by the actual tool handler
      return {
        content: [{ type: 'text', text: 'Tool execution placeholder' }],
      }
    },
  }
}

export const BROWSER_TOOLS: Array<{ name: string; description: string }> = [
  {
    name: 'tabs_context_mcp',
    description: 'Get information about the user\'s current browser tabs. Call this first to understand the current browser state.',
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser.',
  },
  {
    name: 'browser_click',
    description: 'Click on an element on the page.',
  },
  {
    name: 'browser_fill_form',
    description: 'Fill out form fields on the page.',
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page or a specific element.',
  },
  {
    name: 'read_page',
    description: 'Read the content of the current page.',
  },
  {
    name: 'read_console_messages',
    description: 'Read console messages from the browser devtools.',
  },
  {
    name: 'browser_close_tabs',
    description: 'Close browser tabs.',
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch to a different browser tab.',
  },
  {
    name: 'keyboard',
    description: 'Simulate keyboard input.',
  },
  {
    name: 'file_upload',
    description: 'Upload a file to the current page.',
  },
  {
    name: 'handle_dialog',
    description: 'Handle browser dialogs (alert, confirm, prompt).',
  },
  {
    name: 'gif_recorder',
    description: 'Record browser actions as a GIF.',
  },
  {
    name: 'element_picker',
    description: 'Pick elements on the page for interaction.',
  },
  {
    name: 'inject_script',
    description: 'Inject and execute JavaScript in the page.',
  },
  {
    name: 'web_fetcher',
    description: 'Fetch web content using the native host.',
  },
  {
    name: 'network_request',
    description: 'Make network requests from the native host.',
  },
  {
    name: 'browser_task',
    description: 'Execute a high-level browser automation task using AI reasoning.',
  },
  {
    name: 'lightning_turn',
    description: 'Execute a single turn in the lightning browser automation loop.',
  },
]

// ============================================================================
// Native Host Communication
// ============================================================================

const MAX_MESSAGE_SIZE = 1024 * 1024 // 1MB

type NativeHostMessage = {
  type: string
  method?: string
  params?: unknown
  result?: unknown
  error?: string
  id?: number
}

class NativeHostConnection {
  private socket: Socket | null = null
  private messageQueue: Array<{
    resolve: (value: NativeHostMessage) => void
    reject: (error: Error) => void
    method: string
  }> = []
  private pendingId = 0
  private buffer = Buffer.alloc(0)
  private logger: Logger | undefined

  constructor(
    private socketPath: string,
    logger?: Logger,
  ) {
    this.logger = logger
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger?.debug(`Connecting to Native Host: ${this.socketPath}`)
      
      this.socket = netConnect(this.socketPath, () => {
        this.logger?.info('Connected to Native Host')
        resolve()
      })

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data)
      })

      this.socket.on('error', (err) => {
        this.logger?.error(`Native Host socket error: ${err}`)
        reject(err)
      })

      this.socket.on('close', () => {
        this.logger?.warn('Native Host socket closed')
        this.socket = null
        // Reject all pending messages
        for (const pending of this.messageQueue) {
          pending.reject(new Error('Native Host connection closed'))
        }
        this.messageQueue = []
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!this.socket?.connected) {
          reject(new Error('Native Host connection timeout'))
        }
      }, 30000)
    })
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])

    // Process complete messages
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)

      if (length === 0 || length > MAX_MESSAGE_SIZE) {
        this.logger?.error(`Invalid message length: ${length}`)
        return
      }

      if (this.buffer.length < 4 + length) {
        break // Wait for more data
      }

      const messageBytes = this.buffer.slice(4, 4 + length)
      this.buffer = this.buffer.slice(4 + length)

      try {
        const message = JSON.parse(messageBytes.toString('utf-8')) as NativeHostMessage
        this.handleMessage(message)
      } catch (e) {
        this.logger?.error(`Failed to parse message: ${e}`)
      }
    }
  }

  private handleMessage(message: NativeHostMessage): void {
    // Find matching pending request by method
    const index = this.messageQueue.findIndex(p => p.method === message.method)
    if (index !== -1) {
      const pending = this.messageQueue[index]
      this.messageQueue.splice(index, 1)
      pending.resolve(message)
    } else {
      this.logger?.debug(`Received unsolicited message: ${message.type}`)
    }
  }

  async sendRequest(method: string, params?: unknown): Promise<NativeHostMessage> {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Not connected to Native Host')
    }

    const id = ++this.pendingId
    const message: NativeHostMessage = {
      type: 'tool_request',
      method,
      params,
      id,
    }

    const json = JSON.stringify(message)
    const jsonBytes = Buffer.from(json, 'utf-8')
    const lengthBuffer = Buffer.alloc(4)
    lengthBuffer.writeUInt32LE(jsonBytes.length, 0)

    return new Promise((resolve, reject) => {
      this.messageQueue.push({ resolve, reject, method })

      this.socket!.write(lengthBuffer)
      this.socket!.write(jsonBytes)

      // Timeout after 60 seconds
      setTimeout(() => {
        const index = this.messageQueue.findIndex(p => p.method === method)
        if (index !== -1) {
          this.messageQueue.splice(index, 1)
          reject(new Error(`Tool call timeout: ${method}`))
        }
      }, 60000)
    })
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }
}

// ============================================================================
// Tool Execution Handler
// ============================================================================

function createToolHandler(
  toolName: string,
  nativeHost: NativeHostConnection,
  logger?: Logger,
) {
  return async (args: Record<string, unknown>) => {
    try {
      logger?.debug(`Executing tool: ${toolName}`, args)

      const response = await nativeHost.sendRequest(toolName, args)

      if (response.error) {
        logger?.error(`Tool ${toolName} failed: ${response.error}`)
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true,
        }
      }

      const result = response.result ?? response
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      logger?.error(`Tool ${toolName} execution failed: ${error}`)
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  }
}

// ============================================================================
// MCP Server Factory
// ============================================================================

export function createClaudeForChromeMcpServer(
  context: ClaudeForChromeContext,
) {
  const logger = context.logger
  const serverName = context.serverName ?? 'claude-in-chrome'

  // Create MCP Server
  const server = new McpServer(
    {
      name: serverName,
      version: '0.4.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  // Native Host connection (lazy init)
  let nativeHost: NativeHostConnection | null = null

  async function getNativeHost(): Promise<NativeHostConnection> {
    if (!nativeHost) {
      const socketPath = context.socketPath
      if (!socketPath) {
        throw new Error('socketPath not provided in context')
      }
      nativeHost = new NativeHostConnection(socketPath, logger)
      await nativeHost.connect()
    }
    return nativeHost
  }

  // Register browser tools
  for (const toolDef of BROWSER_TOOLS) {
    server.tool(
      toolDef.name,
      toolDef.description,
      async (args: Record<string, unknown>) => {
        try {
          const connection = await getNativeHost()
          const handler = createToolHandler(toolDef.name, connection, logger)
          return await handler(args)
        } catch (error) {
          const disconnectedMsg = context.onToolCallDisconnected?.()
          return {
            content: [{
              type: 'text',
              text: disconnectedMsg ?? `Browser extension is not connected. Error: ${error}`,
            }],
            isError: true,
          }
        }
      },
    )
  }

  // Return server interface compatible with the expected API
  return {
    async connect(transport: Transport): Promise<void> {
      logger?.info(`Connecting ${serverName} MCP server`)
      await server.connect(transport)
      logger?.info(`${serverName} MCP server connected`)
    },

    setRequestHandler(
      _schema: typeof CallToolRequestSchema | typeof ListToolsRequestSchema,
      _handler: (request: CallToolRequest | ListToolsRequest, extra: ServerRequestOptions) => Promise<any>,
    ): void {
      // The McpServer class handles request handlers internally
      logger?.debug('setRequestHandler called (no-op for McpServer)')
    },

    async close(): Promise<void> {
      logger?.info(`Closing ${serverName} MCP server`)
      nativeHost?.close()
      nativeHost = null
      await server.close()
      logger?.info(`${serverName} MCP server closed`)
    },
  }
}
