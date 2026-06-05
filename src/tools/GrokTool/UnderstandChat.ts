/**
 * UnderstandChat — 基于图上下文的代码库问答系统
 *
 * 接收自然语言问题，从 GraphStore + GraphEngine 提取相关上下文，
 * 生成结构化 prompt 供 LLM 消费。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md
 */

import type { GraphStore, NodeMetadata } from '../../services/graph/GraphStore.js'
import type { GraphEngine } from '../../services/graph/GraphEngine.js'

// ============================================================
// Types
// ============================================================

export interface ChatAnswer {
  answer: string
  context: {
    relevantNodes: string[]
    graphFacts: string[]
    confidence: number
  }
}

interface ContextResult {
  nodes: string[]
  facts: string[]
}

// ============================================================
// UnderstandChat
// ============================================================

export class UnderstandChat {
  private pageRankScores: Map<string, number> | null = null

  constructor(
    private store: GraphStore,
    private engine: GraphEngine,
  ) {}

  /**
   * Find relevant context for a question.
   * Extracts key terms, searches nodeMeta, ranks by PageRank.
   */
  findContext(question: string): ContextResult {
    const terms = this.extractTerms(question)
    if (terms.length === 0) {
      return { nodes: [], facts: [] }
    }

    // Search nodeMeta for matching names/kinds
    const candidates = this.searchNodes(terms)
    if (candidates.length === 0) {
      return { nodes: [], facts: ['No matching symbols found for the question terms.'] }
    }

    // Rank by PageRank for relevance
    const ranked = this.rankByPageRank(candidates)

    // Build context window: top nodes + their edges
    const topN = Math.min(ranked.length, 15)
    const relevantNodes = ranked.slice(0, topN).map(n => n.id)
    const graphFacts = this.buildFacts(ranked.slice(0, topN))

    return { nodes: relevantNodes, facts: graphFacts }
  }

  /**
   * Build a prompt with graph context for LLM consumption.
   */
  buildPrompt(question: string): string {
    const context = this.findContext(question)

    const sections: string[] = [
      'You are a code analysis assistant. Answer the following question about this codebase using the provided graph context.',
      '',
      `## Question`,
      question,
    ]

    if (context.nodes.length > 0) {
      sections.push(
        '',
        '## Relevant Symbols',
        ...context.nodes.map(id => {
          const meta = this.store.getNode(id)
          if (!meta) return `- ${id}`
          const parts = [`- **${meta.name}** (${meta.kind})`]
          parts.push(`  file: ${meta.file}:${meta.line}`)
          if (meta.layer) parts.push(`  layer: ${meta.layer}`)
          if (meta.domain) parts.push(`  domain: ${meta.domain}`)
          if (meta.signature) parts.push(`  signature: \`${meta.signature}\``)
          return parts.join('\n')
        }),
      )
    }

    if (context.facts.length > 0) {
      sections.push(
        '',
        '## Graph Facts',
        ...context.facts.map(f => `- ${f}`),
      )
    }

    sections.push(
      '',
      '## Instructions',
      'Answer concisely based on the graph context above. If the context is insufficient, say so.',
    )

    return sections.join('\n')
  }

  // ── Internal helpers ──

  /**
   * Extract meaningful terms from a question.
   * Removes common stop words, keeps identifiers and technical terms.
   */
  extractTerms(question: string): string[] {
    // Stop words to filter out
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'shall',
      'what', 'where', 'when', 'how', 'why', 'which', 'who', 'whom',
      'this', 'that', 'these', 'those',
      'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
      'and', 'or', 'not', 'but', 'if', 'then', 'so',
      'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your',
      'about', 'between', 'through', 'into', 'over', 'under',
      'use', 'used', 'using', 'work', 'works',
    ])

    // Step 1: Split on whitespace/punctuation first, filter stop words
    const words = question
      .split(/[\s,.\-!?;:'"()\[\]{}\/\\]+/)
      .filter(t => t.length > 1)
      .filter(t => !stopWords.has(t.toLowerCase()))

    // Step 2: Apply camelCase splitting to remaining words
    const terms: string[] = []
    const seen = new Set<string>()

    for (const word of words) {
      // camelCase → "camel Case"
      const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/)
      for (const part of parts) {
        const lower = part.toLowerCase()
        if (part.length > 1 && !seen.has(lower)) {
          seen.add(lower)
          terms.push(part)
        }
      }
      // Also keep the original word if different from parts
      const wordLower = word.toLowerCase()
      if (!seen.has(wordLower) && word.length > 1) {
        seen.add(wordLower)
        terms.push(word)
      }
    }

    // Also keep dotted identifiers for fuzzy matching (e.g. "AuthService.login")
    const dotted = question.match(/[A-Za-z_][\w.]*/g) ?? []
    for (const d of dotted) {
      const lower = d.toLowerCase()
      if (!seen.has(lower) && d.length > 2 && !stopWords.has(lower)) {
        seen.add(lower)
        terms.push(d)
      }
    }

    return terms
  }

  /**
   * Search nodeMeta for nodes matching any term.
   * Matches against name, kind, file, and qualified_name.
   */
  private searchNodes(terms: string[]): NodeMetadata[] {
    const results: NodeMetadata[] = []
    const seen = new Set<string>()
    const lowerTerms = terms.map(t => t.toLowerCase())

    for (const [, meta] of this.store.nodeMeta) {
      if (seen.has(meta.id)) continue

      const nameLower = meta.name.toLowerCase()
      const fileLower = meta.file.toLowerCase()
      const qnLower = meta.qualified_name?.toLowerCase() ?? ''

      for (const term of lowerTerms) {
        // Exact name match (highest priority)
        if (nameLower === term) {
          results.push(meta)
          seen.add(meta.id)
          break
        }
        // Name contains term or term contains name
        if (nameLower.includes(term) || term.includes(nameLower)) {
          results.push(meta)
          seen.add(meta.id)
          break
        }
        // File path contains term
        if (fileLower.includes(term)) {
          results.push(meta)
          seen.add(meta.id)
          break
        }
        // Qualified name contains term
        if (qnLower.includes(term)) {
          results.push(meta)
          seen.add(meta.id)
          break
        }
      }
    }

    return results
  }

  /**
   * Rank nodes by PageRank score (cached after first computation).
   */
  private rankByPageRank(nodes: NodeMetadata[]): NodeMetadata[] {
    if (!this.pageRankScores) {
      try {
        const pr = this.engine.pageRank()
        this.pageRankScores = new Map(pr.scores.map(s => [s.node, s.score]))
      } catch {
        // PageRank failed (empty graph etc.), use identity ranking
        this.pageRankScores = new Map()
      }
    }

    const scores = this.pageRankScores
    return [...nodes].sort((a, b) => {
      const sa = scores.get(a.id) ?? 0
      const sb = scores.get(b.id) ?? 0
      return sb - sa
    })
  }

  /**
   * Build graph-derived facts about a set of nodes.
   */
  private buildFacts(nodes: NodeMetadata[]): string[] {
    const facts: string[] = []
    const nodeIds = new Set(nodes.map(n => n.id))

    for (const node of nodes) {
      // Outgoing edges
      const outEdges = this.store.getOutEdges(node.id)
      const outTargets: string[] = []
      for (const [target, edges] of outEdges) {
        const types = edges.map(e => e.type).join('+')
        const targetMeta = this.store.getNode(target)
        const targetName = targetMeta?.name ?? target
        outTargets.push(`${targetName} [${types}]`)
      }
      if (outTargets.length > 0) {
        facts.push(`${node.name} → calls/uses: ${outTargets.slice(0, 5).join(', ')}`)
      }

      // Incoming edges
      const inEdges = this.store.getInEdges(node.id)
      const inSources: string[] = []
      for (const [source, edges] of inEdges) {
        const types = edges.map(e => e.type).join('+')
        const sourceMeta = this.store.getNode(source)
        const sourceName = sourceMeta?.name ?? source
        inSources.push(`${sourceName} [${types}]`)
      }
      if (inSources.length > 0) {
        facts.push(`${node.name} ← used by: ${inSources.slice(0, 5).join(', ')}`)
      }

      // Layer/domain info
      if (node.layer || node.domain) {
        const parts = []
        if (node.layer) parts.push(`layer=${node.layer}`)
        if (node.domain) parts.push(`domain=${node.domain}`)
        facts.push(`${node.name}: ${parts.join(', ')}`)
      }
    }

    return facts
  }
}
