/**
 * ActionServer — Local HTTP server for A2UI Action callbacks
 *
 * Listens on localhost for browser Action POST requests.
 * Validates authentication tokens (X-A2UI-Token).
 * Limits request body size and action history.
 */

import * as http from 'http'
import { randomBytes } from 'crypto'
import type { A2UIAction, ActionCallback, ActionServerConfig } from './types.js'

const DEFAULT_CONFIG: ActionServerConfig = {
  port: 28900,
  host: '127.0.0.1',
  maxBodySize: 1024 * 1024, // 1MB
}

export class ActionServer {
  private server: http.Server | null = null
  private actions: A2UIAction[] = []
  private readonly maxActions = 1000
  private callback: ActionCallback | null = null
  private actionTokens = new Set<string>()
  private config: ActionServerConfig
  port: number

  constructor(config?: Partial<ActionServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.port = this.config.port
  }

  generateActionToken(): string {
    const token = randomBytes(32).toString('hex')
    this.actionTokens.add(token)
    return token
  }

  private verifyActionToken(token: string | undefined): boolean {
    return !!token && this.actionTokens.has(token)
  }

  async ensureRunning(): Promise<void> {
    if (this.server) return
    this.port = await findAvailablePort(this.config.port)
    await this.start()
  }

  private async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.port, this.config.host, () => resolve())
      this.server.on('error', reject)
    })
  }

  onAction(callback: ActionCallback): void {
    this.callback = callback
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS
    const origin = req.headers.origin
    if (origin === 'null' || origin?.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', origin!)
    }
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, DELETE, OPTIONS',
    )
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-A2UI-Token',
    )

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/a2ui/action') {
      await this.handleAction(req, res)
    } else if (req.method === 'GET' && url.pathname === '/a2ui/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
    } else if (req.method === 'GET' && url.pathname === '/a2ui/surfaces') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const surfaces = [
        ...new Set(this.actions.map((a) => a.surfaceId)),
      ]
      res.end(JSON.stringify({ surfaces }))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  private async handleAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Auth
    const token = req.headers['x-a2ui-token'] as string | undefined
    if (!this.verifyActionToken(token)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Invalid or missing action token' }))
      return
    }

    // Read body with size limit
    let body: string
    try {
      body = await this.readBody(req)
    } catch {
      res.writeHead(413)
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    // Parse JSON
    let action: A2UIAction
    try {
      action = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    // Validate required fields
    if (!action.surfaceId || !action.actionId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Missing surfaceId or actionId' }))
      return
    }

    // Action whitelist
    if (!this.isActionAllowed(action)) {
      res.writeHead(403)
      res.end(
        JSON.stringify({
          error: `Action '${action.actionType}' not allowed`,
        }),
      )
      return
    }

    // LRU eviction
    if (this.actions.length >= this.maxActions) {
      this.actions.splice(0, this.actions.length - this.maxActions + 1)
    }

    this.actions.push(action)

    if (this.callback) {
      const result = await this.callback(action)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', actionId: action.actionId }))
    }
  }

  private isActionAllowed(action: A2UIAction): boolean {
    const allowedActions = ['onClick', 'onChange', 'onSubmit']
    return allowedActions.includes(action.actionType)
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalSize = 0

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length
        if (totalSize > this.config.maxBodySize) {
          req.destroy()
          reject(new Error('Request body too large'))
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })

      req.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    this.actionTokens.clear()
  }
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = http.createServer()
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve())
        })
        server.on('error', reject)
      })
      return port
    } catch {
      continue
    }
  }
  throw new Error('No available port found')
}
