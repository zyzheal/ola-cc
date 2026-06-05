// src/tools/GrokTool/OnboardBuilder.ts
// Generates onboarding guides for new developers using graph data

import type { GraphStore, NodeMetadata } from '../../services/graph/GraphStore.js'
import type { GraphEngine, CommunityResult } from '../../services/graph/GraphEngine.js'
import type { EnhancedTour, EnhancedTourStep } from './GrokTourBuilder.js'
import type { GraphData } from './GrokTypes.js'

// ============================================================
// Types
// ============================================================

export interface OnboardOptions {
  language?: string    // output language hint (default: 'en')
  maxSteps?: number    // max tour steps to include (default: 15)
}

// ============================================================
// OnboardBuilder
// ============================================================

export class OnboardBuilder {
  constructor(
    private store: GraphStore,
    private engine: GraphEngine,
  ) {}

  /**
   * 生成 Markdown 格式的 onboarding 指南
   */
  generate(tour: EnhancedTour, grokData?: GraphData, options?: OnboardOptions): string {
    const maxSteps = options?.maxSteps ?? 15
    const sections: string[] = []

    // 1. Project overview
    sections.push(this.buildProjectOverview(grokData))

    // 2. Architecture summary (from community detection)
    sections.push(this.buildArchitectureSummary())

    // 3. Key entry points
    sections.push(this.buildEntryPoints(tour))

    // 4. Learning path
    sections.push(this.buildLearningPath(tour, maxSteps))

    // 5. Common patterns (coupling metrics)
    sections.push(this.buildCommonPatterns())

    return sections.join('\n\n')
  }

  // ── Section builders ──

  private buildProjectOverview(grokData?: GraphData): string {
    const meta = grokData?.metadata
    const stats = this.store.size

    const lines = [
      '# Project Overview',
      '',
      `- **Nodes**: ${stats.nodes}`,
      `- **Edges**: ${stats.edges}`,
    ]

    if (meta) {
      if (meta.languages?.length) {
        lines.push(`- **Languages**: ${meta.languages.join(', ')}`)
      }
      if (meta.frameworks?.length) {
        lines.push(`- **Frameworks**: ${meta.frameworks.join(', ')}`)
      }
      if (meta.layers?.length) {
        lines.push(`- **Layers**: ${meta.layers.join(', ')}`)
      }
      if (meta.fileCount) {
        lines.push(`- **Files analyzed**: ${meta.fileCount}`)
      }
    }

    return lines.join('\n')
  }

  private buildArchitectureSummary(): string {
    const lines = ['# Architecture Summary', '']

    // Community detection
    let communities: CommunityResult
    try {
      communities = this.engine.louvainCommunity()
    } catch {
      lines.push('_Community detection not available (graph too small or empty)._')
      return lines.join('\n')
    }

    if (communities.communities.length === 0) {
      lines.push('_No communities detected._')
      return lines.join('\n')
    }

    lines.push(`Detected **${communities.communities.length}** communities (modularity: ${communities.modularity.toFixed(3)}):`)
    lines.push('')

    // Show top 8 communities
    const sorted = [...communities.communities].sort((a, b) => b.size - a.size)
    for (const comm of sorted.slice(0, 8)) {
      const label = comm.label ?? `Community ${comm.id}`
      const sampleNodes = comm.nodes.slice(0, 5).map(n => {
        const meta = this.store.getNode(n)
        return meta?.name ?? n
      })
      lines.push(`- **${label}** (${comm.size} nodes): ${sampleNodes.join(', ')}${comm.nodes.length > 5 ? ', ...' : ''}`)
    }

    return lines.join('\n')
  }

  private buildEntryPoints(tour: EnhancedTour): string {
    const lines = ['# Key Entry Points', '']

    if (tour.entryPoints.length === 0) {
      lines.push('_No clear entry points detected._')
      return lines.join('\n')
    }

    lines.push('These are the best places to start reading the code (high importance, low fan-in):')
    lines.push('')

    for (const nodeId of tour.entryPoints.slice(0, 8)) {
      const step = tour.steps.find(s => s.file === this.store.getNode(nodeId)?.file)
      const meta = this.store.getNode(nodeId)
      const name = meta?.name ?? nodeId
      const file = meta?.file ?? 'unknown'
      const prScore = step?.importance ?? 0
      lines.push(`- **${name}** — \`${file}\` (importance: ${prScore.toFixed(3)})`)
    }

    return lines.join('\n')
  }

  private buildLearningPath(tour: EnhancedTour, maxSteps: number): string {
    const lines = ['# Learning Path', '']

    if (tour.steps.length === 0) {
      lines.push('_No tour steps available._')
      return lines.join('\n')
    }

    lines.push('Recommended reading order based on PageRank, fan-in/fan-out, and dependency analysis:')
    lines.push('')

    const stepsToShow = tour.steps.slice(0, maxSteps)
    for (let i = 0; i < stepsToShow.length; i++) {
      const step = stepsToShow[i]
      const num = i + 1
      const deps = step.dependencies.length > 0
        ? ` (depends on: ${step.dependencies.slice(0, 3).map(d => {
            const m = this.store.getNode(d)
            return m?.name ?? d
          }).join(', ')})`
        : ''

      lines.push(`${num}. **${this.extractName(step.file)}** — \`${step.file}\``)
      lines.push(`   ${step.description} | importance: ${step.importance.toFixed(3)} | fan-in: ${step.fanIn} | fan-out: ${step.fanOut}${deps}`)
    }

    if (tour.steps.length > maxSteps) {
      lines.push('')
      lines.push(`_...and ${tour.steps.length - maxSteps} more modules._`)
    }

    return lines.join('\n')
  }

  private buildCommonPatterns(): string {
    const lines = ['# Common Patterns', '']

    let metrics: ReturnType<GraphEngine['couplingMetrics']>
    try {
      metrics = this.engine.couplingMetrics()
    } catch {
      lines.push('_Coupling metrics not available._')
      return lines.join('\n')
    }

    // High coupling
    if (metrics.highCoupling.length > 0) {
      lines.push('## High Coupling Modules')
      lines.push('')
      lines.push('These modules have many dependencies and may need extra attention:')
      lines.push('')

      for (const item of metrics.highCoupling.slice(0, 8)) {
        const meta = this.store.getNode(item.node)
        const name = meta?.name ?? item.node
        lines.push(`- **${name}** — fan-in: ${item.fanIn}, fan-out: ${item.fanOut}, instability: ${item.instability.toFixed(3)}`)
      }
    } else {
      lines.push('No high-coupling modules detected.')
    }

    // LCOM (Lack of Cohesion of Methods)
    if (metrics.lcom.length > 0) {
      lines.push('')
      lines.push('## Class Cohesion (LCOM)')
      lines.push('')
      lines.push('Low cohesion classes may benefit from refactoring:')
      lines.push('')

      const lowCohesion = metrics.lcom.filter(c => c.lcom > 0.7).slice(0, 5)
      if (lowCohesion.length > 0) {
        for (const item of lowCohesion) {
          lines.push(`- **${item.class}** — LCOM: ${item.lcom.toFixed(3)} (${item.methods} methods, ${item.fields} fields)`)
        }
      } else {
        lines.push('_All classes have reasonable cohesion._')
      }
    }

    return lines.join('\n')
  }

  private extractName(file: string): string {
    // Extract meaningful name from file path
    const parts = file.split('/')
    const filename = parts[parts.length - 1] ?? file
    return filename.replace(/\.(ts|js|tsx|jsx|py|go|rs)$/, '')
  }
}
