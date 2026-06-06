/**
 * Re-Export Parser
 *
 * Parses JavaScript/TypeScript re-export patterns from source content:
 * - `export * from '...'` (wildcard re-export)
 * - `export * as ns from '...'` (namespace re-export)
 * - `export { a, b as c } from '...'` (named re-export with aliasing)
 *
 * Migrated from codegraph/src/resolution/import-resolver.ts lines 930-983.
 */

import type { ReExport } from './types.js'
import { stripCommentsForRegex, type CommentLang } from './strip-comments.js'

// ============================================================
// Language check
// ============================================================

const JS_TS_LANGUAGES = new Set(['typescript', 'javascript', 'tsx', 'jsx'])

function isJsTs(language: string): boolean {
  return JS_TS_LANGUAGES.has(language)
}

// ============================================================
// Comment stripping for JS/TS
// ============================================================

/**
 * Strip JS/TS comments using the existing stripCommentsForRegex.
 * Maps language strings to CommentLang.
 */
function stripJsComments(content: string, language: string): string {
  const langMap: Record<string, CommentLang> = {
    typescript: 'typescript',
    javascript: 'javascript',
    tsx: 'typescript',
    jsx: 'javascript',
  }
  const commentLang = langMap[language]
  if (!commentLang) return content
  return stripCommentsForRegex(content, commentLang)
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse re-export patterns from source content.
 *
 * Returns an array of ReExport entries describing:
 * - Wildcard re-exports: `export * from '...'`
 * - Named re-exports: `export { a, b as c } from '...'`
 *
 * For non-JS/TS languages, returns an empty array.
 */
export function parseReExports(content: string, language: string): ReExport[] {
  if (!isJsTs(language)) {
    return []
  }

  const out: ReExport[] = []

  // Pre-strip block comments + line comments so a commented-out
  // `// export { x } from '...'` doesn't produce a phantom edge.
  const cleaned = stripJsComments(content, language)

  // Wildcard: `export * from '...'` or `export * as ns from '...'`
  const wildcardRe = /export\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! })
  }

  // Named: `export { a, b as c } from '...'`
  const namedRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm
  while ((m = namedRe.exec(cleaned)) !== null) {
    const inner = m[1]!
    const source = m[2]!
    for (const raw of inner.split(',')) {
      const item = raw.trim()
      if (!item) continue
      const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/)
      if (aliasMatch) {
        out.push({
          kind: 'named',
          exportedName: aliasMatch[2]!,
          originalName: aliasMatch[1]!,
          source,
        })
      } else if (/^\w+$/.test(item)) {
        out.push({
          kind: 'named',
          exportedName: item,
          originalName: item,
          source,
        })
      }
    }
  }

  return out
}
