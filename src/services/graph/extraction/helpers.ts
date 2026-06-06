/**
 * Extraction helpers -- shared utilities for specialized extractors and core TreeSitterExtractor.
 *
 * Ported from codegraph with snake_case function names and camelCase aliases
 * for backward compatibility with existing language extractors.
 */

import { createHash } from 'node:crypto'
import type { SyntaxNode } from './types.js'

/**
 * Generate a unique node ID from extraction context.
 *
 * Uses a 32-character (128-bit) SHA-256 hash to avoid collisions when
 * indexing large codebases with many files containing similar symbols.
 */
export function generate_node_id(
  file: string,
  kind: string,
  name: string,
  line: number,
): string {
  const hash = createHash('sha256')
    .update(`${file}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32)
  return `${kind}:${hash}`
}

/**
 * Extract text from a syntax node
 */
export function get_node_text(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex)
}

/**
 * Find a child node by field name
 */
export function get_child_by_field(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName)
}

/**
 * Get the docstring/comment preceding a node
 */
export function get_preceding_docstring(node: SyntaxNode, source: string): string | undefined {
  let sibling = node.previousNamedSibling
  const comments: string[] = []

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(get_node_text(sibling, source))
      sibling = sibling.previousNamedSibling
    } else {
      break
    }
  }

  if (comments.length === 0) return undefined

  return comments
    .map((c) =>
      c
        .replace(/^\/\*\*?|\*\/$/g, '')
        .replace(/^\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
    )
    .join('\n')
    .trim()
}

// ============================================================
// Backward-compatible camelCase aliases
// (language extractors use these names)
// ============================================================

/** @deprecated Use generate_node_id */
export const generateNodeId = generate_node_id
/** @deprecated Use get_node_text */
export const getNodeText = get_node_text
/** @deprecated Use get_child_by_field */
export const getChildByField = get_child_by_field
/** @deprecated Use get_preceding_docstring */
export const getPrecedingDocstring = get_preceding_docstring
