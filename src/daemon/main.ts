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
import { WarmPool } from './warmPool.js'

const warmPool = new WarmPool()

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
        const logPath = await ensureLogPath(id)
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

        // Try to use a warm worker from the pool
        const warmWorker = warmPool.acquireWorker()
        if (warmWorker) {
          // Assign work to warm worker via IPC
          const assigned = await warmPool.assignWork(warmWorker, {
            type: 'assign_work',
            sessionId: id,
            prompt: req.prompt,
            workdir: req.workdir,
            logPath,
          })

          if (assigned) {
            // Worker accepted the work - update session with worker PID
            entry.pid = warmWorker.pid
            entry.logPath = logPath
            entry.usedWarmPool = true
            await registerSession(entry)

            // Replenish pool asynchronously
            warmPool.replenish().catch(err => {
              console.error('[daemon] warm pool replenish failed:', err)
            })
            return { type: 'ok', data: { id } }
          }
          // If assignment failed, fall through to regular spawn
        }

        // Fallback: spawn worker via CLI self-invocation
        const child = spawn(
          process.execPath,
          ['--bg-worker', id, '--', req.prompt],
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
          // Intentionally silent: session status update failure is non-critical
          updateSession(id, {
            status: code === 0 ? 'completed' : 'failed',
            exitCode: code ?? -1,
          }).catch(() => {})
        })

        child.unref()
        return { type: 'ok', data: { id } }
      }

      case 'get_warm_pool_status': {
        return { type: 'ok', data: warmPool.getStatus() }
      }

      case 'set_warm_pool_size': {
        warmPool.setTargetSize(req.size)
        return { type: 'ok', data: warmPool.getStatus() }
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
      try { fs.unlinkSync(pidFile) } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[daemon] Failed to remove stale PID file ${pidFile}:`, e)
        }
      }
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
      try { fs.unlinkSync(pidFile) } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[daemon] Failed to remove stale PID file ${pidFile}:`, e)
        }
      }
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

  // Initialize warm pool
  await warmPool.initialize()

  await new Promise<void>((resolve, reject) => {
    server.listen(getSocketPath(), () => {
      try {
        fs.chmodSync(getSocketPath(), 0o600)
      } catch (e: unknown) {
        console.error(`[daemon] Failed to chmod socket ${getSocketPath()}:`, e)
      }
      fs.writeFileSync(pidFile, String(process.pid))
      console.log(`Daemon started (PID: ${process.pid})`)
      console.log(`Socket: ${getSocketPath()}`)
      resolve()
    })
    server.on('error', reject)
  })

  // Handle graceful shutdown
  const shutdown = async () => {
    await warmPool.shutdown()
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
