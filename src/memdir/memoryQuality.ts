/**
 * Memory quality validation: prevents duplicate memories, enforces
 * frontmatter structure, and validates content quality before writing.
 *
 * Called before Write tool operations to memory directories.
 * Pure validation — no I/O, no API calls.
 */

import { MemoryDoc, MemoryIndex } from './index.js'

/** Result of quality validation: pass or specific failure reason. */
export type QualityResult =
  | { ok: true }
  | { ok: false; reason: string }

/** Minimum content length for a valid memory (excluding frontmatter). */
const MIN_CONTENT_CHARS = 20

/** Maximum content length to prevent oversized memories. */
const MAX_CONTENT_CHARS = 2000

/**
 * Validate memory content quality before writing.
 *
 * Checks:
 * - Has required frontmatter fields (name, type)
 * - Content is between MIN and MAX length
 * - Has meaningful body text (not just frontmatter)
 * - Does not contain derivate information (code patterns, git history)
 */
export function validateMemoryQuality(
  name: string,
  type: string,
  content: string,
): QualityResult {
  // Required fields
  if (!name || name.trim().length < 2) {
    return { ok: false, reason: 'Memory name is too short' }
  }

  if (!type || !['user', 'feedback', 'project', 'reference'].includes(type)) {
    return { ok: false, reason: `Invalid memory type: "${type}"` }
  }

  // Content length
  const trimmed = content.trim()
  if (trimmed.length < MIN_CONTENT_CHARS) {
    return { ok: false, reason: `Content too short (min ${MIN_CONTENT_CHARS} chars)` }
  }
  if (trimmed.length > MAX_CONTENT_CHARS) {
    return { ok: false, reason: `Content too long (max ${MAX_CONTENT_CHARS} chars)` }
  }

  // Check for prohibited content patterns
  const prohibitedPatterns = [
    /code pattern/i,
    /convention.*codebase/i,
    /git log/i,
    /git blame/i,
    /file structure/i,
    /architecture.*of.*this.*project/i,
  ]
  for (const pattern of prohibitedPatterns) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: 'Content appears to describe derivable information (code patterns, git history, etc.)' }
    }
  }

  return { ok: true }
}

/**
 * Check if a new memory is a duplicate of an existing one.
 *
 * Uses cosine similarity of TF-IDF vectors. Two memories are considered
 * duplicates if their similarity exceeds the threshold.
 */
export function isDuplicate(
  newName: string,
  newContent: string,
  existingDocs: MemoryDoc[],
  threshold = 0.95,
): boolean {
  // Simple heuristic: if name matches exactly, it's a duplicate
  for (const doc of existingDocs) {
    if (doc.name === newName) {
      return true
    }
  }

  // Content overlap check: if the new content is very similar to existing
  for (const doc of existingDocs) {
    const similarity = computeSimilarity(newContent, doc.content)
    if (similarity > threshold) {
      return true
    }
  }

  return false
}

/**
 * Compute Jaccard-like similarity between two text strings.
 *
 * Uses word-level overlap with a simple tokenization.
 * Returns a value between 0 and 1.
 */
function computeSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 2))
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 2))

  if (tokensA.size === 0 || tokensB.size === 0) return 0

  let overlap = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      overlap++
    }
  }

  const union = tokensA.size + tokensB.size - overlap
  return union > 0 ? overlap / union : 0
}

/**
 * Generate a quality score for an existing memory.
 *
 * Returns 0-1 where 1 is a high-quality memory.
 * Used for pruning decisions.
 */
export function qualityScore(doc: MemoryDoc): number {
  let score = 0

  // Has description
  if (doc.description && doc.description.length > 10) {
    score += 0.2
  }

  // Has meaningful content
  if (doc.content.length > 50) {
    score += 0.2
  }

  // Has a structured type (not undefined)
  if (doc.type && ['user', 'feedback', 'project', 'reference'].includes(doc.type)) {
    score += 0.1
  }

  // Content has "Why:" or "How to apply:" structure (feedback/project best practice)
  if (doc.content.includes('Why:') || doc.content.includes('How to apply:')) {
    score += 0.2
  }

  // Content has concrete examples
  if (doc.content.includes('example') || doc.content.includes('e.g.')) {
    score += 0.1
  }

  // Recency bonus
  const ageDays = (Date.now() - doc.mtimeMs) / (1000 * 60 * 60 * 24)
  if (ageDays < 30) {
    score += 0.2
  } else if (ageDays < 90) {
    score += 0.1
  }

  return Math.min(score, 1.0)
}
