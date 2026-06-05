// src/tools/GrokTool/GrokAssembler.ts
// Graph assembly + Zod validation + incremental merge

import { createHash } from 'crypto'
import { existsSync, mkdirSync, copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../../utils/debug.js'
import type { GraphNode, GraphEdge, GraphData, GrokGenerateResult } from './GrokTypes.js'
import { GrokError } from './GrokTypes.js'

// ============================================================
// Kind normalization: map LLM variants to canonical forms
// ============================================================

const KIND_ALIASES: Record<string, string> = {
  // function variants
  'fn': 'function',
  'func': 'function',
  'function_def': 'function',
  'def': 'function',
  // procedure variants
  'proc': 'procedure',
  'procedure_def': 'procedure',
  // constant variants
  'const': 'constant',
  'constant_val': 'constant',
  'constexpr': 'constant',
  // method variants
  'class_method': 'method',
  'classmethod': 'method',
  'instance_method': 'method',
  'member_method': 'method',
  'mem_fn': 'method',
  // struct → class
  'struct': 'class',
  'struct_def': 'class',
  // interface variants
  'iface': 'interface',
  'interface_def': 'interface',
  'trait': 'interface',
  // enum variants
  'enum_type': 'enum',
  'enum_def': 'enum',
  'enumeration': 'enum',
  // type alias
  'type_alias': 'type',
  'typedef': 'type',
  'typealias': 'type',
  // variable variants
  'var': 'variable',
  'let': 'variable',
  'variable_def': 'variable',
  // module/namespace
  'mod': 'module',
  'namespace': 'module',
  'ns': 'module',
}

/**
 * 将 LLM 输出的 kind 变体映射为规范形式
 * 未知 kind 返回原始字符串，空字符串返回 'symbol'
 */
export function normalizeKind(kind: string): string {
  if (!kind || kind.trim() === '') return 'symbol'
  const lower = kind.toLowerCase().trim()
  return KIND_ALIASES[lower] || lower
}

// ============================================================
// Zod Schemas for knowledge-graph.json validation
// ============================================================

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  file: z.string(),
  line: z.number().int().nonnegative(),
  signature: z.string(),
  summary: z.string(),
  layer: z.string(),
  domain: z.string(),
})

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
})

export interface ValidationResult {
  success: boolean
  validNodes: number
  invalidNodes: number
  validEdges: number
  invalidEdges: number
  errors: string[]
  passRate: number
  warnings: string[]
  data?: { nodes: GraphNode[]; edges: GraphEdge[] }
}

/**
 * 验证单个节点，成功时返回规范化后的节点
 */
export function validateGraphNode(raw: unknown): { success: boolean; data?: GraphNode; error?: string } {
  const result = GraphNodeSchema.safeParse(raw)
  if (result.success) {
    const node = result.data as GraphNode
    node.kind = normalizeKind(node.kind)
    return { success: true, data: node }
  }
  return { success: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
}

/**
 * 验证单个边
 */
export function validateGraphEdge(raw: unknown): { success: boolean; data?: GraphEdge; error?: string } {
  const result = GraphEdgeSchema.safeParse(raw)
  if (result.success) {
    return { success: true, data: result.data as GraphEdge }
  }
  return { success: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
}

/**
 * 验证完整图数据（节点 + 边），跳过无效项
 * 当通过率 < 80% 时发出警告
 */
export function validateGraphData(raw: { nodes: unknown[]; edges: unknown[] }): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const validNodes: GraphNode[] = []
  const validEdges: GraphEdge[] = []

  for (const node of raw.nodes || []) {
    const r = validateGraphNode(node)
    if (r.success && r.data) {
      validNodes.push(r.data)
    } else {
      errors.push(`node: ${r.error}`)
    }
  }

  for (const edge of raw.edges || []) {
    const r = validateGraphEdge(edge)
    if (r.success && r.data) {
      validEdges.push(r.data)
    } else {
      errors.push(`edge: ${r.error}`)
    }
  }

  const totalItems = (raw.nodes?.length || 0) + (raw.edges?.length || 0)
  const validItems = validNodes.length + validEdges.length
  const passRate = totalItems > 0 ? validItems / totalItems : 1

  if (passRate < 0.8) {
    warnings.push(`Low validation pass rate: ${(passRate * 100).toFixed(1)}% — LLM output quality may be degraded`)
  }

  return {
    success: true,
    validNodes: validNodes.length,
    invalidNodes: (raw.nodes?.length || 0) - validNodes.length,
    validEdges: validEdges.length,
    invalidEdges: (raw.edges?.length || 0) - validEdges.length,
    errors,
    passRate,
    warnings,
    data: { nodes: validNodes, edges: validEdges },
  }
}

// ============================================================
// ReviewResult for assembleReview
// ============================================================

export interface ReviewResult {
  beforeNodes: number
  afterNodes: number
  beforeEdges: number
  afterEdges: number
  duplicatesRemoved: number
  danglingEdgesRemoved: number
  normalizedIds: number
}

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
          kind: normalizeKind(String(sym.kind || 'symbol')),
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

    // Step 7: Zod 验证（跳过无效节点/边，不阻断流水线）
    const validation = validateGraphData({ nodes, edges: uniqueEdges })
    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        logForDebugging(`[grok] WARNING: ${w}`)
      }
    }
    if (validation.invalidNodes > 0 || validation.invalidEdges > 0) {
      logForDebugging(`[grok] Validation: ${validation.invalidNodes} invalid nodes, ${validation.invalidEdges} invalid edges skipped`)
      errors.push(...validation.errors.map(msg =>
        new GrokError('VALIDATION_SKIP', 'assembler', msg, true)
      ))
    }
    const validatedNodes = validation.data?.nodes || nodes
    const validatedEdges = validation.data?.edges || uniqueEdges

    // Step 8: assembleReview — ID 规范化 + 去重 + 边完整性
    const { nodes: reviewedNodes, edges: reviewedEdges, review } = this.assembleReview(validatedNodes, validatedEdges)
    if (review.duplicatesRemoved > 0 || review.danglingEdgesRemoved > 0 || review.normalizedIds > 0) {
      logForDebugging(`[grok] Review: ${review.duplicatesRemoved} dup nodes, ${review.danglingEdgesRemoved} dangling edges removed, ${review.normalizedIds} IDs normalized`)
    }

    // Step 9: 组装并保存
    const graphData: GraphData = {
      nodes: reviewedNodes,
      edges: reviewedEdges,
      metadata: {
        lastUpdated: new Date().toISOString(),
        fileCount: files.length,
        languages: (scannerResult.languages as string[]) || [],
        frameworks: (scannerResult.frameworks as string[]) || [],
        layers: layers.map((l: Record<string, unknown>) => String(l.name || '')),
        uncovered: uncovered.length,
        tour: (tourResult.tours as unknown[]) || [],
        review: { ...(reviewResult.valid !== undefined ? reviewResult : { valid: true, issues: [], suggestions: [] }), ...review },
        language,
        errors: errors.map(e => ({ code: e.code, stage: e.stage, message: e.message })),
        fingerprints,
      },
    }

    const filePath = this.saveGraph(graphData)
    logForDebugging(`[grok] Graph saved: ${reviewedNodes.length} nodes, ${reviewedEdges.length} edges → ${filePath}`)

    return {
      status: errors.length > 0 ? 'partial' : 'success',
      nodeCount: reviewedNodes.length,
      edgeCount: reviewedEdges.length,
      domainCount: domains.size,
      filePath,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 组装后审查：ID 规范化 + 去重 + 边完整性
   */
  assembleReview(
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): { nodes: GraphNode[]; edges: GraphEdge[]; review: ReviewResult } {
    const beforeNodes = nodes.length
    const beforeEdges = edges.length
    let normalizedIds = 0

    // Step 1: ID 规范化 — 去掉 #counter 后缀
    const normalizedNodes = nodes.map(n => {
      if (n.id.includes('#')) {
        normalizedIds++
        return { ...n, id: n.id.replace(/#\d+$/, '') }
      }
      return n
    })

    // Step 2: 去重 — 按 {file, name} 去重，保留最后一个
    const dedupMap = new Map<string, GraphNode>()
    for (const node of normalizedNodes) {
      const key = `${node.file}:${node.name}`
      dedupMap.set(key, node) // 后来的覆盖前面的
    }
    const dedupedNodes = Array.from(dedupMap.values())
    const duplicatesRemoved = normalizedNodes.length - dedupedNodes.length

    // Step 3: 边完整性 — 移除引用不存在节点的边
    const nodeIdSet = new Set(dedupedNodes.map(n => n.id))
    const validEdges = edges.filter(e => nodeIdSet.has(e.from) && nodeIdSet.has(e.to))
    const danglingEdgesRemoved = edges.length - validEdges.length

    return {
      nodes: dedupedNodes,
      edges: validEdges,
      review: {
        beforeNodes,
        afterNodes: dedupedNodes.length,
        beforeEdges,
        afterEdges: validEdges.length,
        duplicatesRemoved,
        danglingEdgesRemoved,
        normalizedIds,
      },
    }
  }
}
