/**
 * ModuleImpactAnalyzer — Two-stage module impact analysis (F-104)
 *
 * Stage 1: Code-level BFS — find all files transitively affected by a change
 * Stage 2: Contract-level fan-out — analyze affected APIs, events, exports
 *
 * Design doc: F-104 Two-stage Module Impact Analysis
 */

import type { GraphStore } from './GraphStore.js'
import type { GraphEngine } from './GraphEngine.js'
import type { ContractRegistry, ModuleContract, ContractApi, ContractEvent, ContractExport } from './ContractRegistry.js'

// ============================================================
// Types
// ============================================================

export interface ImpactResult {
  stage1: {
    /** Directly affected files (1-hop) */
    directImpact: string[]
    /** Transitively affected files (multi-hop BFS) */
    indirectImpact: string[]
    /** Max BFS depth reached */
    impactDepth: number
  }
  stage2: {
    /** APIs in affected modules */
    affectedApis: ContractApi[]
    /** Events in affected modules */
    affectedEvents: ContractEvent[]
    /** Exports in affected modules */
    affectedExports: ContractExport[]
    /** Risk of breaking contracts */
    contractBreakRisk: 'low' | 'medium' | 'high'
  }
}

// ============================================================
// ModuleImpactAnalyzer
// ============================================================

export class ModuleImpactAnalyzer {
  constructor(
    private store: GraphStore,
    private engine: GraphEngine,
    private registry: ContractRegistry,
  ) {}

  /**
   * Analyze full impact of changing a module
   */
  analyze(modulePath: string): ImpactResult {
    // Stage 1: Code-level BFS
    const stage1 = this.codeLevelBfs(modulePath)

    // Stage 2: Contract-level analysis
    const stage2 = this.contractLevelAnalysis(stage1.directImpact, stage1.indirectImpact)

    return { stage1, stage2 }
  }

  /**
   * Match contracts by pattern (exact + wildcard)
   */
  matchContracts(pattern: string): ModuleContract[] {
    const results: ModuleContract[] = []
    const isWildcard = pattern.includes('*')
    const regex = isWildcard
      ? new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i')
      : null

    // Search all registered contracts
    for (const [, contract] of this.registry['contracts']) {
      if (regex) {
        if (regex.test(contract.module)) {
          results.push(contract)
        }
      } else {
        if (contract.module.includes(pattern) || contract.module === pattern) {
          results.push(contract)
        }
      }
    }

    return results
  }

  // ============================================================
  // Stage 1: Code-level BFS
  // ============================================================

  private codeLevelBfs(modulePath: string): ImpactResult['stage1'] {
    // Find all nodes in this module
    const moduleNodes = this.findModuleNodes(modulePath)

    if (moduleNodes.length === 0) {
      return { directImpact: [], indirectImpact: [], impactDepth: 0 }
    }

    // BFS from all module nodes, collecting impacted files
    const directFiles = new Set<string>()
    const indirectFiles = new Set<string>()
    const visited = new Set<string>(moduleNodes)
    let maxDepth = 0

    // Multi-source BFS
    const queue: Array<{ nodeId: string; depth: number }> = moduleNodes.map(n => ({ nodeId: n, depth: 0 }))

    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift()!
      maxDepth = Math.max(maxDepth, depth)

      // Check all nodes that depend on this node (reverse edges)
      const inEdges = this.store.getInEdges(nodeId)
      for (const [source] of inEdges) {
        if (visited.has(source)) continue
        visited.add(source)

        const sourceNode = this.store.getNode(source)
        const sourceFile = sourceNode?.file
        if (!sourceFile || sourceFile === modulePath) continue

        if (depth === 0) {
          directFiles.add(sourceFile)
        } else {
          indirectFiles.add(sourceFile)
        }

        queue.push({ nodeId: source, depth: depth + 1 })
      }
    }

    // Remove direct from indirect (dedup)
    for (const f of directFiles) {
      indirectFiles.delete(f)
    }

    return {
      directImpact: [...directFiles],
      indirectImpact: [...indirectFiles],
      impactDepth: maxDepth,
    }
  }

  // ============================================================
  // Stage 2: Contract-level analysis
  // ============================================================

  private contractLevelAnalysis(
    directFiles: string[],
    indirectFiles: string[],
  ): ImpactResult['stage2'] {
    const allFiles = [...directFiles, ...indirectFiles]
    const affectedApis: ContractApi[] = []
    const affectedEvents: ContractEvent[] = []
    const affectedExports: ContractExport[] = []

    for (const file of allFiles) {
      const contract = this.registry.getContract(file)
      if (!contract) continue

      affectedApis.push(...contract.apis)
      affectedEvents.push(...contract.events)
      affectedExports.push(...contract.exports)
    }

    // Deduplicate
    const uniqueApis = this.deduplicateApis(affectedApis)
    const uniqueEvents = this.deduplicateEvents(affectedEvents)
    const uniqueExports = this.deduplicateExports(affectedExports)

    // Assess contract break risk
    const contractBreakRisk = this.assessBreakRisk(
      directFiles.length,
      indirectFiles.length,
      uniqueApis.length,
      uniqueExports.length,
    )

    return {
      affectedApis: uniqueApis,
      affectedEvents: uniqueEvents,
      affectedExports: uniqueExports,
      contractBreakRisk,
    }
  }

  private assessBreakRisk(
    directCount: number,
    indirectCount: number,
    apiCount: number,
    exportCount: number,
  ): 'low' | 'medium' | 'high' {
    // High: many direct impacts + APIs affected
    if (directCount > 10 || (apiCount > 5 && directCount > 3)) return 'high'
    if (directCount > 5 || apiCount > 3 || exportCount > 10) return 'high'

    // Medium: moderate impact
    if (directCount > 2 || apiCount > 0 || exportCount > 5) return 'medium'
    if (indirectCount > 10) return 'medium'

    // Low: minimal impact
    return 'low'
  }

  // ============================================================
  // Helpers
  // ============================================================

  private findModuleNodes(modulePath: string): string[] {
    const nodes: string[] = []
    for (const [id, meta] of this.store.nodeMeta) {
      if (meta.file === modulePath) {
        nodes.push(id)
      }
    }
    return nodes
  }

  private deduplicateApis(apis: ContractApi[]): ContractApi[] {
    const seen = new Set<string>()
    return apis.filter(api => {
      const key = `${api.method}:${api.path}:${api.handler}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private deduplicateEvents(events: ContractEvent[]): ContractEvent[] {
    const seen = new Set<string>()
    return events.filter(e => {
      const key = `${e.name}:${e.type}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private deduplicateExports(exports: ContractExport[]): ContractExport[] {
    const seen = new Set<string>()
    return exports.filter(e => {
      const key = `${e.name}:${e.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
