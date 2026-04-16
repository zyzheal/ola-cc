import { join } from 'path'
import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import { MemoryIndex } from './index.js'
import { MemoryStore } from './storage.js'
import { rankMemories, SELECT_MEMORIES_SYSTEM_PROMPT } from './recall.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

/**
 * Find memory files relevant to a query using TF-IDF local search.
 * Falls back to LLM-based selection if the index returns no results.
 *
 * Returns absolute file paths + mtime (up to 5).
 * Excludes MEMORY.md (already loaded in system prompt).
 *
 * `alreadySurfaced` filters paths shown in prior turns.
 */

// Singleton store per project root — initialized on first call
let _store: MemoryStore | null = null

/** Get or create the MemoryStore singleton. */
function getStore(): MemoryStore {
  if (!_store) {
    _store = new MemoryStore()
  }
  return _store
}

/**
 * Main entry point: find relevant memories using TF-IDF + multi-factor scoring.
 * Falls back to LLM selection if the index is empty or returns no results.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const store = getStore()
  const index = store.getIndex()

  // If index is empty, build it from the memory directory
  if (index.size === 0) {
    await store.build(memoryDir)
    // Start watching for incremental updates after initial build
    store.watch(memoryDir)
  }

  // Filter already surfaced docs before searching
  const allDocIds = index.getDocIds()
  if (allDocIds.length === 0) {
    return fallbackToLLMSelection(
      query,
      memoryDir,
      signal,
      recentTools,
      alreadySurfaced,
    )
  }

  // Search the TF-IDF index
  const scoredResults = index.search(query, 10)  // Get more candidates for scoring
  if (scoredResults.length === 0) {
    return fallbackToLLMSelection(
      query,
      memoryDir,
      signal,
      recentTools,
      alreadySurfaced,
    )
  }

  // Apply multi-factor scoring (type weight, age decay)
  const enrichedDocs = scoredResults
    .map(result => {
      const doc = index.getDoc(result.id)
      if (!doc) return null
      return { doc, tfidfScore: result.tfidfScore }
    })
    .filter((d): d is { doc: import('./index.js').MemoryDoc; tfidfScore: number } => d !== null)

  const ranked = rankMemories(enrichedDoc, 5)

  // Map back to file paths
  // Since the index stores docs by id (hashed from relative path),
  // we need to reconstruct paths. For now, use the doc name as filename.
  const results: RelevantMemory[] = []
  for (const scored of ranked) {
    const doc = index.getDoc(scored.id)
    if (!doc) continue
    // Reconstruct path — in the full implementation, the index stores full paths
    const path = join(memoryDir, doc.name + '.md')
    if (!alreadySurfaced.has(path)) {
      results.push({ path, mtimeMs: doc.mtimeMs })
    }
  }

  // Telemetry: log recall shape
  if (results.length > 0 && feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Approximate header list from index docs
    const allHeaders = allDocIds
      .map(id => index.getDoc(id))
      .filter((d): d is import('./index.js').MemoryDoc => d !== undefined)
      .map(doc => ({
        filename: doc.name + '.md',
        filePath: join(memoryDir, doc.name + '.md'),
        mtimeMs: doc.mtimeMs,
        description: doc.description,
        type: doc.type as import('./memoryTypes.js').MemoryType,
      }))
    logMemoryRecallShape(allHeaders, results.map(r => ({ filename: r.path })))
  }

  return results
}

/**
 * Fallback: use the original LLM-based memory selection when TF-IDF
 * returns no results (index empty, query has no meaningful terms, etc.)
 */
async function fallbackToLLMSelection(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[],
  alreadySurfaced: ReadonlySet<string>,
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemoriesWithLLM(
    query,
    memories,
    signal,
    recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemoriesWithLLM(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemoriesWithLLM failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
