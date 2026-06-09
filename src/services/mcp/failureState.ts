/**
 * MCP Failure State Persistence
 *
 * Persists connection failure state across sessions to skip servers that
 * consistently fail. This prevents blocking startup with servers that are
 * known to be unavailable.
 *
 * File: ~/.claude/mcp-failure-state.json
 * TTL: 7 days (entries older than this are cleared)
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { logForDebugging } from '../../utils/debug.js'

const FAILURE_STATE_FILE = 'mcp-failure-state.json'
const TTL_DAYS = 7
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000

const FailureEntrySchema = z.object({
  failCount: z.number().int().nonnegative(),
  lastFailTime: z.number().int().positive(),
})

const FailureStateSchema = z.record(z.string(), FailureEntrySchema)

export type FailureEntry = z.infer<typeof FailureEntrySchema>
export type FailureState = z.infer<typeof FailureStateSchema>

function getFailureStatePath(): string {
  return join(homedir(), '.claude', FAILURE_STATE_FILE)
}

// In-memory cache to avoid repeated file reads during a session.
// Loaded once at startup, invalidated on write.
let cachedState: FailureState | null = null

// Serialize write operations to prevent read-modify-write race conditions
// when multiple MCP servers fail concurrently.
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Load failure state from disk, clearing entries older than TTL.
 * Uses in-memory cache to avoid reading the file multiple times per session.
 */
export async function loadMcpFailureState(): Promise<FailureState> {
  if (cachedState !== null) {
    return cachedState
  }

  const path = getFailureStatePath()
  try {
    if (!existsSync(path)) {
      cachedState = {}
      return cachedState
    }
    const content = await readFile(path, 'utf-8')
    const parsed = JSON.parse(content)
    const state = FailureStateSchema.parse(parsed)

    // Clear expired entries
    const now = Date.now()
    const filtered: FailureState = {}
    for (const [name, entry] of Object.entries(state)) {
      if (now - entry.lastFailTime < TTL_MS) {
        filtered[name] = entry
      }
    }

    // If any entries were expired, write back the filtered state
    if (Object.keys(filtered).length !== Object.keys(state).length) {
      await saveMcpFailureState(filtered)
    }

    cachedState = filtered
    return cachedState
  } catch {
    // If parsing or filtering fails, start fresh rather than propagating error.
    // This prevents cascading failures in the MCP connection pipeline.
    cachedState = {}
    return cachedState
  }
}

/**
 * Save failure state to disk atomically (write to temp file then rename)
 * and update in-memory cache.
 */
async function saveMcpFailureState(state: FailureState): Promise<void> {
  const path = getFailureStatePath()
  const dir = join(homedir(), '.claude')
  const tmpPath = path + '.tmp'
  try {
    await mkdir(dir, { recursive: true })
    // Write to temp file first, then atomic rename to prevent half-written JSON
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmpPath, path)
    cachedState = state
  } catch (err) {
    logForDebugging(`Failed to save MCP failure state: ${err}`)
    // Invalidate cache so next read goes to disk
    cachedState = null
    // Clean up temp file if rename failed
    try {
      await unlink(tmpPath)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Record a connection failure for a server.
 * Serialized to avoid losing concurrent updates.
 */
export async function recordMcpFailure(name: string): Promise<void> {
  // Chain onto write queue to serialize read-modify-write operations
  writeQueue = writeQueue.then(async () => {
    const state = { ...(await loadMcpFailureState()) }
    const existing = state[name]
    state[name] = {
      failCount: (existing?.failCount ?? 0) + 1,
      lastFailTime: Date.now(),
    }
    await saveMcpFailureState(state)
  }).catch(err => {
    logForDebugging(`recordMcpFailure error: ${err}`)
  })
  await writeQueue
}

/**
 * Clear failure state for a server (on successful connection).
 * Serialized to avoid race with recordMcpFailure.
 */
export async function clearMcpFailure(name: string): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const state = { ...(await loadMcpFailureState()) }
    if (name in state) {
      delete state[name]
      await saveMcpFailureState(state)
    }
  }).catch(err => {
    logForDebugging(`clearMcpFailure error: ${err}`)
  })
  await writeQueue
}

/**
 * Batch check which servers should be skipped based on failure history.
 * Returns a Set of server names to skip.
 * More efficient than calling shouldSkipMcpServer N times.
 */
export async function getSkippedServerNames(
  serverNames: string[],
): Promise<Set<string>> {
  const state = await loadMcpFailureState()
  const now = Date.now()
  const skipped = new Set<string>()
  for (const name of serverNames) {
    const entry = state[name]
    if (entry && entry.failCount >= 2 && now - entry.lastFailTime < TTL_MS) {
      skipped.add(name)
    }
  }
  return skipped
}

/**
 * Check if a server should be skipped based on failure history.
 * Prefer getSkippedServerNames() for batch checks.
 */
export async function shouldSkipMcpServer(name: string): Promise<boolean> {
  const state = await loadMcpFailureState()
  const entry = state[name]
  if (!entry) return false
  return entry.failCount >= 2 && Date.now() - entry.lastFailTime < TTL_MS
}
