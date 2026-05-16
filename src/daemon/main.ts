import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import type { DaemonRequest, DaemonResponse } from './protocol.js'
import { createDaemonSocketServer, getSocketPath, getPidFilePath } from './socketServer.js'
import {
  registerSession,
  listSessions,
  getSession,
  updateSession,
  cleanupDeadSessions,
  type SessionEntry,
} from './sessionRegistry.js'

function generateSessionId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

async function ensureLogPath(id: string): Promise<string> {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  return path.join(logDir, `${id}.log`)
}

async function handleRequest(req: DaemonRequest): Promise<DaemonResponse> {
  try {
    switch (req.type) {
      case 'ping':
        return { type: 'ok', data: { version: 1 } }

      case 'list_sessions': {
        await cleanupDeadSessions()
        const sessions = await listSessions()
        return { type: 'ok', data: sessions }
      }

      case 'get_session': {
        const session = await getSession(req.id)
        if (!session) {
          return { type: 'error', message: 'Session not found', code: 'NOT_FOUND' }
        }
        return { type: 'ok', data: session }
      }

      case 'kill_session': {
        const session = await getSession(req.id)
        if (!session) {
          return { type: 'error', message: 'Session not found', code: 'NOT_FOUND' }
        }
        try {
          process.kill(session.pid, 'SIGTERM')
          await updateSession(req.id, { status: 'killed' })
          return { type: 'ok' }
        } catch (err) {
          return { type: 'error', message: `Failed to kill process: ${err}`, code: 'KILL_FAILED' }
        }
      }

      case 'start_session': {
        const id = generateSessionId()
        const entry: SessionEntry = {
          id,
          pid: 0,
          status: 'running',
          prompt: req.prompt,
          workdir: req.workdir,
          startedAt: Date.now(),
          lastActivity: Date.now(),
        }
        await registerSession(entry)

        // Spawn worker via CLI self-invocation
        const logPath = await ensureLogPath(id)
        const child = spawn(
          process.execPath,
          [process.argv[1], '--bg-worker', id, '--', req.prompt],
          {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: req.workdir,
          },
        )

        entry.pid = child.pid!
        entry.logPath = logPath
        await registerSession(entry)

        child.stdout?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))
        child.stderr?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))

        child.on('exit', code => {
          updateSession(id, {
            status: code === 0 ? 'completed' : 'failed',
            exitCode: code ?? -1,
          }).catch(() => {})
        })

        child.unref()
        return { type: 'ok', data: { id } }
      }

      case 'get_logs': {
        const session = await getSession(req.id)
        if (!session?.logPath) {
          return { type: 'error', message: 'No logs available', code: 'NO_LOGS' }
        }
        try {
          const data = fs.readFileSync(session.logPath, 'utf-8')
          const lines = data.split('\n')
          const tail = req.tail ?? 100
          return { type: 'ok', data: { logs: lines.slice(-tail).join('\n') } }
        } catch {
          return { type: 'error', message: 'Log file not found', code: 'NOT_FOUND' }
        }
      }

      default:
        return { type: 'error', message: 'Unknown request', code: 'UNKNOWN' }
    }
  } catch (err) {
    return { type: 'error', message: String(err), code: 'INTERNAL' }
  }
}

export async function daemonMain(args: string[] = []): Promise<void> {
  const pidFile = getPidFilePath()

  // Check if daemon is already running
  try {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    try {
      process.kill(existingPid, 0)
      console.log(`Daemon already running (PID: ${existingPid})`)
      return
    } catch {
      // Stale PID file, clean up
      try { fs.unlinkSync(pidFile) } catch {}
    }
  } catch {
    // No PID file, proceed to start
  }

  // Handle subcommands
  if (args[0] === 'stop') {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      process.kill(pid, 'SIGTERM')
      fs.unlinkSync(pidFile)
      console.log('Daemon stopped.')
    } catch {
      console.log('Daemon is not running.')
      // Clean up stale PID file
      try { fs.unlinkSync(pidFile) } catch {}
    }
    return
  }

  if (args[0] === 'status') {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      process.kill(pid, 0)
      console.log(`Daemon is running (PID: ${pid})`)
      console.log(`Socket: ${getSocketPath()}`)
    } catch {
      console.log('Daemon is not running.')
    }
    return
  }

  // Start daemon
  const server = createDaemonSocketServer({ handleRequest })

  await new Promise<void>((resolve, reject) => {
    server.listen(getSocketPath(), () => {
      try {
        fs.chmodSync(getSocketPath(), 0o600)
      } catch {}
      fs.writeFileSync(pidFile, String(process.pid))
      console.log(`Daemon started (PID: ${process.pid})`)
      console.log(`Socket: ${getSocketPath()}`)
      resolve()
    })
    server.on('error', reject)
  })

  // Handle graceful shutdown
  const shutdown = () => {
    server.close(() => {
      try { fs.unlinkSync(getSocketPath()) } catch {}
      try { fs.unlinkSync(pidFile) } catch {}
      process.exit(0)
    })
    // Force exit after timeout
    setTimeout(() => process.exit(1), 5000)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
