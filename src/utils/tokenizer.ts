/**
 * CJK-aware tokenizer and similarity utilities.
 *
 * Solves two critical bugs in ola-cc's text processing:
 * - B2: `split(/\s+/)` produces a single token for Chinese text → Jaccard always 0
 * - B4: `\b` doesn't match CJK boundaries → toolRanker search broken for Chinese
 *
 * Design based on AgentMemory's SearchIndex BM25 CJK tokenizer spec:
 * - ASCII segments: word-level tokens (split on whitespace/punctuation)
 * - CJK segments: bigram sliding window
 * - Non-alphanumeric characters act as separators
 */

// CJK Unified Ideographs + Extensions + Compatibility Ideographs
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u

/**
 * Check if a character is a CJK ideograph.
 */
function isCJK(ch: string): boolean {
  return CJK_REGEX.test(ch)
}

/**
 * Tokenize text into terms suitable for similarity comparison and search.
 *
 * Rules:
 * 1. ASCII alphanumeric sequences → word-level tokens (lowercased)
 * 2. CJK characters → bigram sliding window (each pair of adjacent CJK chars)
 * 3. Punctuation, whitespace, and other non-alphanumeric chars → separators
 * 4. Single CJK characters (no adjacent CJK) → kept as single token
 *
 * @example tokenizeCJK("hello world") → ["hello", "world"]
 * @example tokenizeCJK("你好世界") → ["你好", "好世", "世界"]
 * @example tokenizeCJK("read文件") → ["read", "文", "文件"]
 * @example tokenizeCJK("hello, world!") → ["hello", "world"]
 */
export function tokenizeCJK(text: string): string[] {
  if (!text) return []

  const tokens: string[] = []
  let asciiBuf = ''
  let cjkBuf = ''

  const flushAscii = () => {
    if (asciiBuf.length > 0) {
      tokens.push(asciiBuf.toLowerCase())
      asciiBuf = ''
    }
  }

  const flushCJK = () => {
    if (cjkBuf.length === 0) return
    if (cjkBuf.length === 1) {
      tokens.push(cjkBuf)
    } else {
      // Bigram sliding window
      for (let i = 0; i < cjkBuf.length - 1; i++) {
        tokens.push(cjkBuf.slice(i, i + 2))
      }
    }
    cjkBuf = ''
  }

  for (const ch of text) {
    if (isCJK(ch)) {
      flushAscii()
      cjkBuf += ch
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      flushCJK()
      asciiBuf += ch
    } else {
      // Separator (punctuation, whitespace, etc.)
      flushAscii()
      flushCJK()
    }
  }

  flushAscii()
  flushCJK()

  return tokens
}

/**
 * Compute Jaccard similarity between two token sets.
 *
 * J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Edge cases:
 * - Both empty → 0 (not 1, as empty sets have no meaningful overlap)
 * - One empty → 0
 *
 * @param tokensA - Token list from first text
 * @param tokensB - Token list from second text
 * @returns Jaccard similarity in [0, 1]
 */
export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 0

  const setA = new Set(tokensA)
  const setB = new Set(tokensB)

  let intersection = 0
  for (const t of setA) {
    if (setB.has(t)) intersection++
  }

  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Convenience: compute Jaccard similarity directly from raw text.
 * Uses tokenizeCJK for CJK-aware tokenization.
 */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeCJK(a), tokenizeCJK(b))
}

/**
 * Check if a string contains any CJK characters.
 * Used by toolRanker to decide whether to add \b word boundaries.
 */
export function containsCJK(text: string): boolean {
  return CJK_REGEX.test(text)
}
