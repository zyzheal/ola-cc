/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 *
 * Ported from /tmp/codegraph/src/extraction/parse-worker.ts with snake_case adaptations.
 */

import { parentPort } from 'worker_threads'
import { extractFromSource } from './tree-sitter.js'
import { detect_language, load_grammars_for_languages } from './grammars.js'
import type { Language, ExtractionResult } from './types.js'

// Filter Emscripten abort noise from stderr
{
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    if (
      s.startsWith('Aborted(') ||
      s.includes('Build with -sASSERTIONS for more info')
    ) {
      if (typeof encoding === 'function') encoding()
      else if (cb) cb()
      return true
    }
    return realWrite(chunk as never, encoding as never, cb as never)
  }) as typeof process.stderr.write
}

const PARSER_RESET_INTERVAL = 5000
const parseCounts = new Map<Language, number>()

parentPort!.on('message', async (msg: {
  type: string
  id?: number
  file?: string
  content?: string
  languages?: Language[]
}) => {
  if (msg.type === 'load-grammars') {
    await load_grammars_for_languages(msg.languages!)
    parentPort!.postMessage({ type: 'grammars-loaded' })
  } else if (msg.type === 'parse') {
    const { id, file, content } = msg
    try {
      const language = detect_language(file!, content)
      const result: ExtractionResult = extractFromSource(file!, content!, language)

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1
      parseCounts.set(language, count)
      if (count % PARSER_RESET_INTERVAL === 0) {
        // Reset parser for this language
        parseCounts.set(language, 0)
      }

      parentPort!.postMessage({ type: 'parse-result', id, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // WASM memory errors leave the module corrupted — crash the worker
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1)
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: {
          nodes: [],
          edges: [],
          unresolved_references: [],
          errors: [{ message: `Parse worker error: ${message}`, file: file!, severity: 'error', code: 'parse_error' }],
          duration_ms: 0,
        } satisfies ExtractionResult,
      })
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' })
  }
})
