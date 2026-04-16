/**
 * Storage layer: loads memory files into MemoryDoc format, manages the
 * TF-IDF index lifecycle, and provides fs.watch for incremental updates.
 *
 * Pure I/O module — all search/scoring is in index.ts and recall.ts.
 * This module handles:
 * - Parsing .md files with frontmatter into MemoryDoc
 * - Building and updating the in-memory index
 * - Watching the filesystem for changes
 */

import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { FSWatcher } from 'fs'
import { watch } from 'fs'
import { MemoryDoc, MemoryIndex } from './index.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'
import { parseFrontmatter } from '../utils/frontmatter.js'

/** First N lines of a memory file to index (content preview). */
const CONTENT_PREVIEW_LINES = 10

/** Maximum characters of body text to include in the index. */
const CONTENT_MAX_CHARS = 200

/**
 * Parse a single memory file into a MemoryDoc.
 * Returns null if the file cannot be parsed or is not .md.
 */
export async function parseMemoryFile(
  filePath: string,
  relativePath: string,
): Promise<MemoryDoc | null> {
  if (!relativePath.endsWith('.md') || basename(relativePath) === 'MEMORY.md') {
    return null
  }

  try {
    const [content, fileStat] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath),
    ])

    const { frontmatter, body } = parseFrontmatter(content, filePath)
    const bodyLines = body.split('\n').slice(0, CONTENT_PREVIEW_LINES)
    const preview = bodyLines.join('\n').slice(0, CONTENT_MAX_CHARS)

    return {
      id: hashCode(relativePath),
      name: frontmatter.name ?? basename(relativePath, '.md'),
      description: frontmatter.description ?? null,
      content: preview,
      type: (parseMemoryType(frontmatter.type) ?? 'project') as MemoryType,
      mtimeMs: fileStat.mtimeMs,
    }
  } catch {
    return null
  }
}

/** String hash → stable numeric id for a given relative path. */
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return Math.abs(hash)
}

/**
 * Scan and parse all memory files in a directory.
 * Returns an array of MemoryDoc sorted by mtime descending.
 */
export async function loadMemoryDocs(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryDoc[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const docs = await Promise.all(
      mdFiles.map(async relativePath => {
        const filePath = join(memoryDir, relativePath)
        return parseMemoryFile(filePath, relativePath)
      }),
    )

    return docs
      .filter((d): d is MemoryDoc => d !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

/**
 * Manages a MemoryIndex with filesystem watching for incremental updates.
 * Call start() to begin watching, stop() to clean up.
 */
export class MemoryStore {
  private index = new MemoryIndex()
  private watcher: FSWatcher | null = null
  private docs = new Map<string, MemoryDoc>()  // relativePath → doc
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null

  /** Get the current index (read-only access). */
  getIndex(): MemoryIndex {
    return this.index
  }

  /** Build the index from scratch from a memory directory. */
  async build(memoryDir: string): Promise<void> {
    const docs = await loadMemoryDocs(memoryDir)
    this.docs.clear()
    for (const doc of docs) {
      // We need to track relative paths for incremental updates
      this.docs.set(doc.name, doc)  // keyed by name for now
    }
    this.index.build(docs)
  }

  /** Start watching the memory directory for changes. */
  watch(memoryDir: string): void {
    this.stop()
    this.watcher = watch(memoryDir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.md') || filename === 'MEMORY.md') {
        return
      }
      // Debounce rapid fs events (macOS emits duplicate events)
      if (this.pendingUpdate) clearTimeout(this.pendingUpdate)
      this.pendingUpdate = setTimeout(async () => {
        await this.refreshSingle(memoryDir, filename)
      }, 250)
    })
  }

  /** Stop watching and clean up resources. */
  stop(): void {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate)
      this.pendingUpdate = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  /** Refresh a single changed file in the index. */
  private async refreshSingle(dir: string, relativePath: string): Promise<void> {
    const filePath = join(dir, relativePath)
    try {
      await stat(filePath)  // Check file still exists
      const doc = await parseMemoryFile(filePath, relativePath)
      if (doc) {
        this.index.update([doc], new Set())
      }
    } catch {
      // File was deleted — remove from index
      const existing = this.docs.get(relativePath)
      if (existing) {
        this.docs.delete(relativePath)
        this.index.update([], new Set([existing.id]))
      }
    }
  }
}
