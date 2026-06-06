/**
 * Specialized extractors barrel export.
 *
 * These extractors handle non-standard file formats that don't have
 * tree-sitter grammars or need special multi-language parsing.
 */

export { VueExtractor } from './vue-extractor.js'
export { SvelteExtractor } from './svelte-extractor.js'
export { LiquidExtractor } from './liquid-extractor.js'
export { MyBatisExtractor } from './mybatis-extractor.js'
export { DfmExtractor } from './dfm-extractor.js'

import { VueExtractor } from './vue-extractor.js'
import { SvelteExtractor } from './svelte-extractor.js'
import { LiquidExtractor } from './liquid-extractor.js'
import { MyBatisExtractor } from './mybatis-extractor.js'
import { DfmExtractor } from './dfm-extractor.js'

import type { ExtractionResult } from '../types.js'

/** Map of file extension to extractor class */
const EXTRACTOR_MAP: Record<string, new (file: string, source: string) => { extract(): ExtractionResult }> = {
  '.vue': VueExtractor,
  '.svelte': SvelteExtractor,
  '.liquid': LiquidExtractor,
  '.dfm': DfmExtractor,
  '.fmx': DfmExtractor,
}

/**
 * Extract from a file using the appropriate specialized extractor.
 *
 * Returns null if no specialized extractor handles this file type.
 * MyBatis is not auto-dispatched — it requires explicit `<mapper>` detection
 * by the caller (the XML extension is too generic).
 */
export function extractSpecialized(file: string, source: string): ExtractionResult | null {
  const ext = file.toLowerCase().match(/\.[^.]+$/)?.[0]
  if (!ext) return null

  const Ctor = EXTRACTOR_MAP[ext]
  if (!Ctor) return null

  return new Ctor(file, source).extract()
}

/**
 * Try MyBatis extraction for XML files.
 *
 * Returns null if the XML is not a MyBatis mapper (no `<mapper namespace>`).
 */
export function extractMyBatis(file: string, source: string): ExtractionResult | null {
  if (!/<mapper\b/.test(source)) return null
  return new MyBatisExtractor(file, source).extract()
}
