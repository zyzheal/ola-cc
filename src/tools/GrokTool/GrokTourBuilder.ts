// src/tools/GrokTool/GrokTourBuilder.ts
// Tour enhancement + learning path generation + RAG query

import type { GraphNode, GraphEdge, GraphData, GrokChatResult } from './GrokTypes.js'
import type { GrokAnalyzer } from './GrokAnalyzer.js'
import type { GraphStore } from '../../services/graph/GraphStore.js'
import type { GraphEngine } from '../../services/graph/GraphEngine.js'

// ============================================================
// Enhanced Tour Types
// ============================================================

export interface EnhancedTourStep {
  file: string
  description: string
  importance: number      // PageRank score (0-1)
  fanIn: number
  fanOut: number
  dependencies: string[]  // node IDs to read first
}

export interface EnhancedTour {
  steps: EnhancedTourStep[]
  entryPoints: string[]   // high PageRank + low fan-in
  coreModules: string[]   // high PageRank + high fan-in
  generatedAt: number
}

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
   * 中文文本分词：bigram 切分
   * 注意：单个 CJK 字符不产生 token（bigram 方案的固有局限）
   */
  private tokenizeChinese(text: string): string[] {
    const CJK_RANGE = /[\u4E00-\u9FFF\u3400-\u4DBF]/
    const tokens: string[] = []

    // 提取连续中文片段
    let buf = ''
    for (const ch of text) {
      if (CJK_RANGE.test(ch)) {
        buf += ch
      } else {
        if (buf.length >= 2) {
          // bigram 切分
          for (let i = 0; i <= buf.length - 2; i++) {
            tokens.push(buf.slice(i, i + 2))
          }
          // 也保留完整片段（3字以上）
          if (buf.length >= 3) {
            tokens.push(buf)
          }
        }
        buf = ''
      }
    }
    // 处理末尾片段
    if (buf.length >= 2) {
      for (let i = 0; i <= buf.length - 2; i++) {
        tokens.push(buf.slice(i, i + 2))
      }
      if (buf.length >= 3) {
        tokens.push(buf)
      }
    }

    return tokens
  }

  /**
   * 查询已生成的知识图谱（RAG 检索 + LLM 回答）
   */
  async queryGraph(question: string, graph: GraphData): Promise<GrokChatResult> {
    // 从问题中提取关键词，支持中英文混合查询
    const keywords = new Set<string>()

    // 英文：按空格拆分 + camelCase/snake_case token 化
    const rawKeywords = question.split(/\s+/).filter(w => w.length > 1)
    for (const kw of rawKeywords) {
      keywords.add(kw.toLowerCase())
      for (const token of this.tokenizeIdentifier(kw)) {
        keywords.add(token)
      }
    }

    // 中文：bigram 切分
    for (const token of this.tokenizeChinese(question)) {
      keywords.add(token)
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

  /**
   * 生成基于图数据的增强学习路径
   *
   * 使用 PageRank + fan-in/fan-out + 反向依赖链构建数据驱动的代码阅读顺序。
   * 排序策略：
   *   1. 高 PageRank + 高 fan-in → 核心模块（先读）
   *   2. 高 PageRank + 低 fan-in → 入口点（次读）
   *   3. 依赖链 → "先读 X 再读 Y"
   */
  generateEnhancedTour(store: GraphStore, engine: GraphEngine): EnhancedTour {
    const allNodes = engine.getAllNodeIds()
    if (allNodes.length === 0) {
      return { steps: [], entryPoints: [], coreModules: [], generatedAt: Date.now() }
    }

    // 1. PageRank 评分
    const pr = engine.pageRank()
    const prMap = new Map(pr.scores.map(s => [s.node, s.score]))

    // 2. 计算 fan-in / fan-out
    const fanInMap = new Map<string, number>()
    const fanOutMap = new Map<string, number>()
    for (const nodeId of allNodes) {
      fanInMap.set(nodeId, store.getInNeighborIds(nodeId).length)
      fanOutMap.set(nodeId, store.getOutNeighborIds(nodeId).length)
    }

    // 3. 计算百分位阈值
    const prSorted = [...prMap.values()].sort((a, b) => b - a)
    const fanInSorted = [...fanInMap.values()].sort((a, b) => b - a)
    const prP50 = prSorted[Math.floor(prSorted.length * 0.5)] ?? 0
    const fanInP50 = fanInSorted[Math.floor(fanInSorted.length * 0.5)] ?? 0

    // 4. 分类：
    //    - entryPoints: fanIn=0 且 fanOut>0（结构上是源节点，PR 天然低）
    //    - coreModules: PR >= P50 且 fanIn >= P50
    const entryPoints: string[] = []
    const coreModules: string[] = []

    for (const nodeId of allNodes) {
      const prScore = prMap.get(nodeId) ?? 0
      const fi = fanInMap.get(nodeId) ?? 0
      const fo = fanOutMap.get(nodeId) ?? 0

      if (fi === 0 && fo > 0) {
        // 结构入口点：无入边、有出边
        entryPoints.push(nodeId)
      } else if (fo === 0 && fi > 0) {
        // sink 节点：有入边、无出边（不归入 core）
      } else if (prScore >= prP50 && fi >= fanInP50) {
        // 核心模块：高重要性 + 高被依赖
        coreModules.push(nodeId)
      }
    }

    // 按 PageRank 排序
    entryPoints.sort((a, b) => (prMap.get(b) ?? 0) - (prMap.get(a) ?? 0))
    coreModules.sort((a, b) => (prMap.get(b) ?? 0) - (prMap.get(a) ?? 0))

    // 5. 为每个节点计算反向依赖链（谁依赖它）
    const depsMap = new Map<string, string[]>()
    for (const nodeId of allNodes) {
      const reach = engine.backwardReachability(nodeId)
      // 排除自身，只保留直接依赖（via 中有记录的）
      const deps = reach.reachable.filter(n => n !== nodeId && reach.via.has(n))
      depsMap.set(nodeId, deps.slice(0, 5)) // 最多 5 个依赖
    }

    // 6. 构建增强步骤：先入口点，再核心模块，最后其余
    const visited = new Set<string>()
    const steps: EnhancedTourStep[] = []

    const addStep = (nodeId: string, description: string) => {
      if (visited.has(nodeId)) return
      visited.add(nodeId)

      const meta = store.getNode(nodeId)
      const prScore = prMap.get(nodeId) ?? 0
      const fi = fanInMap.get(nodeId) ?? 0
      const fo = fanOutMap.get(nodeId) ?? 0

      steps.push({
        file: meta?.file ?? nodeId,
        description,
        importance: prScore,
        fanIn: fi,
        fanOut: fo,
        dependencies: depsMap.get(nodeId) ?? [],
      })
    }

    // 入口点优先
    for (const nodeId of entryPoints) {
      addStep(nodeId, 'Entry point — start here to understand the system flow')
    }

    // 核心模块次之
    for (const nodeId of coreModules) {
      addStep(nodeId, 'Core module — central to the architecture, heavily depended upon')
    }

    // 其余节点按 PageRank 降序
    const remaining = allNodes
      .filter(n => !visited.has(n))
      .sort((a, b) => (prMap.get(b) ?? 0) - (prMap.get(a) ?? 0))

    for (const nodeId of remaining) {
      const fi = fanInMap.get(nodeId) ?? 0
      const fo = fanOutMap.get(nodeId) ?? 0
      const role = fi === 0 && fo > 0 ? 'Leaf source'
        : fo === 0 && fi > 0 ? 'Sink — terminal dependency'
        : 'Supporting module'
      addStep(nodeId, role)
    }

    return {
      steps,
      entryPoints: entryPoints.slice(0, 10),
      coreModules: coreModules.slice(0, 10),
      generatedAt: Date.now(),
    }
  }
}
