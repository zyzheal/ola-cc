import net from 'net'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DaemonRequest, DaemonResponse } from './protocol.js'

export function getSocketPath(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'daemon.sock')
}

export function getPidFilePath(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'daemon.pid')
}

export function createDaemonSocketServer(handlers: {
  handleRequest: (req: DaemonRequest) => Promise<DaemonResponse>
}): net.Server {
  const socketPath = getSocketPath()

  // Remove stale socket — only ignore ENOENT (file doesn't exist), log other errors
  try { fs.unlinkSync(socketPath) } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[daemon] Failed to remove stale socket ${socketPath}:`, e)
    }
  }

  const server = net.createServer(socket => {
    let buffer = ''

    socket.on('data', async data => {
      buffer += data.toString()

      // Each message is newline-delimited JSON
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const req = JSON.parse(line) as DaemonRequest
          const res = await handlers.handleRequest(req)
          socket.write(JSON.stringify(res) + '\n')
        } catch (err) {
          const errorRes: DaemonResponse = {
            type: 'error',
            message: `Invalid request: ${err}`,
            code: 'INVALID_REQUEST',
          }
          socket.write(JSON.stringify(errorRes) + '\n')
        }
      }
    })

    socket.on('error', () => {
      // Client disconnected
    })
  })

  return server
}
