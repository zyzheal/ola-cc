// src/tools/GrokTool/GrokAssembler.ts
// Graph assembly + Zod validation + incremental merge

import { createHash } from 'crypto'
import { existsSync, mkdirSync, copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import type { GraphNode, GraphEdge, GraphData, GrokGenerateResult, GrokError } from './GrokTypes.js'

// ============================================================
// Shared utility: file fingerprinting
// ============================================================

/**
 * 计算文件指纹（SHA-256 content hash + size）
 * 使用内容哈希代替 mtime，避免 git checkout/pull 后 mtime 未变的误判
 */
export function computeFileFingerprint(filePath: string): { hash: string; size: number } | null {
  try {
    const content = readFileSync(filePath)
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
    return { hash, size: content.length }
  } catch {
    return null
  }
}

// ============================================================
// GrokAssembler Class
// ============================================================

export class GrokAssembler {
  constructor(private projectRoot: string) {}

  /**
   * 增量模式：合并已有节点与新分析结果
   */
  mergeIncrementalNodes(
    existingGraph: GraphData,
    changes: { changed: string[]; added: string[]; removed: string[] },
    analysisResults: Record<string, unknown>[]
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const analyzedFiles = new Set<string>()
    for (const result of analysisResults) {
      const syms = result.symbols as Record<string, unknown>[] | undefined
      if (syms) {
        for (const sym of syms) {
          if (sym.file) analyzedFiles.add(String(sym.file))
        }
      }
    }

    const filesToRemove = new Set<string>(changes.removed)
    for (const file of changes.changed) {
      if (analyzedFiles.has(file)) filesToRemove.add(file)
    }

    const nodes = (existingGraph.nodes || []).filter((n: GraphNode) => !filesToRemove.has(n.file))
    const nodeIdsForFilter = new Set(nodes.map((n: GraphNode) => n.id))
    const edges = (existingGraph.edges || []).filter((e: GraphEdge) =>
      nodeIdsForFilter.has(e.from) && nodeIdsForFilter.has(e.to)
    )
    return { nodes, edges }
  }

  /**
   * 从 LLM 分析结果提取新节点和边
   */
  extractNewNodes(
    analysisResults: Record<string, unknown>[],
    existingNodeIds: Set<string>
  ): { newNodes: GraphNode[]; newEdges: GraphEdge[] } {
    const newNodes: GraphNode[] = []
    const newEdges: GraphEdge[] = []

    for (const result of analysisResults) {
      const symbols = (result.symbols as Record<string, unknown>[]) || []
      for (const sym of symbols) {
        const id = `${sym.file || 'unknown'}:${sym.name || 'unknown'}`
        let finalId = id
        let counter = 1
        while (existingNodeIds.has(finalId)) {
          finalId = `${id}#${counter++}`
        }
        existingNodeIds.add(finalId)
        newNodes.push({
          id: finalId,
          name: String(sym.name || 'unknown'),
          kind: String(sym.kind || 'symbol'),
          file: String(sym.file || ''),
          line: Number(sym.line || 0),
          signature: String(sym.signature || ''),
          summary: String(sym.summary || ''),
          layer: '',
          domain: '',
        })
      }

      const rels = (result.relationships as Record<string, unknown>[]) || []
      for (const rel of rels) {
        newEdges.push({
          from: String(rel.from || ''),
          to: String(rel.to || ''),
          type: String(rel.type || 'relates'),
        })
      }
    }
    return { newNodes, newEdges }
  }

  /**
   * 从架构结果分配层并添加依赖边
   */
  assignLayersAndDeps(
    architectureResult: Record<string, unknown>,
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): { domains: Set<string>; layers: Record<string, unknown>[] } {
    const domains = new Set<string>()
    const layers = (architectureResult.layers as Record<string, unknown>[]) || []

    for (const layer of layers) {
      const layerName = String(layer.name || 'unknown')
      const layerModules = (layer.modules as string[]) || []
      for (const node of nodes) {
        if (layerModules.some((m: string) => node.file?.includes(m))) {
          node.layer = layerName
        }
      }
      if (layerName !== 'unknown') domains.add(layerName)
    }

    const deps = (architectureResult.dependencies as Record<string, unknown>[]) || []
    for (const dep of deps) {
      edges.push({ from: String(dep.from || ''), to: String(dep.to || ''), type: String(dep.type || 'depends') })
    }

    return { domains, layers }
  }

  /**
   * 去重边 + 验证两端节点存在
   */
  deduplicateEdges(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
    const nodeIdSet = new Set(nodes.map((n: GraphNode) => n.id))
    const edgeKeys = new Set<string>()
    return edges.filter(e => {
      if (!e.from || !e.to) return false
      if (!nodeIdSet.has(e.from) || !nodeIdSet.has(e.to)) return false
      const key = `${e.from}->${e.to}:${e.type}`
      if (edgeKeys.has(key)) return false
      edgeKeys.add(key)
      return true
    })
  }

  /**
   * 原子写入图谱文件（先写临时文件，再 rename）
   */
  saveGraph(graphData: GraphData): string {
    const graphDir = resolve(this.projectRoot, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })
    const filePath = resolve(graphDir, 'knowledge-graph.json')
    const tempPath = filePath + '.tmp'

    // 清理残留的 .tmp 文件（上次崩溃遗留）
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* ignore */ }

    // 备份旧文件（防损坏恢复）
    const backupPath = filePath + '.backup'
    try { if (existsSync(filePath)) copyFileSync(filePath, backupPath) } catch { /* ignore */ }

    writeFileSync(tempPath, JSON.stringify(graphData, null, 2), 'utf-8')
    renameSync(tempPath, filePath)
    return filePath
  }

  /**
   * 组装知识图谱
   */
  assembleGraph(
    files: string[],
    scannerResult: Record<string, unknown>,
    analysisResults: Record<string, unknown>[],
    architectureResult: Record<string, unknown>,
    tourResult: Record<string, unknown>,
    reviewResult: Record<string, unknown>,
    language: string,
    errors: GrokError[],
    existingGraph?: GraphData,
    changes?: { changed: string[]; added: string[]; removed: string[] }
  ): GrokGenerateResult {
    // Step 1: 初始化节点和边（增量 or 全量）
    let nodes: GraphNode[]
    let edges: GraphEdge[]
    if (existingGraph && changes) {
      const merged = this.mergeIncrementalNodes(existingGraph, changes, analysisResults)
      nodes = merged.nodes
      edges = merged.edges
    } else {
      nodes = []
      edges = []
    }

    // Step 2: 从分析结果提取新节点
    const existingNodeIds = new Set(nodes.map((n: GraphNode) => n.id))
    const { newNodes, newEdges } = this.extractNewNodes(analysisResults, existingNodeIds)
    nodes.push(...newNodes)
    edges.push(...newEdges)

    // Step 3: 分配架构层 + 添加依赖边
    const { domains, layers } = this.assignLayersAndDeps(architectureResult, nodes, edges)

    // Step 4: 去重边
    const uniqueEdges = this.deduplicateEdges(nodes, edges)

    // Step 5: 计算文件指纹
    const fingerprints: Record<string, { hash: string; size: number }> = {}
    for (const file of files) {
      const fp = computeFileFingerprint(file)
      if (fp) fingerprints[file] = fp
    }

    // Step 6: 未覆盖文件
    const coveredFiles = new Set(nodes.map((n: GraphNode) => n.file).filter(Boolean))
    const uncovered = files.filter(f => !coveredFiles.has(f))

    // Step 7: 组装并保存
    const graphData: GraphData = {
      nodes,
      edges: uniqueEdges,
      metadata: {
        lastUpdated: new Date().toISOString(),
        fileCount: files.length,
        languages: (scannerResult.languages as string[]) || [],
        frameworks: (scannerResult.frameworks as string[]) || [],
        layers: layers.map((l: Record<string, unknown>) => String(l.name || '')),
        uncovered: uncovered.length,
        tour: (tourResult.tours as unknown[]) || [],
        review: reviewResult.valid !== undefined ? reviewResult : { valid: true, issues: [], suggestions: [] },
        language,
        errors: errors.map(e => ({ code: e.code, stage: e.stage, message: e.message })),
        fingerprints,
      },
    }

    const filePath = this.saveGraph(graphData)
    logForDebugging(`[grok] Graph saved: ${nodes.length} nodes, ${uniqueEdges.length} edges → ${filePath}`)

    return {
      status: errors.length > 0 ? 'partial' : 'success',
      nodeCount: nodes.length,
      edgeCount: uniqueEdges.length,
      domainCount: domains.size,
      filePath,
      errors: errors.length > 0 ? errors : undefined,
    }
  }
}
