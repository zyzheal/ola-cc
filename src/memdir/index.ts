/**
 * TF-IDF inverted index for memory files.
 *
 * In-memory index built at startup, incrementally updated via fs.watch.
 * Pure computation — no I/O, no API calls. Query time <5ms.
 *
 * Tokenization: split on non-alphanumeric, lowercase, filter tokens <3 chars.
 * TF: raw term frequency within a document's combined text (name + desc + content).
 * IDF: log(N / df) where N = total docs, df = docs containing the term.
 *
 * Score = cosine(query_vec, doc_vec) for TF-IDF vectors.
 */

export interface MemoryDoc {
  id: number
  name: string
  description: string | null
  content: string  // first 200 chars of body
  type: string     // user | feedback | project | reference
  mtimeMs: number
}

export interface ScoredDoc {
  id: number
  score: number    // 0-1, higher = more relevant
  tfidfScore: number
}

type PostingList = Map<number, number>  // docId → tf

// Stop words filtered aggressively — only very short high-freq tokens
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'this', 'that',
  'with', 'from', 'they', 'will', 'each', 'about', 'who', 'get', 'would',
  'their', 'what', 'when', 'where', 'which', 'while', 'after', 'before',
])

export class MemoryIndex {
  private docs = new Map<number, MemoryDoc>()
  private index = new Map<string, PostingList>()  // term → docId → tf
  private docCount = 0

  /** Build index from scratch. Call at startup or after full rebuild. */
  build(docs: MemoryDoc[]): void {
    this.docs.clear()
    this.index.clear()
    this.docCount = docs.length
    for (const doc of docs) {
      this.docs.set(doc.id, doc)
      const tokens = tokenize(doc)
      for (const token of tokens) {
        let postings = this.index.get(token)
        if (!postings) {
          postings = new Map()
          this.index.set(token, postings)
        }
        postings.set(doc.id, (postings.get(doc.id) ?? 0) + 1)
      }
    }
  }

  /** Incremental update: add new docs, remove deleted ones. */
  update(added: MemoryDoc[], removedIds: Set<number>): void {
    for (const id of removedIds) {
      this.docs.delete(id)
      for (const postings of this.index.values()) {
        postings.delete(id)
      }
    }
    for (const doc of added) {
      this.docs.set(doc.id, doc)
      this.docCount = Math.max(this.docCount, doc.id + 1)
      const tokens = tokenize(doc)
      for (const token of tokens) {
        let postings = this.index.get(token)
        if (!postings) {
          postings = new Map()
          this.index.set(token, postings)
        }
        postings.set(doc.id, (postings.get(doc.id) ?? 0) + 1)
      }
    }
  }

  /** Search the index. Returns docs scored by TF-IDF cosine similarity. */
  search(query: string, limit = 5): ScoredDoc[] {
    if (this.docs.size === 0) return []

    const queryTokens = tokenizeText(query)
    if (queryTokens.length === 0) return []

    const queryVec = new Map<string, number>()
    for (const t of queryTokens) {
      queryVec.set(t, (queryVec.get(t) ?? 0) + 1)
    }
    // Normalize query vector
    const queryNorm = vecNorm(queryVec)

    // Collect candidate docIds that share at least one term
    const candidates = new Map<number, number>()  // docId → dot_product
    for (const [term, qtf] of queryVec) {
      const postings = this.index.get(term)
      if (!postings) continue
      const idf = this.idf(term)
      for (const [docId, tf] of postings) {
        const score = qtf * idf * tf
        candidates.set(docId, (candidates.get(docId) ?? 0) + score)
      }
    }

    // Score each candidate
    const results: ScoredDoc[] = []
    for (const [docId, dotProduct] of candidates) {
      const doc = this.docs.get(docId)
      if (!doc) continue
      const docNorm = this.docNorm(docId)
      const cosine = queryNorm > 0 && docNorm > 0
        ? dotProduct / (queryNorm * docNorm)
        : 0
      if (cosine > 0) {
        results.push({ id: docId, score: cosine, tfidfScore: cosine })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /** Get document metadata by id. */
  getDoc(id: number): MemoryDoc | undefined {
    return this.docs.get(id)
  }

  /** Get all indexed doc ids. */
  getDocIds(): number[] {
    return [...this.docs.keys()]
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.size
  }

  /** Inverse document frequency: log(N / df). Smoothed. */
  private idf(term: string): number {
    const postings = this.index.get(term)
    if (!postings || postings.size === 0) return 0
    return Math.log(1 + this.docs.size / postings.size)
  }

  /** Pre-computed document vector norm (cached per doc). */
  private docNormCache = new Map<number, number>()

  private docNorm(docId: number): number {
    const cached = this.docNormCache.get(docId)
    if (cached !== undefined) return cached

    let sumSq = 0
    for (const [term, postings] of this.index) {
      const tf = postings.get(docId)
      if (!tf) continue
      const idf = this.idf(term)
      sumSq += (tf * idf) ** 2
    }
    const norm = Math.sqrt(sumSq)
    this.docNormCache.set(docId, norm)
    return norm
  }
}

/** Tokenize a MemoryDoc into filtered terms. */
function tokenize(doc: MemoryDoc): string[] {
  const text = [doc.name, doc.description ?? '', doc.content].join(' ')
  return tokenizeText(text)
}

/** Tokenize raw text: lowercase, split on non-alnum, filter short/stop words. */
function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)  // supports CJK chars
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
}

/** Euclidean norm of a sparse vector represented as Map<string, number>. */
function vecNorm(vec: Map<string, number>): number {
  let sum = 0
  for (const v of vec.values()) {
    sum += v * v
  }
  return Math.sqrt(sum)
}
