// Warm Worker Process - pre-spawned worker that waits for work assignments

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { WarmWorkerAssign, WarmWorkerAck } from './protocol.js'
import { logForDebugging } from '../utils/debug'

interface PendingWork {
  sessionId: string
  prompt: string
  workdir: string
  logPath: string
}

async function executeWork(work: PendingWork): Promise<void> {
  logForDebugging(`Warm worker starting work on session ${work.sessionId}`)

  // Spawn the actual work process via CLI self-invocation
  const child = spawn(
    process.execPath,
    ['--bg-worker', work.sessionId, '--', work.prompt],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: work.workdir,
    },
  )

  // Ensure log directory exists and pipe output to the log file
  fs.mkdirSync(path.dirname(work.logPath), { recursive: true })
  const logStream = fs.createWriteStream(work.logPath, { flags: 'a' })
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)

  child.on('exit', code => {
    logForDebugging(`Session ${work.sessionId} exited with code ${code}`)
    logStream.end()
    // After work is done, this warm worker exits (daemon will replenish)
    process.exit(code ?? 0)
  })

  child.unref()
}

export async function warmWorkerMain(workerId?: string): Promise<void> {
  // Signal readiness to parent (daemon)
  if (process.send) {
    process.send({ type: 'warm_ready' })
  }

  // Wait for work assignment
  process.on('message', async (data: unknown) => {
    const msg = data as WarmWorkerAssign
    if (msg.type !== 'assign_work') return

    // Acknowledge the work assignment
    if (process.send) {
      process.send({ type: 'work_ack', sessionId: msg.sessionId } satisfies WarmWorkerAck)
    }

    // Execute the work
    await executeWork({
      sessionId: msg.sessionId,
      prompt: msg.prompt,
      workdir: msg.workdir,
      logPath: msg.logPath,
    })
  })

  // Handle graceful shutdown while idle
  process.on('SIGTERM', () => {
    logForDebugging('Warm worker shutting down (idle)')
    process.exit(0)
  })
}

warmWorkerMain().catch(err => {
  logForDebugging(`Warm worker error: ${err}`)
  process.exit(1)
})
