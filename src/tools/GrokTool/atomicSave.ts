/**
 * Shared atomic file write utility for Grok knowledge graphs.
 * Pattern: write .tmp → rename (atomic filesystem operation).
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'

/**
 * Atomically write JSON data to a file with backup.
 * 1. Clean up stale .tmp files
 * 2. Create .backup of existing file
 * 3. Write to .tmp
 * 4. Rename .tmp → target (atomic)
 */
export function atomicWriteJson(filePath: string, data: unknown, caller = 'Grok'): string {
  // Ensure parent directory exists
  mkdirSync(dirname(filePath), { recursive: true })

  const tempPath = filePath + '.tmp'

  // Clean up stale .tmp files (from previous crash)
  try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* ignore */ }

  // Backup existing file (corruption recovery)
  const backupPath = filePath + '.backup'
  try {
    if (existsSync(filePath)) copyFileSync(filePath, backupPath)
  } catch (backupErr) {
    console.warn(`[${caller}] Failed to create backup:`, backupErr instanceof Error ? backupErr.message : backupErr)
  }

  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tempPath, filePath)
  return filePath
}

/**
 * Convenience: atomically write knowledge-graph.json for a project.
 */
export function saveKnowledgeGraph(projectRoot: string, data: unknown, caller = 'Grok'): string {
  const graphDir = resolve(projectRoot, '.understand-anything')
  const filePath = resolve(graphDir, 'knowledge-graph.json')
  return atomicWriteJson(filePath, data, caller)
}
