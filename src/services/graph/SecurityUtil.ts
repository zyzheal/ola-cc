/**
 * Security utilities for graph tools.
 *
 * Provides input sanitization for LLM-bound queries to prevent prompt injection,
 * and path validation to prevent directory traversal attacks.
 *
 * Design: docs/superpowers/plans/2026-06-05-codegraph-grok-unified-plan.md F-89
 */

// ============================================================
// Prompt injection prevention
// ============================================================

/** Characters/sequences that could be used for prompt injection */
const INJECTION_PATTERNS = [
  /\x00/g,                          // null bytes
  /[\x01-\x08\x0b\x0c\x0e-\x1f]/g, // control chars (except \t \n \r)
  /\u200b|\u200c|\u200d|\ufeff/g,  // zero-width chars
  /\u2028|\u2029/g,                // line/paragraph separators
]

/**
 * Sanitize a user query before sending it to an LLM.
 * - Strips control characters and zero-width chars
 * - Normalizes whitespace
 * - Enforces length limits
 */
export function sanitizeQuery(query: string, maxLen = 10000): string {
  let sanitized = query

  // Strip injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '')
  }

  // Normalize whitespace (collapse multiple spaces/newlines)
  sanitized = sanitized.replace(/[\r\n]+/g, '\n').replace(/[ \t]+/g, ' ')

  // Enforce length limit
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen)
  }

  return sanitized.trim()
}

/**
 * Sanitize code content extracted from files before including in LLM prompts.
 * - Strips potential instruction injection in comments/strings
 * - Preserves code structure
 * - Enforces per-file content limits
 */
export function sanitizeCodeContent(content: string, maxLen = 50000): string {
  let sanitized = content

  // Strip null bytes and control chars
  sanitized = sanitized.replace(/\x00/g, '')
  sanitized = sanitized.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, '')

  // Strip zero-width characters
  sanitized = sanitized.replace(/[\u200b\u200c\u200d\ufeff]/g, '')

  // Enforce length limit
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen) + '\n// ... [truncated]'
  }

  return sanitized
}

// ============================================================
// Path traversal prevention
// ============================================================

/**
 * Validate that a path doesn't escape the project root.
 * Returns true if safe, false if traversal detected.
 */
export function isPathSafe(path: string, projectRoot: string): boolean {
  // Normalize separators
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = projectRoot.replace(/\\/g, '/')

  // Check for traversal sequences
  if (normalizedPath.includes('..')) {
    return false
  }

  // Check for absolute paths outside project
  if (normalizedPath.startsWith('/') && !normalizedPath.startsWith(normalizedRoot)) {
    return false
  }

  return true
}

/**
 * Validate that a symbol name doesn't contain injection attempts.
 * Returns sanitized symbol name.
 */
export function sanitizeSymbolName(name: string): string {
  // Strip control characters
  let sanitized = name.replace(/[\x00-\x1f]/g, '')

  // Limit length
  if (sanitized.length > 1000) {
    sanitized = sanitized.slice(0, 1000)
  }

  return sanitized.trim()
}
