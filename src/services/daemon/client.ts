import net from 'net'
import path from 'path'
import os from 'os'
import type { DaemonRequest, DaemonResponse } from '../../daemon/protocol.js'

function getSocketPath(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'daemon.sock')
}

export async function isDaemonRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: getSocketPath() })
    const timeout = setTimeout(() => { socket.destroy(); resolve(false) }, 1000)

    socket.on('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })

    socket.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

export async function sendDaemonRequest(req: DaemonRequest): Promise<DaemonResponse> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: getSocketPath() })
    let buffer = ''

    socket.on('data', data => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line) as DaemonResponse)
            socket.destroy()
            return
          } catch {
            // Invalid JSON, continue waiting
          }
        }
      }
    })

    socket.on('error', () => {
      resolve({ type: 'error', message: 'Daemon not running', code: 'DAEMON_UNAVAILABLE' })
    })

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n')
    })

    setTimeout(() => {
      socket.destroy()
      resolve({ type: 'error', message: 'Daemon request timed out', code: 'TIMEOUT' })
    }, 5000)
  })
}
