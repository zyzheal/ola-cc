/**
 * Worktree Progress Tracker
 *
 * Shared file-based progress system for independent Claude Code processes
 * running in git worktrees. Each worktree agent writes its status to a
 * shared JSON file; the main session polls this file to display progress.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'

export interface WorktreeProgress {
  /** Branch name (unique identifier) */
  branch: string
  /** Human-readable task description */
  task: string
  /** Current step/action being performed */
  currentStep: string
  /** Progress 0-100 */
  progress: number
  /** Status */
  status: 'running' | 'completed' | 'failed' | 'idle'
  /** Last heartbeat timestamp (ms) */
  heartbeat: number
  /** Working directory path */
  workdir: string
}

const PROGRESS_FILENAME = '.worktrees-progress.json'

/**
 * Find the progress file location by walking up to the git root.
 */
function findProgressFile(): { path: string } {
  const results: { path: string } = { path: '' }
  try {
    const { execSync } = require('child_process')
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
    }).trim()
    results.path = join(gitRoot, PROGRESS_FILENAME)
  } catch {
    results.path = join(process.cwd(), PROGRESS_FILENAME)
  }
  return results
}

/**
 * Read all worktree progress entries.
 */
export function readAllProgress(): WorktreeProgress[] {
  const { path } = findProgressFile()
  if (!existsSync(path)) return []

  try {
    const content = readFileSync(path, 'utf8')
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Write or update a worktree progress entry.
 */
export function writeProgress(entry: WorktreeProgress): void {
  const { path } = findProgressFile()
  const entries = readAllProgress()
  const idx = entries.findIndex(e => e.branch === entry.branch)
  if (idx >= 0) {
    entries[idx] = { ...entry, heartbeat: Date.now() }
  } else {
    entries.push({ ...entry, heartbeat: Date.now() })
  }
  writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8')
}

/**
 * Remove entries that haven't heartbeated within the stale threshold.
 */
export function pruneStaleProgress(entries: WorktreeProgress[], staleMs: number = 30_000): WorktreeProgress[] {
  const now = Date.now()
  return entries.filter(e => (now - e.heartbeat) < staleMs)
}
