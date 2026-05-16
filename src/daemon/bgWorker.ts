import path from 'path'
import os from 'os'
import fs from 'fs'
import { updateSession } from './sessionRegistry.js'

/**
 * Run as a background worker process.
 * Executes the given prompt as a non-interactive session.
 */
export async function runBgWorker(sessionId: string, prompt: string): Promise<void> {
  const logPath = await ensureLogPath(sessionId)

  // Redirect stdout/stderr to log file
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })

  // Intercept console methods only (stdout/stderr from subprocess go directly to pipe)
  const redirectConsole = (method: 'log' | 'error' | 'warn' | 'info', ...args: any[]) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    logStream.write(text + '\n')
  }

  console.log = (...args: any[]) => redirectConsole('log', ...args)
  console.error = (...args: any[]) => redirectConsole('error', ...args)
  console.warn = (...args: any[]) => redirectConsole('warn', ...args)
  console.info = (...args: any[]) => redirectConsole('info', ...args)

  try {
    await updateSession(sessionId, { lastActivity: Date.now() })

    console.log(`Worker started for session ${sessionId}`)
    console.log(`Prompt: ${prompt}`)

    // Clean up process.argv so main.tsx's Commander doesn't see --bg-worker
    // Replace argv with a clean --print invocation BEFORE importing main
    process.argv = [process.argv[0], process.argv[1], '--print', prompt]

    // Load the main query engine and execute non-interactively
    const { main: queryMain } = await import('../main.js')
    await queryMain()

    await updateSession(sessionId, {
      status: 'completed',
      exitCode: 0,
      lastActivity: Date.now(),
    })

    console.log(`Worker completed for session ${sessionId}`)
  } catch (err) {
    console.error(`Worker error: ${err}`)
    await updateSession(sessionId, {
      status: 'failed',
      exitCode: -1,
      lastActivity: Date.now(),
    })
  } finally {
    logStream.end()
  }
}

async function ensureLogPath(id: string): Promise<string> {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  return path.join(logDir, `${id}.log`)
}
