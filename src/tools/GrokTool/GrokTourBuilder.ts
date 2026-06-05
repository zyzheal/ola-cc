// src/tools/GrokTool/GrokTourBuilder.ts
// Tour enhancement + learning path generation + RAG query

import type { GraphNode, GraphEdge, GraphData, GrokChatResult } from './GrokTypes.js'
import type { GrokAnalyzer } from './GrokAnalyzer.js'

// ============================================================
// GrokTourBuilder Class
// ============================================================

export class GrokTourBuilder {
  constructor(private analyzer: GrokAnalyzer) {}

  /**
   * 将 camelCase/snake_case 标识符拆分为 token
   */
  tokenizeIdentifier(text: string): string[] {
    return text
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
      .replace(/[_\-./]+/g, ' ')              // snake_case, kebab-case, paths
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 1)
  }

  /**
   * 查询已生成的知识图谱（RAG 检索 + LLM 回答）
   */
  async queryGraph(question: string, graph: GraphData): Promise<GrokChatResult> {
    // 从问题中提取关键词，支持 camelCase/snake_case 拆分
    const rawKeywords = question.split(/\s+/).filter(w => w.length > 1)
    const keywords = new Set<string>()
    for (const kw of rawKeywords) {
      keywords.add(kw.toLowerCase())
      for (const token of this.tokenizeIdentifier(kw)) {
        keywords.add(token)
      }
    }

    // 匹配节点并计算相关性分数
    const scoredNodes = (graph.nodes || [])
      .map((node: GraphNode) => {
        const name = (node.name || '').toLowerCase()
        const summary = (node.summary || '').toLowerCase()
        const file = (node.file || '').toLowerCase()
        const kind = (node.kind || '').toLowerCase()
        const signature = (node.signature || '').toLowerCase()

        let score = 0
        for (const kw of keywords) {
          // 名称精确匹配权重最高
          if (name === kw) { score += 10; continue }
          // 名称包含匹配
          if (name.includes(kw)) { score += 5; continue }
          // 签名匹配
          if (signature.includes(kw)) { score += 3; continue }
          // 摘要匹配
          if (summary.includes(kw)) { score += 2; continue }
          // 文件路径匹配
          if (file.includes(kw)) { score += 1; continue }
          // 类型匹配
          if (kind.includes(kw)) { score += 1; continue }
        }

        // 名称 token 匹配（camelCase 拆分后）
        const nameTokens = this.tokenizeIdentifier(node.name || '')
        for (const nt of nameTokens) {
          if (keywords.has(nt)) score += 4
        }

        return { node, score }
      })
      .filter((item: { node: GraphNode; score: number }) => item.score > 0)
      .sort((a: { node: GraphNode; score: number }, b: { node: GraphNode; score: number }) => b.score - a.score)
      .slice(0, 20)

    const matchedNodes = scoredNodes.map((s: { node: GraphNode; score: number }) => s.node)

    // 找关联边（O(n+m) 使用 Set）
    const matchedIds = new Set(matchedNodes.map((n: GraphNode) => n.id))
    const matchedEdges = (graph.edges || []).filter((edge: GraphEdge) =>
      matchedIds.has(edge.from) || matchedIds.has(edge.to)
    ).slice(0, 30)

    // 构造上下文（按相关性排序）
    const context = scoredNodes.map(({ node: n, score }: { node: GraphNode; score: number }) =>
      `[${n.kind || 'node'}] ${n.name || n.id} (score:${score}) — ${n.file || 'N/A'}:${n.line || '?'}\n  ${n.summary || ''}`
    ).join('\n')

    const edgeContext = matchedEdges.map((e: GraphEdge) =>
      `${e.from} → ${e.to} (${e.type || 'relates'})`
    ).join('\n')

    const prompt = `Based on the following knowledge graph data, answer the question.

Question: ${question}

Relevant nodes (${matchedNodes.length}, sorted by relevance):
${context || '(no matching nodes)'}

Relevant relationships (${matchedEdges.length}):
${edgeContext || '(no relationships)'}

Provide a concise answer with file:line references.`

    const answer = await this.analyzer.callAgentWithTimeout(prompt, 'You are a code knowledge assistant. Answer questions about the codebase using the provided knowledge graph data. Include file:line references in your answer.')

    // 提取引用来源（带实际相关性分数）
    const sources: { file: string; line: number; relevance: number }[] = scoredNodes
      .filter(({ node: n }: { node: GraphNode; score: number }) => n.file)
      .map(({ node: n, score }: { node: GraphNode; score: number }) => ({ file: n.file, line: n.line || 0, relevance: score }))

    return { answer, sources }
  }
}
