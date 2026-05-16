import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface SessionEntry {
  id: string
  pid: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  prompt: string
  workdir: string
  startedAt: number
  lastActivity: number
  logPath?: string
  exitCode?: number
}

function getSessionDir(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'sessions')
}

export async function initSessionRegistry(): Promise<void> {
  const dir = getSessionDir()
  await fs.mkdir(dir, { recursive: true })
}

export async function registerSession(entry: SessionEntry): Promise<void> {
  await initSessionRegistry()
  const filePath = path.join(getSessionDir(), `${entry.id}.json`)
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2))
}

export async function updateSession(id: string, updates: Partial<SessionEntry>): Promise<void> {
  const existing = await getSession(id)
  if (!existing) return
  const updated = { ...existing, ...updates, lastActivity: Date.now() }
  await registerSession(updated)
}

export async function getSession(id: string): Promise<SessionEntry | null> {
  try {
    const filePath = path.join(getSessionDir(), `${id}.json`)
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data) as SessionEntry
  } catch {
    return null
  }
}

export async function listSessions(): Promise<SessionEntry[]> {
  await initSessionRegistry()
  try {
    const files = await fs.readdir(getSessionDir())
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    const sessions = await Promise.all(
      jsonFiles.map(async f => {
        try {
          const data = await fs.readFile(path.join(getSessionDir(), f), 'utf-8')
          return JSON.parse(data) as SessionEntry
        } catch {
          return null
        }
      }),
    )
    return sessions.filter(Boolean) as SessionEntry[]
  } catch {
    return []
  }
}

export async function removeSession(id: string): Promise<void> {
  const filePath = path.join(getSessionDir(), `${id}.json`)
  await fs.unlink(filePath).catch(() => {})
}

export async function cleanupDeadSessions(): Promise<void> {
  const sessions = await listSessions()
  for (const s of sessions) {
    if (s.status === 'running') {
      try {
        process.kill(s.pid, 0)
      } catch {
        await updateSession(s.id, { status: 'failed', exitCode: -1 })
      }
    }
  }
}
