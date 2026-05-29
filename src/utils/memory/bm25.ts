export interface BM25Config {
  k1: number
  b: number
}

export interface BM25Result {
  docId: string
  score: number
  matchedTerms: string[]
}

const DEFAULT_BM25_CONFIG: BM25Config = { k1: 1.2, b: 0.75 }

export class BM25 {
  private config: BM25Config
  private documents: Map<string, string> = new Map()
  private termFreqs: Map<string, Map<string, number>> = new Map()
  private docLengths: Map<string, number> = new Map()
  private avgDocLength: number = 0
  private docCount: number = 0
  private idfCache: Map<string, number> = new Map()

  constructor(config?: Partial<BM25Config>) {
    this.config = { ...DEFAULT_BM25_CONFIG, ...config }
  }

  addDocument(docId: string, content: string): void {
    this.documents.set(docId, content)
    const tokens = this.tokenize(content)
    const freqs = new Map<string, number>()
    for (const token of tokens) {
      freqs.set(token, (freqs.get(token) ?? 0) + 1)
    }
    this.termFreqs.set(docId, freqs)
    this.docLengths.set(docId, tokens.length)
    this.docCount = this.documents.size
    this.avgDocLength = [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.docCount
    this.idfCache.clear()
  }

  removeDocument(docId: string): void {
    this.documents.delete(docId)
    this.termFreqs.delete(docId)
    this.docLengths.delete(docId)
    this.docCount = this.documents.size
    this.avgDocLength = this.docCount > 0
      ? [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.docCount
      : 0
    this.idfCache.clear()
  }

  search(query: string, topK: number = 10): BM25Result[] {
    if (!query.trim()) return []

    const queryTokens = this.tokenize(query)
    if (queryTokens.length === 0) return []

    const scores = new Map<string, { score: number; matchedTerms: Set<string> }>()

    for (const term of queryTokens) {
      const idf = this.calculateIDF(term)
      if (idf <= 0) continue

      for (const [docId, freqs] of this.termFreqs) {
        const tf = freqs.get(term) ?? 0
        if (tf === 0) continue

        const docLen = this.docLengths.get(docId) ?? 0
        const { k1, b } = this.config
        const numerator = tf * (k1 + 1)
        const denominator = tf + k1 * (1 - b + b * docLen / this.avgDocLength)
        const score = idf * numerator / denominator

        const entry = scores.get(docId) ?? { score: 0, matchedTerms: new Set() }
        entry.score += score
        entry.matchedTerms.add(term)
        scores.set(docId, entry)
      }
    }

    return [...scores.entries()]
      .map(([docId, { score, matchedTerms }]) => ({ docId, score, matchedTerms: [...matchedTerms] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = []

    // English words + digit mixed tokens (preserves base64, v2, P0-1)
    const englishWords = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) || []
    tokens.push(...englishWords.map(w => w.toLowerCase()))

    // Chinese chars (unigram + bigram)
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || []
    tokens.push(...chineseChars)
    for (let i = 0; i < chineseChars.length - 1; i++) {
      tokens.push(chineseChars[i] + chineseChars[i + 1])
    }

    // Code identifiers (camelCase / snake_case splitting)
    const identifiers = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []
    for (const id of identifiers) {
      const camelParts = id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')
      tokens.push(...camelParts)
      if (id.includes('_')) {
        tokens.push(...id.toLowerCase().split('_').filter(Boolean))
      }
    }

    return tokens
  }

  private calculateIDF(term: string): number {
    const cached = this.idfCache.get(term)
    if (cached !== undefined) return cached

    let docsWithTerm = 0
    for (const freqs of this.termFreqs.values()) {
      if (freqs.has(term)) docsWithTerm++
    }

    // IDF smooth variant: log(1 + (N - n + 0.5) / (n + 0.5))
    const idf = this.docCount === 0
      ? 0
      : Math.log(1 + (this.docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5))

    this.idfCache.set(term, idf)
    return idf
  }
}
