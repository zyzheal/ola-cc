import { spawn, execSync } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'fs'
import {
  registerSession,
  listSessions,
  getSession,
  updateSession,
  cleanupDeadSessions,
  type SessionEntry,
} from '../daemon/sessionRegistry.js'

function generateSessionId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function getSessionLogPath(id: string): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  return path.join(logDir, `${id}.log`)
}

/**
 * Handle `ola-cc --bg "prompt"` - start a background session
 */
export async function handleBgFlag(args: string[]): Promise<void> {
  await cleanupDeadSessions()

  const bgIndex = args.indexOf('--bg')
  const bgIndexAlt = args.indexOf('--background')
  const index = bgIndex >= 0 ? bgIndex : bgIndexAlt
  if (index < 0) {
    console.error('Usage: ola-cc --bg "your prompt here"')
    process.exit(1)
  }

  const prompt = args[index + 1]
  if (!prompt) {
    console.error('Error: --bg requires a prompt argument')
    console.error('Usage: ola-cc --bg "your prompt here"')
    process.exit(1)
  }

  const id = generateSessionId()
  const logPath = getSessionLogPath(id)

  // Ensure log directory exists
  fs.mkdirSync(path.dirname(logPath), { recursive: true })

  const sessionEntry: SessionEntry = {
    id,
    pid: 0,
    status: 'running',
    prompt,
    workdir: process.cwd(),
    startedAt: Date.now(),
    lastActivity: Date.now(),
    logPath,
  }

  // Spawn child process running the same binary with the prompt
  const child = spawn(
    process.execPath,
    [process.argv[1], '--bg-worker', id, '--', prompt],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    },
  )

  sessionEntry.pid = child.pid!
  await registerSession(sessionEntry)

  // Pipe output to log file
  child.stdout?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))
  child.stderr?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))

  child.on('exit', code => {
    updateSession(id, {
      status: code === 0 ? 'completed' : 'failed',
      exitCode: code ?? -1,
      lastActivity: Date.now(),
    }).catch(() => {})
  })

  child.unref()

  console.log(`Background session started: ${id}`)
  console.log(`View logs:  ola-cc logs ${id}`)
  console.log(`Check status: ola-cc ps`)
}

/**
 * Handle `ola-cc ps` - list background sessions
 */
export async function psHandler(_args: string[]): Promise<void> {
  await cleanupDeadSessions()
  const sessions = await listSessions()

  if (sessions.length === 0) {
    console.log('No background sessions.')
    return
  }

  // Sort by startedAt, newest first
  sessions.sort((a, b) => b.startedAt - a.startedAt)

  // Print table
  console.log(
    'ID'.padEnd(36),
    'STATUS'.padEnd(12),
    'PID'.padEnd(8),
    'STARTED'.padEnd(20),
    'PROMPT',
  )
  console.log('-'.repeat(110))

  for (const s of sessions) {
    const started = new Date(s.startedAt).toLocaleString()
    const promptText = s.prompt.length > 45 ? s.prompt.slice(0, 42) + '...' : s.prompt
    console.log(
      s.id.padEnd(36),
      s.status.padEnd(12),
      String(s.pid).padEnd(8),
      started.padEnd(20),
      promptText,
    )
  }
}

/**
 * Handle `ola-cc logs <id>` - show session logs
 */
export async function logsHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc logs <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  if (!session.logPath) {
    console.log('No logs available for this session.')
    return
  }

  try {
    const logData = fs.readFileSync(session.logPath, 'utf-8')
    if (logData.trim().length === 0) {
      console.log('Logs are empty (session just started).')
    } else {
      console.log(logData)
    }
  } catch {
    console.log('No logs available (file not found).')
  }
}

/**
 * Handle `ola-cc attach <id>` - attach to a running session
 */
export async function attachHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc attach <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  if (session.status !== 'running') {
    console.error(`Session ${id} is ${session.status}, not running.`)
    process.exit(1)
  }

  console.log(`Attaching to session ${id} (PID: ${session.pid})...`)
  console.log('Use Ctrl+C to detach.')

  // Tail the log file for live output
  const logPath = session.logPath
  if (logPath) {
    try {
      execSync(`tail -f "${logPath}"`, { stdio: 'inherit' })
    } catch {
      // User pressed Ctrl+C - normal detach
    }
  }
}

/**
 * Handle `ola-cc kill <id>` - terminate a session
 */
export async function killHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc kill <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  try {
    process.kill(session.pid, 'SIGTERM')
    await updateSession(id, { status: 'killed', lastActivity: Date.now() })
    console.log(`Session ${id} terminated.`)
  } catch {
    // Try force kill as fallback
    try {
      process.kill(session.pid, 'SIGKILL')
      await updateSession(id, { status: 'killed', lastActivity: Date.now() })
      console.log(`Session ${id} force-killed.`)
    } catch {
      await updateSession(id, { status: 'failed', lastActivity: Date.now() })
      console.log(`Session ${id} marked as failed (process not found).`)
    }
  }
}
