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
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)

  process.stdout.write = (chunk: any, ...args: any[]) => {
    logStream.write(typeof chunk === 'string' ? chunk : String(chunk))
    return originalStdoutWrite(chunk, ...args)
  }
  process.stderr.write = (chunk: any, ...args: any[]) => {
    logStream.write(typeof chunk === 'string' ? chunk : String(chunk))
    return originalStderrWrite(chunk, ...args)
  }

  // Intercept console methods
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  }

  const redirectConsole = (method: 'log' | 'error' | 'warn' | 'info', ...args: any[]) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    logStream.write(text + '\n')
    originalConsole[method](...args)
  }

  console.log = (...args: any[]) => redirectConsole('log', ...args)
  console.error = (...args: any[]) => redirectConsole('error', ...args)
  console.warn = (...args: any[]) => redirectConsole('warn', ...args)
  console.info = (...args: any[]) => redirectConsole('info', ...args)

  try {
    await updateSession(sessionId, { lastActivity: Date.now() })

    console.log(`Worker started for session ${sessionId}`)
    console.log(`Prompt: ${prompt}`)

    // Load the main query engine and execute non-interactively
    const { main: queryMain } = await import('../main.js')
    const result = await queryMain({
      bgMode: true,
      bgSessionId: sessionId,
      initialPrompt: prompt,
    })

    await updateSession(sessionId, {
      status: result?.success ? 'completed' : 'failed',
      exitCode: result?.success ? 0 : 1,
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
