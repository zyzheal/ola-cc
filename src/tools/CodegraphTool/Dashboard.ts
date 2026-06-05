/**
 * Dashboard — Terminal-based graph visualization (F-96)
 *
 * ASCII/Unicode output for graph overview:
 * - Header with project stats
 * - Top nodes by PageRank / Betweenness
 * - Community distribution bar chart
 * - Simplified cluster visualization
 * - Recent structural changes
 *
 * Pure text output — no terminal control codes.
 */

import type { GraphStore, NodeMetadata } from '../../services/graph/GraphStore.js'
import type { GraphEngine, CommunityResult, CentralityResult } from '../../services/graph/GraphEngine.js'

// ============================================================
// Types
// ============================================================

export interface DashboardOptions {
  width?: number       // terminal width (default 80)
  height?: number      // terminal height (default 24)
  maxNodes?: number    // max nodes to display (default 50)
  filter?: string      // filter by name pattern
  community?: number   // filter by community ID
}

export interface GraphStats {
  nodes: number
  edges: number
  communities: number
  topPageRank: Array<{ node: string; score: number }>
  topBetweenness: Array<{ node: string; score: number }>
}

// ============================================================
// Dashboard
// ============================================================

export class Dashboard {
  constructor(
    private store: GraphStore,
    private engine: GraphEngine,
  ) {}

  /**
   * Generate full dashboard view as plain text
   */
  render(options?: DashboardOptions): string {
    const width = options?.width ?? 80
    const maxNodes = options?.maxNodes ?? 50
    const sections: string[] = []

    // 1. Header
    sections.push(this.renderHeader(width))

    // 2. Top nodes by PageRank
    sections.push(this.renderTopPageRank(maxNodes, options?.filter, width))

    // 3. Top nodes by Betweenness
    sections.push(this.renderTopBetweenness(10, width))

    // 4. Community distribution
    sections.push(this.renderCommunityDistribution(width))

    // 5. Graph visualization (simplified cluster view)
    sections.push(this.renderClusterView(options?.community, width))

    // 6. Kind distribution
    sections.push(this.renderKindDistribution(width))

    return sections.join('\n')
  }

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    const size = this.store.size
    const communityResult = this.engine.louvainCommunity()
    const pageRank = this.engine.pageRank()
    const betweenness = this.engine.betweennessCentrality(100)

    return {
      nodes: size.nodes,
      edges: size.edges,
      communities: communityResult.communities.length,
      topPageRank: pageRank.scores.slice(0, 10).map(s => ({
        node: s.node,
        score: Math.round(s.score * 10000) / 10000,
      })),
      topBetweenness: betweenness.scores.slice(0, 10).map(s => ({
        node: s.node,
        score: Math.round(s.score * 10000) / 10000,
      })),
    }
  }

  /**
   * Format data as a text table
   */
  formatTable(data: Array<Record<string, unknown>>, columns: string[]): string {
    if (data.length === 0) return '(no data)'

    // Calculate column widths
    const widths = new Map<string, number>()
    for (const col of columns) {
      widths.set(col, col.length)
    }
    for (const row of data) {
      for (const col of columns) {
        const val = String(row[col] ?? '')
        widths.set(col, Math.max(widths.get(col)!, val.length))
      }
    }

    // Build header
    const header = columns.map(col => col.padEnd(widths.get(col)!)).join(' | ')
    const separator = columns.map(col => '-'.repeat(widths.get(col)!)).join('-+-')

    // Build rows
    const rows = data.map(row =>
      columns.map(col => String(row[col] ?? '').padEnd(widths.get(col)!)).join(' | '),
    )

    return [header, separator, ...rows].join('\n')
  }

  // ============================================================
  // Section renderers
  // ============================================================

  private renderHeader(width: number): string {
    const size = this.store.size
    const line = '='.repeat(width)
    const title = 'Graph Dashboard'
    const subtitle = `Nodes: ${size.nodes} | Edges: ${size.edges}`

    return [
      line,
      this.centerText(title, width),
      this.centerText(subtitle, width),
      line,
    ].join('\n')
  }

  private renderTopPageRank(maxNodes: number, filter: string | undefined, width: number): string {
    const pageRank = this.engine.pageRank()
    let scores = pageRank.scores

    if (filter) {
      const pattern = new RegExp(filter, 'i')
      scores = scores.filter(s => pattern.test(s.node))
    }

    scores = scores.slice(0, maxNodes)

    const data = scores.map(s => {
      const meta = this.store.getNode(s.node)
      const fanIn = [...this.store.getInEdges(s.node).keys()].length
      const fanOut = [...this.store.getOutEdges(s.node).keys()].length
      return {
        Name: this.truncate(meta?.name ?? s.node, 25),
        Kind: meta?.kind ?? '?',
        PageRank: s.score.toFixed(4),
        'Fan-in': fanIn,
        'Fan-out': fanOut,
      }
    })

    const table = this.formatTable(data, ['Name', 'Kind', 'PageRank', 'Fan-in', 'Fan-out'])
    return `\n--- Top Nodes by PageRank ---\n${table}`
  }

  private renderTopBetweenness(limit: number, width: number): string {
    const betweenness = this.engine.betweennessCentrality(100)
    const scores = betweenness.scores.slice(0, limit)

    const data = scores.map(s => {
      const meta = this.store.getNode(s.node)
      return {
        Name: this.truncate(meta?.name ?? s.node, 25),
        Kind: meta?.kind ?? '?',
        Betweenness: s.score.toFixed(4),
      }
    })

    const table = this.formatTable(data, ['Name', 'Kind', 'Betweenness'])
    return `\n--- Top Nodes by Betweenness Centrality ---\n${table}`
  }

  private renderCommunityDistribution(width: number): string {
    const communityResult = this.engine.louvainCommunity()
    const communities = communityResult.communities
      .sort((a, b) => b.size - a.size)
      .slice(0, 15)

    if (communities.length === 0) return '\n--- Community Distribution ---\n(no communities)'

    const maxSize = Math.max(...communities.map(c => c.size))
    const barMaxWidth = Math.max(width - 20, 10)

    const lines = communities.map(c => {
      const barLen = Math.max(1, Math.round((c.size / maxSize) * barMaxWidth))
      const bar = '#'.repeat(barLen)
      return `  C${String(c.id).padStart(3)} | ${bar} (${c.size})`
    })

    return `\n--- Community Distribution (top 15, modularity=${communityResult.modularity.toFixed(3)}) ---\n${lines.join('\n')}`
  }

  private renderClusterView(filterCommunity: number | undefined, width: number): string {
    const communityResult = this.engine.louvainCommunity()
    let communities = communityResult.communities

    if (filterCommunity !== undefined) {
      communities = communities.filter(c => c.id === filterCommunity)
    }

    if (communities.length === 0) return '\n--- Cluster View ---\n(no data)'

    const lines: string[] = []
    lines.push('\n--- Cluster View (simplified) ---')

    for (const comm of communities.slice(0, 8)) {
      const representative = comm.nodes.slice(0, 5).map(n => {
        const meta = this.store.getNode(n)
        return meta?.name ?? n
      })
      const extra = comm.nodes.length > 5 ? ` +${comm.nodes.length - 5} more` : ''
      lines.push(`  [C${comm.id}] ${comm.size} nodes: ${representative.join(', ')}${extra}`)
    }

    if (communities.length > 8) {
      lines.push(`  ... and ${communities.length - 8} more communities`)
    }

    return lines.join('\n')
  }

  private renderKindDistribution(width: number): string {
    const kindCounts = new Map<string, number>()
    for (const node of this.store.nodeMeta.values()) {
      kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1)
    }

    const sorted = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])
    if (sorted.length === 0) return '\n--- Kind Distribution ---\n(no data)'

    const maxCount = sorted[0]![1]
    const barMaxWidth = Math.max(width - 20, 10)

    const lines = sorted.slice(0, 10).map(([kind, count]) => {
      const barLen = Math.max(1, Math.round((count / maxCount) * barMaxWidth))
      const bar = '='.repeat(barLen)
      return `  ${kind.padEnd(12)} | ${bar} (${count})`
    })

    return `\n--- Kind Distribution ---\n${lines.join('\n')}`
  }

  // ============================================================
  // Helpers
  // ============================================================

  private centerText(text: string, width: number): string {
    const padding = Math.max(0, Math.floor((width - text.length) / 2))
    return ' '.repeat(padding) + text
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + '...'
  }
}
